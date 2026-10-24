import { describe, expect, test } from 'bun:test';
import { quarantineIsEmpty, quarantineTotal } from './quarantineCount';

describe('Quarantine count', () => {
  test('badge counts letters and airdrops', () => {
    expect(quarantineTotal(0, 2)).toBe(2);
    expect(quarantineTotal(3, 1)).toBe(4);
  });
  test('empty note only when nothing is listed', () => {
    expect(quarantineIsEmpty(0, 2)).toBe(false);
    expect(quarantineIsEmpty(1, 0)).toBe(false);
    expect(quarantineIsEmpty(0, 0)).toBe(true);
  });
});
