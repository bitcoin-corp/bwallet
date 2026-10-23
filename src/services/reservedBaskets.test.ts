import { describe, expect, test } from 'bun:test';
import {
  isAutoGrantable,
  TRUST_SITE_BASKET,
  trustCovers,
  trustedBasketsFrom,
  type BundleRequest,
} from './permissionBundle';
import {
  guardReservedBaskets,
  isReservedBasket,
  revokeBasketGrantsForOriginator,
  revokeReservedBasketGrants,
  withoutReservedBaskets,
} from './reservedBaskets';

const ADMIN = 'admin.bwalletx';
const base = { requestID: 'r1', originator: 'site.example' } as BundleRequest;
const basket = (name: string): BundleRequest => ({ ...base, type: 'basket', basket: name });

type Key = { type: string; originator: string; basket?: string };
const memStore = (keys: Key[]) => {
  let grants = keys.map((key) => ({ key }));
  return {
    listGrants: async (f?: { type?: string }) => grants.filter((g) => !f?.type || g.key.type === f.type),
    deleteGrant: async (k: never) => {
      grants = grants.filter((g) => g.key !== (k as unknown as Key));
    },
    all: () => grants.map((g) => g.key),
  };
};

describe('reserved baskets', () => {
  test("the wallet's own baskets are reserved", () => {
    for (const b of ['default', '1sat', 'bsv21', 'lock', 'opns', 'fund', 'funding', 'vesting', TRUST_SITE_BASKET])
      expect(isReservedBasket(b)).toBe(true);
    expect(isReservedBasket(' 1SAT ')).toBe(true);
    expect(isReservedBasket('admin stuff')).toBe(true);
    expect(isReservedBasket('bchat posts')).toBe(false);
    expect(isReservedBasket(undefined)).toBe(false);
  });

  test('reserved baskets are never auto-granted', () => {
    expect(isAutoGrantable(basket('1sat'))).toBe(false);
    expect(isAutoGrantable(basket('bsv21'))).toBe(false);
    expect(isAutoGrantable(basket('default'))).toBe(false);
    expect(isAutoGrantable(basket('bchat posts'))).toBe(true);
  });

  test("Don't ask again covers only the baskets on the approved sheet", () => {
    const baskets = trustedBasketsFrom([basket('bchat posts'), basket('1sat'), { ...base, type: 'protocol' }]);
    expect(baskets).toEqual(['bchat posts']);
    const trust = { expiry: 0, baskets };
    expect(trustCovers(trust, basket('bchat posts'))).toBe(true);
    expect(trustCovers(trust, basket('other app basket'))).toBe(false);
    expect(trustCovers(trust, basket('1sat'))).toBe(false);
    expect(trustCovers(trust, basket('bsv21'))).toBe(false);
  });

  test('an old trust record without a basket list covers no basket', () => {
    expect(trustCovers({ expiry: 0 }, basket('bchat posts'))).toBe(false);
    expect(trustCovers(null, basket('bchat posts'))).toBe(false);
  });

  test('an expired trust record covers nothing', () => {
    expect(trustCovers({ expiry: 10, baskets: ['bchat posts'] }, basket('bchat posts'), 20_000)).toBe(false);
  });

  test('ensureBasketAccess refuses reserved baskets to outside sites, even with a stored grant', async () => {
    const calls: unknown[] = [];
    const m = guardReservedBaskets(
      {
        ensureBasketAccess: async (a: unknown) => {
          calls.push(a);
          return true;
        },
        grantGroupedPermission: async (p: unknown) => {
          calls.push(p);
        },
      },
      ADMIN,
    );
    await expect(m.ensureBasketAccess({ originator: 'site.example', basket: '1sat' })).rejects.toThrow(/reserved/);
    await expect(m.ensureBasketAccess({ originator: 'site.example', basket: 'bsv21' })).rejects.toThrow(/reserved/);
    expect(calls.length).toBe(0);
    expect(await m.ensureBasketAccess({ originator: ADMIN, basket: '1sat' })).toBe(true);
    expect(await m.ensureBasketAccess({ originator: 'site.example', basket: 'bchat posts' })).toBe(true);
    await m.grantGroupedPermission({ granted: { basketAccess: [{ basket: '1sat' }, { basket: 'posts' }] } });
    expect((calls.at(-1) as { granted: { basketAccess: unknown[] } }).granted.basketAccess).toEqual([
      { basket: 'posts' },
    ]);
  });

  test('withoutReservedBaskets drops wallet baskets', () => {
    expect(withoutReservedBaskets([{ basket: 'default' }, { basket: 'x' }])).toEqual([{ basket: 'x' }]);
  });

  test('upgrade migration removes stored outside grants for reserved baskets', async () => {
    const s = memStore([
      { type: 'basket', originator: 'site.example', basket: '1sat' },
      { type: 'basket', originator: 'site.example', basket: 'posts' },
      { type: 'basket', originator: 'site.example', basket: TRUST_SITE_BASKET },
      { type: 'basket', originator: ADMIN, basket: '1sat' },
    ]);
    expect(await revokeReservedBasketGrants(s, ADMIN)).toBe(1);
    expect(s.all().map((k) => k.basket)).toEqual(['posts', TRUST_SITE_BASKET, '1sat']);
  });

  test('Forget site removes basket grants and the trust record for that site only', async () => {
    const s = memStore([
      { type: 'basket', originator: 'site.example', basket: '1sat' },
      { type: 'basket', originator: 'https://site.example:8080', basket: 'posts' },
      { type: 'basket', originator: 'site.example', basket: TRUST_SITE_BASKET },
      { type: 'basket', originator: 'other.example', basket: 'posts' },
      { type: 'protocol', originator: 'site.example' },
    ]);
    const norm = (o: string) => o.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    expect(await revokeBasketGrantsForOriginator(s, 'https://site.example', norm)).toBe(3);
    expect(s.all()).toEqual([
      { type: 'basket', originator: 'other.example', basket: 'posts' },
      { type: 'protocol', originator: 'site.example' },
    ]);
  });
});
