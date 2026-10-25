import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FINAL_CODES,
  PENDING_MAX_AGE_MS,
  clearPending,
  errorCode,
  loadPending,
  parsePending,
  savePending,
  type PendingPaid,
} from './pending';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const NOW = 1_800_000_000_000;
const TXID = 'ab'.repeat(32);
const p = (over: Partial<PendingPaid> = {}): PendingPaid => ({
  account: '1Acct',
  quote: { quoteId: 'q_abcdefgh', sats: 3000, payTo: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', expiresAt: NOW + 60_000 },
  txid: TXID,
  messages: [{ role: 'user', text: 'hi' }],
  shown: [{ role: 'user', text: 'hi' }],
  at: NOW,
  ...over,
});

beforeEach(() => store.clear());

describe('pending paid message', () => {
  test('round-trips through storage, per account', () => {
    savePending(p());
    expect(loadPending('1Acct', NOW)).toEqual(p());
    expect(loadPending('1Other', NOW)).toBeNull();
    expect(loadPending(undefined, NOW)).toBeNull();
    clearPending();
    expect(loadPending('1Acct', NOW)).toBeNull();
  });

  test('keeps a pre-payment slot (txid null)', () => {
    expect(parsePending(p({ txid: null }), NOW)?.txid).toBeNull();
  });

  test('rejects malformed or stale data', () => {
    expect(parsePending(null, NOW)).toBeNull();
    expect(parsePending({ ...p(), txid: 'nope' }, NOW)).toBeNull();
    expect(parsePending({ ...p(), quote: { ...p().quote, payTo: '3abc' } }, NOW)).toBeNull();
    expect(parsePending({ ...p(), messages: [] }, NOW)).toBeNull();
    expect(parsePending({ ...p(), messages: [{ role: 'system', text: 'x' }] }, NOW)).toBeNull();
    expect(parsePending(p(), NOW + PENDING_MAX_AGE_MS + 1)).toBeNull();
    store.set('bwallet.agent.pending', '{not json');
    expect(loadPending('1Acct', NOW)).toBeNull();
  });

  test('reads bit-sign error codes; retryable ones are not final', () => {
    expect(errorCode({ data: { code: 'quote_used' } })).toBe('quote_used');
    expect(errorCode(new Error('x'))).toBeNull();
    expect(FINAL_CODES.has('quote_used')).toBe(true);
    for (const c of ['model_failed', 'rate_limited', 'server', 'tx_not_found']) expect(FINAL_CODES.has(c)).toBe(false);
  });
});
