import { beforeEach, describe, expect, test } from 'bun:test';
import { arrange, readArchived, readPinned, setArchived, setPinned, togglePin } from './tokenRows';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

describe('token row pins', () => {
  test('pinned rows come first, in the order pinned', () => {
    let pins: string[] = [];
    pins = togglePin(pins, 'c');
    pins = togglePin(pins, 'a');
    const r = arrange(['a', 'b', 'c', 'd'], (x) => x, pins);
    expect(r.pinned).toEqual(['c', 'a']);
    expect(r.rest).toEqual(['b', 'd']);
  });
  test('unpin removes it from the group', () => {
    expect(togglePin(['c', 'a'], 'c')).toEqual(['a']);
  });
  test('archived rows leave both groups', () => {
    const r = arrange(['a', 'b', 'c'], (x) => x, ['a'], ['a', 'b']);
    expect(r.pinned).toEqual([]);
    expect(r.rest).toEqual(['c']);
    expect(r.archived).toEqual(['a', 'b']);
  });
  test('a pin for a token no longer held is ignored', () => {
    expect(arrange(['a'], (x) => x, ['gone', 'a']).pinned).toEqual(['a']);
  });
});

describe('persistence', () => {
  test('pins and archive survive a reload (per device)', () => {
    setPinned(['bsv', 'tok']);
    setArchived('junk', true);
    expect(readPinned()).toEqual(['bsv', 'tok']);
    expect(readArchived()).toEqual(['junk']);
    setArchived('junk', false);
    expect(readArchived()).toEqual([]);
  });
});
