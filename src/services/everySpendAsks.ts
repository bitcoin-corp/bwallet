/**
 * Every payment shows its own sheet (owner, 25 Oct 2026: "pay in the moment"; no caps, no silent spending).
 *
 * The upstream LocalWalletPermissionsManager.ensureSpendingAuthorization still honours an OLD stored monthly spending
 * grant: a site payment under it would go through with no sheet. Store builds (no envelopes, no allowances) used the
 * raw manager, so this guard replaces that method on the instance (node_modules untouched):
 * - a site's payment of more than 0 → the normal pay sheet (`requestPermissionFlow`) for this payment only;
 *   Approve pays, Deny refuses; stored spending grants are never consulted;
 * - the wallet itself (admin originator) and spends of 0 → the original method, unchanged. The user's own pots and
 *   scheduled payments run as the wallet, so they stay as they are.
 *
 * `revokeStoredSpendingGrants` is the matching start-up migration: it deletes stored spending grants held by sites
 * (idempotent, logged by the caller). Envelopes live in their own store (services/envelopes.ts) and are not touched.
 */

type SpendArgs = {
  originator?: string;
  satoshis: number;
  lineItems?: unknown[];
  reason?: string;
  seekPermission?: boolean;
};

type Deps = { adminOriginator: string; normalize: (o: string) => string };

export function guardEverySpendAsks<T extends object>(manager: T, deps: Deps): T {
  const m = manager as Record<string, unknown>;
  const original = m.ensureSpendingAuthorization;
  const flow = m.requestPermissionFlow;
  if (typeof original !== 'function' || typeof flow !== 'function') {
    throw new Error(
      'guardEverySpendAsks: permissions manager is missing ensureSpendingAuthorization/requestPermissionFlow',
    );
  }
  m.ensureSpendingAuthorization = async (args: SpendArgs) => {
    if (!args?.originator || args.originator === deps.adminOriginator || !(args.satoshis > 0))
      return (original as (a: SpendArgs) => Promise<boolean>).call(manager, args);
    const originator = deps.normalize(args.originator);
    if (args.seekPermission === false)
      throw new Error(`Spending authorization needs your approval for ${args.satoshis} (seekPermission=false).`);
    return (flow as (r: unknown) => Promise<boolean>).call(manager, {
      type: 'spending',
      originator,
      spending: { satoshis: args.satoshis, lineItems: args.lineItems },
      reason: args.reason,
      renewal: false,
    });
  };
  return manager;
}

type SpendingGrantStore = {
  listGrants(filter?: { type?: 'spending' }): Promise<{ key: { type: string; originator: string } }[]>;
  deleteGrant(key: never): Promise<void>;
};

/** Delete every stored spending grant a site holds (upgrade migration; safe to run on every start). */
export const revokeStoredSpendingGrants = async (store: SpendingGrantStore, adminOriginator: string) => {
  const grants = await store.listGrants({ type: 'spending' });
  let removed = 0;
  for (const g of grants) {
    if (g.key.type !== 'spending' || g.key.originator === adminOriginator) continue;
    await store.deleteGrant(g.key as never);
    removed++;
  }
  return removed;
};
