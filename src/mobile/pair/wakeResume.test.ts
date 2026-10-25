/**
 * Owner, 25 Oct 2026: paired to tokenblaster.lol, the phone slept, and after unlock every connect failed with
 * "Permission denied." Two causes, both covered here:
 *  - the background (a worker on the phone, no localStorage) could not see the pairing, so every Allow became a
 *    denial; the page now mirrors the guard's fields into chrome.storage.local;
 *  - a socket that survived sleep "OPEN" but dead was kept; waking now opens a fresh one.
 * A pairing that has really ended answers REPAIR_NEEDED, never "Permission denied.", and a forged second pairing
 * still gets nothing (#80). Same local setup as lapseRevoke.test.ts: fake WebSocket, throwaway keys, .invalid host.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { PAIR_VERSION, Sealer, deriveSession, pairUrl, type PairMessage } from '../../pair/protocol';
import { keepGlobals, stubGlobals } from '../../testing/stubGlobals';

let siteCall: () => Promise<unknown> = async () => ({ success: true, data: { publicKey: '02ab' } });
// Keep the real exports: bun module mocks are process-wide, and a partial mock breaks later files (lapseRevoke.test.ts).
const realDappBrowser = { ...(await import('../dappBrowser')) };
mock.module('../dappBrowser', () => ({ ...realDappBrowser, handleSiteCall: () => siteCall() }));

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = 1;
  sent: string[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
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

const mem = new Map<string, string>();
const chromeLocal = new Map<string, unknown>();
let visibility = 'visible';
const g = globalThis as Record<string, unknown>;
// Restored when this file finishes: a leaked document/localStorage broke the theme and pageHidden tests.
stubGlobals({
  WebSocket: FakeWS,
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
  document: {
    get visibilityState() {
      return visibility;
    },
    addEventListener: () => undefined,
  },
  chrome: {
    storage: {
      local: {
        set: async (v: Record<string, unknown>) => {
          for (const [k, x] of Object.entries(v)) chromeLocal.set(k, x);
        },
      },
    },
  },
});
// The first test deletes and puts back localStorage; make sure the stub is what comes back even if it throws.
keepGlobals('localStorage');

// A private copy of sessions.ts (see lapseRevoke.test.ts): its started flag, live sockets, hiddenAt and mirror cache
// would otherwise carry over from whichever pair test ran first.
const sessions = (await import('./sessions?wakeResume' as string)) as typeof import('./sessions');
const guard = await import('../../services/pairedPromptGuard');
const { pairedOrigin } = await import('../../services/originKey');

const settle = () => new Promise<void>((r) => setTimeout(r, 25));
const HOST = 'https://pairtest.example';
const KEY = 'bwallet.pair.sessions';
const ACCOUNT = '1AccountAAAAAAAAAAAAAAAAAAAAAAAAAA';
sessions.setPairRevoker(async () => true);
sessions.setAgentPairDeps({ ctx: undefined, currentId: ACCOUNT, accountCount: 1 });

/** Pair like the site does; returns the site's sealer to talk to the phone. */
const pair = async (channel: string) => {
  const siteKey = PrivateKey.fromRandom();
  const pending = sessions.beginPairing(
    pairUrl({
      v: PAIR_VERSION,
      r: 'relay.bwallet.space',
      c: channel,
      k: siteKey.toPublicKey().toString(),
      o: HOST,
      e: Math.floor(Date.now() / 1000) + 120,
    }),
  );
  const ws = FakeWS.all.at(-1)!;
  ws.deliver({ t: 'relay', verifiedOrigin: HOST });
  (await pending).confirm();
  await settle();
  const hello = JSON.parse(ws.sent[0]) as { k: string };
  const { key } = await deriveSession(siteKey, hello.k, channel);
  return { site: new Sealer(key, 'site'), phone: new Sealer(key, 'site') };
};
/** Everything the phone sent on a socket, opened with a fresh reader (counters start at 0 per reader). */
const readAll = async (key: Sealer, ws: FakeWS): Promise<PairMessage[]> => {
  const out: PairMessage[] = [];
  for (const raw of ws.sent) {
    const f = JSON.parse(raw);
    if (!('s' in f)) continue;
    const m = await key.open(f);
    if (m) out.push(m);
  }
  return out;
};
let reqN = 0;
const ask = async (site: Sealer, ws: FakeWS) => {
  const id = `r${++reqN}`;
  ws.deliver(await site.seal({ t: 'req', id, action: 'getPublicKey', params: { identityKey: true } }));
  await settle();
  return id;
};

describe('phone pairing after the phone sleeps', () => {
  test('the background sees the pairing through the mirror (no localStorage in the worker)', async () => {
    await pair('WAKEAAAAAAAAAAAAAAAAAA');
    const mirror = chromeLocal.get(guard.PAIR_MIRROR_KEY) as Array<Record<string, unknown>>;
    expect(mirror.map((m) => m.c)).toContain('WAKEAAAAAAAAAAAAAAAAAA');
    expect(JSON.stringify(mirror)).not.toContain('phoneKey');
    // As the worker does: no localStorage, mirror set from chrome.storage.local.
    const ls = g.localStorage;
    delete g.localStorage;
    try {
      guard.setPairMirror(mirror);
      expect(guard.pairedGrantAllowed(pairedOrigin(HOST, 'WAKEAAAAAAAAAAAAAAAAAA'))).toBe(true);
      // #80: a forged second pairing claiming the same host never inherits this pairing's grants.
      expect(guard.pairedGrantAllowed(pairedOrigin(HOST, 'FORGEDAAAAAAAAAAAAAAAA'))).toBe(false);
    } finally {
      guard.setPairMirror([]);
      g.localStorage = ls;
    }
  });

  test('resume after sleep with a valid session: fresh socket, call answered, no re-approval', async () => {
    const { site, phone } = await pair('WAKEBBBBBBBBBBBBBBBBBB');
    const before = FakeWS.all.at(-1)!;
    visibility = 'hidden';
    sessions.onPairVisibility();
    const realNow = Date.now;
    Date.now = () => realNow() + sessions.WAKE_MS + 60_000;
    try {
      visibility = 'visible';
      sessions.onPairVisibility();
      await settle();
    } finally {
      Date.now = realNow;
    }
    // The old socket still said OPEN (iOS after sleep); it was replaced anyway. Waking reopens every pairing still
    // held (earlier tests' too, in any order), so look up this channel's newest socket rather than the last one opened.
    const after = FakeWS.all.findLast((w) => w.url.includes('/v1/c/WAKEBBBBBBBBBBBBBBBBBB'))!;
    expect(after).not.toBe(before);
    expect(after.url).toContain('/v1/c/WAKEBBBBBBBBBBBBBBBBBB');
    await settle();
    // The rejoin announces itself so the site resends.
    expect((await readAll(phone, after)).map((m) => m.t)).toContain('ready');
    const id = await ask(site, after);
    const res = (await readAll(phone, after)).find((m) => m.t === 'res' && m.id === id);
    expect(res).toEqual({ t: 'res', id, result: { publicKey: '02ab' } });
  });

  test('an expired session answers REPAIR_NEEDED and closes, never "Permission denied."', async () => {
    const { site, phone } = await pair('WAKECCCCCCCCCCCCCCCCCC');
    const ws = FakeWS.all.at(-1)!;
    const all = JSON.parse(mem.get(KEY)!) as Array<{ c: string; lastUsed: number }>;
    mem.set(
      KEY,
      JSON.stringify(
        all.map((s) => (s.c === 'WAKECCCCCCCCCCCCCCCCCC' ? { ...s, lastUsed: Date.now() - 25 * 3600_000 } : s)),
      ),
    );
    const id = await ask(site, ws);
    const msgs = await readAll(phone, ws);
    expect(msgs.find((m) => m.t === 'res' && m.id === id)).toEqual({
      t: 'res',
      id,
      error: { code: sessions.REPAIR_NEEDED_CODE, message: sessions.REPAIR_NEEDED_MESSAGE },
    });
    expect(msgs.some((m) => m.t === 'close' && m.reason === 'REPAIR_NEEDED')).toBe(true);
    expect(ws.readyState).toBe(3);
    expect(sessions.pairedSites().some((s) => s.c === 'WAKECCCCCCCCCCCCCCCCCC')).toBe(false);
  });

  afterAll(() => {
    for (const s of sessions.pairedSites()) sessions.forget(s.c, false);
  });

  test('a real No from the user is still ERR_PERMISSION_DENIED', async () => {
    const { site, phone } = await pair('WAKEDDDDDDDDDDDDDDDDDD');
    const ws = FakeWS.all.at(-1)!;
    siteCall = async () => ({ success: false, error: 'Permission denied.', code: 'ERR_PERMISSION_DENIED' });
    try {
      const id = await ask(site, ws);
      const res = (await readAll(phone, ws)).find((m) => m.t === 'res' && m.id === id);
      expect(res).toEqual({ t: 'res', id, error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission denied.' } });
    } finally {
      siteCall = async () => ({ success: true, data: { publicKey: '02ab' } });
    }
  });
});
