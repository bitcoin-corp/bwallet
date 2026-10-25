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

const { addSubscription, getSub, makePot, confirmPayeeReview } = await import('./pots');
const { payDue } = await import('./payDue');
const { payeeDestination, PayeeReviewError, PAYEE_KEY_CHANGED, keyFingerprint } = await import('./payeeBinding');
const { BAD_BINDING, KEY_CHANGED } = await import('../names/names');
const { setAllAgentsStopped } = await import('../agents/agentAccounts');
type Resolved = import('../names/names').Resolved;
type Payee = import('./pots').Payee;

const NOW = Date.parse('2026-10-20T12:00:00Z');
const DAY = 86_400_000;
const KEY_A = '02' + 'a'.repeat(64);
const KEY_B = '02' + 'b'.repeat(64);

const resolved = (p: Partial<Resolved> = {}): Resolved => ({
  input: 'alice@bwalletx.com',
  target: '1AliceAddr',
  targetKind: 'address',
  via: 'paymail-address',
  pubkey: KEY_A,
  nameBinding: 'signed',
  ...p,
});

const setup = (payee: Payee) => {
  makePot('1Pot', 'Rent', undefined, NOW);
  return addSubscription(
    { potId: '1Pot', payee, amount: { value: 1, currency: 'USD' }, period: 'day', start: NOW - 1000, maxCount: null },
    50,
    NOW,
  );
};

/** payDue deps whose resolver runs the real payeeDestination over a stubbed resolution. */
const deps = (r: () => Resolved, paid: string[]) => ({
  bsvUsd: 50,
  resolve: async (p: Payee) => payeeDestination(p, r()),
  sign: async (_potId: string, outputs: { address: string }[]) => {
    paid.push(outputs[0].address);
    return { rawTx: 'raw', txid: `tx${paid.length}` };
  },
  broadcast: async () => undefined,
});

beforeEach(() => {
  mem.clear();
  setAllAgentsStopped(false);
});

describe('payeeDestination', () => {
  test('same pinned key → destination', () => {
    expect(payeeDestination({ name: 'a', paymail: 'alice@bwalletx.com', pinnedKey: KEY_A }, resolved())).toEqual({
      address: '1AliceAddr',
      pubkey: KEY_A,
    });
  });
  test('changed key vs pin → review', () => {
    const p = { name: 'a', paymail: 'alice@bwalletx.com', pinnedKey: KEY_A };
    expect(() => payeeDestination(p, resolved({ pubkey: KEY_B }))).toThrow(PayeeReviewError);
    // The user reviewing the change may look past the pin, but never past destinationFor.
    expect(payeeDestination(p, resolved({ pubkey: KEY_B }), { ignorePin: true }).pubkey).toBe(KEY_B);
    expect(() => payeeDestination(p, resolved({ nameBinding: 'bad' }), { ignorePin: true })).toThrow(BAD_BINDING);
  });
  test('bad binding and BRC-169 key change → review even with no pin', () => {
    const p = { name: 'a', paymail: 'alice@bwalletx.com' };
    expect(() => payeeDestination(p, resolved({ nameBinding: 'bad' }))).toThrow(BAD_BINDING);
    expect(() => payeeDestination(p, resolved({ nameBinding: 'changed' }))).toThrow(KEY_CHANGED);
  });
  test('fingerprint', () => expect(keyFingerprint(KEY_A)).toBe('02aaaaaa…aaaaaa'));
});

describe('automatic payments honour the pinned binding', () => {
  test('same pinned key → paid', async () => {
    const s = setup({ name: 'Alice', paymail: 'alice@bwalletx.com', pinnedKey: KEY_A });
    const paid: string[] = [];
    const r = await payDue(
      deps(() => resolved(), paid),
      NOW,
    );
    expect(r[0]).toMatchObject({ id: s.id, ok: true });
    expect(paid).toEqual(['1AliceAddr']);
  });

  test('changed key → not paid, flagged needsReview, notified; stays unpaid until confirmed', async () => {
    const s = setup({ name: 'Alice', paymail: 'alice@bwalletx.com', pinnedKey: KEY_A });
    const paid: string[] = [];
    const notes: string[] = [];
    const d = {
      ...deps(() => resolved({ pubkey: KEY_B, target: '1Mallory' }), paid),
      notify: (t: string) => void notes.push(t),
    };
    const r = await payDue(d, NOW);
    expect(r[0]).toMatchObject({ id: s.id, ok: false, reason: PAYEE_KEY_CHANGED });
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.needsReview).toMatchObject({ reason: PAYEE_KEY_CHANGED, servedKey: KEY_B });
    expect(notes).toHaveLength(1);
    // Next open: still not paid, no second alert, resolver not even asked.
    let asked = 0;
    await payDue({ ...d, resolve: async (p: Payee) => (asked++, payeeDestination(p, resolved())) }, NOW + 1000);
    expect(paid).toEqual([]);
    expect(asked).toBe(0);
    expect(notes).toHaveLength(1);
    // The user confirms the new destination: payments resume to the new key only.
    confirmPayeeReview(s.id, KEY_B, NOW);
    expect(getSub(s.id)?.needsReview).toBeUndefined();
    expect(getSub(s.id)?.payee.pinnedKey).toBe(KEY_B);
    await payDue(d, NOW + 2000);
    expect(paid).toEqual(['1Mallory']);
  });

  test('bad binding → not paid, flagged', async () => {
    const s = setup({ name: 'Alice', paymail: 'alice@bwalletx.com', pinnedKey: KEY_A });
    const paid: string[] = [];
    await payDue(
      deps(() => resolved({ nameBinding: 'bad' }), paid),
      NOW,
    );
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.needsReview?.reason).toBe(BAD_BINDING);
  });

  test('pinned key no longer served → not paid, flagged', async () => {
    const s = setup({ name: 'Alice', paymail: 'alice@bwalletx.com', pinnedKey: KEY_A });
    const paid: string[] = [];
    await payDue(
      deps(() => resolved({ pubkey: undefined, nameBinding: undefined }), paid),
      NOW,
    );
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.needsReview).toBeDefined();
  });

  test('legacy order without a pin: pinned on first verified resolution, then held to it', async () => {
    const s = setup({ name: 'Alice', paymail: 'alice@bwalletx.com' });
    const paid: string[] = [];
    await payDue(
      deps(() => resolved(), paid),
      NOW,
    );
    expect(paid).toEqual(['1AliceAddr']);
    expect(getSub(s.id)?.payee.pinnedKey).toBe(KEY_A);
    await payDue(
      deps(() => resolved({ pubkey: KEY_B }), paid),
      NOW + DAY,
    );
    expect(paid).toEqual(['1AliceAddr']);
    expect(getSub(s.id)?.needsReview?.reason).toBe(PAYEE_KEY_CHANGED);
  });

  test('legacy order: a failing first resolution pins nothing', async () => {
    const s = setup({ name: 'Alice', paymail: 'alice@bwalletx.com' });
    const paid: string[] = [];
    await payDue(
      deps(() => resolved({ nameBinding: 'bad' }), paid),
      NOW,
    );
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.payee.pinnedKey).toBeUndefined();
  });
});
