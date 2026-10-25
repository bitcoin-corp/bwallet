/**
 * Output baskets that belong to the wallet itself (b-Aware report, 23 Oct 2026). Their outputs are the user's
 * coins, ordinals, tokens, locks and names, with tags and decrypted custom instructions. No outside site or app
 * may list, insert into or relinquish from them: a call from any originator other than the wallet's own is
 * refused before any permission prompt, and no grant for them is ever stored or honoured.
 *
 * The permissions manager upstream reserves only 'default' and names starting 'admin'.
 */
import { takeTokenInsertionTicket } from './siteTokens';

/** Same value as permissionBundle.TRUST_SITE_BASKET (not imported: permissionBundle imports this file). */
const TRUST_SITE_BASKET = 'bwalletx.trust-site';
/** The "Block this site" record: kept in the same store so "Forget site" in Settings removes it (unblocks). */
export const BLOCK_SITE_BASKET = 'bwalletx.block-site';

const RESERVED = new Set([
  'default',
  '1sat',
  'bsv21',
  // The legacy name of 'bsv21' (services/legacyBaskets.ts): an account not yet re-filed keeps its tokens there.
  'p 1sat bsv21',
  'lock',
  'opns',
  'fund',
  'funding',
  'vesting',
  TRUST_SITE_BASKET,
]);

export const RESERVED_BASKET_REFUSAL = 'This basket is reserved for bWalletX itself';

export const isReservedBasket = (basket: unknown): boolean => {
  if (typeof basket !== 'string') return false;
  const b = basket.trim().toLowerCase();
  if (!b) return false;
  return RESERVED.has(b) || b.startsWith('admin') || b.startsWith('bwalletx.');
};

type BasketGrantStore = {
  listGrants(filter?: { type?: 'basket' }): Promise<{ key: { type: string; originator: string; basket?: string } }[]>;
  deleteGrant(key: never): Promise<void>;
};

/**
 * Remove every stored grant an outside originator holds for a reserved basket (upgrade migration; safe to run on
 * every unlock). The site-trust and block records are kept: they are not basket grants. Returns how many were removed.
 */
export const revokeReservedBasketGrants = async (store: BasketGrantStore, adminOriginator: string) => {
  const grants = await store.listGrants({ type: 'basket' });
  let removed = 0;
  for (const g of grants) {
    const k = g.key;
    if (k.type !== 'basket' || k.originator === adminOriginator) continue;
    if (k.basket === TRUST_SITE_BASKET || k.basket === BLOCK_SITE_BASKET || !isReservedBasket(k.basket)) continue;
    await store.deleteGrant(k as never);
    removed++;
  }
  return removed;
};

/** Grouped (BRC-73) basket entries an outside app may be granted: reserved ones are dropped. */
export const withoutReservedBaskets = <T extends { basket?: unknown }>(items: T[] | undefined): T[] =>
  (items ?? []).filter((b) => !isReservedBasket(b.basket));

/**
 * Defence in depth inside the permissions manager: refuse reserved baskets for outside originators in
 * ensureBasketAccess (every basket method goes through it), before any stored grant or prompt is consulted, and
 * drop them from grouped grants.
 */
export function guardReservedBaskets<T extends object>(manager: T, adminOriginator: string): T {
  const m = manager as Record<string, unknown>;
  const ensure = m.ensureBasketAccess;
  if (typeof ensure === 'function') {
    m.ensureBasketAccess = async (args: { originator?: string; basket?: unknown; usageType?: unknown }) => {
      // A token delivery siteTokens.ts checked and rewrote (to a receive key the wallet gave this site): this one
      // insertion only, no grant stored, no sheet (docs/SITE-TOKENS.md). Listing and relinquishing stay refused.
      if (
        args?.originator !== adminOriginator &&
        takeTokenInsertionTicket(args?.originator, args?.basket, args?.usageType)
      )
        return true;
      if (args?.originator !== adminOriginator && isReservedBasket(args?.basket))
        throw new Error(`${RESERVED_BASKET_REFUSAL}: "${String(args.basket)}"`);
      return (ensure as (a: unknown) => Promise<boolean>).call(manager, args);
    };
  }
  // A 'p <scheme> …' basket goes to its permission module, not ensureBasketAccess: refuse a reserved one first.
  for (const method of ['listOutputs', 'relinquishOutput']) {
    const fn = m[method];
    if (typeof fn !== 'function') continue;
    m[method] = async (args: { basket?: unknown }, originator?: string) => {
      if (originator !== adminOriginator && isReservedBasket(args?.basket))
        throw new Error(`${RESERVED_BASKET_REFUSAL}: "${String(args.basket)}"`);
      return (fn as (a: unknown, o?: string) => Promise<unknown>).call(manager, args, originator);
    };
  }
  const grouped = m.grantGroupedPermission;
  if (typeof grouped === 'function') {
    m.grantGroupedPermission = async (params: { granted?: { basketAccess?: { basket?: unknown }[] } }) => {
      if (params?.granted?.basketAccess)
        params = {
          ...params,
          granted: { ...params.granted, basketAccess: withoutReservedBaskets(params.granted.basketAccess) },
        };
      return (grouped as (p: unknown) => Promise<void>).call(manager, params);
    };
  }
  return manager;
}

/**
 * "Forget site": delete every basket grant (and the site-trust record) the store holds for this site, matched on
 * the raw and the normalized originator so a grant stored under either form goes. Returns how many were removed.
 */
export const revokeBasketGrantsForOriginator = async (
  store: BasketGrantStore,
  originator: string,
  normalize: (o: string) => string,
): Promise<number> => {
  const targets = new Set([originator, normalize(originator)].filter(Boolean));
  const grants = await store.listGrants({ type: 'basket' });
  let removed = 0;
  for (const g of grants) {
    const k = g.key;
    if (k.type !== 'basket') continue;
    if (!targets.has(k.originator) && !targets.has(normalize(k.originator))) continue;
    await store.deleteGrant(k as never);
    removed++;
  }
  return removed;
};
