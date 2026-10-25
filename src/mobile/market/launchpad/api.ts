/** BlastPad (tokenblaster.lol's BSV-21 bonding-curve launchpad) public API. CORS is open on /api/launch/*. */
import { price } from './curve';

export const BLASTPAD = 'https://www.tokenblaster.lol';

export type BoardCoin = {
  slot: string;
  token_id: string;
  sym: string;
  name: string;
  description: string;
  creator: string;
  route: unknown;
  sold: string | number;
  reserve_sats: string | number;
  burned: string | number;
  route_accrued: string | number;
  ath_sold: string | number;
  graduated_at: string | null;
  grad_rank: number | null;
  created_at: string;
  vol24: string | number;
  trades24: string | number;
  holders: string | number;
  sold24: string | number | null;
  /** Ready-made price (sats per token) TokenBlaster is adding; derived from the curve when absent. */
  price_sats?: string | number | null;
  /** Optional store fields TokenBlaster is adding (read through exchange/tokenStore.ts). */
  theme?: unknown;
  room?: unknown;
  merch_url?: unknown;
  /** TokenBlaster: false = no curve buy/sell (earned tokens, P2P only). See noCurve.ts. */
  trading?: boolean;
  /** Where to earn a trading:false token (validated before use). */
  earn_url?: unknown;
};

export const coinImage = (tokenId: string) => `https://ordfs.network/${tokenId.split('_')[0]}_0`;
/** TokenBlaster's launch form (src/app/launch/new in tokenblaster.lol). */
export const launchPage = `${BLASTPAD}/launch/new`;
export const coinPage = (tokenId: string) => `${BLASTPAD}/launch/${tokenId}`;
export const wocTx = (txid: string) => `https://whatsonchain.com/tx/${txid}`;

/** A numeric API field as a bigint (integers only; anything else is 0). */
export const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? 0).split('.')[0] || '0');
  } catch {
    return 0n;
  }
};

/** 24h change: price now over price 24h ago, minus 1. null when there's no 24h point. */
export const change24 = (c: Pick<BoardCoin, 'sold' | 'sold24'>): number | null => {
  if (c.sold24 === null || c.sold24 === undefined) return null;
  const then = price(big(c.sold24));
  return then > 0 ? price(big(c.sold)) / then - 1 : null;
};

/** Board order: 24h volume, then 24h trades, then newest. */
export const sortBoard = (coins: BoardCoin[]): BoardCoin[] =>
  [...coins].sort(
    (a, b) =>
      Number(b.vol24 ?? 0) - Number(a.vol24 ?? 0) ||
      Number(b.trades24 ?? 0) - Number(a.trades24 ?? 0) ||
      Date.parse(b.created_at) - Date.parse(a.created_at),
  );

/** Newest launches first ("New on TokenBlaster"). Rows with an unreadable date go last. */
export const sortNewest = (coins: BoardCoin[]): BoardCoin[] => {
  const t = (c: BoardCoin) => {
    const v = Date.parse(c.created_at);
    return Number.isFinite(v) ? v : 0;
  };
  return [...coins].sort((a, b) => t(b) - t(a));
};

/** Sats per token: the server's `price_sats` when it is a sane number, else from the curve. */
export const boardPrice = (c: Pick<BoardCoin, 'sold' | 'price_sats'>): number => {
  const p = Number(c.price_sats);
  return c.price_sats !== null && c.price_sats !== undefined && Number.isFinite(p) && p > 0 ? p : price(big(c.sold));
};

/** "launched 3h ago" style age, plain English. */
export const launchedAgo = (iso: string, now = Date.now()): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 60) return m <= 1 ? 'just now' : `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)} days ago`;
};

const getJson = async <T>(path: string): Promise<T> => {
  const r = await fetch(`${BLASTPAD}${path}`);
  const j = await r.json().catch(() => ({ error: `BlastPad answered ${r.status}.` }));
  if (!r.ok || j.error) throw new Error(j.error ?? `BlastPad answered ${r.status}.`);
  return j as T;
};

export const fetchCoins = () => getJson<{ coins: BoardCoin[] }>('/api/launch/coins').then((j) => j.coins ?? []);
export const fetchCoin = (id: string) =>
  getJson<{ coin: BoardCoin; indexed: boolean | null; reserves: unknown }>(
    `/api/launch/coin?token=${encodeURIComponent(id)}`,
  );
