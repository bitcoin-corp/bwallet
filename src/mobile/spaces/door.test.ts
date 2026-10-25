import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as bmailClient from '../bmail/client';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

// The message box and the wallet's BEEF check are mocked: these tests cover the door's own rules.
type Msg = { messageId: string; sender: string; body: string };
let inbox: Msg[] = [];
let sent: { recipient: string; messageBox: string; body: string }[] = [];
let acked: string[] = [];
let paidSats = 20_000;
let internalized = 0;
// Keep the real exports: bun module mocks are process-wide, and a partial mock left behind breaks later files that
// import other names from it.
const realMessageBox = { ...(await import('@bsv/message-box-client')) };
mock.module('@bsv/message-box-client', () => ({
  ...realMessageBox,
  MessageBoxClient: class {
    async listMessages() {
      return inbox.filter((m) => !acked.includes(m.messageId));
    }
    async acknowledgeMessage({ messageIds }: { messageIds: string[] }) {
      acked.push(...messageIds);
    }
    async sendMessage(m: { recipient: string; messageBox: string; body: string }) {
      sent.push(m);
    }
  },
}));
// A copy taken before mocking (the mock patches the module namespace in place).
const realClient = { ...bmailClient };
mock.module('../bmail/client', () => ({
  // Keep the real exports (bun module mocks leak across test files; bMail's own tests need sendMail).
  ...realClient,
  bmailHost: () => 'https://box.test',
  verifyPostage: async (_w: unknown, _e: unknown, internalize = true) => {
    if (internalize) internalized++;
    return { sats: paidSats };
  },
}));

const door = await import('./door');
const { checkDoorRequest, parseDoorRequest, runDoor, doorPriceUsd, minAcceptSats, needsHandCheck, loadLedger } = door;

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const K = (c: string) => `02${c.repeat(64)}`;
const HOST = K('b');
const PAYER = K('a');
const NOW = 1_760_000_000_000;
const req = (o: Record<string, unknown> = {}) => ({
  t: 'spacedoor',
  v: 1,
  id: 'ab'.repeat(16),
  from: PAYER,
  to: HOST,
  ticker: 'PENNY1',
  ordAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
  usd: 0.01,
  at: NOW,
  payment: {
    txid: 'c'.repeat(64),
    sats: 20_000,
    outputIndex: 0,
    beef: 'beef',
    derivationPrefix: 'p',
    derivationSuffix: 's',
  },
  ...o,
});
const msg = (id: string, body: unknown, sender = PAYER): Msg => ({ messageId: id, sender, body: JSON.stringify(body) });
const run = (sendTicket = async () => 'd'.repeat(64)) =>
  runDoor({} as never, { hostKey: HOST, ticker: 'PENNY1', priceSats: 20_000, sendTicket, now: () => NOW });

beforeEach(() => {
  inbox = [];
  sent = [];
  acked = [];
  paidSats = 20_000;
  internalized = 0;
  store.clear();
});

describe('door request parsing', () => {
  test('accepts a good request and normalises the ticker', () => {
    expect(parseDoorRequest(JSON.stringify(req({ ticker: 'penny1' })))?.ticker).toBe('PENNY1');
  });
  test('rejects a bad address, self-payment, or missing payment', () => {
    expect(parseDoorRequest(req({ ordAddress: 'nope' }))).toBeNull();
    expect(parseDoorRequest(req({ to: PAYER }))).toBeNull();
    expect(parseDoorRequest(req({ payment: null }))).toBeNull();
  });
});

describe('door checks', () => {
  const ctx = { sender: PAYER, hostKey: HOST, ticker: 'PENNY1', priceSats: 20_000, ledger: {}, now: NOW };
  const r = () => parseDoorRequest(req())!;
  test('ok', () => expect(checkDoorRequest(r(), ctx).ok).toBe(true));
  test('sender must be the payer the relay authenticated', () =>
    expect(checkDoorRequest(r(), { ...ctx, sender: K('e') }).ok).toBe(false));
  test('a txid already used is refused', () => {
    const c = checkDoorRequest(r(), {
      ...ctx,
      ledger: { ['c'.repeat(64)]: { status: 'sent', ticker: 'PENNY1', payer: PAYER, at: NOW } },
    });
    expect(c.ok).toBe(false);
  });
  test('underpaid is refused; small rate drift is fine', () => {
    expect(checkDoorRequest(r(), { ...ctx, priceSats: 30_000 }).ok).toBe(false);
    expect(checkDoorRequest(r(), { ...ctx, priceSats: 24_000 }).ok).toBe(true);
  });
  test('stale request refused; no rate yet means retry later', () => {
    expect(checkDoorRequest(r(), { ...ctx, now: NOW + 7 * 3600_000 }).ok).toBe(false);
    const c = checkDoorRequest(r(), { ...ctx, priceSats: null });
    expect(c.ok === false && c.retry).toBe(true);
  });
  test('price defaults to one cent', () => {
    expect(doorPriceUsd(null)).toBe(0.01);
    expect(doorPriceUsd(0.05)).toBe(0.05);
    expect(minAcceptSats(20_000)).toBe(16_000);
  });
});

describe('runDoor', () => {
  test('one admission per txid, even when the same payment is sent twice', async () => {
    inbox = [msg('m1', req()), msg('m2', req({ id: 'cd'.repeat(16) }))];
    const tickets: string[] = [];
    const r = await run(async () => {
      tickets.push('x');
      return 'd'.repeat(64);
    });
    expect(r.admitted).toBe(1);
    expect(tickets.length).toBe(1);
    expect(internalized).toBe(1);
    expect(acked.sort()).toEqual(['m1', 'm2']);
    // Both get an ok reply (the repeat is told it is already in).
    const replies = sent.filter((s) => s.messageBox === 'spacedoor_reply').map((s) => JSON.parse(s.body));
    expect(replies.every((x) => x.ok)).toBe(true);
    // A later pass with the same payment again sends nothing.
    inbox.push(msg('m3', req({ id: 'ef'.repeat(16) })));
    const again = await run();
    expect(again.admitted).toBe(0);
  });

  test('a payment smaller than claimed is refused and not taken', async () => {
    paidSats = 100;
    inbox = [msg('m1', req())];
    const r = await run();
    expect(r.admitted).toBe(0);
    expect(r.refused).toBe(1);
    expect(internalized).toBe(0);
  });

  test('a forged sender is refused without touching money', async () => {
    inbox = [msg('m1', req(), K('e'))];
    const r = await run();
    expect(r.admitted).toBe(0);
    expect(internalized).toBe(0);
  });

  test('a failed ticket send is never retried automatically', async () => {
    inbox = [msg('m1', req())];
    const r = await run(async () => {
      throw new Error('broadcast failed');
    });
    expect(r.check).toBe(1);
    expect(needsHandCheck(loadLedger(HOST), 'PENNY1').length).toBe(1);
    inbox.push(msg('m2', req({ id: 'cd'.repeat(16) })));
    let calls = 0;
    await run(async () => {
      calls++;
      return 'd'.repeat(64);
    });
    expect(calls).toBe(0);
  });

  test('requests for another room stay in the box', async () => {
    inbox = [msg('m1', req({ ticker: 'OTHER' }))];
    await run();
    expect(acked).toEqual([]);
  });
});
