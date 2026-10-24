import { describe, expect, test } from 'bun:test';
import { GRANT_DEFAULT_DAYS, withDefaultExpiry } from './grantExpiry';

describe('withDefaultExpiry (audit 24 Oct B1)', () => {
  const now = 1_800_000_000_000;
  const def = Math.floor(now / 1000) + GRANT_DEFAULT_DAYS * 86400;
  test('no expiry, or 0 ("never"), becomes the default lifetime', () => {
    expect(withDefaultExpiry(undefined, now)).toBe(def);
    expect(withDefaultExpiry(0, now)).toBe(def);
    expect(withDefaultExpiry(null, now)).toBe(def);
    expect(withDefaultExpiry(-5, now)).toBe(def);
    expect(withDefaultExpiry(Number.NaN, now)).toBe(def);
  });
  test('an explicit expiry is kept', () => {
    expect(withDefaultExpiry(1_800_003_600, now)).toBe(1_800_003_600);
  });
  test('default is 90 days', () => expect(GRANT_DEFAULT_DAYS).toBe(90));
});
