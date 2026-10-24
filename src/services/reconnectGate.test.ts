import { describe, expect, test } from 'bun:test';
import {
  RECONNECT_GAP_MS,
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
});
