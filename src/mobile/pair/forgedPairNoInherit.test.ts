/**
 * b-Aware report (24 Oct 2026): a second pairing that merely claimed a live pairing's origin (a forged QR; the relay's
 * Origin header is any client's choice) shared its "<host>.paired.invalid" key, so it signed and spent under the live
 * pairing's grants with no sheet. The key now names the pairing's own channel.
 * Same local setup as lapseRevoke.test.ts: fake WebSocket, in-memory grant store, throwaway keys, a .invalid host.
 */
import { describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { PAIR_VERSION, pairUrl } from '../../pair/protocol';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';

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

describe('A second pairing claiming the same origin gets nothing (b-Aware report)', () => {
  test('the forged pairing is asked again; the live pairing keeps its grants', async () => {
    clear();
    const { store, revoked } = useStore();
    const legit = 'LLLLLLLLLLLLLLLLLLLLLL';
    await pair(legit);
    const legitKey = PAIRED_KEY;
    await seedGrants(store);
    revoked.length = 0;

    const forged = 'FFFFFFFFFFFFFFFFFFFFFF';
    await pair(forged);
    expect(PAIRED_KEY).not.toBe(legitKey);
    expect(sessions.pairedSites().map((s) => s.c)).toEqual([legit, forged]);

    // The live pairing is untouched.
    expect(revoked).not.toContain(normalizeOriginator(legitKey));
    expect((await store.listGrants({ originator: legitKey })).length).toBe(2);
    // The forged one holds nothing and every signature request shows a sheet.
    expect((await store.listGrants({ originator: PAIRED_KEY })).length).toBe(0);
    await expectAskedAgain(store);

    sessions.forget(legit, false);
    sessions.forget(forged, false);
    await settle();
  });
});
