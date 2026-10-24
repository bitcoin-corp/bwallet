import { describe, expect, test } from 'bun:test';
import { pinnedAllowed, pinnedProtocolRefusal, PINNED_REFUSAL, PINNED_PROTOCOLS_VERSION } from './pinnedProtocols';
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
