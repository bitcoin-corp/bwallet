/**
 * Envelopes (owner, 24 Oct 2026): a site spends only from its own envelope, only up to the balance, atomically, and
 * Coin return releases what is left at once. Old stored allowances grant nothing.
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import {
  EnvelopeStore,
  closeEnvelopeInAccounts,
  fillEnvelope,
  guardEnvelopes,
  isMicropaymentSite,
  markMicropayments,
  MAX_ENVELOPE_SATS,
  parseEnvelopeState,
  returnCoins,
  spendFromEnvelope,
  emptyEnvelopeState,
  type EnvelopeBackend,
  type EnvelopeState,
} from './envelopes';

/** A backend with an await on every read and write, so interleavings are real. */
const memBackend = (): EnvelopeBackend & { raw: () => unknown } => {
  let data: unknown;
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 2));
  return {
    load: async () => {
      await tick();
      return data === undefined ? undefined : JSON.parse(JSON.stringify(data));
    },
    save: async (s: EnvelopeState) => {
      await tick();
      data = JSON.parse(JSON.stringify(s));
    },
    raw: () => data,
  };
};

const A = 'arcade.example';
const B = 'other.example';

describe('envelope model', () => {
  test('fill, spend all-or-nothing, never negative', () => {
    let s = fillEnvelope(emptyEnvelopeState(), A, 1000, 1).state;
    expect(s.envelopes[A].balanceSats).toBe(1000);
    const over = spendFromEnvelope(s, A, 1001, 2);
    expect(over.ok).toBe(false);
    expect(over.state).toBe(s);
    const ok = spendFromEnvelope(s, A, 1000, 3);
    expect(ok.ok).toBe(true);
    s = ok.state;
    expect(s.envelopes[A].balanceSats).toBe(0);
    expect(spendFromEnvelope(s, A, 1, 4).ok).toBe(false);
    expect(s.envelopes[A].history.map((h) => h.kind)).toEqual(['fill', 'spend']);
  });

  test('zero, negative, NaN and fractional spends', () => {
    const s = fillEnvelope(emptyEnvelopeState(), A, 10, 1).state;
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(spendFromEnvelope(s, A, bad, 2).ok).toBe(false);
    // A fraction is rounded up, so 9.5 takes 10 and 10.5 does not fit.
    expect(spendFromEnvelope(s, A, 9.5, 2).balanceSats).toBe(0);
    expect(spendFromEnvelope(s, A, 10.5, 2).ok).toBe(false);
  });

  test('a fill is capped and junk fills add nothing', () => {
    const s = fillEnvelope(emptyEnvelopeState(), A, MAX_ENVELOPE_SATS * 3, 1).state;
    expect(s.envelopes[A].balanceSats).toBe(MAX_ENVELOPE_SATS);
    expect(fillEnvelope(s, A, 5, 2).added).toBe(0);
    expect(fillEnvelope(emptyEnvelopeState(), A, -5, 1).added).toBe(0);
    expect(fillEnvelope(emptyEnvelopeState(), '', 5, 1).added).toBe(0);
  });

  test('coin return releases the whole balance and removes the envelope', () => {
    const s = fillEnvelope(emptyEnvelopeState(), A, 700, 1).state;
    const r = returnCoins(s, A);
    expect(r.returned).toBe(700);
    expect(r.state.envelopes[A]).toBeUndefined();
    expect(spendFromEnvelope(r.state, A, 1, 2).ok).toBe(false);
    expect(returnCoins(r.state, A).returned).toBe(0);
  });

  test('stored junk grants nothing', () => {
    const s = parseEnvelopeState({
      envelopes: {
        [A]: { originator: A, balanceSats: -100 },
        [B]: { originator: 'evil.example', balanceSats: 100 },
        'c.example': { originator: 'c.example', balanceSats: '100' },
        'd.example': { originator: 'd.example', balanceSats: 50 },
      },
    });
    expect(Object.keys(s.envelopes)).toEqual(['d.example']);
    expect(parseEnvelopeState(null).envelopes).toEqual({});
    expect(parseEnvelopeState('x').envelopes).toEqual({});
  });
});

describe('envelope store', () => {
  test('concurrent spends never take more than the balance (no double spend)', async () => {
    const store = new EnvelopeStore(memBackend());
    await store.fill(A, 255);
    const results = await Promise.all(Array.from({ length: 100 }, () => store.trySpend(A, 10)));
    expect(results.filter(Boolean).length).toBe(25);
    expect((await store.get(A))?.balanceSats).toBe(5);
    expect((await store.get(A))?.spentSats).toBe(250);
  });

  test('two payments racing for the last balance: exactly one wins', async () => {
    for (let i = 0; i < 20; i++) {
      const store = new EnvelopeStore(memBackend());
      await store.fill(A, 100);
      const [x, y] = await Promise.all([store.trySpend(A, 100), store.trySpend(A, 100)]);
      expect(Number(x) + Number(y)).toBe(1);
      expect((await store.get(A))?.balanceSats).toBe(0);
    }
  });

  test('coin return racing payments: nothing is spent after the return, balance never negative', async () => {
    const store = new EnvelopeStore(memBackend());
    await store.fill(A, 1000);
    const ops = [
      ...Array.from({ length: 5 }, () => store.trySpend(A, 100)),
      store.close(A),
      ...Array.from({ length: 5 }, () => store.trySpend(A, 100)),
    ];
    const out = await Promise.all(ops);
    const spent = (out.slice(0, 5) as boolean[]).filter(Boolean).length;
    expect(spent).toBe(5);
    expect(out[5]).toBe(500);
    expect((out.slice(6) as boolean[]).some(Boolean)).toBe(false);
    expect(await store.get(A)).toBeUndefined();
  });

  test('another site cannot spend, see or close the envelope', async () => {
    const store = new EnvelopeStore(memBackend());
    await store.fill(A, 500);
    expect(await store.trySpend(B, 1)).toBe(false);
    expect(await store.get(B)).toBeUndefined();
    expect(await store.close(B)).toBe(0);
    expect((await store.get(A))?.balanceSats).toBe(500);
  });

  test('a failed save changes nothing and the queue keeps working', async () => {
    const be = memBackend();
    const store = new EnvelopeStore(be);
    await store.fill(A, 100);
    const save = be.save;
    be.save = async () => {
      throw new Error('disk full');
    };
    await expect(store.trySpend(A, 50)).rejects.toThrow('disk full');
    be.save = save;
    expect((await store.get(A))?.balanceSats).toBe(100);
    expect(await store.trySpend(A, 50)).toBe(true);
  });
});

/** A permissions manager stand-in: `ensureSpendingAuthorization` approves as an old stored allowance would. */
const fakeManager = () => {
  const flowCalls: { originator: string; spending: { satoshis: number } }[] = [];
  const originalCalls: unknown[] = [];
  const m = {
    ensureSpendingAuthorization: async (a: unknown) => {
      originalCalls.push(a);
      return true;
    },
    requestPermissionFlow: async (r: { originator: string; spending: { satoshis: number } }) => {
      flowCalls.push(r);
      return false;
    },
  };
  return { m, flowCalls, originalCalls };
};

describe('guardEnvelopes', () => {
  const setup = async (balance = 500) => {
    const store = new EnvelopeStore(memBackend());
    if (balance) await store.fill(normalizeOriginator(A), balance);
    const f = fakeManager();
    const g = guardEnvelopes(f.m, { envelopes: store, adminOriginator: 'admin', normalize: normalizeOriginator });
    const pay = (originator: string, satoshis: number, seekPermission?: boolean) =>
      g.ensureSpendingAuthorization({ originator, satoshis, seekPermission } as never);
    return { store, pay, ...f };
  };

  test('a payment under the balance goes through without a sheet and ticks the balance down', async () => {
    const { pay, flowCalls, store } = await setup(500);
    expect(await pay(A, 400)).toBe(true);
    expect(flowCalls.length).toBe(0);
    expect((await store.get(normalizeOriginator(A)))?.balanceSats).toBe(100);
  });

  test('a payment over the balance shows the pay sheet and leaves the envelope alone', async () => {
    const { pay, flowCalls, originalCalls, store } = await setup(500);
    expect(await pay(A, 600)).toBe(false);
    expect(flowCalls).toHaveLength(1);
    expect(flowCalls[0].spending.satoshis).toBe(600);
    // The original method (which honours stored allowances) is never asked.
    expect(originalCalls).toHaveLength(0);
    expect((await store.get(normalizeOriginator(A)))?.balanceSats).toBe(500);
  });

  test('no silent spend beyond the balance, however it is split', async () => {
    const { pay, flowCalls, store } = await setup(1000);
    const silent = (await Promise.all(Array.from({ length: 30 }, () => pay(A, 70)))).filter(Boolean).length;
    expect(silent).toBe(14); // 14 × 70 = 980; the rest asked
    expect(flowCalls).toHaveLength(16);
    expect((await store.get(normalizeOriginator(A)))?.balanceSats).toBe(20);
  });

  test("another site's payment never uses this envelope", async () => {
    const { pay, flowCalls, store } = await setup(500);
    expect(await pay(B, 1)).toBe(false);
    expect(flowCalls[0].originator).toBe(normalizeOriginator(B));
    expect((await store.get(normalizeOriginator(A)))?.balanceSats).toBe(500);
  });

  test('after Coin return the site asks again', async () => {
    const { pay, flowCalls, store } = await setup(500);
    expect(await store.close(normalizeOriginator(A))).toBe(500);
    expect(await pay(A, 1)).toBe(false);
    expect(flowCalls).toHaveLength(1);
  });

  test('seekPermission=false over the balance is refused, not approved', async () => {
    const { pay } = await setup(10);
    await expect(pay(A, 11, false)).rejects.toThrow('needs your approval');
  });

  test('the wallet itself and zero spends use the original path', async () => {
    const { pay, originalCalls, flowCalls } = await setup(0);
    expect(await pay('admin', 999)).toBe(true);
    expect(await pay(A, 0)).toBe(true);
    expect(originalCalls).toHaveLength(2);
    expect(flowCalls).toHaveLength(0);
  });
});

describe('no spending caps (owner, 25 Oct 2026)', () => {
  // TokenBlaster credit: ONE createAction for the exact total. 1 USD ≈ 2,000,000 sats at a $50 BSV price.
  for (const [label, satoshis] of [
    ['100 × $1 load', 100 * 2_000_000],
    ['$500 load', 500 * 2_000_000],
  ] as const) {
    test(`${label}: one sheet for the full amount, Approve pays, no stored allowance consulted`, async () => {
      const store = new EnvelopeStore(memBackend());
      const sheets: { originator: string; spending: { satoshis: number } }[] = [];
      const originalCalls: unknown[] = [];
      const m = {
        ensureSpendingAuthorization: async (a: unknown) => {
          originalCalls.push(a);
          return false; // an old allowance that would refuse: must never be asked
        },
        requestPermissionFlow: async (r: { originator: string; spending: { satoshis: number } }) => {
          sheets.push(r);
          return true; // the user taps Approve
        },
      };
      const g = guardEnvelopes(m, { envelopes: store, adminOriginator: 'admin', normalize: normalizeOriginator });
      const ok = await g.ensureSpendingAuthorization({ originator: 'https://www.tokenblaster.lol', satoshis } as never);
      expect(ok).toBe(true);
      expect(sheets).toHaveLength(1);
      expect(sheets[0].spending.satoshis).toBe(satoshis);
      expect(originalCalls).toHaveLength(0);
    });
  }

  test('the approval sheet never says a payment is over an allowance or a site limit', async () => {
    const { readFileSync } = await import('node:fs');
    const sheet = readFileSync(new URL('../pages/requests/BundleSheet.tsx', import.meta.url), 'utf8');
    expect(sheet).not.toMatch(/over your allowance/i);
    expect(sheet).not.toMatch(/may spend/i);
    expect(sheet).not.toMatch(/Your allowance here/i);
  });
});

describe('migration: old monthly allowances grant nothing', () => {
  test('a stored $5/month allowance on the real manager no longer approves silently', async () => {
    const store = new InMemoryPermissionStore();
    await store.putGrant({
      key: { type: 'spending', originator: normalizeOriginator(A) },
      expiry: 0,
      grantedAt: Date.now(),
      authorizedAmount: 5_000_000,
    } as never);
    const w = {
      listActions: async () => ({ actions: [], totalActions: 0 }),
      listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
    };
    const envelopes = new EnvelopeStore(memBackend());
    const mgr = guardEnvelopes(new LocalWalletPermissionsManager(w as never, 'admin', {}, { store } as never), {
      envelopes,
      adminOriginator: 'admin',
      normalize: normalizeOriginator,
    });
    const pay = (satoshis: number) =>
      mgr.ensureSpendingAuthorization({ originator: A, satoshis, reason: 'pay', seekPermission: false } as never).then(
        () => 'auto',
        () => 'asks',
      );
    // Without the guard this would be 'auto' (spendLedger.test.ts shows the allowance path).
    expect(await pay(1_000)).toBe('asks');
    await envelopes.fill(normalizeOriginator(A), 2_000);
    expect(await pay(1_000)).toBe('auto');
    expect(await pay(1_500)).toBe('asks');
  });
});

describe('micropayment sites', () => {
  test('a site is flagged while its call names a streaming protocol, then not', () => {
    expect(isMicropaymentSite('tokenblaster.lol')).toBe(true);
    expect(isMicropaymentSite('stream.example')).toBe(false);
    const done = markMicropayments('stream.example');
    expect(isMicropaymentSite('stream.example')).toBe(true);
    done();
    done();
    expect(isMicropaymentSite('stream.example')).toBe(false);
  });
});

describe('b-Aware 24 Oct 2026: envelope keys, accounts and Revoke all', () => {
  test('an envelope for https://shop.com is never spent by https://shop.com:8443 (ports are separate sites)', async () => {
    const store = new EnvelopeStore(memBackend());
    await store.fill(normalizeOriginator('https://shop.com'), 500);
    const f = fakeManager();
    const g = guardEnvelopes(f.m, { envelopes: store, adminOriginator: 'admin', normalize: normalizeOriginator });
    expect(await g.ensureSpendingAuthorization({ originator: 'https://shop.com:8443', satoshis: 100 } as never)).toBe(
      false,
    );
    expect(f.flowCalls).toHaveLength(1);
    expect(f.flowCalls[0].originator).toBe(normalizeOriginator('https://shop.com:8443'));
    expect(normalizeOriginator('http://localhost:3001')).not.toBe(normalizeOriginator('http://localhost:3002'));
    expect((await store.get(normalizeOriginator('https://shop.com')))?.balanceSats).toBe(500);
  });

  test('one account never sees or spends another account’s envelope', async () => {
    const backends = new Map<string, ReturnType<typeof memBackend>>();
    const be = (id: string) => backends.get(id) ?? (backends.set(id, memBackend()), backends.get(id)!);
    const a = new EnvelopeStore(be('acctA'));
    const b = new EnvelopeStore(be('acctB'));
    await a.fill(A, 500);
    expect(await b.get(A)).toBeUndefined();
    expect(await b.trySpend(A, 1)).toBe(false);
    expect((await a.get(A))?.balanceSats).toBe(500);
  });

  test('Revoke all across accounts closes the site’s envelope in each, and only that site’s', async () => {
    const backends = new Map<string, ReturnType<typeof memBackend>>();
    const be = (id: string) => backends.get(id) ?? (backends.set(id, memBackend()), backends.get(id)!);
    await new EnvelopeStore(be('x')).fill(A, 300);
    await new EnvelopeStore(be('y')).fill(A, 200);
    await new EnvelopeStore(be('y')).fill(B, 50);
    expect(await closeEnvelopeInAccounts(['x', 'y', 'y', ''], A, be)).toBe(500);
    expect(await new EnvelopeStore(be('x')).get(A)).toBeUndefined();
    expect(await new EnvelopeStore(be('y')).get(A)).toBeUndefined();
    expect((await new EnvelopeStore(be('y')).get(B))?.balanceSats).toBe(50);
  });
});
