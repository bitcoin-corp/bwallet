import { describe, expect, test } from 'bun:test';
import { foundHeadline, scanMissingCoins, scanNote, type ScanStore, type StoreOutput } from './findMissingCoins';
import { findUnsettledTxs, makeMissingCoinsDeps } from './findMissingCoinsWiring';

/** tx 877d2505… : aborted after a server broadcast, vout 3 = 28.66670816 BSV change. */
const LOST = '877d2505159194dcd7ea01ae8ee68bfb9740bd85335badd836671e1844ce4224';
const LOST_SATS = 2_866_670_816;
const quiet = () => {};
const lostOut = (o: Partial<StoreOutput> = {}): StoreOutput => ({
  txid: LOST,
  vout: 3,
  satoshis: LOST_SATS,
  change: true,
  spendable: false,
  spentBy: null,
  ...o,
});
const base = { chain: async () => 'mined' as const, isUnspent: async () => true, log: quiet };

describe('scan: failed/unsent transactions are read explicitly', () => {
  test("a failed tx's change missing from the all-outputs read is found by the status pass", async () => {
    const store: ScanStore = {
      name: 'the 1Sat backup (wallet.1sat.app)',
      active: true,
      outputs: async () => [],
      unsettledOutputs: async () => [lostOut()],
    };
    const r = await scanMissingCoins({ ...base, stores: async () => [store] });
    expect(r.found.map((c) => [c.txid, c.sats])).toEqual([[LOST, LOST_SATS]]);
    expect(r.incomplete).toEqual([]);
  });

  test('all-outputs read timed out but the status pass works: still found, store reported as partly read', async () => {
    const store: ScanStore = {
      name: 'the 1Sat backup (wallet.1sat.app)',
      active: true,
      outputs: async () => {
        throw new Error('Couldn’t reach the 1Sat backup after 30 s');
      },
      unsettledOutputs: async () => [lostOut()],
    };
    const r = await scanMissingCoins({ ...base, stores: async () => [store] });
    expect(r.found).toHaveLength(1);
    expect(r.incomplete).toEqual(['the 1Sat backup (wallet.1sat.app)']);
  });

  test('a partial read never says "No missing coins found"', async () => {
    const store: ScanStore = {
      name: 'wallet.1sat.app',
      active: true,
      outputs: async () => ({ outputs: [], incomplete: 'stopped at 200000 outputs' }),
      unsettledOutputs: async () => {
        throw new Error('timeout');
      },
    };
    const r = await scanMissingCoins({ ...base, stores: async () => [store] });
    expect(r.found).toEqual([]);
    expect(foundHeadline(r)).toBe('Couldn’t finish reading wallet.1sat.app; nothing changed.');
    expect(scanNote(r)).toContain('couldn’t finish reading wallet.1sat.app');
  });

  test('an unreachable store also never reads as "No missing coins found"', async () => {
    const r = await scanMissingCoins({
      ...base,
      stores: async () => [
        {
          name: 'wallet.1sat.app',
          active: true,
          outputs: async () => {
            throw new Error('down');
          },
        },
      ],
    });
    expect(foundHeadline(r)).toBe('Couldn’t finish reading wallet.1sat.app; nothing changed.');
  });

  test('every store read in full and nothing there: "No missing coins found."', async () => {
    const r = await scanMissingCoins({
      ...base,
      stores: async () => [
        { name: 'this device', active: true, outputs: async () => [], unsettledOutputs: async () => [] },
      ],
    });
    expect(foundHeadline(r)).toBe('No missing coins found.');
  });
});

describe('findUnsettledTxs', () => {
  test('local store: asks findTransactions by each unsettled status', async () => {
    const asked: string[] = [];
    const r = await findUnsettledTxs(
      {
        findOutputsAuth: async () => [],
        findTransactions: async (a) => {
          const status = (a.partial as { status: string }).status;
          asked.push(status);
          return status === 'failed' ? [{ transactionId: 7, txid: LOST, status }] : [];
        },
      },
      1,
      'idk',
      'sik',
    );
    expect(asked).toEqual(['failed', 'nosend', 'unsigned', 'unprocessed']);
    expect(r.txs.map((t) => t.transactionId)).toEqual([7]);
  });

  test('remote store: pages transactions with getSyncChunk, skipping every other entity, keeps unsettled only', async () => {
    const pages = [
      [
        { transactionId: 1, txid: 'aa'.repeat(32), status: 'completed' },
        { transactionId: 7, txid: LOST, status: 'failed' },
      ],
      [{ transactionId: 9, txid: 'bb'.repeat(32), status: 'nosend' }],
      [],
    ];
    const seen: number[] = [];
    const r = await findUnsettledTxs(
      {
        findOutputsAuth: async () => [],
        getSyncChunk: async (a) => {
          const offs = a.offsets as { name: string; offset: number }[];
          seen.push(offs.find((o) => o.name === 'transaction')!.offset);
          expect(offs.filter((o) => o.name !== 'transaction').every((o) => o.offset >= 1e9)).toBe(true);
          return { transactions: pages.shift() };
        },
      },
      1,
      'idk',
      'sik',
    );
    expect(seen).toEqual([0, 2, 3]);
    expect(r.txs.map((t) => t.transactionId)).toEqual([7, 9]);
    expect(r.incomplete).toBeUndefined();
  });

  test('remote store that can list neither way: reported incomplete, not empty-and-fine', async () => {
    const r = await findUnsettledTxs({ findOutputsAuth: async () => [] }, 1, 'idk', 'sik');
    expect(r.incomplete).toBeTruthy();
  });
});

describe('wiring: unsettledOutputs fills a missing txid from its transaction', () => {
  test("the failed tx's output row without a txid is still found", async () => {
    const remote = {
      constructor: { name: 'StorageClient' },
      endpointUrl: 'https://wallet.1sat.app',
      findOutputsAuth: async (_auth: unknown, a: { partial: { transactionId?: number } }) =>
        a.partial.transactionId === 7
          ? [{ outputId: 1, transactionId: 7, vout: 3, satoshis: LOST_SATS, spendable: false, change: true }]
          : [],
      getSyncChunk: async (a: { offsets: { name: string; offset: number }[] }) => ({
        transactions:
          a.offsets.find((o) => o.name === 'transaction')!.offset === 0
            ? [{ transactionId: 7, txid: LOST, status: 'failed' }]
            : [],
      }),
    };
    const m = { storage: remote, user: { userId: 5 }, settings: { storageIdentityKey: 'remote-sik' } };
    const storage = { _active: m, _stores: [m] } as never;
    const { scan } = makeMissingCoinsDeps({
      storage,
      identityKey: 'idk',
      services: { getRawTx: async () => undefined, getMerklePath: async () => undefined },
      recoverTxid: async () => {
        throw new Error('not used');
      },
      log: quiet,
    });
    const r = await scanMissingCoins({ ...scan, chain: async () => 'mined', isUnspent: async () => true, log: quiet });
    expect(r.found.map((c) => [c.txid, c.sats, c.inActive])).toEqual([[LOST, LOST_SATS, true]]);
    expect(r.incomplete).toEqual([]);
  });
});
