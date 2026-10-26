import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { isPeerPayUri, parsePeerPay, peerPayUri } from './peerpay';
import { parseScan } from './parseScan';

// The spec's own example key (BRC-125).
const KEY = '020307452080baba84b28027a4f4152fd9d29bb4f9c966684f71e7f9427380f2a4';

describe('parsePeerPay (BRC-125)', () => {
  test('the spec examples', () => {
    expect(parsePeerPay(`peerpay:${KEY}?sats=12345`)).toEqual({ key: KEY, amountSats: 12345 });
    expect(parsePeerPay(`peerpay:${KEY}`)).toEqual({ key: KEY });
  });
  test('scheme is case-insensitive; whitespace trimmed; fragment ignored', () => {
    expect(parsePeerPay(`  PeerPay:${KEY}?sats=5  `)).toEqual({ key: KEY, amountSats: 5 });
    expect(parsePeerPay(`PEERPAY:${KEY}#x`)).toEqual({ key: KEY });
  });
  test('sats=0 is unspecified; malformed sats are ignored, never guessed', () => {
    for (const q of ['sats=0', 'sats=', 'sats=-5', 'sats=1.5', 'sats=1e3', 'sats=99999999999999999', 'SATS=5'])
      expect(parsePeerPay(`peerpay:${KEY}?${q}`)).toEqual({ key: KEY });
  });
  test('unknown parameters are ignored', () => {
    expect(parsePeerPay(`peerpay:${KEY}?memo=hi&sats=7&x`)).toEqual({ key: KEY, amountSats: 7 });
  });
  test('SECURITY: invalid keys are rejected (funds would be lost)', () => {
    for (const k of [
      KEY.toUpperCase(), // spec: lowercase only
      KEY.slice(0, 64),
      `${KEY}00`,
      `04${KEY.slice(2)}`, // not a compressed prefix
      `02${'f'.repeat(64)}`, // x beyond the field: not on the curve
      `02${'0'.repeat(64)}`,
      '',
    ])
      expect(parsePeerPay(`peerpay:${k}?sats=1`)).toBeNull();
    expect(parsePeerPay(`bitcoin:${KEY}`)).toBeNull();
    expect(parsePeerPay(null)).toBeNull();
  });
  test('random valid keys round-trip through peerPayUri', () => {
    for (let i = 0; i < 20; i++) {
      const k = PrivateKey.fromRandom().toPublicKey().toString();
      expect(parsePeerPay(peerPayUri(k, 1000 + i))).toEqual({ key: k, amountSats: 1000 + i });
      expect(parsePeerPay(peerPayUri(k))).toEqual({ key: k });
    }
  });
  test('isPeerPayUri', () => {
    expect(isPeerPayUri(' peerpay:zzz')).toBe(true);
    expect(isPeerPayUri('bitcoin:1abc')).toBe(false);
  });
});

describe('parseScan: peerpay', () => {
  test('a valid link pre-fills Send (pay, never more)', () => {
    expect(parseScan(`peerpay:${KEY}?sats=12345`)).toEqual({ kind: 'pay', to: KEY, amountSats: 12345, peerpay: true });
    expect(parseScan(`peerpay:${KEY}`)).toEqual({ kind: 'pay', to: KEY, peerpay: true });
  });
  test('an invalid link is shown as text, never as a payment', () => {
    expect(parseScan(`peerpay:${KEY.toUpperCase()}?sats=5`).kind).toBe('text');
    expect(parseScan('peerpay:hello').kind).toBe('text');
  });
});

describe('deep links: held, then pre-fill only', () => {
  test('offer → take; invalid links are dropped; nothing sends', async () => {
    const { offerPeerPayLink, takePeerPayLink, onPeerPayLink } = await import('./peerpayLinks');
    let heard = 0;
    const off = onPeerPayLink(() => heard++);
    expect(offerPeerPayLink('peerpay:nope')).toBe(false);
    expect(takePeerPayLink()).toBeNull();
    expect(offerPeerPayLink(`peerpay:${KEY}?sats=9`)).toBe(true);
    expect(heard).toBe(1);
    expect(takePeerPayLink()).toEqual({ key: KEY, amountSats: 9 });
    expect(takePeerPayLink()).toBeNull();
    off();
  });
});
