import { createRequire } from 'node:module';
import { describe, expect, it } from 'bun:test';
import {
  NOT_NOW_MS,
  fetchSiteTheme,
  forgetSiteTheme,
  notNowSiteTheme,
  parseSiteTheme,
  rememberSiteTheme,
  shouldOfferSiteTheme,
  siteThemePack,
  siteThemeReadable,
  wornSiteThemes,
} from './siteTheme';
import { THEME_SITES, familySite } from './themeSites';
import { parseThemePack } from './themePack';

const DNSDEX = { id: 'dnsdex', host: 'dns-dex.com' };
const GOOD = {
  v: 1,
  id: 'dnsdex',
  label: 'DNS DEX',
  blurb: 'Racing green on black',
  scheme: 'dark',
  accent: '#00E676',
  hi: '#5CFFA8',
  lo: '#00C853',
  on: '#010101',
  bg: '#010101',
  surface: '#17191E',
  surface2: '#1F2128',
  nav: '#010101',
  text: '#FFFFFF',
  muted: '#98A2B3',
  line: '#2B2F36',
  success: '#2DD4BF',
  danger: '#F97066',
  livery: { stripe: 'double-bars', display: 'Orbitron', label: 'Racing Sans One' },
  badge: 'bacc',
};

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('parseSiteTheme', () => {
  it('accepts the contract example', () => {
    expect(parseSiteTheme(GOOD, DNSDEX)).not.toBeNull();
    const { livery: _l, badge: _b, blurb: _bl, ...min } = GOOD;
    expect(parseSiteTheme(min, DNSDEX)).not.toBeNull();
  });
  const bad: [string, unknown][] = [
    ['extra key', { ...GOOD, css: 'body{}' }],
    ['extra livery key', { ...GOOD, livery: { stripe: 'x', font: 'y' } }],
    ['non-hex colour', { ...GOOD, accent: 'green' }],
    ['short hex', { ...GOOD, accent: '#0f0' }],
    ['url in label', { ...GOOD, label: 'https://evil.example' }],
    ['domain in label', { ...GOOD, label: 'evil.com' }],
    ['markup in blurb', { ...GOOD, blurb: '<img src=x>' }],
    ['url() in livery', { ...GOOD, livery: { display: 'url(x)' } }],
    ['label too long', { ...GOOD, label: 'A'.repeat(25) }],
    ['blurb too long', { ...GOOD, blurb: 'a'.repeat(61) }],
    ['wrong id', { ...GOOD, id: 'clawdex' }],
    ['v 2', { ...GOOD, v: 2 }],
    ['no scheme', { ...GOOD, scheme: 'dim' }],
    ['other badge', { ...GOOD, badge: 'other' }],
    ['array', [GOOD]],
    ['null', null],
  ];
  for (const [name, v] of bad) it(`rejects ${name}`, () => expect(parseSiteTheme(v, DNSDEX)).toBeNull());
});

describe('contrast guard and pack', () => {
  it('passes a readable theme and builds a valid store pack', () => {
    const t = parseSiteTheme(GOOD, DNSDEX)!;
    expect(siteThemeReadable(t)).toBe(true);
    const p = siteThemePack(t)!;
    expect(p.id).toBe('site-dnsdex');
    expect(p.creator).toBe('DNS DEX theme');
    expect(p.look.accent).toBe('#00E676');
    expect(parseThemePack(JSON.parse(JSON.stringify(p)))).not.toBeNull();
  });
  it("badvertisingx.com's bAds file (gold b on warm black) is a family theme the wallet will wear", () => {
    const site = familySite('https://badvertisingx.com/campaign')!;
    expect(site.id).toBe('badvertisingx');
    const t = parseSiteTheme(
      {
        v: 1,
        id: 'badvertisingx',
        label: 'bAds',
        blurb: 'Gold b on warm black',
        scheme: 'dark',
        accent: '#F5B800',
        hi: '#FFD24D',
        lo: '#C99700',
        on: '#120F05',
        bg: '#0B0A09',
        surface: '#121110',
        surface2: '#1A1816',
        nav: '#0B0A09',
        text: '#F3ECDC',
        muted: '#A39D90',
        line: '#2A2724',
        success: '#5FD38A',
        danger: '#F97066',
        livery: { display: 'Space Grotesk', label: 'IBM Plex Mono' },
      },
      site,
    )!;
    expect(siteThemeReadable(t)).toBe(true);
    expect(siteThemePack(t)!.id).toBe('site-badvertisingx');
  });
  it('refuses unreadable colours', () => {
    expect(siteThemeReadable(parseSiteTheme({ ...GOOD, on: '#00C853' }, DNSDEX)!)).toBe(false);
    expect(siteThemeReadable(parseSiteTheme({ ...GOOD, text: '#111111' }, DNSDEX)!)).toBe(false);
  });
});

describe('fetchSiteTheme', () => {
  const res = (body: string, url = 'https://dns-dex.com/.well-known/bwalletx-theme.json', ok = true) =>
    ({ ok, url, headers: new Headers(), text: async () => body }) as unknown as Response;
  it('fetches the well-known file from the site, credentials omitted', async () => {
    let asked = '';
    let init: RequestInit | undefined;
    const p = await fetchSiteTheme(DNSDEX, (async (u: string, i?: RequestInit) => {
      asked = u;
      init = i;
      return res(JSON.stringify(GOOD));
    }) as unknown as typeof fetch);
    expect(asked).toBe('https://dns-dex.com/.well-known/bwalletx-theme.json');
    expect(init?.credentials).toBe('omit');
    expect(p?.id).toBe('site-dnsdex');
  });
  it('refuses a redirect to another host, oversized files, errors and junk', async () => {
    const f = (r: Response) => (async () => r) as unknown as typeof fetch;
    expect(await fetchSiteTheme(DNSDEX, f(res(JSON.stringify(GOOD), 'https://evil.example/t.json')))).toBeNull();
    expect(await fetchSiteTheme(DNSDEX, f(res(JSON.stringify({ ...GOOD, blurb: 'x'.repeat(5000) }))))).toBeNull();
    expect(await fetchSiteTheme(DNSDEX, f(res('{}', undefined, false)))).toBeNull();
    expect(await fetchSiteTheme(DNSDEX, f(res('not json')))).toBeNull();
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchSiteTheme(DNSDEX, boom)).toBeNull();
  });
});

describe('offer memory', () => {
  it('Not now quiets a site for 30 days', () => {
    const s = memStore();
    const now = 1_000_000_000_000;
    expect(shouldOfferSiteTheme('dnsdex', now, s)).toBe(true);
    notNowSiteTheme('dnsdex', now, s);
    expect(shouldOfferSiteTheme('dnsdex', now + NOT_NOW_MS - 1, s)).toBe(false);
    expect(shouldOfferSiteTheme('clawdex', now, s)).toBe(true);
    expect(shouldOfferSiteTheme('dnsdex', now + NOT_NOW_MS + 1, s)).toBe(true);
  });
  it('a worn theme is listed, not offered again, and can be removed', () => {
    const s = memStore();
    const p = siteThemePack(parseSiteTheme(GOOD, DNSDEX)!)!;
    rememberSiteTheme(p, s);
    expect(wornSiteThemes(s).map((x) => x.id)).toEqual(['site-dnsdex']);
    expect(shouldOfferSiteTheme('dnsdex', Date.now(), s)).toBe(false);
    forgetSiteTheme('site-dnsdex', s);
    expect(wornSiteThemes(s)).toEqual([]);
  });
  it('survives broken storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(shouldOfferSiteTheme('dnsdex', Date.now(), broken)).toBe(true);
    expect(() => notNowSiteTheme('dnsdex', Date.now(), broken)).not.toThrow();
    expect(wornSiteThemes(broken)).toEqual([]);
  });
});

describe('family sites', () => {
  it('matches the host or www., https only, nothing else', () => {
    expect(familySite('https://dns-dex.com/market')?.id).toBe('dnsdex');
    expect(familySite('https://www.dns-dex.com')?.id).toBe('dnsdex');
    expect(familySite('dns-dex.com')?.id).toBe('dnsdex');
    expect(familySite('DNS-DEX.COM.')?.id).toBe('dnsdex');
    expect(familySite('https://race.bwalletx.com/race')?.id).toBe('bacc-race');
    expect(familySite('http://dns-dex.com')).toBeNull();
    expect(familySite('https://dns-dex.com:8443')).toBeNull();
    expect(familySite('https://evil.dns-dex.com')).toBeNull();
    expect(familySite('https://dns-dex.com.evil.example')).toBeNull();
    expect(familySite('https://notdns-dex.com')).toBeNull();
    expect(familySite('https://user@dns-dex.com')).toBeNull();
    expect(familySite('')).toBeNull();
    expect(familySite(null)).toBeNull();
  });
  it('equals site/lib/themeSites.js (served at /api/theme-sites)', () => {
    const req = createRequire(import.meta.url);
    const { THEME_SITES: served } = req('../../../site/lib/themeSites.js') as { THEME_SITES: unknown };
    expect(served).toEqual(THEME_SITES as unknown);
  });
  it('ids and hosts are unique and well formed', () => {
    expect(new Set(THEME_SITES.map((s) => s.id)).size).toBe(THEME_SITES.length);
    expect(new Set(THEME_SITES.map((s) => s.host)).size).toBe(THEME_SITES.length);
    for (const s of THEME_SITES) {
      expect(s.id).toMatch(/^[a-z0-9][a-z0-9-]{1,31}$/);
      expect(s.host).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
    }
  });
  it('every Sign in with bWalletX client site except localhost is a family site', () => {
    const req = createRequire(import.meta.url);
    const { CLIENTS } = req('../../../site/lib/authClients.js') as {
      CLIENTS: Record<string, { site: string }>;
    };
    for (const c of Object.values(CLIENTS)) if (c.site !== 'localhost') expect(familySite(c.site)).not.toBeNull();
  });
});

describe('site/api/themes.js ?list=sites', () => {
  it('serves the family list', () => {
    const req = createRequire(import.meta.url);
    const handler = req('../../../site/api/themes.js') as (q: unknown, r: unknown) => void;
    let body = '';
    let status = 0;
    handler(
      { method: 'GET', url: '/api/themes?list=sites' },
      {
        set statusCode(v: number) {
          status = v;
        },
        setHeader: () => undefined,
        end: (b?: string) => void (body = b ?? ''),
      },
    );
    expect(status).toBe(200);
    expect((JSON.parse(body) as { sites: unknown }).sites).toEqual(THEME_SITES as unknown);
  });
});
