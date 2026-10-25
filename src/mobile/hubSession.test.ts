import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// hub.ts imports Capacitor plugins; stub the bits it touches at import time.
const fakeStore = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

const { initialSession } = await import('./hub');

describe('hub storage.session (security audit 25 Oct 2026)', () => {
  test('web + Desktop: an unlock key left by an older build is removed at startup and nothing is restored', () => {
    const store = fakeStore();
    store.setItem('chrome.storage.session', JSON.stringify({ passKey: 'aa'.repeat(32), other: 1 }));
    const session = initialSession(false, store);
    expect(session.size).toBe(0);
    expect(store.getItem('chrome.storage.session')).toBeNull();
  });

  test('phones: the in-process mirror still survives a reload', () => {
    const store = fakeStore();
    store.setItem('chrome.storage.session', JSON.stringify({ passKey: 'k' }));
    expect(initialSession(true, store).get('passKey')).toBe('k');
  });

  test('a corrupt mirror never stops the app from starting', () => {
    const store = fakeStore();
    store.setItem('chrome.storage.session', '{nope');
    expect(initialSession(true, store).size).toBe(0);
  });

  test('main.ts keeps the session in memory everywhere except native phones', () => {
    const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(src).toContain('persistSession: Capacitor.isNativePlatform()');
    const hub = readFileSync(new URL('./hub.ts', import.meta.url), 'utf8');
    expect(hub).toContain('if (this.persistSession) sessionStorage.setItem(SESSION_KEY');
  });
});
