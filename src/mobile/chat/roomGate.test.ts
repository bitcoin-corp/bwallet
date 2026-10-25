import { describe, expect, it } from 'bun:test';
import { gateIconUrl, lacksGate, lockedForMe, lockedLine, ownsGatedRoom, roomTokenGate } from './roomGate';

const ID = 'd5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1';
const META = {
  kind: 'open',
  site: 'https://www.tokenblaster.lol',
  tokenGate: { key: `bsv21:${ID}`, kind: 'bsv21', symbol: 'TERRORNODE', dec: 0, minAmountRaw: '1' },
};

describe('roomGate', () => {
  it('reads the ASSAULT gate', () => {
    expect(roomTokenGate(META)).toEqual({ key: `bsv21:${ID}`, symbol: 'TERRORNODE', dec: 0, minRaw: '1' });
    expect(roomTokenGate({ kind: 'open' })).toBeNull();
    expect(roomTokenGate({ tokenGate: { key: 'nonsense' } })).toBeNull();
  });
  it('locks only on a known balance below the minimum', () => {
    const g = roomTokenGate(META)!;
    expect(lacksGate(g, '0')).toBe(true);
    expect(lacksGate(g, '1')).toBe(false);
    expect(lacksGate(g, null)).toBe(false);
    expect(lacksGate(g, undefined)).toBe(false);
    expect(lacksGate(null, '0')).toBe(false);
  });
  it('keeps the creator / issuer exemption', () => {
    const room = { metadata: META, created_by_handle: 'tokenblaster' };
    // Creator holding 0 sees and enters.
    expect(lockedForMe(room, '$TokenBlaster', '0')).toBeNull();
    // Another non-holder sees it locked.
    expect(lockedForMe(room, 'alice', '0')?.symbol).toBe('TERRORNODE');
    // A holder sees it.
    expect(lockedForMe(room, 'alice', '1')).toBeNull();
    // Claimed issuer or bit-sign's you_are_issuer holding 0 gets in.
    expect(lockedForMe(room, 'bob', '0', { issuer: { handle: 'bob', claimed: true } })).toBeNull();
    expect(lockedForMe(room, 'bob', '0', { issuer: { handle: 'bob', claimed: false } })).not.toBeNull();
    expect(lockedForMe(room, null, '0', { youAreIssuer: true })).toBeNull();
    expect(ownsGatedRoom({ created_by_handle: '' }, '', null)).toBe(false);
  });
  it('says what to hold', () => {
    const g = roomTokenGate(META)!;
    expect(lockedLine(g, true)).toBe('Hold 1 $TERRORNODE to join · Play to earn');
    expect(lockedLine({ ...g, dec: 2, minRaw: '250' }, false)).toBe('Hold 2.5 $TERRORNODE to join');
  });
  it('uses the on-chain icon', () => {
    expect(gateIconUrl(roomTokenGate(META))).toBe(`https://ordfs.network/content/${ID.slice(0, 64)}_0`);
    expect(gateIconUrl(null)).toBeNull();
  });
});
