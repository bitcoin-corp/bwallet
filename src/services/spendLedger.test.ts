/**
 * Monthly allowances must not trust the storage server's month-to-date figure alone (b-Aware report, 23 Oct 2026).
 * Local only: fake-indexeddb, a stub wallet whose listActions always reports nothing spent.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import { currentMonthUTC, openSpendLedger, withLocalSpendLedger } from './spendLedger';

const SITE = 'ledger.example';
const BUDGET = 5_000_000;
let n = 0;
const acct = () => `1LedgerAcct${++n}`;

const allowance = () =>
  ({
    key: { type: 'spending', originator: normalizeOriginator(SITE) },
    expiry: 0,
    grantedAt: Date.now(),
    authorizedAmount: BUDGET,
    reason: 'Up to $5 a month without asking',
  }) as never;

const managerFor = async (accountId: string) => {
  const store = new InMemoryPermissionStore();
  await store.putGrant(allowance());
  // Storage that under-reports: every listActions answer says nothing was spent.
  const w = {
    listActions: async () => ({ actions: [], totalActions: 0 }),
    listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
  };
  const ledger = await openSpendLedger(accountId);
  const mgr = withLocalSpendLedger(
    new LocalWalletPermissionsManager(w as never, 'wallet-admin-id', {}, { store } as never),
    ledger,
    () => undefined,
  );
  const pay = (satoshis: number) =>
    mgr.ensureSpendingAuthorization({ originator: SITE, satoshis, reason: 'pay', seekPermission: false } as never).then(
      () => 'auto',
      () => 'asks',
    );
  return { mgr, ledger, pay };
};

describe('local spend ledger', () => {
  test('a storage server reporting nothing spent does not let spends past the allowance through', async () => {
    const { pay, ledger } = await managerFor(acct());
    expect(await pay(3_000_000)).toBe('auto');
    expect(await pay(3_000_000)).toBe('asks');
    expect(await pay(2_000_000)).toBe('auto');
    expect(await pay(1)).toBe('asks');
    await ledger.close();
  });

  test('querySpentSince is max(local, remote)', async () => {
    const { mgr, pay, ledger } = await managerFor(acct());
    await pay(1_000_000);
    expect(await mgr.querySpentSince({ originator: normalizeOriginator(SITE), rawOriginator: SITE } as never)).toBe(
      1_000_000,
    );
    await ledger.close();
  });

  test('the record survives a restart', async () => {
    const id = acct();
    const a = await managerFor(id);
    expect(await a.pay(4_000_000)).toBe('auto');
    await a.ledger.close();
    const b = await managerFor(id);
    expect(await b.pay(2_000_000)).toBe('asks');
    expect(await b.ledger.total(SITE, currentMonthUTC())).toBe(4_000_000);
    await b.ledger.close();
  });

  test('accounts keep separate records', async () => {
    const a = await managerFor(acct());
    expect(await a.pay(4_500_000)).toBe('auto');
    const b = await managerFor(acct());
    expect(await b.ledger.total(SITE, currentMonthUTC())).toBe(0);
    expect(await b.pay(4_500_000)).toBe('auto');
    await a.ledger.close();
    await b.ledger.close();
  });

  test('months and apps are separate', async () => {
    const ledger = await openSpendLedger(acct());
    await ledger.record(SITE, '2026-09', 10);
    await ledger.record('other.example', currentMonthUTC(), 20);
    expect(await ledger.total(SITE, currentMonthUTC())).toBe(0);
    expect(await ledger.total(SITE, '2026-09')).toBe(10);
    await ledger.close();
  });
});
