/**
 * Synced Space video (bit-sign rooms/[ticker]/space-video). The server keeps one item and a clock;
 * every phone works out the same position from it, so the whole room watches the same frame.
 * Pure helpers here (tested in spaceVideo.test.ts); the player is SpaceVideoPlayer.tsx.
 */

export type SpaceVideoItem = {
  kind: 'url' | 'ordinal';
  src: string;
  outpoint?: string;
  title?: string;
  durationMs?: number;
  poster?: string;
};

/** An Album Space: an ordered run of videos; `index` is the one playing, `repeat` wraps to the first. */
export type SpaceAlbum = { items: SpaceVideoItem[]; index: number; repeat: boolean };
export const ALBUM_MAX = 50;

export type SpaceVideoState = 'playing' | 'paused' | 'stopped';

export type SpaceVideo = {
  item: SpaceVideoItem | null;
  state: SpaceVideoState;
  startedAt: number;
  pausedAtMs: number;
  loop: boolean;
  version: number;
  /** Album Space: the host's ordered run of videos (bit-sign `space_video.album`), or null. */
  album: SpaceAlbum | null;
  serverNow: number;
  /** server_now − local clock when this copy arrived (ms). Add to Date.now() to get server time. */
  skew: number;
};

export const SPACE_VIDEO_TOPIC = 'space-video';
export const MESH_POLL_MS = 10_000;
export const DRIFT_RESEEK_MS = 1_500;

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|ogg|m3u8)$/i;
const VIDEO_HOSTS = ['ordfs.network', '1sat.app', 'gorillapool.io', 'bitsign.it', 'bchatx.com', 'chat.bwalletx.com'];

/** https only, and a video file or one of our known content hosts (and their subdomains). */
export const isAllowedVideoSrc = (src: unknown): src is string => {
  if (typeof src !== 'string' || !src) return false;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return VIDEO_EXT.test(u.pathname);
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

const parseItem = (raw: unknown): SpaceVideoItem | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'url' && o.kind !== 'ordinal') return null;
  if (!isAllowedVideoSrc(o.src)) return null;
  const d = num(o.duration_ms);
  const poster = str(o.poster);
  return {
    kind: o.kind,
    src: o.src,
    ...(str(o.outpoint) ? { outpoint: str(o.outpoint) } : {}),
    ...(str(o.title) ? { title: str(o.title) } : {}),
    ...(d && d > 0 ? { durationMs: d } : {}),
    ...(poster && isAllowedPoster(poster) ? { poster } : {}),
  };
};

const isAllowedPoster = (p: string) => {
  try {
    return new URL(p).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * A GET body or a data packet ({type:'space-video', ...}) → SpaceVideo, or null when unreadable.
 * `receivedAt` is the local clock when it arrived. A disallowed src reads as no item.
 */
export const parseSpaceVideo = (raw: unknown, receivedAt: number): SpaceVideo | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const v = (o.video && typeof o.video === 'object' ? o.video : o) as Record<string, unknown>;
  const version = num(v.version);
  if (version === undefined) return null;
  const state: SpaceVideoState = v.state === 'playing' || v.state === 'paused' ? v.state : 'stopped';
  const serverNow = num(v.server_now) ?? receivedAt;
  return {
    item: parseItem(v.item),
    state,
    startedAt: num(v.started_at) ?? serverNow,
    pausedAtMs: Math.max(0, num(v.paused_at_ms) ?? 0),
    loop: v.loop === true,
    version,
    album: parseAlbum(v.album),
    serverNow,
    skew: serverNow - receivedAt,
  };
};

const parseAlbum = (raw: unknown): SpaceAlbum | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.items)) return null;
  const items = o.items
    .slice(0, ALBUM_MAX)
    .map(parseItem)
    .filter((i): i is SpaceVideoItem => !!i);
  if (!items.length) return null;
  const i = num(o.index);
  const index = i !== undefined && Number.isInteger(i) && i >= 0 && i < items.length ? i : 0;
  return { items, index, repeat: o.repeat === true };
};

/** Timed album: every item has duration_ms, so the current track follows from the clock alone. */
export const isTimedAlbum = (a: SpaceAlbum | null | undefined): boolean =>
  !!a && a.items.every((i) => !!i.durationMs && i.durationMs > 0);

export type AlbumCursor = { index: number; ms: number; stopped: boolean };

/**
 * Where an album is now (bit-sign #297): started_at is when the current track (album.index) was at 0.
 * Timed albums walk forward through the durations, wrapping on repeat; untimed ones stay on album.index.
 */
export const albumCursor = (v: SpaceVideo, localNow: number): AlbumCursor | null => {
  const a = v.album;
  if (!a) return null;
  if (v.state === 'stopped') return { index: a.index, ms: 0, stopped: true };
  if (v.state === 'paused') return { index: a.index, ms: v.pausedAtMs, stopped: false };
  let e = Math.max(0, localNow + v.skew - v.startedAt);
  if (!isTimedAlbum(a)) return { index: a.index, ms: e, stopped: false };
  const d = a.items.map((i) => i.durationMs as number);
  const total = d.reduce((x, y) => x + y, 0);
  let i = a.index;
  // Skip whole laps on repeat so a long-running room doesn't loop many times.
  if (a.repeat && total > 0) {
    const toEnd = d.slice(i).reduce((x, y) => x + y, 0);
    if (e >= toEnd) {
      e = (e - toEnd) % total;
      i = 0;
    }
  }
  while (e >= (d[i] as number)) {
    e -= d[i] as number;
    i++;
    if (i >= d.length) {
      if (!a.repeat) return { index: d.length - 1, ms: d[d.length - 1] as number, stopped: true };
      i = 0;
    }
  }
  return { index: i, ms: e, stopped: false };
};

/** "Now playing n/N" (1-based), or null when the Space is not running an album. */
export const nowPlaying = (
  v: SpaceVideo | null,
  localNow = Date.now(),
): { n: number; total: number; title: string; index: number } | null => {
  const a = v?.album;
  if (!a || !v) return null;
  const index = albumCursor(v, localNow)?.index ?? a.index;
  const it = a.items[index];
  return { n: index + 1, total: a.items.length, title: it?.title || `Video ${index + 1}`, index };
};

/** Where the album goes when the current video ends: the next index, wrap on repeat, or null at the end. */
export const nextAlbumIndex = (a: SpaceAlbum): number | null => {
  if (a.index + 1 < a.items.length) return a.index + 1;
  return a.repeat ? 0 : null;
};

/** Move one entry of the host's draft list (reorder UI). Out-of-range moves return the list unchanged. */
export const moveItem = <T>(list: readonly T[], from: number, to: number): T[] => {
  const out = list.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
};

/** A draft album entry → the item the server takes (`play`/`set_album` item shape). */
export type AlbumDraftItem = { kind: 'url' | 'ordinal'; src: string; outpoint?: string; title?: string };

/** Keep the newer copy: only a strictly higher version replaces what we have. */
export const newerVideo = (have: SpaceVideo | null, next: SpaceVideo | null): SpaceVideo | null => {
  if (!next) return have;
  if (!have) return next;
  return next.version > have.version ? next : have;
};

export type Position = { ms: number; ended: boolean };

/**
 * Where the room is now (ms into the item). `localNow` is Date.now(); `mediaDurationMs` is the
 * element's own duration, used for looping when the server sent no duration_ms.
 */
export const positionOf = (v: SpaceVideo, localNow: number, mediaDurationMs?: number): Position => {
  if (!v.item || v.state === 'stopped') return { ms: 0, ended: false };
  if (v.state === 'paused') return { ms: v.pausedAtMs, ended: false };
  const e = Math.max(0, localNow + v.skew - v.startedAt);
  const d =
    v.item.durationMs ??
    (mediaDurationMs && Number.isFinite(mediaDurationMs) && mediaDurationMs > 0 ? mediaDurationMs : undefined);
  if (!d) return { ms: e, ended: false };
  if (v.loop) return { ms: e % d, ended: false };
  return e >= d ? { ms: d, ended: true } : { ms: e, ended: false };
};

/** Seek when the element is more than 1.5 s from where the room is. */
export const needsReseek = (currentMs: number, targetMs: number, threshold = DRIFT_RESEEK_MS) =>
  Math.abs(currentMs - targetMs) > threshold;

/** A data packet on LiveKit: keep only the space-video topic. */
export const parseVideoPacket = (topic: string | undefined, payload: Uint8Array, receivedAt: number) => {
  if (topic !== SPACE_VIDEO_TOPIC) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    if (raw?.type !== undefined && raw.type !== SPACE_VIDEO_TOPIC) return null;
    return parseSpaceVideo(raw, receivedAt);
  } catch {
    return null;
  }
};

export type VideoAction =
  | {
      action: 'play';
      item: { kind: 'url' | 'ordinal'; src: string; outpoint?: string; title?: string };
      loop?: boolean;
    }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'seek'; position_ms: number }
  | { action: 'stop' }
  | { action: 'set_loop'; loop: boolean }
  /** Album Space (bit-sign #297): replace the run and start at `index` (default 0). */
  | { action: 'set_album'; items: AlbumDraftItem[]; repeat: boolean; index?: number }
  /** Album Space: jump to a track (also how a staff phone advances when a video ends). */
  | { action: 'album_goto'; index: number }
  /** Any viewer, on <video> 'ended' of an untimed track. 409 stale_index / too_early are ignored. */
  | { action: 'album_next'; from_index: number }
  | { action: 'clear_album' };

/** ORDFS content URL for an owned ordinal (origin `<txid>_<n>` or `.n`). */
export const ordinalSrc = (origin: string) => `https://ordfs.network/content/${origin.replace('.', '_')}`;
