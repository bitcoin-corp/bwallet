import { describe, expect, test } from 'bun:test';
import {
  INSECURE_ORIGIN_ERROR,
  isLoopbackHostname,
  originatorForOrigin,
  isPairedHost,
  pairedOrigin,
  legacyPairedOrigin,
  channelLabel,
} from './originKey';

describe('originatorForOrigin (M3)', () => {
  test('https keeps the host key existing grants were stored under', () => {
    expect(originatorForOrigin('https://example.com')).toEqual({ originator: 'example.com' });
    expect(originatorForOrigin('https://example.com:8443/path?q=1')).toEqual({ originator: 'example.com:8443' });
  });

  test('plain http is refused, so it can never share https grants or allowances', () => {
    expect(originatorForOrigin('http://example.com')).toEqual({ error: INSECURE_ORIGIN_ERROR });
    expect(originatorForOrigin('http://example.com:443')).toEqual({ error: INSECURE_ORIGIN_ERROR });
    // the H1 shapes: single-label hosts over http
    expect(originatorForOrigin('http://yours-mobile')).toEqual({ error: INSECURE_ORIGIN_ERROR });
    expect(originatorForOrigin('http://abcdefghijklmnopabcdefghijklmnop/')).toEqual({ error: INSECURE_ORIGIN_ERROR });
  });

  test('loopback http is allowed for development', () => {
    expect(originatorForOrigin('http://localhost:5173')).toEqual({ originator: 'localhost:5173' });
    expect(originatorForOrigin('http://127.0.0.1:3000')).toEqual({ originator: '127.0.0.1:3000' });
    expect(originatorForOrigin('http://[::1]:8080')).toEqual({ originator: '[::1]:8080' });
    expect(isLoopbackHostname('app.localhost')).toBe(true);
    expect(isLoopbackHostname('localhost.evil.com')).toBe(false);
    expect(isLoopbackHostname('127.0.0.1.evil.com')).toBe(false);
  });

  test('other schemes and junk are refused', () => {
    for (const o of ['file:///etc/passwd', 'ftp://example.com', 'data:text/html,x', 'null', '', undefined, null]) {
      expect(originatorForOrigin(o).originator).toBeUndefined();
    }
  });
});

describe('paired sessions (audit H1)', () => {
  test('run under their own key, never the site originator', () => {
    const CH = 'AAAAAAAAAAAAAAAAAAAAAA';
    const o = pairedOrigin('https://bchatx.com', CH);
    expect(o).toBe(`https://bchatx.com.c${'41'.repeat(22)}.paired.invalid`);
    expect(originatorForOrigin(o).originator).toBe(`bchatx.com.c${'41'.repeat(22)}.paired.invalid`);
    expect(originatorForOrigin(o).originator).not.toBe(originatorForOrigin('https://bchatx.com').originator);
    expect(isPairedHost('bchatx.com.paired.invalid')).toBe(true);
    expect(isPairedHost('bchatx.com')).toBe(false);
    expect(pairedOrigin('http://localhost:3000', CH)).toBe(`https://localhost.c${'41'.repeat(22)}.paired.invalid:3000`);
    expect(legacyPairedOrigin('https://bchatx.com')).toBe('https://bchatx.com.paired.invalid');
  });

  test('b-Aware 24 Oct 2026: two pairings claiming the same origin never share a key', () => {
    const a = pairedOrigin('https://bchatx.com', 'AAAAAAAAAAAAAAAAAAAAAA');
    const b = pairedOrigin('https://bchatx.com', 'AAAAAAAAAAAAAAAAAAAAAB');
    expect(a).not.toBe(b);
    expect(isPairedHost(new URL(b).hostname)).toBe(true);
    expect(channelLabel('_-_-_-_-_-_-_-_-_-_-_w')).toMatch(/^c[0-9a-f]{44}$/);
    expect(() => pairedOrigin('https://bchatx.com', 'short')).toThrow();
  });
});
