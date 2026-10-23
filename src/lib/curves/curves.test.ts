import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  PRESETS,
  costToBuy,
  curveCommitment,
  curveLines,
  earlyTierAllowanceUsd,
  earlyTierSummary,
  expRateFor,
  fitToSupply,
  makeCurve,
  maxPrice,
  parseCurve,
  preset,
  standardCurve,
  priceAt,
  raiseAt,
  sha256Hex,
  tokensForUsd,
  usd,
  usdToSats,
  verifyCurve,
  type CurveShape,
} from './index';

const close = (a: number, b: number, rel = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(b) * rel + 1e-9);

describe('standard launch', () => {
  const c = preset('standard');
  test('1¢ → 19¢, $100M at 100%', () => {
    close(priceAt(c, 0), 0.01);
    close(priceAt(c, 1), 0.19);
    close(raiseAt(c, 1), 100_000_000);
    close(priceAt(c, 0.5), 0.1);
  });
  test('first $10 buys 999 tokens (price rises a hair inside them)', () => expect(tokensForUsd(c, 0, 10)).toBe(999));
  test('flat curve is exact', () => expect(tokensForUsd(makeCurve({ ceilingRaiseUsd: 1 }), 0, 10)).toBe(1000));
  test('10¢ buy works', () => expect(tokensForUsd(c, 0, 0.1)).toBe(10));
  test('early tier is on by default', () => {
    const e = earlyTierSummary(c)!;
    expect(e.tokens).toBe(10_000_000);
    expect(e.people).toBeGreaterThan(10_000);
  });
});

describe('every shape', () => {
  for (const shape of ['linear', 'sigmoid', 'exponential'] as CurveShape[]) {
    const c = makeCurve({ shape, ceilingRaiseUsd: 50_000_000 });
    test(`${shape}: hits the ceiling, starts at floor, is monotone`, () => {
      close(raiseAt(c, 1), 50_000_000, 1e-6);
      close(priceAt(c, 0), 0.01);
      let last = 0;
      for (let i = 0; i <= 100; i++) {
        const p = priceAt(c, i / 100);
        expect(p).toBeGreaterThanOrEqual(last - 1e-12);
        last = p;
      }
      close(priceAt(c, 1), maxPrice(c));
    });
    test(`${shape}: costToBuy and tokensForUsd invert`, () => {
      const sold = 123_456_789;
      const n = tokensForUsd(c, sold, 5000);
      expect(costToBuy(c, sold, sold + n)).toBeLessThanOrEqual(5000 + 1e-6);
      expect(costToBuy(c, sold, sold + n + 1)).toBeGreaterThan(5000 - 1e-3);
    });
    test(`${shape}: raise integrates price`, () => {
      // trapezoid check over a slice
      const a = 0.3;
      const b = 0.31;
      let s = 0;
      const steps = 1000;
      for (let i = 0; i < steps; i++) s += priceAt(c, a + ((b - a) * (i + 0.5)) / steps) * ((b - a) / steps) * c.supply;
      close(raiseAt(c, b) - raiseAt(c, a), s, 1e-4);
    });
  }
});

test('buy caps at remaining supply', () => {
  const c = preset('standard');
  expect(tokensForUsd(c, 1e9 - 10, 1e12)).toBe(10);
  expect(tokensForUsd(c, 1e9, 10)).toBe(0);
  expect(tokensForUsd(c, 0, 0)).toBe(0);
});

test('every climb: 1B supply, 1¢ first token, early tier on, 12-month burn', () => {
  const want = { standard: [1e8, 0.19], big: [1e9, 1.99], huge: [1e10, 19.99] } as const;
  for (const id of ['standard', 'big', 'huge'] as const) {
    const c = PRESETS[id].curve;
    expect(c.supply).toBe(1e9);
    expect(c.floorUsd).toBe(0.01);
    expect(c.earlyTier).toEqual({ fraction: 0.01, maxUsdPerIdentity: 10 });
    expect(c.burnAfterMonths).toBe(12);
    close(raiseAt(c, 1), want[id][0]);
    close(maxPrice(c), want[id][1]);
  }
});

test('standardCurve: shape and burn choices keep the raise', () => {
  const s = standardCurve('big', 'exponential', null);
  expect(s.shape).toBe('exponential');
  expect(s.burnAfterMonths).toBeNull();
  close(raiseAt(s, 1), 1e9);
  expect(standardCurve('standard', 'sigmoid', 6).burnAfterMonths).toBe(6);
});

test('maxPrice input and too-small ceiling', () => {
  close(makeCurve({ maxPrice: 0.19 }).ceilingRaiseUsd, 100_000_000);
  const e = makeCurve({ shape: 'exponential', maxPrice: 1 });
  expect(makeCurve({ earlyTier: null }).earlyTier).toBeNull();
  close(maxPrice(e), 1, 1e-6);
  expect(makeCurve({ ceilingRaiseUsd: 1 }).ceilingRaiseUsd).toBe(10_000_000);
  expect(expRateFor(1)).toBe(0);
});

test('fitToSupply keeps prices', () => {
  const c = fitToSupply(preset('standard'), 1_000_000);
  expect(c.supply).toBe(1_000_000);
  close(maxPrice(c), 0.19);
  expect(fitToSupply(preset('standard'), 2e9).supply).toBe(1e9);
});

test('early tier allowance', () => {
  const c = preset('standard');
  expect(earlyTierAllowanceUsd(c, 0, 3)).toBe(7);
  expect(earlyTierAllowanceUsd(c, 0, 30)).toBe(0);
  expect(earlyTierAllowanceUsd(c, 20_000_000, 30)).toBe(Infinity);
  expect(earlyTierAllowanceUsd(makeCurve({ earlyTier: null }), 0, 1e9)).toBe(Infinity);
});

test('sha256 matches node', () => {
  for (const s of ['', 'abc', 'x'.repeat(200), '¢ ünïcode'])
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
});

describe('commitment', () => {
  test('round trips and verifies', () => {
    const m = curveCommitment(preset('standard'));
    const v = verifyCurve(m);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.curve.ceilingRaiseUsd).toBe(100_000_000);
    if (v.ok) expect(v.curve.burnAfterMonths).toBe(12);
    expect(m.curve).toContain('"burnAfterMonths":12');
    expect(parseCurve(m.curve)?.earlyTier).toEqual({ fraction: 0.01, maxUsdPerIdentity: 10 });
  });
  test('tampering fails', () => {
    const m = curveCommitment(preset('standard'));
    expect(verifyCurve({ ...m, curve: m.curve.replace('100000000', '200000000') }).ok).toBe(false);
    expect(verifyCurve({ curve: m.curve }).ok).toBe(false);
    expect(verifyCurve({ ...m, curve: ' ' + m.curve }).ok).toBe(false);
    expect(verifyCurve(null).ok).toBe(false);
  });
  test('preset name does not change the hash', () => {
    const a = curveCommitment(preset('big'));
    const { preset: _p, ...rest } = preset('big');
    expect(curveCommitment(makeCurve(rest)).curveHash).toBe(a.curveHash);
  });
});

test('plain words', () => {
  expect(usd(0.01)).toBe('1¢');
  expect(usd(100_000_000)).toBe('$100M');
  expect(usd(10_000)).toBe('$10K');
  expect(usd(1.99)).toBe('$1.99');
  const lines = curveLines(preset('standard'));
  expect(lines[0]).toBe('First $10 buys 999 tokens');
  expect(lines[1]).toBe('If all sell: $100M raised');
  expect(lines[3]).toBe('Unsold after 12 months: burnt');
  expect(lines[4]).toContain('Early tier: first 1% · max $10 each');
  expect(curveLines(standardCurve('standard', 'linear', null))[3]).toBe('Unsold: stays on sale forever');
  expect(usdToSats(1, 50)).toBe(2_000_000);
  expect(usdToSats(1, 0)).toBe(0);
});
