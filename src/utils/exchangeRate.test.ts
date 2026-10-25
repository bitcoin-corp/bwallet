import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetExchangeRateForTests,
  BACKOFF_MAX_MS,
  cachedExchangeRate,
  fetchExchangeRate,
  isExchangeRateStale,
  RATE_TTL_MS,
  STORAGE_KEY,
} from './exchangeRate';

let now = 1_000_000;
let calls = 0;
let next: () => Response;
const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
const ok = (rate: number) => () => new Response(JSON.stringify({ rate }), { status: 200 });
const tooMany = () => new Response('', { status: 429 });

// bun runs every test file in one process and this module keeps the price in memory: don't hand the next file a
// cached $ rate (it turned "1.5 BSV" into "$105.00" in notify.test.ts), a fake fetch or a frozen clock.
afterAll(() => __resetExchangeRateForTests({ fetch: (...a) => fetch(...a), now: () => Date.now(), storage: null }));

beforeEach(() => {
  now = 1_000_000;
  calls = 0;
  mem.clear();
  next = ok(50);
  __resetExchangeRateForTests({
    now: () => now,
    storage,
    fetch: (async () => {
      calls++;
      return next();
    }) as unknown as typeof fetch,
  });
});

describe('exchange rate', () => {
  test('dedupes concurrent callers into one request', async () => {
    const rs = await Promise.all([fetchExchangeRate('main'), fetchExchangeRate('main'), fetchExchangeRate('main')]);
    expect(rs).toEqual([50, 50, 50]);
    expect(calls).toBe(1);
  });

  test('reuses the price within the TTL and refetches after', async () => {
    await fetchExchangeRate('main');
    now += RATE_TTL_MS - 1;
    expect(await fetchExchangeRate('main')).toBe(50);
    expect(calls).toBe(1);
    expect(isExchangeRateStale()).toBe(false);
    now += 1;
    expect(isExchangeRateStale()).toBe(true);
    next = ok(60);
    expect(await fetchExchangeRate('main')).toBe(60);
    expect(calls).toBe(2);
  });

  test('persists last known price and serves it after restart', async () => {
    await fetchExchangeRate('main');
    expect(JSON.parse(mem.get(STORAGE_KEY)!)).toEqual({ rate: 50, timestamp: 1_000_000 });
    __resetExchangeRateForTests();
    expect(cachedExchangeRate()).toBe(50);
  });

  test('backs off 2 → 4 → 8 min on 429, capped, and keeps the stale price', async () => {
    await fetchExchangeRate('main');
    next = tooMany;
    now += RATE_TTL_MS;
    expect(await fetchExchangeRate('main')).toBe(50); // fails, stale price
    expect(calls).toBe(2);
    const step = async (wait: number) => {
      now += wait - 1;
      expect(await fetchExchangeRate('main')).toBe(50);
      const before = calls;
      now += 1;
      await fetchExchangeRate('main');
      expect(calls).toBe(before + 1);
      expect(calls - before).toBe(1);
    };
    const before = calls;
    now += 2 * 60_000 - 1;
    await fetchExchangeRate('main');
    expect(calls).toBe(before); // still waiting
    now += 1;
    await fetchExchangeRate('main');
    expect(calls).toBe(before + 1);
    await step(4 * 60_000);
    await step(8 * 60_000);
    await step(BACKOFF_MAX_MS); // 16 min capped to 15
    expect(isExchangeRateStale()).toBe(true);
    next = ok(70);
    now += BACKOFF_MAX_MS;
    expect(await fetchExchangeRate('main')).toBe(70);
  });

  test('network failure with no price returns 0 without throwing', async () => {
    next = () => {
      throw new Error('offline');
    };
    expect(await fetchExchangeRate('main')).toBe(0);
  });
});
