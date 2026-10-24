import { describe, expect, test } from 'bun:test';
import { normalize, showAmount } from './format';

describe('token decimals from an inscription are bounded', () => {
  test('0..18 format normally', () => {
    expect(showAmount(12345n, 2)).toBe('123.45');
    expect(showAmount(1n, 18)).toBe('0.000000000000000001');
  });
  test('huge, fractional or negative dec shows the raw amount, fast', () => {
    const t = performance.now();
    expect(showAmount(5n, 1e8)).toBe('5');
    expect(showAmount(5n, 19)).toBe('5');
    expect(showAmount(5n, 2.5)).toBe('5');
    expect(normalize('7.5', 1e7)).toBe('7');
    expect(performance.now() - t).toBeLessThan(50);
  });
});
