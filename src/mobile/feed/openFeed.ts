/**
 * Feeds the wallet only gets through bChatX's public Open Feed: CoinGeek news (a claimable @coingeek
 * profile) and the archived club posts of the defunct Hodlocker and RelayX.
 *
 * Source: GET https://www.bchatx.com/api/feed/open?source=<id>&limit=1..50 (CORS *, no auth, CDN-cached)
 *   → { feed, home, spec, source, posts: [{ txid, url, text, mediaCount, author: {name, handle}, source,
 *       sourceLabel, sourceUrl, at, replyTo, likes, replies, language }] }
 * Moderated upstream (takedowns, authors' hides, NSFW, slurs). Text only: no media or avatar URLs.
 * When www.bchatx.com is unreachable the request moves to chat.bwalletx.com (services/bchatOrigin.ts).
 *
 * Only these three ids are asked for, one request each: the sources we already read directly
 * (Twetch, Treechat, Fwetch, bChat, Peck) never come from here, so a post is never shown twice.
 */
import { routeBchatUrl } from '../../services/bchatOrigin';
import { mediaFromText } from './media';
import { MAX_POST_CHARS, type FeedPost } from './post';
import type { Source } from './sources';

export const OPEN_FEED_ORIGIN = 'https://www.bchatx.com';
export const OPEN_FEED_SOURCES = ['coingeek', 'hodlocker', 'relayx'] as const;
export type OpenFeedSource = (typeof OPEN_FEED_SOURCES)[number];

export const isOpenFeedSource = (s: string): s is OpenFeedSource =>
  (OPEN_FEED_SOURCES as readonly string[]).includes(s);

export const openFeedUrl = (source: OpenFeedSource, limit = 50) =>
  `${OPEN_FEED_ORIGIN}/api/feed/open?source=${source}&limit=${Math.max(1, Math.min(50, Math.floor(limit)))}`;

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** One Open Feed post → FeedPost, or null (wrong source, reply, malformed, empty). */
export function parseOpenPost(raw: unknown, want: OpenFeedSource): FeedPost | null {
  const p = asRec(raw);
  if (asStr(p.source) !== want) return null;
  const txid = asStr(p.txid).trim();
  if (!txid || txid.length > 120 || /\s/.test(txid)) return null;
  if (p.replyTo) return null;
  const body = mediaFromText(asStr(p.text).trim());
  if (!body.text && !body.media.length) return null;
  const a = asRec(p.author);
  const handle = asStr(a.handle).trim().replace(/^@/, '').slice(0, 60);
  const name = asStr(a.name).trim().slice(0, 60);
  const key = handle || name || 'unknown';
  return {
    txid,
    text: body.text.slice(0, MAX_POST_CHARS * 2),
    images: [],
    media: body.media,
    links: body.links,
    app: want,
    source: want as Source,
    threadId: null,
    replyTo: null,
    author: {
      // Never payable: the Open Feed carries no verified address for these authors.
      address: `${want}:${key}`,
      bapId: null,
      name: name || handle || 'Unknown',
      avatar: null,
      source: want as Source,
      sourceId: key,
    },
    at: num(p.at),
    likes: num(p.likes),
    replies: num(p.replies),
    language: p.language === 'strong' ? 'strong' : null,
  };
}

/** The route's body → that source's posts, deduped by txid. Anything malformed is empty. */
export function parseOpenFeed(body: unknown, want: OpenFeedSource): FeedPost[] {
  const posts = asRec(body).posts;
  if (!Array.isArray(posts)) return [];
  const seen = new Set<string>();
  const out: FeedPost[] = [];
  for (const item of posts) {
    const p = parseOpenPost(item, want);
    if (p && !seen.has(p.txid)) {
      seen.add(p.txid);
      out.push(p);
    }
  }
  return out;
}

export type GetJson = (url: string) => Promise<unknown>;

const liveJson: GetJson = async (url) => {
  const res = await fetch(await routeBchatUrl(url), { credentials: 'omit', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`bChatX feed error (${res.status})`);
  return res.json();
};

/** Recent posts of one Open Feed source. Throws on a network / server failure. */
export const fetchOpenFeed = async (source: OpenFeedSource, limit = 50, get: GetJson = liveJson) =>
  parseOpenFeed(await get(openFeedUrl(source, limit)), source);
