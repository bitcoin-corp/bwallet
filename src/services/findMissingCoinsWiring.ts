/**
 * The toolbox side of findMissingCoins.ts: what initWallet passes in. Reads every managed store through
 * findOutputsAuth (works for the device's StorageProvider and the remote StorageClient alike; read only).
 */
import { Transaction } from '@bsv/sdk';
import { timedStep } from './recoverByTxid';
import { managedStores, withRepairStore, type TxidWiring } from './recoverByTxidWiring';
import type { ChainState, MissingCoin, RestoreDeps, ScanDeps, ScanStore, StoreOutput } from './findMissingCoins';

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
                w.stepTimeoutMs ?? 30_000,
                `Couldn’t reach ${label}`,
                async () => {
                  const auth = { userId: m.user!.userId, identityKey: w.identityKey };
                  const all: StoreOutput[] = [];
                  for (let offset = 0; offset < 200_000; offset += PAGE) {
                    const page = (await m.storage.findOutputsAuth(auth, {
                      partial: {},
                      noScript: true,
                      paged: { limit: PAGE, offset },
                    })) as unknown as OutRow[];
                    for (const o of page) {
                      const x = toStoreOutput(o);
                      if (x) all.push(x);
                    }
                    if (page.length < PAGE) break;
                  }
                  return all;
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
