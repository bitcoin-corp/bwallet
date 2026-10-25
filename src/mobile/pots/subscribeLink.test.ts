import { beforeEach, describe, expect, test } from 'bun:test';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { parseSubscribeLink, requestLabel, MAX_LINK_USD } = await import('./subscribeLink');
const { memoScript } = await import('./potSend');

const REF = 'bchatx-plus:0123456789abcdef01234567';
const app = `bwalletx://subscribe?service=bchat&plan=plus&usd=0.01&period=day&ref=${encodeURIComponent(REF)}&return=${encodeURIComponent('https://bchatx.com/settings')}`;
const web = `https://web.bwalletx.com/m/settings?subscribe=bchat&plan=plus&usd=0.01&period=day&ref=${encodeURIComponent(REF)}`;
const NOW = Date.parse('2026-10-09T12:00:00Z');

describe('subscribe links (bChatX Plus)', () => {
  beforeEach(() => mem.clear());

  test('the app link prefills a daily 1¢ bChat subscription with the reference', () => {
    expect(parseSubscribeLink(app, NOW, true)).toEqual({
      service: 'bchat',
      plan: 'plus',
      usd: 0.01,
      period: 'day',
      memo: REF,
      returnUrl: 'https://bchatx.com/settings',
      at: NOW,
    });
  });
  test('the web wallet link works too', () => {
    expect(parseSubscribeLink(web, NOW, true)?.memo).toBe(REF);
  });
  test('labelled bChatX Plus', () => {
    expect(requestLabel(parseSubscribeLink(app, NOW, true)!)).toBe('bChatX Plus');
  });
  test('⚠ store build: nothing parses', () => {
    expect(parseSubscribeLink(app, NOW, false)).toBeNull();
    expect(parseSubscribeLink(web, NOW, false)).toBeNull();
  });
  test('⚠ a link carrying a payee is refused', () => {
    expect(parseSubscribeLink(`${app}&address=1BitcoinEaterAddressDontSendf59kuE`, NOW, true)).toBeNull();
    expect(parseSubscribeLink(`${app}&paymail=x@y.com`, NOW, true)).toBeNull();
  });
  test('unknown services, bad amounts, periods and refs are refused', () => {
    expect(parseSubscribeLink(app.replace('service=bchat', 'service=evil'), NOW, true)).toBeNull();
    expect(parseSubscribeLink(app.replace('usd=0.01', `usd=${MAX_LINK_USD + 1}`), NOW, true)).toBeNull();
    expect(parseSubscribeLink(app.replace('usd=0.01', 'usd=-1'), NOW, true)).toBeNull();
    expect(parseSubscribeLink(app.replace('period=day', 'period=hour'), NOW, true)).toBeNull();
    expect(parseSubscribeLink(app.replace(encodeURIComponent(REF), 'nope'), NOW, true)).toBeNull();
  });
  test('a return URL off our hosts is dropped, not followed', () => {
    const r = parseSubscribeLink(
      app.replace(encodeURIComponent('https://bchatx.com/settings'), encodeURIComponent('https://evil.example/x')),
      NOW,
      true,
    );
    expect(r?.returnUrl).toBeNull();
  });
  test('other wallet links are not subscribe links', () => {
    expect(parseSubscribeLink('bwalletx://space/abcdefgh23', NOW, true)).toBeNull();
    expect(parseSubscribeLink('https://web.bwalletx.com/m/settings', NOW, true)).toBeNull();
  });
  test('the memo is an OP_FALSE OP_RETURN push bit-sign can read', () => {
    const hex = memoScript(REF).toHex();
    expect(hex.startsWith('006a')).toBe(true);
    expect(hex).toContain(Buffer.from(REF, 'utf8').toString('hex'));
  });
});

describe('subscription memo rule', () => {
  test('a memo only rides on a service subscription and must be a short reference', async () => {
    const { subMemoProblem } = await import('./pots');
    expect(subMemoProblem({ service: 'bchat', name: 'bChat' }, REF)).toBeNull();
    expect(subMemoProblem({ name: 'Alice', address: '1abc' }, REF)).not.toBeNull();
    expect(subMemoProblem({ service: 'bchat', name: 'bChat' }, 'hello world')).not.toBeNull();
    expect(subMemoProblem({ service: 'bchat', name: 'bChat' }, undefined)).toBeNull();
  });
});
