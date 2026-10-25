import { beforeEach, describe, expect, test } from 'bun:test';
import { PrivateKey, Utils } from '@bsv/sdk';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

// localStorage stand-in for the store-backed tests (bun has no DOM).
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const {
  addSubscription,
  amountSats,
  defaultDailyCap,
  dueAt,
  dueItems,
  getSub,
  isLowFunds,
  makePot,
  nextDue,
  pauseSub,
  potCovers,
  resumeSub,
  cancelSub,
  subProblem,
  subscriptionsUnlocked,
} = await import('./pots');
const { payDue } = await import('./payDue');
const { getPending } = await import('./pots');
const { parseConfig, DEFAULT_CONFIG, getRemoteConfig, resetRemoteConfigFailure, CONFIG_FAIL_TTL } =
  await import('../config/remoteConfig');
const { plannedReminders, reminderId } = await import('./notifyPots');
const {
  getAgentAccount,
  getAgentLog,
  listAgentsOnly,
  markAgentAccount,
  setAgentDailyCap,
  setAgentStopped,
  setAllAgentsStopped,
  spendAllowed,
} = await import('../agents/agentAccounts');
type Subscription = import('./pots').Subscription;

const T = (iso: string) => Date.parse(iso);
type Outs = { address: string; sats: number }[];
/** sign + broadcast deps from a "pay" stub returning a txid (the raw tx is just 'raw:' + txid here). */
const P = (pay: (potId: string, outputs: Outs) => Promise<string>) => ({
  sign: async (potId: string, outputs: Outs) => {
    const txid = await pay(potId, outputs);
    return { rawTx: `raw:${txid}`, txid };
  },
  broadcast: async () => undefined,
  spendingPaused: async () => false,
});
const DAY = 86_400_000;
const sub = (p: Partial<Subscription> = {}): Subscription => ({
  id: 's1',
  potId: '1Pot',
  payee: { name: 'Alice', address: '1Alice' },
  amount: { value: 5, currency: 'USD' },
  period: 'month',
  start: T('2026-01-31T09:00:00Z'),
  maxCount: null,
  paidCount: 0,
  periodIndex: 0,
  nextDue: 0,
  status: 'active',
  mode: 'onOpen',
  ...p,
});

describe('period math', () => {
  test('month-end clamps to the last day, and goes back to the 31st', () => {
    const s = T('2026-01-31T09:00:00Z');
    expect(new Date(dueAt(s, 'month', 1)).toISOString()).toBe('2026-02-28T09:00:00.000Z');
    expect(new Date(dueAt(s, 'month', 2)).toISOString()).toBe('2026-03-31T09:00:00.000Z');
    expect(new Date(dueAt(s, 'month', 3)).toISOString()).toBe('2026-04-30T09:00:00.000Z');
    expect(new Date(dueAt(s, 'month', 11)).toISOString()).toBe('2026-12-31T09:00:00.000Z');
    expect(new Date(dueAt(s, 'month', 12)).toISOString()).toBe('2027-01-31T09:00:00.000Z');
  });
  test('leap years: Feb 29 in 2028, Feb 28 otherwise', () => {
    expect(new Date(dueAt(T('2027-01-31T00:00:00Z'), 'month', 13)).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    const leap = T('2028-02-29T12:00:00Z');
    expect(new Date(dueAt(leap, 'year', 1)).toISOString()).toBe('2029-02-28T12:00:00.000Z');
    expect(new Date(dueAt(leap, 'year', 4)).toISOString()).toBe('2032-02-29T12:00:00.000Z');
  });
  test('days and weeks are exact; DST never moves a payment (UTC)', () => {
    const s = T('2026-03-28T12:00:00Z'); // UK clocks change 29 Mar
    expect(dueAt(s, 'day', 2) - s).toBe(2 * DAY);
    expect(new Date(dueAt(s, 'day', 2)).getUTCHours()).toBe(12);
    expect(dueAt(s, 'week', 3) - s).toBe(21 * DAY);
    expect(dueAt(s, { seconds: 3600 }, 5) - s).toBe(5 * 3600_000);
  });
  test('nextDue follows periodIndex and stops at maxCount', () => {
    expect(nextDue(sub({ periodIndex: 1 }))).toBe(T('2026-02-28T09:00:00Z'));
    expect(nextDue(sub({ maxCount: 2, periodIndex: 2 }))).toBeNull();
  });
});

describe('dueItems catch-up', () => {
  test('nothing before start', () => {
    expect(dueItems(sub(), T('2026-01-30T00:00:00Z')).missed).toBe(0);
  });
  test('caps at 3 and asks for more', () => {
    const p = dueItems(sub({ period: 'day', start: T('2026-01-01T00:00:00Z') }), T('2026-01-05T01:00:00Z'));
    expect(p.missed).toBe(5);
    expect(p.due).toHaveLength(3);
    expect(p.needsConfirm).toBe(true);
    const q = dueItems(sub({ period: 'day', start: T('2026-01-01T00:00:00Z') }), T('2026-01-03T01:00:00Z'));
    expect([q.missed, q.needsConfirm]).toEqual([3, false]);
  });
  test('respects maxCount and status', () => {
    const s = sub({ period: 'day', start: T('2026-01-01T00:00:00Z'), maxCount: 2 });
    expect(dueItems(s, T('2026-02-01T00:00:00Z')).missed).toBe(2);
    expect(dueItems({ ...s, status: 'paused' }, T('2026-02-01T00:00:00Z')).missed).toBe(0);
  });
});

describe('funds', () => {
  test('USD and SAT amounts in sats', () => {
    expect(amountSats({ value: 5, currency: 'USD' }, 50)).toBe(10_000_000);
    expect(amountSats({ value: 5, currency: 'USD' }, 0)).toBeNull();
    expect(amountSats({ value: 1234, currency: 'SAT' }, 0)).toBe(1234);
    expect(amountSats({ value: 100, currency: 'PNEE' }, 50)).toBeNull();
  });
  test('potCovers pays in due order across orders; low funds below 2', () => {
    const a = sub({ id: 'a', amount: { value: 1000, currency: 'SAT' }, period: 'day', start: 0 });
    const b = sub({ id: 'b', amount: { value: 3000, currency: 'SAT' }, period: 'week', start: 0 });
    expect(potCovers([a, b], 4000, 0)).toBe(2); // a@0 + b@0 both due first
    expect(potCovers([a, b], 3999, 0)).toBe(1);
    expect(potCovers([a], 0, 0)).toBe(0);
    expect(potCovers([{ ...a, status: 'paused' }], 0, 0)).toBe(99);
    expect(isLowFunds(1)).toBe(true);
    expect(isLowFunds(2)).toBe(false);
  });
  test('default daily cap fits a catch-up, +10%', () => {
    expect(defaultDailyCap([sub({ amount: { value: 10, currency: 'USD' } })], 50)).toBe(33);
    expect(defaultDailyCap([], 50)).toBeNull();
  });
});

describe('spend gating for pots', () => {
  const pot = {
    identityAddress: '1Pot',
    labels: [],
    stopped: false,
    dailyCapUsd: 10,
    createdAt: 0,
    kind: 'pot' as const,
  };
  test('stopped, stop-all and the cap refuse', () => {
    expect(spendAllowed(pot, false, [], 5).ok).toBe(true);
    expect(spendAllowed({ ...pot, stopped: true }, false, [], 5).ok).toBe(false);
    expect(spendAllowed(pot, true, [], 5).ok).toBe(false);
    expect(spendAllowed(pot, false, [{ at: Date.now(), action: 'sub-pay', detail: '', usd: 8 }], 5).ok).toBe(false);
  });
});

describe('subscriptionsUnlocked', () => {
  const st = { hasActiveBillingSub: false, firstUseAt: null, walletCreatedAt: null };
  const on = { billing: { ...DEFAULT_CONFIG.billing, enabled: true, freeBefore: null } };
  const now = T('2027-06-01T00:00:00Z');
  test('always unlocked while billing is off', () => {
    expect(subscriptionsUnlocked(DEFAULT_CONFIG, st, now)).toBe(true);
  });
  test('billing on: sub, grace, free-before, grandfathered unlock; nothing else', () => {
    expect(subscriptionsUnlocked(on, st, now)).toBe(false);
    expect(subscriptionsUnlocked(on, { ...st, hasActiveBillingSub: true }, now)).toBe(true);
    expect(subscriptionsUnlocked(on, { ...st, firstUseAt: now - 10 * DAY }, now)).toBe(true);
    expect(subscriptionsUnlocked(on, { ...st, firstUseAt: now - 40 * DAY }, now)).toBe(false);
    expect(subscriptionsUnlocked({ billing: { ...on.billing, freeBefore: '2028-01-01' } }, st, now)).toBe(true);
    const g = { billing: { ...on.billing, grandfatherCreatedBefore: '2027-01-01' } };
    expect(subscriptionsUnlocked(g, { ...st, walletCreatedAt: T('2026-10-01T00:00:00Z') }, now)).toBe(true);
    expect(subscriptionsUnlocked(g, { ...st, walletCreatedAt: T('2027-03-01T00:00:00Z') }, now)).toBe(false);
  });
});

describe('remote config fails closed', () => {
  const key = PrivateKey.fromRandom();
  const pub = key.toPublicKey().toString();
  const body = JSON.stringify({ billing: { enabled: true, usdPerDay: 0.01 }, features: { presigned: true } });
  const sig = Utils.toHex(key.sign(Utils.toArray(body, 'utf8')).toDER() as number[]);
  test('garbage and missing → defaults, billing off', () => {
    expect(parseConfig(null, pub, true)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig({ body: 'not json' }, pub, true)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig({ billing: { enabled: true } }, pub, true).billing.enabled).toBe(false);
  });
  test('only a good signature in a billing build turns billing on', () => {
    expect(parseConfig({ body, sig }, pub, true).billing.enabled).toBe(true);
    expect(parseConfig({ body, sig }, pub, true).features.presigned).toBe(true);
    expect(parseConfig({ body }, pub, true).billing.enabled).toBe(false);
    expect(parseConfig({ body, sig: 'deadbeef' }, pub, true).billing.enabled).toBe(false);
    const other = PrivateKey.fromRandom().toPublicKey().toString();
    expect(parseConfig({ body, sig }, other, true).billing.enabled).toBe(false);
    expect(parseConfig({ body, sig }, pub, false).billing.enabled).toBe(false); // store build
    expect(parseConfig({ body, sig }, '', true).billing.enabled).toBe(false); // no key configured (today)
  });
  test('network failure → billing off; default key keeps billing off', async () => {
    mem.clear();
    const down = await getRemoteConfig(() => Promise.reject(new Error('offline')), 1);
    expect(down.billing.enabled).toBe(false);
    const signed = await getRemoteConfig(() => Promise.resolve(new Response(JSON.stringify({ body, sig }))), 2);
    expect(signed.billing.enabled).toBe(false);
  });
  test('a failed config fetch is not retried for an hour (no reconnect-loop spam)', async () => {
    mem.clear();
    resetRemoteConfigFailure();
    let calls = 0;
    const f = () => {
      calls++;
      return Promise.resolve(new Response('', { status: 404 }));
    };
    await getRemoteConfig(f, 1000);
    await getRemoteConfig(f, 2000);
    await getRemoteConfig(f, 1000 + CONFIG_FAIL_TTL - 1);
    expect(calls).toBe(1);
    await getRemoteConfig(f, 1000 + CONFIG_FAIL_TTL + 1);
    expect(calls).toBe(2);
    resetRemoteConfigFailure();
  });
});

describe('store: pots, orders, pause/resume, pay-on-open', () => {
  const NOW = T('2026-03-10T12:00:00Z');
  beforeEach(() => mem.clear());

  const setup = (p: Partial<Parameters<typeof addSubscription>[0]> = {}) => {
    makePot('1Pot', 'Rent', undefined, NOW);
    return addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Landlord', address: '1Landlord' },
        amount: { value: 10, currency: 'USD' },
        period: 'day',
        start: NOW - 2 * DAY - 1000,
        maxCount: null,
        ...p,
      },
      50,
      NOW,
    );
  };

  test('a pot is an agent account kind pot, hidden from the agents list', () => {
    makePot('1Pot', 'Rent', undefined, NOW);
    markAgentAccount('1Agent', [], NOW);
    expect(getAgentAccount('1Pot')?.kind).toBe('pot');
    expect(listAgentsOnly().map((a) => a.identityAddress)).toEqual(['1Agent']);
  });

  test('new orders set a default daily cap on the pot', () => {
    setup();
    expect(getAgentAccount('1Pot')?.dailyCapUsd).toBe(33);
  });

  test('validation', () => {
    makePot('1Pot', 'Rent', undefined, NOW);
    const base = {
      potId: '1Pot',
      payee: { name: 'x', address: '1x' },
      amount: { value: 1, currency: 'USD' as const },
      period: 'month' as const,
      start: NOW,
      maxCount: null,
    };
    expect(subProblem(base)).toBeNull();
    expect(subProblem({ ...base, payee: { name: 'x' } })).toBe('Enter who to pay');
    expect(subProblem({ ...base, amount: { value: 0, currency: 'USD' } })).toBe('Enter an amount');
    expect(subProblem({ ...base, maxCount: 0 })).toContain('1–1000');
    expect(subProblem({ ...base, payee: { name: 'bChat', service: 'bchat' } }, false)).toBe(
      'That service isn’t available',
    );
  });

  test('pays everything due in one tx, logs, advances', async () => {
    const s = setup();
    const paid: { potId: string; outputs: { address: string; sats: number }[] }[] = [];
    const r = await payDue(
      {
        bsvUsd: 50,
        resolve: async (p) => p.address!,
        ...P(async (potId, outputs) => (paid.push({ potId, outputs }), 'tx1')),
      },
      NOW,
    );
    expect(r).toEqual([{ id: s.id, ok: true, count: 3, txid: 'tx1' }]);
    expect(paid[0].outputs).toEqual(Array(3).fill({ address: '1Landlord', sats: 20_000_000 }));
    expect(getSub(s.id)?.periodIndex).toBe(3);
    expect(getSub(s.id)?.paidCount).toBe(3);
    expect(getAgentLog('1Pot')[0]).toMatchObject({ action: 'sub-pay', usd: 30, txid: 'tx1' });
    // Nothing more due until tomorrow.
    expect(await payDue({ bsvUsd: 50, resolve: async () => '1x', ...P(async () => 'tx2') }, NOW)).toEqual([]);
  });

  test('more than 3 missed: confirm pays all, decline skips the older ones', async () => {
    const s = setup({ start: NOW - 5 * DAY - 1000 }); // 6 due
    setAllAgentsStopped(false);
    const counts: number[] = [];
    await payDue(
      {
        bsvUsd: 50,
        resolve: async () => '1L',
        ...P(async (_p, o) => (counts.push(o.length), 't')),
        confirm: async () => false,
      },
      NOW,
    );
    expect(counts).toEqual([3]);
    expect(getSub(s.id)?.periodIndex).toBe(6);
    expect(getSub(s.id)?.paidCount).toBe(3);

    mem.clear();
    const s2 = setup({ start: NOW - 5 * DAY - 1000, amount: { value: 1, currency: 'USD' } });
    const c2: number[] = [];
    const all = {
      bsvUsd: 50,
      resolve: async () => '1L',
      ...P(async (_p: string, o: unknown[]) => (c2.push(o.length), 't')),
      confirm: async () => true,
    };
    // A confirmed catch-up is still held to the pot's daily cap ($3.30 here)…
    expect((await payDue(all, NOW))[0].ok).toBe(false);
    expect(c2).toEqual([]);
    // …and goes through once the cap allows it.
    setAgentDailyCap('1Pot', null);
    await payDue(all, NOW);
    expect(c2).toEqual([6]);
    expect(getSub(s2.id)?.paidCount).toBe(6);
  });

  test('an agent spend during a slow payment waits for it, so the two cannot both pass the cap', async () => {
    // b-Aware report, 24 Oct 2026: the pot payer and the agent path checked the same cap side by side.
    setup(); // $30 due today, pot cap $33
    const { serialSpend } = await import('../agents/spendQueue');
    const { checkAgentSpend } = await import('../agents/agentAccounts');
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const resolving = new Promise<void>((r) => (entered = r));
    const paying = payDue(
      { bsvUsd: 50, resolve: async (p) => (entered(), await slow, p.address!), ...P(async () => 'tx1') },
      NOW,
    );
    // An agent spend of $6 arrives while the pot is still resolving its payee (inside the queued step).
    await resolving;
    const agent = serialSpend(async () => checkAgentSpend('1Pot', 6, NOW));
    await Promise.resolve();
    release();
    expect((await paying)[0].ok).toBe(true);
    // It is checked after the $30 is logged: only $3 left, so it is refused.
    expect((await agent).ok).toBe(false);
  });

  test('stopped pot and the daily cap refuse; nothing is signed', async () => {
    const s = setup();
    setAgentStopped('1Pot', true, NOW);
    let signed = 0;
    const deps = { bsvUsd: 50, resolve: async () => '1L', ...P(async () => (signed++, 't')) };
    const r = await payDue(deps, NOW);
    expect(r[0].ok).toBe(false);
    expect(signed).toBe(0);
    expect(getSub(s.id)?.lastError).toContain('stopped');

    setAgentStopped('1Pot', false, NOW);
    setAllAgentsStopped(true);
    expect((await payDue(deps, NOW))[0].ok).toBe(false);
    setAllAgentsStopped(false);
    expect(signed).toBe(0);
  });

  test('the spending pause stops pot payments: nothing signed or broadcast, paid once lifted', async () => {
    const s = setup();
    let signed = 0;
    let sent = 0;
    let paused = true;
    const deps = {
      bsvUsd: 50,
      resolve: async () => '1L',
      ...P(async () => (signed++, 't')),
      broadcast: async () => void sent++,
      spendingPaused: async () => paused,
    };
    expect(await payDue(deps, NOW)).toEqual([]);
    expect(signed).toBe(0);
    expect(sent).toBe(0);
    paused = false;
    await payDue(deps, NOW);
    expect(signed).toBe(1);
    expect(getSub(s.id)?.paidCount).toBeGreaterThan(0);
  });

  test('not enough in the pot → lowFunds, retried next open', async () => {
    const s = setup();
    const r = await payDue(
      { bsvUsd: 50, resolve: async () => '1L', ...P(async () => Promise.reject(new Error('Not enough in the pot'))) },
      NOW,
    );
    expect(r[0].ok).toBe(false);
    expect(getSub(s.id)?.status).toBe('lowFunds');
    const ok = await payDue({ bsvUsd: 50, resolve: async () => '1L', ...P(async () => 'tx') }, NOW);
    expect(ok[0].ok).toBe(true);
    expect(getSub(s.id)?.status).toBe('active');
  });

  test('pause skips the paused periods; cancel stops it', async () => {
    const s = setup();
    pauseSub(s.id, NOW);
    expect(await payDue({ bsvUsd: 50, resolve: async () => '1L', ...P(async () => 't') }, NOW)).toEqual([]);
    resumeSub(s.id, NOW);
    const r = getSub(s.id)!;
    expect(r.status).toBe('active');
    expect(nextDue(r)!).toBeGreaterThan(NOW);
    expect(r.paidCount).toBe(0);
    cancelSub(s.id, NOW);
    expect(getSub(s.id)?.status).toBe('cancelled');
    expect(
      getAgentLog('1Pot')
        .map((e) => e.action)
        .slice(0, 3),
    ).toEqual(['sub-cancel', 'sub-resume', 'sub-pause']);
  });

  test('ends after maxCount', async () => {
    const s = setup({ maxCount: 2 });
    await payDue({ bsvUsd: 50, resolve: async () => '1L', ...P(async () => 't') }, NOW);
    expect(getSub(s.id)?.status).toBe('ended');
    expect(getSub(s.id)?.paidCount).toBe(2);
  });

  test('no price → USD orders wait without failing', async () => {
    const s = setup();
    const r = await payDue({ bsvUsd: 0, resolve: async () => '1L', ...P(async () => 't') }, NOW);
    expect(r[0].ok).toBe(false);
    expect(getSub(s.id)?.status).toBe('active');
  });

  test('service orders refused where subscriptions are off (store build)', async () => {
    makePot('1Pot', 'bChat', undefined, NOW);
    const svc = sub({ id: 'svc', payee: { name: 'bChat', service: 'bchat' }, start: NOW - DAY });
    mem.set('bwallet.subs', JSON.stringify({ svc }));
    let signed = 0;
    const r = await payDue(
      { bsvUsd: 50, resolve: async () => '1L', ...P(async () => (signed++, 't')), subsOn: false },
      NOW,
    );
    expect(r[0].ok).toBe(false);
    expect(signed).toBe(0);
  });
});

describe('crash safety: a payment is recorded before it is broadcast', () => {
  const NOW = T('2026-03-10T12:00:00Z');
  beforeEach(() => mem.clear());
  const setup = () => {
    makePot('1Pot', 'Rent', undefined, NOW);
    return addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Landlord', address: '1Landlord' },
        amount: { value: 10, currency: 'USD' },
        period: 'day',
        start: NOW - 2 * DAY - 1000,
        maxCount: null,
      },
      50,
      NOW,
    );
  };

  test('crash after broadcast, before save: next run pays nothing new', async () => {
    const s = setup();
    let signs = 0;
    const network: string[] = [];
    // Run 1: signs, records pending, broadcasts, then "crashes" before the sub is saved.
    const crashing = {
      bsvUsd: 50,
      resolve: async () => '1L',
      sign: async () => (signs++, { rawTx: 'RAW1', txid: 'TX1' }),
      broadcast: async (raw: string) => {
        network.push(raw);
        throw new Error('app killed');
      },
    };
    expect((await payDue(crashing, NOW))[0].ok).toBe(false);
    expect(getPending(s.id)).toMatchObject({ subId: s.id, periodIndex: 0, count: 3, rawTx: 'RAW1', txid: 'TX1' });
    expect(getPending(s.id)?.dueTimes).toHaveLength(3);
    expect(getSub(s.id)?.periodIndex).toBe(0);

    // Run 2: the network already has TX1 ("already known"). No new tx is signed; the periods are marked paid.
    const next = {
      bsvUsd: 50,
      resolve: async () => '1L',
      sign: async () => (signs++, { rawTx: 'RAW2', txid: 'TX2' }),
      broadcast: async (raw: string) => {
        network.push(raw);
        throw new Error('txn-already-known');
      },
    };
    expect(await payDue(next, NOW)).toEqual([{ id: s.id, ok: true, count: 3, txid: 'TX1' }]);
    expect(signs).toBe(1);
    expect(network).toEqual(['RAW1', 'RAW1']);
    expect(getSub(s.id)?.periodIndex).toBe(3);
    expect(getSub(s.id)?.paidCount).toBe(3);
    expect(getPending(s.id)).toBeNull();
    expect(getAgentLog('1Pot').filter((l) => l.action === 'sub-pay')).toHaveLength(1);
    // And nothing further is due.
    expect(await payDue(next, NOW)).toEqual([]);
    expect(signs).toBe(1);
  });

  test('crash before broadcast: the same tx is rebroadcast, never a fresh one', async () => {
    const s = setup();
    let signs = 0;
    // Run 1: signed and recorded, then killed before broadcast got anywhere.
    await payDue(
      {
        bsvUsd: 50,
        resolve: async () => '1L',
        sign: async () => (signs++, { rawTx: 'RAW1', txid: 'TX1' }),
        broadcast: async () => Promise.reject(new Error('Network request failed')),
      },
      NOW,
    );
    expect(getPending(s.id)?.rawTx).toBe('RAW1');
    // Run 2 (later): rebroadcasts RAW1, succeeds.
    const sent: string[] = [];
    const r = await payDue(
      {
        bsvUsd: 50,
        resolve: async () => '1L',
        sign: async () => (signs++, { rawTx: 'RAW2', txid: 'TX2' }),
        broadcast: async (raw: string) => void sent.push(raw),
      },
      NOW + 60_000,
    );
    expect(r).toEqual([{ id: s.id, ok: true, count: 3, txid: 'TX1' }]);
    expect(sent).toEqual(['RAW1']);
    expect(signs).toBe(1);
    expect(getSub(s.id)?.periodIndex).toBe(3);
    expect(getPending(s.id)).toBeNull();
  });

  test('crash after save, before the record is cleared: no double count', async () => {
    const s = setup();
    // Simulate: sub already advanced to 3 but the pending record for periods 0..2 is still there.
    mem.set(
      'bwallet.pots.pending',
      JSON.stringify({
        [s.id]: {
          subId: s.id,
          potId: '1Pot',
          periodIndex: 0,
          count: 3,
          dueTimes: [],
          rawTx: 'RAW1',
          txid: 'TX1',
          usd: 30,
          at: NOW,
        },
      }),
    );
    const cur = getSub(s.id)!;
    mem.set('bwallet.subs', JSON.stringify({ [s.id]: { ...cur, periodIndex: 3, paidCount: 3 } }));
    let signs = 0;
    const r = await payDue({ bsvUsd: 50, resolve: async () => '1L', ...P(async () => (signs++, 'TX2')) }, NOW);
    expect(r).toEqual([{ id: s.id, ok: true, count: 3, txid: 'TX1' }]);
    expect(signs).toBe(0);
    expect(getSub(s.id)?.periodIndex).toBe(3);
    expect(getSub(s.id)?.paidCount).toBe(3);
    expect(getPending(s.id)).toBeNull();
  });
});

describe('notifications', () => {
  test('reminder 24h before the next payment, only while still ahead', () => {
    const now = T('2026-03-01T00:00:00Z');
    const s = sub({ start: T('2026-03-05T09:00:00Z') });
    const r = plannedReminders(
      [s, sub({ id: 'p', status: 'paused', start: T('2026-03-05T09:00:00Z') })],
      () => 'Rent',
      now,
    );
    expect(r).toHaveLength(1);
    expect(r[0].at).toBe(T('2026-03-04T09:00:00Z'));
    expect(r[0].id).toBe(reminderId('s1'));
    expect(plannedReminders([s], () => 'Rent', T('2026-03-04T10:00:00Z'))).toHaveLength(0);
  });
});

describe('payDue respects a Pause or Cancel tapped mid-run (b-Aware, 23 Oct 2026)', () => {
  const NOW = T('2026-03-10T12:00:00Z');
  beforeEach(() => mem.clear());
  const setup = (name = 'Landlord') => {
    makePot('1Pot', 'Rent', undefined, NOW);
    setAgentDailyCap('1Pot', null);
    return addSubscription(
      {
        potId: '1Pot',
        payee: { name, address: `1${name}` },
        amount: { value: 10, currency: 'USD' },
        period: 'day',
        start: NOW - 2 * DAY - 1000,
        maxCount: null,
      },
      50,
      NOW,
    );
  };

  test('cancel during resolve, then resolve fails: stays cancelled', async () => {
    const s = setup();
    const r = await payDue(
      {
        bsvUsd: 50,
        resolve: async () => {
          cancelSub(s.id, NOW);
          throw new Error('paymail down');
        },
        ...P(async () => 'tx'),
      },
      NOW,
    );
    expect(r[0].ok).toBe(false);
    expect(getSub(s.id)?.status).toBe('cancelled');
    expect(getSub(s.id)?.cancelledAt).toBe(NOW);
    expect(await payDue({ bsvUsd: 50, resolve: async () => '1L', ...P(async () => 'tx2') }, NOW + DAY)).toEqual([]);
  });

  test('pause during sign, sign fails for low funds: stays paused', async () => {
    const s = setup();
    await payDue(
      {
        bsvUsd: 50,
        resolve: async () => '1L',
        ...P(async () => {
          pauseSub(s.id, NOW);
          throw new Error('Not enough in this pot');
        }),
      },
      NOW,
    );
    expect(getSub(s.id)?.status).toBe('paused');
    expect(getSub(s.id)?.lastError).toBe('Not enough in this pot');
  });

  test('cancel during sign, payment goes through: stays cancelled', async () => {
    const s = setup();
    const r = await payDue(
      { bsvUsd: 50, resolve: async () => '1L', ...P(async () => (cancelSub(s.id, NOW), 'tx1')) },
      NOW,
    );
    expect(r[0]).toMatchObject({ ok: true, txid: 'tx1' });
    expect(getSub(s.id)?.status).toBe('cancelled');
    expect(getSub(s.id)?.periodIndex).toBe(3);
  });

  test('a normal failure leaves the order active (or lowFunds)', async () => {
    const s = setup();
    await payDue(
      {
        bsvUsd: 50,
        resolve: async () => {
          throw new Error('paymail down');
        },
        ...P(async () => 'tx'),
      },
      NOW,
    );
    expect(getSub(s.id)?.status).toBe('active');
    expect(getSub(s.id)?.lastError).toBe('paymail down');
    await payDue(
      {
        bsvUsd: 50,
        resolve: async () => '1L',
        ...P(async () => {
          throw new Error('insufficient funds');
        }),
      },
      NOW,
    );
    expect(getSub(s.id)?.status).toBe('lowFunds');
  });

  test('two due orders: cancelling the second while the first pays means the second is never signed', async () => {
    const a = setup('A');
    const b = setup('B');
    const signedFor: string[] = [];
    const r = await payDue(
      {
        bsvUsd: 50,
        resolve: async (p) => p.address!,
        ...P(async (_pot, outs) => {
          signedFor.push(outs[0].address);
          if (outs[0].address === '1A') cancelSub(b.id, NOW);
          if (outs[0].address === '1B') cancelSub(a.id, NOW);
          return `tx${signedFor.length}`;
        }),
      },
      NOW,
    );
    expect(signedFor.length).toBe(1);
    const first = signedFor[0] === '1A' ? a : b;
    const second = first === a ? b : a;
    expect(r.map((x) => x.id)).toEqual([first.id]);
    expect(getSub(second.id)?.status).toBe('cancelled');
    expect(getSub(second.id)?.periodIndex).toBe(0);
  });

  test('a stale write cannot resurrect a cancelled order; only resume un-pauses', async () => {
    const s = setup();
    const { saveSub } = await import('./pots');
    const stale = getSub(s.id)!;
    cancelSub(s.id, NOW);
    saveSub({ ...stale, status: 'active' });
    expect(getSub(s.id)?.status).toBe('cancelled');

    const t = setup('T');
    const staleT = getSub(t.id)!;
    pauseSub(t.id, NOW);
    saveSub({ ...staleT, status: 'active' });
    expect(getSub(t.id)?.status).toBe('paused');
    resumeSub(t.id, NOW);
    expect(getSub(t.id)?.status).toBe('active');
  });
});
