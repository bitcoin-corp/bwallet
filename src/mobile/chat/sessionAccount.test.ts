import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { BchatClient, loadSession, saveSession, setChatAccount, type Http } from './api';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

// Minimal localStorage for bun.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const A = '1AccountGmailxxxxxxxxxxxxxxxxxxxx';
const B = '1AccountXxxxxxxxxxxxxxxxxxxxxxxxx';

describe('bit-sign session follows the ACTIVE wallet account', () => {
  beforeEach(() => {
    store.clear();
    setChatAccount(null);
  });
  afterAll(() => setChatAccount(null));

  test('a session saved by one account is not loaded by another', () => {
    setChatAccount(B);
    saveSession({ token: 'tok-b0asex', handle: 'b0asex', address: 'addrB' });
    expect(loadSession()?.handle).toBe('b0asex');
    setChatAccount(A);
    expect(loadSession()).toBeNull();
    saveSession({ token: 'tok-gmail', handle: 'richardwboase', address: 'addrA' });
    expect(loadSession()?.handle).toBe('richardwboase');
    setChatAccount(B);
    expect(loadSession()?.handle).toBe('b0asex');
  });

  test('the old global session (pre-fix) is dropped, never reused', () => {
    store.set('bwallet.bchat.session', JSON.stringify({ token: 't', handle: 'b0asex', address: 'x' }));
    setChatAccount(A);
    expect(loadSession()).toBeNull();
    expect(store.has('bwallet.bchat.session')).toBe(false);
  });

  test('no active account: nothing loads, nothing is stored', () => {
    saveSession({ token: 't', handle: 'h', address: 'a' });
    expect(store.size).toBe(0);
    expect(loadSession()).toBeNull();
  });

  test('a client holding another account’s session refuses to send it after a switch', async () => {
    setChatAccount(B);
    const seen: (string | undefined)[] = [];
    const http: Http = async (req) => {
      seen.push(req.headers.Authorization);
      return { status: 200, data: { rooms: [] } };
    };
    const client = new BchatClient(http, { token: 'tok-b0asex', handle: 'b0asex', address: 'x', account: B });
    await client.rooms();
    expect(seen).toEqual(['Bearer tok-b0asex']);
    setChatAccount(A);
    await expect(client.rooms()).rejects.toMatchObject({ status: 401 });
    expect(seen.length).toBe(1);
    expect(client.handle).toBeNull();
  });
});
