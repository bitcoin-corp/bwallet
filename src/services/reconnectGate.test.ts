import { describe, expect, test } from 'bun:test';
import {
  RECONNECT_GAP_MS,
  ReconnectAsks,
  gatesConnect,
  emptyReconnectState,
  isReconnectRequestId,
  needsReconnect,
  noteCall,
  noteDisconnect,
  noteReconnected,
  parseReconnectState,
} from './reconnectGate';

const site = 'www.tokenblaster.lol';

describe('reconnectGate', () => {
  test('a connected site stays silent (liveness checks never ask)', () => {
    let s = noteCall(emptyReconnectState(), site, 1000);
    expect(needsReconnect(s, site, 2000)).toBe(false);
    s = noteCall(s, site, 2000);
    expect(needsReconnect(s, site, 3000)).toBe(false);
  });
  test('never silent after a disconnect, until the user reconnects', () => {
    let s = noteDisconnect(noteCall(emptyReconnectState(), site, 1000), `https://${site}`, 1500);
    expect(needsReconnect(s, site, 1600)).toBe(true);
    s = noteCall(s, site, 1600); // a call alone does not clear it
    expect(needsReconnect(s, site, 1700)).toBe(true);
    s = noteReconnected(s, site, 1800);
    expect(needsReconnect(s, site, 1900)).toBe(false);
  });
  test('a day of silence asks again', () => {
    const s = noteCall(emptyReconnectState(), site, 0);
    expect(needsReconnect(s, site, RECONNECT_GAP_MS)).toBe(false);
    expect(needsReconnect(s, site, RECONNECT_GAP_MS + 1)).toBe(true);
  });
  test('a first-time site is left to the normal connect sheet', () => {
    expect(needsReconnect(emptyReconnectState(), site, 5)).toBe(false);
  });
  test('per site, and parse tolerates junk', () => {
    const s = noteDisconnect(emptyReconnectState(), 'a.com', 1);
    expect(needsReconnect(s, 'b.com', 2)).toBe(false);
    expect(parseReconnectState({ off: { x: 'no', y: 3 }, seen: [] })).toEqual({ off: { y: 3 }, seen: {} });
    expect(isReconnectRequestId('reconnect-1')).toBe(true);
    expect(isReconnectRequestId('abc')).toBe(false);
  });
  test('regression (paid playtest, 25 Oct 2026): liveness calls never open the sheet', () => {
    for (const a of ['isAuthenticated', 'getVersion', 'getNetwork', 'waitForAuthentication', 'getHeight'])
      expect(gatesConnect(a, { identityKey: true })).toBe(false);
    expect(gatesConnect('getPublicKey', { protocolID: [1, 'x'], keyID: '1' })).toBe(false);
    expect(gatesConnect('getPublicKey', undefined)).toBe(false);
    expect(gatesConnect('getPublicKey', { identityKey: true })).toBe(true);
  });
  test('regression: a site in use never hits the idle gap, whatever kind of call keeps it alive', () => {
    let s = noteCall(emptyReconnectState(), site, 0);
    // A long session of liveness pings, each well under a day apart, spanning several days.
    for (let t = 1; t <= 5; t++) {
      const now = t * (RECONNECT_GAP_MS - 1000);
      expect(needsReconnect(s, site, now)).toBe(false);
      s = noteCall(s, site, now);
    }
  });
  test('an explicit disconnect asks exactly once on the next real connect', () => {
    let s = noteCall(emptyReconnectState(), site, 1000);
    s = noteDisconnect(s, site, 2000);
    expect(gatesConnect('isAuthenticated', {}) && needsReconnect(s, site, 2100)).toBe(false);
    expect(gatesConnect('getPublicKey', { identityKey: true }) && needsReconnect(s, site, 2200)).toBe(true);
    s = noteReconnected(s, site, 2300);
    expect(needsReconnect(s, site, 2400)).toBe(false);
  });
  test('identity calls that arrive while the reconnect sheet is open share one sheet', async () => {
    const asks = new ReconnectAsks();
    let shown = 0;
    let answer: () => void = () => undefined;
    const show = () => {
      shown++;
      return new Promise<void>((r) => (answer = r));
    };
    const all = [asks.ask(site, show), asks.ask(`https://${site}`, show), asks.ask(site, show)];
    expect(shown).toBe(1);
    answer();
    await Promise.all(all);
    // Answered: a later disconnect would get a fresh sheet.
    void asks.ask(site, show);
    expect(shown).toBe(2);
  });
});
