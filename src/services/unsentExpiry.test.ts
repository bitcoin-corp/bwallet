import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_TTL_S,
  WATCH_S,
  emptyState,
  expireOnce,
  isExpired,
  policyFromLabels,
  resetExpiryLimit,
  runUnsentExpiry,
  splitOutpoint,
  wocSpent,
  type ExpiryDeps,
  type ExpiryState,
  type NoSendAction,
  type SpendState,
} from './unsentExpiry';
import type { Sighting } from './unsentGuard';

const T = (c: string) => c.repeat(64);
const A = T('a');
const B = T('b');
const P = T('1'); // a mined parent
const Q = T('2'); // another mined parent
const X = T('9'); // someone else's tx

/** A fake world: which txids the chain has, and who spent which outpoint. */
function world() {
  const seen = new Set<string>([P, Q]);
  const spends = new Map<string, string>();
  const unclear = new Set<string>();
  const aborted: string[] = [];
  const sent: string[] = [];
  const recovered: string[] = [];
  const logs: string[] = [];
  let state: ExpiryState | null = null;
  let now = 1_800_000_000;
  let actions: NoSendAction[] = [];
  const look = async (txid: string): Promise<Sighting> =>
    unclear.has(txid) ? 'unclear' : seen.has(txid) ? 'seen' : 'missing';
  const deps: ExpiryDeps = {
    listNoSend: async () => actions,
    abort: async (t) => {
      aborted.push(t);
      actions = actions.filter((a) => a.txid !== t);
    },
    sendWith: async (t) => void sent.push(t),
    recoverLate: async (t) => void recovered.push(t),
    kv: { load: async () => (state ? structuredClone(state) : null), save: async (s) => void (state = s) },
    lookups: [look, look],
    spent: async (o): Promise<SpendState> => {
      if (unclear.has(o)) return { state: 'unclear' };
      const by = spends.get(o);
      return by ? { state: 'spent', by } : { state: 'unspent' };
    },
    nowS: () => now,
    delaysMs: [0, 1, 1],
    sleep: async () => undefined,
    log: (m) => logs.push(m),
  };
  return {
    deps,
    seen,
    spends,
    unclear,
    aborted,
    sent,
    recovered,
    logs,
    get state() {
      return state;
    },
    set actions(a: NoSendAction[]) {
      actions = a;
    },
    advance: (s: number) => (now += s),
  };
}

const act = (txid: string, ins: string[], labels?: string[]): NoSendAction => ({
  txid,
  labels,
  inputs: ins.map((sourceOutpoint) => ({ sourceOutpoint })),
});

beforeEach(() => resetExpiryLimit());

describe('BRC-177 labels', () => {
  test('exact forms parse; others fall back to the default deadline', () => {
    expect(policyFromLabels(undefined)).toEqual({ mode: 'default' });
    expect(policyFromLabels(['offer 42'])).toEqual({ mode: 'default' });
    expect(policyFromLabels(['p nosend expiry seconds 300'])).toEqual({ mode: 'seconds', value: 300 });
    expect(policyFromLabels(['p nosend expiry timestamp 1798761600'])).toEqual({
      mode: 'timestamp',
      value: 1798761600,
    });
    expect(policyFromLabels(['p nosend expiry blockheight 1000000'])).toEqual({ mode: 'blockheight', value: 1000000 });
    expect(policyFromLabels(['p nosend expiry never'])).toEqual({ mode: 'never' });
    for (const bad of [
      'p nosend expiry seconds 0',
      'p nosend expiry seconds 007',
      'p nosend expiry seconds -5',
      'p nosend expiry Seconds 5',
      'p nosend expiry  seconds 5',
      'p nosend expiry never 0',
      'p nosend expiry fortnight 1',
      'p nosend expiry seconds 99999999999999999999',
    ])
      expect(policyFromLabels([bad]).mode).toBe('default');
    expect(policyFromLabels(['p nosend expiry seconds 5', 'p nosend expiry seconds 6']).invalid).toMatch(/duplicate/);
  });

  test('deadlines: relative from first sight, absolute time, block height, never', () => {
    expect(isExpired({ mode: 'default' }, 100, 100 + DEFAULT_TTL_S - 1, undefined)).toBe(false);
    expect(isExpired({ mode: 'default' }, 100, 100 + DEFAULT_TTL_S, undefined)).toBe(true);
    expect(isExpired({ mode: 'seconds', value: 300 }, 100, 399, undefined)).toBe(false);
    expect(isExpired({ mode: 'seconds', value: 300 }, 100, 400, undefined)).toBe(true);
    expect(isExpired({ mode: 'timestamp', value: 500 }, 0, 499, undefined)).toBe(false);
    expect(isExpired({ mode: 'timestamp', value: 500 }, 0, 500, undefined)).toBe(true);
    expect(isExpired({ mode: 'blockheight', value: 10 }, 0, 9e9, undefined)).toBe(false); // no height: never early
    expect(isExpired({ mode: 'blockheight', value: 10 }, 0, 0, 9)).toBe(false);
    expect(isExpired({ mode: 'blockheight', value: 10 }, 0, 0, 10)).toBe(true);
    expect(isExpired({ mode: 'never' }, 0, 9e12, 9e9)).toBe(false);
  });

  test('outpoints', () => {
    expect(splitOutpoint(`${P}.3`)).toEqual([P, 3]);
    expect(splitOutpoint(`${P.toUpperCase()}_0`)).toEqual([P, 0]);
    expect(splitOutpoint('nope.1')).toBeUndefined();
  });
});

describe('expiry and release', () => {
  test('before the deadline nothing happens; the first-seen time is persisted and never restarts', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`])];
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
    const first = w.state!.first[A];
    w.advance(DEFAULT_TTL_S - 10);
    r = await expireOnce(w.deps);
    expect(w.state!.first[A]).toBe(first);
    expect(w.aborted).toEqual([]);
    w.advance(10);
    r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    expect(w.aborted).toEqual([A]);
    expect(w.state!.released[A]).toBeDefined();
  });

  test('released only when every input is unspent, its parent is on chain and the tx is missing everywhere', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`, `${Q}.1`], ['p nosend expiry seconds 60'])];
    await expireOnce(w.deps);
    w.advance(60);
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    expect(w.logs.some((l) => l.includes('released (aborted)'))).toBe(true);
  });

  test('CRITICAL: the original is on chain (seen) → never released, handed to sendWith', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    w.seen.add(A);
    const r = await expireOnce(w.deps);
    expect(w.aborted).toEqual([]);
    expect(r.settled).toEqual([A]);
    expect(w.sent).toEqual([A]);
  });

  test('CRITICAL: an input spent by the original (indexer lag on the tx itself) → settle, never release', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    w.spends.set(`${P}.0`, A);
    const r = await expireOnce(w.deps);
    expect(w.aborted).toEqual([]);
    expect(r.settled).toEqual([A]);
  });

  test('CRITICAL: an input spent by something else, or any unclear answer → kept, nothing aborted', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    w.spends.set(`${P}.0`, X);
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    w.spends.clear();
    w.unclear.add(`${P}.0`);
    r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-unclear' }]);
    w.unclear.clear();
    w.unclear.add(A); // a lookup that can't answer for the tx itself
    r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'chain-has-it-or-unclear' }]);
    expect(w.aborted).toEqual([]);
  });

  test('CRITICAL: a parent the chain has never heard of (404 spent lookup on a phantom outpoint) → kept', async () => {
    const w = world();
    const ghost = T('7');
    w.actions = [act(A, [`${ghost}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'parent-unknown' }]);
    expect(w.aborted).toEqual([]);
  });

  test('CRITICAL: the tx appears during the ~30 s retry window → kept', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    let calls = 0;
    w.deps.lookups = [
      async (t) => {
        if (t !== A) return w.seen.has(t) ? 'seen' : 'missing';
        return ++calls > 2 ? 'seen' : 'missing';
      },
    ];
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'chain-has-it-or-unclear' }]);
    expect(w.aborted).toEqual([]);
  });

  test('CRITICAL: an input gets spent between the check and the release → kept (re-check before abort)', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    let n = 0;
    const base = w.deps.spent!;
    w.deps.spent = async (o) => (++n > 1 ? { state: 'spent', by: X } : base(o));
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'changed-at-recheck' }]);
    expect(w.aborted).toEqual([]);
  });

  test('never: no deadline, no release', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry never'])];
    await expireOnce(w.deps);
    w.advance(10 * DEFAULT_TTL_S);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'never' }]);
    expect(w.aborted).toEqual([]);
  });

  test('no inputs listed → kept (nothing to check on chain)', async () => {
    const w = world();
    w.actions = [{ txid: A, labels: ['p nosend expiry seconds 1'] }];
    await expireOnce(w.deps);
    w.advance(5);
    expect((await expireOnce(w.deps)).kept).toEqual([{ txid: A, reason: 'no-inputs' }]);
  });

  test('a chain of our own nosend txs is released together, child first', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`]), act(B, [`${A}.1`])];
    await expireOnce(w.deps);
    w.advance(DEFAULT_TTL_S);
    const r = await expireOnce(w.deps);
    expect(r.released.sort()).toEqual([A, B].sort());
    expect(w.aborted).toEqual([B, A]);
  });

  test('a child whose own-parent is not due holds; the parent is not dragged along', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry never']), act(B, [`${A}.1`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    const r = await expireOnce(w.deps);
    expect(r.kept).toContainEqual({ txid: B, reason: 'parent-unknown' });
    expect(w.aborted).toEqual([]);
  });

  test('a child that cannot be released does not hold back a clean parent', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`]), act(B, [`${A}.1`, `${Q}.0`])];
    await expireOnce(w.deps);
    w.advance(DEFAULT_TTL_S);
    w.spends.set(`${Q}.0`, X); // the child's other input went elsewhere
    const r = await expireOnce(w.deps);
    expect(r.kept).toContainEqual({ txid: B, reason: 'input-spent-elsewhere' });
    // A (parent) has B depending on it, but B is out of the set; A alone is still releasable: B can never be valid
    // without A, and A's own inputs are clean.
    expect(w.aborted).toEqual([A]);
  });

  test('abort refused → kept, retried next run', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    w.deps.abort = async () => {
      throw new Error('busy');
    };
    await expireOnce(w.deps);
    w.advance(5);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'abort-failed' }]);
    expect(w.state!.released[A]).toBeUndefined();
  });
});

describe('after release (race at expiry)', () => {
  test('if the original shows up later, the wallet recovery runs; then it is no longer watched', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    await expireOnce(w.deps);
    expect(w.aborted).toEqual([A]);
    w.advance(3600);
    expect((await expireOnce(w.deps)).lateSeen).toEqual([]);
    w.seen.add(A);
    const r = await expireOnce(w.deps);
    expect(r.lateSeen).toEqual([A]);
    expect(w.recovered).toEqual([A]);
    expect(w.state!.released[A]).toBeUndefined();
  });

  test('a failed recovery is retried; a watch older than WATCH_S is dropped', async () => {
    const w = world();
    const s = emptyState();
    s.released[A] = 1_800_000_000;
    s.released[B] = 1_800_000_000 - WATCH_S - 1;
    await w.deps.kv.save(s);
    w.seen.add(A);
    w.seen.add(B);
    w.deps.recoverLate = async () => {
      throw new Error('offline');
    };
    const r = await expireOnce(w.deps);
    expect(r.lateSeen).toEqual([A]);
    expect(w.state!.released[A]).toBeDefined();
    expect(w.state!.released[B]).toBeUndefined();
  });

  test('a txid that left the nosend list is forgotten (sent or aborted elsewhere)', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`])];
    await expireOnce(w.deps);
    expect(w.state!.first[A]).toBeDefined();
    w.actions = [];
    await expireOnce(w.deps);
    expect(w.state!.first[A]).toBeUndefined();
  });
});

describe('runner', () => {
  test('rate-limited and single-flight', async () => {
    const w = world();
    w.actions = [];
    expect((await runUnsentExpiry(w.deps)).skipped).toBeUndefined();
    expect((await runUnsentExpiry(w.deps)).skipped).toBe('rate-limited');
    expect((await runUnsentExpiry(w.deps, { force: true })).skipped).toBeUndefined();
  });

  test('listing fails → nothing released, never throws', async () => {
    const w = world();
    w.deps.listNoSend = async () => {
      throw new Error('locked');
    };
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([]);
  });
});

describe('wocSpent', () => {
  const res = (status: number, body?: unknown) =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
  test('404 unspent, 200 spent by, else unclear', async () => {
    expect(await wocSpent(async () => res(404))(`${P}.0`)).toEqual({ state: 'unspent' });
    expect(await wocSpent(async () => res(200, { txid: A }))(`${P}.0`)).toEqual({ state: 'spent', by: A });
    expect(await wocSpent(async () => res(200, {}))(`${P}.0`)).toEqual({ state: 'unclear' });
    expect(await wocSpent(async () => res(429))(`${P}.0`)).toEqual({ state: 'unclear' });
    expect(
      await wocSpent(async () => {
        throw new Error('net');
      })(`${P}.0`),
    ).toEqual({ state: 'unclear' });
    expect(await wocSpent(async () => res(404))('bad')).toEqual({ state: 'unclear' });
  });
  test('asks the right URL', async () => {
    let url = '';
    await wocSpent(async (u) => {
      url = u;
      return res(404);
    })(`${P}.7`);
    expect(url).toBe(`https://api.whatsonchain.com/v1/bsv/main/tx/${P}/7/spent`);
  });
});
