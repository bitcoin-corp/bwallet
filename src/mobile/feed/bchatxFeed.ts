/**
 * Generic bApp feed: a bApp's bChatX brand-account posts (www.bchatx.com/u/<slug>).
 *
 * Source: bit-sign's public GET /api/feed/author/<slug>?tab=posts[&cursor=<next>] → {posts, next, tab}
 * (no auth, CDN-cached; CORS allows web.bwalletx.com and desktop.bwalletx.com). Phones read it through
 * the native HTTP layer (no CORS), like bnews.ts. Only the fields a card needs are kept, re-checked here.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { routeBchatUrl } from '../../services/bchatOrigin';

export const BCHATX_ORIGIN = 'https://www.bchatx.com';

export const authorFeedUrl = (slug: string, cursor?: string | null) =>
  `${BCHATX_ORIGIN}/api/feed/author/${encodeURIComponent(slug)}?tab=posts${
    cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
  }`;

/** The brand account's profile on bChatX. */
export const profileUrl = (slug: string) => `${BCHATX_ORIGIN}/u/${encodeURIComponent(slug)}`;

export type BrandMedia = { kind: 'image' | 'video' | 'audio'; src: string; thumb: string | null };

export type BrandPost = {
  id: string;
  text: string;
  /** ms epoch (0 when unknown). */
  at: number;
  media: BrandMedia[];
  /** Where tapping the post goes: the bChatX post page, or the original for external posts. */
  link: string;
  /** The creator credited on a repost (as in the bMovies reel). */
  credit: { via: string; profileUrl: string | null } | null;
};

export type BrandPage = { posts: BrandPost[]; next: string | null };

const https = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/[^\s]+$/i.test(v) ? v : null);

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const MEDIA_KINDS = new Set(['image', 'video', 'audio']);

function parseMedia(p: Record<string, unknown>): BrandMedia[] {
  const out: BrandMedia[] = [];
  for (const m of Array.isArray(p.media) ? p.media : []) {
    const r = (m ?? {}) as Record<string, unknown>;
    const src = https(r.src);
    if (src && MEDIA_KINDS.has(str(r.kind)))
      out.push({ kind: r.kind as BrandMedia['kind'], src, thumb: https(r.thumb) });
  }
  if (!out.length)
    for (const i of Array.isArray(p.images) ? p.images : []) {
      const src = https(
        typeof i === 'string'
          ? i
          : ((i as Record<string, unknown> | null)?.url ?? (i as Record<string, unknown> | null)?.src),
      );
      if (src) out.push({ kind: 'image', src, thumb: null });
    }
  return out.slice(0, 4);
}

/** One post, or null when it has no id. On-chain ids link to /feed/p/<txid>; external ones to their original. */
export function parseBrandPost(raw: unknown): BrandPost | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  const id = str(p.txid);
  if (!id) return null;
  const credit = (p.credit ?? null) as Record<string, unknown> | null;
  const onChain = /^[0-9a-f]{64}$/i.test(id);
  const link = onChain
    ? `${BCHATX_ORIGIN}/feed/p/${id.toLowerCase()}`
    : (https(credit?.originalUrl) ?? `${BCHATX_ORIGIN}/feed/p/${encodeURIComponent(id)}`);
  const at = typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : 0;
  const via = str(credit?.via);
  return {
    id,
    text: str(p.text).slice(0, 2000),
    at,
    media: parseMedia(p),
    link,
    credit: via ? { via, profileUrl: https(credit?.profileUrl) } : null,
  };
}

/** The route's `{posts, next}`, re-checked. Anything malformed is an empty page. */
export function parseBrandPage(data: unknown): BrandPage {
  const d = (data ?? {}) as Record<string, unknown>;
  const posts = (Array.isArray(d.posts) ? d.posts : []).map(parseBrandPost).filter((p): p is BrandPost => !!p);
  const next = typeof d.next === 'string' && d.next ? d.next : null;
  return { posts, next };
}

export type FetchJson = (url: string) => Promise<unknown>;

const webJson: FetchJson = async (url) => {
  const r = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(12_000) });
  return r.ok ? r.json() : null;
};

const nativeJson: FetchJson = async (url) => {
  const r = await CapacitorHttp.request({
    method: 'GET',
    url: await routeBchatUrl(url),
    headers: {},
    responseType: 'json',
  });
  return r.status === 200 ? r.data : null;
};

/** A page of a brand account's posts. Throws on a network / server failure (the view shows it). */
export async function fetchBrandPage(
  slug: string,
  cursor: string | null = null,
  get: FetchJson = Capacitor.isNativePlatform() ? nativeJson : webJson,
): Promise<BrandPage> {
  const data = await get(authorFeedUrl(slug, cursor));
  if (data == null) throw new Error('Could not load these posts.');
  return parseBrandPage(data);
}
