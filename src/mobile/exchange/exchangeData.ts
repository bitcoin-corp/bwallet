/**
 * Exchange (desktop.bwalletx.com/exchange): data for the token board and the trade screen. Prices come from
 * live 1Sat listings (GorillaPool's BSV-21 market, market/indexer.ts) and past sales; nothing here signs or spends.
 */
import { cached } from '../market/indexer';

/** One finished trade of a BSV-21 token: block height, whole-token price and the total paid, in sats. */
export type Trade = { height: number; satsPerToken: number; totalSats: number; amount: number };

/** About one day of blocks (10-minute blocks). */
export const DAY_BLOCKS = 144;

/** Past sales of a token, oldest first (GorillaPool), with the total paid kept for volume. */
export const tokenTrades = (tokenId: string, limit = 100): Promise<Trade[]> =>
  cached(`trades:${tokenId}:${limit}`, async () => {
    try {
      const r = await fetch(
        `https://ordinals.gorillapool.io/api/bsv20/market/sales?id=${encodeURIComponent(tokenId)}&limit=${limit}&dir=desc`,
      );
      if (!r.ok) return [];
      return parseTrades(await r.json());
    } catch {
      return [];
    }
  });

type SaleRow = { amt?: string; price?: string; dec?: number; spendHeight?: number; height?: number };

/** GorillaPool sale rows → trades, oldest first; rows without a price, amount or height are dropped. */
export const parseTrades = (rows: unknown): Trade[] => {
  if (!Array.isArray(rows)) return [];
  return (rows as SaleRow[])
    .map((s) => {
      const amount = Number(s.amt ?? 0) / 10 ** (s.dec ?? 0);
      const totalSats = Number(s.price ?? 0);
      return {
        height: Number(s.spendHeight || s.height || 0),
        amount,
        totalSats,
        satsPerToken: amount > 0 ? totalSats / amount : 0,
      };
    })
    .filter((t) => t.satsPerToken > 0 && t.height > 0 && Number.isFinite(t.satsPerToken))
    .sort((a, b) => a.height - b.height);
};

/** Current chain height (WhatsOnChain), or 0 when unknown. */
export const chainTip = (): Promise<number> =>
  cached(
    'tip',
    async () => {
      try {
        const r = await fetch('https://api.whatsonchain.com/v1/bsv/main/chain/info');
        if (!r.ok) return 0;
        const j = (await r.json()) as { blocks?: number };
        return Number(j.blocks) || 0;
      } catch {
        return 0;
      }
    },
    5 * 60_000,
  );

export type DayStats = {
  /** Last trade price per whole token, in sats (null: never traded). */
  last: number | null;
  /** Change over the last day as a fraction (0.05 = +5%); null when there is no earlier trade to compare. */
  change: number | null;
  /** Sats traded in the last day. */
  volume: number;
  trades: number;
};

/**
 * Last price, 24h change and 24h volume from trades (oldest first). `tip` is the chain height; with no tip the
 * newest trade's height stands in. The change compares the latest price with the last trade before the window.
 */
export const dayStats = (trades: readonly Trade[], tip = 0): DayStats => {
  if (!trades.length) return { last: null, change: null, volume: 0, trades: 0 };
  const now = Math.max(tip, trades[trades.length - 1].height);
  const from = now - DAY_BLOCKS;
  const inDay = trades.filter((t) => t.height > from);
  const before = trades.filter((t) => t.height <= from);
  const last = trades[trades.length - 1].satsPerToken;
  const ref = before.length ? before[before.length - 1].satsPerToken : null;
  return {
    last,
    change: ref ? (last - ref) / ref : null,
    volume: Math.round(inDay.reduce((s, t) => s + t.totalSats, 0)),
    trades: inDay.length,
  };
};

/** "+4.2%" / "−3.1%" / "0.0%"; an em dash when unknown. */
export const changeLabel = (c: number | null): string => {
  if (c === null || !Number.isFinite(c)) return '—';
  const pct = c * 100;
  const s = Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)).toString() : Math.abs(pct).toFixed(1);
  return `${pct > 0.0499 ? '+' : pct < -0.0499 ? '−' : ''}${s}%`;
};

/** Sats → "0.0012 BSV" (up to 8 places, trailing zeros trimmed). */
export const bsvLabel = (sats: number): string => {
  const bsv = sats / 1e8;
  if (bsv === 0) return '0 BSV';
  const places = bsv >= 1 ? 4 : 8;
  return `${bsv.toFixed(places).replace(/\.?0+$/, '')} BSV`;
};

/** Sats → "$1.23" at `rate` USD per BSV; '' when the rate is unknown. Sub-cent values keep two significant digits. */
export const fiatLabel = (sats: number, rate: number): string => {
  if (!(rate > 0)) return '';
  const usd = (sats / 1e8) * rate;
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toPrecision(2)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Price per whole token: sats under 1 BSV-cent shown as sats, else BSV. */
export const unitPriceLabel = (satsPerToken: number): string =>
  satsPerToken >= 1e6
    ? bsvLabel(satsPerToken)
    : satsPerToken >= 1
      ? `${Math.round(satsPerToken).toLocaleString('en-US')} sats`
      : `${satsPerToken.toPrecision(2)} sats`;

// ── URLs ────────────────────────────────────────────────────────────────────

export type ExchangeView =
  | { tab: 'markets' }
  | { tab: 'swap' }
  | { tab: 'orders' }
  | { tab: 'names' }
  | { tab: 'podcasts' }
  | { tab: 'memepool' }
  | { tab: 'movies' }
  | { tab: 'launchpad' }
  | { tab: 'launch' }
  | { tab: 'more' }
  | { tab: 'platforms' }
  | { tab: 'platform'; slug: string }
  | { tab: 'trade'; id: string };

/** A BSV-21 token id: <txid>_<vout>. */
export const TOKEN_ID = /^[0-9a-f]{64}_\d{1,6}$/i;

/** The router's path under /m/exchange → which screen to show. Unknown segments fall back to Markets. */
export const exchangeView = (rest: string): ExchangeView => {
  const segs = rest.replace(/^\/+|\/+$/g, '').split('/');
  const seg = segs[0] ?? '';
  if (seg === 'platform' || seg === 'platforms') {
    const slug = (segs[1] ?? '').toLowerCase();
    return /^[a-z0-9][a-z0-9-]{0,39}$/.test(slug) ? { tab: 'platform', slug } : { tab: 'platforms' };
  }
  if (seg === 'swap') return { tab: 'swap' };
  if (seg === 'orders') return { tab: 'orders' };
  if (seg === 'names') return { tab: 'names' };
  if (seg === 'podcasts') return { tab: 'podcasts' };
  if (seg === 'memepool') return { tab: 'memepool' };
  if (seg === 'movies') return { tab: 'movies' };
  if (seg === 'launchpad') return segs[1] === 'new' ? { tab: 'launch' } : { tab: 'launchpad' };
  if (seg === 'collectibles') return { tab: 'more' };
  const id = decodeURIComponent(seg).replace('.', '_');
  if (TOKEN_ID.test(id)) return { tab: 'trade', id: id.toLowerCase() };
  return { tab: 'markets' };
};

export const EXCHANGE_ROUTE = '/m/exchange';
export const tradeRoute = (id: string) => `${EXCHANGE_ROUTE}/${id}`;
/** Launch your own coin (Exchange › Launchpad). */
export const LAUNCH_ROUTE = `${EXCHANGE_ROUTE}/launchpad/new`;
export const platformRoute = (slug?: string) => `${EXCHANGE_ROUTE}/platform${slug ? `/${slug}` : ''}`;

// ── favourites + my trades (this device) ────────────────────────────────────

const FAV_KEY = 'bwallet.exchange.favs';
const HIST_KEY = 'bwallet.exchange.history';

const read = <T>(key: string, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: favourites just don't persist */
  }
};

export const loadFavs = (): string[] => read<unknown[]>(FAV_KEY, []).filter((x): x is string => typeof x === 'string');
export const toggleFav = (favs: readonly string[], id: string): string[] => {
  const next = favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id];
  write(FAV_KEY, next);
  return next;
};

export type MyTrade = {
  txid: string;
  tokenId: string;
  symbol: string;
  amountLabel: string;
  totalSats: number;
  at: number;
};
export const loadHistory = (): MyTrade[] =>
  read<MyTrade[]>(HIST_KEY, []).filter((t) => t && typeof t.txid === 'string' && typeof t.tokenId === 'string');
export const addHistory = (t: MyTrade) => write(HIST_KEY, [t, ...loadHistory()].slice(0, 100));
