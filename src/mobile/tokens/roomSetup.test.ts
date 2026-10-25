import { beforeEach, describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { P2PKH } from '@bsv/sdk';
import { INDEX_FUND_NETWORK_SATS, INDEX_FUND_SATS, deriveFeeAddress } from './indexFund';
import {
  DISMISS_PREFIX,
  FREE_FEE,
  chargeUsd,
  fetchServerSetupFee,
  freeRoomNote,
  parseServerFee,
  resetServerSetupFeeCache,
  ROOM_SETUP_FEE_USD,
  dismissRoomSetup,
  isRoomSetupDismissed,
  payRoomSetup,
  roomSetupExtraOutputs,
  setupFeeFor,
  roomSetupFeeAddress,
  setupFeeSats,
  setupTotal,
  withoutDismissed,
} from './roomSetup';
import { ticketCost } from '../tickets/tickets';
import { PERSONAL_FEE_ESTIMATE_SATS, PERSONAL_NETWORK_FEE_SATS } from '../names/claimPersonal';
import { stubGlobals } from '../../testing/stubGlobals';

const BCORP = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const ID = `${'a'.repeat(64)}_0`;
/** The real indexer fee address for ID, derived from the id as the wallet does. */
const FEE = deriveFeeAddress(ID) as string;

// Minimal localStorage / window for the dismissal helpers.
const store = new Map<string, string>();
stubGlobals({
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
  window: new EventTarget(),
});

beforeEach(() => store.clear());

describe('setupFeeSats', () => {
  test('$1.00 at $50/BSV = 2,000,000 sats', () => {
    expect(setupFeeSats(1, 50, false, BCORP)).toBe(2_000_000);
  });
  test('store build charges no bCorp fee', () => {
    expect(setupFeeSats(1, 50, true, BCORP)).toBe(0);
    expect(roomSetupFeeAddress(BCORP, true)).toBe('');
  });
  test('unknown rate: no fee (never guess)', () => {
    expect(setupFeeSats(1, 0, false, BCORP)).toBe(0);
    expect(setupFeeSats(1, Number.NaN, false, BCORP)).toBe(0);
  });
  test('no / invalid address or no price: no fee', () => {
    expect(setupFeeSats(1, 50, false, '')).toBe(0);
    expect(roomSetupFeeAddress('nope', false)).toBe('');
    expect(roomSetupFeeAddress(BCORP, false)).toBe(BCORP);
    expect(setupFeeSats(0, 50, false, BCORP)).toBe(0);
  });
  test('default price is $1.00', () => {
    expect(ROOM_SETUP_FEE_USD).toBe(1);
  });
});

describe('setupTotal', () => {
  test('indexer shortfall + fee + network', () => {
    const t = setupTotal({ feePerOutput: 1000, balance: 4_000_000, minFunding: 10_000_000 }, 2_000_000);
    expect(t).toEqual({
      indexSats: 6_000_000,
      feeSats: 2_000_000,
      networkSats: INDEX_FUND_NETWORK_SATS,
      totalSats: 8_000_000 + INDEX_FUND_NETWORK_SATS,
    });
  });
  test('fresh token, no fee: the whole minimum only', () => {
    const t = setupTotal({ feePerOutput: 1000 }, 0);
    expect(t.indexSats).toBe(INDEX_FUND_SATS);
    expect(t.feeSats).toBe(0);
    expect(t.totalSats).toBe(INDEX_FUND_SATS + INDEX_FUND_NETWORK_SATS);
  });
  test('junk fee counts as 0', () => {
    expect(setupTotal({ feePerOutput: 1000 }, -5).feeSats).toBe(0);
    expect(setupTotal({ feePerOutput: 1000 }, 1.5).feeSats).toBe(0);
  });
});

describe('dismissal ("Not now")', () => {
  test('persists per token under bwallet.roomSetup.dismissed.', () => {
    expect(isRoomSetupDismissed(ID)).toBe(false);
    dismissRoomSetup(ID);
    expect(store.get(`${DISMISS_PREFIX}${ID}`)).toBe('1');
    expect(isRoomSetupDismissed(ID)).toBe(true);
    expect(isRoomSetupDismissed(ID.replace('_', '.'))).toBe(true);
    expect(isRoomSetupDismissed(`${'b'.repeat(64)}_0`)).toBe(false);
  });
  test('withoutDismissed drops only dismissed tokens', () => {
    dismissRoomSetup(ID);
    const other = { tokenId: `${'b'.repeat(64)}_0`, ticker: 'B' };
    expect(withoutDismissed([{ tokenId: ID, ticker: 'A' }, other])).toEqual([other]);
  });
});

describe('payRoomSetup', () => {
  const status = { feeAddress: FEE, feePerOutput: 1000, isActive: false, balance: 0, minFunding: 10_000_000 };
  const ctxWith = (calls: unknown[]) =>
    ({
      wallet: { createAction: async (a: unknown) => (calls.push(a), { txid: 'f'.repeat(64) }) },
    }) as unknown as OneSatContext;
  type Args = { outputs: { lockingScript: string; satoshis: number }[] };

  test('indexer + bCorp fee in ONE transaction', async () => {
    const calls: unknown[] = [];
    await payRoomSetup(ctxWith(calls), ID, 'TESTY', status, 2_000_000, BCORP);
    expect(calls).toHaveLength(1);
    const { outputs } = calls[0] as Args;
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ satoshis: 10_000_000, lockingScript: new P2PKH().lock(FEE).toHex() });
    expect(outputs[1]).toMatchObject({ satoshis: 2_000_000, lockingScript: new P2PKH().lock(BCORP).toHex() });
  });
  test('no fee address (store build): indexer output only', async () => {
    const calls: unknown[] = [];
    await payRoomSetup(ctxWith(calls), ID, 'TESTY', status, 2_000_000, '');
    expect((calls[0] as Args).outputs).toHaveLength(1);
  });
  test('a failed payment sends nothing (fee never charged without the setup)', async () => {
    const ctx = {
      wallet: {
        createAction: async () => {
          throw new Error('Insufficient funds');
        },
        listActions: async () => ({ actions: [] }),
      },
    } as unknown as OneSatContext;
    await expect(payRoomSetup(ctx, ID, 'TESTY', status, 2_000_000, BCORP)).rejects.toThrow(/Insufficient/);
  });
  test('an indexer fee address that does not match the token id is refused: nothing sent', async () => {
    const calls: unknown[] = [];
    const wrong = { ...status, feeAddress: '1HAeteL7Dk8vXQ3ctVyktyRqrAzgk4LwfU' };
    expect(wrong.feeAddress).not.toBe(FEE);
    await expect(payRoomSetup(ctxWith(calls), ID, 'TESTY', wrong, 2_000_000, BCORP)).rejects.toThrow(
      /Nothing was sent/,
    );
    expect(calls).toHaveLength(0);
  });
});

test('mint quotes no longer include indexing', () => {
  const c = ticketCost(0, 100, 0, '');
  expect(c.totalSats).toBe(c.networkSats);
  expect(c.totalSats).toBeLessThan(INDEX_FUND_SATS);
  // Personal $NAME token: network fee only.
  expect(PERSONAL_FEE_ESTIMATE_SATS).toBe(PERSONAL_NETWORK_FEE_SATS);
});

describe('Index $X: only the issuer pays the bCorp setup fee', () => {
  const ADDR = '192nuX6cz81MH3T2gwsam3FxYoDrvzDYpU';
  test('non-issuer holder: no fee, no bCorp output, total is the indexing cost only', () => {
    const fee = setupFeeFor(12_345, false);
    expect(fee).toBe(0);
    expect(roomSetupExtraOutputs('X', fee, ADDR)).toEqual([]);
    const t = setupTotal({ feePerOutput: 1000 }, fee);
    expect(t.feeSats).toBe(0);
    expect(t.totalSats).toBe(t.indexSats + t.networkSats);
  });
  test('issuer: unchanged (fee output to the bCorp address)', () => {
    const fee = setupFeeFor(12_345, true);
    expect(fee).toBe(12_345);
    expect(roomSetupExtraOutputs('X', fee, ADDR)).toEqual([
      { address: ADDR, satoshis: 12_345, outputDescription: 'bWallet room setup ($X)' },
    ]);
    expect(setupTotal({ feePerOutput: 1000 }, fee).feeSats).toBe(12_345);
  });
});

describe('first 1,000 rooms free (server decides)', () => {
  const ok = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  beforeEach(() => resetServerSetupFeeCache());

  test('free while under 1,000: charges nothing and says so', async () => {
    const f = await fetchServerSetupFee(ok({ feeUsd: 0, freeRemaining: 995, reason: 'free-first-1000' }));
    expect(chargeUsd(f)).toBe(0);
    expect(freeRoomNote(f)).toBe('Free: one of the first 1,000 rooms (995 left)');
  });

  test('after 1,000: the server fee, capped at the build fee', async () => {
    const f = await fetchServerSetupFee(ok({ feeUsd: 1, freeRemaining: 0, reason: 'standard' }));
    expect(chargeUsd(f, 1)).toBe(1);
    expect(chargeUsd({ ...f, feeUsd: 50 }, 1)).toBe(1);
    expect(freeRoomNote(f)).toBe('');
  });

  test('a failed or odd answer is FREE, never a charge', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchServerSetupFee(boom)).toEqual(FREE_FEE);
    resetServerSetupFeeCache();
    const bad = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(chargeUsd(await fetchServerSetupFee(bad))).toBe(0);
    expect(chargeUsd(parseServerFee({ feeUsd: 'lots' }))).toBe(0);
    expect(chargeUsd(undefined)).toBe(0);
  });
});
