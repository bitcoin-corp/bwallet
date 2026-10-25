import { describe, expect, test } from 'bun:test';
import { isBasketRead, ManifestOnce, SessionBasketDenials, wantsManifestSheet } from './sessionDenials';

const memStore = (init: string[] = []) => {
  let keys = [...init];
  return {
    store: {
      load: async () => keys,
      save: async (k: string[]) => {
        keys = [...k];
      },
    },
    get: () => keys,
  };
};

describe('isBasketRead', () => {
  test('only listing a named basket', () => {
    expect(isBasketRead({ type: 'basket', basket: 'ordnance', usageType: 'listing' })).toBe(true);
    expect(isBasketRead({ type: 'basket', basket: 'ordnance', usageType: 'insertion' })).toBe(false);
    expect(isBasketRead({ type: 'basket', basket: ' ', usageType: 'listing' })).toBe(false);
    expect(isBasketRead({ type: 'spending', usageType: 'listing' })).toBe(false);
  });
});

describe('SessionBasketDenials', () => {
  test('remembers a No per site and basket', async () => {
    const mem = memStore();
    const d = new SessionBasketDenials(mem.store);
    await d.add('https://Game.Example', 'Ordnance');
    expect(await d.has('game.example', 'ordnance')).toBe(true);
    expect(await d.has('game.example', 'other')).toBe(false);
    expect(await d.has('other.example', 'ordnance')).toBe(false);
    expect(mem.get()).toHaveLength(1);
  });

  test('survives a service-worker restart through the session store', async () => {
    const mem = memStore();
    await new SessionBasketDenials(mem.store).add('game.example', 'ordnance');
    expect(await new SessionBasketDenials(mem.store).has('game.example', 'ordnance')).toBe(true);
  });

  test('forget clears only that site', async () => {
    const d = new SessionBasketDenials(memStore().store);
    await d.add('game.example', 'a');
    await d.add('other.example', 'a');
    await d.forget('game.example');
    expect(await d.has('game.example', 'a')).toBe(false);
    expect(await d.has('other.example', 'a')).toBe(true);
  });

  test('works without a store and ignores bad input', async () => {
    const d = new SessionBasketDenials();
    await d.add(undefined, 'a');
    await d.add('x', 5 as unknown as string);
    expect(await d.has('x', 'a')).toBe(false);
  });
});

describe('manifest sheet', () => {
  test('only for identity-key requests from a site', () => {
    expect(wantsManifestSheet({ identityKey: true }, 'game.example', 'admin')).toBe(true);
    expect(wantsManifestSheet({ identityKey: true }, 'admin', 'admin')).toBe(false);
    expect(wantsManifestSheet({}, 'game.example', 'admin')).toBe(false);
  });

  test('ManifestOnce asks once per site, shares the sheet, swallows a refusal', async () => {
    const once = new ManifestOnce();
    let asks = 0;
    const ask = async () => {
      asks++;
      throw new Error('Not now');
    };
    await Promise.all([once.run('game.example', ask), once.run('https://game.example', ask)]);
    await once.run('game.example', ask);
    expect(asks).toBe(1);
    once.forget('game.example');
    await once.run('game.example', ask);
    expect(asks).toBe(2);
  });
});
