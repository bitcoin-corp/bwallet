import { describe, expect, it } from 'bun:test';
import {
  FETCH_TIMEOUT_MS,
  LOGO_MAX_BYTES,
  fetchConnectTheme,
  loadConnectTheme,
  markSiteConnected,
  parseConnectTheme,
  sameOriginImage,
  setSiteThemeAllowed,
  setSiteThemesOn,
  shouldWearSiteTheme,
  siteConnected,
  forgetSiteConnected,
  themeOrigin,
} from './connectSiteTheme';

const O = 'https://emberandbean.example';
const GOOD = {
  v: 2,
  name: 'Ember & Bean',
  mode: 'dark',
  accent: '#E8B04A',
  accentHi: '#F6D08A',
  bg: '#0F2A1F',
  surface: '#173A2C',
  text: '#F5EBDD',
  logo: '/brand/logo.png',
};

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

type Route = { status?: number; body: string | Uint8Array; type?: string; url?: string };
const fakeFetch = (routes: Record<string, Route>, calls: string[] = []) =>
  (async (input: string | URL) => {
    const u = String(input);
    calls.push(u);
    const r = routes[u];
    if (!r) return new Response('nope', { status: 404 });
    const res = new Response(r.body, {
      status: r.status ?? 200,
      headers: { 'content-type': r.type ?? 'application/json' },
    });
    Object.defineProperty(res, 'url', { value: r.url ?? u });
    return res;
  }) as unknown as typeof fetch;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('parseConnectTheme', () => {
  it('accepts a good theme and resolves the logo on the same origin', () => {
    const p = parseConnectTheme(GOOD, O);
    expect(p.theme?.name).toBe('Ember & Bean');
    expect(p.theme?.logo).toBe(`${O}/brand/logo.png`);
    expect(p.theme?.accent).toBe('#E8B04A');
  });

  it('refuses colours that are not #RRGGBB', () => {
    for (const bad of ['red', '#fff', 'rgb(0,0,0)', '#12345G', 'var(--x)', '#000000; background:url(x)'])
      expect(parseConnectTheme({ ...GOOD, accent: bad }, O).theme).toBeUndefined();
  });

  it('refuses unknown keys, CSS strings and names that carry links', () => {
    expect(parseConnectTheme({ ...GOOD, css: 'body{}' }, O).theme).toBeUndefined();
    expect(parseConnectTheme({ ...GOOD, name: 'Visit https://evil.example' }, O).theme).toBeUndefined();
    expect(parseConnectTheme({ ...GOOD, name: '<b>x</b>' }, O).theme).toBeUndefined();
    expect(parseConnectTheme({ ...GOOD, mode: 'auto' }, O).theme).toBeUndefined();
    expect(parseConnectTheme({ ...GOOD, v: 3 }, O).theme).toBeUndefined();
  });

  it('refuses a logo on another origin, http, or javascript:', () => {
    for (const logo of [
      'https://cdn.other.example/logo.png',
      '//evil.example/x.png',
      'http://emberandbean.example/x.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'https://user:pw@emberandbean.example/x.png',
    ])
      expect(parseConnectTheme({ ...GOOD, logo }, O).theme).toBeUndefined();
    expect(sameOriginImage(`${O}/a.png`, O)).toBe(`${O}/a.png`);
  });

  it('auto-fixes unreadable text to black or white', () => {
    const p = parseConnectTheme({ ...GOOD, text: '#173A2C' }, O);
    expect(p.theme?.text).toBe('#FFFFFF');
    expect(p.theme ? (p as { fixed: string[] }).fixed : []).toEqual(['text']);
  });

  it('refuses when bg and surface leave no readable text, or the accent is invisible', () => {
    // mid-grey page with near-white cards: neither black nor white reaches 4.5:1 on both.
    expect(parseConnectTheme({ ...GOOD, bg: '#767676', surface: '#F0F0F0' }, O).theme).toBeUndefined();
    expect(parseConnectTheme({ ...GOOD, accent: '#10291E' }, O).theme).toBeUndefined();
  });
});

describe('themeOrigin', () => {
  it('maps hosts to https origins and refuses paired, paths and junk', () => {
    expect(themeOrigin('emberandbean.example')).toBe(O);
    expect(themeOrigin('https://emberandbean.example')).toBe(O);
    expect(themeOrigin('localhost:5173')).toBe('http://localhost:5173');
    expect(themeOrigin('bwalletx.com.paired.invalid')).toBeNull();
    expect(themeOrigin('evil.example/x')).toBeNull();
    expect(themeOrigin('a@b.example')).toBeNull();
    expect(themeOrigin('intranet')).toBeNull();
    expect(themeOrigin('')).toBeNull();
  });
});

describe('fetchConnectTheme', () => {
  it('fetches the theme and its logo as a data: URL', async () => {
    const f = fakeFetch({
      [`${O}/.well-known/bwalletx-theme.json`]: { body: JSON.stringify(GOOD) },
      [`${O}/brand/logo.png`]: { body: PNG, type: 'image/png' },
    });
    const t = await fetchConnectTheme(O, f);
    expect(t?.name).toBe('Ember & Bean');
    expect(t?.logoData?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('falls back to the theme object in bapp.json', async () => {
    const { v: _v, name: _n, ...theme } = GOOD;
    const f = fakeFetch({ [`${O}/.well-known/bapp.json`]: { body: JSON.stringify({ name: 'Ember & Bean', theme }) } });
    expect((await fetchConnectTheme(O, f))?.bg).toBe('#0F2A1F');
  });

  it('drops a logo that is too big or not an image, keeping the colours', async () => {
    const big = fakeFetch({
      [`${O}/.well-known/bwalletx-theme.json`]: { body: JSON.stringify(GOOD) },
      [`${O}/brand/logo.png`]: { body: new Uint8Array(LOGO_MAX_BYTES + 1), type: 'image/png' },
    });
    const t = await fetchConnectTheme(O, big);
    expect(t?.name).toBe('Ember & Bean');
    expect(t?.logoData).toBeUndefined();
    const html = fakeFetch({
      [`${O}/.well-known/bwalletx-theme.json`]: { body: JSON.stringify(GOOD) },
      [`${O}/brand/logo.png`]: { body: '<script>', type: 'text/html' },
    });
    expect((await fetchConnectTheme(O, html))?.logoData).toBeUndefined();
  });

  it('refuses a theme file that redirected to another origin, or is oversized', async () => {
    const redirected = fakeFetch({
      [`${O}/.well-known/bwalletx-theme.json`]: { body: JSON.stringify(GOOD), url: 'https://evil.example/t.json' },
    });
    expect(await fetchConnectTheme(O, redirected)).toBeNull();
    const huge = fakeFetch({ [`${O}/.well-known/bwalletx-theme.json`]: { body: ' '.repeat(9000) + '{}' } });
    expect(await fetchConnectTheme(O, huge)).toBeNull();
  });

  it('gives up after the timeout', async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await fetchConnectTheme(O, hang)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FETCH_TIMEOUT_MS - 50);
  }, 15000);
});

describe('connected origins, cache and switches', () => {
  const routes = {
    [`${O}/.well-known/bwalletx-theme.json`]: { body: JSON.stringify({ ...GOOD, logo: undefined }) },
  };

  it('never fetches for a site the user has not approved', async () => {
    const s = mem();
    const calls: string[] = [];
    expect(await loadConnectTheme('emberandbean.example', { s, f: fakeFetch(routes, calls) })).toBeNull();
    expect(calls).toEqual([]);
    expect(shouldWearSiteTheme('emberandbean.example', s)).toBe(false);
  });

  it('wears the theme only for the connected origin, and caches it', async () => {
    const s = mem();
    const calls: string[] = [];
    const f = fakeFetch(routes, calls);
    markSiteConnected('emberandbean.example', s, f);
    expect(siteConnected('emberandbean.example', s)).toBe(true);
    expect(shouldWearSiteTheme('emberandbean.example', s)).toBe(true);
    expect(shouldWearSiteTheme('other.example', s)).toBe(false);
    const t = await loadConnectTheme('emberandbean.example', { s, f });
    expect(t?.origin).toBe(O);
    const n = calls.length;
    await loadConnectTheme('emberandbean.example', { s, f });
    expect(calls.length).toBe(n); // cached
    // A day later it asks again.
    await loadConnectTheme('emberandbean.example', { s, f, now: Date.now() + 25 * 3600 * 1000 });
    expect(calls.length).toBeGreaterThan(n);
  });

  it('per-site toggle and the global switch turn it off; revoking forgets the site', () => {
    const s = mem();
    markSiteConnected('emberandbean.example', s, fakeFetch(routes));
    setSiteThemeAllowed('emberandbean.example', false, s);
    expect(shouldWearSiteTheme('emberandbean.example', s)).toBe(false);
    setSiteThemeAllowed('emberandbean.example', true, s);
    expect(shouldWearSiteTheme('emberandbean.example', s)).toBe(true);
    setSiteThemesOn(false, s);
    expect(shouldWearSiteTheme('emberandbean.example', s)).toBe(false);
    setSiteThemesOn(true, s);
    forgetSiteConnected('emberandbean.example', s);
    expect(shouldWearSiteTheme('emberandbean.example', s)).toBe(false);
  });
});
