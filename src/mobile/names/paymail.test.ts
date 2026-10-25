import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
// The server module (CommonJS, site/lib) — the wallet's signatures must verify there.
import server from '../../../site/lib/paymail.js';
import {
  nameChangeBlocked,
  paymailAvailability,
  paymailAvailable,
  signRequest,
  signedMessage,
  toAlias,
  PAYMAIL_ALIAS_RE,
} from './paymail';
import { ownedFromOutputs, payableLabel, pickName } from './accountName';
import type { WalletOutput } from '@bsv/sdk';

describe('paymail client ↔ server', () => {
  test('canonical message is identical on both sides', () => {
    const f = { alias: 'a', identityKey: '02ab', timestamp: '1' };
    expect(signedMessage('register', f)).toBe(server.signedMessage('register', f));
  });

  test('a wallet-signed register request verifies on the server; tampering fails', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const body = await signRequest(wallet, 'register', {
      alias: 'satchmo',
      ordAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    });
    expect(await server.verifySigned(body, 'register')).toBeNull();
    expect(await server.verifySigned({ ...body, fields: { alias: 'other' } }, 'register')).toBe('Bad signature');
    expect(await server.verifySigned(body, 'inbox')).toBe('Bad signature');
  });

  test('aliases', () => {
    expect(toAlias(' Testy Tester! ')).toBe('testytester');
    expect(PAYMAIL_ALIAS_RE.test('testytester')).toBe(true);
    expect(PAYMAIL_ALIAS_RE.test('-x')).toBe(false);
  });
});

describe('account names', () => {
  const out = (tags: string[]): WalletOutput =>
    ({ outpoint: `${'a'.repeat(64)}.0`, satoshis: 1, spendable: true, tags }) as WalletOutput;

  test('owned names from the opns basket (bound wins over unbound duplicates)', () => {
    const owned = ownedFromOutputs([
      out(['opns', 'name:bob', 'id:x_2']),
      out(['opns', 'name:alice', 'id:y_0', 'opns:published']),
      out(['opns', 'name:bob', 'id:z_0', 'opns:published']),
    ]);
    expect(owned).toEqual([
      { name: 'alice', id: 'y_0', published: true },
      { name: 'bob', id: 'z_0', published: true },
    ]);
  });

  test('pickName: keep owned choice, else single bound, else single owned, else let the user pick', () => {
    const a = { name: 'a', id: '1', published: false };
    const b = { name: 'b', id: '2', published: true };
    const c = { name: 'c', id: '3', published: false };
    expect(pickName([a, b], 'a')).toBe('a');
    expect(pickName([a, b], '')).toBe('b');
    expect(pickName([a], 'stale')).toBe('a');
    expect(pickName([a, c], '')).toBe('');
    expect(pickName([], 'stale')).toBe('');
  });

  test('payable label', () => {
    expect(payableLabel('Testytester', '', 'testytester@bwallet-nine.vercel.app')).toBe(
      'Testytester · testytester@bwallet-nine.vercel.app',
    );
    expect(payableLabel('satchmo', 'satchmo', '')).toBe('satchmo');
    expect(payableLabel('Account 1', '', '')).toBe('Account 1');
  });
});

describe('verified social names', () => {
  test('only *.x and *.gmail', async () => {
    const { SOCIAL_ALIAS_RE } = await import('./paymail');
    expect(SOCIAL_ALIAS_RE.test('b0asex.x')).toBe(true);
    expect(SOCIAL_ALIAS_RE.test('theirname.gmail')).toBe(true);
    expect(SOCIAL_ALIAS_RE.test('evil.com')).toBe(false);
    expect(SOCIAL_ALIAS_RE.test('.x')).toBe(false);
  });
  test('the token keeps the plain ticker', async () => {
    const { personalTicker } = await import('./personalToken');
    expect(personalTicker('b0asex.x')).toBe('B0ASEX');
    expect(personalTicker('theirname.gmail@bwalletx.com')).toBe('THEIRNAME');
    expect(personalTicker('boase')).toBe('BOASE');
  });
});

describe('nameChangeBlocked', () => {
  test('a verified X / Google name may switch to a chosen plain handle; new .x / .gmail names are refused', () => {
    expect(nameChangeBlocked('b0asex.x@bwallet.space', 'b0ase')).toBeNull();
    expect(nameChangeBlocked('me.gmail@bwallet.space', 'me')).toBeNull();
    expect(nameChangeBlocked('boase@bwallet.space', 'someone.gmail')).toMatch(/plain handle/);
    expect(nameChangeBlocked(undefined, 'b0asex.x')).toMatch(/plain handle/);
  });
  test('lets a plain name rename, and allows no-change or a first claim', () => {
    expect(nameChangeBlocked('boase@bwallet.space', 'b0ase')).toBeNull();
    expect(nameChangeBlocked(undefined, 'b0ase')).toBeNull();
    expect(nameChangeBlocked('b0asex.x@bwallet.space', 'b0asex.x')).toBeNull();
  });
});

describe('claim screen availability uses the server rules', () => {
  // A fetch that answers from the real server handlers (empty store).
  const store = { getAlias: async () => null, getForward: async () => null };
  const h = server.makeHandlers({ store, env: { PAYMAIL_DOMAIN: 'pay.test' } });
  const f = async (url: string) => {
    const u = new URL(url, 'https://x');
    const [status, body] = await h.available(Object.fromEntries(u.searchParams));
    return new Response(JSON.stringify(body), { status });
  };
  test('a reserved alias shows Reserved, never Available', async () => {
    const a = await paymailAvailability(f as never, 'bwalletx', '02' + '1'.repeat(64));
    expect(a.state).toBe('reserved');
    expect(a.message).toContain('bWalletX team');
    expect(await paymailAvailable(f as never, 'bwalletx')).toBe(false);
  });
  test('the brand key sees it as free; an ordinary name is free', async () => {
    expect((await paymailAvailability(f as never, 'bwalletx', server.RESERVED_OWNERS.bwalletx)).state).toBe('free');
    expect((await paymailAvailability(f as never, 'somebody', '02' + '1'.repeat(64))).state).toBe('free');
  });
  test('an older server without the op falls back to pki', async () => {
    const old = async () => new Response('{}', { status: 404 });
    expect((await paymailAvailability(old as never, 'x1')).state).toBe('free');
  });
});
