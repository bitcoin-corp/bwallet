import { describe, expect, test } from 'bun:test';
import {
  AUTO_RESYNC_KEY,
  autoResyncCoins,
  readAutoResyncCoins,
  runAutoResyncIfDue,
  type AutoResyncDeps,
  type AutoResyncReader,
} from './autoCoinResync';
import { withCoinResyncLock } from './coinResyncLock';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const S = 'd'.repeat(64);
const OWN = 'e'.repeat(64);

const deps = (over: Partial<AutoResyncDeps> = {}) => {
  const spent: Record<string, string> = {};
  const unspent: string[] = [];
  const d: AutoResyncDeps = {
    coins: [],
    cleared: {},
    ownPendingTxids: new Set(),
    ownPendingInputs: new Set(),
    getSpends: async (b) => b.map(() => null),
    markSpent: async (o, by) => ((spent[o] = by), 1),
    markUnspent: async (o) => (unspent.push(o), 1),
    ...over,
  };
  return { d, spent, unspent };
};

describe('autoResyncCoins', () => {
  test('1sat index spender clears the coin and is remembered', async () => {
    const { d, spent } = deps({
      coins: [`${A}_0`, `${B}_1`],
      getSpends: async (b) => b.map((o) => (o.startsWith(A) ? S : null)),
    });
    const r = await autoResyncCoins(d);
    expect(spent).toEqual({ [`${A}_0`]: S });
    expect(r.cleared).toEqual({ [`${A}_0`]: S });
    expect(r.released).toBe(1);
  });

  test('an index spend WhatsOnChain does not back never clears (b-Aware report, 24 Oct 2026)', async () => {
    const idx = { coins: [`${A}_0`], getSpends: async (b: string[]) => b.map(() => S) };
    const unspent = deps({ ...idx, woc: async () => null });
    expect((await autoResyncCoins(unspent.d)).released).toBe(0);
    const other = deps({ ...idx, woc: async () => ({ txid: C, confirmed: true }) });
    expect((await autoResyncCoins(other.d)).released).toBe(0);
    const agree = deps({ ...idx, woc: async () => ({ txid: S, confirmed: false }) });
    expect((await autoResyncCoins(agree.d)).released).toBe(1);
  });

  test('mempool-only WhatsOnChain spender never clears; confirmed does', async () => {
    const mem = deps({ coins: [`${A}_0`], woc: async () => ({ txid: S, confirmed: false }) });
    expect((await autoResyncCoins(mem.d)).released).toBe(0);
    const conf = deps({ coins: [`${A}_0`], woc: async () => ({ txid: S, confirmed: true }) });
    expect((await autoResyncCoins(conf.d)).released).toBe(1);
  });

  test('index failure leaves coins alone (fail closed), no WoC fallback asked', async () => {
    let asked = 0;
    const { d, spent } = deps({
      coins: [`${A}_0`],
      getSpends: async () => {
        throw new Error('boom');
      },
      woc: async () => (asked++, { txid: S, confirmed: true }),
    });
    await autoResyncCoins(d);
    expect(spent).toEqual({});
    expect(asked).toBe(0);
  });

  test("own unfinished actions: their txid is no spender, their inputs aren't checked", async () => {
    const { d, spent } = deps({
      coins: [`${A}_0`, `${B}_0`],
      ownPendingTxids: new Set([OWN]),
      ownPendingInputs: new Set([`${B}_0`]),
      getSpends: async (b) => b.map((o) => (o.startsWith(A) ? OWN : S)),
    });
    const r = await autoResyncCoins(d);
    expect(spent).toEqual({});
    expect(r.checked).toBe(1);
  });

  test('a cleared coin both lookups now call unspent is restored', async () => {
    const { d, unspent } = deps({ cleared: { [`${C}_2`]: S }, woc: async () => null });
    const r = await autoResyncCoins(d);
    expect(unspent).toEqual([`${C}_2`]);
    expect(r.restored).toBe(1);
    expect(r.cleared).toEqual({});
  });

  test('restore needs WoC to agree (fail closed)', async () => {
    const { d, unspent } = deps({ cleared: { [`${C}_2`]: S }, woc: async () => ({ txid: S, confirmed: false }) });
    await autoResyncCoins(d);
    expect(unspent).toEqual([]);
  });

  test('batches of 100 to the index', async () => {
    const sizes: number[] = [];
    const coins = Array.from({ length: 250 }, (_, i) => `${A}_${i}`);
    const { d } = deps({ coins, getSpends: async (b) => (sizes.push(b.length), b.map(() => null)) });
    await autoResyncCoins(d);
    expect(sizes.sort((x, y) => x - y)).toEqual([50, 100, 100]);
  });
});

describe('index replies: only an explicit null is unspent', () => {
  test('short reply: nothing restored, nothing cleared', async () => {
    const { d, unspent, spent } = deps({
      coins: [`${A}_0`],
      cleared: { [`${C}_2`]: S },
      getSpends: async () => [],
    });
    const r = await autoResyncCoins(d);
    expect(unspent).toEqual([]);
    expect(spent).toEqual({});
    expect(r.cleared).toEqual({ [`${C}_2`]: S });
  });
  test('undefined entry is unknown, not unspent', async () => {
    const { d, unspent } = deps({ cleared: { [`${C}_2`]: S }, getSpends: async (b) => b.map(() => undefined) });
    await autoResyncCoins(d);
    expect(unspent).toEqual([]);
  });
  test('explicit null (and WoC 404) restores', async () => {
    const { d, unspent } = deps({ cleared: { [`${C}_2`]: S }, woc: async () => null });
    await autoResyncCoins(d);
    expect(unspent).toEqual([`${C}_2`]);
  });
});

describe('runAutoResyncIfDue', () => {
  test('not ready (load null) does not start the wait', async () => {
    const m: Record<string, unknown> = {};
    const kv = {
      get: async (k: string) => ({ [k]: m[k] }),
      set: async (i: Record<string, unknown>) => void Object.assign(m, i),
    };
    expect(await runAutoResyncIfDue('k', kv, async () => null, 1)).toBeNull();
    expect(await runAutoResyncIfDue('k', kv, async () => deps().d, 2)).not.toBeNull();
  });

  const memKV = () => {
    const m: Record<string, unknown> = {};
    return {
      m,
      kv: {
        get: async (k: string) => ({ [k]: m[k] }),
        set: async (i: Record<string, unknown>) => void Object.assign(m, i),
      },
    };
  };

  test('throttle is persisted: a new worker (same storage) waits the gap', async () => {
    const { m, kv } = memKV();
    let runs = 0;
    const load = async () => (runs++, deps({ coins: [] }).d);
    expect(await runAutoResyncIfDue('k', kv, load, 1_000)).not.toBeNull();
    expect(await runAutoResyncIfDue('k', kv, load, 2_000)).toBeNull();
    expect(runs).toBe(1);
    expect((m[AUTO_RESYNC_KEY] as Record<string, { at: number }>).k.at).toBe(1_000);
    expect(await runAutoResyncIfDue('k', kv, load, 1_000 + 30 * 60 * 1000)).not.toBeNull();
    expect(await runAutoResyncIfDue('other', kv, load, 2_000)).not.toBeNull();
  });

  test('cleared list is persisted and fed to the next run', async () => {
    const { m, kv } = memKV();
    await runAutoResyncIfDue(
      'k',
      kv,
      async () => deps({ coins: [`${A}_0`], getSpends: async (b) => b.map(() => S) }).d,
      0,
    );
    expect((m[AUTO_RESYNC_KEY] as Record<string, { cleared: Record<string, string> }>).k.cleared).toEqual({
      [`${A}_0`]: S,
    });
    let seen: Record<string, string> = {};
    await runAutoResyncIfDue('k', kv, async (c) => ((seen = c), deps().d), 10 * 60 * 60 * 1000);
    expect(seen).toEqual({ [`${A}_0`]: S });
  });
});

describe('withCoinResyncLock', () => {
  test('runs one at a time, survives a throw', async () => {
    const order: string[] = [];
    const slow = withCoinResyncLock(async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a2');
      throw new Error('x');
    }).catch(() => undefined);
    const fast = withCoinResyncLock(async () => order.push('b'));
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a1', 'a2', 'b']);
  });
});

describe('readAutoResyncCoins (web/native storage, big wallets)', () => {
  const T = (c: string) => c.repeat(64);
  const rows = Array.from({ length: 1203 }, (_, i) => ({
    txid: T((i % 16).toString(16)),
    vout: i,
    spendable: i % 3 !== 0,
    spentBy: i === 3 ? 77 : i === 6 ? 5 : null,
  }));
  const fake = (opts: { activeLocal?: () => boolean } = {}) => {
    const calls = { reads: 0, pages: [] as number[], held: 0, maxHeld: 0 };
    const reader: AutoResyncReader = {
      findUsers: async () => [{ userId: 1 }],
      findOutputBaskets: async () => [{ basketId: 9 }],
      findTransactions: async () => [{ transactionId: 77, txid: T('e') }],
      findOutputs: async (a) => {
        calls.pages.push(a.paged.offset);
        expect(a.noScript).toBe(true);
        return rows.slice(a.paged.offset, a.paged.offset + a.paged.limit);
      },
    };
    const storage = {
      isActiveStorageProvider: opts.activeLocal ?? (() => true),
      runAsReader: async <X>(f: (r: AutoResyncReader) => Promise<X>) => {
        calls.reads++;
        calls.held++;
        calls.maxHeld = Math.max(calls.maxHeld, calls.held);
        try {
          return await f(reader);
        } finally {
          calls.held--;
        }
      },
    };
    return { storage, calls };
  };

  test('remote-active store (web before the switch): skipped, nothing read, no error', async () => {
    const { storage, calls } = fake({ activeLocal: () => false });
    expect(await readAutoResyncCoins(storage, 'idk', ['failed'])).toBeNull();
    expect(calls.reads).toBe(0);
  });

  test('reads the basket in pages, one lock hold per page, without scripts', async () => {
    const { storage, calls } = fake();
    const r = await readAutoResyncCoins(storage, 'idk', ['failed'], 500);
    expect(calls.pages).toEqual([0, 500, 1000]);
    expect(calls.reads).toBe(4); // head + 3 pages, each released before the next
    expect(calls.maxHeld).toBe(1);
    expect(r!.coins.length).toBe(rows.filter((o) => o.spendable).length);
    expect([...r!.ownPendingInputs]).toEqual([`${T('3')}_3`]);
    expect([...r!.ownPendingTxids]).toEqual([T('e')]);
  });

  test('store switched mid-read: stops, no verdicts from a half read', async () => {
    let n = 0;
    const { storage } = fake({ activeLocal: () => n++ < 2 });
    expect(await readAutoResyncCoins(storage, 'idk', ['failed'], 500)).toBeNull();
  });
});
