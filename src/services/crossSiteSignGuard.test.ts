import { describe, expect, test } from 'bun:test';
import { boundHosts, crossSiteSignRefusal, guardCrossSiteSigning, sameSite } from './crossSiteSignGuard';

const bytes = (s: string) => Array.from(new TextEncoder().encode(s));
const sig = (s: string) => ({ protocolID: [2, 'good login'], keyID: '1', counterparty: 'anyone', data: bytes(s) });

describe('crossSiteSignRefusal (audit 24 Oct B1)', () => {
  test('refuses a SIWE-style challenge relayed from another site', () => {
    const msg = 'good.com wants you to sign in with your Bitcoin account:\nNonce: 123';
    expect(crossSiteSignRefusal('evil.com', sig(msg))).toContain('different site');
    expect(crossSiteSignRefusal('good.com', sig(msg))).toBeNull();
  });

  test('refuses a JSON challenge whose domain/origin/audience is another site', () => {
    for (const field of ['domain', 'origin', 'host', 'audience', 'aud']) {
      const msg = JSON.stringify({ [field]: 'https://good.com', nonce: 'abc' });
      expect(crossSiteSignRefusal('evil.com', sig(msg))).not.toBeNull();
      expect(crossSiteSignRefusal('good.com', sig(msg))).toBeNull();
    }
  });

  test('subdomains, ports and the pairing key count as the same site', () => {
    const msg = JSON.stringify({ domain: 'bchatx.com' });
    expect(crossSiteSignRefusal('app.bchatx.com', sig(msg))).toBeNull();
    expect(crossSiteSignRefusal('bchatx.com:8443', sig(msg))).toBeNull();
    expect(crossSiteSignRefusal('bchatx.com.paired.invalid', sig(msg))).toBeNull();
    expect(crossSiteSignRefusal(`bchatx.com.c${'ab'.repeat(22)}.paired.invalid`, sig(msg))).toBeNull();
    expect(crossSiteSignRefusal(`evil.com.c${'ab'.repeat(22)}.paired.invalid`, sig(msg))).not.toBeNull();
  });

  test('one matching field cannot launder a second, foreign one', () => {
    const msg = JSON.stringify({ origin: 'evil.com', domain: 'good.com' });
    expect(crossSiteSignRefusal('evil.com', sig(msg))).not.toBeNull();
  });

  test('data that names no site, free links, and binary data sign as before', () => {
    expect(crossSiteSignRefusal('evil.com', sig('bwx-podcast:42:nonce'))).toBeNull();
    expect(crossSiteSignRefusal('evil.com', sig('look at https://good.com/post/1'))).toBeNull();
    expect(crossSiteSignRefusal('evil.com', { data: [0, 255, 1, 2, 200, 3] })).toBeNull();
    expect(crossSiteSignRefusal('evil.com', { hashToDirectlySign: [1, 2, 3] })).toBeNull();
    expect(crossSiteSignRefusal(undefined, sig(JSON.stringify({ domain: 'good.com' })))).toBeNull();
  });

  test('boundHosts reads both forms', () => {
    expect(boundHosts('a.io wants you to sign in\norigin=https://b.io:3000/x').sort()).toEqual(['a.io', 'b.io']);
  });
});

describe('guardCrossSiteSigning', () => {
  const make = () => {
    const calls: string[] = [];
    const m = {
      createSignature: async (_a: unknown, o?: string) => (calls.push(`sig:${o}`), { signature: [1] }),
      createHmac: async (_a: unknown, o?: string) => (calls.push(`hmac:${o}`), { hmac: [1] }),
    };
    return { m: guardCrossSiteSigning(m, 'admin.local'), calls };
  };
  const relayed = sig(JSON.stringify({ domain: 'good.com', nonce: 'n' }));

  test('refuses before reaching the manager (so no prompt is shown)', async () => {
    const { m, calls } = make();
    await expect(m.createSignature(relayed, 'evil.com')).rejects.toThrow('different site');
    await expect(m.createHmac(relayed, 'evil.com')).rejects.toThrow('different site');
    expect(calls).toEqual([]);
  });

  test('the right site and the wallet itself go through', async () => {
    const { m, calls } = make();
    await m.createSignature(relayed, 'good.com');
    await m.createSignature(relayed, 'admin.local');
    expect(calls).toEqual(['sig:good.com', 'sig:admin.local']);
  });
});

describe('sameSite: shared hosting and dot boundaries', () => {
  test('parent and subdomain match', () => {
    expect(sameSite('app.bchatx.com', 'bchatx.com')).toBe(true);
    expect(sameSite('bchatx.com', 'a.b.bchatx.com')).toBe(true);
  });
  test('siblings on shared suffixes are different sites', () => {
    expect(sameSite('evil.vercel.app', 'good.vercel.app')).toBe(false);
    expect(sameSite('evil.github.io', 'good.github.io')).toBe(false);
    expect(sameSite('evil.co.uk', 'good.co.uk')).toBe(false);
  });
  test('no match without a dot boundary', () => {
    expect(sameSite('notbchatx.com', 'bchatx.com')).toBe(false);
    expect(sameSite('bchatx.com', 'notbchatx.com')).toBe(false);
  });
  test('relays between shared-hosting siblings are refused', () => {
    for (const [evil, good] of [
      ['evil.vercel.app', 'good.vercel.app'],
      ['evil.github.io', 'good.github.io'],
      ['evil.co.uk', 'good.co.uk'],
      ['notbchatx.com', 'bchatx.com'],
    ])
      expect(crossSiteSignRefusal(evil, sig(JSON.stringify({ domain: good })))).not.toBeNull();
  });
});
