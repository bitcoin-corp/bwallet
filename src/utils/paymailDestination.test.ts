import { describe, expect, test } from 'bun:test';
import { KeyDeriver, P2PKH, PrivateKey, ProtoWallet, Random, Utils } from '@bsv/sdk';
import { brc29Script, checkP2pDestination } from './paymailDestination';
import { checkOrdProof, destinationCheck, NOT_VERIFIED_NOTE } from '../mobile/names/names';
import { signOrdProof } from '../mobile/names/paymail';

const payee = PrivateKey.fromRandom();
const KEY = payee.toPublicKey().toString();
/** What site/lib/paymail.js deriveDestination returns. */
const serverOutput = (identityKey = KEY, satoshis = 1000) => {
  const derivationPrefix = Utils.toBase64(Random(16));
  const derivationSuffix = Utils.toBase64(Random(16));
  const pub = new KeyDeriver(new PrivateKey(1)).derivePublicKey(
    [2, '3241645161d8'],
    `${derivationPrefix} ${derivationSuffix}`,
    identityKey,
    false,
  );
  return { script: new P2PKH().lock(pub.toAddress()).toHex(), satoshis, derivationPrefix, derivationSuffix };
};

describe('checkP2pDestination (b_feedback 67)', () => {
  test('a script derived from the payee key passes, and only the payee can spend it', () => {
    const o = serverOutput();
    expect(checkP2pDestination(KEY, [o])).toEqual({ ok: true, verified: true });
    // The payee's own derivation (counterparty = anyone) gives the same script.
    const own = new KeyDeriver(payee).derivePublicKey(
      [2, '3241645161d8'],
      `${o.derivationPrefix} ${o.derivationSuffix}`,
      'anyone',
      true,
    );
    expect(new P2PKH().lock(own.toAddress()).toHex()).toBe(o.script);
    expect(brc29Script(KEY, o.derivationPrefix, o.derivationSuffix)).toBe(o.script);
  });

  test('a tampered script is refused', () => {
    const o = { ...serverOutput(), script: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex() };
    const r = checkP2pDestination(KEY, [o]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('does not belong to the payee');
  });

  test("a script derived from someone else's key is refused", () => {
    const o = serverOutput(PrivateKey.fromRandom().toPublicKey().toString());
    expect(checkP2pDestination(KEY, [o]).ok).toBe(false);
  });

  test('no derivation at all: allowed but not verified; partial derivation or no key: refused', () => {
    const { script, satoshis } = serverOutput();
    expect(checkP2pDestination(KEY, [{ script, satoshis }])).toEqual({ ok: true, verified: false });
    expect(checkP2pDestination(KEY, [serverOutput(), { script, satoshis }]).ok).toBe(false);
    expect(checkP2pDestination(undefined, [serverOutput()]).ok).toBe(false);
    expect(checkP2pDestination(KEY, []).ok).toBe(false);
  });
});

describe('pay sheet note and ord_address proof', () => {
  test('missing derivation (third-party host) shows the not-verified note; our host does not', () => {
    expect(destinationCheck({ via: 'p2p-paymail', external: 'handcash.io' }, 'bsv')).toBe('unverified');
    expect(destinationCheck({ via: 'paymail-address', external: 'x.io' }, 'bsv')).toBe('unverified');
    expect(destinationCheck({ via: 'p2p-paymail' }, 'bsv')).toBe('verified');
    expect(destinationCheck({ via: 'address' }, 'bsv')).toBeNull();
    expect(NOT_VERIFIED_NOTE).toContain('Not verified');
  });

  test('ord_address is checked against the payee key', async () => {
    const ord = PrivateKey.fromRandom().toAddress();
    const proof = await signOrdProof(new ProtoWallet(payee), ord);
    expect(await checkOrdProof(KEY, ord, proof)).toBe('ok');
    // Swapped address, or signed by another key: bad.
    expect(await checkOrdProof(KEY, PrivateKey.fromRandom().toAddress(), proof)).toBe('bad');
    const other = await signOrdProof(new ProtoWallet(PrivateKey.fromRandom()), ord);
    expect(await checkOrdProof(KEY, ord, other)).toBe('bad');
    expect(destinationCheck({ via: 'p2p-paymail', ordVerified: true }, 'token')).toBe('verified');
    expect(destinationCheck({ via: 'p2p-paymail', ordVerified: false }, 'token')).toBe('unverified');
  });
});
