/**
 * Every payment shows its own sheet (owner, 25 Oct 2026). An old stored monthly grant pays nothing silently.
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import { guardEverySpendAsks, revokeStoredSpendingGrants } from './everySpendAsks';

const A = 'https://shop.example';

const storeWithOldGrant = async () => {
  const store = new InMemoryPermissionStore();
  await store.putGrant({
    key: { type: 'spending', originator: normalizeOriginator(A) },
    expiry: 0,
    grantedAt: Date.now(),
    authorizedAmount: 5_000_000,
  } as never);
  return store;
};

const realManager = (store: InMemoryPermissionStore, answer: boolean) => {
  const w = {
    listActions: async () => ({ actions: [], totalActions: 0 }),
    listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
  };
  const mgr = new LocalWalletPermissionsManager(w as never, 'admin', {}, { store } as never);
  const sheets: { originator: string; satoshis: number }[] = [];
  (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async (r: {
    originator: string;
    spending: { satoshis: number };
  }) => {
    sheets.push({ originator: r.originator, satoshis: r.spending.satoshis });
    if (!answer) throw new Error('User denied');
    return true;
  };
  return { mgr, sheets };
};

describe('old stored monthly grant', () => {
  test('without the guard it would pay silently (the bug)', async () => {
    const { mgr, sheets } = realManager(await storeWithOldGrant(), true);
    expect(await mgr.ensureSpendingAuthorization({ originator: A, satoshis: 1_000, reason: 'pay' } as never)).toBe(
      true,
    );
    expect(sheets.length).toBe(0);
  });

  test('a site payment under it still shows the sheet; Approve pays', async () => {
    const { mgr, sheets } = realManager(await storeWithOldGrant(), true);
    const g = guardEverySpendAsks(mgr, { adminOriginator: 'admin', normalize: normalizeOriginator });
    expect(await g.ensureSpendingAuthorization({ originator: A, satoshis: 1_000, reason: 'pay' } as never)).toBe(true);
    expect(sheets).toEqual([{ originator: normalizeOriginator(A), satoshis: 1_000 }]);
    // A second payment asks again: approving once stores nothing that pays later.
    await g.ensureSpendingAuthorization({ originator: A, satoshis: 1_000, reason: 'pay' } as never);
    expect(sheets.length).toBe(2);
  });

  test('Deny does not pay', async () => {
    const { mgr, sheets } = realManager(await storeWithOldGrant(), false);
    const g = guardEverySpendAsks(mgr, { adminOriginator: 'admin', normalize: normalizeOriginator });
    await expect(
      g.ensureSpendingAuthorization({ originator: A, satoshis: 1_000, reason: 'pay' } as never),
    ).rejects.toThrow();
    expect(sheets.length).toBe(1);
  });

  test('seekPermission=false is refused, never silently approved', async () => {
    const { mgr, sheets } = realManager(await storeWithOldGrant(), true);
    const g = guardEverySpendAsks(mgr, { adminOriginator: 'admin', normalize: normalizeOriginator });
    await expect(
      g.ensureSpendingAuthorization({ originator: A, satoshis: 1_000, seekPermission: false } as never),
    ).rejects.toThrow(/approval/);
    expect(sheets.length).toBe(0);
  });

  test('the wallet itself (pots, scheduled payments) and spends of 0 keep the original path', async () => {
    let calls = 0;
    const fake = {
      ensureSpendingAuthorization: async () => {
        calls++;
        return true;
      },
      requestPermissionFlow: async () => {
        throw new Error('no sheet expected');
      },
    };
    const g = guardEverySpendAsks(fake, { adminOriginator: 'admin', normalize: normalizeOriginator });
    expect(await g.ensureSpendingAuthorization({ originator: 'admin', satoshis: 5_000 } as never)).toBe(true);
    expect(await g.ensureSpendingAuthorization({ originator: A, satoshis: 0 } as never)).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('start-up migration', () => {
  test('removes site spending grants, keeps the wallet own and other grant types; idempotent', async () => {
    const store = await storeWithOldGrant();
    await store.putGrant({ key: { type: 'spending', originator: 'admin' }, expiry: 0, grantedAt: 1 } as never);
    await store.putGrant({
      key: { type: 'basket', originator: normalizeOriginator(A), basket: 'x' },
      expiry: 0,
      grantedAt: 1,
    } as never);
    expect(await revokeStoredSpendingGrants(store as never, 'admin')).toBe(1);
    expect(await revokeStoredSpendingGrants(store as never, 'admin')).toBe(0);
    expect(await store.findGrant({ type: 'spending', originator: normalizeOriginator(A) } as never)).toBeFalsy();
    expect(await store.findGrant({ type: 'spending', originator: 'admin' } as never)).toBeTruthy();
    expect(
      await store.findGrant({ type: 'basket', originator: normalizeOriginator(A), basket: 'x' } as never),
    ).toBeTruthy();
  });
});
