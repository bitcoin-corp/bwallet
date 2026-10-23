import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  BCHAT_CHOICE_TTL_MS,
  BCHAT_FALLBACK_ORIGIN,
  BCHAT_PRIMARY_ORIGIN,
  chooseBchatOrigin,
  ensureBchatOrigin,
  liveBchatUrl,
  resetBchatOriginForTests,
  routeBchatUrl,
  type OriginDeps,
} from './bchatOrigin';
import { BAPP_FRAME_ALLOWLIST } from '../mobile/bappFrame/bappFrame';
import { WEB_FRAME_ORIGINS } from '../mobile/bappFrame/webFrame';
import { familySite } from '../mobile/theme/themeSites';
import { parseXInviteLink } from '../mobile/chat/xInvites';
import { isAllowedVideoSrc } from '../mobile/spaces/spaceVideo';

const deps = (up: boolean, stored: string | null = null, now = 1_000_000) => {
  const probed: string[] = [];
  let saved = stored;
  const d: OriginDeps = {
    probe: async (o) => {
      probed.push(o);
      return up;
    },
    now: () => now,
    store: { get: () => saved, set: (v) => (saved = v) },
  };
  return { d, probed, saved: () => saved };
};

describe('bChatX origin fallback', () => {
  beforeEach(() => resetBchatOriginForTests());
  afterEach(() => resetBchatOriginForTests());

  it('uses www.bchatx.com when it answers', async () => {
    const { d, probed, saved } = deps(true);
    expect(await chooseBchatOrigin(d)).toBe(BCHAT_PRIMARY_ORIGIN);
    expect(probed).toEqual([BCHAT_PRIMARY_ORIGIN]);
    expect(JSON.parse(saved()!).origin).toBe(BCHAT_PRIMARY_ORIGIN);
  });

  it('falls back to chat.bwalletx.com when the primary is down', async () => {
    const { d } = deps(false);
    expect(await chooseBchatOrigin(d)).toBe('https://chat.bwalletx.com');
  });

  it('reuses a fresh cached choice without probing', async () => {
    const { d, probed } = deps(true, JSON.stringify({ origin: BCHAT_FALLBACK_ORIGIN, at: 999_000 }));
    expect(await chooseBchatOrigin(d)).toBe(BCHAT_FALLBACK_ORIGIN);
    expect(probed).toEqual([]);
  });

  it('re-probes once the cached choice is a day old, and ignores unknown origins', async () => {
    const old = deps(true, JSON.stringify({ origin: BCHAT_FALLBACK_ORIGIN, at: 1_000_000 - BCHAT_CHOICE_TTL_MS }));
    expect(await chooseBchatOrigin(old.d)).toBe(BCHAT_PRIMARY_ORIGIN);
    expect(old.probed.length).toBe(1);
    const evil = deps(true, JSON.stringify({ origin: 'https://evil.example', at: 999_999 }));
    expect(await chooseBchatOrigin(evil.d)).toBe(BCHAT_PRIMARY_ORIGIN);
  });

  it('probes once per session', async () => {
    const { d, probed } = deps(false);
    const [a, b] = await Promise.all([ensureBchatOrigin(d), ensureBchatOrigin(d)]);
    expect(await ensureBchatOrigin(d)).toBe(BCHAT_FALLBACK_ORIGIN);
    expect([a, b]).toEqual([BCHAT_FALLBACK_ORIGIN, BCHAT_FALLBACK_ORIGIN]);
    expect(probed.length).toBe(1);
  });

  it('rewrites only bChatX URLs', async () => {
    expect(liveBchatUrl('https://www.bchatx.com/api/x?a=1', BCHAT_FALLBACK_ORIGIN)).toBe(
      'https://chat.bwalletx.com/api/x?a=1',
    );
    expect(liveBchatUrl('https://bchatx.com/u/b', BCHAT_FALLBACK_ORIGIN)).toBe('https://chat.bwalletx.com/u/b');
    expect(liveBchatUrl('https://www.bchatx.com.evil.io/x', BCHAT_FALLBACK_ORIGIN)).toBe(
      'https://www.bchatx.com.evil.io/x',
    );
    expect(liveBchatUrl('https://api.1sat.app/x', BCHAT_FALLBACK_ORIGIN)).toBe('https://api.1sat.app/x');
    expect(liveBchatUrl('https://www.bchatx.com/x', BCHAT_PRIMARY_ORIGIN)).toBe('https://www.bchatx.com/x');
    const { d } = deps(false);
    expect(await routeBchatUrl('https://www.bchatx.com/api/y', d)).toBe('https://chat.bwalletx.com/api/y');
  });
});

describe('chat.bwalletx.com allowlists', () => {
  it('may be framed like bChatX', () => {
    expect(BAPP_FRAME_ALLOWLIST.has('https://chat.bwalletx.com')).toBe(true);
    expect(WEB_FRAME_ORIGINS.has('https://chat.bwalletx.com')).toBe(true);
    expect(BAPP_FRAME_ALLOWLIST.has('https://bwalletx.com')).toBe(false);
  });

  it('gets the bChatX site theme', () => {
    expect(familySite('https://chat.bwalletx.com/u/x')?.id).toBe('bchatx');
    expect(familySite('chat.bwalletx.com')?.id).toBe('bchatx');
    expect(familySite('https://evil.chat.bwalletx.com')).toBeNull();
  });

  it('is accepted for invite links and Space video', () => {
    const frag = '#k=L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ&t=' + 'a'.repeat(64);
    const www = parseXInviteLink(`https://www.bchatx.com/i/x/abcd1234${frag}`);
    expect(www).not.toBeNull();
    expect(parseXInviteLink(`https://chat.bwalletx.com/i/x/abcd1234${frag}`)).toEqual(www);
    expect(isAllowedVideoSrc('https://chat.bwalletx.com/media/v')).toBe(true);
  });
});
