/**
 * The toolbox side of recoverByTxid.ts: what initWallet passes in. Its own module so the incident tests
 * (src/incident/sweepUnrecorded.test.ts) run exactly the production wiring.
 */
import { Beef, Hash, MerklePath, Transaction, Utils } from '@bsv/sdk';
import type { KeyDeriver } from '@bsv/sdk';
import type { StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { timedStep, type Derivation, type TxidRecoverDeps } from './recoverByTxid';

type Row = {
  outputId: number;
  transactionId: number;
  txid?: string;
  vout: number;
  satoshis: number;
  spendable: boolean;
  spentBy?: number;
  change: boolean;
  derivationPrefix?: string;
  derivationSuffix?: string;
  senderIdentityKey?: string;
};
type TxRow = {
  transactionId: number;
  txid?: string;
  status: string;
  description?: string;
  provenTxId?: number;
  inputBEEF?: number[];
};
/** The slice of a store (StorageProvider or remote StorageClient) the search reads. */
type ReadableStore = {
  findOutputsAuth: (
    auth: { userId?: number; identityKey: string },
    args: { partial: Record<string, unknown>; noScript?: boolean; paged?: { limit: number; offset: number } },
  ) => Promise<Row[]>;
};
export type Managed = { storage: ReadableStore & { constructor: { name: string } }; user?: { userId: number } };

export type TxidWiring = {
  storage: Pick<
    WalletStorageManager,
    'getAuth' | 'runAsStorageProvider' | 'isActiveStorageProvider' | 'updateBackups' | 'syncFromReader' | 'runAsSync'
  >;
  wallet: Pick<Wallet, 'internalizeAction'> & { keyDeriver: Pick<KeyDeriver, 'derivePrivateKey' | 'identityKey'> };
  services: {
    getRawTx: (txid: string) => Promise<{ rawTx?: number[] } | undefined>;
    getMerklePath: (txid: string) => Promise<{ merklePath?: unknown } | undefined>;
    getHeaderForHeight: (height: number) => Promise<number[] | undefined>;
    getUtxoStatus?: (
      hash: string,
      format: undefined,
      outpoint: string,
    ) => Promise<{ status?: string; isUtxo?: boolean }>;
  };
  legacyAddresses?: { label: string; address: string }[];
  log?: (msg: string) => void;
  progress?: (step: string) => void;
  /** Per-store search timeout (ms), default 20 s. */
  stepTimeoutMs?: number;
};

/** Active, backup and conflicting stores of the manager (toolbox internals; read only). */
export function managedStores(storage: TxidWiring['storage']): { name: string; m: Managed }[] {
  const s = storage as unknown as { _active?: Managed; _stores?: Managed[] };
  const all = s._stores?.length ? s._stores : s._active ? [s._active] : [];
  return all.map((m) => ({
    m,
    name:
      m === s._active ? 'this device' : m.storage.constructor?.name === 'StorageClient' ? 'remote backup' : 'backup',
  }));
}

const PAGE = 1000;

type SP = StorageProvider;
/**
 * Where a repair is written. Device store active: that store. Remote store active (a restored account, or a device
 * whose copy of the backup keeps failing): the device's own IndexedDB store, which the manager always holds as a
 * backup; the result is then merged into the remote with the toolbox's own sync (syncFromReader), never by
 * writing remote rows directly.
 */
export async function withRepairStore<T>(
  storage: TxidWiring['storage'],
  fn: (sp: SP, userId: number) => Promise<T>,
): Promise<T> {
  if (storage.isActiveStorageProvider()) {
    const userId = (await storage.getAuth(true)).userId!;
    return storage.runAsStorageProvider((sp) => fn(sp as SP, userId));
  }
  const dev = deviceStore(storage);
  if (!dev) throw new Error('no device store to repair in');
  return storage.runAsSync(() => fn(dev.sp, dev.userId));
}

function deviceStore(storage: TxidWiring['storage']): { sp: SP; userId: number } | undefined {
  const s = storage as unknown as { _active?: Managed; _stores?: (Managed & { isStorageProvider?: boolean })[] };
  const m = (s._stores ?? []).find((x) => x !== s._active && x.isStorageProvider && x.user);
  return m ? { sp: m.storage as unknown as SP, userId: m.user!.userId } : undefined;
}

export function makeTxidRecoverDeps(w: TxidWiring): TxidRecoverDeps {
  const { storage, services } = w;
  const identityKey = w.wallet.keyDeriver.identityKey;
  return {
    keyDeriver: w.wallet.keyDeriver,
    getRawTx: async (txid) => (await services.getRawTx(txid))?.rawTx,
    getMerklePath: async (txid) => {
      const mp = (await services.getMerklePath(txid))?.merklePath;
      return mp instanceof MerklePath ? mp : undefined;
    },
    isUnspent: async (outpoint) => {
      if (!services.getUtxoStatus) return undefined;
      const r = await services.getUtxoStatus('', undefined, outpoint);
      return r?.status === 'success' && typeof r.isUtxo === 'boolean' ? r.isUtxo : undefined;
    },
    findDerivations: async ({ txid, satoshis }) => {
      const sats = new Set(satoshis);
      const out: Derivation[] = [];
      const unreachable: string[] = [];
      for (const { name, m } of managedStores(storage)) {
        if (!m.user) continue;
        const auth = { userId: m.user.userId, identityKey };
        const remote = !(m as { isStorageProvider?: boolean }).isStorageProvider;
        const url = (m.storage as unknown as { endpointUrl?: string }).endpointUrl;
        const host = url ? url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
        const label = remote ? `the 1Sat backup${host ? ` (${host})` : ''}` : 'this device';
        w.progress?.(remote ? 'Searching the 1Sat backup…' : 'Searching this device…');
        try {
          await timedStep(
            `search ${name}`,
            w.stepTimeoutMs ?? 20_000,
            `Couldn’t reach ${label}`,
            async () => {
              for (let offset = 0; offset < 200_000; offset += PAGE) {
                const page = await m.storage.findOutputsAuth(auth, {
                  partial: {},
                  noScript: true,
                  paged: { limit: PAGE, offset },
                });
                for (const o of page)
                  if (o.derivationPrefix && o.derivationSuffix && (o.txid === txid || sats.has(o.satoshis)))
                    out.push({
                      derivationPrefix: o.derivationPrefix,
                      derivationSuffix: o.derivationSuffix,
                      senderIdentityKey: o.senderIdentityKey || undefined,
                      satoshis: o.satoshis,
                      txid: o.txid,
                      store: name,
                    });
                if (page.length < PAGE) break;
              }
            },
            w.log,
          );
        } catch (e) {
          unreachable.push(label);
          w.log?.(`[recoverTxid] couldn't read ${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { derivations: out, unreachable };
    },
    localRecord: async (txid) => {
      // This device's store, read directly (no manager lock, no network).
      const s = storage as unknown as { _active?: Managed & { isStorageProvider?: boolean } };
      const dev =
        s._active?.isStorageProvider && s._active.user
          ? { sp: s._active.storage as unknown as SP, userId: s._active.user.userId }
          : deviceStore(storage);
      if (!dev) return undefined;
      const [t] = (await dev.sp.findTransactions({
        partial: { userId: dev.userId, txid },
        noRawTx: true,
      })) as unknown as (TxRow & { satoshis?: number; created_at?: Date | string })[];
      let hiddenOutputs = 0;
      if (t) {
        // An output of ours held unspendable with no settled spender of ours (dkg's state) is not "in the wallet".
        const outs = (await dev.sp.findOutputs({
          partial: { userId: dev.userId, transactionId: t.transactionId },
          noScript: true,
        })) as unknown as Row[];
        for (const o of outs) {
          if (o.spendable) continue;
          if (o.spentBy == null || o.spentBy === t.transactionId) {
            hiddenOutputs++;
            continue;
          }
          const [sp] = (await dev.sp.findTransactions({
            partial: { userId: dev.userId, transactionId: o.spentBy },
            noRawTx: true,
          })) as unknown as TxRow[];
          if (!sp || !['completed', 'unproven', 'sending', 'nosend', 'unsigned', 'unprocessed'].includes(sp.status))
            hiddenOutputs++;
        }
      }
      return t
        ? {
            hiddenOutputs,
            status: t.status,
            satoshis: t.satoshis,
            createdAt: t.created_at ? new Date(t.created_at).getTime() : undefined,
          }
        : undefined;
    },
    progress: w.progress,
    stepTimeoutMs: w.stepTimeoutMs,
    activeRows: async (txid) =>
      withRepairStore(storage, async (sp, userId) => {
        const [t] = (await sp.findTransactions({ partial: { userId, txid }, noRawTx: true })) as unknown as TxRow[];
        if (!t) return { outputs: [] };
        const outputs = (await sp.findOutputs({
          partial: { userId, transactionId: t.transactionId },
        })) as unknown as Row[];
        return { tx: { transactionId: t.transactionId, status: t.status, provenTxId: t.provenTxId }, outputs };
      }),
    internalize: async (args) => {
      if (storage.isActiveStorageProvider()) {
        await w.wallet.internalizeAction(args as never);
        return;
      }
      // Remote active: into the device store (scripts were already proven ours by recoverPaymentByTxid).
      await withRepairStore(storage, (sp, userId) =>
        sp.internalizeAction({ userId, identityKey, isActive: false } as never, args as never),
      );
    },
    repairRows: async ({ txid, rawTx, merklePath, transactionId, outputIds }) => {
      const header = await services.getHeaderForHeight(merklePath.blockHeight);
      if (!header?.length) throw new Error(`no block header for height ${merklePath.blockHeight}`);
      const leaf = merklePath.path[0].find((l) => l.hash === txid);
      if (!leaf) throw new Error('proof does not name the txid');
      const blockHash = Utils.toHex(Hash.hash256(header).reverse());
      const merkleRoot = merklePath.computeRoot(txid);
      const tx = Transaction.fromBinary(rawTx);
      await withRepairStore(storage, async (sp, userId) => {
        await sp.transaction(async (trx) => {
          const now = new Date();
          const { proven } = await sp.findOrInsertProvenTx(
            {
              created_at: now,
              updated_at: now,
              provenTxId: 0,
              txid,
              height: merklePath.blockHeight,
              index: leaf.offset,
              merklePath: merklePath.toBinary(),
              rawTx,
              blockHash,
              merkleRoot,
            },
            trx,
          );
          await sp.updateTransaction(transactionId, { status: 'completed', provenTxId: proven.provenTxId, txid }, trx);
          for (const req of await sp.findProvenTxReqs({ partial: { txid }, trx }))
            await sp.updateProvenTxReq(req.provenTxReqId, { status: 'completed', provenTxId: proven.provenTxId }, trx);
          for (const outputId of outputIds)
            await sp.updateOutput(outputId, { spendable: true, spentBy: undefined }, trx);
          // The mined tx really spent its inputs: any of them the wallet holds (a failed action released them) are spent.
          for (const input of tx.inputs) {
            const [o] = await sp.findOutputs({
              partial: { userId, txid: input.sourceTXID, vout: input.sourceOutputIndex },
              trx,
            });
            if (o) await sp.updateOutput(o.outputId, { spendable: false, spentBy: transactionId }, trx);
          }
        });
      });
    },
    pushBackups: async () => {
      if (storage.isActiveStorageProvider()) return storage.updateBackups();
      const dev = deviceStore(storage);
      if (dev) await storage.syncFromReader(identityKey, dev.sp as never);
    },
    pushOnAlready: !storage.isActiveStorageProvider(),
    legacyAddresses: w.legacyAddresses,
    log: w.log,
  };
}

/**
 * Sweep txids worth trying from the device's own records (Find mined payments): every sweep row that has a txid,
 * and for a sweep row that never got one, whatever txid the chain says spent the coins in its input BEEF.
 */
export async function sweepCandidateTxids(
  storage: TxidWiring['storage'],
  getSpends: ((outpoints: string[]) => Promise<(string | null | undefined)[]>) | undefined,
): Promise<string[]> {
  const rows = (await withRepairStore(storage, (sp, userId) =>
    sp.findTransactions({ partial: { userId } }),
  )) as unknown as TxRow[];
  const out = new Set<string>();
  const outpoints = new Set<string>();
  for (const t of rows) {
    if (!/^sweep/i.test(t.description ?? '')) continue;
    if (t.txid) {
      out.add(t.txid);
      continue;
    }
    if (!t.inputBEEF?.length) continue;
    try {
      const beef = Beef.fromBinary(t.inputBEEF);
      for (const btx of beef.txs) {
        const parent = btx.tx;
        if (!parent) continue;
        parent.outputs.forEach((_, vout) => outpoints.add(`${btx.txid}_${vout}`));
      }
    } catch {
      /* unreadable BEEF: skip */
    }
  }
  if (getSpends && outpoints.size) {
    const list = [...outpoints].slice(0, 500);
    for (let i = 0; i < list.length; i += 100) {
      const batch = list.slice(i, i + 100);
      const spends = await getSpends(batch).catch(() => []);
      for (const s of spends) if (s && /^[0-9a-f]{64}$/i.test(s)) out.add(s.toLowerCase());
    }
  }
  return [...out];
}

/**
 * Wiring for services/postageReconcile.ts: bMail postage rows still nosend/unsent on the repair store, and the
 * repair for one that the chain says is mined (reuses repairRows above; nothing is built or broadcast).
 */
export function makePostageReconcileWiring(w: TxidWiring) {
  const deps = makeTxidRecoverDeps(w);
  return {
    listStuck: async () => {
      const rows = (await withRepairStore(w.storage, (sp, userId) =>
        sp.findTransactions({ partial: { userId, isOutgoing: true }, noRawTx: true }),
      )) as unknown as TxRow[];
      // Descriptions are stored encrypted, so 'bMail postage' can't be matched here: every outgoing row still held
      // back is checked, and only one the chain says is mined is touched (the chain is the authority either way).
      return rows
        .filter((t) => !!t.txid && ['nosend', 'unsent', 'unprocessed'].includes(t.status))
        .map((t) => ({ transactionId: t.transactionId, txid: t.txid!, status: t.status }));
    },
    settle: async (row: { transactionId: number; txid: string }) => {
      const rawTx = await deps.getRawTx(row.txid);
      if (!rawTx?.length) throw new Error('raw tx not found');
      const merklePath = await deps.getMerklePath(row.txid);
      if (!merklePath?.path?.[0]?.some((l) => l.hash === row.txid)) throw new Error('no merkle proof yet');
      const rows = await deps.activeRows(row.txid);
      const outputIds: number[] = [];
      for (const o of rows?.outputs ?? []) {
        // Only outputs the chain says are still unspent become spendable; a spent or unclear one is left as is.
        if ((await deps.isUnspent(`${row.txid}.${o.vout}`).catch(() => undefined)) === true) outputIds.push(o.outputId);
      }
      await deps.repairRows({
        txid: row.txid,
        rawTx,
        merklePath,
        transactionId: rows?.tx?.transactionId ?? row.transactionId,
        outputIds,
      });
      await deps.pushBackups?.().catch(() => undefined);
      return { outputs: outputIds.length };
    },
  };
}
