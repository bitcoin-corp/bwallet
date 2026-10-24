/**
 * b-Aware report (23 Oct 2026): Disconnect removed the pairing but kept the grants and the monthly allowance
 * written under "<host>.paired.invalid", so the next pairing reporting the same host signed and spent with no sheet.
 * Adapted from the reporter's PoC. Local only: fake WebSocket, in-memory grant store, throwaway keys, a .invalid host.
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

describe('Disconnect withdraws the paired grants (b-Aware report)', () => {
  test('forget() revokes the paired key: no grant, no allowance, the next pairing is asked again', async () => {
    const store = new InMemoryPermissionStore();
    const revoked: string[] = [];
    sessions.setPairRevoker(async (o) => {
      revoked.push(o);
      await manager(store).mgr.revokeAllForOriginator(o);
      return true;
    });
    const channel = 'BBBBBBBBBBBBBBBBBBBBBB';
    await pair(channel);
    await grantSignIn(store);
    await store.putGrant({
      key: { type: 'spending', originator: normalizeOriginator(PAIRED_KEY) },
      expiry: 0,
      grantedAt: Date.now(),
      authorizedAmount: 5_000_000,
      reason: 'Up to $5 a month without asking',
    } as never);

    sessions.forget(channel, false);
    await settle();

    expect(sessions.pairedSites().map((s) => s.c)).not.toContain(channel);
    expect(revoked.map(normalizeOriginator)).toContain(normalizeOriginator(PAIRED_KEY));
    expect((await store.listGrants({ originator: PAIRED_KEY })).length).toBe(0);

    // A second pairing reporting the same host gets a sheet again.
    await pair('CCCCCCCCCCCCCCCCCCCCCC');
    const second = manager(store);
    const asked = second.mgr.createSignature(signIn as never, PAIRED_KEY);
    asked.catch(() => undefined);
    const outcome = await Promise.race([
      asked.then(() => 'allowed'),
      new Promise((r) => setTimeout(() => r('pending'), 300)),
    ]);
    expect(outcome).toBe('pending');
    expect(second.prompts()).toBe(1);
  });

  test('a revoke that cannot run yet is queued and retried, never dropped', async () => {
    let up = false;
    const done: string[] = [];
    sessions.setPairRevoker(async (o) => {
      if (!up) return false;
      done.push(o);
      return true;
    });
    const channel = 'DDDDDDDDDDDDDDDDDDDDDD';
    await pair(channel);
    sessions.forget(channel, false);
    await settle();
    expect(done).toEqual([]);
    expect(localStorage.getItem('bwallet.pair.revokeQueue')).toContain(PAIRED_KEY);

    up = true;
    await sessions.flushRevocations();
    expect(done.map(normalizeOriginator)).toContain(normalizeOriginator(PAIRED_KEY));
    expect(localStorage.getItem('bwallet.pair.revokeQueue')).toBeNull();
  });
});
