import { describe, expect, test } from 'bun:test';
import { sweepFeeOk } from './sweepLegacyMnee';

describe('legacy MNEE sweep fee cap (b-Aware report, 24 Oct 2026)', () => {
  test('normal fees pass', () => {
    expect(sweepFeeOk(5_000_000, 1_000)).toBe(true); // 0.01 MNEE on 50 MNEE
    expect(sweepFeeOk(50_000, 1_000)).toBe(true); // 0.01 MNEE floor on 0.5 MNEE
    expect(sweepFeeOk(5_000_000, 0)).toBe(true);
  });
  test('a fee taking most of the balance is refused', () => {
    expect(sweepFeeOk(100_000, 99_999)).toBe(false);
    expect(sweepFeeOk(100_000_000, 200_000)).toBe(false); // over 1 MNEE
    expect(sweepFeeOk(5_000_000, 60_000)).toBe(false); // over 1%
    expect(sweepFeeOk(5_000_000, -1)).toBe(false);
    expect(sweepFeeOk(5_000_000, 0.5)).toBe(false);
  });
});
