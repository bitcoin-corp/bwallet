import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import V from '../mobile/private/vectors.json';
import { attachMintPrivate } from '../mintPrivatePage';
import { MINT_PRIVATE_ACTION, MINT_PRIVATE_CAPS, MINT_PRIVATE_MAX_ITEMS } from './mintPrivateAction';
import { mintPrivateSheetText } from '../pages/requests/mintPrivateSheetText';

(globalThis as Record<string, unknown>).__MINT_FEE_ADDRESS__ = '';
const pm = await import('../mobile/private/privateMint');
const site = await import('./mintPrivateSite');

const base = JSON.parse(V.x1.json);
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ...base, x_id: String(1000 + i), text: `post ${i}` }));
const memKv = () => {
  const m = new Map<string, unknown>();
  return {
    m,
    kv: { get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)) },
  };
};
/** A wallet that counts createAction and otherwise is a real ProtoWallet (encrypt works). */
const countingCtx = () => {
  const w = new ProtoWallet(new PrivateKey(1));
  let n = 0;
  const wallet = new Proxy(w, {
    get(t, p) {
      if (p === 'createAction') return async () => ({ txid: String(++n).padStart(64, 'a') });
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { calls: () => n, ctx: { wallet } as never };
};

describe('provider', () => {
  test('exposes mintPrivate and mintPrivateCaps, sending the bwxMintPrivate action', async () => {
    const target: Record<string, unknown> = {};
    const sent: [string, unknown][] = [];
    attachMintPrivate(target, async (a, p) => (sent.push([a, p]), { ok: 1 }));
    expect(typeof target.mintPrivate).toBe('function');
    expect(target.mintPrivateCaps).toEqual({ sequence: true, maxItems: 25_000 });
    expect(await (target.mintPrivate as (a: unknown) => Promise<unknown>)({ source: 'x' })).toEqual({ ok: 1 });
    expect(sent).toEqual([[MINT_PRIVATE_ACTION, { source: 'x' }]]);
  });
  test('the caps match the core cap', () => {
    expect(MINT_PRIVATE_MAX_ITEMS).toBe(pm.MAX_REQUEST_ITEMS);
    expect(MINT_PRIVATE_CAPS.maxItems).toBe(pm.MAX_REQUEST_ITEMS);
  });
});

describe('runSiteMintPrivate', () => {
  test('the originator passes through to the sheet and the core; the result comes back', async () => {
    const { kv } = memKv();
    const c = countingCtx();
    const seen: string[] = [];
    const r = await site.runSiteMintPrivate({
      ctx: c.ctx,
      originator: 'bchatx.com',
      identityKey: '02abc',
      satsPerKb: 100,
      kv,
      params: { source: 'x', requestId: 'req-route-01', items: items(3) },
      ask: async (s) => (seen.push(s.originator), true),
    });
    expect(seen).toEqual(['bchatx.com']);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.complete).toBe(true);
    expect(c.calls()).toBe(1);
  });

  test('a decline gives USER_REFUSED as { code, message } and mints nothing', async () => {
    const { kv } = memKv();
    const c = countingCtx();
    const r = await site.runSiteMintPrivate({
      ctx: c.ctx,
      originator: 'bchatx.com',
      identityKey: '02abc',
      satsPerKb: 100,
      kv,
      params: { source: 'x', requestId: 'req-route-02', items: items(3) },
      ask: async () => false,
    });
    expect(r).toEqual({ success: false, code: 'USER_REFUSED', error: 'The user declined.' });
    expect(c.calls()).toBe(0);
  });

  test('a bad request is BAD_REQUEST, without a sheet', async () => {
    const { kv } = memKv();
    let asked = 0;
    const r = await site.runSiteMintPrivate({
      ctx: countingCtx().ctx,
      originator: 'bchatx.com',
      identityKey: '02abc',
      satsPerKb: 100,
      kv,
      params: { source: 'x', requestId: 'req-route-03', items: items(1), sequence: { id: 'short' } },
      ask: async () => (asked++, true),
    });
    expect(r).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(asked).toBe(0);
  });

  test('request records go to the async store, so a repeat does not mint again', async () => {
    const { kv, m } = memKv();
    const c = countingCtx();
    const args = {
      ctx: c.ctx,
      originator: 'bchatx.com',
      identityKey: '02abc',
      satsPerKb: 100,
      kv,
      params: { source: 'x', requestId: 'req-route-04', items: items(2) },
      ask: async () => true,
    };
    await site.runSiteMintPrivate(args);
    expect([...m.keys()].some((k) => k.startsWith(site.MINT_REQUESTS_PREFIX))).toBe(true);
    const r2 = await site.runSiteMintPrivate({ ...args, ask: async () => false });
    expect(r2.success).toBe(true);
    expect(c.calls()).toBe(1);
  });
});

describe('sequence approval', () => {
  const T0 = 1_000_000;
  /** Fake core: confirm is called with a fixed chunk cost, like handleMintPrivate does. */
  const fakeMint = (sats: number) =>
    (async (_ctx, _req, env) => {
      if (!(await env.confirm({ posts: 1000, sats, txs: 4, originator: env.originator })))
        throw new pm.MintPrivateError('USER_REFUSED', 'The user declined.');
      return { records: [], txids: [], complete: true };
    }) as typeof pm.handleMintPrivate;
  const seq = (index: number, extra: object = {}) => ({
    id: 'run-0000001',
    index,
    total: 3,
    totalSats: 3000,
    totalTxs: 12,
    ...extra,
  });
  const runner = (
    kv: ReturnType<typeof memKv>['kv'],
    opts: { sats?: number; now?: number; originator?: string; identityKey?: string } = {},
  ) => {
    const sheets: site.MintPrivateSheet[] = [];
    let answer = true;
    const call = (index: number, extra: object = {}) =>
      site.runSiteMintPrivate({
        ctx: {} as never,
        originator: opts.originator ?? 'bchatx.com',
        identityKey: opts.identityKey ?? '02abc',
        satsPerKb: 100,
        kv,
        params: { source: 'x', requestId: `req-seq-${index}`, items: [], sequence: seq(index, extra) },
        ask: async (s) => (sheets.push(s), answer),
        now: () => opts.now ?? T0,
        mint: fakeMint(opts.sats ?? 1000),
      });
    return { sheets, call, decline: () => (answer = false) };
  };

  test('one sheet for the whole run; later chunks within budget run without one', async () => {
    const { kv } = memKv();
    const r = runner(kv);
    expect((await r.call(0)).success).toBe(true);
    expect((await r.call(1)).success).toBe(true);
    expect((await r.call(2)).success).toBe(true);
    expect(r.sheets.length).toBe(1);
    expect(r.sheets[0].sequence).toEqual({ chunks: 3, index: 0, totalSats: 3000, totalTxs: 12 });
  });

  test('budget exhausted: the next chunk shows a fresh sheet', async () => {
    const { kv } = memKv();
    // Budget 3000 × 1.1 = 3300. Chunks of 1500: 1500 + 1500 = 3000 fit, the third (4500) does not.
    const r = runner(kv, { sats: 1500 });
    await r.call(0);
    await r.call(1);
    expect(r.sheets.length).toBe(1);
    await r.call(2);
    expect(r.sheets.length).toBe(2);
  });

  test('a reused index shows a fresh sheet', async () => {
    const { kv } = memKv();
    const r = runner(kv);
    await r.call(0);
    await r.call(0);
    expect(r.sheets.length).toBe(2);
  });

  test('expired after 2 hours: a fresh sheet', async () => {
    const { kv } = memKv();
    await runner(kv).call(0);
    const later = runner(kv, { now: T0 + site.SEQUENCE_TTL_MS + 1 });
    await later.call(1);
    expect(later.sheets.length).toBe(1);
  });

  test('survives a page reload / reconnect: only storage carries the approval', async () => {
    const { kv, m } = memKv();
    await runner(kv).call(0);
    // A reload: a new runner (no page or module memory of the first), same chrome.storage contents.
    const stored = structuredClone(m.get(site.MINT_SEQUENCES_KEY));
    const fresh = memKv();
    fresh.m.set(site.MINT_SEQUENCES_KEY, stored);
    const after = runner(fresh.kv, { now: T0 + 30 * 60_000 });
    expect((await after.call(1)).success).toBe(true);
    expect(after.sheets.length).toBe(0);
    expect(Object.keys(stored as object)).toEqual(['bchatx.com|02abc|run-0000001']);
  });

  test('just inside 2 hours: no sheet', async () => {
    const { kv } = memKv();
    await runner(kv).call(0);
    const inTime = runner(kv, { now: T0 + site.SEQUENCE_TTL_MS - 1 });
    await inTime.call(1);
    expect(inTime.sheets.length).toBe(0);
  });

  test('a different originator or identity key never rides the approval', async () => {
    const { kv } = memKv();
    await runner(kv).call(0);
    const other = runner(kv, { originator: 'evil.example' });
    await other.call(1);
    expect(other.sheets.length).toBe(1);
    const otherKey = runner(kv, { identityKey: '02def' });
    await otherKey.call(1);
    expect(otherKey.sheets.length).toBe(1);
  });

  test('decline: USER_REFUSED and the approval is cleared', async () => {
    const { kv, m } = memKv();
    const r = runner(kv);
    await r.call(0);
    r.decline();
    // A fresh sheet (reused index) declined clears the approval, so the next chunk asks again.
    expect(await r.call(0)).toMatchObject({ success: false, code: 'USER_REFUSED' });
    expect(Object.keys((m.get(site.MINT_SEQUENCES_KEY) as object) ?? {})).toEqual([]);
    const again = runner(kv);
    await again.call(1);
    expect(again.sheets.length).toBe(1);
  });

  test('a first-chunk decline gives USER_REFUSED and stores nothing', async () => {
    const { kv, m } = memKv();
    const r = runner(kv);
    r.decline();
    expect(await r.call(0)).toMatchObject({ success: false, code: 'USER_REFUSED' });
    expect(m.get(site.MINT_SEQUENCES_KEY)).toEqual({});
  });
});

describe('sheet text', () => {
  test('says the site, posts, sats, txs and that they are private', () => {
    const t = mintPrivateSheetText({
      requestID: 'x',
      originator: 'bchatx.com',
      posts: 1000,
      sats: 72000,
      txs: 4,
      sequence: { chunks: 20, index: 0, totalPosts: 19011, totalSats: 1370000, totalTxs: 77 },
    });
    expect(t.title).toBe('Lock 19,011 posts to you');
    expect(t.site).toBe('bchatx.com is asking');
    expect(t.cost).toBe('About 1,370,000 sats in 77 transactions');
    expect(t.privacy).toContain('only you can see them');
    expect(t.chunks).toContain('20 parts');
  });
});

describe('message size', () => {
  test('19,011 posts serialise to a message well under Chrome’s 64 MB limit', () => {
    const big = { source: 'x', requestId: 'req-big-0001', items: items(19_011) };
    const bytes = JSON.stringify({ action: MINT_PRIVATE_ACTION, params: big, originator: 'bchatx.com' }).length;
    expect(bytes).toBeLessThan(64 * 1024 * 1024);
  });
});
