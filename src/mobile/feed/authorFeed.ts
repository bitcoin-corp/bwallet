/**
 * A feed author's own posts and profile, read from the source the author came from.
 *
 * Before this, the profile page always asked bmap for posts by BAP id / address. bmap stopped
 * indexing Twetch (and everything else) in April 2026, and Twetch / Peck / Treechat / Fwetch
 * authors carry `twetch:` / `peck:` / `treechat:` / `fwetch:` keys or a key-derived address that
 * no indexer files posts under, so the page under the flip bAvatar came back empty.
 */
import type { Author, FeedPost } from './post';
import type { Source } from './sources';
import { mergePosts, parseBmapFeed, parseTwetchFeed, TWETCH_API } from './post';
import type { OpenFeedSource } from './openFeed';
import { parsePeckFeed, parseTreechatOverlayFeed, PECK_OVERLAY, PECK_READ_APPS, TREECHAT_OVERLAY_APP } from './peck';

/** Which source to read an author's posts from, and that source's id for them. */
export type AuthorRef = {
  source: Source;
  /** Twetch user id, Peck signer key, Treechat username, Fwetch address, or bChat address. */
  id: string;
  /** bChat only: BAP id, when known. */
  bapId: string | null;
};

const PREFIXED = ['twetch', 'peck', 'treechat', 'fwetch', 'coingeek', 'hodlocker', 'relayx'] as const;

/** Map a feed author to the source + id its posts are filed under. */
export function authorRef(a: Pick<Author, 'address' | 'bapId' | 'source' | 'sourceId'>): AuthorRef {
  if (a.source && a.source !== 'bchat' && a.source !== 'other' && a.sourceId)
    return { source: a.source, id: a.sourceId, bapId: null };
  // Older Author objects (followed lists, cached posts) only have the prefixed key.
  for (const p of PREFIXED) {
    if (a.address.startsWith(`${p}:`)) return { source: p, id: a.address.slice(p.length + 1), bapId: null };
  }
  return { source: 'bchat', id: a.address, bapId: a.bapId };
}

/** The author's page on their own site, or null. */
export function authorProfileUrl(r: AuthorRef): string | null {
  if (!r.id || r.id === 'anon' || r.id === 'unknown') return null;
  const id = encodeURIComponent(r.id);
  switch (r.source) {
    case 'twetch':
      return /^\d+$/.test(r.id) ? `https://twetch.com/u/${id}` : null;
    case 'peck':
      return `https://peck.to/u/${id}`;
    case 'treechat':
      return `https://app.treechat.com/u/${id}`;
    case 'fwetch':
      return `https://fwetch.lol/#/u/${id}`;
    // CoinGeek's claimable profile on bChatX. Hodlocker and RelayX are gone.
    case 'coingeek':
      return 'https://www.bchatx.com/u/coingeek';
    default:
      return null;
  }
}

export type AuthorProfile = {
  name: string;
  bio: string;
  followers: number | null;
  following: number | null;
};

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Twetch GET /v1/users/{id} → profile, or null. */
export function parseTwetchUser(body: unknown): AuthorProfile | null {
  const u = asRec(body);
  if (!asStr(u.id)) return null;
  return {
    name: asStr(u.name).trim().slice(0, 60),
    bio: asStr(u.description).trim().slice(0, 400),
    followers: count(u.numFollowers),
    following: count(u.numFollowing),
  };
}

export type AuthorPage = { posts: FeedPost[]; next: string | null };

export type AuthorDeps = {
  getJson: (url: string) => Promise<unknown>;
  /** Twetch public key → address (makes posts tippable, as in the main feed). */
  twetchAddressOf?: (pubKey: string) => string;
  /** bChat indexer + bmap base URLs. */
  bchatApi: string;
  bmapApi: string;
  /** Fwetch's recent posts (verified for tips); there is no per-author endpoint. */
  fwetchPage: (limit: number, offset: number) => Promise<FeedPost[]>;
  /** Treechat thread ids (for the original-post link). */
  treechatEnrich?: (posts: FeedPost[]) => Promise<FeedPost[]>;
  /** A bChatX Open Feed source's recent posts (CoinGeek, Hodlocker, RelayX); no per-author endpoint. */
  openFeed?: (source: OpenFeedSource) => Promise<FeedPost[]>;
};

export const AUTHOR_PAGE = 20;
/** Sources with no per-author filter are scanned this many rows per "page". */
const SCAN = 100;
const SCAN_PAGES = 3;

const newestFirst = (p: FeedPost[]) => [...p].sort((a, b) => b.at - a.at);

const isAuthor = (r: AuthorRef) => (p: FeedPost) =>
  p.author.sourceId === r.id || p.author.address === `${r.source}:${r.id}`;

/** One page of an author's posts, newest first. `cursor` is what the previous page returned. */
export async function fetchAuthorPage(r: AuthorRef, cursor: string | null, d: AuthorDeps): Promise<AuthorPage> {
  const offset = Number(cursor) || 0;
  switch (r.source) {
    case 'twetch': {
      if (!/^\d+$/.test(r.id)) return { posts: [], next: null };
      const q = `limit=${AUTHOR_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await d.getJson(`${TWETCH_API}/v1/users/${r.id}/posts?${q}`);
      const next = asStr(asRec(body).nextCursor);
      const raw = asRec(body).data;
      return {
        posts: newestFirst(parseTwetchFeed(body, d.twetchAddressOf)),
        next: next && Array.isArray(raw) && raw.length >= AUTHOR_PAGE ? next : null,
      };
    }
    case 'peck': {
      const body = await d.getJson(
        `${PECK_OVERLAY}/v1/feed?app=${encodeURIComponent(PECK_READ_APPS[0])}&author=${encodeURIComponent(r.id)}&limit=${AUTHOR_PAGE}&offset=${offset}`,
      );
      const raw = asRec(body).data;
      return {
        posts: newestFirst(parsePeckFeed(body).filter(isAuthor(r))),
        next: Array.isArray(raw) && raw.length >= AUTHOR_PAGE ? String(offset + AUTHOR_PAGE) : null,
      };
    }
    case 'treechat': {
      // Treechat relays everyone through one key, so the overlay can't filter: scan recent posts.
      let found: FeedPost[] = [];
      let at = offset;
      let more = true;
      for (let i = 0; i < SCAN_PAGES && more; i++, at += SCAN) {
        const body = await d.getJson(`${PECK_OVERLAY}/v1/feed?app=${TREECHAT_OVERLAY_APP}&limit=${SCAN}&offset=${at}`);
        const raw = asRec(body).data;
        more = Array.isArray(raw) && raw.length >= SCAN;
        found = found.concat(parseTreechatOverlayFeed(body).filter(isAuthor(r)));
      }
      if (d.treechatEnrich && found.length) found = await d.treechatEnrich(found);
      return { posts: newestFirst(found), next: more ? String(at) : null };
    }
    case 'fwetch': {
      let found: FeedPost[] = [];
      let at = offset;
      let more = true;
      for (let i = 0; i < SCAN_PAGES && more; i++, at += SCAN) {
        const page = await d.fwetchPage(SCAN, at);
        more = page.length >= SCAN / 2; // hidden / empty posts are dropped by the parser
        found = found.concat(page.filter(isAuthor(r)));
      }
      return { posts: newestFirst(found), next: more ? String(at) : null };
    }
    case 'coingeek':
    case 'hodlocker':
    case 'relayx': {
      // One page of the source's recent posts (the Open Feed's max), filtered to the author.
      if (cursor || !d.openFeed) return { posts: [], next: null };
      return { posts: newestFirst((await d.openFeed(r.source)).filter(isAuthor(r))), next: null };
    }
    default: {
      // bChat: our own indexer (current) + bmap (history before April 2026), merged.
      const page = offset ? offset : 1;
      const addr = r.id && !r.id.includes(':') ? r.id : '';
      const tries: Promise<FeedPost[]>[] = [];
      if (addr)
        tries.push(
          d
            .getJson(`${d.bchatApi}/social/post/address/${encodeURIComponent(addr)}?page=${page}&limit=${AUTHOR_PAGE}`)
            .then(parseBmapFeed),
        );
      if (r.bapId)
        tries.push(
          d
            .getJson(`${d.bmapApi}/social/post/bap/${encodeURIComponent(r.bapId)}?page=${page}&limit=${AUTHOR_PAGE}`)
            .then(parseBmapFeed),
        );
      else if (addr)
        tries.push(
          d
            .getJson(`${d.bmapApi}/social/post/address/${encodeURIComponent(addr)}?page=${page}&limit=${AUTHOR_PAGE}`)
            .then(parseBmapFeed),
        );
      const got = await Promise.allSettled(tries);
      const lists = got.flatMap((g) => (g.status === 'fulfilled' ? [g.value] : []));
      if (!lists.length && got.length) throw (got[0] as PromiseRejectedResult).reason;
      const posts = newestFirst(mergePosts(...lists));
      return { posts, next: lists.some((l) => l.length >= AUTHOR_PAGE) ? String(page + 1) : null };
    }
  }
}

/** Basic profile info, where the source has it (Twetch today); null otherwise. */
export async function fetchAuthorProfile(r: AuthorRef, d: Pick<AuthorDeps, 'getJson'>): Promise<AuthorProfile | null> {
  if (r.source !== 'twetch' || !/^\d+$/.test(r.id)) return null;
  return parseTwetchUser(await d.getJson(`${TWETCH_API}/v1/users/${r.id}`));
}
