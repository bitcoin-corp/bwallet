import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { getKeys } from '../../utils/keys';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const realConfig = { ...(await import('../names/config')) };
mock.module('../names/config', () => ({ ...realConfig, BWALLET_PAYMAIL_DOMAIN: 'bwalletx.com' }));
// A pending Continue with X sign-in for the account being restored (real socialLogin, no module mock, so
// the other social tests in this process see the real module).
const ls = new Map<string, string>();
(globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage = {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, String(v)),
  removeItem: (k: string) => void ls.delete(k),
};
const pendingSignIn = () =>
  ls.set(
    'bwallet.social',
    JSON.stringify({ provider: 'x', secret: 's', at: Date.now(), owner: 'new', profile: { alias: 'someone.x' } }),
  );
const { checkRestoreMatchesName } = await import('./restoreGuard');

// Throwaway test phrases (BIP39 test vectors), never real wallets.
const OWNER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const realFetch = globalThis.fetch;
const serve = (pki: Response) =>
  (globalThis.fetch = (async (u: string) =>
    u.includes('.well-known/bsvalias')
      ? new Response(JSON.stringify({ capabilities: { pki: 'https://pay.test/id/{alias}@{domain.tld}' } }))
      : u.startsWith('https://pay.test/id/')
        ? pki
        : new Response('{}')) as typeof fetch);

beforeEach(pendingSignIn);
afterEach(() => (globalThis.fetch = realFetch));

describe('checkRestoreMatchesName', () => {
  it('lets the owning phrase through', async () => {
    serve(new Response(JSON.stringify({ pubkey: getKeys(OWNER).identityPubKey })));
    expect(await checkRestoreMatchesName(OWNER, null, null, null)).toBe('');
  });
  it("refuses another wallet's phrase", async () => {
    serve(new Response(JSON.stringify({ pubkey: getKeys(OWNER).identityPubKey })));
    expect(await checkRestoreMatchesName(OTHER, null, null, null)).toMatch(/aren't the wallet that owns someone\.x/);
  });
  it('lets any phrase through when the name is free', async () => {
    serve(new Response('{"error":"not-found"}', { status: 404 }));
    expect(await checkRestoreMatchesName(OTHER, null, null, null)).toBe('');
  });
  it('fails closed when the lookup errors', async () => {
    serve(new Response('down', { status: 502 }));
    await expect(checkRestoreMatchesName(OWNER, null, null, null)).rejects.toThrow(/Couldn't check/);
  });
});
