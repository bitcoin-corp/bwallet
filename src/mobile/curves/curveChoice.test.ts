import { expect, test } from 'bun:test';
import { burnLabel, curveProblem, defaultCurve, satsView } from './curveChoice';

test('standard launch blocks until 1B supply and the permanent tick', () => {
  const c = defaultCurve();
  expect(curveProblem(c, true, 1_000_000)).toContain('1,000,000,000');
  expect(curveProblem(c, false, 1e9)).toContain('permanent');
  expect(curveProblem(c, true, 1e9)).toBeNull();
});

test('sats at the live rate: 1¢ at $17.87 is ~55,960 sats', () => {
  expect(satsView(0.01, 17.87, false, null).text).toBe('≈ 55,960 sats (BSV $17.87)');
  const old = satsView(0.01, 17.87, true, 1_000, 1_000 + 30 * 60_000);
  expect(old.stale).toBe(true);
  expect(old.text).toContain('30 min old');
  expect(satsView(0.01, 0, true, null).text).toBe('BSV price unavailable');
});

test('burn labels', () => {
  expect(burnLabel(null)).toBe('Forever');
  expect(burnLabel(12)).toBe('12 months');
});
