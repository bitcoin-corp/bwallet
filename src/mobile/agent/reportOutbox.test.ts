import { describe, expect, test } from 'bun:test';
import {
  DEVICE,
  OUTBOX_CAP,
  backoffMs,
  enqueueReport,
  failureReason,
  flushOutbox,
  outboxText,
  queuedFor,
  readOutbox,
} from './reportOutbox';

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const call = async () => ({});

const NUMBERED = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
  .split(' ')
  .map((w, i) => `${i + 1}. ${w}`)
  .join('\n');

describe('report outbox', () => {
  test('a numbered recovery phrase is never stored', () => {
    const store = memStore();
    enqueueReport('A', `help, my words are\n${NUMBERED}`, 'signin', store, 0);
    const raw = store.getItem('bwallet.agent.reportOutbox') ?? '';
    expect(raw).not.toContain('abandon');
    expect(raw).not.toContain('accident');
  });
  test('items queued by an older build are scrubbed before they are sent', async () => {
    const store = memStore();
    store.setItem(
      'bwallet.agent.reportOutbox',
      JSON.stringify([{ id: 'x', account: 'A', text: NUMBERED, at: 0, tries: 1, nextAt: 0, reason: 'signin' }]),
    );
    const seen: string[] = [];
    await flushOutbox('A', call, {
      store,
      now: () => 1000,
      send: async (_c, text) => {
        seen.push(text);
        throw Object.assign(new Error('no'), { status: 401 });
      },
    });
    expect(seen).toEqual(['[recovery words hidden]']);
    expect(store.getItem('bwallet.agent.reportOutbox')).not.toContain('abandon');
  });
  test('a failed report is kept, per account', () => {
    const store = memStore();
    enqueueReport('A', 'broke', 'offline', store, 1000);
    enqueueReport('B', 'other', 'error', store, 1000);
    expect(queuedFor('A', store, 2000).map((r) => r.text)).toEqual(['broke']);
    expect(queuedFor('B', store, 2000).map((r) => r.text)).toEqual(['other']);
  });
  test('reports with no account open show for any account', () => {
    const store = memStore();
    const r = enqueueReport(null, 'boot', 'signin', store, 1000);
    expect(r.account).toBe(DEVICE);
    expect(queuedFor('A', store, 2000).length).toBe(1);
  });
  test('capped per account, oldest dropped', () => {
    const store = memStore();
    for (let i = 0; i < OUTBOX_CAP + 5; i++) enqueueReport('A', `r${i}`, 'error', store, 1000 + i);
    enqueueReport('B', 'keep', 'error', store, 1000);
    const a = queuedFor('A', store, 5000).filter((r) => r.account === 'A');
    expect(a.length).toBe(OUTBOX_CAP);
    expect(a[0].text).toBe('r5');
    expect(queuedFor('B', store, 5000).length).toBe(1);
  });
  test('backoff grows and is capped', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(50)).toBe(60 * 60_000);
  });
  test('failure reasons', () => {
    expect(failureReason(new Error('x'), false)).toBe('offline');
    expect(failureReason(new TypeError('Failed to fetch'), true)).toBe('offline');
    expect(failureReason(Object.assign(new Error('no'), { status: 401 }), true)).toBe('signin');
    expect(failureReason(new Error('Wallet is locked.'), true)).toBe('signin');
    expect(failureReason(new Error('500'), true)).toBe('error');
  });
  test('flush sends due reports and removes only those that were sent', async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'offline', store, 0);
    enqueueReport('A', 'two', 'offline', store, 0);
    const seen: string[] = [];
    const r = await flushOutbox('A', call, {
      store,
      now: () => 10 * 60_000,
      send: async (_c, text) => {
        seen.push(text);
        if (text === 'two') throw new Error('500');
        return { ack: 'ok', ref: 'F-1' };
      },
    });
    expect(seen).toEqual(['one', 'two']);
    expect(r).toEqual({ sent: 1, left: 1 });
    const left = readOutbox(store, 10 * 60_000);
    expect(left.map((x) => x.text)).toEqual(['two']);
    expect(left[0].tries).toBe(2);
    expect(left[0].nextAt).toBe(10 * 60_000 + backoffMs(2));
  });
  test('respects backoff unless forced', async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'offline', store, 0);
    let sends = 0;
    const send = async () => {
      sends++;
      return { ack: 'ok', ref: '' };
    };
    await flushOutbox('A', call, { store, now: () => 1000, send });
    expect(sends).toBe(0);
    await flushOutbox('A', call, { store, now: () => 1000, send, force: true });
    expect(sends).toBe(1);
    expect(readOutbox(store, 1000)).toEqual([]);
  });
  test('stops at the first offline / sign-in failure and never drops', async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'offline', store, 0);
    enqueueReport('A', 'two', 'offline', store, 0);
    let sends = 0;
    await flushOutbox('A', call, {
      store,
      force: true,
      now: () => 1000,
      send: async () => {
        sends++;
        throw Object.assign(new Error('unauthorised'), { status: 401 });
      },
    });
    expect(sends).toBe(1);
    const left = readOutbox(store, 1000);
    expect(left.length).toBe(2);
    expect(left[0].reason).toBe('signin');
  });
});

describe('failureReason: offline even when navigator says online', () => {
  test('aborts, timeouts and DNS failures read as offline', () => {
    expect(failureReason(new Error('signal is aborted without reason'), true)).toBe('offline');
    expect(failureReason(new DOMException('x', 'TimeoutError'), true)).toBe('offline');
    expect(failureReason('net::ERR_NAME_NOT_RESOLVED', true)).toBe('offline');
  });
  test('a server error is still an error, sign-in still sign-in', () => {
    expect(failureReason(new Error('HTTP 500'), true)).toBe('error');
    expect(failureReason(Object.assign(new Error('x'), { status: 401 }), true)).toBe('signin');
  });
  test("offline text says You're offline", () => expect(outboxText('offline').startsWith("You're offline")).toBe(true));
});
