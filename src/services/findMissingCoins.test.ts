import { describe, expect, test } from 'bun:test';
import {
  foundHeadline,
  restoreMissingCoins,
  scanMissingCoins,
  type ChainState,
  type ScanStore,
  type StoreOutput,
} from './findMissingCoins';
import type { TxidRecoverReport } from './recoverByTxid';

/** tx 877d2505… (25 Oct 2026, block 972621): vout 3 = 28.66670816 BSV change, unspent on chain. */
const LOST = '877d2505159194dcd7ea01ae8ee68bfb9740bd85335badd836671e1844ce4224';
const OTHER = 'aa'.repeat(32);
const LOST_SATS = 2_866_670_816;

const change = (txid: string, vout: number, satoshis: number, o: Partial<StoreOutput> = {}): StoreOutput => ({
  txid,
  vout,
  satoshis,
  change: true,
  spendable: false,
  spentBy: null,
  createdAt: Date.parse('2026-10-25T16:17:00Z'),
  ...o,
});
const store = (name: string, active: boolean, outs: StoreOutput[]): ScanStore => ({
  name,
  active,
  outputs: async () => outs,
});
const chainOf =
  (m: Record<string, ChainState>) =>
  async (txid: string): Promise<ChainState> =>
    m[txid] ?? 'missing';
const unspentOf =
  (spent: string[] = []) =>
  async (op: string) =>
    !spent.includes(op);
const quiet = () => {};

describe('scanMissingCoins (read only)', () => {
  test('record only in the remote backup: found, and it says which store holds it', async () => {
    const r = await scanMissingCoins({
      stores: async () => [
        store('this device', true, []),
        store('the 1Sat backup (wallet.1sat.app)', false, [change(LOST, 3, LOST_SATS, { spendable: true })]),
      ],
      chain: chainOf({ [LOST]: 'mined' }),
      isUnspent: unspentOf(),
      log: quiet,
    });
    expect(r.found).toHaveLength(1);
    expect(r.found[0]).toMatchObject({
      txid: LOST,
      sats: LOST_SATS,
      inActive: false,
      stores: ['the 1Sat backup (wallet.1sat.app)'],
    });
    expect(foundHeadline(r)).toBe('We found 28.667 BSV the wallet lost track of. Add it back?');
  });

  test('record in the local (active) store, failed: found, inActive', async () => {
    const r = await scanMissingCoins({
      stores: async () => [store('this device', true, [change(LOST, 3, LOST_SATS)])],
      chain: chainOf({ [LOST]: 'mined' }),
      isUnspent: unspentOf(),
      log: quiet,
    });
    expect(r.found.map((c) => [c.txid, c.inActive])).toEqual([[LOST, true]]);
  });

  test('tx not on chain: never listed (so never restored)', async () => {
    const r = await scanMissingCoins({
      stores: async () => [store('this device', true, [change(OTHER, 1, 5000)])],
      chain: chainOf({}),
      isUnspent: unspentOf(),
      log: quiet,
    });
    expect(r.found).toEqual([]);
    expect(r.checked).toBe(1);
  });

  test('output already spent on chain: not listed as spendable', async () => {
    const r = await scanMissingCoins({
      stores: async () => [store('this device', true, [change(LOST, 3, LOST_SATS), change(LOST, 4, 900)])],
      chain: chainOf({ [LOST]: 'mined' }),
      isUnspent: unspentOf([`${LOST}.3`]),
      log: quiet,
    });
    expect(r.found[0].outputs).toEqual([{ vout: 4, satoshis: 900 }]);
    expect(r.spent).toEqual([`${LOST}.3`]);
  });

  test('already spendable in the active store, or spent by us in any store: not a candidate', async () => {
    const r = await scanMissingCoins({
      stores: async () => [
        store('this device', true, [change(LOST, 3, LOST_SATS, { spendable: true })]),
        store('backup', false, [change(OTHER, 0, 700, { spentBy: 9 }), change(OTHER, 0, 700)]),
      ],
      chain: async () => 'mined',
      isUnspent: unspentOf(),
      log: quiet,
    });
    expect(r.found).toEqual([]);
    expect(r.checked).toBe(0);
  });

  test('mempool only, unclear chain, unreachable store: reported, not listed', async () => {
    const r = await scanMissingCoins({
      stores: async () => [
        store('this device', true, [change(LOST, 3, 10), change(OTHER, 1, 20)]),
        {
          name: 'the 1Sat backup',
          active: false,
          outputs: async () => {
            throw new Error('offline');
          },
        },
      ],
      chain: chainOf({ [LOST]: 'mempool', [OTHER]: 'unclear' }),
      isUnspent: unspentOf(),
      log: quiet,
    });
    expect(r.found).toEqual([]);
    expect(r.unconfirmed).toEqual([LOST]);
    expect(r.unclear).toEqual([OTHER]);
    expect(r.unreachable).toEqual(['the 1Sat backup']);
  });

  test('non-change outputs are ignored (a relinquished token is never resurrected)', async () => {
    const r = await scanMissingCoins({
      stores: async () => [store('this device', true, [change(LOST, 0, 1, { change: false })])],
      chain: async () => 'mined',
      isUnspent: unspentOf(),
      log: quiet,
    });
    expect(r.found).toEqual([]);
  });
});

describe('restoreMissingCoins', () => {
  const coin = (inActive: boolean) => ({
    txid: LOST,
    sats: LOST_SATS,
    outputs: [{ vout: 3, satoshis: LOST_SATS }],
    stores: [inActive ? 'this device' : 'the 1Sat backup'],
    inActive,
  });
  const recovered = (result: TxidRecoverReport['result']): TxidRecoverReport => ({
    txid: LOST,
    result,
    outputs: [],
    restoredSats: result === 'restored' ? LOST_SATS : 0,
  });

  test('in the active store: toolbox UnFail first; if that restores it, recoverByTxid is not needed', async () => {
    const calls: string[] = [];
    let spendable = 0;
    const r = await restoreMissingCoins([coin(true)], {
      unfail: async (txids) => {
        calls.push(`unfail:${txids.join(',')}`);
        spendable = LOST_SATS;
        return 1;
      },
      recoverTxid: async () => {
        calls.push('recoverTxid');
        return recovered('restored');
      },
      markInputsSpent: async () => {
        calls.push('inputs');
        return 1;
      },
      spendableSats: async () => spendable,
      log: quiet,
    });
    expect(calls).toEqual([`unfail:${LOST}`, 'inputs']);
    expect(r.restored).toEqual([{ txid: LOST, sats: LOST_SATS }]);
  });

  test('only in the backup: copied in through recoverByTxid (internalize), inputs marked spent', async () => {
    const calls: string[] = [];
    let spendable = 0;
    const r = await restoreMissingCoins([coin(false)], {
      unfail: async () => {
        calls.push('unfail');
        return 0;
      },
      recoverTxid: async () => {
        calls.push('recoverTxid');
        spendable = LOST_SATS;
        return recovered('restored');
      },
      markInputsSpent: async () => {
        calls.push('inputs');
        return 2;
      },
      spendableSats: async () => spendable,
      log: quiet,
    });
    expect(calls).toEqual(['recoverTxid', 'inputs']);
    expect(r.restored[0].sats).toBe(LOST_SATS);
  });

  test('a failed recovery is reported, not hidden', async () => {
    const r = await restoreMissingCoins([coin(false)], {
      recoverTxid: async () => ({ ...recovered('error'), error: 'Couldn’t reach the 1Sat backup' }),
      spendableSats: async () => 0,
      log: quiet,
    });
    expect(r.restored).toEqual([]);
    expect(r.notRestored[0].reason).toMatch(/1Sat backup/);
  });
});
