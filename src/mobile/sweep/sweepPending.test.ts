import { beforeEach, describe, expect, test } from 'bun:test';
import { MAX_AGE_MS, clearSweepPrompt, getSweepPrompt, markSweepPrompt } from './sweepPending';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

describe('pending SimplyCash sweep', () => {
  beforeEach(() => clearSweepPrompt());

  test('fresh mark is honoured', () => {
    markSweepPrompt('simplycash', 1_000);
    expect(getSweepPrompt(1_000 + 60_000)).toBe('simplycash');
  });
  test('expires, and is cleared once expired', () => {
    markSweepPrompt('simplycash', 1_000);
    expect(getSweepPrompt(1_000 + MAX_AGE_MS)).toBeNull();
    expect(getSweepPrompt(1_001)).toBeNull();
  });
  test('a mark from the first version (no time) is dropped', () => {
    localStorage.setItem('bwallet.sweep.pending', 'simplycash');
    expect(getSweepPrompt()).toBeNull();
    expect(localStorage.getItem('bwallet.sweep.pending')).toBeNull();
  });
  test('cleared when another restore option is chosen', () => {
    markSweepPrompt('simplycash');
    clearSweepPrompt();
    expect(getSweepPrompt()).toBeNull();
  });
});
