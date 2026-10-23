/**
 * Space pages, room pages and invite links (docs/BSPACES-PLAN.md, "Invite links and tickets"), the
 * pure half: which URLs open what, and the shapes of bit-sign's public reads.
 *
 *   Named Space (permanent) https://<host>/s/<ticker>  → the room, where its live Space docks
 *   Space episode           https://<host>/s/<ticker>/<slug>
 *   Space page (old/private) https://<host>/s/<slug>   bwalletx://space/<slug>
 *   Invite (ephemeral)      https://<host>/i/<code>    bwalletx://invite/<code>
 *   Room page (permanent)   https://<host>/r/<ticker>  bwalletx://room/<ticker>[?buy=1]
 *
 * <host> is bchatx.com (the planned base), bwalletx.com, bit-sign.online or bitcoinchat.online.
 */

const CODE = /^[a-hjkmnp-z2-9]{10}$/;
const TICKER = /^[A-Za-z0-9_-]{1,32}$/;
const WEB_HOSTS = new Set([
  ...['bchatx.com', 'bwalletx.com', 'bit-sign.online', 'bitcoinchat.online'].flatMap((h) => [h, `www.${h}`]),
  'chat.bwalletx.com',
]);

export const isSpaceInviteCode = (s: string) => CODE.test(s);
export const isSpaceSlug = isSpaceInviteCode;
export const isRoomTicker = (s: string) => TICKER.test(s);

export type AppLink =
  | { kind: 'space'; slug: string }
  | { kind: 'invite'; code: string }
  | { kind: 'room'; ticker: string; buy: boolean };

/** What a link opens, or null when it is none of ours. */
export const parseAppLink = (url: string | null | undefined): AppLink | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    let kind = '';
    let arg = '';
    if (u.protocol === 'bwalletx:') {
      // bwalletx://space/<slug>: host "space", path "/<slug>".
      kind = u.host;
      arg = u.pathname.replace(/^\/+|\/+$/g, '');
    } else if (u.protocol === 'https:' && WEB_HOSTS.has(u.host)) {
      // Named Space episode: /s/<ticker>/<slug> opens that Space's page.
      const ep = u.pathname.match(/^\/s\/([^/]+)\/([^/]+)\/?$/);
      if (ep && isRoomTicker(decodeURIComponent(ep[1])) && isSpaceSlug(decodeURIComponent(ep[2]))) {
        return { kind: 'space', slug: decodeURIComponent(ep[2]) };
      }
      const m = u.pathname.match(/^\/([sir])\/([^/]+)\/?$/);
      if (!m) return null;
      kind = { s: 'space', i: 'invite', r: 'room' }[m[1]] ?? '';
      arg = m[2];
    } else return null;
    arg = decodeURIComponent(arg);
    if (kind === 'space' && isSpaceSlug(arg)) return { kind, slug: arg };
    // Named Space (owner, 9 Oct 2026): /s/<ticker> is the room's permanent Space address → open the room.
    if (kind === 'space' && u.protocol === 'https:' && isRoomTicker(arg))
      return { kind: 'room', ticker: arg.toUpperCase(), buy: false };
    if (kind === 'invite' && isSpaceInviteCode(arg)) return { kind, code: arg };
    if (kind === 'room' && isRoomTicker(arg)) return { kind, ticker: arg, buy: u.searchParams.get('buy') === '1' };
    return null;
  } catch {
    return null;
  }
};

export type InviteEntry =
  | { kind: 'free' | 'members'; line: string }
  | { kind: 'token'; symbol: string; amount: string; mode: 'hold' | 'burn'; usd: number | null; line: string };

export interface PublicGate {
  key: string;
  kind: 'bsv21' | 'coll' | null;
  id: string | null;
  symbol: string;
}

interface PageBase {
  url: string;
  ticker: string;
  roomName: string;
  title: string;
  live: boolean;
  statusLine: string;
  entry: InviteEntry;
  gate: PublicGate | null;
}

export interface SpacePage extends PageBase {
  kind: 'space';
  slug: string;
  host: string | null;
  /** The host's chosen display name (bit-sign #95 `host_name`); null before it deploys. */
  hostName?: string | null;
}

export interface RoomPage extends PageBase {
  kind: 'room';
  members: number | null;
  host: null;
}

export type InviteState = 'ok' | 'expired' | 'revoked' | 'used_up';

export interface SpaceInvite {
  code: string;
  url: string;
  state: InviteState;
  expiresAt: string | null;
  target: SpacePage | RoomPage;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

const entryOf = (raw: unknown): InviteEntry => {
  const e = obj(raw) ?? {};
  const line = str(e.line) || 'Members only';
  return e.kind === 'token'
    ? {
        kind: 'token',
        symbol: str(e.symbol),
        amount: str(e.amount) || '1',
        mode: e.mode === 'burn' ? 'burn' : 'hold',
        usd: typeof e.usd === 'number' && Number.isFinite(e.usd) && e.usd > 0 ? e.usd : null,
        line,
      }
    : { kind: e.kind === 'free' ? 'free' : 'members', line };
};

const pageOf = (d: Record<string, unknown>): SpacePage | RoomPage | null => {
  const ticker = str(d.ticker);
  if (!ticker) return null;
  const status = obj(d.status) ?? {};
  const g = obj(d.gate);
  const gkind = g?.kind === 'bsv21' || g?.kind === 'coll' ? g.kind : null;
  const base: PageBase = {
    url: str(d.url),
    ticker,
    roomName: str(d.room_name) || `$${ticker}`,
    title: str(d.title) || str(d.room_name) || `$${ticker}`,
    live: status.state === 'live',
    statusLine: str(status.line),
    entry: entryOf(d.entry),
    gate: g && str(g.key) ? { key: str(g.key), kind: gkind, id: str(g.id) || null, symbol: str(g.symbol) } : null,
  };
  if (d.kind === 'space') {
    const slug = str(d.slug);
    return isSpaceSlug(slug)
      ? { ...base, kind: 'space', slug, host: str(d.host) || null, hostName: str(d.host_name) || null }
      : null;
  }
  if (d.kind === 'room')
    return { ...base, kind: 'room', members: typeof d.members === 'number' ? d.members : null, host: null };
  return null;
};

/** `{ page }` from GET space-pages/<slug> or room-pages/<ticker>. */
export const parsePage = (data: unknown): SpacePage | RoomPage | null => {
  const d = obj(obj(data)?.page);
  return d ? pageOf(d) : null;
};

/** `{ invite }` from the invite GET / use / create. */
export const parseSpaceInvite = (data: unknown): SpaceInvite | null => {
  const d = obj(obj(data)?.invite);
  if (!d) return null;
  const code = str(d.code);
  const target = obj(d.target);
  const page = target ? pageOf(target) : null;
  if (!isSpaceInviteCode(code) || !page) return null;
  const state = (['ok', 'expired', 'revoked', 'used_up'] as const).find((s) => s === d.state) ?? 'expired';
  return { code, url: str(d.url), state, expiresAt: str(d.expires_at) || null, target: page };
};

export interface ManagedInvite {
  code: string;
  url: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  state: InviteState;
}

/** `{ invites }` from the host's list. */
export const parseManagedInvites = (data: unknown): ManagedInvite[] => {
  const list = obj(data)?.invites;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const r = obj(raw);
    const code = str(r?.code);
    if (!r || !isSpaceInviteCode(code)) return [];
    const state = (['ok', 'expired', 'revoked', 'used_up'] as const).find((s) => s === r.state) ?? 'expired';
    return [
      {
        code,
        url: str(r.url),
        createdBy: str(r.created_by),
        createdAt: str(r.created_at),
        expiresAt: str(r.expires_at) || null,
        maxUses: typeof r.max_uses === 'number' ? r.max_uses : null,
        uses: typeof r.uses === 'number' ? r.uses : 0,
        state,
      },
    ];
  });
};

export const EXPIRY_CHOICES = [
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['never', 'Never'],
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number][0];
export const DEFAULT_EXPIRY: ExpiryChoice = '7d';

/** "" or a whole number 1..100000; anything else is null (refuse). */
export const parseMaxUses = (s: string): number | '' | null => {
  const t = s.trim();
  if (!t) return '';
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : null;
};

export const STATE_LINE: Record<InviteState, string> = {
  ok: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  used_up: 'Used up',
};

/** "3 / 10 uses" or "3 uses". */
export const usesLine = (i: Pick<ManagedInvite, 'uses' | 'maxUses'>) =>
  i.maxUses != null ? `${i.uses} / ${i.maxUses} uses` : `${i.uses} ${i.uses === 1 ? 'use' : 'uses'}`;

/** The text that goes with a shared link. */
export const inviteShareText = (inv: { title: string; live: boolean; url: string }) =>
  `${inv.live ? 'Live now: ' : ''}${inv.title}\n${inv.url}`;
