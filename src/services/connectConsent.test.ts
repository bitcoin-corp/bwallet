import { describe, expect, test } from 'bun:test';
import { CONNECT_CONSENT_MS, ConnectConsent, IDENTITY_LINE, isConnectLine } from './connectConsent';

const reserved = (p: unknown) => Array.isArray(p) && p[1] === 'bwalletx wallet';
const paired = (o: string) => o.endsWith('.paired.invalid');
const mk = () => new ConnectConsent({ isPaired: paired, isReserved: reserved });
const site = 'tokenblaster.lol';
const identity = { type: 'protocol', originator: site, protocolID: [1, IDENTITY_LINE], counterparty: 'self' };
const signIn = { type: 'protocol', originator: site, protocolID: [1, 'tokenblaster social'], counterparty: 'anyone' };

describe('one connect sheet covers identity key and sign-in', () => {
  test('after the connect sheet, identity key and sign-in need no second or third sheet', () => {
    const c = mk();
    c.record(site, 1000);
    expect(c.coversAll([identity], 2000)).toBe(true);
    expect(c.coversAll([signIn], 3000)).toBe(true);
    expect(c.coversAll([identity, signIn], 3000)).toBe(true);
  });
  test('without a connect sheet nothing is covered', () => {
    expect(mk().coversAll([identity], 1)).toBe(false);
  });
  test('the consent ends after the window', () => {
    const c = mk();
    c.record(site, 0);
    expect(c.covers(identity, CONNECT_CONSENT_MS + 1)).toBe(false);
  });
  test('another site gets nothing', () => {
    const c = mk();
    c.record(site, 0);
    expect(c.covers({ ...identity, originator: 'evil.example' }, 1)).toBe(false);
  });
  test('paired sessions inherit no trust', () => {
    const c = mk();
    const p = 'tokenblaster.lol.paired.invalid';
    c.record(p, 0);
    expect(c.covers({ ...identity, originator: p }, 1)).toBe(false);
  });
  test('never: level 2, privileged, reserved, reconnect, baskets or spending', () => {
    const c = mk();
    c.record(site, 0);
    expect(c.covers({ ...signIn, protocolID: [2, 'tokenblaster social'], counterparty: '02ab' }, 1)).toBe(false);
    expect(c.covers({ ...signIn, counterparty: '02abcdef' }, 1)).toBe(false);
    expect(c.covers({ ...signIn, privileged: true }, 1)).toBe(false);
    expect(c.covers({ ...signIn, protocolID: [1, 'bwalletx wallet'] }, 1)).toBe(false);
    expect(c.covers({ ...identity, reconnect: true }, 1)).toBe(false);
    expect(c.covers({ type: 'basket', originator: site }, 1)).toBe(false);
    expect(c.covers({ type: 'spending', originator: site }, 1)).toBe(false);
    expect(c.coversAll([identity, { type: 'spending', originator: site }], 1)).toBe(false);
  });
  test('forget ends it at once', () => {
    const c = mk();
    c.record(site, 0);
    c.forget(site);
    expect(c.covers(identity, 1)).toBe(false);
  });
  test('isConnectLine shape checks', () => {
    expect(isConnectLine({ type: 'protocol', protocolID: 'x' }, reserved)).toBe(false);
  });
});
