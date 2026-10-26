import { describe, expect, test } from 'bun:test';
import {
  pinnedAllowed,
  pinnedProtocolRefusal,
  PINNED_REFUSAL,
  PINNED_PROTOCOLS_VERSION,
  pinLevelFromVersion,
  versionWithPins,
} from './pinnedProtocols';
import { guardReservedProtocols } from './reservedProtocols';
import { knownProtocol } from '../utils/protocols';

const ARCHIVE = [2, 'bmintx archive'] as [number, string];
const VIDEO = [2, 'bvideox records'] as [number, string];
const ADMIN = 'admin.bwalletx';

describe('pinned protocols', () => {
  test('home site may use the archive protocol; any other site is refused', () => {
    expect(
      pinnedProtocolRefusal('encrypt', { protocolID: ARCHIVE, keyID: 'p1', counterparty: 'self' }, 'bmintx.com'),
    ).toBeNull();
    expect(pinnedProtocolRefusal('decrypt', { protocolID: ARCHIVE, keyID: 'p1' }, 'www.bmintx.com')).toBeNull();
    for (const o of ['evil.com', 'bmintx.com.evil.com', 'localhost:3000', undefined])
      expect(pinnedProtocolRefusal('decrypt', { protocolID: ARCHIVE, keyID: 'p1' }, o)).toContain(PINNED_REFUSAL);
  });
  test('case and spacing of the name do not get round the pin', () => {
    expect(pinnedProtocolRefusal('encrypt', { protocolID: [2, ' BMintX Archive '] }, 'evil.com')).toContain(
      PINNED_REFUSAL,
    );
  });
  test('other protocols and methods are untouched', () => {
    expect(pinnedProtocolRefusal('encrypt', { protocolID: [2, 'some app'] }, 'evil.com')).toBeNull();
    expect(pinnedProtocolRefusal('createAction', { protocolID: ARCHIVE }, 'evil.com')).toBeNull();
    expect(pinnedAllowed([2, 'some app'], 'evil.com')).toBe(true);
    expect(pinnedAllowed(ARCHIVE, 'evil.com')).toBe(false);
  });
  test('the permissions guard refuses before the manager (and before a sheet) for other sites', async () => {
    const calls: string[] = [];
    const m = guardReservedProtocols(
      {
        encrypt: async () => (calls.push('encrypt'), { ciphertext: [1] }),
        ensureProtocolPermission: async () => (calls.push('ensure'), true),
      },
      ADMIN,
    );
    await expect(m.encrypt({ protocolID: ARCHIVE, keyID: 'k', plaintext: [1] }, 'https://evil.com')).rejects.toThrow(
      PINNED_REFUSAL,
    );
    await expect(m.ensureProtocolPermission({ originator: 'evil.com', protocolID: ARCHIVE })).rejects.toThrow(
      PINNED_REFUSAL,
    );
    expect(calls).toEqual([]);
    await m.encrypt({ protocolID: ARCHIVE, keyID: 'k', plaintext: [1] }, 'https://bmintx.com');
    await m.ensureProtocolPermission({ originator: 'bmintx.com', protocolID: ARCHIVE });
    await m.encrypt({ protocolID: ARCHIVE, keyID: 'k', plaintext: [1] }, ADMIN);
    expect(calls).toEqual(['encrypt', 'ensure', 'encrypt']);
  });
  test('the sheet shows plain words for it', () => {
    expect(knownProtocol(ARCHIVE)?.label).toBe('Your private archive (bMintX)');
  });
  test('bvideox records are pinned to bvideox.com, and the two pins do not cross', () => {
    expect(
      pinnedProtocolRefusal('encrypt', { protocolID: VIDEO, keyID: 'k', counterparty: 'self' }, 'bvideox.com'),
    ).toBeNull();
    expect(pinnedProtocolRefusal('decrypt', { protocolID: VIDEO, keyID: 'k' }, 'www.bvideox.com')).toBeNull();
    for (const o of ['bmintx.com', 'evil.com', 'bvideox.com.evil.com', undefined])
      expect(pinnedProtocolRefusal('decrypt', { protocolID: VIDEO, keyID: 'k' }, o)).toContain(PINNED_REFUSAL);
    expect(pinnedProtocolRefusal('decrypt', { protocolID: ARCHIVE, keyID: 'k' }, 'bvideox.com')).toContain(
      PINNED_REFUSAL,
    );
    expect(pinnedAllowed(VIDEO, 'evil.com')).toBe(false);
    expect(pinnedAllowed(VIDEO, 'bvideox.com')).toBe(true);
    expect(knownProtocol(VIDEO)?.label).toBe('Your video records (bVideoX)');
  });
  test('the advertised version covers bvideox records (bvideox.com checks >= 2)', () => {
    expect(PINNED_PROTOCOLS_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe('versionWithPins (BRC-205)', () => {
  test('BRC-205 form: base, one space, pin attribute, final semicolon', () => {
    expect(versionWithPins('bwalletx-5.2.44')).toBe(`bwalletx-5.2.44; pin=${PINNED_PROTOCOLS_VERSION};`);
    expect(versionWithPins('yours-wallet-5.2.44')).toBe(`yours-wallet-5.2.44; pin=${PINNED_PROTOCOLS_VERSION};`);
    // Matches the BRC-205 ABNF (version-string = base [";" [SP attribute *(";" SP attribute) [";"]]]).
    const grammar =
      /^[A-Za-z0-9][A-Za-z0-9._-]*-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(;( [a-z][a-z0-9-]*=([A-Za-z0-9._~-]|%[0-9A-F]{2})+(; [a-z][a-z0-9-]*=([A-Za-z0-9._~-]|%[0-9A-F]{2})+)*;?)?)?$/;
    expect(versionWithPins('bwalletx-5.2.44')).toMatch(grammar);
  });
  test('every branded name fits the SDK limit (7–30 chars); too long → base only', () => {
    for (const base of [
      'bwalletx-5.2.44',
      'bwallet-mobile-5.2.44',
      'yours-wallet-5.2.44',
      'bwallet-mobile-5.2.100',
      'bwallet-mobile-55.55.555',
    ]) {
      const v = versionWithPins(base);
      expect(v.length).toBeGreaterThanOrEqual(7);
      expect(v.length).toBeLessThanOrEqual(30);
      expect(v.startsWith(base)).toBe(true);
    }
    expect(versionWithPins('bwallet-mobile-55.55.555')).toBe('bwallet-mobile-55.55.555');
  });
  test('a base outside BRC-205 (4-part or leading zero) is sent bare', () => {
    expect(versionWithPins('bwalletx-5.2.44.1')).toBe('bwalletx-5.2.44.1');
    expect(versionWithPins('bwalletx-05.2.44')).toBe('bwalletx-05.2.44');
  });
});

describe('pinLevelFromVersion (sites and SDK)', () => {
  test('reads the BRC-205 attribute and the legacy +pN suffix', () => {
    expect(pinLevelFromVersion('bwalletx-5.2.44; pin=3;')).toBe(3);
    expect(pinLevelFromVersion('bwalletx-5.2.44; pin=3')).toBe(3);
    expect(pinLevelFromVersion('bwalletx-5.2.44; account-label=A; pin=2;')).toBe(2);
    expect(pinLevelFromVersion('bwalletx-5.2.40+p2')).toBe(2);
    expect(pinLevelFromVersion(versionWithPins('bwalletx-5.2.44'))).toBe(PINNED_PROTOCOLS_VERSION);
  });
  test('the pinnedProtocols field counts; the larger wins; nothing → 0', () => {
    expect(pinLevelFromVersion({ version: 'bwalletx-5.2.44', pinnedProtocols: 3 })).toBe(3);
    expect(pinLevelFromVersion({ version: 'bwalletx-5.2.44; pin=1;', pinnedProtocols: 3 })).toBe(3);
    expect(pinLevelFromVersion({ version: 'bwalletx-5.2.44' })).toBe(0);
    expect(pinLevelFromVersion('wallet-brc100-1.0.0')).toBe(0);
    expect(pinLevelFromVersion(null)).toBe(0);
    expect(pinLevelFromVersion({ version: 5 as unknown as string, pinnedProtocols: 'x' })).toBe(0);
  });
  test('not fooled by look-alikes', () => {
    expect(pinLevelFromVersion('bwalletx-5.2.44; xpin=9;')).toBe(0);
    expect(pinLevelFromVersion('bwalletx-5.2.44;pin=9;')).toBe(0);
  });
  test('the old site regex is what breaks: sites must switch to pinLevelFromVersion or the dual regex', () => {
    const OLD = /\+p(\d+)\b/;
    const DUAL = /(?:\+p|; pin=)(\d+)\b/;
    const v = versionWithPins('bwalletx-5.2.44');
    expect(OLD.test(v)).toBe(false);
    expect(Number(v.match(DUAL)?.[1])).toBe(PINNED_PROTOCOLS_VERSION);
    expect(Number('bwalletx-5.2.40+p2'.match(DUAL)?.[1])).toBe(2);
  });
});
