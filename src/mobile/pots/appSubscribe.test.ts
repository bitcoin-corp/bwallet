import { beforeEach, describe, expect, test } from 'bun:test';
import { BSM, PrivateKey, Utils } from '@bsv/sdk';

const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { amountSats, dueAt, getSub, makePot, saveSub } = await import('./pots');
const { canonicalSubscribe, MAX_LIFETIME_MS, MAX_NONCES_PER_ORIGIN, signSubscribeRequest } =
  await import('./merchantSig');
const { payDue } = await import('./payDue');
const { getAgentLog, setAgentDailyCap } = await import('../agents/agentAccounts');
const {
  answerSubscribe,
  createAppSub,
  handleSubscribeCall,
  MAX_ASKS_PER_MINUTE,
  parseSubscribeArgs,
  parseSubscribeMessage,
  resetSubscribeLimits,
} = await import('./appSubscribe');

const T = (iso: string) => Date.parse(iso);
const ORIGIN = 'https://app.example.com';
const ADDR = PrivateKey.fromRandom().toAddress();
const MERCHANT = PrivateKey.fromRandom();
const MKEY = MERCHANT.toPublicKey().toString();
let nonceSeq = 0;
/**
 * A request signed by MERCHANT for `signFor` (the origin the merchant meant), valid from `at`. Fields in `p` are
 * signed too unless `tamper` changes them after signing.
 */
const req = (
  p: Record<string, unknown> = {},
  o: {
    at?: number;
    signFor?: string;
    ttl?: number;
    nonce?: string;
    tamper?: Record<string, unknown>;
    key?: PrivateKey;
  } = {},
) => {
  const signer = o.key ?? MERCHANT;
  const base = {
    merchantName: 'Example Pro',
    payTo: 'pay@example.com',
    usdPerMonth: 5,
    description: 'Pro plan',
    appOrigin: ORIGIN,
    ...p,
  };
  const nonce = o.nonce ?? `nonce-${String(++nonceSeq).padStart(12, '0')}`;
  const expiresAt = (o.at ?? Date.now()) + (o.ttl ?? 5 * 60_000);
  const msg = canonicalSubscribe({
    origin: o.signFor ?? ORIGIN,
    payTo: base.payTo as string,
    usdPerMonth: Math.round((base.usdPerMonth as number) * 100) / 100,
    merchantName: base.merchantName as string,
    description: base.description as string,
    nonce,
    expiresAt,
  });
  const signature = BSM.sign(Utils.toArray(msg, 'utf8'), signer, 'base64') as string;
  return { ...base, merchantKey: signer.toPublicKey().toString(), nonce, expiresAt, signature, ...o.tamper };
};
type Outs = { address: string; sats: number }[];
const deps = (paid: Outs[], bsvUsd = 50) => ({
  bsvUsd,
  resolve: async () => ADDR,
  sign: async (_pot: string, outputs: Outs) => {
    paid.push(outputs);
    return { rawTx: `raw${paid.length}`, txid: `tx${paid.length}` };
  },
  broadcast: async () => undefined,
});

beforeEach(() => {
  mem.clear();
  resetSubscribeLimits();
});

describe('request parsing', () => {
  test('a valid request', () => {
    expect(parseSubscribeArgs(req(), ORIGIN)).toEqual({
      merchantName: 'Example Pro',
      payTo: 'pay@example.com',
      usdPerMonth: 5,
      description: 'Pro plan',
      appOrigin: ORIGIN,
      merchantKey: MKEY,
      keyTrust: 'new',
    });
    expect(parseSubscribeArgs(req({ payTo: ADDR }), ORIGIN).payTo).toBe(ADDR);
  });
  test('appOrigin must be the real sender', () => {
    expect(() => parseSubscribeArgs(req(), 'https://evil.example')).toThrow('appOrigin');
  });
  test('rejects bad payees and amounts', () => {
    expect(() => parseSubscribeArgs(req({ payTo: 'not a payee' }), ORIGIN)).toThrow('payTo');
    expect(() => parseSubscribeArgs(req({ usdPerMonth: 0 }), ORIGIN)).toThrow('usdPerMonth');
    expect(() => parseSubscribeArgs(req({ usdPerMonth: 1000 }), ORIGIN)).toThrow('usdPerMonth');
    expect(() => parseSubscribeArgs(req({ usdPerMonth: '5' }), ORIGIN)).toThrow('usdPerMonth');
    expect(() => parseSubscribeArgs(req({ merchantName: '' }), ORIGIN)).toThrow('merchantName');
  });
  test('rounds to cents', () => {
    expect(parseSubscribeArgs(req({ usdPerMonth: 4.999 }), ORIGIN).usdPerMonth).toBe(5);
  });
  test('message envelope', () => {
    expect(parseSubscribeMessage({ type: 'BWX_SUBSCRIBE', isInvocation: true, id: 1, call: 'subscribe' })).toEqual({
      id: 1,
      call: 'subscribe',
      args: {},
    });
    expect(parseSubscribeMessage({ type: 'BWX_SUBSCRIBE', isInvocation: true, id: 1, call: 'pay' })).toBeNull();
    expect(parseSubscribeMessage({ type: 'CWI', isInvocation: true, id: 1, call: 'subscribe' })).toBeNull();
  });
});

describe('merchant signatures', () => {
  const NOW = T('2026-10-18T12:00:00Z');
  test('good: a signed request verifies and names the merchant key', () => {
    expect(parseSubscribeArgs(req({}, { at: NOW }), ORIGIN, NOW).merchantKey).toBe(MKEY);
  });
  test('good: the merchant helper signs what the wallet checks', () => {
    const f = { merchantName: 'Example Pro', payTo: 'pay@example.com', usdPerMonth: 5, description: 'Pro plan' };
    const proof = signSubscribeRequest({ ...f, origin: ORIGIN }, MERCHANT.toWif(), NOW);
    expect(parseSubscribeArgs({ ...f, appOrigin: ORIGIN, ...proof }, ORIGIN, NOW).merchantKey).toBe(MKEY);
  });
  test('unsigned requests are refused', () => {
    const bare: Record<string, unknown> = req({}, { at: NOW });
    for (const k of ['merchantKey', 'signature', 'nonce', 'expiresAt']) delete bare[k];
    expect(() => parseSubscribeArgs(bare, ORIGIN, NOW)).toThrow('Unsigned');
  });
  test('bad: any field changed after signing, another key, or garbage fails', () => {
    expect(() => parseSubscribeArgs(req({}, { at: NOW, tamper: { usdPerMonth: 50 } }), ORIGIN, NOW)).toThrow(
      'signature',
    );
    expect(() => parseSubscribeArgs(req({}, { at: NOW, tamper: { payTo: 'thief@example.com' } }), ORIGIN, NOW)).toThrow(
      'signature',
    );
    expect(() =>
      parseSubscribeArgs(req({}, { at: NOW, tamper: { merchantName: 'Someone Else' } }), ORIGIN, NOW),
    ).toThrow('signature');
    const other = PrivateKey.fromRandom().toPublicKey().toString();
    expect(() => parseSubscribeArgs(req({}, { at: NOW, tamper: { merchantKey: other } }), ORIGIN, NOW)).toThrow(
      'signature',
    );
    expect(() => parseSubscribeArgs(req({}, { at: NOW, tamper: { signature: 'A'.repeat(88) } }), ORIGIN, NOW)).toThrow(
      'signature',
    );
  });
  test('expired, or valid for too long, is refused', () => {
    expect(() => parseSubscribeArgs(req({}, { at: NOW - 10 * 60_000 }), ORIGIN, NOW)).toThrow('expired');
    expect(() => parseSubscribeArgs(req({}, { at: NOW, ttl: MAX_LIFETIME_MS + 5 * 60_000 }), ORIGIN, NOW)).toThrow(
      'too far ahead',
    );
  });
  test('replayed: the same signed request is approved once', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    const r = req({}, { at: NOW });
    const d = { approve: async () => '1Pot', bsvUsd: () => 50, now: () => NOW };
    await handleSubscribeCall('subscribe', r, ORIGIN, d);
    expect(() => parseSubscribeArgs(r, ORIGIN, NOW + 1000)).toThrow('already used');
    await expect(handleSubscribeCall('subscribe', r, ORIGIN, { ...d, now: () => NOW + 1000 })).rejects.toThrow(
      'already used',
    );
  });
  test('wrong origin: a request signed for one site fails from another, even if appOrigin is set to match', () => {
    const evil = 'https://evil.example';
    expect(() => parseSubscribeArgs(req({ appOrigin: evil }, { at: NOW }), evil, NOW)).toThrow('signature');
    expect(() => parseSubscribeArgs(req({}, { at: NOW }), evil, NOW)).toThrow('appOrigin');
  });
});

describe('due dates and rate maths', () => {
  test('monthly from the 31st clamps to short months and goes back', () => {
    const start = T('2026-01-31T10:00:00Z');
    expect(new Date(dueAt(start, 'month', 1)).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(new Date(dueAt(start, 'month', 2)).toISOString()).toBe('2026-03-31T10:00:00.000Z');
  });
  test('dollars become sats at the day’s rate', () => {
    expect(amountSats({ value: 5, currency: 'USD' }, 50)).toBe(10_000_000);
    expect(amountSats({ value: 5, currency: 'USD' }, 25)).toBe(20_000_000);
    expect(amountSats({ value: 5, currency: 'USD' }, 0)).toBeNull(); // no price: wait, never guess
  });
});

describe('subscribe, status, cancel', () => {
  const NOW = T('2026-10-16T12:00:00Z');
  test('approve stores it; decline stores nothing', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    let kicked = 0;
    const d = { approve: async () => '1Pot', bsvUsd: () => 50, chargeSoon: () => void kicked++, now: () => NOW };
    const st = (await handleSubscribeCall('subscribe', req({}, { at: NOW }), ORIGIN, d)) as {
      id: string;
      status: string;
    };
    expect(st.status).toBe('active');
    expect(kicked).toBe(1);
    expect(getSub(st.id)).toMatchObject({ catchUp: 'latest', period: 'month', amount: { value: 5, currency: 'USD' } });
    const no = await answerSubscribe({ id: 2, call: 'subscribe', args: req({}, { at: NOW }) }, ORIGIN, {
      ...d,
      approve: async () => null,
    });
    expect(no).toMatchObject({ status: 'error', description: 'Declined' });
  });
  test('an app only sees and cancels its own', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    const s = createAppSub(parseSubscribeArgs(req({}, { at: NOW }), ORIGIN, NOW), '1Pot', 50, NOW);
    const d = { approve: async () => null, bsvUsd: () => 50 };
    await expect(handleSubscribeCall('status', { id: s.id }, 'https://other.example', d)).rejects.toThrow('Unknown');
    await expect(handleSubscribeCall('cancel', { id: s.id }, 'https://other.example', d)).rejects.toThrow('Unknown');
    expect(await handleSubscribeCall('list', {}, 'https://other.example', d)).toEqual([]);
    const c = (await handleSubscribeCall('cancel', { id: s.id }, ORIGIN, d)) as { status: string; nextCharge: null };
    expect(c.status).toBe('cancelled');
    expect(c.nextCharge).toBeNull();
  });
});

describe('charger', () => {
  const START = T('2026-06-16T12:00:00Z');
  const setup = () => {
    makePot('1Pot', 'Apps', undefined, START);
    return createAppSub(parseSubscribeArgs(req({ payTo: ADDR }, { at: START }), ORIGIN, START), '1Pot', 50, START);
  };

  test('first month pays at once, with a receipt; a second run pays nothing', async () => {
    const s = setup();
    const paid: Outs[] = [];
    const r = await payDue(deps(paid), START + 1000);
    expect(r).toEqual([{ id: s.id, ok: true, count: 1, txid: 'tx1' }]);
    expect(paid).toEqual([[{ address: ADDR, sats: 10_000_000 }]]);
    expect(getSub(s.id)?.lastReceipt).toMatchObject({ txid: 'tx1', usd: 5, sats: 10_000_000 });
    expect(await payDue(deps(paid), START + 2000)).toEqual([]);
    expect(paid.length).toBe(1);
  });

  test('concurrent runs share one payment (no double charge)', async () => {
    setup();
    const paid: Outs[] = [];
    await Promise.all([payDue(deps(paid), START + 1000), payDue(deps(paid), START + 1000)]);
    expect(paid.length).toBe(1);
  });

  test('missed months never stack: pays one month on next open, at that day’s rate', async () => {
    const s = setup();
    const paid: Outs[] = [];
    await payDue(deps(paid), START + 1000); // June
    const later = T('2026-10-20T09:00:00Z'); // July, Aug, Sep, Oct all missed
    const r = await payDue(deps(paid, 100), later);
    expect(r).toEqual([{ id: s.id, ok: true, count: 1, txid: 'tx2' }]);
    expect(paid[1]).toEqual([{ address: ADDR, sats: 5_000_000 }]); // $5 at $100/BSV
    expect(getAgentLog('1Pot').some((l) => l.action === 'sub-skip' && /3 missed/.test(l.detail))).toBe(true);
    const next = dueAt(s.start, 'month', getSub(s.id)!.periodIndex);
    expect(new Date(next).toISOString()).toBe('2026-11-16T12:00:00.000Z');
    expect(await payDue(deps(paid, 100), later + 1000)).toEqual([]);
  });

  test('respects the pot’s daily cap', async () => {
    const s = setup();
    setAgentDailyCap('1Pot', 1);
    const paid: Outs[] = [];
    const r = await payDue(deps(paid), START + 1000);
    expect(r[0]).toMatchObject({ id: s.id, ok: false });
    expect(paid.length).toBe(0);
  });
});

describe('pot only, never the main balance', () => {
  const NOW = T('2026-10-18T12:00:00Z');
  test('approving with an id that is not a pot (e.g. the main account) stores nothing', async () => {
    const d = { approve: async () => '1MainAccount', bsvUsd: () => 50, now: () => NOW };
    await expect(handleSubscribeCall('subscribe', req({}, { at: NOW }), ORIGIN, d)).rejects.toThrow('Only a pot');
    expect(await handleSubscribeCall('list', {}, ORIGIN, d)).toEqual([]);
  });
  test('the charger refuses a subscription whose payer is not a pot, and signs nothing', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    const s = createAppSub(parseSubscribeArgs(req({ payTo: ADDR }, { at: NOW }), ORIGIN, NOW), '1Pot', 50, NOW);
    saveSub({ ...s, potId: '1MainAccount' }); // e.g. a tampered or migrated record pointing at the main account
    const paid: Outs[] = [];
    const r = await payDue(deps(paid), NOW + 1000);
    expect(r[0]).toMatchObject({ id: s.id, ok: false, reason: expect.stringContaining('Only a pot') });
    expect(paid.length).toBe(0);
  });
});

describe('merchant identity and request limits', () => {
  const NOW = T('2026-10-24T12:00:00Z');
  const OTHER = 'https://other.example';
  const approveWith = (potId: string | null, seen: { r?: unknown }[] = []) => ({
    approve: async (r: unknown) => {
      seen.push({ r });
      return potId;
    },
    bsvUsd: () => 50,
    now: () => NOW,
  });

  test('a self-signed key is never "verified": first request from an origin is new', () => {
    const selfKey = PrivateKey.fromRandom();
    const r = parseSubscribeArgs(req({}, { at: NOW, key: selfKey }), ORIGIN, NOW);
    expect(r.keyTrust).toBe('new');
    expect(r.appOrigin).toBe(ORIGIN);
  });

  test('pinning: the approved key matches next time, a different key is flagged', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    await handleSubscribeCall('subscribe', req({}, { at: NOW }), ORIGIN, approveWith('1Pot'));
    expect(parseSubscribeArgs(req({}, { at: NOW }), ORIGIN, NOW).keyTrust).toBe('same');
    const other = PrivateKey.fromRandom();
    expect(parseSubscribeArgs(req({}, { at: NOW, key: other }), ORIGIN, NOW).keyTrust).toBe('changed');
    // Pins are per origin: the same key from another origin is new there.
    const elsewhere = req({ appOrigin: OTHER }, { at: NOW, signFor: OTHER });
    expect(parseSubscribeArgs(elsewhere, OTHER, NOW).keyTrust).toBe('new');
  });

  test('a declined request pins nothing', async () => {
    await expect(handleSubscribeCall('subscribe', req({}, { at: NOW }), ORIGIN, approveWith(null))).rejects.toThrow(
      'Declined',
    );
    expect(parseSubscribeArgs(req({}, { at: NOW }), ORIGIN, NOW).keyTrust).toBe('new');
  });

  test('origin is stored on the subscription and shown on its card', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    const st = (await handleSubscribeCall('subscribe', req({}, { at: NOW }), ORIGIN, approveWith('1Pot'))) as {
      id: string;
    };
    const sub = getSub(st.id)!;
    expect(sub.payee.origin).toBe(ORIGIN);
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { SubscriptionCard } = await import('./SubscriptionCard');
    const html = renderToStaticMarkup(createElement(SubscriptionCard, { sub }));
    expect(html).toContain('Example Pro');
    expect(html).toContain('app.example.com');
  });

  test('nonce is not used up when the user declines or never sees the sheet', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    const r = req({}, { at: NOW });
    await expect(handleSubscribeCall('subscribe', r, ORIGIN, approveWith(null))).rejects.toThrow('Declined');
    // Parsing (what happens before the sheet) records nothing either.
    parseSubscribeArgs(r, ORIGIN, NOW);
    parseSubscribeArgs(r, ORIGIN, NOW);
    const ok = (await handleSubscribeCall('subscribe', r, ORIGIN, approveWith('1Pot'))) as { status: string };
    expect(ok.status).toBe('active');
  });

  test('nonces are kept per origin: one full origin never blocks another', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    // Fill OTHER's own store directly to its cap.
    const full: Record<string, number> = {};
    for (let i = 0; i < MAX_NONCES_PER_ORIGIN; i++) full[`${MKEY}:fill-${String(i).padStart(12, '0')}`] = NOW + 60_000;
    mem.set(`bwx.subNonces.v2:${OTHER}`, JSON.stringify(full));
    const fromOther = req({ appOrigin: OTHER }, { at: NOW, signFor: OTHER });
    await expect(handleSubscribeCall('subscribe', fromOther, OTHER, approveWith('1Pot'))).rejects.toThrow('Too many');
    const ok = (await handleSubscribeCall('subscribe', req({}, { at: NOW }), ORIGIN, approveWith('1Pot'))) as {
      status: string;
    };
    expect(ok.status).toBe('active');
  });

  test('a flood from one origin is limited and does not affect another', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    // One pending request at a time per origin.
    let release: (v: string | null) => void = () => undefined;
    const slow = {
      approve: () => new Promise<string | null>((res) => (release = res)),
      bsvUsd: () => 50,
      now: () => NOW,
    };
    const first = handleSubscribeCall('subscribe', req({ appOrigin: OTHER }, { at: NOW, signFor: OTHER }), OTHER, slow);
    await expect(
      handleSubscribeCall('subscribe', req({ appOrigin: OTHER }, { at: NOW, signFor: OTHER }), OTHER, slow),
    ).rejects.toThrow('already waiting');
    // Another origin is unaffected while OTHER waits.
    const ok = (await handleSubscribeCall('subscribe', req({}, { at: NOW }), ORIGIN, approveWith('1Pot'))) as {
      status: string;
    };
    expect(ok.status).toBe('active');
    release(null);
    await expect(first).rejects.toThrow('Declined');
    // A per-minute cap per origin (the first call above counted).
    for (let i = 1; i < MAX_ASKS_PER_MINUTE; i++)
      await expect(
        handleSubscribeCall(
          'subscribe',
          req({ appOrigin: OTHER }, { at: NOW, signFor: OTHER }),
          OTHER,
          approveWith(null),
        ),
      ).rejects.toThrow('Declined');
    await expect(
      handleSubscribeCall(
        'subscribe',
        req({ appOrigin: OTHER }, { at: NOW, signFor: OTHER }),
        OTHER,
        approveWith(null),
      ),
    ).rejects.toThrow('Too many');
    const ok2 = (await handleSubscribeCall('subscribe', req({}, { at: NOW }), ORIGIN, approveWith('1Pot'))) as {
      status: string;
    };
    expect(ok2.status).toBe('active');
  });
});
