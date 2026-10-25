import { beforeEach, describe, expect, it } from 'bun:test';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

// A Map-backed localStorage (bun has none), installed before the module loads.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const { NEW_ACCOUNT, bindSocial, clearSocial, socialProfile, socialProof, webReturnKey } =
  await import('./socialLogin');

const KEY = 'bwallet.social';
const A = '1AccountAaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '1AccountBbbbbbbbbbbbbbbbbbbbbbbbbb';
const profile = { provider: 'x', name: 'someone', alias: 'someone.x', avatar: 'https://pbs.twimg.com/a.jpg' };
const pending = (owner?: string, at = Date.now()) =>
  store.set(KEY, JSON.stringify({ provider: 'x', secret: 's', at, ticket: 't', profile, ...(owner ? { owner } : {}) }));

beforeEach(() => store.clear());

describe('social sign-in is per account', () => {
  it('a sign-in started on Create Account is shown there, and to no account', () => {
    pending(NEW_ACCOUNT);
    expect(socialProfile()?.avatar).toBe(profile.avatar);
    expect(socialProfile(A)).toBeNull();
    expect(socialProof(A)).toBeNull();
  });

  it("another account's sign-in never pre-fills Create Account (photo carry-over)", () => {
    pending(A);
    expect(socialProfile()).toBeNull();
    expect(socialProfile(NEW_ACCOUNT)).toBeNull();
    expect(socialProfile(B)).toBeNull();
    expect(socialProof(A)?.ticket).toBe('t');
  });

  it('once the account exists, its sign-in moves to it and leaves Create Account empty', () => {
    pending(NEW_ACCOUNT);
    bindSocial(A);
    expect(socialProfile()).toBeNull();
    expect(socialProof(A)?.profile.alias).toBe('someone.x');
    expect(socialProof(B)).toBeNull();
  });

  it("binding never takes over another account's sign-in", () => {
    pending(A);
    bindSocial(B);
    expect(socialProof(B)).toBeNull();
    expect(socialProof(A)).not.toBeNull();
  });

  it('a global leftover (no owner, from before this fix) is dropped', () => {
    pending(undefined);
    expect(socialProfile()).toBeNull();
    expect(socialProfile(A)).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });

  it('an expired sign-in is dropped', () => {
    pending(NEW_ACCOUNT, Date.now() - 11 * 60_000);
    expect(socialProfile()).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });

  it('Remove clears it', () => {
    pending(NEW_ACCOUNT);
    clearSocial();
    expect(socialProfile()).toBeNull();
  });
});

describe('back from X with an existing (locked) wallet', () => {
  it('Connect reopens once for that account, after unlock; Create Account never does', async () => {
    const { socialReturnWaiting, takeSocialReturn } = await import('./socialLogin');
    store.set(
      KEY,
      JSON.stringify({ provider: 'x', secret: 's', at: Date.now(), ticket: 't', profile, owner: A, returned: true }),
    );
    expect(socialReturnWaiting(B)).toBe(false);
    expect(socialReturnWaiting(A)).toBe(true);
    expect(takeSocialReturn(A)).toBe(true);
    // One trip: the profile stays for Connect to claim, but it won't send the user round again.
    expect(takeSocialReturn(A)).toBe(false);
    expect(socialProof(A)?.ticket).toBe('t');
    store.set(
      KEY,
      JSON.stringify({
        provider: 'x',
        secret: 's',
        at: Date.now(),
        ticket: 't',
        profile,
        owner: NEW_ACCOUNT,
        returned: true,
      }),
    );
    expect(takeSocialReturn(NEW_ACCOUNT)).toBe(false);
  });

  it('the return only stores the ticket: it never touches the wallet keys', async () => {
    const { receiveSocialUrl } = await import('./socialLogin');
    const wallet = 'secure:chrome.storage.local:accounts';
    store.set(wallet, '{"A":{"encryptedKeys":"ciphertext"}}');
    store.set(KEY, JSON.stringify({ provider: 'x', secret: 's', at: Date.now(), owner: A }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(profile), { status: 200 })) as unknown as typeof fetch;
    try {
      await receiveSocialUrl('https://web.bwalletx.com/#t=ticket1');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(store.get(wallet)).toContain('ciphertext');
    const p = JSON.parse(store.get(KEY)!);
    expect(p.ticket).toBe('ticket1');
    expect(p.returned).toBe(true);
    expect(p.owner).toBe(A);
  });
});

describe('webReturnKey', () => {
  it('Desktop comes back to Desktop, not the web wallet', () => {
    expect(webReturnKey('https://desktop.bwalletx.com')).toBe('desktop');
    expect(webReturnKey('https://beta.bwalletx.com')).toBe('beta');
    expect(webReturnKey('https://web.bwalletx.com')).toBe('web');
    expect(webReturnKey('http://localhost:4310')).toBe('web');
  });
});
