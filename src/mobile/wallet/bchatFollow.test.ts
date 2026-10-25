import { describe, expect, it, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aliasOf,
  decideFollow,
  followDue,
  FOLLOW_RETRY_MS,
  loadBchatPref,
  saveBchatPref,
  type BchatPref,
} from './bchatFollow';
import { keyFingerprint } from './identityLine';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const account: BchatPref = { mode: 'account' };
const custom: BchatPref = { mode: 'custom' };
const off: BchatPref = { mode: 'off' };

describe('bChatX follows the wallet account', () => {
  beforeEach(() => store.clear());

  it('switching to an account whose session belongs to another account signs in fresh', () => {
    // The owner's case: $b0asey's stored session was @b0asex's.
    expect(decideFollow({ pref: account, sessionHandle: 'b0asex', alias: 'b0asey', mismatch: true })).toBe('signin');
  });

  it('an account with no session signs in by default', () => {
    expect(decideFollow({ pref: account, sessionHandle: null, alias: 'b0asey', mismatch: false })).toBe('signin');
  });

  it('own session under a placeholder name adopts the paymail name', () => {
    expect(decideFollow({ pref: account, sessionHandle: 'yours-jorv3rmo', alias: 'testy', mismatch: false })).toBe(
      'adopt',
    );
  });

  it('own session under the paymail name needs nothing', () => {
    expect(decideFollow({ pref: account, sessionHandle: '$Testy', alias: 'testy', mismatch: false })).toBe('none');
  });

  it('a chosen different name is kept', () => {
    expect(decideFollow({ pref: custom, sessionHandle: 'nightowl', alias: 'testy', mismatch: false })).toBe('none');
    // ...but someone else's session is still replaced by this account's own.
    expect(decideFollow({ pref: custom, sessionHandle: 'b0asex', alias: 'testy', mismatch: true })).toBe('signin');
  });

  it('privacy opt-out drops the session and never signs in', () => {
    expect(decideFollow({ pref: off, sessionHandle: 'testy', alias: 'testy', mismatch: false })).toBe('clear');
    expect(decideFollow({ pref: off, sessionHandle: 'b0asex', alias: 'testy', mismatch: true })).toBe('clear');
    expect(decideFollow({ pref: off, sessionHandle: null, alias: 'testy', mismatch: false })).toBe('none');
  });

  it('preferences are per account and default to the account name', () => {
    expect(loadBchatPref('1Abc')).toEqual({ mode: 'account' });
    saveBchatPref('1Abc', off);
    expect(loadBchatPref('1Abc')).toEqual({ mode: 'off' });
    expect(loadBchatPref('1Other')).toEqual({ mode: 'account' });
  });

  it('a failed attempt waits before retrying automatically', () => {
    const now = 1_000_000_000;
    expect(followDue(null, now)).toBe(true);
    expect(followDue({ at: now - 1000, ok: false, error: 'x' }, now)).toBe(false);
    expect(followDue({ at: now - FOLLOW_RETRY_MS, ok: false, error: 'x' }, now)).toBe(true);
    expect(followDue({ at: now - 1000, ok: true, handle: 'testy' }, now)).toBe(true);
  });

  it('reads the alias from a paymail', () => {
    expect(aliasOf('b0asey@bwalletx.com')).toBe('b0asey');
    expect(aliasOf('')).toBe('');
  });
});

describe('wallet card layout', () => {
  const css = readFileSync(join(import.meta.dir, '../mobile.css'), 'utf8');
  const card = readFileSync(join(import.meta.dir, 'WalletCard.tsx'), 'utf8');
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };

  it('the fingerprint never shrinks to "0…" at narrow widths', () => {
    expect(keyFingerprint('02' + 'ab'.repeat(32))).toBe('02abab…abab');
    const r = rule('.bw-wcard-fingerprint');
    expect(r).toContain('flex: none');
    expect(r).toContain('min-width: max-content');
    expect(r).toContain('text-overflow: clip');
  });

  it('no bChatX mismatch banner on the card', () => {
    expect(card).not.toContain('Signed in to bChatX as');
    expect(card).not.toContain('Chat identity mismatch');
    expect(card).not.toContain('bw-wcard-idwarn');
  });

  it('front has a plain pen that flips; no Sign or Front pills', () => {
    expect(card).toContain('className="bw-wcard-penflip"');
    expect(card).not.toContain('bw-wcard-sidebtn');
    const pen = rule('.bw-wcard-penflip');
    expect(pen).toContain('border: 0');
    expect(pen).toContain('background: transparent');
  });

  it('identity key sits in the magnetic strip with a small copy icon', () => {
    const strip = card.slice(card.indexOf('<div className="bw-wcard-stripe">'), card.indexOf('bw-wcard-backbody'));
    expect(strip).toContain('ID KEY:');
    expect(strip).toContain('stripeKey(backKey)');
    expect(strip).toContain('aria-label="Copy identity key"');
    expect(card).not.toContain('Signed by identity key');
  });
});
