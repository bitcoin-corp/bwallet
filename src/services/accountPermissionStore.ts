import { IndexedDbPermissionStore } from '@1sat/wallet-browser';

/**
 * App grants (site approvals, basket/protocol/spending grants, the monthly allowance) belong to one account
 * (b-Aware report, 23-24 Oct 2026). Until 5.2.x every account on a device shared one store, "yours-wallet", so a
 * grant or allowance made on one account was shown and honoured on every other account. Each account now gets its
 * own IndexedDB store, named after its identity address.
 *
 * Legacy grants: the shared store cannot say which account a grant was made on. It is copied only when the device
 * has exactly one account (that account made every grant). With several accounts it is dropped and sites ask again.
 * Either way the legacy store is deleted, so this runs once.
 */
export const LEGACY_PERMISSION_SCOPE = 'yours-wallet';
const DEFAULT_DATABASE_NAME = '1sat-wallet-permissions';

export const permissionScopeFor = (accountId: string): string => {
  if (!accountId) throw new Error('permission store needs an account id');
  return `${LEGACY_PERMISSION_SCOPE}:${accountId}`;
};

const legacyDatabaseName = `${DEFAULT_DATABASE_NAME}:${LEGACY_PERMISSION_SCOPE}`;

const legacyExists = async (): Promise<boolean> => {
  const list = (indexedDB as { databases?: () => Promise<{ name?: string }[]> }).databases;
  if (typeof list !== 'function') return true; // cannot tell: open it (an empty store migrates nothing)
  try {
    return (await list.call(indexedDB)).some((d) => d.name === legacyDatabaseName);
  } catch {
    return true;
  }
};

const deleteDatabase = (name: string) =>
  new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

export type MigrationResult = 'none' | 'migrated' | 'dropped';

/** Move or drop the pre-fix shared grants. Idempotent: the legacy store is gone afterwards. */
export async function migrateLegacyGrants(
  target: IndexedDbPermissionStore,
  accountCount: number,
): Promise<{ result: MigrationResult; count: number }> {
  if (!(await legacyExists())) return { result: 'none', count: 0 };
  const legacy = new IndexedDbPermissionStore({ scope: LEGACY_PERMISSION_SCOPE });
  let grants: Awaited<ReturnType<IndexedDbPermissionStore['listGrants']>> = [];
  try {
    grants = await legacy.listGrants();
  } finally {
    await legacy.close().catch(() => undefined);
  }
  let result: MigrationResult = 'none';
  if (grants.length && accountCount === 1) {
    for (const g of grants) await target.putGrant(g);
    result = 'migrated';
  } else if (grants.length) {
    result = 'dropped';
  }
  await deleteDatabase(legacyDatabaseName);
  return { result, count: grants.length };
}

/** The permission store for one account, with the one-time legacy migration applied. */
export async function openAccountPermissionStore(
  accountId: string,
  accountCount: number,
): Promise<IndexedDbPermissionStore> {
  const store = new IndexedDbPermissionStore({ scope: permissionScopeFor(accountId) });
  try {
    const { result, count } = await migrateLegacyGrants(store, accountCount);
    if (result !== 'none') console.warn(`[permissions] legacy shared grants ${result} (${count})`);
  } catch (e) {
    // Never fall back to the shared store: the account simply starts without old grants.
    console.warn('[permissions] legacy grant migration failed:', e);
  }
  return store;
}

/**
 * A paired session is device-wide (mobile/pair/sessions.ts), so withdrawing it must reach every account's store,
 * not just the account that happens to be open when the revocation is flushed.
 */
export async function revokeOriginatorInAccounts(accountIds: string[], originator: string): Promise<number> {
  let n = 0;
  for (const id of new Set(accountIds.filter(Boolean))) {
    const store = new IndexedDbPermissionStore({ scope: permissionScopeFor(id) });
    try {
      n += await store.deleteAllForOriginator(originator);
    } finally {
      await store.close().catch(() => undefined);
    }
  }
  return n;
}
