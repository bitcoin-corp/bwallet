import { afterAll, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { REPLY_MAX, REPLY_TTL_MS, ReplyBook } from './replies';
import { PAIR_VERSION, Sealer, deriveSession, pairUrl, type PairMessage } from '../../pair/protocol';

describe('ReplyBook', () => {
  test('a repeat of an answered request replays the stored reply; in-flight repeats are dropped', () => {
    const b = new ReplyBook();
    expect(b.begin('c', 'r1')).toBe('run');
    expect(b.begin('c', 'r1')).toBe('busy');
    const res: PairMessage = { t: 'res', id: 'r1', result: { txid: 'aa' } };
    b.finish('c', 'r1', res);
    expect(b.begin('c', 'r1')).toEqual({ replay: res });
    expect(b.begin('other', 'r1')).toBe('run'); // per channel
  });

  test('bounded by count and age', () => {
    let t = 0;
    const b = new ReplyBook(() => t);
    for (let i = 0; i <= REPLY_MAX; i++) {
      b.begin('c', `r${i}`);
      b.finish('c', `r${i}`, { t: 'res', id: `r${i}`, result: i });
    }
    expect(b.begin('c', 'r0')).toBe('run'); // oldest evicted
    expect(b.begin('c', `r${REPLY_MAX}`)).toEqual({ replay: { t: 'res', id: `r${REPLY_MAX}`, result: REPLY_MAX } });
    t += REPLY_TTL_MS + 1;
    expect(b.begin('c', `r${REPLY_MAX}`)).toBe('run'); // expired
  });

  test('outbox holds and drains in order; forget clears', () => {
    const b = new ReplyBook();
    b.hold('c', { t: 'res', id: '1' });
    b.hold('c', { t: 'res', id: '2' });
    expect(b.drain('c').map((m) => (m as { id: string }).id)).toEqual(['1', '2']);
    expect(b.drain('c')).toEqual([]);
    b.begin('c', 'x');
    b.finish('c', 'x', { t: 'res', id: 'x' });
    b.forget('c');
    expect(b.begin('c', 'x')).toBe('run');
  });
});

// ---- sessions.ts end to end with a fake socket, a fake site and a counting handleSiteCall ----

/**
 * Event-driven waits, no wall-clock polling: every fake socket send, new socket and wallet call pokes the waiters,
 * which re-check their condition. The only real work left is a few ECDH derivations and AES seals (milliseconds).
 */
const waiters = new Set<() => void>();
const poke = () => waiters.forEach((w) => w());
const until = (what: string, ok: () => boolean, ms = 4000) =>
  new Promise<void>((resolve, reject) => {
    if (ok()) return resolve();
    const check = () => {
      if (!ok()) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(
        new Error(`timed out waiting for: ${what} (sockets ${FakeWS.all.map((w) => w.sent.length)}, calls ${calls})`),
      );
    }, ms);
    waiters.add(check);
  });
/** Let every pending promise continuation run (one macrotask: the microtask queue drains first). */
const settle = () => new Promise<void>((r) => setImmediate(r));

let calls = 0;
let gate: Promise<void> = Promise.resolve();
mock.module('../dappBrowser', () => ({
  handleSiteCall: async () => {
    calls++;
    poke();
    await gate;
    return { success: true, data: { txid: `tx${calls}` } };
  },
}));

class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
    poke();
  }
  send(d: string) {
    this.sent.push(d);
    poke();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}
const store = new Map<string, string>();
const docListeners: Array<() => void> = [];
const doc = {
  visibilityState: 'visible',
  addEventListener: (_: string, fn: () => void) => docListeners.push(fn),
};
const g = globalThis as Record<string, unknown>;
const saved = { WebSocket: g.WebSocket, localStorage: g.localStorage, document: g.document };
afterAll(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete g[k];
    else g[k] = v;
});
Object.assign(globalThis, {
  WebSocket: FakeWS,
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
  document: doc,
});
// Load sessions.ts (and the wallet module graph behind it) here, at file load, not inside the test: a cold import
// of that graph is most of a second alone and several seconds under a busy full-suite or release-build run, and it
// was being charged to the test's 5 s budget. (Bun shares one module registry across test files, so it is cold or
// warm depending on whether relay/e2e/pair.e2e.test.ts happened to load it first.)
const { beginPairing, initPairing, forget, pairedSites, setAgentPairDeps } = await import('./sessions');
// Sessions are revived only for the account that paired them (accountBind.test.ts).
setAgentPairDeps({ ctx: undefined, currentId: '1ReplyTestAccount', accountCount: 1 });
// Leave no live socket or reconnect timer behind for later test files.
afterAll(() => {
  for (const s of pairedSites()) forget(s.c, false);
});

test('sessions: never re-runs an answered call; holds a reply while the socket is closed and sends it on reconnect', async () => {
  const site = PrivateKey.fromRandom();
  const c = 'AAAAAAAAAAAAAAAAAAAAAA';
  const url = pairUrl({
    v: PAIR_VERSION,
    r: 'relay.bwallet.space',
    c,
    k: site.toPublicKey().toString(),
    o: 'https://a.lol',
    e: Math.floor(Date.now() / 1000) + 120,
  });
  const pending = beginPairing(url);
  const ws1 = FakeWS.all.at(-1)!;
  ws1.open();
  ws1.deliver({ t: 'relay', verifiedOrigin: 'https://a.lol' });
  const p = await pending;
  const hello = JSON.parse(ws1.sent[0]) as { k: string };
  const { key } = await deriveSession(site, hello.k, c);
  const siteSealer = new Sealer(key, 'site');
  p.confirm();
  await until('ready sent', () => ws1.sent.length >= 2);
  const open = async (raw: string) => siteSealer.open(JSON.parse(raw));
  expect(await open(ws1.sent[1])).toEqual({ t: 'ready' });

  // A createAction whose answer is ready only after the phone's socket has gone (app backgrounded).
  let release!: () => void;
  gate = new Promise((r) => (release = r));
  ws1.deliver(await siteSealer.seal({ t: 'req', id: 'r1', action: 'createAction', params: {} }));
  await until('first wallet call', () => calls === 1);
  expect(calls).toBe(1);
  doc.visibilityState = 'hidden';
  ws1.close();
  release();
  // The answer is recorded and held (the socket is checked before any sealing): pure promise continuations.
  await settle();
  expect(ws1.sent.length).toBe(2); // nothing sent into a closed socket

  // Back in the foreground: reconnect, the held reply goes out.
  doc.visibilityState = 'visible';
  initPairing();
  for (const fn of docListeners) fn();
  await until('reconnect socket', () => FakeWS.all.at(-1) !== ws1);
  const ws2 = FakeWS.all.at(-1)!;
  expect(ws2).not.toBe(ws1);
  await settle();
  expect(FakeWS.all).toHaveLength(2); // initPairing + the foreground listener open ONE socket between them
  ws2.open();
  await until('held reply sent', () => ws2.sent.length >= 1);
  expect(await open(ws2.sent[0])).toEqual({ t: 'res', id: 'r1', result: { txid: 'tx1' } });

  // The site, unsure, re-sends the same request id: answered again (freshly sealed), not re-run.
  ws2.deliver(await siteSealer.seal({ t: 'req', id: 'r1', action: 'createAction', params: {} }));
  await until('replayed reply sent', () => ws2.sent.length >= 2);
  expect(calls).toBe(1);
  expect(await open(ws2.sent[1])).toEqual({ t: 'res', id: 'r1', result: { txid: 'tx1' } });
  // An old frame replayed verbatim is still refused by the site's Sealer.
  expect(await open(ws2.sent[0])).toBeNull();

  // A new id runs.
  ws2.deliver(await siteSealer.seal({ t: 'req', id: 'r2', action: 'createAction', params: {} }));
  await until('second call answered', () => ws2.sent.length >= 3);
  expect(calls).toBe(2);
  expect(await open(ws2.sent[2])).toEqual({ t: 'res', id: 'r2', result: { txid: 'tx2' } });
});
