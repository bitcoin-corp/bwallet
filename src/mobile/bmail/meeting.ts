/**
 * Meeting invites as bMail (pure; tested in meeting.test.ts). Owner, 26 Oct 2026: bChatX sends a meeting invite as a
 * bMail the user writes themselves from a pre-filled compose screen, plus a `meeting_invite` push. No new money code:
 * the compose link only fills the form; Send goes through the normal bMail send path, postage and approval included.
 *
 *   Compose link (the contract bChatX calls):
 *     bwalletx://mail/compose?to=<paymail-or-$handle>&subject=<s>&body=<b>
 *     https://web.bwalletx.com/?mail=compose&to=…&subject=…&body=…
 *   Meeting link in a bMail body:
 *     https://www.bchatx.com/room/<TICKER>  or  https://www.bchatx.com/chat?room=<TICKER>
 *     optional marker anywhere in the body: `startsAt=<ISO>` (or "Starts at: <ISO>"), `durationMin=<n>`
 */
import { BODY_MAX, SUBJECT_MAX } from './envelope';

/** Join opens this long before the start (owner, 26 Oct 2026: "enabled from 10 minutes before"). */
export const MEETING_EARLY_MS = 10 * 60_000;
/** A meeting without a stated length counts as an hour. */
export const DEFAULT_MEETING_MIN = 60;

export type MeetingPhase = 'before' | 'live' | 'over';

/** Where a meeting is at `now`: live from startsAt until startsAt + duration. Null when startsAt is not a time. */
export const meetingPhase = (startsAt: number, durationMin: number | undefined, now: number): MeetingPhase | null => {
  if (!Number.isFinite(startsAt)) return null;
  const mins = durationMin && durationMin > 0 && Number.isFinite(durationMin) ? durationMin : DEFAULT_MEETING_MIN;
  if (now < startsAt) return 'before';
  return now < startsAt + mins * 60_000 ? 'live' : 'over';
};

/** Join button: on from 10 minutes before the start; with no start time known, always on. */
export const canJoinMeeting = (startsAt: number | undefined, now: number): boolean =>
  startsAt === undefined || !Number.isFinite(startsAt) || now >= startsAt - MEETING_EARLY_MS;

const TICKER_RE = /^[A-Z0-9_.-]{1,64}$/;
const normTicker = (t: string | null | undefined): string | null => {
  const v = (t ?? '').trim().replace(/^\$/, '').toUpperCase();
  return TICKER_RE.test(v) ? v : null;
};
const BCHATX_HOSTS = new Set(['www.bchatx.com', 'bchatx.com']);

/** The canonical room page (built from the ticker only, so it is always a bchatx.com https link). */
export const bchatxRoomUrl = (ticker: string) => `https://www.bchatx.com/room/${encodeURIComponent(ticker)}`;

/** The room ticker of a bChatX room link (/room/<T> or /chat?room=<T>, https only), else null. */
export const bchatxRoomTicker = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !BCHATX_HOSTS.has(u.hostname) || u.port) return null;
  const m = /^\/room\/([^/]+)\/?$/.exec(u.pathname);
  if (m) {
    try {
      return normTicker(decodeURIComponent(m[1]));
    } catch {
      return null;
    }
  }
  if (u.pathname === '/chat' || u.pathname === '/chat/') return normTicker(u.searchParams.get('room'));
  return null;
};

const LINK_RE = /https:\/\/(?:www\.)?bchatx\.com\/(?:room\/[^\s<>"')\]]+|chat\/?\?[^\s<>"')\]]+)/gi;
const ISO = '(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:?\\d{2}))';
const STARTS_RE = new RegExp(`starts[ _-]?at\\s*[=:]\\s*${ISO}`, 'i');
const DURATION_RE = /duration[ _-]?min\s*[=:]\s*(\d{1,4})/i;

export type MeetingLink = { ticker: string; url: string; startsAt?: number; durationMin?: number };

/** The first bChatX room link in a bMail body, with its start time and length when the body states them. */
export const findMeetingLink = (body: string): MeetingLink | null => {
  if (typeof body !== 'string' || !body) return null;
  for (const m of body.matchAll(LINK_RE)) {
    const ticker = bchatxRoomTicker(m[0].replace(/[).,;:!?'"\]]+$/, ''));
    if (!ticker) continue;
    const out: MeetingLink = { ticker, url: bchatxRoomUrl(ticker) };
    const s = STARTS_RE.exec(body);
    const at = s ? Date.parse(s[1]) : NaN;
    if (Number.isFinite(at)) out.startsAt = at;
    const d = DURATION_RE.exec(body);
    if (d && Number(d[1]) > 0) out.durationMin = Number(d[1]);
    return out;
  }
  return null;
};

export type ComposePrefill = { to?: string; subject?: string; body?: string };

// $handle, or a paymail (name@domain.tld). Anything else is dropped rather than shown as a recipient.
const HANDLE_RE = /^\$[A-Za-z0-9_.-]{1,64}$/;
const PAYMAIL_RE = /^[A-Za-z0-9_.+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;
const WEB_HOSTS = new Set(['web.bwalletx.com', 'desktop.bwalletx.com']);
// Control characters out (tabs and newlines stay), without a control-character regex (eslint no-control-regex).
const strip = (s: string) =>
  Array.from(s)
    .filter((c) => {
      const n = c.charCodeAt(0);
      return n === 9 || n === 10 || n === 13 || (n >= 32 && n !== 127);
    })
    .join('');

const prefillFrom = (q: URLSearchParams): ComposePrefill => {
  const out: ComposePrefill = {};
  const to = (q.get('to') ?? '').trim();
  if (HANDLE_RE.test(to) || PAYMAIL_RE.test(to)) out.to = to;
  const subject = strip(q.get('subject') ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SUBJECT_MAX);
  if (subject) out.subject = subject;
  const body = strip(q.get('body') ?? '').slice(0, BODY_MAX);
  if (body.trim()) out.body = body;
  return out;
};

/**
 * A compose link → the fields to pre-fill, or null when it is not one. Never sends: BMailScreen opens Compose with
 * these filled in and the user presses Send (owner, 26 Oct 2026).
 */
export const parseComposeLink = (raw: string | null | undefined): ComposePrefill | null => {
  if (typeof raw !== 'string' || !raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol === 'bwalletx:') {
    // bwalletx://mail/compose → host "mail", path "/compose" (WHATWG URL keeps the host for custom schemes).
    const path = `${u.host}${u.pathname}`.replace(/\/+$/, '');
    return path === 'mail/compose' ? prefillFrom(u.searchParams) : null;
  }
  if (u.protocol === 'https:' && WEB_HOSTS.has(u.hostname)) return parseComposeQuery(u.search);
  return null;
};

/** The web app's own query (`?mail=compose&to=…`), as read from window.location.search. */
export const parseComposeQuery = (search: string): ComposePrefill | null => {
  const q = new URLSearchParams(search);
  return q.get('mail') === 'compose' ? prefillFrom(q) : null;
};

/** Query keys the web compose link uses, removed from the address bar once taken. */
export const COMPOSE_QUERY_KEYS = ['mail', 'to', 'subject', 'body'] as const;
