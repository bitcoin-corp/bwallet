import {
  ALL_VARS,
  BASE_LOOK,
  DEFAULT_ACCENT,
  RETIRED_PACKS,
  THEMES,
  accentById,
  accentVars,
  packVars,
  setCustomAccent,
  type AccentId,
  PAID_EDITIONS,
} from './accents';
import { deriveMix, normaliseMix, type MixSpec } from './mixer';
import { accentOfPack, parseThemePack, type ThemePack } from './themePack';
import { rememberSiteTheme } from './siteTheme';

/**
 * Applies and stores the app accent (Theme → App colours). Per account on this device only, nothing leaves it.
 * The last-applied accent is also kept under a boot key so main.ts can paint it before the first frame, before
 * the account is known; useAccountAccent then settles on the open account's own choice.
 */
const BOOT_KEY = 'bwx.accent.boot';
const keyFor = (account: string) => `bwx.accent.${account}`;
const MIX_BOOT_KEY = 'bwx.mix.boot';
const mixKeyFor = (account: string) => `bwx.mix.${account}`;
// A store pack that is not bundled (holder / premium, docs/THEME-STORE-PLAN.md): kept as its validated JSON.
const PACK_BOOT_KEY = 'bwx.pack.boot';
const packKeyFor = (account: string) => `bwx.pack.${account}`;
export const ACCENT_EVENT = 'bwx-accent';

let applied: AccentId = DEFAULT_ACCENT;
// What a connected-site theme painted over (wearConnectedSiteTheme); null when none is worn.
let beforeSite: AccentId | null = null;
/** The accent currently painted on <html> (for art drawn in JS, e.g. bAvatar tint). */
export const currentAccentId = (): AccentId => applied;

const announce = () => {
  try {
    window.dispatchEvent(new Event(ACCENT_EVENT));
  } catch {
    /* no window (tests) */
  }
};

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage blocked or full: the accent still applies for this session */
  }
};

/** Sets the pack's CSS variables on <html>. Gold clears them all, so src/accent.css's defaults apply. */
export function applyAccent(id: string | null | undefined): AccentId {
  const a = accentById(id);
  applied = a.id;
  if (typeof document === 'undefined') return a.id;
  const root = document.documentElement;
  const gold = a.id === DEFAULT_ACCENT;
  if (gold) delete root.dataset.bwTheme;
  else root.dataset.bwTheme = a.id;
  // Full packs and the mixer restyle the whole app; accent-only colours keep the Gold base.
  const full = !gold && a.kind !== 'colour';
  if (full) root.dataset.bwPack = a.scheme;
  else delete root.dataset.bwPack;
  // Mono / Duo / Tri: themes.css paints Mono's white cards and tinted buttons from this.
  if (full && a.group) root.dataset.bwTone = a.group;
  else delete root.dataset.bwTone;
  // White and the paper packs (Pink, Blue, Yellow) share White's rules (themes.css [data-bw-paper]).
  if (full && (a.id === 'white' || a.paper)) root.dataset.bwPaper = '';
  else delete root.dataset.bwPaper;
  const s = root.style;
  for (const k of ALL_VARS) s.removeProperty(k);
  if (!gold) for (const [k, v] of Object.entries(full ? packVars(a) : accentVars(a))) s.setProperty(k, v);
  s.colorScheme = full && a.scheme === 'light' ? 'light' : '';
  // The browser / installed web-app bar follows the pack (Gold keeps the base black).
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', full ? a.bg : BASE_LOOK.bg);
  return a.id;
}

/**
 * ?theme=<pack> links (web.bwalletx.com and web-app installs): the first time each distinct value is seen it
 * becomes the user's theme; the param is then stripped. A value already seen is ignored, so a theme the user
 * picks later is never overridden by an old bookmarked link. Unknown values are ignored.
 */
const URL_SEEN_KEY = 'bwx.theme.url.seen';
/** The URL's pack, waiting for the account to open so it can be saved as that account's choice. */
const URL_PENDING_KEY = 'bwx.accent.pending';
const URL_ALIASES: Readonly<Record<string, AccentId>> = { dark: 'gold', light: 'white' };

/** A ?theme value → pack id, or null when it names no pack. */
export const packFromThemeParam = (raw: string | null | undefined): AccentId | null => {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (URL_ALIASES[v]) return URL_ALIASES[v];
  if (RETIRED_PACKS[v]) return RETIRED_PACKS[v];
  return THEMES.some((a) => a.id === v) ? (v as AccentId) : null;
};

/** Colours with their own install manifest in the web build (vite.config.web.ts THEME_INSTALLS). */
export const LINKED_INSTALLS: readonly string[] = ['white', 'pink', 'blue', 'yellow', 'vexvoid', 'npg', 'npgx'];

/** Points the manifest and apple-touch-icon at the colour's install files, so Add to Home Screen is themed. */
export function swapInstallLinks(colour: string): boolean {
  if (!LINKED_INSTALLS.includes(colour) || typeof document === 'undefined') return false;
  const base = `/themes/${colour}/`;
  document.querySelector('link[rel="manifest"]')?.setAttribute('href', `${base}manifest.json`);
  document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', `${base}icon-180.png`);
  return true;
}

/** Reads ?theme once at startup; returns the pack it newly applied, if any. */
export function applyThemeParam(): AccentId | null {
  if (typeof window === 'undefined' || !window.location) return null;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return null;
  }
  // web.bwalletx.com/white, /pink, /vexvoid … (each edition's install entry) counts as ?theme=<id> and opens home.
  const path = url.pathname.replace(/\/+$/, '').slice(1).toLowerCase();
  const edition = LINKED_INSTALLS.includes(path);
  if (!edition && !url.searchParams.has('theme')) return null;
  const raw = edition ? path : (url.searchParams.get('theme') ?? '').trim().toLowerCase();
  url.searchParams.delete('theme');
  if (edition) url.pathname = '/';
  try {
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch {
    /* no history API: the param stays, harmless */
  }
  swapInstallLinks(raw);
  const id = packFromThemeParam(raw);
  if (!id) return null;
  // Paid editions are bought in the Store, so a link can't switch one on for free (owner, 17 Oct 2026).
  if (PAID_EDITIONS.includes(id)) return null;
  let seen: string[] = [];
  try {
    const v = JSON.parse(read(URL_SEEN_KEY) ?? '[]') as unknown;
    if (Array.isArray(v)) seen = v.filter((x): x is string => typeof x === 'string');
  } catch {
    /* corrupt: start again */
  }
  // An edition entry (/white, /pink …) is that edition's install: it always opens in its own pack, before unlock,
  // even when the same origin's plain install last saved another (owner, 16 Oct 2026: White lock screen was Gold).
  if (!edition && seen.includes(raw)) return null;
  if (!seen.includes(raw)) write(URL_SEEN_KEY, JSON.stringify([...seen, raw].slice(-50)));
  write(BOOT_KEY, id === DEFAULT_ACCENT ? null : id);
  write(MIX_BOOT_KEY, null);
  write(URL_PENDING_KEY, id);
  return id;
}

const readMix = (k: string): MixSpec | null => {
  try {
    const v = read(k);
    return v ? normaliseMix(JSON.parse(v) as Partial<MixSpec>) : null;
  } catch {
    return null;
  }
};
/** Loads a mix into the 'custom' pack so accentById('custom') can paint it. */
const primeMix = (m: MixSpec | null) => setCustomAccent(m ? deriveMix(m) : null);
const readPack = (k: string): ThemePack | null => {
  try {
    const v = read(k);
    return v ? parseThemePack(JSON.parse(v)) : null;
  } catch {
    return null;
  }
};
/** 'custom' is the mix when there is one, otherwise a saved store pack. */
const primeCustom = (m: MixSpec | null, p: ThemePack | null) => {
  if (m) primeMix(m);
  else setCustomAccent(p ? accentOfPack(p) : null);
};

/** Startup: paint the last-used accent before the first frame. */
export const applyBootAccent = (): AccentId => {
  applyThemeParam();
  primeCustom(readMix(MIX_BOOT_KEY), readPack(PACK_BOOT_KEY));
  return applyAccent(read(BOOT_KEY));
};

/** The account's saved mix, if it has one. */
export const loadMix = (account: string): MixSpec | null => readMix(mixKeyFor(account));

export const loadAccent = (account: string): AccentId => accentById(read(keyFor(account))).id;

/** Applies an account's accent and remembers it for the next startup. */
export function switchToAccountAccent(account: string): AccentId {
  beforeSite = null; // the account's own theme replaces any connected-site theme
  const before = applied;
  const pending = read(URL_PENDING_KEY);
  if (account && pending) {
    // A ?theme link opened before the account did: it becomes this account's choice.
    write(keyFor(account), pending === DEFAULT_ACCENT ? null : pending);
    write(URL_PENDING_KEY, null);
  }
  const m = readMix(account ? mixKeyFor(account) : MIX_BOOT_KEY);
  const pk = m ? null : readPack(account ? packKeyFor(account) : PACK_BOOT_KEY);
  primeCustom(m, pk);
  const id = applyAccent(account ? read(keyFor(account)) : read(BOOT_KEY));
  write(BOOT_KEY, id === DEFAULT_ACCENT ? null : id);
  write(MIX_BOOT_KEY, id === 'custom' && m ? JSON.stringify(m) : null);
  write(PACK_BOOT_KEY, id === 'custom' && pk ? JSON.stringify(pk) : null);
  if (id !== before) announce();
  return id;
}

/** Saves and applies an account's mix (Mix your own); the account's pack becomes 'custom'. */
export function saveMix(account: string, mix: MixSpec): void {
  const m = normaliseMix(mix);
  const json = JSON.stringify(m);
  if (account) write(mixKeyFor(account), json);
  write(MIX_BOOT_KEY, json);
  if (account) write(packKeyFor(account), null);
  write(PACK_BOOT_KEY, null);
  primeMix(m);
  saveAccent(account, 'custom');
}

/** Saves and applies a store pack that is not bundled (it becomes the account's 'custom' pack; any mix is dropped). */
export function saveStorePack(account: string, pack: ThemePack): void {
  const json = JSON.stringify(pack);
  if (account) {
    write(packKeyFor(account), json);
    write(mixKeyFor(account), null);
  }
  write(PACK_BOOT_KEY, json);
  write(MIX_BOOT_KEY, null);
  setCustomAccent(accentOfPack(pack));
  saveAccent(account, 'custom');
}

/** The account's saved store pack (a site theme, holder pack …), if its 'custom' pack is one. */
export const loadStorePack = (account: string): ThemePack | null =>
  readPack(account ? packKeyFor(account) : PACK_BOOT_KEY);

/** Wears a site's theme (Theme › From sites, the site's offer): saved like a store pack and listed under From sites. */
export function wearSiteTheme(account: string, pack: ThemePack): void {
  rememberSiteTheme(pack);
  saveStorePack(account, pack);
}

/** Paints a mix without saving it (live preview while sliding). */
export function previewMix(mix: MixSpec): void {
  primeMix(normaliseMix(mix));
  applyAccent('custom');
  announce();
}

/** Saves and applies an account's accent. */
export function saveAccent(account: string, id: AccentId): void {
  beforeSite = null; // the user's choice wins over a connected-site theme
  if (account) write(keyFor(account), id === DEFAULT_ACCENT ? null : id);
  write(BOOT_KEY, id === DEFAULT_ACCENT ? null : id);
  applyAccent(id);
  announce();
}

/**
 * Connected-site theme (connectTheme.ts): paints a bundled pack while a connected site that declared it is the
 * active tab, without saving it anywhere; null puts back what was showing before. The background has already
 * checked the id against the site's origin.
 */
export function wearConnectedSiteTheme(id: AccentId | null): void {
  if (id) {
    if (beforeSite === null) beforeSite = applied;
    applyAccent(id);
    announce();
    return;
  }
  if (beforeSite === null) return;
  const back = beforeSite;
  beforeSite = null;
  applyAccent(back);
  announce();
}

/** True while a connected site's theme is painted over the user's own (Theme settings should not save it). */
export const wearingConnectedSiteTheme = (): boolean => beforeSite !== null;
