import { describe, expect, test } from 'bun:test';
import { bsvLabel, changeLabel, dayStats, exchangeView, fiatLabel, parseTrades } from './exchangeData';

const ID = `${'a'.repeat(64)}_0`;

describe('exchange data', () => {
  test('parseTrades: whole-token price, oldest first, junk dropped', () => {
    const t = parseTrades([
      { amt: '200', dec: 2, price: '1000', height: 900 },
      { amt: '100', dec: 0, price: '500', height: 800 },
      { amt: '0', price: '5', height: 850 },
      { amt: '1', price: '0', height: 860 },
    ]);
    expect(t.map((x) => x.height)).toEqual([800, 900]);
    expect(t[1].satsPerToken).toBe(500);
    expect(parseTrades(null)).toEqual([]);
  });

  test('dayStats: last, change against the trade before the window, volume in the window', () => {
    const trades = parseTrades([
      { amt: '1', price: '100', height: 1000 },
      { amt: '1', price: '110', height: 1100 },
      { amt: '2', price: '240', height: 1150 },
    ]);
    const s = dayStats(trades, 1200);
    expect(s.last).toBe(120);
    expect(s.change).toBeCloseTo(0.2);
    expect(s.volume).toBe(350);
    expect(s.trades).toBe(2);
    expect(dayStats([], 1).last).toBeNull();
  });

  test('labels', () => {
    expect(changeLabel(0.042)).toBe('+4.2%');
    expect(changeLabel(-0.031)).toBe('−3.1%');
    expect(changeLabel(null)).toBe('—');
    expect(bsvLabel(120_000)).toBe('0.0012 BSV');
    expect(fiatLabel(1e8, 50)).toBe('$50.00');
    expect(fiatLabel(1, 0)).toBe('');
  });

  test('exchangeView: sub-paths', () => {
    expect(exchangeView('')).toEqual({ tab: 'markets' });
    expect(exchangeView('/swap')).toEqual({ tab: 'swap' });
    expect(exchangeView('orders/')).toEqual({ tab: 'orders' });
    expect(exchangeView('collectibles')).toEqual({ tab: 'more' });
    expect(exchangeView('/names')).toEqual({ tab: 'names' });
    expect(exchangeView('/podcasts')).toEqual({ tab: 'podcasts' });
    expect(exchangeView('/memepool')).toEqual({ tab: 'memepool' });
    expect(exchangeView('/movies')).toEqual({ tab: 'movies' });
    expect(exchangeView(ID)).toEqual({ tab: 'trade', id: ID });
    expect(exchangeView(`${'A'.repeat(64)}.1`)).toEqual({ tab: 'trade', id: `${'a'.repeat(64)}_1` });
    expect(exchangeView('nonsense')).toEqual({ tab: 'markets' });
  });
});
