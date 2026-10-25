import { describe, expect, test } from 'bun:test';
import { TOKENBLASTER_ORIGIN, parseTokenStore, safeHttpsUrl, storeChecklist } from './tokenStore';
import { boardPrice, launchedAgo, sortNewest, type BoardCoin } from '../market/launchpad/api';

const theme = {
  v: 2,
  name: 'Frogger',
  mode: 'dark',
  accent: '#33CC66',
  bg: '#000000',
  surface: '#111111',
  text: '#FFFFFF',
};

describe('parseTokenStore', () => {
  test('reads a valid theme, merch link and room', () => {
    const s = parseTokenStore(
      { theme, merch_url: 'https://shop.example.com/frog', room: '$frogger' },
      TOKENBLASTER_ORIGIN,
    );
    expect(s.theme?.name).toBe('Frogger');
    expect(s.merchUrl).toBe('https://shop.example.com/frog');
    expect(s.room).toBe('FROGGER');
  });
  test('drops malformed fields', () => {
    const s = parseTokenStore(
      { theme: { ...theme, logo: 'https://evil.example/x.png' }, merch_url: 'javascript:alert(1)', room: '<b>' },
      TOKENBLASTER_ORIGIN,
    );
    expect(s).toEqual({ theme: null, merchUrl: null, room: null });
    expect(parseTokenStore(null, TOKENBLASTER_ORIGIN).theme).toBeNull();
  });
  test('https only, no credentials', () => {
    expect(safeHttpsUrl('http://a.com')).toBeNull();
    expect(safeHttpsUrl('https://u:p@a.com')).toBeNull();
  });
  test('checklist marks what is live', () => {
    const items = storeChecklist({ theme: null, merchUrl: 'https://a.com/', room: null }, true);
    expect(items.map((i) => i.live)).toEqual([true, false, true, false]);
  });
});

describe('TokenBlaster listing helpers', () => {
  const coin = (sym: string, created_at: string, extra: Partial<BoardCoin> = {}) =>
    ({ sym, created_at, sold: 0, ...extra }) as unknown as BoardCoin;
  test('newest first, bad dates last', () => {
    const out = sortNewest([coin('A', '2026-10-01T00:00:00Z'), coin('B', 'nope'), coin('C', '2026-10-06T00:00:00Z')]);
    expect(out.map((c) => c.sym)).toEqual(['C', 'A', 'B']);
  });
  test('prefers price_sats, else curve', () => {
    expect(boardPrice({ sold: 0, price_sats: 2.5 })).toBe(2.5);
    expect(boardPrice({ sold: 0, price_sats: 'x' })).toBeCloseTo(100_000_000 / 1_073_000_000, 6);
  });
  test('launchedAgo', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    expect(launchedAgo('2026-10-25T09:00:00Z', now)).toBe('3h ago');
    expect(launchedAgo('2026-10-20T12:00:00Z', now)).toBe('5 days ago');
    expect(launchedAgo('bad', now)).toBe('');
  });
});
