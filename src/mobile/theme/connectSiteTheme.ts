import { isPairedHost } from '../../services/originKey';
import { contrast } from './colour';

/**
 * Connected-site themes (docs/SITE-THEME.md; owner, 23 Oct 2026: "every site that connects to bWallet needs a theme
 * JSON that tells the wallet what it should look like when connected"). Part of the Theme edition on
 * bwalletx.com/themes/custom.
 *
 * A site publishes a small JSON theme (/.well-known/bwalletx-theme.json, `v: 2`, or a `theme` object in
 * /.well-known/bapp.json). Once the user has approved a connection from that origin, the wallet fetches it and the
 * site's approval sheets wear it: a banner in the site's colours with its logo. The wallet's own strip above it
 * (true origin host, never themed) and everything that decides a payment or signature (amounts, recipients,
 * warnings, Approve / Deny) keep the wallet's fixed styling.
 *
 * Only `#RRGGBB` colours, one plain-text name, a mode, and same-origin https image URLs are read. No CSS, fonts,
 * scripts or other values. Images are fetched by the wallet, size-capped and kept as data: URLs.
 */
export const CONNECT_THEME_PATH = '/.well-known/bwalletx-theme.json';
export const BAPP_MANIFEST_PATH = '/.well-known/bapp.json';
export const THEME_MAX_BYTES = 8 * 1024;
export const LOGO_MAX_BYTES = 64 * 1024;
export const ART_MAX_BYTES = 256 * 1024;
export const FETCH_TIMEOUT_MS = 4000;
/** A fetched theme is reused for a day; a site with none is asked again after an hour. */
export const CACHE_MS = 24 * 60 * 60 * 1000;
export const MISS_CACHE_MS = 60 * 60 * 1000;

export type ConnectTheme = {
  name: string;
  mode: 'dark' | 'light';
  accent: string;
  accentHi: string;
  /** Text on the accent (black or white, whichever reads). */
  onAccent: string;
  bg: string;
  surface: string;
  text: string;
  /** Same-origin https URL as declared (validated). */
  logo?: string;
  cardArt?: string;
};

/** A theme ready to paint: images already fetched and checked. */
export type WornTheme = ConnectTheme & { origin: string; logoData?: string; artData?: string };

const KEYS = new Set([
  '$schema',
  'v',
  'name',
  'mode',
  'accent',
  'accentHi',
  'bg',
  'surface',
  'text',
  'logo',
  'cardArt',
]);
const HEX = /^#[0-9a-f]{6}$/i;
// Plain words: no markup, links or addresses.
const PLAIN = /^[\p{L}\p{N} .,'&!·:+-]+$/u;
const URLISH = /:\/\/|www\.|javascript:|data:/i;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

/**
 * The https origin the wallet fetches from for a BRC-100 originator, or null. Paired sessions (".paired.invalid")
 * never get a theme: their origin is only a relay hint (originKey.ts, audit H1), and a theme must not lend an
 * unproven origin a real site's look. Loopback is allowed over http for local development.
 */
export function themeOrigin(originator: string | null | undefined): string | null {
  const raw = (originator ?? '').trim();
  if (!raw || raw.length > 260 || /[\s/\\@?#]/.test(raw.replace(/^https?:\/\//, ''))) return null;
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) return null;
    const host = u.hostname.toLowerCase();
    if (isPairedHost(host)) return null;
    const loop = host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host);
    if (loop) return `http://${u.host}`;
    if (u.protocol !== 'https:' || !host.includes('.')) return null;
    return `https://${u.host}`;
  } catch {
    return null;
  }
}

/** The host to show in the wallet's own strip for an originator (never from the theme). */
export const trueHost = (originator: string): string =>
  originator
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();

/** A same-origin image URL from the theme, resolved against the site, or null. */
export function sameOriginImage(raw: unknown, origin: string): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 512 || /[\s\\]/.test(raw)) return null;
  try {
    const u = new URL(raw, `${origin}/`);
    if (u.origin !== origin || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

const bestOn = (bg: string) => (contrast('#FFFFFF', bg) >= contrast('#000000', bg) ? '#FFFFFF' : '#000000');

export type ParseResult = { theme: ConnectTheme; fixed: string[] } | { theme?: undefined; error: string };

/**
 * Validates a theme object for `origin`. Unreadable text is auto-fixed to black or white (listed in `fixed`); if
 * even that cannot reach 4.5:1 on both the page and the cards, or the accent can't be seen at 3:1, it is refused.
 */
export function parseConnectTheme(v: unknown, origin: string): ParseResult {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'not an object' };
  const t = v as Record<string, unknown>;
  const extra = Object.keys(t).find((k) => !KEYS.has(k));
  if (extra) return { error: `unknown key ${extra}` };
  if (t.v !== undefined && t.v !== 2) return { error: 'v must be 2' };
  if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 32 || !PLAIN.test(t.name) || URLISH.test(t.name))
    return { error: 'name' };
  if (t.mode !== 'dark' && t.mode !== 'light') return { error: 'mode' };
  for (const k of ['accent', 'bg', 'surface', 'text'] as const)
    if (typeof t[k] !== 'string' || !HEX.test(t[k] as string)) return { error: `${k} must be #RRGGBB` };
  if (t.accentHi !== undefined && (typeof t.accentHi !== 'string' || !HEX.test(t.accentHi)))
    return { error: 'accentHi must be #RRGGBB' };
  const up = (s: unknown) => (s as string).toUpperCase();
  const bg = up(t.bg);
  const surface = up(t.surface);
  const accent = up(t.accent);
  let text = up(t.text);
  const fixed: string[] = [];
  const reads = (c: string) => contrast(c, bg) >= 4.5 && contrast(c, surface) >= 4.5;
  if (!reads(text)) {
    const alt = ['#FFFFFF', '#000000'].find(reads);
    if (!alt) return { error: 'bg and surface leave no readable text colour' };
    text = alt;
    fixed.push('text');
  }
  if (contrast(accent, bg) < 3) return { error: 'accent is not visible on bg (needs 3:1)' };
  let logo: string | undefined;
  if (t.logo !== undefined) {
    const l = sameOriginImage(t.logo, origin);
    if (!l) return { error: 'logo must be a same-origin URL' };
    logo = l;
  }
  let cardArt: string | undefined;
  if (t.cardArt !== undefined) {
    const a = sameOriginImage(t.cardArt, origin);
    if (!a) return { error: 'cardArt must be a same-origin URL' };
    cardArt = a;
  }
  return {
    theme: {
      name: t.name.trim(),
      mode: t.mode,
      accent,
      accentHi: t.accentHi ? up(t.accentHi) : accent,
      onAccent: bestOn(accent),
      bg,
      surface,
      text,
      ...(logo ? { logo } : {}),
      ...(cardArt ? { cardArt } : {}),
    },
    fixed,
  };
}

/** A family site's v1 file (docs/SITE-THEMES.md) read as a connect theme: same colours, no images. */
function fromV1(v: Record<string, unknown>): Record<string, unknown> | null {
  if (v.v !== 1) return null;
  return {
    v: 2,
    name: v.label,
    mode: v.scheme,
    accent: v.accent,
    accentHi: v.hi,
    bg: v.bg,
    surface: v.surface,
    text: v.text,
  };
}

type Fetch = typeof fetch;

async function fetchCapped(
  url: string,
  origin: string,
  max: number,
  f: Fetch,
): Promise<{ type: string; bytes: Uint8Array } | null> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const r = await f(url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (!r.ok) return null;
    if (r.url && new URL(r.url).origin !== origin) return null; // no redirect to another site
    if (Number(r.headers?.get?.('content-length') ?? 0) > max) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.byteLength > max) return null;
    const type = (r.headers?.get?.('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    return { type, bytes };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const toBase64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

async function fetchImage(url: string | undefined, origin: string, max: number, f: Fetch): Promise<string | undefined> {
  if (!url) return undefined;
  const r = await fetchCapped(url, origin, max, f);
  if (!r || !IMAGE_TYPES.includes(r.type)) return undefined;
  return `data:${r.type};base64,${toBase64(r.bytes)}`;
}

const readJson = async (url: string, origin: string, f: Fetch): Promise<unknown> => {
  const r = await fetchCapped(url, origin, THEME_MAX_BYTES, f);
  if (!r) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(r.bytes));
  } catch {
    return undefined;
  }
};

/**
 * Fetches and checks a site's theme: /.well-known/bwalletx-theme.json first (v2, or a family v1 file), then the
 * `theme` object of /.well-known/bapp.json. Null when there is none or it fails the checks; a missing theme is
 * normal and never an error. No cookies, 4 s timeout, size caps, no cross-origin redirects.
 */
export async function fetchConnectTheme(origin: string, f: Fetch = fetch): Promise<WornTheme | null> {
  const candidates: unknown[] = [];
  const file = await readJson(`${origin}${CONNECT_THEME_PATH}`, origin, f);
  if (file && typeof file === 'object') {
    const o = file as Record<string, unknown>;
    candidates.push(o.v === 1 ? fromV1(o) : o);
  }
  if (!candidates.length) {
    const manifest = await readJson(`${origin}${BAPP_MANIFEST_PATH}`, origin, f);
    const th = manifest && typeof manifest === 'object' ? (manifest as Record<string, unknown>).theme : undefined;
    if (th && typeof th === 'object') {
      const name = (manifest as Record<string, unknown>).name;
      candidates.push({ ...(typeof name === 'string' ? { name } : {}), ...(th as object) });
    }
  }
  for (const c of candidates) {
    const p = parseConnectTheme(c, origin);
    if (!p.theme) continue;
    const [logoData, artData] = await Promise.all([
      fetchImage(p.theme.logo, origin, LOGO_MAX_BYTES, f),
      fetchImage(p.theme.cardArt, origin, ART_MAX_BYTES, f),
    ]);
    return { ...p.theme, origin, ...(logoData ? { logoData } : {}), ...(artData ? { artData } : {}) };
  }
  return null;
}

// ---- per-device state (localStorage: prompt.html shares the wallet page's origin in every build) ----

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const CACHE_KEY = 'bwx.connectTheme.cache';
const CONNECTED_KEY = 'bwx.connectTheme.connected';
const SITE_OFF_KEY = 'bwx.connectTheme.siteOff';
export const GLOBAL_OFF_KEY = 'bwx.connectTheme.off';
export const CONNECT_THEME_EVENT = 'bwx-connect-theme';

const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
const get = (s: Store | null, k: string): unknown => {
  try {
    const v = s?.getItem(k);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
};
const put = (s: Store | null, k: string, v: unknown) => {
  try {
    s?.setItem(k, JSON.stringify(v));
  } catch {
    /* storage blocked or full */
  }
};
const list = (s: Store | null, k: string): string[] => {
  const v = get(s, k);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};
const announce = () => {
  try {
    window.dispatchEvent(new Event(CONNECT_THEME_EVENT));
  } catch {
    /* no window (tests) */
  }
};

/** Settings › Theme: wear connected sites' themes at all (default on). */
export const siteThemesOn = (s: Store | null = local()): boolean => get(s, GLOBAL_OFF_KEY) !== true;
export const setSiteThemesOn = (on: boolean, s: Store | null = local()): void => {
  put(s, GLOBAL_OFF_KEY, !on);
  announce();
};

/** Connections: "Use this site's theme" for one site (default on). */
export const siteThemeAllowed = (originator: string, s: Store | null = local()): boolean =>
  !list(s, SITE_OFF_KEY).includes(trueHost(originator));
export const setSiteThemeAllowed = (originator: string, on: boolean, s: Store | null = local()): void => {
  const h = trueHost(originator);
  const rest = list(s, SITE_OFF_KEY).filter((x) => x !== h);
  put(s, SITE_OFF_KEY, on ? rest : [...rest, h].slice(-500));
  announce();
};

/** Called when the user approves a request from a site: from then on its sheets may wear its theme. */
export function markSiteConnected(originator: string, s: Store | null = local(), f?: Fetch): void {
  const h = trueHost(originator);
  if (!themeOrigin(h)) return;
  const all = list(s, CONNECTED_KEY);
  if (!all.includes(h)) put(s, CONNECTED_KEY, [...all, h].slice(-500));
  // Start fetching now so the next sheet is already dressed.
  void loadConnectTheme(h, { s, f });
}
export const siteConnected = (originator: string, s: Store | null = local()): boolean =>
  list(s, CONNECTED_KEY).includes(trueHost(originator));
/** Revoking a site in Connections forgets that it was connected (and its cached theme). */
export function forgetSiteConnected(originator: string, s: Store | null = local()): void {
  const h = trueHost(originator);
  put(
    s,
    CONNECTED_KEY,
    list(s, CONNECTED_KEY).filter((x) => x !== h),
  );
  const c = (get(s, CACHE_KEY) ?? {}) as Record<string, unknown>;
  delete c[h];
  put(s, CACHE_KEY, c);
  announce();
}

/** Whether this site's sheets should wear its theme right now (connected, not switched off anywhere). */
export const shouldWearSiteTheme = (originator: string, s: Store | null = local()): boolean =>
  !!themeOrigin(originator) && siteThemesOn(s) && siteThemeAllowed(originator, s) && siteConnected(originator, s);

/**
 * Whether an approval sheet from this site may wear its theme. Unlike shouldWearSiteTheme it does not need an
 * earlier approval: the site is asking right now (the background checked the origin), so its first connect sheet is
 * dressed too. Switches and paired-session rules still apply.
 */
export const shouldWearOnSheet = (originator: string, s: Store | null = local()): boolean =>
  !!themeOrigin(originator) && siteThemesOn(s) && siteThemeAllowed(originator, s);

type CacheEntry = { at: number; theme: WornTheme | null };
const inflight = new Map<string, Promise<WornTheme | null>>();

/** The site's theme from cache or the network. Fetched only for a site the user approved or that is asking now. */
export async function loadConnectTheme(
  originator: string,
  {
    s = local(),
    f = fetch,
    now = Date.now(),
    asking = false,
  }: { s?: Store | null; f?: Fetch; now?: number; asking?: boolean } = {},
): Promise<WornTheme | null> {
  const h = trueHost(originator);
  const origin = themeOrigin(h);
  // `asking`: the site has a request on screen right now (its first connect sheet), so it may be fetched.
  if (!origin || (!asking && !siteConnected(h, s))) return null;
  const cache = (get(s, CACHE_KEY) ?? {}) as Record<string, CacheEntry>;
  const hit = cache[h];
  if (hit && now - hit.at < (hit.theme ? CACHE_MS : MISS_CACHE_MS)) return hit.theme;
  const running = inflight.get(h);
  if (running) return running;
  const p = fetchConnectTheme(origin, f)
    .then((theme) => {
      const c = (get(s, CACHE_KEY) ?? {}) as Record<string, CacheEntry>;
      c[h] = { at: now, theme };
      // Keep the cache small: the 50 most recent sites.
      const keep = Object.entries(c)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 50);
      put(s, CACHE_KEY, Object.fromEntries(keep));
      announce();
      return theme;
    })
    .finally(() => inflight.delete(h));
  inflight.set(h, p);
  return p;
}
