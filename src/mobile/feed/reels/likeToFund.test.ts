import { describe, expect, it, beforeEach } from 'bun:test';
import type { Listing } from '../../market/indexer';
import {
  addFundLike,
  BANNED_LIKE_WORDS,
  LIKE_COPY,
  LIKE_DONE,
  LIKE_LABEL,
  LIKE_NO_LISTING,
  loadFundLikes,
  planLike,
} from './likeToFund';
import { keepGlobals } from '../../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

if (typeof globalThis.localStorage === 'undefined') {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    clear: () => m.clear(),
  };
}
const ID = 'a'.repeat(64) + '_0';
const L = (priceSats: number, buyable = true): Listing => ({
  outpoint: `${'b'.repeat(64)}_${priceSats}`,
  priceSats,
  amount: '1',
  label: `1 @ ${priceSats}`,
  origin: null,
  seller: '1x',
  buyable,
});
// $50 / BSV: 1¢ = 20,000 sats.
const RATE = 50;

describe('planLike', () => {
  it('buys the cheapest buyable listing within 1¢', () => {
    const p = planLike(ID, [L(15_000), L(5_000), L(1_000, false), L(30_000)], RATE);
    expect(p).toMatchObject({ kind: 'buy', priceSats: 5_000, feeSats: 0, totalSats: 5_000 });
  });
  it('adds the marketplace fee to the total', () => {
    const p = planLike(ID, [L(10_000)], RATE, (s) => Math.ceil(s * 0.01));
    expect(p).toMatchObject({ kind: 'buy', feeSats: 100, totalSats: 10_100 });
  });
  it('pays nothing when no listing fits 1¢', () => {
    expect(planLike(ID, [L(25_000)], RATE).kind).toBe('no-listing');
    expect(planLike(ID, [], RATE).kind).toBe('no-listing');
  });
  it('refuses without a rate or a real token id', () => {
    expect(planLike(ID, [L(1_000)], 0).kind).toBe('no-rate');
    expect(planLike('not-a-token', [L(1_000)], RATE).kind).toBe('no-token');
  });
});

describe('copy', () => {
  it('has no investment wording', () => {
    for (const s of [LIKE_COPY, LIKE_DONE, LIKE_LABEL, LIKE_NO_LISTING]) expect(s).not.toMatch(BANNED_LIKE_WORDS);
  });
});

describe('fund likes store', () => {
  beforeEach(() => localStorage.setItem('bw.feed.fundLikes.v1', '[]'));
  it('keys on the token id, lowercased', () => {
    addFundLike(ID.toUpperCase());
    addFundLike('junk');
    expect([...loadFundLikes()]).toEqual([ID]);
  });
});

describe('store build gate', () => {
  it('FundLike is only used inside BexReel (absent from a store build, BEX_REEL_ENABLED)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const users: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.tsx?$/.test(n) &&
          !n.includes('.test.') &&
          /from '\.\/FundLike'|\/FundLike'/.test(readFileSync(p, 'utf8'))
        )
          users.push(p.replace(/\\/g, '/'));
      }
    };
    walk(join(import.meta.dir, '../..'));
    expect(users.map((u) => u.split('/').pop())).toEqual(['BexReel.tsx']);
    const fl = readFileSync(join(import.meta.dir, 'FundLike.tsx'), 'utf8');
    expect(fl).toMatch(/if \(!marketTradingEnabled\(\)\) return null;/);
    expect(fl).toMatch(/oneClick\.take\(plan\.totalSats\)/);
  });
});
