import { describe, expect, test } from 'bun:test';
import { listingPriceUsd, parseActions, pickListing } from './agentTrade';

describe('agent action blocks', () => {
  test('blocks are pulled out of the reply; bad ones are counted, not run', () => {
    const r = parseActions(
      'Buying a little.\n```bwalletx\n{"kind":"buy","token":"abc_0","usd":2}\n```\n```bwalletx\n{"kind":"rug","token":"x"}\n```',
    );
    expect(r.text).toBe('Buying a little.');
    expect(r.actions).toEqual([{ kind: 'buy', token: 'abc_0', usd: 2 }]);
    expect(r.bad).toBe(1);
    expect(parseActions('no actions').actions).toEqual([]);
  });

  test('at most 3 actions per reply', () => {
    const b = '```bwalletx\n{"kind":"send","token":"BSV","usd":1,"to":"a@b.c"}\n```';
    expect(parseActions([b, b, b, b].join('\n')).actions).toHaveLength(3);
  });

  test('the cheapest buyable listing within budget', () => {
    const l = (priceSats: number, buyable = true) => ({
      outpoint: `o${priceSats}`,
      priceSats,
      amount: '1',
      label: '',
      origin: null,
      seller: '',
      buyable,
    });
    // 1e8 sats = $50
    expect(pickListing([l(4e6), l(2e6), l(1e6, false)], 2, 50)?.priceSats).toBe(2e6);
    expect(pickListing([l(5e6)], 2, 50)).toBeNull();
  });

  test('the price checked is the picked listing’s, not the floor (b-Aware, 24 Oct 2026)', () => {
    expect(listingPriceUsd({ perTokenSats: 2e6 }, 50)).toBe(1);
    expect(listingPriceUsd({}, 50)).toBeUndefined();
    expect(listingPriceUsd({ perTokenSats: Infinity }, 50)).toBeUndefined();
  });
});
