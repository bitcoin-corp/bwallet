/**
 * Exchange › Memepool: a READ-ONLY listing of the coins on TX Blaster's MEMEPOOL launchpad (txblaster.xyz/memepool).
 * Each coin is a standard BSV-21 token (id = deploy outpoint "<txid>_<vout>") traded on a bonding curve there.
 *
 * Source: their public HTTP API (CORS open, documented at /memepool/api/openapi.json):
 *   GET https://txblaster.xyz/memepool/api/tokens?sort=trending&limit=96&offset=N → { total, tokens: [...] }
 * Price comes from the API's `priceSats` (sats per whole token, read from the curve's state by their server).
 *
 * Nothing here signs, pays or trades. "Trade on Memepool" opens their own coin page in the browser.
 * Their data is untrusted: every field is checked and anything malformed is dropped.
 */

export const MEMEPOOL_ORIGIN = 'https://txblaster.xyz';
export const MEMEPOOL_API = `${MEMEPOOL_ORIGIN}/memepool/api`;
const PAGE = 96; // the API's maximum page size
const MAX_PAGES = 10; // up to 960 coins; the board had 141 on 25 Oct 2026
const TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;

export type MemepoolCoin = {
  id: string;
  sym: string;
  name: string;
  iconUrl: string | null;
  /** Sats per whole token, from the curve. */
  priceSats: number;
  mcapSats: number;
  vol24hSats: number;
  change24h: number | null;
  holders: number;
  /** 0–1: how far through the bonding curve (1 = graduated). */
  progress: number;
  graduated: boolean;
  createdAt: number;
};

const ID_RE = /^[0-9a-f]{64}_\d{1,4}$/;
const ICON_RE = /^\/memepool\/api\/icon\/[0-9a-f]{64}_\d{1,4}$/;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const text = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? v
        .split('')
        .filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)
        .join('')
        .trim()
        .slice(0, max)
    : '';

/** One API row → a coin, or null when it isn't a well-formed BSV-21 coin. */
export const parseCoin = (raw: unknown): MemepoolCoin | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.toLowerCase() : '';
  if (!ID_RE.test(id)) return null;
  const sym = text(r.sym, 20);
  if (!sym) return null;
  const icon = typeof r.icon === 'string' && ICON_RE.test(r.icon) ? `${MEMEPOOL_ORIGIN}${r.icon}` : null;
  const ch = (r.change as Record<string, unknown> | null | undefined)?.h24;
  return {
    id,
    sym,
    name: text(r.name, 60) || sym,
    iconUrl: icon,
    priceSats: num(r.priceSats),
    mcapSats: num(r.mcapSats),
    vol24hSats: num(r.vol24hSats),
    change24h: typeof ch === 'number' && Number.isFinite(ch) ? ch : null,
    holders: Math.floor(num(r.holders)),
    progress: Math.min(1, num(r.progress)),
    graduated: r.graduated === true,
    createdAt: num(r.createdAt),
  };
};

/** A page body → its coins and the board's total. */
export const parsePage = (body: unknown): { total: number; coins: MemepoolCoin[] } => {
  const b = (body ?? {}) as { total?: unknown; tokens?: unknown };
  const rows = Array.isArray(b.tokens) ? b.tokens : [];
  return { total: Math.floor(num(b.total)), coins: rows.map(parseCoin).filter((c): c is MemepoolCoin => !!c) };
};

/** Their coin page, where trading happens. Only ever built from a checked id. */
export const memepoolTradeUrl = (id: string): string =>
  ID_RE.test(id) ? `${MEMEPOOL_ORIGIN}/memepool/token.html?id=${id}` : `${MEMEPOOL_ORIGIN}/memepool/`;

export type MemepoolSort = 'trending' | 'new' | 'mcap' | 'graduating' | 'graduated';
export const MEMEPOOL_SORTS: readonly [MemepoolSort, string][] = [
  ['trending', 'Trending'],
  ['new', 'Newest'],
  ['mcap', 'Biggest'],
  ['graduating', 'Nearly full'],
  ['graduated', 'Graduated'],
];

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const cache = new Map<MemepoolSort, { at: number; coins: MemepoolCoin[] }>();

/** Clears the in-memory cache (tests). */
export const clearMemepoolCache = () => cache.clear();

const getPage = async (f: Fetcher, sort: MemepoolSort, offset: number) => {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await f(`${MEMEPOOL_API}/tokens?sort=${sort}&limit=${PAGE}&offset=${offset}`, {
      signal: ctl?.signal,
      credentials: 'omit',
    });
    if (!res.ok) throw new Error(`Memepool ${res.status}`);
    return parsePage(await res.json());
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Every coin on the board, in the given order (pages until the total is reached). Cached for a minute; on a
 * failure the last good list is returned when there is one, else it throws.
 */
export const fetchMemepoolCoins = async (
  sort: MemepoolSort = 'trending',
  f: Fetcher = (u, i) => fetch(u, i),
  now = Date.now(),
): Promise<MemepoolCoin[]> => {
  const hit = cache.get(sort);
  if (hit && now - hit.at < TTL_MS) return hit.coins;
  try {
    const seen = new Set<string>();
    const coins: MemepoolCoin[] = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const page = await getPage(f, sort, p * PAGE);
      for (const c of page.coins) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        coins.push(c);
      }
      if (page.coins.length < PAGE || (page.total && (p + 1) * PAGE >= page.total)) break;
    }
    cache.set(sort, { at: now, coins });
    return coins;
  } catch (e) {
    if (hit) return hit.coins;
    throw e;
  }
};
