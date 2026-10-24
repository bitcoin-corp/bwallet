/**
 * b-Aware report from 0xRen (23 Oct 2026): pairing sessions survived "remove the wallet from this device" and were
 * revived for whichever wallet was restored next. Sessions are now bound to the account that paired them, and the
 * wipe closes and forgets them. Same local setup as lapseRevoke.test.ts: fake WebSocket, throwaway keys, .invalid host.
 */
import { describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { PAIR_VERSION, pairUrl } from '../../pair/protocol';
import { normalizeOriginator } from '@1sat/wallet';

mock.module('../dappBrowser', () => ({
  handleSiteCall: async () => ({ success: true, data: {} }),
}));

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send() {}
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
const g = globalThis as Record<string, unknown>;
g.WebSocket = FakeWS;
g.localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
g.document = { visibilityState: 'visible', addEventListener: () => undefined };

const sessions = await import('./sessions');
const { pairedOrigin } = await import('../../services/originKey');

const settle = () => new Promise<void>((r) => setTimeout(r, 25));
const HOST = 'https://pairtest.example';
/** The paired key of the most recent pairing (it names that pairing's channel, originKey.ts). */
let PAIRED_KEY = '';

const pair = async (channel: string) => {
  PAIRED_KEY = pairedOrigin(HOST, channel).slice('https://'.length);
  const url = pairUrl({
    v: PAIR_VERSION,
    r: 'relay.bwallet.space',
    c: channel,
    k: PrivateKey.fromRandom().toPublicKey().toString(),
    o: HOST,
    e: Math.floor(Date.now() / 1000) + 120,
  });
  const pending = sessions.beginPairing(url);
  FakeWS.all.at(-1)!.deliver({ t: 'relay', verifiedOrigin: HOST });
  (await pending).confirm();
  await settle();
};

const KEY = 'bwallet.pair.sessions';
const stored = () => JSON.parse(mem.get(KEY) ?? '[]') as Array<Record<string, unknown>>;
const A = '1AccountAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = '1AccountBBBBBBBBBBBBBBBBBBBBBBBBBB';
const as = (currentId: string | undefined, accountCount: number) =>
  sessions.setAgentPairDeps({ ctx: undefined, currentId, accountCount });
const revoked: string[] = [];
sessions.setPairRevoker(async (o) => {
  revoked.push(normalizeOriginator(o));
  return true;
});
const reset = () => {
  for (const s of FakeWS.all) s.close();
  mem.clear();
  revoked.length = 0;
  as(undefined, 0);
};
const opened = () => FakeWS.all.filter((s) => s.readyState === 1).length;

describe('Pairings are bound to the account that made them (b-Aware report)', () => {
  test('a new pairing records the open account', async () => {
    reset();
    as(A, 2);
    await pair('AAAAAAAAAAAAAAAAAAAAAA');
    expect(stored().map((s) => s.account)).toEqual([A]);
  });

  test("account B never revives account A's pairing; it is dropped and revoked", async () => {
    reset();
    as(A, 2);
    await pair('BBBBBBBBBBBBBBBBBBBBBB');
    for (const s of FakeWS.all) s.close(); // the app closes: nothing live
    as(undefined, 2);
    sessions.initPairing();
    expect(opened()).toBe(0); // nothing is revived before the open account is known

    as(B, 2);
    await settle();
    expect(opened()).toBe(0);
    expect(stored()).toEqual([]);
    expect(revoked).toContain(normalizeOriginator(PAIRED_KEY));
  });

  test("the pairing account's own sessions are revived", async () => {
    reset();
    as(A, 2);
    await pair('CCCCCCCCCCCCCCCCCCCCCC');
    for (const s of FakeWS.all) s.close();
    as(undefined, 2);
    as(A, 2);
    await settle();
    expect(opened()).toBe(1);
    expect(stored().map((s) => s.c)).toEqual(['CCCCCCCCCCCCCCCCCCCCCC']);
  });

  test('legacy sessions are adopted only when the wallet holds exactly one account', async () => {
    reset();
    as(A, 1);
    await pair('DDDDDDDDDDDDDDDDDDDDDD');
    const legacy = stored().map(({ account: _a, ...s }) => s);
    mem.set(KEY, JSON.stringify(legacy));
    expect(sessions.bindToAccount(legacy as never, A, 1).map((s) => s.account)).toEqual([A]);
    expect(sessions.bindToAccount(legacy as never, A, 2)).toEqual([]);
    expect(sessions.pairedSites().map((s) => s.account)).toEqual([A]);
    expect(stored().map((s) => s.account)).toEqual([A]);

    mem.set(KEY, JSON.stringify(legacy));
    as(B, 3);
    expect(sessions.pairedSites()).toEqual([]);
    await settle();
    expect(stored()).toEqual([]);
    expect(revoked).toContain(normalizeOriginator(PAIRED_KEY));
  });

  test('closeAllPairings closes live sockets and nothing revives afterwards', async () => {
    reset();
    as(A, 1);
    await pair('EEEEEEEEEEEEEEEEEEEEEE');
    expect(opened()).toBe(1);
    sessions.closeAllPairings();
    expect(opened()).toBe(0);
    expect(mem.has(KEY)).toBe(false);
    as(undefined, 0);
    as(A, 1);
    await settle();
    expect(opened()).toBe(0);
  });
});
