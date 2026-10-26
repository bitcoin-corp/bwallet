/**
 * Push notifications, pure parts (tested in push.test.ts). The server is bitcoin-corp/bwalletx-push at
 * https://push.bwalletx.com (src/push/routes.ts there): the app registers each device with its bChat
 * bearer, and bit-sign forwards room events to it. Decisions (owner, 6 Oct 2026): groups default to
 * Mentions (bell: All / Mentions / Off), DMs always notify, message previews off by default.
 */
import type { Channel } from '../channel';
import { bchatxRoomTicker, bchatxRoomUrl, meetingPhase } from '../bmail/meeting';

export const PUSH_ORIGIN = 'https://push.bwalletx.com';

export type PushPlatform = 'ios' | 'android' | 'web' | 'extension';
export type PushApp = 'bwallet' | 'bwalletx';
export type PushEnv = 'production' | 'sandbox';
export type RoomNotify = 'all' | 'mentions' | 'off';

/** The store channels are plain bWallet; every other build (private, direct, web, extension, dev) is bWalletX. */
export const pushAppFor = (channel: Channel, store: boolean): PushApp =>
  store || channel === 'ios-store' || channel === 'android-play' ? 'bwallet' : 'bwalletx';

/** APNs gateway: only iOS has two; a Debug build (Xcode Run, INSTALL=1) gets sandbox tokens. */
export const pushEnvFor = (platform: PushPlatform, nativeEnv?: PushEnv | null): PushEnv =>
  platform === 'ios' && nativeEnv === 'sandbox' ? 'sandbox' : 'production';

/** iOS bundle id when the native layer can't say: ios-private is `.private`, everything else the base id. */
export const iosBundleFor = (channel: Channel): string =>
  channel === 'ios-private' ? 'com.bitcoincorp.bwallet.private' : 'com.bitcoincorp.bwallet';

export interface WebPushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface DeviceBody {
  platform: PushPlatform;
  app: PushApp;
  env?: PushEnv;
  bundleId?: string;
  token?: string;
  webPushSubscription?: WebPushSubscriptionJson;
}

/** POST /v1/devices body. Native sends `token`; web and extension send their Web Push subscription. */
export const deviceBody = (o: {
  platform: PushPlatform;
  channel: Channel;
  store: boolean;
  env?: PushEnv | null;
  bundleId?: string | null;
  token?: string | null;
  subscription?: WebPushSubscriptionJson | null;
}): DeviceBody => {
  const body: DeviceBody = { platform: o.platform, app: pushAppFor(o.channel, o.store) };
  if (o.platform === 'ios') {
    body.env = pushEnvFor('ios', o.env);
    body.bundleId = o.bundleId || iosBundleFor(o.channel);
  } else if (o.platform === 'android' && o.bundleId) body.bundleId = o.bundleId;
  if (o.platform === 'web' || o.platform === 'extension') {
    if (o.subscription) body.webPushSubscription = o.subscription;
  } else if (o.token) body.token = o.token;
  return body;
};

// ── Tap → where to go ──────────────────────────────────────────────────────────────────────────

/** 'signins' = Settings › Chat › Recent sign-ins (the "New sign-in to bChat" alert); ticker is ''. */
/** `space`: ticker is the Space slug (push kind space_live → bwalletx://space/<slug>). */
/** `partner`: a partnership's shared account request (kind partner_account_*, url /m/lock); id = the request. */
/**
 * `mail`: the bMail Inbox, opening the meeting invite for room `ticker` when it is there (kind meeting_invite before
 * the meeting starts). `openUrl`: a bChatX room page to ALSO open in a browser tab (meeting already live; Desktop and
 * the extension only, PushEngine.tsx). Owner, 26 Oct 2026.
 */
export type PushRoute = {
  segment: 'rooms' | 'dms' | 'signins' | 'space' | 'partner' | 'mail';
  ticker: string;
  id?: string;
  openUrl?: string;
};
const REQUEST_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SPACE_SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

const TICKER_RE = /^[A-Z0-9_.-]{1,64}$/;
const normTicker = (t: unknown): string | null => {
  if (typeof t !== 'string') return null;
  const v = t.trim().replace(/^\$/, '').toUpperCase();
  return TICKER_RE.test(v) ? v : null;
};
/** FCM data values are all strings ("true"); APNs and Web Push keep JSON types. */
const truthy = (v: unknown) => v === true || v === 'true' || v === '1';

/**
 * The room a notification is about: data.ticker (or data.room, or a `/room/<TICKER>` url), as a DM
 * when data.dm is set. Null when it isn't about a room (calls ring through CallScreen instead).
 */
export const routeFromData = (
  data: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): PushRoute | null => {
  if (!data || typeof data !== 'object') return null;
  if (data.kind === 'call') return null;
  if (data.kind === 'meeting_invite') return meetingRoute(data, now);
  if (data.kind === 'sign_in') return { segment: 'signins', ticker: '' };
  if (data.kind === 'space_live') {
    // Prefer url (bwalletx://space/<slug>), fall back to slug.
    const fromUrl = typeof data.url === 'string' ? /^bwalletx:\/\/space\/([^/?#]+)\/?$/.exec(data.url)?.[1] : undefined;
    const slug = fromUrl ?? data.slug;
    return typeof slug === 'string' && SPACE_SLUG_RE.test(slug) ? { segment: 'space', ticker: slug } : null;
  }
  if ((typeof data.kind === 'string' && data.kind.startsWith('partner_account')) || data.url === '/m/lock') {
    const t = normTicker(data.ticker);
    if (!t) return null;
    return typeof data.id === 'string' && REQUEST_ID_RE.test(data.id)
      ? { segment: 'partner', ticker: t, id: data.id }
      : { segment: 'partner', ticker: t };
  }
  let ticker = normTicker(data.ticker) ?? normTicker(data.room);
  if (!ticker && typeof data.url === 'string') {
    const m = /\/room\/([^/?#]+)/.exec(data.url);
    if (m) ticker = normTicker(decodeURIComponent(m[1]));
  }
  if (!ticker) return null;
  return { segment: truthy(data.dm) ? 'dms' : 'rooms', ticker };
};

/**
 * meeting_invite {ticker, startsAt (ISO), durationMin, url}: live → the room now (plus the bChatX page on Desktop and
 * the extension); not started yet, over, or no usable start → the bMail Inbox on that invite (owner, 26 Oct 2026).
 */
export const meetingRoute = (data: Record<string, unknown>, now: number): PushRoute | null => {
  const ticker = normTicker(data.ticker) ?? bchatxRoomTicker(data.url);
  if (!ticker) return null;
  const startsAt = typeof data.startsAt === 'string' ? Date.parse(data.startsAt) : NaN;
  const phase = meetingPhase(startsAt, Number(data.durationMin), now);
  if (phase !== 'live') return { segment: 'mail', ticker };
  // Only ever a bchatx.com room page, rebuilt from the ticker: data.url itself is never opened.
  return { segment: 'rooms', ticker, openUrl: bchatxRoomUrl(ticker) };
};

/** Web Push click → `?push=dms:ABC` on the page it opens, read back with routeFromQuery. */
export const routeToQuery = (r: PushRoute) =>
  `push=${r.segment}:${encodeURIComponent(r.ticker)}${r.segment === 'partner' && r.id ? `/${r.id}` : ''}`;
export const routeFromQuery = (search: string): PushRoute | null => {
  const v = new URLSearchParams(search).get('push');
  if (v === 'signins:' || v === 'signins') return { segment: 'signins', ticker: '' };
  const sp = v ? /^space:([A-Za-z0-9_-]{1,64})$/.exec(v) : null;
  if (sp) return { segment: 'space', ticker: sp[1] };
  const ml = v ? /^mail:(.+)$/.exec(v) : null;
  const mt = ml ? normTicker(ml[1]) : null;
  if (mt) return { segment: 'mail', ticker: mt };
  const pa = v ? /^partner:([^/]+)(?:\/([A-Za-z0-9-]{1,64}))?$/.exec(v) : null;
  const pt = pa ? normTicker(pa[1]) : null;
  if (pa && pt) return pa[2] ? { segment: 'partner', ticker: pt, id: pa[2] } : { segment: 'partner', ticker: pt };
  const m = v ? /^(rooms|dms):(.+)$/.exec(v) : null;
  const ticker = m ? normTicker(m[2]) : null;
  return m && ticker ? { segment: m[1] as PushRoute['segment'], ticker } : null;
};

/** What a Web Push service worker shows (the server's webPushPayload: {title, body, tag, data, urgent}). */
export const webNotification = (raw: string | null | undefined) => {
  let p: { title?: unknown; body?: unknown; tag?: unknown; data?: unknown; urgent?: unknown } = {};
  try {
    p = raw ? JSON.parse(raw) : {};
  } catch {
    /* not JSON: show a generic notification */
  }
  const data = p.data && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : {};
  return {
    title: typeof p.title === 'string' && p.title ? p.title : 'bWalletX',
    options: {
      body: typeof p.body === 'string' ? p.body : '',
      tag: typeof p.tag === 'string' && p.tag ? p.tag : undefined,
      data,
      requireInteraction: p.urgent === true,
    },
  };
};

// ── Preferences ────────────────────────────────────────────────────────────────────────────────

/** GET/PUT /v1/prefs as the server speaks it. */
export interface ServerPrefs {
  previews: boolean;
  quietFrom?: string | null;
  quietTo?: string | null;
  tz?: string | null;
  categories?: Record<string, boolean>;
}

/** Settings › Notifications as the screen shows it. */
export interface UiPrefs {
  previews: boolean;
  quiet: boolean;
  quietFrom: string;
  quietTo: string;
  categories: Record<string, boolean>;
}

/**
 * A local copy of "Show message previews" so notices built on this device (notify/engine.ts) honour it too,
 * not only the push server. Off unless the user turned it on.
 */
const PREVIEWS_KEY = 'bwx:notify:previews';
export const localPreviews = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(PREVIEWS_KEY) === '1';
  } catch {
    return false;
  }
};
export const setLocalPreviews = (on: boolean): void => {
  try {
    globalThis.localStorage?.setItem(PREVIEWS_KEY, on ? '1' : '0');
  } catch {
    /* private mode: stays off */
  }
};

export const DEFAULT_QUIET = { from: '22:00', to: '07:00' } as const;
export const DEFAULT_UI_PREFS: UiPrefs = {
  previews: false,
  quiet: false,
  quietFrom: DEFAULT_QUIET.from,
  quietTo: DEFAULT_QUIET.to,
  categories: {},
};

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;
/** "7:5" / "07:05" → "07:05"; null when not a time of day. */
export const normHhmm = (v: unknown): string | null => {
  const m = typeof v === 'string' ? HHMM_RE.exec(v.trim()) : null;
  if (!m) return null;
  const h = Number(m[1]),
    mm = Number(m[2]);
  return h < 24 && mm < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
};

export const fromServerPrefs = (s: Partial<ServerPrefs> | null | undefined): UiPrefs => {
  const from = normHhmm(s?.quietFrom);
  const to = normHhmm(s?.quietTo);
  const quiet = !!from && !!to && from !== to;
  return {
    previews: s?.previews === true,
    quiet,
    quietFrom: quiet ? from! : DEFAULT_QUIET.from,
    quietTo: quiet ? to! : DEFAULT_QUIET.to,
    categories: s?.categories && typeof s.categories === 'object' ? { ...s.categories } : {},
  };
};

/** The PUT body. Quiet hours off = both null; times are read in the device's time zone. */
export const toServerPrefs = (u: UiPrefs, tz: string | null): ServerPrefs => {
  const from = normHhmm(u.quietFrom);
  const to = normHhmm(u.quietTo);
  const on = u.quiet && !!from && !!to && from !== to;
  return {
    previews: u.previews,
    quietFrom: on ? from : null,
    quietTo: on ? to : null,
    tz: on ? tz : null,
    categories: u.categories,
  };
};

export const deviceTimeZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

// ── Per-room bell ──────────────────────────────────────────────────────────────────────────────

export const ROOM_NOTIFY_OPTIONS: { id: RoomNotify; label: string; note: string }[] = [
  { id: 'all', label: 'All messages', note: 'Every message in this room' },
  { id: 'mentions', label: 'Mentions', note: 'Only when someone mentions you' },
  { id: 'off', label: 'Off', note: 'Nothing from this room' },
];

/** A room's setting: what you chose, else the server default (DMs all, groups mentions). */
export const roomNotifyFor = (
  prefs: Record<string, RoomNotify> | null | undefined,
  ticker: string,
  dm = false,
): RoomNotify => {
  const t = normTicker(ticker);
  const v = t ? prefs?.[t] : undefined;
  return v === 'all' || v === 'mentions' || v === 'off' ? v : dm ? 'all' : 'mentions';
};
