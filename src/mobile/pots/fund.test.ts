import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Hash, Utils } from '@bsv/sdk';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
// The fund pays bCorp's fee address, a build-time define; tests give it a placeholder.
(globalThis as Record<string, unknown>).__MARKET_FEE_ADDRESS__ = '1BcorpFeeAddressPlaceholderxxxxxx';

const fund = await import('./fund');
const pots = await import('./pots');

const KEY = '02' + 'ab'.repeat(32);
const POT = '1PotAddressxxxxxxxxxxxxxxxxxxxxxx';

describe('Back bWalletX', () => {
  beforeEach(() => mem.clear());

  test('memo names the supporter by hash160 of their identity key and fits the subscription memo rule', () => {
    const memo = fund.fundMemo(KEY);
    expect(memo).toBe(`bwalletx-fund:${Utils.toHex(Hash.hash160(Utils.toArray(KEY, 'hex')))}`);
    expect(pots.SUB_MEMO_RE.test(memo)).toBe(true);
    expect(() => fund.fundMemo('not-a-key')).toThrow();
  });

  test('set-aside amount: months × monthly, and its sats at a given rate', () => {
    expect(fund.fundPlan(10, 6, 50)).toEqual({
      usdPerMonth: 10,
      months: 6,
      setAsideUsd: 60,
      setAsideSats: 120_000_000,
    });
    expect(fund.fundPlan(5, 3, 0).setAsideSats).toBeNull();
    expect(fund.fundPlan(2.5, 3, 40).setAsideSats).toBe(Math.ceil((7.5 / 40) * 1e8));
  });

  test('limits', () => {
    expect(fund.fundProblem(0.5, 6)).not.toBeNull();
    expect(fund.fundProblem(10, 0)).not.toBeNull();
    expect(fund.fundProblem(10, 6)).toBeNull();
    expect(fund.fundProblem(fund.MAX_FUND_USD + 1, 6)).not.toBeNull();
  });

  test('each month pays that month’s dollars in BSV at that day’s rate', () => {
    const amount = fund.fundSub(POT, 10, fund.fundMemo(KEY)).amount;
    expect(pots.amountSats(amount, 50)).toBe(20_000_000);
    expect(pots.amountSats(amount, 25)).toBe(40_000_000);
  });

  test('a new fund pot gets a monthly, dollar-priced subscription to the fund with the memo', () => {
    fund.startFundPot(10, KEY);
    pots.makePot(POT, fund.FUND_POT_NAME);
    const s = fund.consumeFundIntent(POT, 50, Date.parse('2026-10-10T12:00:00Z'));
    expect(s).not.toBeNull();
    expect(s!.payee.service).toBe(fund.FUND_SERVICE);
    expect(s!.amount).toEqual({ value: 10, currency: 'USD' });
    expect(s!.period).toBe('month');
    expect(s!.memo).toBe(fund.fundMemo(KEY));
    expect(fund.consumeFundIntent(POT, 50)).toBeNull(); // the plan is used once
  });

  test('stopping keeps the pot and its balance: cancel only ends the subscription', () => {
    fund.startFundPot(5, KEY);
    pots.makePot(POT, fund.FUND_POT_NAME);
    const s = fund.consumeFundIntent(POT, 50)!;
    pots.cancelSub(s.id);
    expect(pots.getSub(s.id)!.status).toBe('cancelled');
    expect(pots.getPot(POT)).not.toBeNull();
  });

  test('store edition: hidden (SUBSCRIPTIONS_ENABLED gate, and on the store-bundle grep list)', () => {
    const src = readFileSync(new URL('./fund.ts', import.meta.url), 'utf8');
    expect(src).toContain('SUBSCRIPTIONS_ENABLED && !!servicePayee(FUND_SERVICE)');
    const audit = readFileSync(new URL('../../../docs/STORE-AUDIT.md', import.meta.url), 'utf8');
    expect(audit).toContain('Back bWalletX');
  });
});
