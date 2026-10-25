import { describe, expect, test } from 'bun:test';
import * as live from './tokenblasterShopX';
import * as store from './tokenblasterShopX.store';
import * as storePacks from './tokenblasterX.store';
import { SHOPS } from '../themeStore/shops';
import { PAID_EDITIONS } from './accents';

describe('TokenBlaster shop', () => {
  test('bWalletX: two $1 packs, Play and Launchpad links, merch and ammo shown as coming', () => {
    const shop = live.TOKENBLASTER_SHOPS[0];
    expect(shop?.themes).toEqual(['tokenblaster', 'terrornode']);
    for (const id of shop?.themes ?? []) expect(PAID_EDITIONS).toContain(id);
    expect(shop?.links?.map((l) => l.href)).toEqual([
      'https://www.tokenblaster.lol',
      'https://www.tokenblaster.lol/launch',
    ]);
    expect(shop?.coming).toEqual(['Merch: coming', 'Terrornode ammo: coming soon']);
    // Right after NPG in the Store.
    const ids = SHOPS.map((s) => s.id);
    expect(ids.indexOf('tokenblaster')).toBe(ids.indexOf('npg') + 1);
  });
  test('store build stand-in has nothing', () => {
    expect(store.TOKENBLASTER_SHOPS).toEqual([]);
    expect(store.TOKENBLASTER_CARD_ART).toEqual({});
    expect(store.TOKENBLASTER_SHOP_ART).toEqual({});
    expect(storePacks.tokenblasterEditions({} as never)).toEqual([]);
  });
});
