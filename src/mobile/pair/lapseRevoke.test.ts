/**
 * b-Aware report (23 Oct 2026): a paired session that lapsed without Disconnect (24 h idle, agent expiry, unpinned
 * relay) kept the grants under "<host>.paired.invalid", and the next pairing for that host inherited them.
 * Same local setup as disconnectRevoke.test.ts: fake WebSocket, in-memory grant store, throwaway keys, a .invalid host.
 */
import { describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { PAIR_VERSION, pairUrl } from '../../pair/protocol';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import { stubGlobals } from '../../testing/stubGlobals';

// Keep the real exports: bun module mocks are process-wide, and a partial mock left behind breaks later files that
// import other names from it (openDappBrowser). Only handleSiteCall is replaced; no other test calls it.
const realDappBrowser = { ...(await import('../dappBrowser')) };
mock.module('../dappBrowser', () => ({
  ...realDappBrowser,
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
stubGlobals({
  WebSocket: FakeWS,
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
  document: { visibilityState: 'visible', addEventListener: () => undefined },
});

// A private copy of sessions.ts for this file: bun shares one module registry across test files, and its
// started flag, live sockets and document listener would otherwise carry over from whichever pair test ran first.
const sessions = (await import('./sessions?lapseRevoke' as string)) as typeof import('./sessions');
const { pairedOrigin } = await import('../../services/originKey');

const settle = () => new Promise<void>((r) => setTimeout(r, 25));
const HOST = 'https://pairtest.example';
/** The paired key of the most recent pairing (it names that pairing's channel, originKey.ts). */
let PAIRED_KEY = '';
const signIn = { data: [1], protocolID: [2, 'bwallet sign in'], keyID: 'n', counterparty: 'anyone' };

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

const grantSignIn = (s: InMemoryPermissionStore) =>
  s.putGrant({
    key: {
      type: 'protocol',
      originator: normalizeOriginator(PAIRED_KEY),
      privileged: false,
      protocolLevel: 2,
      protocolName: 'bwallet sign in',
      counterparty: 'anyone',
    },
    expiry: 0,
    grantedAt: Date.now(),
    reason: 'Sign in with bWalletX',
  } as never);

const manager = (s: InMemoryPermissionStore) => {
  let prompts = 0;
  const w = {
    createSignature: async () => ({ signature: [1] }),
    getPublicKey: async () => ({ publicKey: '02' + '11'.repeat(32) }),
    listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
    listActions: async () => ({ actions: [], totalActions: 0 }),
  };
  const mgr = new LocalWalletPermissionsManager(w as never, 'wallet-admin-id', {}, { store: s } as never);
  mgr.bindCallback('onProtocolPermissionRequested', (async () => {
    prompts++;
  }) as never);
  return { mgr, prompts: () => prompts };
};

const KEY = 'bwallet.pair.sessions';
const DAY = 24 * 60 * 60 * 1000;
const stored = () => JSON.parse(mem.get(KEY) ?? '[]') as Array<Record<string, unknown>>;
const edit = (c: string, patch: Record<string, unknown>) =>
  mem.set(KEY, JSON.stringify(stored().map((s) => (s.c === c ? { ...s, ...patch } : s))));

const seedGrants = async (s: InMemoryPermissionStore) => {
  await grantSignIn(s);
  await s.putGrant({
    key: { type: 'spending', originator: normalizeOriginator(PAIRED_KEY) },
    expiry: 0,
    grantedAt: Date.now(),
    authorizedAmount: 4_000_000,
    reason: 'Up to $4 a month without asking',
  } as never);
};

const useStore = () => {
  const store = new InMemoryPermissionStore();
  const revoked: string[] = [];
  sessions.setPairRevoker(async (o) => {
    revoked.push(normalizeOriginator(o));
    await manager(store).mgr.revokeAllForOriginator(o);
    return true;
  });
  return { store, revoked };
};

const expectAskedAgain = async (store: InMemoryPermissionStore) => {
  const m = manager(store);
  const asked = m.mgr.createSignature(signIn as never, PAIRED_KEY);
  asked.catch(() => undefined);
  const outcome = await Promise.race([
    asked.then(() => 'allowed'),
    new Promise((r) => setTimeout(() => r('pending'), 300)),
  ]);
  expect(outcome).toBe('pending');
  expect(m.prompts()).toBe(1);
};

const clear = () => {
  mem.delete(KEY);
  mem.delete('bwallet.pair.revokeQueue');
};

describe('A lapsed pairing withdraws its grants (b-Aware report)', () => {
  test('24-hour idle expiry revokes the paired key and closes the socket', async () => {
    clear();
    const { store, revoked } = useStore();
    const channel = 'EEEEEEEEEEEEEEEEEEEEEE';
    await pair(channel);
    const socket = FakeWS.all.at(-1)!;
    await seedGrants(store);
    edit(channel, { lastUsed: Date.now() - DAY - 1000 });

    expect(sessions.pairedSites().map((s) => s.c)).not.toContain(channel);
    await settle();
    expect(stored().map((s) => s.c)).not.toContain(channel);
    expect(socket.readyState).toBe(3);
    expect(revoked).toContain(normalizeOriginator(PAIRED_KEY));
    expect((await store.listGrants({ originator: PAIRED_KEY })).length).toBe(0);

    await pair('FFFFFFFFFFFFFFFFFFFFFF');
    await expectAskedAgain(store);
  });

  test('agent session expiry revokes the paired key', async () => {
    clear();
    const { store, revoked } = useStore();
    const channel = 'GGGGGGGGGGGGGGGGGGGGGG';
    await pair(channel);
    await seedGrants(store);
    edit(channel, { agent: { expiresAt: Date.now() - 1000 } });

    expect(sessions.pairedSites().map((s) => s.c)).not.toContain(channel);
    await settle();
    expect(stored().map((s) => s.c)).not.toContain(channel);
    expect(revoked).toContain(normalizeOriginator(PAIRED_KEY));
    expect((await store.listGrants({ originator: PAIRED_KEY })).length).toBe(0);
  });

  test('dropping an unpinned relay revokes the paired key', async () => {
    clear();
    const { store, revoked } = useStore();
    const channel = 'HHHHHHHHHHHHHHHHHHHHHH';
    await pair(channel);
    await seedGrants(store);
    edit(channel, { r: 'relay.attacker.invalid' });

    expect(sessions.pairedSites().map((s) => s.c)).not.toContain(channel);
    await settle();
    expect(stored().map((s) => s.c)).not.toContain(channel);
    expect(revoked).toContain(normalizeOriginator(PAIRED_KEY));
    expect((await store.listGrants({ originator: PAIRED_KEY })).length).toBe(0);
  });

  test('a lapsed revoke that cannot run yet stays queued', async () => {
    clear();
    let up = false;
    const done: string[] = [];
    sessions.setPairRevoker(async (o) => {
      if (!up) return false;
      done.push(normalizeOriginator(o));
      return true;
    });
    const channel = 'IIIIIIIIIIIIIIIIIIIIII';
    await pair(channel);
    done.length = 0;
    edit(channel, { lastUsed: Date.now() - DAY - 1000 });
    sessions.pairedSites();
    await settle();
    expect(done).toEqual([]);
    expect(localStorage.getItem('bwallet.pair.revokeQueue')).toContain(PAIRED_KEY);
    up = true;
    await sessions.flushRevocations();
    expect(done).toContain(normalizeOriginator(PAIRED_KEY));
    expect(localStorage.getItem('bwallet.pair.revokeQueue')).toBeNull();
  });

  test('a new pairing for a host starts with no inherited grants', async () => {
    clear();
    const { store, revoked } = useStore();
    // Grants left under the paired key with no session (e.g. dropped by an older build).
    await seedGrants(store);
    await pair('JJJJJJJJJJJJJJJJJJJJJJ');
    expect(revoked).toContain(normalizeOriginator(PAIRED_KEY));
    expect((await store.listGrants({ originator: PAIRED_KEY })).length).toBe(0);
    await expectAskedAgain(store);
  });

  test('a live session keeps its grants when another pairing for the same host is made', async () => {
    clear();
    const { store, revoked } = useStore();
    await pair('KKKKKKKKKKKKKKKKKKKKKK');
    const liveKey = PAIRED_KEY;
    await seedGrants(store);
    revoked.length = 0;
    await pair('LLLLLLLLLLLLLLLLLLLLLL');
    expect(sessions.pairedSites().map((s) => s.c)).toContain('KKKKKKKKKKKKKKKKKKKKKK');
    expect(revoked).not.toContain(normalizeOriginator(liveKey));
    expect((await store.listGrants({ originator: liveKey })).length).toBe(2);
    // The new pairing has its own key and none of the live one's grants (b-Aware 24 Oct 2026).
    expect((await store.listGrants({ originator: PAIRED_KEY })).length).toBe(0);
  });
});
