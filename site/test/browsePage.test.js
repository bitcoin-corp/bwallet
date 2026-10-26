const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const page = require('../browse.js');

const T = 'https://www.tokenblaster.lol/terrornode';
const Q = `?url=${encodeURIComponent(T)}`;

describe('site/browse.html (app not installed)', () => {
  test('https targets only, host shown, app retry and store links', () => {
    const ios = page.links(Q, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    expect(ios.target).toBe(T);
    expect(ios.host).toBe('www.tokenblaster.lol');
    expect(ios.app).toBe(`bwalletx://browse?url=${encodeURIComponent(T)}`);
    expect(ios.get).toBe('https://www.bwallet.space/get');
    const android = page.links(Q, 'Mozilla/5.0 (Linux; Android 15)');
    expect(android.app.startsWith(`intent://browse?url=${encodeURIComponent(T)}#Intent;scheme=bwalletx;`)).toBe(true);
    expect(android.app).toContain(`S.browser_fallback_url=${encodeURIComponent(T)};end`);
  });
  test('ATTACK: non-https and userinfo targets get nothing', () => {
    for (const u of ['http://x.example/', 'javascript:alert(1)', 'https://a:b@x.example/', ''])
      expect(page.links(`?url=${encodeURIComponent(u)}`, '')).toBeNull();
  });
  test('the page has a Get bWallet banner and never redirects on its own', () => {
    const html = readFileSync(join(__dirname, '../browse.html'), 'utf8');
    const js = readFileSync(join(__dirname, '../browse.js'), 'utf8');
    expect(html).toContain('class="banner"');
    expect(html).toContain('Get bWallet');
    expect(html + js).not.toMatch(/http-equiv="refresh"|location\.(href|assign|replace)\s*[=(]/);
  });
});
