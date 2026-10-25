import bchatIcon from '../brand/sources/bchat.png';
import coingeekIcon from '../brand/sources/coingeek.png';
import hodlockerIcon from '../brand/sources/hodlocker.png';
import relayxIcon from '../brand/sources/relayx.png';
import otherIcon from '../brand/sources/other.png';
import fwetchIcon from '../brand/sources/fwetch.png';
import peckIcon from '../brand/sources/peck.png';
import treechatIcon from '../brand/sources/treechat.png';
import twetchIcon from '../brand/sources/twetch.png';

/**
 * Feed sources: one entry per app a post can come from (MAP `app`). Adding a syndicated feed
 * is one entry here: how to recognise its MAP app, its label and bundled 64px logo
 * (src/mobile/brand/sources/, never hotlinked), and where its original post lives.
 */
export type Source =
  | 'bchat'
  | 'treechat'
  | 'twetch'
  | 'peck'
  | 'fwetch'
  | 'coingeek'
  | 'hodlocker'
  | 'relayx'
  | 'other';

/**
 * Per-post actions. On-chain ones are Bitcoin Schema transactions signed by the user with
 * `app=bChat` (never as the source app). `bookmark` and `unlock` live on the source's own
 * servers (Twetch bookmarks, Twetch paid unlocks), so they open the post in the source app.
 */
export type PostAction =
  | 'reply'
  | 'like'
  | 'branch'
  | 'quote'
  | 'tip'
  | 'lock'
  | 'copyLink'
  | 'open'
  | 'bookmark'
  | 'unlock'
  | 'report'
  | 'mute';

/** Actions on the row, and the rest under the "…" menu, in display order. */
export type SourceActions = { row: PostAction[]; more: PostAction[] };

/** Actions that need the source's own servers: they open the post in the source app. */
export const REMOTE_ACTIONS: ReadonlySet<PostAction> = new Set(['bookmark', 'unlock']);

/** Actions that need a link to the original post. */
const LINK_ACTIONS: ReadonlySet<PostAction> = new Set(['copyLink', 'open', 'bookmark', 'unlock']);

const BASIC: SourceActions = { row: ['reply', 'like', 'tip', 'lock'], more: ['open', 'copyLink', 'report', 'mute'] };

/** Off-chain items (CoinGeek articles): nothing to reply to, like, tip or lock on chain. */
const READ_ONLY: SourceActions = { row: ['open'], more: ['copyLink', 'report', 'mute'] };

/** CoinGeek's Open Feed key `coingeek:<WordPress post id>` → the article. */
export const coingeekArticleUrl = (txid: string): string | null => {
  const m = /^coingeek:(\d{1,12})$/.exec(txid);
  return m ? `https://coingeek.com/?p=${m[1]}` : null;
};

export type SourceInfo = {
  id: Source;
  label: string;
  icon: string;
  /** Brand colour: the selected source chip and the source's avatar ring. */
  color?: string;
  /** Does this MAP app value belong to the source? (lower-cased, trimmed) */
  matches: (app: string) => boolean;
  /** Link to the original post on the source app, where a URL pattern is known. */
  postUrl: (p: { txid: string; threadId: string | null }) => string | null;
  /** Which actions a post from this source supports. */
  actions: SourceActions;
  /**
   * The app's OWN published payment address for the home app share (spec §6.2): 5% on top of a
   * tip / paid like on its posts. Set only when the app has published or confirmed it — never a
   * relay / shared posting address inferred from its posts (e.g. Treechat's signer). Unset = no share.
   */
  homePayTo?: string;
};

/**
 * bWallet's own social posts are bChat (one network, two apps): new posts, replies, likes,
 * locks, reposts and follows are written with MAP `app=bChat`. Posts written before the
 * rename carry the legacy `app=bWallet`, which still reads as bChat.
 */
export const FEED_APP = 'bChat';
// bchat.online is the app id the Open Rooms spec (docs/OPEN-ROOMS-SPEC.md) gives bChat's on-chain messages.
const LEGACY_FEED_APPS = ['bchat', 'bchat.online', 'bwallet'];

export const SOURCE_REGISTRY: Record<Source, SourceInfo> = {
  bchat: {
    id: 'bchat',
    label: 'bChat',
    icon: bchatIcon,
    color: '#FFFFFF',
    matches: (a) => LEGACY_FEED_APPS.includes(a),
    postUrl: () => null,
    actions: BASIC,
  },
  treechat: {
    id: 'treechat',
    label: 'Treechat',
    icon: treechatIcon,
    // Sampled from brand/sources/treechat.png (dominant non-black colour).
    color: '#8C80E4',
    matches: (a) => a === 'treechat' || a.startsWith('treechat_'),
    // Verified: app.treechat.com/p/<thread id> redirects to /quest/<thread id>.
    postUrl: (p) => (p.threadId ? `https://app.treechat.com/p/${p.threadId}` : null),
    actions: BASIC,
  },
  twetch: {
    id: 'twetch',
    label: 'Twetch',
    icon: twetchIcon,
    // The bundled logo is monochrome (#23242E on white), so this is Twetch's brand blue.
    color: '#085AF6',
    matches: (a) => a === 'twetch',
    // The form Twetch users shared on-chain.
    postUrl: (p) => `https://twetch.com/t/${p.txid}`,
    // Twetch's own post menu (twetch.com app bundle): reply, like, branch / quote ("Branch
    // options"), tip, copy link, bookmark, paid unlock, mute, report. Bookmarks and paid
    // unlocks are Twetch-server state, so they open the post in Twetch.
    actions: {
      row: ['reply', 'like', 'branch', 'tip', 'lock'],
      more: ['quote', 'copyLink', 'open', 'bookmark', 'unlock', 'report', 'mute'],
    },
  },
  peck: {
    id: 'peck',
    label: 'Peck',
    icon: peckIcon,
    // From peck.to's apple-touch-icon (black bird on white); this is a neutral warm accent.
    color: '#E8A33D',
    // peck.to writes MAP app=peck.to; its agents / seed corpora write peck.agents, peck.cross… —
    // attributed to Peck, but only peck.to is read (feedApi.fetchPeck).
    matches: (a) => a === 'peck.to' || a.startsWith('peck.'),
    // Verified 2026-10-06: peck.to/tx/<txid> is its post page.
    postUrl: (p) => `https://peck.to/tx/${p.txid}`,
    actions: BASIC,
  },
  fwetch: {
    id: 'fwetch',
    label: 'Fwetch',
    icon: fwetchIcon,
    // From fwetch.lol/logo-512.png (gold flower on black).
    color: '#F0B81A',
    // Fwetch posts are not MAP; fwetch.ts sets app 'fwetch' on what it reads from its API.
    matches: (a) => a === 'fwetch',
    // Verified 2026-10-06: fwetch.lol routes #/post/<txid> to its thread view.
    postUrl: (p) => `https://fwetch.lol/#/post/${p.txid}`,
    actions: BASIC,
  },
  // The next three come only from bChatX's Open Feed (openFeed.ts); openFeed.ts sets `app` to the id.
  // Icons are bChatX's own bundled 64px logos (www.bchatx.com/feed-sources/<id>.png).
  coingeek: {
    id: 'coingeek',
    label: 'CoinGeek',
    icon: coingeekIcon,
    // CoinGeek's own blue (coingeek.com), with its official CG logo (owner, 25 Oct 2026).
    color: '#0072D6',
    matches: (a) => a === 'coingeek',
    postUrl: (p) => coingeekArticleUrl(p.txid),
    actions: READ_ONLY,
  },
  hodlocker: {
    id: 'hodlocker',
    label: 'Hodlocker',
    icon: hodlockerIcon,
    // Sampled from brand/sources/hodlocker.png.
    color: '#F7931A',
    matches: (a) => a === 'hodlocker',
    // hodlocker.com is gone: no original-post link.
    postUrl: () => null,
    actions: BASIC,
  },
  relayx: {
    id: 'relayx',
    label: 'RelayX',
    icon: relayxIcon,
    // Sampled from brand/sources/relayx.png.
    color: '#3D7BF7',
    matches: (a) => a === 'relayx',
    // RelayX clubs are gone: no original-post link.
    postUrl: () => null,
    actions: BASIC,
  },
  other: {
    id: 'other',
    label: 'Other',
    icon: otherIcon,
    matches: () => true,
    postUrl: () => null,
    actions: BASIC,
  },
};

/** Match order: specific sources first, "other" last. */
const ORDER: Source[] = ['bchat', 'twetch', 'treechat', 'peck', 'fwetch', 'coingeek', 'hodlocker', 'relayx', 'other'];

/** Chips: All, bChat, then the others (same order as bitcoinchat.online/feed). */
export const SOURCES: { id: Source | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  // No "Other" chip: those posts still show under All.
  ...ORDER.filter((id) => id !== 'other').map((id) => ({ id, label: SOURCE_REGISTRY[id].label })),
];

/** Pretty names for "other" apps we know by name. */
const APP_LABELS: Record<string, string> = {
  '1satsocial': '1satsocial',
  '1sat.social': '1satsocial',
  bsocial: 'bSocial',
};

/** A persisted source-filter value, with the pre-rename 'bwallet' id read as 'bchat'. */
export const migrateSourceId = (v: string | null): string | null =>
  v === 'bwallet' ? 'bchat' : v === 'other' ? 'all' : v;

export function sourceOf(app: string): Source {
  const a = app.trim().toLowerCase();
  return ORDER.find((id) => id !== 'other' && SOURCE_REGISTRY[id].matches(a)) ?? 'other';
}

export const sourceInfo = (app: string): SourceInfo => SOURCE_REGISTRY[sourceOf(app)];

/** "Treechat" for the credit line; unknown apps keep their own (trimmed) name; ours / empty → ''. */
export const sourceLabel = (app: string): string => {
  const a = app.trim();
  const s = sourceOf(a);
  if (!a || s === 'bchat') return '';
  if (s !== 'other') return SOURCE_REGISTRY[s].label;
  return APP_LABELS[a.toLowerCase()] ?? a.slice(0, 24);
};

export function sourceUrl(p: { source: Source; threadId: string | null; txid: string }): string | null {
  return SOURCE_REGISTRY[p.source].postUrl(p);
}

/** A post's actions: its source's list, minus link actions when there is no original-post link. */
export function postActions(p: { source: Source; threadId: string | null; txid: string }): SourceActions {
  const info = SOURCE_REGISTRY[p.source] ?? SOURCE_REGISTRY.other;
  const linked = !!info.postUrl(p);
  const keep = (a: PostAction) => linked || !LINK_ACTIONS.has(a);
  return { row: info.actions.row.filter(keep), more: info.actions.more.filter(keep) };
}

export const ACTION_LABELS: Record<PostAction, string> = {
  reply: 'Reply',
  like: 'Like',
  branch: 'Branch',
  quote: 'Quote',
  tip: 'Tip',
  lock: 'Lock',
  copyLink: 'Copy link',
  open: 'Open in',
  bookmark: 'Bookmark in',
  unlock: 'Unlock paid content in',
  report: 'Report post',
  mute: 'Mute',
};

/** Menu label, naming the source app where the action happens there ("Open in Twetch"). */
export const actionLabel = (a: PostAction, source: Source): string =>
  a === 'open' || a === 'bookmark' || a === 'unlock'
    ? `${ACTION_LABELS[a]} ${SOURCE_REGISTRY[source].label}`
    : ACTION_LABELS[a];

/** Readable text on a solid background: near-black on light colours, white on dark (WCAG relative luminance). */
export const textOn = (hex: string): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Contrast vs white (1.05/(l+0.05)) against contrast vs black ((l+0.05)/0.05).
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#1a1300';
};
