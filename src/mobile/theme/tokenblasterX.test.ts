import { describe, expect, test } from 'bun:test';
import * as live from './tokenblasterShopX';
import * as store from './tokenblasterShopX.store';
import * as storePacks from './tokenblasterX.store';
import { SHOPS } from '../themeStore/shops';
import { PAID_EDITIONS } from './accents';

describe('TokenBlaster shop', () => {
  test('bWalletX: two $1 packs, Play and Launchpad links, merch coming, $TERRORNODE ammo as a BlastPad item', () => {
    const shop = live.TOKENBLASTER_SHOPS[0];
    expect(shop?.themes).toEqual(['tokenblaster', 'terrornode']);
    for (const id of shop?.themes ?? []) expect(PAID_EDITIONS).toContain(id);
    expect(shop?.links?.map((l) => l.href)).toEqual([
      'https://www.tokenblaster.lol',
      'https://www.tokenblaster.lol/launch',
    ]);
    expect(shop?.coming).toEqual(['Merch: coming']);
    const ammo = shop?.items?.[0];
    expect(ammo?.line).toBe(
      'Every shot earns you a $TERRORNODE receipt, paid to your paymail when you finish playing.',
    );
    expect(ammo?.tokenId).toBe('d5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1');
    expect(ammo?.links.map((l) => l.label)).toEqual(['Play Assault on Terrornode to earn $TERRORNODE']);
    expect(ammo?.links[0].href).toBe('https://www.tokenblaster.lol/arcade/terrornode');
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
