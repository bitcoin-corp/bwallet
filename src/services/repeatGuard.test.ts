import { describe, expect, test } from 'bun:test';
import {
  repeatFingerprints,
  QUEUED_MESSAGE,
  RepeatGuard,
  REPEAT_WINDOW_MS,
  queuedResult,
  queuedSend,
  repeatRefusal,
  requestFingerprint,
} from './repeatGuard';

const lock = (h: string) => `76a914${h.repeat(40).slice(0, 40)}88ac`;
const ord = (body: string) => `0063036f7264${body}68`;

describe('requestFingerprint', () => {
  test('the same inscription matches even with a fresh receive address', async () => {
    const a = await requestFingerprint({
      outputs: [{ lockingScript: ord('aa'.repeat(50)) + lock('1'), satoshis: 1, outputDescription: '' }],
    });
    const b = await requestFingerprint({
      outputs: [{ lockingScript: ord('aa'.repeat(50)) + lock('2'), satoshis: 1, outputDescription: '' }],
    });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
  test('different content does not match', async () => {
    const a = await requestFingerprint({ outputs: [{ lockingScript: ord('aa'), satoshis: 1, outputDescription: '' }] });
    const b = await requestFingerprint({ outputs: [{ lockingScript: ord('bb'), satoshis: 1, outputDescription: '' }] });
    expect(a).not.toBe(b);
  });
  test('small plain payments are not guarded (tips repeat)', async () => {
    expect(
      await requestFingerprint({ outputs: [{ lockingScript: lock('3'), satoshis: 500, outputDescription: '' }] }),
    ).toBeNull();
    expect(await requestFingerprint({ outputs: [] })).toBeNull();
  });
});

describe('RepeatGuard', () => {
  test('refuses a repeat inside the window, allows after it or after an abort', () => {
    let t = 1_000;
    const g = new RepeatGuard(() => t);
    g.record('fp', { reference: 'r1' });
    t += 60_000;
    expect(g.check('fp')?.reference).toBe('r1');
    g.aborted('r1');
    expect(g.check('fp')).toBeNull();
    g.record('fp', { reference: 'r2' });
    t += REPEAT_WINDOW_MS + 1;
    expect(g.check('fp')).toBeNull();
  });
  test('an abort by txid after signing clears it too', () => {
    const g = new RepeatGuard(() => 0);
    g.record('fp', { reference: 'r1' });
    g.signed('r1', 'tx1');
    g.aborted('tx1');
    expect(g.check('fp')).toBeNull();
  });
  test('message says how long ago', () => {
    expect(repeatRefusal({ at: 0 }, 4 * 60_000)).toContain('4 minutes ago');
  });
});

describe('queuedSend', () => {
  test('only all-sending results count as queued', () => {
    expect(queuedSend({ sendWithResults: [{ status: 'sending' }] })).toBe(true);
    expect(queuedSend({ sendWithResults: [{ status: 'failed' }] })).toBe(false);
    expect(queuedSend(new Error('x'))).toBe(false);
  });
});

describe('queuedResult', () => {
  const txid = 'ab'.repeat(32);
  test('a queued send answers with its txid, marked pending', () => {
    const r = queuedResult({ txid, sendWithResults: [{ txid, status: 'sending' }] });
    expect(r?.txid).toBe(txid);
    expect(r?.pending).toBe(true);
    expect(r?.message).toBe(QUEUED_MESSAGE);
    expect(r?.sendWithResults).toEqual([{ txid, status: 'sending' }]);
  });
  test('falls back to the txid in sendWithResults', () => {
    expect(queuedResult({ sendWithResults: [{ txid, status: 'sending' }] })?.txid).toBe(txid);
  });
  test('null for real failures and queued sends without a txid', () => {
    expect(queuedResult({ txid, sendWithResults: [{ txid, status: 'failed' }] })).toBeNull();
    expect(queuedResult(new Error('x'))).toBeNull();
    expect(queuedResult({ sendWithResults: [{ status: 'sending' }] })).toBeNull();
  });
  test('reads the txid from reviewActionResults or the atomic BEEF', () => {
    expect(queuedResult({ reviewActionResults: [{ txid }], sendWithResults: [{ status: 'sending' }] })?.txid).toBe(
      txid,
    );
    const want = '0123456789abcdef'.repeat(4);
    const le = want
      .match(/../g)!
      .reverse()
      .map((h) => parseInt(h, 16));
    const r = queuedResult({ tx: [1, 1, 1, 1, ...le, 1, 0], sendWithResults: [{ status: 'sending' }] });
    expect(r?.txid).toBe(want);
    expect(r?.sendWithResults).toEqual([{ txid: want, status: 'sending' }]);
  });
  test('uses the fallback txid (storage, by reference) when the error has none', () => {
    expect(queuedResult({ sendWithResults: [{ status: 'sending' }] }, txid)?.txid).toBe(txid);
    expect(queuedResult({ sendWithResults: [{ status: 'failed' }] }, txid)).toBeNull();
    expect(queuedResult({ sendWithResults: [{ status: 'sending' }] }, 'nope')).toBeNull();
  });
});

describe('repeatFingerprints: chain options never switch the guard off (b-Aware row 55)', () => {
  const ord = `0063036f7264${'ab'.repeat(40)}68`;
  const outputs = [{ lockingScript: ord, satoshis: 1, outputDescription: 'mint' }];
  test.each([
    ['sendWith', { sendWith: ['00'.repeat(32)] }],
    ['noSendChange', { noSendChange: ['00'.repeat(32) + '.0'] }],
    ['knownTxids', { knownTxids: ['00'.repeat(32)] }],
  ])('a repeat carrying %s is still refused', async (_n, options) => {
    const g = new RepeatGuard();
    const first = await repeatFingerprints({ outputs });
    g.record(first.recordedFingerprint, { origin: 'https://a.com' });
    const again = await repeatFingerprints({ outputs, options: options as never });
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(g.check(again.fingerprint)).not.toBeNull();
  });
  test('a noSend step is checked but not recorded', async () => {
    const r = await repeatFingerprints({ outputs, options: { noSend: true } });
    expect(r.fingerprint).not.toBeNull();
    expect(r.recordedFingerprint).toBeNull();
  });
});
