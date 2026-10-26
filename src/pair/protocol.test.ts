import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import {
  Sealer,
  deriveSession,
  formatPairCode,
  isAllowedRelay,
  newChannel,
  pairProofMessageV2,
  pairUrl,
  parsePairUrl,
  relaySocketUrl,
} from './protocol';

describe('pairing protocol', () => {
  test('both sides derive the same key and code; frames round-trip', async () => {
    const c = newChannel();
    const S = PrivateKey.fromRandom();
    const P = PrivateKey.fromRandom();
    const site = await deriveSession(S, P.toPublicKey().toString(), c);
    const phone = await deriveSession(P, S.toPublicKey().toString(), c);
    expect(site.code).toMatch(/^\d{4}$/);
    expect(site.code).toBe(phone.code);
    const toPhone = new Sealer(site.key, 'site');
    const atPhone = new Sealer(phone.key, 'wallet');
    const f = await toPhone.seal({ t: 'req', id: '1', action: 'getPublicKey', params: { identityKey: true } });
    expect(await atPhone.open(f)).toEqual({ t: 'req', id: '1', action: 'getPublicKey', params: { identityKey: true } });
    // replay dropped
    expect(await atPhone.open(f)).toBeNull();
    // reflection (a site frame bounced back to the site) fails the AAD
    const toSite = new Sealer(site.key, 'site');
    const own = await toSite.seal({ t: 'ping' });
    expect(await new Sealer(site.key, 'site').open(own)).toBeNull();
    // tamper
    const g = await toPhone.seal({ t: 'ping' });
    expect(await atPhone.open({ ...g, d: g.d.slice(0, -4) + 'AAAA' })).toBeNull();
  });

  test('different channel → different code', async () => {
    const S = PrivateKey.fromRandom();
    const P = PrivateKey.fromRandom();
    const a = await deriveSession(S, P.toPublicKey().toString(), newChannel());
    const b = await deriveSession(S, P.toPublicKey().toString(), newChannel());
    expect(a.code === b.code && a.key === b.key).toBe(false);
  });

  test('pair links: build, parse, reject', () => {
    const k = PrivateKey.fromRandom().toPublicKey().toString();
    const e = Math.floor(Date.now() / 1000) + 120;
    const link = { v: '1', r: 'relay.bwallet.space', c: newChannel(), k, o: 'https://tokenblaster.lol', e };
    expect(parsePairUrl(pairUrl(link))).toEqual(link);
    expect(() => parsePairUrl('https://evil.example/pair?v=1')).toThrow();
    expect(() => parsePairUrl(pairUrl({ ...link, e: 10 }))).toThrow(/expired/);
    expect(() => parsePairUrl(pairUrl({ ...link, o: 'https://a.lol/path' }))).toThrow();
    // Audit H1: the relay is pinned; a link naming any other relay is refused.
    expect(() => parsePairUrl(pairUrl({ ...link, r: 'relay.attacker.com' }))).toThrow(/doesn't trust/);
    expect(() => parsePairUrl(pairUrl({ ...link, r: 'relay.bwallet.space.evil.com' }))).toThrow(/doesn't trust/);
    expect(() => parsePairUrl(pairUrl({ ...link, r: 'localhost:8787' }))).toThrow(/doesn't trust/);
    expect(parsePairUrl(pairUrl({ ...link, r: 'localhost:8787' }), undefined, { allowLocalRelay: true }).r).toBe(
      'localhost:8787',
    );
    expect(isAllowedRelay('relay.bwallet.space')).toBe(true);
    expect(isAllowedRelay('127.0.0.1:1', false)).toBe(false);
    expect(relaySocketUrl('relay.bwallet.space', link.c, 'site', e)).toBe(
      `wss://relay.bwallet.space/v1/c/${link.c}?role=site&e=${e}`,
    );
  });

  test('large frames (a signed transaction with its proofs) round-trip', async () => {
    const c = newChannel();
    const S = PrivateKey.fromRandom();
    const P = PrivateKey.fromRandom();
    const site = await deriveSession(S, P.toPublicKey().toString(), c);
    const phone = await deriveSession(P, S.toPublicKey().toString(), c);
    const tx = Array.from({ length: 400_000 }, (_, i) => i % 256);
    const f = await new Sealer(phone.key, 'wallet').seal({ t: 'res', id: '9', result: { txid: 'ab', tx } });
    const back = (await new Sealer(site.key, 'site').open(f)) as { result: { tx: number[] } };
    expect(back.result.tx.length).toBe(400_000);
  });

  test('cd=8 (BRC-185): both sides get the same 8 digits, the key is unchanged, no 4-digit prefix', async () => {
    let prefixHits = 0;
    for (let i = 0; i < 40; i++) {
      const c = newChannel();
      const S = PrivateKey.fromRandom();
      const P = PrivateKey.fromRandom();
      const site8 = await deriveSession(S, P.toPublicKey().toString(), c, 8);
      const phone8 = await deriveSession(P, S.toPublicKey().toString(), c, 8);
      const phone4 = await deriveSession(P, S.toPublicKey().toString(), c);
      expect(site8.code).toMatch(/^\d{8}$/);
      expect(phone8.code).toBe(site8.code);
      expect(phone4.code).toMatch(/^\d{4}$/);
      if (site8.code.startsWith(phone4.code)) prefixHits++;
      // Same AES key whatever the code length: the frames still open.
      const f = await new Sealer(site8.key, 'site').seal({ t: 'ping' });
      expect(await new Sealer(phone4.key, 'wallet').open(f)).toEqual({ t: 'ping' });
    }
    expect(prefixHits).toBeLessThan(3); // independent bytes: ~1 in 10,000 each
  });

  test('cd link field: round-trips, only 4 or 8 honoured, absent = legacy', () => {
    const k = PrivateKey.fromRandom().toPublicKey().toString();
    const e = Math.floor(Date.now() / 1000) + 120;
    const link = { v: '1', r: 'relay.bwallet.space', c: newChannel(), k, o: 'https://tokenblaster.lol', e };
    expect(parsePairUrl(pairUrl(link)).cd).toBeUndefined();
    expect(parsePairUrl(pairUrl({ ...link, cd: 8 })).cd).toBe(8);
    expect(parsePairUrl(pairUrl({ ...link, cd: 4 })).cd).toBe(4);
    expect(parsePairUrl(pairUrl(link) + '&cd=6').cd).toBeUndefined();
    expect(parsePairUrl(pairUrl(link) + '&cd=88').cd).toBeUndefined();
  });

  test('v2 proof binds cd only when present (old sites sign the old string)', () => {
    const base = { c: 'C', k: '02AB', o: 'https://a.lol', e: 1, ret: 'https://a.lol/x', rid: 'r', b: 'chrome' };
    const txt = (n: number[]) => new TextDecoder().decode(new Uint8Array(n));
    expect(txt(pairProofMessageV2(base))).toBe('bwallet-pair-v2|proof|C|02ab|https://a.lol|1|https://a.lol/x|r|chrome');
    expect(txt(pairProofMessageV2({ ...base, cd: 8 }))).toBe(
      'bwallet-pair-v2|proof|C|02ab|https://a.lol|1|https://a.lol/x|r|chrome|cd=8',
    );
  });

  test('formatPairCode groups 8 digits, leaves 4 alone', () => {
    expect(formatPairCode('12345678')).toBe('1234 5678');
    expect(formatPairCode('0042')).toBe('0042');
  });
});
