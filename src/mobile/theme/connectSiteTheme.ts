import { isPairedHost } from '../../services/originKey';
import { contrast } from './colour';
import { roomTicker } from '../chat/siteRoom';

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
/**
 * A cached theme older than this is re-checked: the small JSON file is fetched again and, if it changed (a new
 * `paths` map, another `room`, new colours), the theme is rebuilt. Unchanged files keep the cached pictures.
 * (Owner, 25 Oct 2026: tokenblaster.lol moved /arcade/terrornode to a new sub-theme and the wallet kept the old one
 * for a day.)
 */
export const RECHECK_MS = 10 * 60 * 1000;

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
  /** Optional background for the site's chat room (wide picture); the room falls back to cardArt. Same rules. */
  roomArt?: string;
  /** Root file only: path prefix → same-origin /.well-known/*.json sub-theme URL (validated, ≤ PATHS_MAX). */
  paths?: Record<string, string>;
  /** The site's chat room: a ticker the wallet's room list knows (mobile/chat/siteRoom.ts). Optional. */
  room?: string;
};

/** A theme ready to paint: images already fetched and checked. */
export type WornTheme = ConnectTheme & { origin: string; logoData?: string; artData?: string; roomArtData?: string };

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

export const PATHS_MAX = 8;
const PREFIX = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;
const SUB_FILE = /^\/\.well-known\/[A-Za-z0-9._-]{1,64}\.json$/;

/** A sub-theme target: same origin, under /.well-known/, a .json file, no query or fragment. Null otherwise. */
export function subThemeUrl(raw: unknown, origin: string): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 128 || /[\s\\?#]/.test(raw)) return null;
  try {
    const u = new URL(raw, `${origin}/`);
    if (u.origin !== origin || u.username || u.password || u.search || u.hash) return null;
    if (!SUB_FILE.test(u.pathname) || u.pathname === CONNECT_THEME_PATH) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** The root file's `paths` map, checked; null when it is malformed (the root theme still applies). */
export function parsePaths(v: unknown, origin: string): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > PATHS_MAX) return null;
  const out: Record<string, string> = {};
  for (const [k, target] of entries) {
    if (k.length > 128 || !PREFIX.test(k)) return null;
    const url = subThemeUrl(target, origin);
    if (!url) return null;
    out[k] = url;
  }
  return out;
}

/** The sub-theme for a page path: the longest prefix that matches on a "/" boundary, or null. */
export function pickSubTheme(
  paths: Record<string, string> | undefined,
  path: string | null | undefined,
): string | null {
  if (!paths || !path) return null;
  let best: string | null = null;
  for (const k of Object.keys(paths)) {
    const hit = k === '/' || path === k || path.startsWith(`${k}/`);
    if (hit && (best === null || k.length > best.length)) best = k;
  }
  return best === null ? null : (paths[best] ?? null);
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
  // Unknown keys are ignored (never read), so a field added later never breaks an older wallet. Known keys stay strict.
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
  let roomArt: string | undefined;
  if (t.roomArt !== undefined) {
    const a = sameOriginImage(t.roomArt, origin);
    if (!a) return { error: 'roomArt must be a same-origin URL' };
    roomArt = a;
  }
  // A bad `paths` map is dropped, never fatal: the root theme still applies.
  const paths = t.paths === undefined ? null : parsePaths(t.paths, origin);
  // A bad `room` is dropped too: no room means the normal home screen.
  const room = roomTicker(t.room);
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
      ...(roomArt ? { roomArt } : {}),
      ...(paths && Object.keys(paths).length ? { paths } : {}),
      ...(room ? { room } : {}),
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

/** The theme's pictures, fetched by the wallet (same origin, size-capped) and kept as data: URLs. */
export async function withImages(t: ConnectTheme, origin: string, f: Fetch): Promise<WornTheme> {
  const [logoData, artData, roomArtData] = await Promise.all([
    fetchImage(t.logo, origin, LOGO_MAX_BYTES, f),
    fetchImage(t.cardArt, origin, ART_MAX_BYTES, f),
    fetchImage(t.roomArt, origin, ART_MAX_BYTES, f),
  ]);
  return {
    ...t,
    origin,
    ...(logoData ? { logoData } : {}),
    ...(artData ? { artData } : {}),
    ...(roomArtData ? { roomArtData } : {}),
  };
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

/** A short fingerprint of a JSON value (FNV-1a over its text), to tell whether a theme file changed. */
export function jsonSig(v: unknown): string {
  const text = JSON.stringify(v ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}.${(h >>> 0).toString(36)}`;
}

/** The fingerprint of the file at `url` right now, or null when it cannot be read. */
export async function fileSig(url: string, origin: string, f: Fetch = fetch): Promise<string | null> {
  const v = await readJson(url, origin, f);
  return v === undefined ? null : jsonSig(v);
}

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
    return withImages(p.theme, origin, f);
  }
  return null;
}

/**
 * Fetches a path sub-theme (`url` already checked by subThemeUrl). Same checks as the root file; it may not carry
 * its own `paths`. Null on any failure: the caller falls back to the root theme.
 */
export async function fetchSubTheme(url: string, origin: string, f: Fetch = fetch): Promise<WornTheme | null> {
  if (subThemeUrl(url, origin) !== url) return null;
  const v = await readJson(url, origin, f);
  if (!v || typeof v !== 'object' || 'paths' in (v as object)) return null;
  const p = parseConnectTheme(v, origin);
  if (!p.theme) return null;
  return withImages(p.theme, origin, f);
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
  // A fresh approval asks again even if the site had no theme file an hour ago (it may have just added one).
  dropCachedMiss(h, s);
  // Start fetching now so the next sheet is already dressed.
  void loadConnectTheme(h, { s, f });
}

/** Forget a cached "no theme" answer for a host (root and sub-themes); a cached theme is kept. */
function dropCachedMiss(h: string, s: Store | null): void {
  const c = (get(s, CACHE_KEY) ?? {}) as Record<string, { theme?: unknown } | undefined>;
  let changed = false;
  for (const k of Object.keys(c))
    if ((k === h || k.startsWith(`${h} `)) && !c[k]?.theme) {
      delete c[k];
      changed = true;
    }
  if (changed) put(s, CACHE_KEY, c);
}

/**
 * Whether the user has connected this site. Approving a sheet in this build marks it (markSiteConnected), but a
 * site approved before site themes shipped, or through a sheet that doesn't mark it, still holds wallet
 * permissions: `grantHosts` lists the hosts that do (the background's permission list), and a match counts as
 * connected from then on. Any failure (wallet locked, no background) means "not connected".
 */
export async function ensureSiteConnected(
  originator: string,
  grantHosts: () => Promise<string[]>,
  s: Store | null = local(),
): Promise<boolean> {
  if (!themeOrigin(originator)) return false;
  if (siteConnected(originator, s)) return true;
  const h = trueHost(originator);
  const hosts = await grantHosts().catch(() => [] as string[]);
  if (!hosts.some((x) => trueHost(x) === h)) return false;
  const all = list(s, CONNECTED_KEY);
  if (!all.includes(h)) put(s, CONNECTED_KEY, [...all, h].slice(-500));
  dropCachedMiss(h, s);
  return true;
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
  for (const k of Object.keys(c)) if (k.startsWith(`${h} `)) delete c[k];
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

type CacheEntry = { at: number; theme: WornTheme | null; sig?: string | null; checked?: number };
const inflight = new Map<string, Promise<WornTheme | null>>();

/** The site's theme from cache or the network. Fetched only for a site the user approved or that is asking now. */
async function loadRootTheme(
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
  if (hit && now - hit.at < (hit.theme ? CACHE_MS : MISS_CACHE_MS)) {
    // Fresh enough, or re-checked recently: keep it. Else re-read the small file and keep it only if unchanged.
    if (!hit.theme || now - (hit.checked ?? hit.at) < RECHECK_MS) return hit.theme;
    const sig = await fileSig(`${origin}${CONNECT_THEME_PATH}`, origin, f).catch(() => null);
    if (sig === null || sig === hit.sig) {
      const c = (get(s, CACHE_KEY) ?? {}) as Record<string, CacheEntry>;
      if (c[h]) c[h] = { ...c[h]!, checked: now };
      put(s, CACHE_KEY, c);
      return hit.theme;
    }
  }
  const running = inflight.get(h);
  if (running) return running;
  const p = Promise.all([
    fetchConnectTheme(origin, f),
    fileSig(`${origin}${CONNECT_THEME_PATH}`, origin, f).catch(() => null),
  ])
    .then(([theme, sig]) => {
      const c = (get(s, CACHE_KEY) ?? {}) as Record<string, CacheEntry>;
      c[h] = { at: now, theme, sig, checked: now };
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

const subInflight = new Map<string, Promise<WornTheme | null>>();

/**
 * The site's theme for a page: the root file, or the sub-theme its `paths` map names for `path` (longest prefix on
 * a "/" boundary). Any failure falls back to the root theme. Fetch rules as loadRootTheme.
 */
export async function loadConnectTheme(
  originator: string,
  opts: { s?: Store | null; f?: Fetch; now?: number; asking?: boolean; path?: string | null } = {},
): Promise<WornTheme | null> {
  const root = await loadRootTheme(originator, opts);
  const url = root ? pickSubTheme(root.paths, opts.path) : null;
  if (!root || !url) return root;
  const { s = local(), f = fetch, now = Date.now() } = opts;
  const key = `${trueHost(originator)} ${url}`;
  const cache = (get(s, CACHE_KEY) ?? {}) as Record<string, CacheEntry>;
  const hit = cache[key];
  if (hit && now - hit.at < (hit.theme ? CACHE_MS : MISS_CACHE_MS)) return hit.theme ?? root;
  let p = subInflight.get(key);
  if (!p) {
    p = fetchSubTheme(url, root.origin, f)
      .catch(() => null)
      .then((theme) => {
        const c = (get(s, CACHE_KEY) ?? {}) as Record<string, CacheEntry>;
        c[key] = { at: now, theme };
        const keep = Object.entries(c)
          .sort((a, b) => b[1].at - a[1].at)
          .slice(0, 50);
        put(s, CACHE_KEY, Object.fromEntries(keep));
        return theme;
      })
      .finally(() => subInflight.delete(key));
    subInflight.set(key, p);
  }
  return (await p) ?? root;
}

// The page path the panel last saw for a host, so a sheet can wear the same sub-theme (per device).
const PATH_KEY = 'bwx.connectTheme.path';
export const rememberSitePath = (originator: string, path: string | null, s: Store | null = local()): void => {
  const m = (get(s, PATH_KEY) ?? {}) as Record<string, string>;
  const h = trueHost(originator);
  if (path) m[h] = path.slice(0, 256);
  else delete m[h];
  put(s, PATH_KEY, Object.fromEntries(Object.entries(m).slice(-100)));
};
export const lastSitePath = (originator: string, s: Store | null = local()): string | null => {
  const v = ((get(s, PATH_KEY) ?? {}) as Record<string, unknown>)[trueHost(originator)];
  return typeof v === 'string' ? v : null;
};
