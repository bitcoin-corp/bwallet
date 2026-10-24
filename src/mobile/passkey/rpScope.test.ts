// b-Aware row 57: with rpId bwalletx.com any subdomain could ask for the seed-backup passkey and get the same
// PRF output. The wallet's rpId must be scoped to web.bwalletx.com, and only the wallet hosts may use it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE_RP_ID } from './nativePasskeys';
import { rpIdFor, WALLET_RP_HOSTS } from './prf';

const root = join(import.meta.dir, '..', '..', '..');

describe('seed-backup rpId scope', () => {
  test('the wallet rpId is web.bwalletx.com, never the registrable domain', () => {
    expect(NATIVE_RP_ID).toBe('web.bwalletx.com');
    expect(NATIVE_RP_ID).not.toBe('bwalletx.com');
  });

  test('only the wallet hosts and the native apps map to the wallet rpId', () => {
    expect(rpIdFor('web.bwalletx.com', false)).toBe(NATIVE_RP_ID);
    expect(rpIdFor('desktop.bwalletx.com', false)).toBe(NATIVE_RP_ID);
    expect(rpIdFor('localhost', true)).toBe(NATIVE_RP_ID);
    expect(WALLET_RP_HOSTS).toEqual(['web.bwalletx.com', 'desktop.bwalletx.com']);
  });

  test('other bwalletx.com hosts get their own rpId', () => {
    for (const h of [
      'bwalletx.com',
      'chat.bwalletx.com',
      'auth.bwalletx.com',
      'beta.bwalletx.com',
      'x.web.bwalletx.com',
    ]) {
      expect(rpIdFor(h, false)).toBe(h);
      expect(rpIdFor(h, false)).not.toBe(NATIVE_RP_ID);
    }
    expect(rpIdFor('evilweb.bwalletx.com.attacker.io', false)).toBe('evilweb.bwalletx.com.attacker.io');
  });

  test('related origins file lists desktop and nothing wider', () => {
    const ror = JSON.parse(readFileSync(join(root, 'public/.well-known/webauthn'), 'utf8')) as { origins: string[] };
    expect(ror.origins).toEqual(['https://web.bwalletx.com', 'https://desktop.bwalletx.com']);
  });

  test('apps claim the scoped domain', () => {
    const ent = readFileSync(join(root, 'ios/App/App/App.entitlements'), 'utf8');
    expect(ent).toContain('<string>webcredentials:web.bwalletx.com</string>');
    expect(ent).not.toContain('<string>webcredentials:bwalletx.com</string>');
    const strings = readFileSync(join(root, 'android/app/src/main/res/values/strings.xml'), 'utf8');
    expect(strings).toContain('https://web.bwalletx.com/.well-known/assetlinks.json');
    for (const f of ['apple-app-site-association', 'assetlinks.json']) {
      expect(() => JSON.parse(readFileSync(join(root, 'public/.well-known', f), 'utf8'))).not.toThrow();
    }
  });
});
