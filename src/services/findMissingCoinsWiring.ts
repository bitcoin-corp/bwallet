/**
 * The toolbox side of findMissingCoins.ts: what initWallet passes in. Reads every managed store through
 * findOutputsAuth (works for the device's StorageProvider and the remote StorageClient alike; read only).
 */
import { Transaction } from '@bsv/sdk';
import { timedStep } from './recoverByTxid';
import { managedStores, withRepairStore, type TxidWiring } from './recoverByTxidWiring';
import type {
  ChainState,
  MissingCoin,
  RestoreDeps,
  ScanDeps,
  ScanStore,
  StoreOutput,
  StoreRead,
} from './findMissingCoins';

type OutRow = {
  outputId: number;
  transactionId: number;
  txid?: string;
  vout: number;
  satoshis: number;
  spendable: boolean;
  spentBy?: number | null;
  change: boolean;
  outputDescription?: string;
  created_at?: Date | string;
};

const PAGE = 1000;
const MAX_OUTPUTS = 200_000;
/** Statuses whose outputs the toolbox keeps but no list shows: an aborted or never-sent action's change. */
export const UNSETTLED_STATUSES = ['failed', 'nosend', 'unsigned', 'unprocessed'] as const;
/** Order the toolbox's getSyncChunk expects its offsets in (backup/WalletBackupService.ts SYNC_ENTITY_NAMES). */
const SYNC_ENTITIES = [
  'provenTx',
  'outputBasket',
  'outputTag',
  'txLabel',
  'transaction',
  'output',
  'txLabelMap',
  'outputTagMap',
  'certificate',
  'certificateField',
  'commission',
  'provenTxReq',
];
const SKIP = 1_000_000_000;

type TxRow = { transactionId: number; txid?: string; status: string; created_at?: Date | string; description?: string };

/** The store-level calls the scan uses. A local StorageProvider has findTransactions; a remote StorageClient doesn't. */
type ScanStoreApi = {
  findOutputsAuth: (
    auth: { userId?: number; identityKey: string },
    args: Record<string, unknown>,
  ) => Promise<unknown[]>;
  findTransactions?: (args: Record<string, unknown>) => Promise<unknown[]>;
  getSyncChunk?: (args: Record<string, unknown>) => Promise<{ transactions?: unknown[] }>;
  getSettings?: () => { storageIdentityKey?: string };
};

/**
 * This store's failed / nosend / unsigned / unprocessed transactions. A local store answers by status directly. A
 * remote store has no findTransactions over RPC, so its transactions are paged with getSyncChunk (every other entity
 * skipped) and filtered here; getSyncChunk has no status filter, so failed rows are included.
 */
export async function findUnsettledTxs(
  api: ScanStoreApi,
  userId: number,
  identityKey: string,
  storageIdentityKey: string | undefined,
): Promise<{ txs: TxRow[]; incomplete?: string }> {
  const want = new Set<string>(UNSETTLED_STATUSES);
  if (api.findTransactions) {
    const txs: TxRow[] = [];
    for (const status of UNSETTLED_STATUSES)
      txs.push(...((await api.findTransactions({ partial: { userId, status }, noRawTx: true })) as unknown as TxRow[]));
    return { txs };
  }
  if (!api.getSyncChunk || !storageIdentityKey) return { txs: [], incomplete: 'it can’t list transactions by status' };
  const txs: TxRow[] = [];
  let offset = 0;
  for (let i = 0; i < 1000; i++) {
    const chunk = await api.getSyncChunk({
      identityKey,
      fromStorageIdentityKey: storageIdentityKey,
      toStorageIdentityKey: 'bwx-find-missing-coins',
      maxRoughSize: 10_000_000,
      maxItems: PAGE,
      offsets: SYNC_ENTITIES.map((name) => ({ name, offset: name === 'transaction' ? offset : SKIP })),
    });
    const page = (chunk.transactions ?? []) as TxRow[];
    for (const t of page) if (want.has(t.status)) txs.push(t);
    if (!page.length) return { txs };
    offset += page.length;
  }
  return { txs, incomplete: `stopped after ${offset} transactions` };
}

export type MissingCoinsWiring = {
  storage: TxidWiring['storage'];
  identityKey: string;
  services: {
    getRawTx: (txid: string) => Promise<{ rawTx?: number[] } | undefined>;
    getMerklePath: (txid: string) => Promise<{ merklePath?: unknown } | undefined>;
    getUtxoStatus?: (
      hash: string,
      format: undefined,
      outpoint: string,
    ) => Promise<{ status?: string; isUtxo?: boolean }>;
  };
  /** The existing proof-checked UnFail repair (recoverFailedWiring: queueUnfail + runUnFail). */
  unfail?: (txids: string[]) => Promise<number>;
  recoverTxid: RestoreDeps['recoverTxid'];
  stepTimeoutMs?: number;
  log?: (m: string) => void;
};

const toStoreOutput = (o: OutRow): StoreOutput | null =>
  o.txid
    ? {
        txid: o.txid,
        vout: o.vout,
        satoshis: o.satoshis,
        change: !!o.change,
        spendable: !!o.spendable,
        spentBy: o.spentBy ?? null,
        createdAt: o.created_at ? new Date(o.created_at).getTime() : undefined,
        description: o.outputDescription,
      }
    : null;

export function makeMissingCoinsDeps(w: MissingCoinsWiring): { scan: ScanDeps; restore: RestoreDeps } {
  const { storage, services } = w;
  const log = w.log ?? ((m: string) => console.log(m));
  const isUnspent = async (outpoint: string) => {
    if (!services.getUtxoStatus) return undefined;
    const r = await services.getUtxoStatus('', undefined, outpoint);
    return r?.status === 'success' && typeof r.isUtxo === 'boolean' ? r.isUtxo : undefined;
  };
  const activeOutputs = (txid: string) =>
    withRepairStore(storage, async (sp, userId) => {
      const outs = (await sp.findOutputs({ partial: { userId, txid }, noScript: true })) as unknown as OutRow[];
      return outs;
    });

  const scan: ScanDeps = {
    stores: async () => {
      const s = storage as unknown as { _active?: unknown };
      return managedStores(storage)
        .filter(({ m }) => !!m.user)
        .map(({ name, m }): ScanStore => {
          const api = m.storage as unknown as ScanStoreApi;
          const auth = () => ({ userId: m.user!.userId, identityKey: w.identityKey });
          const ms = w.stepTimeoutMs ?? 30_000;
          const remote = !(m as { isStorageProvider?: boolean }).isStorageProvider;
          const url = (m.storage as unknown as { endpointUrl?: string }).endpointUrl;
          const host = url ? url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
          const label = remote ? `the 1Sat backup${host ? ` (${host})` : ''}` : name;
          return {
            name: label,
            active: m === s._active,
            outputs: () =>
              timedStep(
                `read ${label}`,
                ms,
                `Couldn’t reach ${label}`,
                async (): Promise<StoreRead> => {
                  const all: StoreOutput[] = [];
                  for (let offset = 0; offset < MAX_OUTPUTS; offset += PAGE) {
                    const page = (await m.storage.findOutputsAuth(auth(), {
                      partial: {},
                      noScript: true,
                      paged: { limit: PAGE, offset },
                    })) as unknown as OutRow[];
                    for (const o of page) {
                      const x = toStoreOutput(o);
                      if (x) all.push(x);
                    }
                    if (page.length < PAGE) return { outputs: all };
                  }
                  return { outputs: all, incomplete: `stopped at ${MAX_OUTPUTS} outputs` };
                },
                log,
              ),
            unsettledOutputs: () =>
              timedStep(
                `read failed/unsent transactions in ${label}`,
                ms,
                `Couldn’t finish reading ${label}`,
                async (): Promise<StoreRead> => {
                  const settings =
                    (m as { settings?: { storageIdentityKey?: string } }).settings ?? api.getSettings?.();
                  const { txs, incomplete } = await findUnsettledTxs(
                    api,
                    m.user!.userId,
                    w.identityKey,
                    settings?.storageIdentityKey,
                  );
                  log(`[bwx-recover] ${label}: ${txs.length} failed/unsent transaction(s)`);
                  const all: StoreOutput[] = [];
                  for (const t of txs) {
                    const outs = (await m.storage.findOutputsAuth(auth(), {
                      partial: { transactionId: t.transactionId },
                      noScript: true,
                    })) as unknown as OutRow[];
                    for (const o of outs) {
                      // An output row of a signed-then-aborted action may not carry the txid: take the transaction's.
                      const x = toStoreOutput({
                        ...o,
                        txid: o.txid || t.txid,
                        created_at: o.created_at ?? t.created_at,
                      });
                      if (x) all.push({ ...x, description: x.description || t.description });
                    }
                  }
                  return { outputs: all, incomplete };
                },
                log,
              ),
          };
        });
    },
    chain: async (txid): Promise<ChainState> => {
      try {
        if ((await services.getMerklePath(txid))?.merklePath) return 'mined';
        const raw = await services.getRawTx(txid);
        return raw?.rawTx?.length ? 'mempool' : 'missing';
      } catch {
        return 'unclear';
      }
    },
    isUnspent,
    log,
  };

  const restore: RestoreDeps = {
    unfail: w.unfail,
    recoverTxid: w.recoverTxid,
    spendableSats: async (coin: MissingCoin) => {
      const want = new Set(coin.outputs.map((o) => o.vout));
      const outs = await activeOutputs(coin.txid);
      return outs.filter((o) => want.has(o.vout) && o.spendable).reduce((n, o) => n + o.satoshis, 0);
    },
    // The mined tx really spent its inputs: any of them the active store still offers as spendable is marked spent
    // (a failed action released them). Only when the chain says that input is spent.
    markInputsSpent: async (txid) => {
      const raw = (await services.getRawTx(txid))?.rawTx;
      if (!raw?.length) return 0;
      const tx = Transaction.fromBinary(raw);
      return withRepairStore(storage, async (sp, userId) => {
        const [t] = await sp.findTransactions({ partial: { userId, txid }, noRawTx: true });
        let n = 0;
        for (const input of tx.inputs) {
          const [o] = (await sp.findOutputs({
            partial: { userId, txid: input.sourceTXID, vout: input.sourceOutputIndex },
            noScript: true,
          })) as unknown as OutRow[];
          if (!o || !o.spendable) continue;
          if ((await isUnspent(`${input.sourceTXID}.${input.sourceOutputIndex}`).catch(() => undefined)) !== false)
            continue;
          await sp.updateOutput(o.outputId, { spendable: false, ...(t ? { spentBy: t.transactionId } : {}) });
          n++;
        }
        return n;
      });
    },
    log,
  };
  return { scan, restore };
}
