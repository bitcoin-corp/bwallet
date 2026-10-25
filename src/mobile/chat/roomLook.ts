import { useEffect, useState } from 'react';
import {
  CACHE_MS,
  CONNECT_THEME_EVENT,
  MISS_CACHE_MS,
  fetchConnectTheme,
  fetchSubTheme,
  loadConnectTheme,
  parseConnectTheme,
  withImages,
  shouldWearSiteTheme,
  themeOrigin,
  trueHost,
  type WornTheme,
} from '../theme/connectSiteTheme';
import { roomTicker } from './siteRoom';

/**
 * Game rooms dress themselves (owner, 25 Oct 2026: "as they add to it, their room becomes themed, their token avatar
 * gets themed, their room agent becomes themed"). A connected site's theme file (docs/SITE-THEME.md) that names a
 * `room` dresses that room in the wallet: header art, colours, the room's picture and its agent's label.
 *
 * Read-only and built only from a theme that passed parseConnectTheme: #RRGGBB colours, one plain name, and
 * pictures the wallet fetched from the site's own origin (size-capped, kept as data: URLs). No CSS from the site.
 * The look follows the theme file: when the game maker adds art or changes colours, the room changes with it (the
 * theme is re-read daily, or when the user approves the site again).
 *
 * Which site dresses which room is remembered per device when the extension sees that site's theme name the room
 * (siteLook.ts); the room is only dressed while that site stays connected and its theme switched on.
 */
export type RoomLook = {
  ticker: string;
  /** The true host the look came from (shown in the room, never from the theme). */
  host: string;
  name: string;
  mode: 'dark' | 'light';
  accent: string;
  accentHi: string;
  onAccent: string;
  bg: string;
  surface: string;
  text: string;
  logoData?: string;
  /** Room background: the theme's roomArt, else its cardArt. */
  artData?: string;
};

/** The look a theme gives its own room, or null when it names none (or a different one). */
export function roomLookFrom(t: WornTheme | null | undefined, ticker: string): RoomLook | null {
  const want = roomTicker(ticker);
  if (!t || !t.room || !want || t.room !== want) return null;
  const art = t.roomArtData ?? t.artData;
  return {
    ticker: want,
    host: trueHost(t.origin),
    name: t.name,
    mode: t.mode,
    accent: t.accent,
    accentHi: t.accentHi,
    onAccent: t.onAccent,
    bg: t.bg,
    surface: t.surface,
    text: t.text,
    ...(t.logoData ? { logoData: t.logoData } : {}),
    ...(art ? { artData: art } : {}),
  };
}

const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/**
 * The room header's background: the art under a dark-to-clear overlay in the room's own background colour, so the
 * name and buttons stay readable over any picture. No art: a gradient in the theme's colours.
 */
export function roomHeaderBackground(l: RoomLook): string {
  const tint = `linear-gradient(180deg, ${l.bg}E6 0%, ${l.bg}B3 55%, ${l.bg}F2 100%)`;
  if (l.artData && DATA_IMAGE.test(l.artData)) return `${tint}, url("${l.artData}") center / cover no-repeat`;
  return `linear-gradient(180deg, ${l.surface} 0%, ${l.bg} 100%)`;
}

// ---- room → site (per device) ----

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'bwx.roomLook.sites';
const MAX = 30;
type Entry = { origin: string; path: string | null; at: number };

const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
const read = (s: Store | null): Record<string, Entry> => {
  try {
    const v = JSON.parse(s?.getItem(KEY) ?? 'null') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Entry>) : {};
  } catch {
    return {};
  }
};

/** The connected site whose theme (root or path sub-theme) names this room. Called by siteLook.ts. */
export function rememberRoomSite(
  ticker: string,
  origin: string,
  path: string | null,
  s: Store | null = local(),
  now = Date.now(),
): void {
  const t = roomTicker(ticker);
  if (!t) return;
  const m = read(s);
  const prev = m[t];
  if (prev && prev.origin === origin && prev.path === path && now - prev.at < 60_000) return;
  m[t] = { origin, path: path ? path.slice(0, 256) : null, at: now };
  const keep = Object.entries(m)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX);
  try {
    s?.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    /* storage blocked or full */
  }
}

export const roomSite = (ticker: string, s: Store | null = local()): Entry | null => {
  const t = roomTicker(ticker);
  const e = t ? read(s)[t] : undefined;
  return e && typeof e.origin === 'string'
    ? { origin: e.origin, path: typeof e.path === 'string' ? e.path : null, at: e.at }
    : null;
};

/**
 * Ownership: a site may only dress a room that names that site as its own. The room's owner sets `metadata.site`
 * (its https origin) on bChatX; the theme's origin must equal it. A room with no `metadata.site`, or another
 * site's, is never dressed, so one site can never dress another's token room.
 */
export function roomOwnerOrigin(metadata: unknown): string | null {
  const v = (metadata as { site?: unknown } | null | undefined)?.site;
  if (typeof v !== 'string' || !/^https?:\/\//.test(v)) return null;
  try {
    const u = new URL(v);
    return themeOrigin(u.origin);
  } catch {
    return null;
  }
}

export async function loadRoomLook(
  ticker: string,
  opts: { s?: Store | null; load?: typeof loadConnectTheme; owner?: string | null } = {},
): Promise<RoomLook | null> {
  const { s = local(), load = loadConnectTheme, owner = null } = opts;
  const site = roomSite(ticker, s);
  if (!site || !owner || themeOrigin(site.origin) !== owner || !shouldWearSiteTheme(site.origin, s)) return null;
  const t = await load(site.origin, { s, path: site.path }).catch(() => null);
  return roomLookFrom(t, ticker);
}

// ---- the room's look from the server (no connection needed) ----

/**
 * A room's look without the user ever connecting its site (owner, 25 Oct 2026: the phone showed the $TERRORNODE room
 * plain because tokenblaster.lol was never connected inside the app). Two sources, both tied to the room's own site
 * (metadata.site, set by the room's owner on bit-sign), so one site can never dress another's room:
 *
 * 1. `metadata.look` on the room: the same fields as a theme file ({name, mode, accent, accentHi, bg, surface, text,
 *    logo, roomArt | cardArt}), run through parseConnectTheme with origin = metadata.site, so every picture must be an
 *    https URL on that site and is fetched by the wallet (size-capped, kept as a data: URL).
 * 2. Else the site's public theme file (/.well-known/bwalletx-theme.json): the root theme or the `paths` sub-theme
 *    whose `room` names this ticker.
 *
 * Cached per device for a day (an hour when the site has none).
 */
type Fetch = typeof fetch;
const SERVER_KEY = 'bwx.roomLook.server';
type ServerEntry = { at: number; look: RoomLook | null };
const serverMem = new Map<string, ServerEntry>();
const serverInflight = new Map<string, Promise<RoomLook | null>>();

async function lookFromSite(origin: string, ticker: string, f: Fetch): Promise<RoomLook | null> {
  const root = await fetchConnectTheme(origin, f).catch(() => null);
  if (!root) return null;
  const own = roomLookFrom(root, ticker);
  if (own) return own;
  for (const url of Object.values(root.paths ?? {})) {
    const sub = await fetchSubTheme(url, origin, f).catch(() => null);
    const l = roomLookFrom(sub, ticker);
    if (l) return l;
  }
  return null;
}

export async function serverRoomLook(
  ticker: string,
  metadata: unknown,
  opts: { s?: Store | null; f?: Fetch; now?: number } = {},
): Promise<RoomLook | null> {
  const { s = local(), f = fetch, now = Date.now() } = opts;
  const want = roomTicker(ticker);
  const owner = roomOwnerOrigin(metadata);
  if (!want || !owner) return null;
  const raw = (metadata as { look?: unknown }).look;
  const declared = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  // The cache key carries the declared look, so an owner's edit on bit-sign shows at once.
  const key = `${owner} ${want} ${declared ? JSON.stringify(declared).slice(0, 2048) : '-'}`;
  const hit = serverMem.get(key) ?? readServer(s)[key];
  if (hit && now - hit.at < (hit.look ? CACHE_MS : MISS_CACHE_MS)) return hit.look;
  const running = serverInflight.get(key);
  if (running) return running;
  const p = (async () => {
    if (declared) {
      const parsed = parseConnectTheme({ ...declared, room: want }, owner);
      if (parsed.theme) return roomLookFrom(await withImages(parsed.theme, owner, f), want);
    }
    return lookFromSite(owner, want, f);
  })()
    .catch(() => null)
    .then((look) => {
      const entry = { at: now, look };
      serverMem.set(key, entry);
      writeServer(s, key, entry);
      return look;
    })
    .finally(() => serverInflight.delete(key));
  serverInflight.set(key, p);
  return p;
}

const readServer = (s: Store | null): Record<string, ServerEntry> => {
  try {
    const v = JSON.parse(s?.getItem(SERVER_KEY) ?? 'null') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, ServerEntry>) : {};
  } catch {
    return {};
  }
};
const writeServer = (s: Store | null, key: string, e: ServerEntry) => {
  const keep = Object.entries({ ...readServer(s), [key]: e })
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 12);
  try {
    s?.setItem(SERVER_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    /* storage blocked or full: the in-memory copy still serves this session */
  }
};

/** The room's look: the connected site's theme on this device first, else the server's (serverRoomLook). */
export async function anyRoomLook(
  ticker: string,
  metadata: unknown,
  opts: { s?: Store | null; f?: Fetch; load?: typeof loadConnectTheme } = {},
): Promise<RoomLook | null> {
  const owner = roomOwnerOrigin(metadata);
  if (!owner) return null;
  const device = await loadRoomLook(ticker, { s: opts.s, load: opts.load, owner }).catch(() => null);
  return device ?? serverRoomLook(ticker, metadata, opts);
}

/** React: the look for an open room (null for no ticker, a disabled room, or no themed site). */
export function useRoomLook(
  ticker: string | null | undefined,
  enabled = true,
  /** The room's metadata: its site (metadata.site; no site, no look) and optional metadata.look. */
  metadata: unknown = null,
): RoomLook | null {
  const [look, setLook] = useState<RoomLook | null>(null);
  const owner = roomOwnerOrigin(metadata);
  const declared = JSON.stringify((metadata as { look?: unknown } | null)?.look ?? null);
  useEffect(() => {
    setLook(null);
    if (!ticker || !enabled || !owner) return;
    let live = true;
    const refresh = () => void anyRoomLook(ticker, metadata).then((l) => live && setLook(l));
    refresh();
    window.addEventListener(CONNECT_THEME_EVENT, refresh);
    return () => {
      live = false;
      window.removeEventListener(CONNECT_THEME_EVENT, refresh);
    };
  }, [ticker, enabled, owner, declared]); // eslint-disable-line react-hooks/exhaustive-deps
  return look;
}
