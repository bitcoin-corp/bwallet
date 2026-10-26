const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const page = require('../pair.js');

const Q =
  '?v=1&r=relay.bwallet.space&c=AAAA&k=02ab&o=https%3A%2F%2Fwww.tokenblaster.lol&e=9&s=30aa' +
  '&ret=https%3A%2F%2Fwww.tokenblaster.lol%2Fplay&rid=r1d_r1d_r1d_r1d_r1d_r1&b=chrome&s2=30bb';

describe('site/pair.html on a phone', () => {
  test('phones are told apart from computers (iPadOS reports a Mac with touch)', () => {
    expect(page.phoneKind('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe('ios');
    expect(page.phoneKind('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 5)).toBe('android');
    expect(page.phoneKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 5)).toBe('ios');
    expect(page.phoneKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 0)).toBeNull();
    expect(page.phoneKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0)).toBeNull();
  });

  test('the app, web wallet and store links carry the same request (and only pairing params)', () => {
    const q = page.pairQuery(`${Q}&evil=1`);
    expect(q).not.toContain('evil');
    for (const k of ['s', 'ret', 'rid', 'b', 's2']) expect(new URLSearchParams(q).has(k)).toBe(true);
    const ios = page.links(Q, 'ios');
    expect(ios.app).toBe(`bwalletx://pair?${q}`);
    expect(ios.web).toBe(`https://web.bwalletx.com/m/settings?bwxpair=1&${q}`);
    expect(ios.get).toBe('https://www.bwallet.space/get');
    const android = page.links(Q, 'android');
    expect(android.app.startsWith(`intent://pair?${q}#Intent;scheme=bwalletx;`)).toBe(true);
    expect(android.app).toContain(`S.browser_fallback_url=${encodeURIComponent('https://www.bwallet.space/get')}`);
  });

  test('a bare /pair visit has no request to hand on', () => {
    expect(page.links('', 'ios')).toBeNull();
  });

  test('no QR anywhere; "your computer" only in the desktop section', () => {
    const html = readFileSync(join(__dirname, '../pair.html'), 'utf8');
    expect(html).not.toMatch(/<canvas|qrcode|qrSvg/i);
    const start = html.indexOf('<section class="phone">');
    const phone = html.slice(start, html.indexOf('</section>', start));
    expect(phone).not.toMatch(/computer/i);
    expect(phone).toContain('Open in the bWallet app');
    expect(phone).toContain('Use the web wallet');
    expect(phone).toContain('Get bWallet');
  });
});
