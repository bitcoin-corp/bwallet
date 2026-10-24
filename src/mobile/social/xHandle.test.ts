import { describe, expect, test } from 'bun:test';
import {
  X_HANDLE_TTL_MS,
  checkXOffer,
  forgetXHandle,
  rememberXHandle,
  rememberedXHandle,
  xAlias,
  xAlternatives,
  xOffer,
  xPrefill,
} from './xHandle';

describe('Link your X on Create: prefill', () => {
  test('fills the X display name and avatar', () => {
    expect(xPrefill({ provider: 'x', name: 'b0asex', display: 'Richard Boase', avatar: 'https://x/a.jpg' })).toEqual({
      name: 'Richard Boase',
      avatar: 'https://x/a.jpg',
    });
  });
  test('falls back to the @handle when there is no display name', () => {
    expect(xPrefill({ provider: 'x', name: '@b0asex', display: '', avatar: null })).toEqual({
      name: 'b0asex',
      avatar: '',
    });
  });
  test('a placeholder display name is not used', () => {
    expect(xPrefill({ provider: 'x', name: 'alice', display: 'Anonymous' }).name).toBe('alice');
  });
});

describe('xAlias', () => {
  test('X handle → lower-case plain alias', () => {
    expect(xAlias({ provider: 'x', name: 'B0aseX' })).toBe('b0asex');
    expect(xAlias({ provider: 'x', name: 'old', suggested_handle: 'New_One' })).toBe('new_one');
  });
  test('never from Google (an email) or other providers', () => {
    expect(xAlias({ provider: 'google', name: 'me@gmail.com' })).toBe('');
    expect(xAlias({ provider: 'github', name: 'octo' })).toBe('');
    expect(xAlias(null)).toBe('');
  });
});

describe('paymail proposal', () => {
  test('available → offer to take it', () => {
    expect(xOffer('alice', true)).toEqual({ kind: 'take', alias: 'alice' });
  });
  test('unknown → propose nothing', () => {
    expect(xOffer('alice', null)).toEqual({ kind: 'none' });
  });
  test('taken → only the free alternatives', async () => {
    const free = new Set(['alicex', 'alice1']);
    const o = await checkXOffer('alice', async (a) => free.has(a));
    expect(o).toEqual({ kind: 'taken', alias: 'alice', alternatives: ['alicex', 'alice1'] });
  });
  test('available via the checker', async () => {
    expect(await checkXOffer('bob', async () => true)).toEqual({ kind: 'take', alias: 'bob' });
  });
  test('a failed check proposes nothing', async () => {
    expect(
      await checkXOffer('bob', async () => {
        throw new Error('offline');
      }),
    ).toEqual({ kind: 'none' });
  });
  test('alternatives are valid plain aliases, never .x', () => {
    for (const a of xAlternatives('alice')) expect(a).not.toContain('.');
  });
});

describe('X handle kept through the create flow', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  test('outlives the 10-minute sign-in ticket, up to 60 minutes', () => {
    const s = mem();
    rememberXHandle('alice', 0, s);
    expect(rememberedXHandle(30 * 60_000, s)).toBe('alice');
    expect(rememberedXHandle(X_HANDLE_TTL_MS + 1, s)).toBe('');
    expect(rememberedXHandle(0, s)).toBe(''); // expired entry was removed
  });
  test('cleared after use', () => {
    const s = mem();
    rememberXHandle('alice', 0, s);
    forgetXHandle(s);
    expect(rememberedXHandle(1, s)).toBe('');
  });
});
