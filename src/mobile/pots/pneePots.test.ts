import { beforeEach, describe, expect, test } from 'bun:test';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const {
  addSubscription,
  amountPnee,
  amountUsd,
  defaultDailyCap,
  formatAmount,
  getPending,
  getPot,
  getSub,
  makePot,
  moveSub,
  potCoversPnee,
  setPotUnit,
  subProblem,
  usdToPnee,
} = await import('./pots');
const { payDue } = await import('./payDue');
const { pickPneeInputs, p2pkhSuffixHash } = await import('./pneePot');
const { getAgentAccount, getAgentLog, setAgentStopped, setAllAgentsStopped } = await import('../agents/agentAccounts');

const NOW = Date.parse('2026-03-10T12:00:00Z');
const DAY = 86_400_000;
const H = 'ab'.repeat(20);
const script = (hash = H) => `0063036f726451${'00'.repeat(4)}6876a914${hash}88ac`;

describe('PNEE amounts', () => {
  test('dollars to PNEE units, formatting and $ value', () => {
    expect(usdToPnee(5)).toBe(500);
    expect(usdToPnee(0.1 + 0.2)).toBe(30);
    expect(amountPnee({ value: 500, currency: 'PNEE' })).toBe(500);
    expect(amountPnee({ value: 1.5, currency: 'PNEE' })).toBeNull();
    expect(amountPnee({ value: 5, currency: 'USD' })).toBeNull();
    expect(amountUsd({ value: 500, currency: 'PNEE' }, 0)).toBe(5);
    expect(formatAmount({ value: 500, currency: 'PNEE' })).toBe('$5.00 in PNEEs');
    // Daily cap from PNEE orders, in dollars, without any BSV price.
    expect(
      defaultDailyCap(
        [
          {
            amount: { value: 1000, currency: 'PNEE' },
            status: 'active',
          } as never,
        ],
        0,
      ),
    ).toBe(33);
  });

  test('covers counts PNEE payments against a PNEE balance', () => {
    const s = {
      id: 'a',
      potId: 'p',
      payee: { name: 'x', address: '1x' },
      amount: { value: 300, currency: 'PNEE' as const },
      period: 'day' as const,
      start: 0,
      maxCount: null,
      paidCount: 0,
      periodIndex: 0,
      nextDue: 0,
      status: 'active' as const,
      mode: 'onOpen' as const,
    };
    expect(potCoversPnee([s], 1000)).toBe(3);
    expect(potCoversPnee([s], 299)).toBe(0);
  });
});

describe('picking PNEE inputs (overlay + key check)', () => {
  test('reads the P2PKH suffix', () => {
    expect(p2pkhSuffixHash(script())).toBe(H);
    expect(p2pkhSuffixHash('6a0102')).toBeNull();
  });

  test('only overlay-valid outputs the pot key signs, largest first', () => {
    const r = pickPneeInputs(
      [
        { outpoint: 'a_0', amt: BigInt(100), scriptHex: script(), state: 'valid' },
        { outpoint: 'b_0', amt: BigInt(900), scriptHex: script(), state: 'queued' },
        { outpoint: 'c_0', amt: BigInt(800), scriptHex: script('cd'.repeat(20)), state: 'valid' },
        { outpoint: 'd_0', amt: BigInt(400), scriptHex: script(), state: 'valid' },
        { outpoint: 'e_0', amt: BigInt(700), scriptHex: script(), state: 'spent' },
      ],
      H,
      BigInt(450),
    );
    expect(r).toEqual({
      ok: true,
      inputs: [
        { outpoint: 'd_0', amt: BigInt(400), scriptHex: script(), state: 'valid' },
        { outpoint: 'a_0', amt: BigInt(100), scriptHex: script(), state: 'valid' },
      ],
      total: BigInt(500),
      change: BigInt(50),
    });
  });

  test('short: says whether more is still being indexed', () => {
    const queued = pickPneeInputs(
      [
        { outpoint: 'a_0', amt: BigInt(100), scriptHex: script(), state: 'valid' },
        { outpoint: 'b_0', amt: BigInt(900), scriptHex: script(), state: 'queued' },
      ],
      H,
      BigInt(450),
    );
    expect(queued).toEqual({
      ok: false,
      reason: 'Not enough PNEEs in the pot ready to spend yet',
      spendable: BigInt(100),
    });
    const none = pickPneeInputs(
      [{ outpoint: 'a_0', amt: BigInt(100), scriptHex: script(), state: 'valid' }],
      H,
      BigInt(450),
    );
    expect(none).toMatchObject({ ok: false, reason: 'Not enough PNEEs in the pot' });
  });
});

describe('PNEE pots: store and pay-on-open', () => {
  beforeEach(() => {
    mem.clear();
    setAllAgentsStopped(false);
  });

  const pneePot = (id = '1Pot') => {
    makePot(id, 'Rent', undefined, NOW);
    expect(setPotUnit(id, 'PNEE')).toBe(true);
  };
  const order = (p: Partial<Parameters<typeof addSubscription>[0]> = {}) =>
    addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Landlord', address: '1Landlord' },
        amount: { value: 1000, currency: 'PNEE' },
        period: 'day',
        start: NOW - 2 * DAY - 1000,
        maxCount: null,
        ...p,
      },
      0,
      NOW,
    );

  test('a pot can hold PNEEs; orders must match the pot', () => {
    pneePot();
    expect(getPot('1Pot')?.unit).toBe('PNEE');
    makePot('1Bsv', 'Bills', undefined, NOW);
    const base = {
      potId: '1Pot',
      payee: { name: 'x', address: '1x' },
      amount: { value: 500, currency: 'PNEE' as const },
      period: 'month' as const,
      start: NOW,
      maxCount: null,
    };
    expect(subProblem(base)).toBeNull();
    expect(subProblem({ ...base, amount: { value: 5, currency: 'USD' } })).toBe('This pot pays in PNEEs');
    expect(subProblem({ ...base, amount: { value: 2.5, currency: 'PNEE' } })).toBe('Enter a whole number of cents');
    expect(subProblem({ ...base, potId: '1Bsv' })).toBe('PNEE orders need a PNEE pot');
  });

  test('the unit is locked while orders are live, and orders only move between same-unit pots', () => {
    pneePot();
    const s = order();
    expect(setPotUnit('1Pot', 'BSV')).toBe(false);
    makePot('1Bsv', 'Bills', undefined, NOW);
    moveSub(s.id, '1Bsv');
    expect(getSub(s.id)?.potId).toBe('1Pot');
    pneePot('1Other');
    moveSub(s.id, '1Other');
    expect(getSub(s.id)?.potId).toBe('1Other');
  });

  test('pays due periods in PNEEs through the PNEE send path, with a $ daily cap', async () => {
    pneePot();
    const s = order();
    expect(getAgentAccount('1Pot')?.dailyCapUsd).toBe(33);
    const signed: { outputs: { address: string; units: number }[]; memo?: string }[] = [];
    const sent: string[] = [];
    const r = await payDue(
      {
        bsvUsd: 0, // no BSV price needed for PNEEs
        resolve: async (p) => p.address!,
        sign: async () => {
          throw new Error('BSV path must not be used');
        },
        broadcast: async () => {
          throw new Error('BSV path must not be used');
        },
        signPnee: async (_pot, outputs, memo) => (signed.push({ outputs, memo }), { rawTx: 'beef:P1', txid: 'P1' }),
        broadcastPnee: async (raw) => void sent.push(raw),
      },
      NOW,
    );
    expect(r).toEqual([{ id: s.id, ok: true, count: 3, txid: 'P1' }]);
    expect(signed[0].outputs).toEqual(Array(3).fill({ address: '1Landlord', units: 1000 }));
    expect(sent).toEqual(['beef:P1']);
    expect(getSub(s.id)?.paidCount).toBe(3);
    expect(getAgentLog('1Pot')[0]).toMatchObject({ action: 'sub-pay', usd: 30, txid: 'P1' });
    expect(getAgentLog('1Pot')[0].detail).toContain('$10.00 in PNEEs');
    expect(getPending(s.id)).toBeNull();
  });

  test('daily cap and Stop hold PNEE payments too', async () => {
    pneePot();
    const s = order({ start: NOW - 5 * DAY - 1000 }); // 6 due, catch-up confirmed = $60 > $33 cap
    let signs = 0;
    const deps = {
      bsvUsd: 0,
      resolve: async () => '1L',
      sign: async () => ({ rawTx: '', txid: '' }),
      broadcast: async () => undefined,
      signPnee: async () => (signs++, { rawTx: 'b', txid: 't' }),
      broadcastPnee: async () => undefined,
      confirm: async () => true,
    };
    expect((await payDue(deps, NOW))[0].ok).toBe(false);
    expect(signs).toBe(0);
    mem.clear();
    pneePot();
    const s2 = order();
    setAgentStopped('1Pot', true);
    expect((await payDue(deps, NOW))[0].ok).toBe(false);
    expect(signs).toBe(0);
    expect(getSub(s2.id)?.paidCount).toBe(0);
    expect(s.id).not.toBe(s2.id);
  });

  test('without a PNEE send path the order waits and says why; nothing is signed', async () => {
    pneePot();
    const s = order();
    const r = await payDue(
      {
        bsvUsd: 50,
        resolve: async () => '1L',
        sign: async () => ({ rawTx: 'x', txid: 'x' }),
        broadcast: async () => undefined,
      },
      NOW,
    );
    expect(r[0]).toMatchObject({ ok: false });
    expect(getSub(s.id)?.paidCount).toBe(0);
  });

  test('a recorded PNEE payment is rebroadcast with the PNEE path, never re-signed', async () => {
    pneePot();
    const s = order();
    let signs = 0;
    const sent: string[] = [];
    await payDue(
      {
        bsvUsd: 0,
        resolve: async () => '1L',
        sign: async () => ({ rawTx: '', txid: '' }),
        broadcast: async () => undefined,
        signPnee: async () => (signs++, { rawTx: 'beef:A', txid: 'A' }),
        broadcastPnee: async () => {
          throw new Error('network down');
        },
      },
      NOW,
    );
    expect(getPending(s.id)).toMatchObject({ unit: 'PNEE', rawTx: 'beef:A' });
    const r = await payDue(
      {
        bsvUsd: 0,
        resolve: async () => '1L',
        sign: async () => ({ rawTx: '', txid: '' }),
        broadcast: async () => {
          throw new Error('BSV path must not be used');
        },
        signPnee: async () => (signs++, { rawTx: 'beef:B', txid: 'B' }),
        broadcastPnee: async (raw) => void sent.push(raw),
      },
      NOW,
    );
    expect(r).toEqual([{ id: s.id, ok: true, count: 3, txid: 'A' }]);
    expect(signs).toBe(1);
    expect(sent).toEqual(['beef:A']);
  });
});

describe('PNEE overlay fee bound (auto-pay has no per-payment prompt)', () => {
  test('no fee address or fee: 0', async () => {
    const { pneeOverlayFee } = await import('./pneePot');
    expect(pneeOverlayFee(undefined, 100, 2)).toBe(0);
    expect(pneeOverlayFee('1abc', 0, 2)).toBe(0);
  });
  test('normal fee: per token output', async () => {
    const { pneeOverlayFee } = await import('./pneePot');
    expect(pneeOverlayFee('1abc', 1000, 3)).toBe(3000);
  });
  test('an inflated or fractional fee fails the payment instead of draining the pot', async () => {
    const { pneeOverlayFee, MAX_PNEE_OVERLAY_FEE_PER_OUTPUT } = await import('./pneePot');
    expect(() => pneeOverlayFee('1abc', MAX_PNEE_OVERLAY_FEE_PER_OUTPUT + 1, 1)).toThrow();
    expect(() => pneeOverlayFee('1abc', 1e9, 1)).toThrow();
    expect(() => pneeOverlayFee('1abc', 1.5, 1)).toThrow();
  });
});
