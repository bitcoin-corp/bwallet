import { fetchNoRedirect } from './sameSiteFetch';
import { BASE_LOOK } from './accents';
import { contrast } from './colour';
import { THEME_PACK_FORMAT, parseThemePack, type ThemeLook, type ThemePack } from './themePack';
import type { ThemeSite } from './themeSites';

/**
 * Site themes (docs/SITE-THEMES.md, owner 22 Oct 2026: "all our sites should provide a theme to bWallet"). A family
 * site (themeSites.ts) publishes its livery at /.well-known/bwalletx-theme.json; the wallet offers it ("Wear DNS DEX
 * colours?") and never applies it on its own. Only colours and short plain text are read: no URLs, CSS, fonts or
 * images, so a site can change how the wallet looks but nothing else. A worn site theme is an ordinary store pack
 * (themePack.ts), saved and applied by accent.ts saveStorePack, and listed in Theme › From sites.
 */
export const SITE_THEME_PATH = '/.well-known/bwalletx-theme.json';
export const SITE_THEME_MAX_BYTES = 4096;
export const SITE_THEME_TIMEOUT_MS = 5000;
/** "Not now" quiets a site's offer for this long (on this device). */
export const NOT_NOW_MS = 30 * 24 * 60 * 60 * 1000;

const COLOURS = [
  'accent',
  'hi',
  'lo',
  'on',
  'bg',
  'surface',
  'surface2',
  'nav',
  'text',
  'muted',
  'line',
  'success',
  'danger',
] as const;
type Colour = (typeof COLOURS)[number];

export type SiteTheme = { v: 1; id: string; label: string; blurb?: string; scheme: 'dark' | 'light' } & Record<
  Colour,
  string
> & { livery?: { stripe?: string; display?: string; label?: string }; badge?: 'bacc' };

const TOP_KEYS = new Set<string>(['v', 'id', 'label', 'blurb', 'scheme', 'livery', 'badge', ...COLOURS]);
const LIVERY_KEYS = new Set(['stripe', 'display', 'label']);
const HEX = /^#[0-9a-f]{6}$/i;
// Plain words only: no markup, no links, nothing that looks like an address.
const PLAIN = /^[\p{L}\p{N} .,'&!·:+-]+$/u;
const URLISH = /:\/\/|www\.|\.(com|net|org|io|app|online|store|website)\b|javascript:|data:/i;
const plain = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && PLAIN.test(v) && !URLISH.test(v);

/** Validates a site's theme file for the family site it came from; null for anything else. */
export function parseSiteTheme(v: unknown, site: Pick<ThemeSite, 'id'>): SiteTheme | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const t = v as Record<string, unknown>;
  if (Object.keys(t).some((k) => !TOP_KEYS.has(k))) return null;
  if (t.v !== 1 || t.id !== site.id) return null;
  if (!plain(t.label, 24)) return null;
  if (t.blurb !== undefined && !plain(t.blurb, 60)) return null;
  if (t.scheme !== 'dark' && t.scheme !== 'light') return null;
  for (const k of COLOURS) if (typeof t[k] !== 'string' || !HEX.test(t[k] as string)) return null;
  if (t.badge !== undefined && t.badge !== 'bacc') return null;
  if (t.livery !== undefined) {
    const l = t.livery as Record<string, unknown> | null;
    if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
    if (Object.keys(l).some((k) => !LIVERY_KEYS.has(k) || !plain(l[k], 32))) return null;
  }
  return t as unknown as SiteTheme;
}

/** Readable enough to wear: text on the page and cards, and on-accent on the accent, at AA (4.5:1). */
export const siteThemeReadable = (t: SiteTheme): boolean =>
  contrast(t.on, t.accent) >= 4.5 && contrast(t.text, t.bg) >= 4.5 && contrast(t.text, t.surface) >= 4.5;

/** The site theme as a store pack (applied like any other; id `site-<id>`). Null if the wallet would refuse it. */
export function siteThemePack(t: SiteTheme): ThemePack | null {
  const { kind: _k, ...base } = BASE_LOOK;
  const look: ThemeLook = { ...base, scheme: t.scheme, pattern: 'stripes' } as ThemeLook;
  for (const k of COLOURS) (look as unknown as Record<string, string>)[k] = t[k].toUpperCase();
  return parseThemePack({
    format: THEME_PACK_FORMAT,
    id: `site-${t.id}`,
    label: t.label,
    ...(t.blurb ? { blurb: t.blurb } : {}),
    creator: `${t.label} theme`,
    tier: 'free',
    preview: [look.bg, look.surface, look.accent],
    look,
  });
}

/**
 * Fetches and checks a family site's theme. Null when there is none, it is too big or slow, it redirected to
 * another host, or it fails the checks: a missing theme is normal and never shown as an error.
 */
export async function fetchSiteTheme(site: ThemeSite, f: typeof fetch = fetch): Promise<ThemePack | null> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), SITE_THEME_TIMEOUT_MS) : null;
  try {
    // Never follows a redirect; apex ↔ www is asked directly (sameSiteFetch.ts).
    const r = await fetchNoRedirect(
      `https://${site.host}${SITE_THEME_PATH}`,
      { credentials: 'omit', cache: 'no-store', ...(ctl ? { signal: ctl.signal } : {}) },
      f,
    );
    if (!r.ok) return null;
    if (r.url) {
      const h = new URL(r.url).hostname.toLowerCase();
      if (h !== site.host && h !== `www.${site.host}`) return null;
    }
    if (Number(r.headers?.get?.('content-length') ?? 0) > SITE_THEME_MAX_BYTES) return null;
    const text = await r.text();
    if (text.length > SITE_THEME_MAX_BYTES) return null;
    const t = parseSiteTheme(JSON.parse(text), site);
    return t && siteThemeReadable(t) ? siteThemePack(t) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const WORN_KEY = 'bwx.siteThemes';
const NOT_NOW_KEY = 'bwx.siteThemes.notNow';
const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
const readJson = (s: Store | null, k: string): unknown => {
  try {
    const v = s?.getItem(k);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
};
const writeJson = (s: Store | null, k: string, v: unknown) => {
  try {
    s?.setItem(k, JSON.stringify(v));
  } catch {
    /* storage blocked or full: the theme still applies this session */
  }
};

/** Site themes this device has worn (Theme › From sites), newest first. */
export const wornSiteThemes = (s: Store | null = local()): ThemePack[] => {
  const v = readJson(s, WORN_KEY);
  return Array.isArray(v) ? v.map(parseThemePack).filter((p): p is ThemePack => !!p && p.id.startsWith('site-')) : [];
};

export const rememberSiteTheme = (pack: ThemePack, s: Store | null = local()): void =>
  writeJson(s, WORN_KEY, [pack, ...wornSiteThemes(s).filter((p) => p.id !== pack.id)].slice(0, 30));

export const forgetSiteTheme = (id: string, s: Store | null = local()): void =>
  writeJson(
    s,
    WORN_KEY,
    wornSiteThemes(s).filter((p) => p.id !== id),
  );

/** "Not now": no offer from this site again for 30 days. */
export const notNowSiteTheme = (siteId: string, now = Date.now(), s: Store | null = local()): void => {
  const v = readJson(s, NOT_NOW_KEY);
  const m = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
  writeJson(s, NOT_NOW_KEY, { ...m, [siteId]: now });
};

/** Whether to offer this site's theme: not quieted in the last 30 days and not already worn here. */
export const shouldOfferSiteTheme = (siteId: string, now = Date.now(), s: Store | null = local()): boolean => {
  const v = readJson(s, NOT_NOW_KEY);
  const at = v && typeof v === 'object' ? (v as Record<string, unknown>)[siteId] : undefined;
  if (typeof at === 'number' && now - at < NOT_NOW_MS) return false;
  return !wornSiteThemes(s).some((p) => p.id === `site-${siteId}`);
};
