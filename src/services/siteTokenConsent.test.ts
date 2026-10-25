import { describe, expect, test } from 'bun:test';
import { chromeConsentStore, LIST_CONSENT_DAYS, LIST_CONSENT_KEY, memoryConsentStore } from './siteTokens';
import { keepGlobals } from '../testing/stubGlobals';

keepGlobals('chrome');
const DAY = 86_400_000;

describe('b-Aware 25 Oct: site token list consent expires and can be withdrawn', () => {
  test('memory store: expires after the limit, forget drops only that site', async () => {
    let t = Date.UTC(2026, 9, 25);
    const s = memoryConsentStore(() => t);
    await s.add('a.example', 'tok');
    await s.add('b.example', 'tok');
    expect(await s.has('a.example', 'tok')).toBe(true);
    await s.forget!('a.example');
    expect(await s.has('a.example', 'tok')).toBe(false);
    expect(await s.has('b.example', 'tok')).toBe(true);
    t += LIST_CONSENT_DAYS * DAY;
    expect(await s.has('b.example', 'tok')).toBe(false);
  });

  test('stored store: legacy entries with no time are expired; forget and expiry apply', async () => {
    const data: Record<string, unknown> = { [LIST_CONSENT_KEY]: ['old.example|tok'] };
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: { get: async (k: string) => ({ [k]: data[k] }), set: async (v: object) => void Object.assign(data, v) },
      },
    };
    let t = Date.UTC(2026, 9, 25);
    const s = chromeConsentStore(() => t);
    expect(await s.has('old.example', 'tok')).toBe(false);
    await s.add('a.example', 'tok');
    expect(await s.has('a.example', 'tok')).toBe(true);
    // A second instance (another part of the wallet) sees a Forget made through this one.
    await chromeConsentStore(() => t).forget!('a.example');
    expect(await s.has('a.example', 'tok')).toBe(false);
    await s.add('a.example', 'tok');
    t += LIST_CONSENT_DAYS * DAY + 1;
    expect(await s.has('a.example', 'tok')).toBe(false);
  });
});
