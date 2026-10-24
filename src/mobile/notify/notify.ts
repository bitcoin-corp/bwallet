import { hasRate, moneyNow } from '../money/money';
import { cachedExchangeRate } from '../../utils/wallet';
/**
 * bWallet notifications: pure logic (no I/O) — the item list, unread state, "what is new since
 * last time" diffs, mention matching and per-category filtering. engine.ts does the polling.
 */

export type NotifyCategory = 'bmail' | 'social' | 'mentions' | 'chat' | 'calls' | 'payments' | 'sales';
export type NotifyKind =
  | 'reply'
  | 'quote'
  | 'like'
  | 'lock'
  | 'mention'
  | 'chat'
  | 'call'
  | 'payment'
  | 'token'
  | 'sale'
  | 'bmail';

export const KIND_CATEGORY: Record<NotifyKind, NotifyCategory> = {
  reply: 'social',
  quote: 'social',
  like: 'social',
  lock: 'social',
  mention: 'mentions',
  chat: 'chat',
  call: 'calls',
  payment: 'payments',
  token: 'payments',
  sale: 'sales',
  bmail: 'bmail',
};

export const CATEGORY_LABELS: Record<NotifyCategory, { label: string; description: string }> = {
  bmail: { label: 'bMail', description: 'New mail that reaches your Inbox (not Requests)' },
  social: { label: 'Replies, quotes, likes & locks', description: 'On your Twetch, Treechat and bChat posts' },
  mentions: { label: 'Mentions', description: 'Posts and room messages that name you' },
  chat: { label: 'Room messages', description: 'New messages in your bChat rooms' },
  calls: { label: 'Calls', description: 'Incoming and missed calls' },
  payments: { label: 'Incoming payments', description: 'BSV, tokens and tickets received' },
  sales: { label: 'Sales', description: 'When a listing of yours sells' },
};

export const CATEGORIES = Object.keys(CATEGORY_LABELS) as NotifyCategory[];

/** What tapping a notification opens. */
export type NotifyTarget =
  | { type: 'post'; txid: string; twetchId?: number }
  | { type: 'room'; ticker: string }
  | { type: 'wallet' }
  | { type: 'calls' }
  | { type: 'bmail' };

export type NotifyItem = {
  /** Stable id: the same event polled twice yields the same id (deduped). */
  id: string;
  kind: NotifyKind;
  title: string;
  body: string;
  /** Longer preview (up to 280 chars) for the Desktop Notifications page; falls back to body. */
  full?: string;
  /** ms since epoch */
  at: number;
  read: boolean;
  target?: NotifyTarget;
};

export const MAX_ITEMS = 200;
export const MAX_SEEN = 2000;

/** Merge new items into the list (dedupe by id, newest first, capped). Returns the list and the truly new items. */
export function addItems(
  list: NotifyItem[],
  incoming: NotifyItem[],
  max = MAX_ITEMS,
): { list: NotifyItem[]; added: NotifyItem[] } {
  const have = new Set(list.map((i) => i.id));
  const added: NotifyItem[] = [];
  for (const i of incoming) {
    if (have.has(i.id)) continue;
    have.add(i.id);
    added.push(i);
  }
  const merged = [...added, ...list].sort((a, b) => b.at - a.at).slice(0, max);
  return { list: merged, added: added.filter((a) => merged.includes(a)) };
}

export const unreadCount = (list: NotifyItem[]): number => list.reduce((n, i) => n + (i.read ? 0 : 1), 0);
export const markAllRead = (list: NotifyItem[]): NotifyItem[] =>
  list.some((i) => !i.read) ? list.map((i) => (i.read ? i : { ...i, read: true })) : list;
export const markRead = (list: NotifyItem[], id: string): NotifyItem[] =>
  list.map((i) => (i.id === id && !i.read ? { ...i, read: true } : i));

/**
 * Seen-set diff: which `ids` are new, and the updated seen list (most recent kept, capped).
 * `seeded` false (a source's first run) marks everything seen without reporting it, so turning
 * notifications on never floods the user with history.
 */
export function diffSeen(
  seen: string[],
  ids: string[],
  seeded: boolean,
  cap = MAX_SEEN,
): { fresh: string[]; seen: string[] } {
  const set = new Set(seen);
  const fresh = ids.filter((id, i) => !set.has(id) && ids.indexOf(id) === i);
  const next = [...seen, ...fresh].slice(-cap);
  return { fresh: seeded ? fresh : [], seen: next };
}

/** Per-key counter increases (e.g. like counts per post). Unknown keys are a baseline, not an increase. */
export function countIncreases(prev: Record<string, number>, cur: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cur)) {
    const before = prev[k];
    if (typeof before === 'number' && v > before) out[k] = v - before;
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Names a user can be mentioned by, normalized: "$handle", "handle@domain" paymails, "@name".
 * Very short names (< 3 chars) are dropped: too many false positives.
 */
export function mentionNames(raw: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const n = (r ?? '').trim().toLowerCase().replace(/^[@$]/, '');
    if (n.length >= 3) out.add(n);
  }
  return [...out];
}

/** Does `text` mention any of `names` as @name, $name, or the full paymail (word-bounded)? */
export function mentionsMe(text: string, names: string[]): boolean {
  if (!text || !names.length) return false;
  const t = text.toLowerCase();
  return names.some((n) => {
    const e = escape(n);
    const re = n.includes('@')
      ? new RegExp(`(^|[^\\w.@])${e}(?![\\w.-]*\\w)`)
      : new RegExp(`(^|[^\\w])[@$]${e}(?![\\w-])`);
    return re.test(t);
  });
}

export type MeKeys = { addresses: string[]; bapId: string | null; twetchUserId: string | null };

/** Is a post author the current user (any of their addresses, their BAP id, or their Twetch user)? */
export const isMe = (a: { address: string; bapId: string | null }, me: MeKeys, twetchUserId?: string | null): boolean =>
  (!!a.address && me.addresses.includes(a.address)) ||
  (!!a.bapId && a.bapId === me.bapId) ||
  (!!twetchUserId && twetchUserId === me.twetchUserId) ||
  (!!me.twetchUserId && a.address === `twetch:${me.twetchUserId}`);

/** Keep items whose category is switched on. */
export const allowed = (items: NotifyItem[], on: Record<NotifyCategory, boolean>): NotifyItem[] =>
  items.filter((i) => on[KIND_CATEGORY[i.kind]] !== false);

const PRIVATE_BODY: Partial<Record<NotifyKind, string>> = {
  reply: 'New reply',
  quote: 'New quote',
  like: 'On your post',
  lock: 'On your post',
  mention: 'You were mentioned',
  chat: 'New message',
  bmail: 'New mail',
};

/**
 * The body an OS / lock-screen notice may show. With "Show message previews" off (the default) anything built
 * from message or post text is replaced by a generic line; payments, sales and calls carry no message text.
 * The in-app list still shows the full item. (b-Aware report, 24 Oct 2026: the local poller ignored the toggle.)
 */
export const osNoticeBody = (i: Pick<NotifyItem, 'kind' | 'body'>, previews: boolean): string =>
  previews ? i.body : (PRIVATE_BODY[i.kind] ?? i.body);

/** Short one-line excerpt for a notification body. */
export const excerpt = (text: string, max = 90): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Stable 31-bit id for the native notification (Android needs an int). */
export const nativeId = (id: string): number => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h & 0x7fffffff || 1;
};

export const formatSatsShort = (sats: number): string =>
  hasRate(cachedExchangeRate())
    ? moneyNow(sats)
    : sats >= 1e6
      ? `${(sats / 1e8).toFixed(sats >= 1e8 ? 2 : 4).replace(/\.?0+$/, '')} BSV`
      : `${sats.toLocaleString()} sats`;

/**
 * One unspent output newly seen at one of the user's addresses → what to say about it.
 * BSV-21 data → a token (ticket when the token is one the app knows as a ticket); a 1-sat output
 * without token data → an ordinal; anything bigger → a BSV payment. Our own listings are not news.
 */
export type IncomingRow = {
  outpoint: string;
  satoshis?: number;
  data?: { bsv21?: { id?: string; amt?: string; sym?: string }; ordlock?: unknown };
};

export function describeIncoming(
  r: IncomingRow,
  ticketIds: ReadonlySet<string> = new Set(),
): Pick<NotifyItem, 'kind' | 'title' | 'body'> | null {
  if (r.data?.ordlock) return null;
  const tok = r.data?.bsv21;
  if (tok?.id) {
    const ticket = ticketIds.has(tok.id);
    const amt = tok.amt ?? '';
    const sym = tok.sym ? `$${tok.sym.replace(/^\$/, '')}` : 'tokens';
    return {
      kind: 'token',
      title: ticket ? 'Ticket received' : 'Tokens received',
      body: ticket ? `You received ${amt || 'a'} ticket${amt === '1' ? '' : 's'} (${sym})` : `${amt} ${sym}`.trim(),
    };
  }
  const sats = Number(r.satoshis) || 0;
  if (sats === 1) return { kind: 'token', title: 'Item received', body: 'An ordinal arrived in your wallet' };
  if (sats > 1) return { kind: 'payment', title: 'Payment received', body: `You received ${formatSatsShort(sats)}` };
  return null;
}
