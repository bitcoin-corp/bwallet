import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { PAIR_PROOF_PATH, pairUrl, parsePairUrl, signPairProof, verifyPairProof, type PairLink } from './protocol';

const O = 'https://www.tokenblaster.lol';
const siteKey = PrivateKey.fromRandom();
const link = (over: Partial<PairLink> = {}): PairLink => ({
  v: '1',
  r: 'relay.bwallet.space',
  c: 'AAAAAAAAAAAAAAAAAAAAAA',
  k: PrivateKey.fromRandom().toPublicKey().toString(),
  o: O,
  e: Math.floor(Date.now() / 1000) + 100,
  ...over,
});
const wellKnown = (keys: string[]) =>
  (async (url: string) => {
    expect(url).toBe(`${O}${PAIR_PROOF_PATH}`);
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as unknown as typeof fetch;

describe('pairing origin proof', () => {
  test('a link signed with a key the origin publishes is proven, and survives the QR round trip', async () => {
    const l = link();
    l.s = signPairProof(l, siteKey);
    const parsed = parsePairUrl(pairUrl(l));
    expect(parsed.s).toBe(l.s);
    expect(await verifyPairProof(parsed, wellKnown([siteKey.toPublicKey().toString()]))).toBe(true);
  });

  test('ATTACK: a forger claiming the origin without its key is not proven', async () => {
    const l = link();
    l.s = signPairProof(l, PrivateKey.fromRandom());
    expect(await verifyPairProof(l, wellKnown([siteKey.toPublicKey().toString()]))).toBe(false);
    expect(await verifyPairProof(link(), wellKnown([siteKey.toPublicKey().toString()]))).toBe(false);
  });

  test('ATTACK: a real proof replayed onto another channel or key is not proven', async () => {
    const real = link();
    real.s = signPairProof(real, siteKey);
    const replay = link({ s: real.s, c: 'BBBBBBBBBBBBBBBBBBBBBB' });
    const otherKey = { ...real, k: PrivateKey.fromRandom().toPublicKey().toString() };
    const keys = wellKnown([siteKey.toPublicKey().toString()]);
    expect(await verifyPairProof(replay, keys)).toBe(false);
    expect(await verifyPairProof(otherKey, keys)).toBe(false);
  });

  test('no file, a redirect, or junk: not proven', async () => {
    const l = link();
    l.s = signPairProof(l, siteKey);
    const none = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const redirect = (async () => {
      throw new TypeError('redirect');
    }) as unknown as typeof fetch;
    const junk = (async () => new Response('nope', { status: 200 })) as unknown as typeof fetch;
    for (const f of [none, redirect, junk]) expect(await verifyPairProof(l, f)).toBe(false);
  });
});
