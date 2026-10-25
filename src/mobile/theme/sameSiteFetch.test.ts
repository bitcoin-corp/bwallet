import { describe, expect, test } from 'bun:test';
import { apexWwwSwap, fetchNoRedirect, sameSiteOrigin } from './sameSiteFetch';

describe('theme fetches never follow redirects', () => {
  test('ATTACK: a redirect to a LAN address is never requested', async () => {
    const asked: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      asked.push(url);
      expect(init.redirect).toBe('error');
      // What a browser does with redirect 'error' when the server answers 302 → http://192.168.1.1/
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchNoRedirect('https://evil.com/.well-known/bwalletx-theme.json', {}, f)).rejects.toThrow();
    expect(asked).toEqual([
      'https://evil.com/.well-known/bwalletx-theme.json',
      'https://www.evil.com/.well-known/bwalletx-theme.json',
    ]);
  });
  test('apex ↔ www still works', async () => {
    const f = (async (url: string) => {
      if (!url.includes('www.')) throw new TypeError('redirect');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    expect((await fetchNoRedirect('https://a.com/t.json', {}, f)).ok).toBe(true);
    expect(apexWwwSwap('https://www.a.com/x')).toBe('https://a.com/x');
    expect(sameSiteOrigin('https://www.a.com/x', 'https://a.com')).toBe(true);
    expect(sameSiteOrigin('https://a.com.evil.net/x', 'https://a.com')).toBe(false);
    expect(sameSiteOrigin('http://www.a.com/x', 'https://a.com')).toBe(false);
  });
});
