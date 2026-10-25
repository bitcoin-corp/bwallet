import { beforeEach, describe, expect, test } from 'bun:test';
import {
  examplesHidden,
  hiddenExampleIds,
  hideExample,
  markSwipeHintSeen,
  setExamplesHidden,
  swipeHintSeen,
  unhideExample,
} from './examples';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};

describe('example letters: delete all / delete one persist per account', () => {
  beforeEach(() => mem.clear());

  test('Delete all examples hides them for that account only', () => {
    expect(examplesHidden('A')).toBe(false);
    setExamplesHidden(true, 'A');
    expect(examplesHidden('A')).toBe(true);
    expect(examplesHidden('B')).toBe(false);
  });

  test('the old device-wide hide still counts, and Show again clears it', () => {
    mem.set('bw-bmail-examples-hidden', '1');
    expect(examplesHidden('A')).toBe(true);
    setExamplesHidden(false, 'A');
    expect(examplesHidden('A')).toBe(false);
  });

  test('deleting one example persists, per account, and can be undone', () => {
    hideExample('ex-letter', 'A');
    hideExample('ex-letter', 'A');
    hideExample('ex-intro', 'A');
    expect(hiddenExampleIds('A')).toEqual(['ex-letter', 'ex-intro']);
    expect(hiddenExampleIds('B')).toEqual([]);
    unhideExample('ex-letter', 'A');
    expect(hiddenExampleIds('A')).toEqual(['ex-intro']);
  });

  test('Show examples again brings back single deleted ones too', () => {
    hideExample('ex-intro', 'A');
    setExamplesHidden(true, 'A');
    setExamplesHidden(false, 'A');
    expect(examplesHidden('A')).toBe(false);
    expect(hiddenExampleIds('A')).toEqual([]);
  });

  test('corrupt storage reads as nothing hidden', () => {
    mem.set('bw-bmail-examples-hidden:one:A', '{bad');
    expect(hiddenExampleIds('A')).toEqual([]);
  });

  test('swipe hint plays once', () => {
    expect(swipeHintSeen()).toBe(false);
    markSwipeHintSeen();
    expect(swipeHintSeen()).toBe(true);
  });
});
