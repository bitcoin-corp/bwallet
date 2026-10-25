import { describe, expect, test } from 'bun:test';
import {
  SEED_RESTORE_OFFER_MS,
  dismissSeedRestore,
  markBackupImported,
  markSeedRestore,
  readSeedRestore,
  shouldOfferFullWallet,
} from './seedRestoreGap';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('seed restore offer', () => {
  test('never offered for an account that was not restored from its words', () => {
    expect(shouldOfferFullWallet(readSeedRestore('1Addr', mem()))).toBe(false);
  });

  test('offered right after a seed restore', () => {
    const s = mem();
    markSeedRestore('1Addr', 1000, s);
    expect(shouldOfferFullWallet(readSeedRestore('1Addr', s), 2000)).toBe(true);
  });

  test('kept per account', () => {
    const s = mem();
    markSeedRestore('1Addr', 1000, s);
    expect(readSeedRestore('1Other', s)).toBeNull();
  });

  test('gone once the user says it is all here', () => {
    const s = mem();
    markSeedRestore('1Addr', 1000, s);
    dismissSeedRestore('1Addr', s);
    expect(shouldOfferFullWallet(readSeedRestore('1Addr', s), 2000)).toBe(false);
  });

  test('gone once a master backup is imported', () => {
    const s = mem();
    markSeedRestore('1Addr', 1000, s);
    markBackupImported('1Addr', 1500, s);
    expect(shouldOfferFullWallet(readSeedRestore('1Addr', s), 2000)).toBe(false);
  });

  test('expires after the offer window', () => {
    const s = mem();
    markSeedRestore('1Addr', 0, s);
    expect(shouldOfferFullWallet(readSeedRestore('1Addr', s), SEED_RESTORE_OFFER_MS + 1)).toBe(false);
  });

  test('a fresh restore re-arms a dismissed offer', () => {
    const s = mem();
    markSeedRestore('1Addr', 0, s);
    dismissSeedRestore('1Addr', s);
    markSeedRestore('1Addr', 5000, s);
    expect(shouldOfferFullWallet(readSeedRestore('1Addr', s), 6000)).toBe(true);
  });

  test('corrupt or blocked storage never throws and never offers', () => {
    const bad = {
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSeedRestore('1Addr', bad)).toBeNull();
    expect(() => markSeedRestore('1Addr', 0, bad)).not.toThrow();
    expect(readSeedRestore('1Addr', undefined)).toBeNull();
  });
});
