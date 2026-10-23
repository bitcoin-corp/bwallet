/**
 * bNews (phase 1): news headlines as Feed threads.
 *
 * Headlines come from a small set of public RSS/Atom feeds. We keep only the headline, source,
 * time, link and image; never the article body or summary (copyright). Each story opens as a
 * thread; the discussion is ordinary on-chain bChat posts that link the story ("the chain is the
 * feed"), so no new server or storage is needed. Swiping a story away hides it on this device.
 *
 * Fetching: the phone apps read the feeds through the native HTTP layer (no CORS) and fall back
 * to bit-sign's GET /api/bitsign/news; web and desktop use that route (same sources, same rules).
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { routeBchatUrl } from '../../services/bchatOrigin';

export type NewsSourceId = 'coingeek' | 'hn' | 'ars' | 'bbc-tech' | 'wired' | 'other';

export type NewsSource = {
  id: NewsSourceId;
  label: string;
  url: string;
};

/** Reputable BSV/bitcoin and general-tech feeds (checked 14 Oct 2026). */
export const NEWS_SOURCES: NewsSource[] = [
  { id: 'coingeek', label: 'CoinGeek', url: 'https://coingeek.com/feed/' },
  { id: 'hn', label: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { id: 'ars', label: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { id: 'bbc-tech', label: 'BBC Tech', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { id: 'wired', label: 'WIRED', url: 'https://www.wired.com/feed/rss' },
];

export type NewsItem = {
  /** Stable id: the normalised link. */
  id: string;
  title: string;
  link: string;
  source: NewsSourceId;
  sourceLabel: string;
  /** Published time, ms (0 when the feed gave none). */
  at: number;
  /** https image only, else null. */
  image: string | null;
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text of an element's content: CDATA unwrapped, tags stripped, entities decoded, spaces collapsed. */
const textOf = (raw: string): string =>
  decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
};

const attr = (el: string, name: string): string | null => {
  const m = el.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
};

const httpsOnly = (u: string | null): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const webLink = (u: string | null): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/**
 * Normalised story URL for ids, dedupe and matching posts: lower-case host without `www.`,
 * no hash, no tracking params (utm_*, fbclid, gclid), no trailing slash.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()])
      if (/^utm_/i.test(k) || k === 'fbclid' || k === 'gclid' || k === 'ref') u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

const imageOf = (block: string): string | null => {
  for (const re of [/<media:content\b[^>]*>/gi, /<media:thumbnail\b[^>]*>/gi, /<enclosure\b[^>]*>/gi]) {
    for (const el of block.match(re) ?? []) {
      const type = attr(el, 'type') ?? attr(el, 'medium') ?? 'image';
      if (!/image/i.test(type) && !el.toLowerCase().startsWith('<media:thumbnail')) continue;
      const u = httpsOnly(attr(el, 'url'));
      if (u) return u;
    }
  }
  return null;
};

const timeOf = (raw: string | null): number => {
  if (!raw) return 0;
  const t = Date.parse(textOf(raw));
  return Number.isFinite(t) ? t : 0;
};

/** Parse an RSS 2.0 or Atom document into headline items (no body text is kept). */
export function parseFeed(xml: string, source: Pick<NewsSource, 'id' | 'label'>): NewsItem[] {
  if (typeof xml !== 'string' || !xml) return [];
  const out: NewsItem[] = [];
  const isAtom = /<feed\b[^>]*xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(xml) && !/<rss\b/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks) {
    const titleRaw = tag(b, 'title');
    const title = titleRaw ? textOf(titleRaw) : '';
    let link: string | null;
    if (isAtom) {
      const links = b.match(/<link\b[^>]*>/gi) ?? [];
      const alt = links.find((l) => (attr(l, 'rel') ?? 'alternate') === 'alternate') ?? links[0];
      link = webLink(alt ? attr(alt, 'href') : null);
    } else {
      const l = tag(b, 'link');
      link = webLink(l ? textOf(l) : null);
      if (!link) {
        const g = b.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
        if (g && !/isPermaLink\s*=\s*["']false/i.test(g[0])) link = webLink(textOf(g[1]));
      }
    }
    if (!title || !link) continue;
    const at = timeOf(tag(b, isAtom ? 'published' : 'pubDate') ?? tag(b, isAtom ? 'updated' : 'dc:date'));
    out.push({
      id: normalizeUrl(link),
      title: title.slice(0, 300),
      link,
      source: source.id,
      sourceLabel: source.label,
      at,
      image: imageOf(b),
    });
  }
  return out;
}

const titleKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Merge feeds: one item per story (same normalised link, or the same headline from two
 * sources), the earliest-listed copy wins but keeps an image from a duplicate. Newest first.
 */
export function dedupeNews(lists: NewsItem[][]): NewsItem[] {
  const byId = new Map<string, NewsItem>();
  const byTitle = new Map<string, string>();
  for (const list of lists)
    for (const it of list) {
      const tk = titleKey(it.title);
      const hit = byId.get(it.id) ?? (tk ? byId.get(byTitle.get(tk) ?? '') : undefined);
      if (hit) {
        if (!hit.image && it.image) hit.image = it.image;
        continue;
      }
      const copy = { ...it };
      byId.set(it.id, copy);
      if (tk) byTitle.set(tk, it.id);
    }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

// ── swipe-closed stories (per device) ─────────────────────────────────────────

export const HIDDEN_KEY = 'bwallet.bnews.hidden';
/** Keep the list small: the newest closes win. */
export const MAX_HIDDEN = 500;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadHidden(store: Store | null = defaultStore()): string[] {
  try {
    const v = JSON.parse(store?.getItem(HIDDEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const saveHidden = (list: string[], store: Store | null) => {
  try {
    store?.setItem(HIDDEN_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable
  }
};

export function hideStory(hidden: string[], id: string, store: Store | null = defaultStore()): string[] {
  const next = [...hidden.filter((h) => h !== id), id].slice(-MAX_HIDDEN);
  saveHidden(next, store);
  return next;
}

export function unhideStory(hidden: string[], id: string, store: Store | null = defaultStore()): string[] {
  const next = hidden.filter((h) => h !== id);
  saveHidden(next, store);
  return next;
}

export const visibleNews = (items: NewsItem[], hidden: string[]): NewsItem[] => {
  const h = new Set(hidden);
  return items.filter((i) => !h.has(i.id));
};

/** Horizontal swipe distance (px) past which a card closes on release. */
export const SWIPE_CLOSE_PX = 96;
/** A left swipe closes; a mostly vertical drag (a scroll) never does. */
export const swipeCloses = (dx: number, dy: number, threshold = SWIPE_CLOSE_PX): boolean =>
  dx <= -threshold && Math.abs(dx) > Math.abs(dy) * 1.5;

// ── bNews chip on/off (per device) ──────────────────────────────────────────

const MODE_KEY = 'bwallet.feed.bnews';
export const loadNewsMode = (): boolean => {
  try {
    return localStorage.getItem(MODE_KEY) === '1';
  } catch {
    return false;
  }
};
export const saveNewsMode = (on: boolean) => {
  try {
    localStorage.setItem(MODE_KEY, on ? '1' : '0');
  } catch {
    // storage unavailable
  }
};

// ── discussion: on-chain posts that link the story ────────────────────────────

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Does this post text link the story? */
export const linksStory = (text: string, storyId: string): boolean =>
  (text.match(URL_RE) ?? []).some((u) => normalizeUrl(u.replace(/[.,;:!?]+$/, '')) === storyId);

/** Posts (deduped by txid, oldest first) that link the story. */
export function discussionFor<P extends { txid: string; text: string; at: number }>(storyId: string, posts: P[]): P[] {
  const seen = new Set<string>();
  return posts
    .filter((p) => {
      if (seen.has(p.txid) || !linksStory(p.text, storyId)) return false;
      seen.add(p.txid);
      return true;
    })
    .sort((a, b) => a.at - b.at);
}

// ── fetching ──────────────────────────────────────────────────────────────────

/** bit-sign's GET /api/bitsign/news: the same sources fetched and parsed server-side, CDN-cached. */
export const NEWS_API = 'https://www.bchatx.com/api/bitsign/news';

export type FetchText = (url: string) => Promise<string | null>;
export type FetchJson = (url: string) => Promise<unknown>;

const nativeText: FetchText = async (url) => {
  const r = await CapacitorHttp.request({
    method: 'GET',
    url: await routeBchatUrl(url),
    headers: {},
    responseType: 'text',
  });
  return r.status === 200 && typeof r.data === 'string' ? r.data : null;
};

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

const PER_SOURCE = 20;

/** The route's `{ items }`, re-checked here: titles, web links and https images only. */
export function parseNewsResponse(data: unknown): NewsItem[] {
  const list = (data as { items?: unknown })?.items;
  if (!Array.isArray(list)) return [];
  const out: NewsItem[] = [];
  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r.title !== 'string' || typeof r.link !== 'string') continue;
    const link = webLink(r.link);
    const title = textOf(r.title).slice(0, 300);
    if (!link || !title) continue;
    const src = NEWS_SOURCES.find((s) => s.id === r.source);
    out.push({
      id: normalizeUrl(link),
      title,
      link,
      source: src?.id ?? 'other',
      sourceLabel: src?.label ?? (typeof r.sourceLabel === 'string' ? textOf(r.sourceLabel).slice(0, 40) : 'News'),
      at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
      image: typeof r.image === 'string' ? httpsOnly(r.image) : null,
    });
  }
  return dedupeNews([out]);
}

async function fromRoute(json: FetchJson): Promise<NewsItem[]> {
  try {
    return parseNewsResponse(await json(NEWS_API));
  } catch {
    return [];
  }
}

/**
 * Web and desktop: bit-sign's news route (browsers can't read most feeds: no CORS). Phones: the
 * feeds directly through native HTTP, falling back to the route when that gives nothing.
 */
export async function fetchNews(
  native = Capacitor.isNativePlatform(),
  get: FetchText = nativeText,
  json: FetchJson = native ? nativeJson : webJson,
): Promise<NewsItem[]> {
  if (!native) return fromRoute(json);
  const lists = await Promise.all(
    NEWS_SOURCES.map((s) =>
      get(s.url)
        .then((xml) => (xml ? parseFeed(xml, s).slice(0, PER_SOURCE) : []))
        .catch(() => []),
    ),
  );
  const direct = dedupeNews(lists);
  return direct.length ? direct : fromRoute(json);
}
