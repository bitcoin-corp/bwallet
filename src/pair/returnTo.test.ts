import { beforeEach, describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import {
  PAIR_PROOF_PATH,
  pairUrl,
  parsePairUrl,
  signPairProof,
  signPairProofV2,
  verifyPairProofs,
  type PairLink,
} from './protocol';
import {
  RID_TTL_MS,
  claimRid,
  isAllowedReturn,
  planReturn,
  resetRidMemory,
  returnTarget,
  returnUrlFor,
  type KV,
} from './returnTo';

const O = 'https://www.tokenblaster.lol';
const siteKey = PrivateKey.fromRandom();
const wellKnown = (async (url: string) => {
  expect(url).toBe(`${O}${PAIR_PROOF_PATH}`);
  return new Response(JSON.stringify({ keys: [siteKey.toPublicKey().toString()] }), { status: 200 });
}) as unknown as typeof fetch;
const RID = 'r1d_r1d_r1d_r1d_r1d_r1';
const base = (over: Partial<PairLink> = {}): PairLink => ({
  v: '1',
  r: 'relay.bwallet.space',
  c: 'AAAAAAAAAAAAAAAAAAAAAA',
  k: PrivateKey.fromRandom().toPublicKey().toString(),
  o: O,
  e: Math.floor(Date.now() / 1000) + 100,
  ...over,
});
const v2 = (over: Partial<PairLink> = {}, key = siteKey): PairLink => {
  const l = base({ ret: `${O}/terrornode?x=1`, rid: RID, b: 'chrome', ...over });
  l.s = signPairProof(l, key);
  l.s2 = signPairProofV2({ ...l, ret: l.ret!, rid: l.rid! }, key);
  return l;
};
const memKv = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
};
beforeEach(() => resetRidMemory());

describe('return allow-list', () => {
  test('same host and subdomains of the proven origin, https only', () => {
    expect(isAllowedReturn('https://www.tokenblaster.lol/play', O)).toBe(true);
    expect(isAllowedReturn('https://game.www.tokenblaster.lol/', O)).toBe(true);
    expect(isAllowedReturn('https://tokenblaster.lol/', 'https://tokenblaster.lol')).toBe(true);
    expect(isAllowedReturn('https://app.tokenblaster.lol/', 'https://tokenblaster.lol')).toBe(true);
  });
  test('ATTACK: other hosts, look-alikes, parents, http, userinfo, ports and other schemes are refused', () => {
    for (const r of [
      'https://evil.example/',
      'https://www.tokenblaster.lol.evil.example/',
      'https://eviltokenblaster.lol/',
      'https://wwwtokenblaster.lol/',
      'https://tokenblaster.lol/', // the parent of the proven host
      'http://www.tokenblaster.lol/',
      'https://user:pw@www.tokenblaster.lol/',
      'https://www.tokenblaster.lol:8443/',
      'javascript:alert(1)',
      'googlechromes://www.tokenblaster.lol/',
      `https://www.tokenblaster.lol/${'a'.repeat(600)}`,
      'not a url',
    ])
      expect(isAllowedReturn(r, O)).toBe(false);
    expect(isAllowedReturn('https://www.tokenblaster.lol/', 'http://www.tokenblaster.lol')).toBe(false);
  });
});

describe('v2 proof + plan', () => {
  test('a signed v2 link survives the round trip, proves both versions and plans a return', async () => {
    const l = parsePairUrl(pairUrl(v2()));
    expect([l.ret, l.rid, l.b]).toEqual([`${O}/terrornode?x=1`, RID, 'chrome']);
    const p = await verifyPairProofs(l, wellKnown);
    expect(p).toEqual({ v1: true, v2: true });
    expect(planReturn(l, O, p.v2)).toEqual({ ret: `${O}/terrornode?x=1`, rid: RID, b: 'chrome' });
  });
  test('v1 link (no return fields) still pairs and is proven, with no return', async () => {
    const l = base();
    l.s = signPairProof(l, siteKey);
    const parsed = parsePairUrl(pairUrl(l));
    expect(parsed.ret).toBeUndefined();
    const p = await verifyPairProofs(parsed, wellKnown);
    expect(p).toEqual({ v1: true, v2: false });
    expect(planReturn(parsed, O, p.v2)).toBeNull();
  });
  test('ATTACK: ret, rid or b swapped on a real link breaks the v2 proof: no return', async () => {
    for (const over of [
      { ret: 'https://evil.example/' },
      { ret: `${O}/other` },
      { rid: 'x'.repeat(22) },
      { b: 'safari' as const },
    ]) {
      const l = { ...v2(), ...over };
      const p = await verifyPairProofs(l, wellKnown);
      expect(p.v2).toBe(false);
      expect(planReturn(l, O, p.v2)).toBeNull();
    }
  });
  test('ATTACK: a forger signing their own v2 proof is not proven: no return', async () => {
    const l = v2({}, PrivateKey.fromRandom());
    const p = await verifyPairProofs(l, wellKnown);
    expect(p).toEqual({ v1: false, v2: false });
    expect(planReturn(l, O, p.v2)).toBeNull();
  });
  test('ATTACK: a proven link whose ret is off-origin, or whose relay origin differs, gets no return', async () => {
    const off = v2({ ret: 'https://evil.example/' });
    expect((await verifyPairProofs(off, wellKnown)).v2).toBe(true); // the site signed it, but…
    expect(planReturn(off, O, true)).toBeNull(); // …it is not on the proven origin
    expect(planReturn(v2(), 'https://other.example', true)).toBeNull();
  });
  test('malformed return fields are dropped, the link still parses', () => {
    const l = parsePairUrl(pairUrl({ ...base(), ret: 'x'.repeat(600), rid: 'short', b: 'netscape' as never }));
    expect([l.ret, l.rid, l.b]).toEqual([undefined, undefined, undefined]);
  });
});

describe('one-time request id', () => {
  test('first use passes, reuse is refused, and it is forgotten after 24 h', () => {
    const kv = memKv();
    expect(claimRid(RID, 1_000, kv)).toBe(true);
    expect(claimRid(RID, 2_000, kv)).toBe(false);
    resetRidMemory();
    expect(claimRid(RID, 3_000, kv)).toBe(false); // persisted, not just in memory
    expect(claimRid('another_request_id_1234', 3_000, kv)).toBe(true);
    resetRidMemory();
    expect(claimRid(RID, 1_000 + RID_TTL_MS + 1, kv)).toBe(true);
  });
  test('storage that fails still refuses a reuse in this run; bad ids are refused', () => {
    const broken: KV = {
      get: () => {
        throw new Error('blocked');
      },
      set: () => undefined,
    };
    expect(claimRid(RID, 1, broken)).toBe(true);
    expect(claimRid(RID, 2, broken)).toBe(false);
    expect(claimRid('nope', 1, memKv())).toBe(false);
  });
});

describe('return URL for each browser', () => {
  const target = returnTarget(`${O}/play?x=1#old`, RID);
  test('the result rides in the fragment, replacing any old one', () => {
    expect(target).toBe(`${O}/play?x=1#bwx=ok&rid=${RID}`);
  });
  test('iOS: Safari and unknown get https, Chrome googlechromes://, Firefox firefox://open-url', () => {
    expect(returnUrlFor(target, 'safari', 'ios')).toBe(target);
    expect(returnUrlFor(target, undefined, 'ios')).toBe(target);
    expect(returnUrlFor(target, 'other', 'ios')).toBe(target);
    expect(returnUrlFor(target, 'chrome', 'ios')).toBe(
      `googlechromes://www.tokenblaster.lol/play?x=1#bwx=ok&rid=${RID}`,
    );
    expect(returnUrlFor(target, 'firefox', 'ios')).toBe(`firefox://open-url?url=${encodeURIComponent(target)}`);
  });
  test('Android: intent:// naming the browser package with the https fallback', () => {
    const fb = `S.browser_fallback_url=${encodeURIComponent(target)};end`;
    const rest = `www.tokenblaster.lol/play?x=1#bwx=ok&rid=${RID}`;
    expect(returnUrlFor(target, 'chrome', 'android')).toBe(
      `intent://${rest}#Intent;scheme=https;package=com.android.chrome;${fb}`,
    );
    expect(returnUrlFor(target, 'samsung', 'android')).toContain('package=com.sec.android.app.sbrowser;');
    expect(returnUrlFor(target, 'firefox', 'android')).toContain('package=org.mozilla.firefox;');
    expect(returnUrlFor(target, 'edge', 'android')).toContain('package=com.microsoft.emmx;');
    expect(returnUrlFor(target, 'brave', 'android')).toContain('package=com.brave.browser;');
    expect(returnUrlFor(target, 'other', 'android')).toBe(target);
    expect(returnUrlFor(target, undefined, 'android')).toBe(target);
  });
  test('web wallet: always the https URL', () => {
    expect(returnUrlFor(target, 'chrome', 'web')).toBe(target);
  });
  test('never builds a non-https return', () => {
    expect(() => returnUrlFor('http://www.tokenblaster.lol/', 'chrome', 'ios')).toThrow();
  });
});
