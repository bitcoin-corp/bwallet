import { hasRate, moneyNow } from '../money/money';
import { listingVersion } from './ordlockVersion';
import { cachedExchangeRate } from '../../utils/wallet';
/**
 * Market data from the 1Sat indexers (1sat-stack at api.1sat.app). Ported from
 * the 1satsocial project (src/lib/{hot,listings,market,indexer,content,room-ref}.ts)
 * minus its server-only parts (Next caches, chat signal). Results are cached
 * in memory for 30s; every request has a timeout.
 */
export const ONESAT = 'https://api.1sat.app/1sat';
const CACHE_MS = 30_000;

export type RoomKind = 'bsv21' | 'coll';
export type RoomRef = { kind: RoomKind; id: string; key: string };

const OUTPOINT = /^[0-9a-f]{64}_\d{1,6}$/;
export const isOutpoint = (s: string) => OUTPOINT.test(s);

export function parseRoom(kind: string, rawId: string): RoomRef | null {
  const id = rawId.trim().toLowerCase().replace('.', '_');
  if ((kind === 'bsv21' || kind === 'coll') && OUTPOINT.test(id)) return { kind, id, key: `${kind}:${id}` };
  return null;
}

// ── content ──────────────────────────────────────────────────────────────────
/** Inscription content hosts, in fallback order (use with <img onError> to step through). */
export const CONTENT_HOSTS = [
  'https://api.1sat.app/content',
  'https://ordfs.network/content',
  'https://ordinals.gorillapool.io/content',
];
export const contentUrls = (outpoint: string | null | undefined): string[] =>
  outpoint && isOutpoint(outpoint.replace('.', '_'))
    ? CONTENT_HOSTS.map((h) => `${h}/${outpoint.replace('.', '_')}`)
    : [];

// ── fetch + cache ────────────────────────────────────────────────────────────
const cache = new Map<string, { value: unknown; expires: number }>();
const pending = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, fn: () => Promise<T>, ttl = CACHE_MS): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const running = pending.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = fn()
    .then((value) => {
      cache.set(key, { value, expires: Date.now() + ttl });
      return value;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** Drop cached market data (pull to refresh / after a purchase). */
export const clearMarketCache = () => cache.clear();

async function getJson<T>(url: string, timeoutMs = 15_000, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`1Sat indexer ${res.status}`);
  return res.json() as Promise<T>;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ── search / listings ────────────────────────────────────────────────────────
export type SearchRow = {
  outpoint: string;
  score: number;
  data?: {
    bsv21?: { id?: string; amt?: string };
    ordlock?: { price?: number; seller?: { AddressString?: string } };
  };
};

export async function search(params: Record<string, string | string[]>): Promise<SearchRow[]> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) q.append(k, x);
  return (await getJson<SearchRow[] | null>(`${ONESAT}/txo/search?${q}`, 30_000)) ?? [];
}

type OrdfsMeta = {
  origin?: string;
  contentType?: string;
  map?: {
    name?: string;
    subType?: string;
    subTypeData?: string | { collectionId?: string; description?: string };
  } & Record<string, unknown>;
};

/** What the indexer knows about an inscription (from ORDFS metadata of its origin). */
export type ItemMeta = {
  origin: string;
  contentType: string | null;
  name: string | null;
  collectionId: string | null;
  /** Raw MAP fields (strings), for the safety filter (nsfw / adult / rating flags, descriptions). */
  map: Record<string, unknown>;
};
const itemMetas = new Map<string, ItemMeta | null>(); // immutable: no expiry

const parseStd = (std: unknown): Record<string, unknown> => {
  if (std && typeof std === 'object') return std as Record<string, unknown>;
  try {
    const v = JSON.parse(typeof std === 'string' ? std : '') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Content type and MAP metadata of the inscription at this outpoint. null on a transient error (not cached). */
export async function itemInfo(outpoint: string): Promise<ItemMeta | null> {
  if (itemMetas.has(outpoint)) return itemMetas.get(outpoint)!;
  let value: ItemMeta | null;
  try {
    const res = await fetch(`${ONESAT}/ordfs/metadata/${outpoint.replace('_', '.')}:-2`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const meta = (await res.json()) as OrdfsMeta;
      const m = meta.map ?? {};
      const std = parseStd(m.subTypeData);
      const coll = m.subType === 'collectionItem' && typeof std.collectionId === 'string' ? std.collectionId : null;
      value = {
        origin: (meta.origin ?? outpoint).replace('.', '_'),
        contentType: meta.contentType ?? null,
        name: typeof m.name === 'string' ? m.name : null,
        collectionId: coll,
        map: { ...m, subTypeData: std },
      };
    } else if (res.status === 404) {
      value = { origin: outpoint.replace('.', '_'), contentType: null, name: null, collectionId: null, map: {} };
    } else {
      return null; // transient: don't cache
    }
  } catch {
    return null;
  }
  itemMetas.set(outpoint, value);
  return value;
}

type ItemInfo = {
  id: string;
  name: string | null;
  origin: string;
  image: boolean;
  contentType: string | null;
  /** Raw MAP fields, for the safety filter. */
  map: Record<string, unknown>;
};

/** Collection (and item name) of the inscription at this outpoint, from its origin. */
export async function itemCollection(outpoint: string): Promise<ItemInfo | null> {
  const m = await itemInfo(outpoint);
  if (!m?.collectionId) return null;
  return {
    id: m.collectionId,
    name: m.name,
    origin: m.origin,
    image: !!m.contentType?.startsWith('image/'),
    contentType: m.contentType,
    map: m.map,
  };
}

export type RecentListing = {
  event: 'listed' | 'sold';
  outpoint: string; // txid_vout
  kind: RoomKind;
  id: string;
  priceSats: number;
  amount: string | null;
  name: string | null;
  origin: string | null;
  seller: string;
  height: number | null;
  contentType?: string | null;
  /** The item's MAP fields (collections), for the safety filter. */
  map?: Record<string, unknown> | null;
};

const heightOf = (score?: number) => (score && score < 1e8 ? Math.floor(score) : null);

async function liveListings(): Promise<RecentListing[]> {
  const rows = await search({ key: 'ordlock', rev: 'true', unspent: 'true', limit: '100', tags: 'bsv21,ordlock' });
  const mapped = await mapLimit(rows, 16, async (r): Promise<RecentListing | null> => {
    const outpoint = r.outpoint.replace('.', '_');
    const priceSats = r.data?.ordlock?.price ?? 0;
    if (!priceSats) return null;
    const seller = r.data?.ordlock?.seller?.AddressString ?? '';
    const token = r.data?.bsv21;
    if (token?.id && token.amt) {
      const ref = parseRoom('bsv21', token.id);
      return ref
        ? {
            event: 'listed',
            outpoint,
            kind: 'bsv21',
            id: ref.id,
            priceSats,
            amount: token.amt,
            name: null,
            origin: null,
            seller,
            height: heightOf(r.score),
          }
        : null;
    }
    const item = await itemCollection(outpoint);
    const ref = item ? parseRoom('coll', item.id) : null;
    return ref && item
      ? {
          event: 'listed',
          outpoint,
          kind: 'coll',
          id: ref.id,
          priceSats,
          amount: null,
          name: item.name,
          origin: item.origin,
          seller,
          height: heightOf(r.score),
          contentType: item.contentType,
          map: item.map,
        }
      : null;
  });
  return mapped.filter((l): l is RecentListing => !!l);
}

type MarketRow = {
  outpoint: string;
  data?: { ordlock?: { name?: string; origin?: string; price?: number; spend_score?: number } };
};

async function sales(): Promise<RecentListing[]> {
  const rows = (await getJson<MarketRow[] | null>(`${ONESAT}/market/listings?status=sale&limit=50`, 20_000)) ?? [];
  const mapped = await mapLimit(rows, 16, async (r): Promise<RecentListing | null> => {
    const lock = r.data?.ordlock;
    const origin = lock?.origin?.replace('.', '_');
    if (!lock?.price || !origin) return null;
    const item = await itemCollection(origin);
    const ref = item ? parseRoom('coll', item.id) : null;
    return ref && item
      ? {
          event: 'sold',
          outpoint: r.outpoint.replace('.', '_'),
          kind: 'coll',
          id: ref.id,
          priceSats: lock.price,
          amount: null,
          name: lock.name ?? item.name,
          origin: item.origin,
          seller: '',
          height: heightOf(lock.spend_score),
          contentType: item.contentType,
          map: item.map,
        }
      : null;
  });
  return mapped.filter((l): l is RecentListing => !!l);
}

/** Newest live listings ("active") or sales ("sale"). */
export const recentListings = (status: 'active' | 'sale' = 'active') =>
  cached(`recent:${status}`, () => (status === 'active' ? liveListings() : sales()));

type OverlayToken = {
  token_id?: string;
  output_count?: number;
  is_active?: boolean;
  is_blacklisted?: boolean;
  symbol?: string;
  icon?: string;
};

export type DirectoryToken = { id: string; sym: string; icon: string | null; outputs: number };

/** api.1sat.app answers 502 now and then (5 Oct 2026): one quick retry before giving up. */
async function getJsonRetry<T>(url: string, timeoutMs: number): Promise<T> {
  try {
    return await getJson<T>(url, timeoutMs);
  } catch {
    await new Promise((r) => setTimeout(r, 800));
    return getJson<T>(url, timeoutMs);
  }
}

type GpMarketRow = { id?: string; sym?: string; tick?: string; icon?: string | null };
/** Fallback when the 1Sat overlay is down: every token with a live GorillaPool listing. */
async function gorillaDirectory(): Promise<DirectoryToken[]> {
  const rows = await getJson<GpMarketRow[]>(
    'https://ordinals.gorillapool.io/api/bsv20/market?limit=300&dir=desc',
    12_000,
  );
  const out = new Map<string, DirectoryToken>();
  for (const r of rows ?? []) {
    if (!r.id || out.has(r.id) || !parseRoom('bsv21', r.id)) continue;
    const icon = r.icon && isOutpoint(r.icon) ? r.icon : null;
    out.set(r.id, { id: r.id, sym: (r.sym || r.tick || r.id.slice(0, 8)).replace(/^\$/, ''), icon, outputs: 0 });
  }
  return [...out.values()];
}

const overlayTokens = () =>
  cached(
    'tokens:all',
    async () => {
      let rows: OverlayToken[] = [];
      try {
        rows = (await getJsonRetry<OverlayToken[] | null>(`${ONESAT}/bsv21/tokens`, 20_000)) ?? [];
      } catch {
        /* fall through to GorillaPool */
      }
      if (!rows.length) {
        const fallback = await gorillaDirectory();
        // Throwing keeps an empty answer out of the cache, so the next open tries again.
        if (!fallback.length) throw new Error('The token index is unreachable right now.');
        return fallback;
      }
      return rows
        .filter((t) => t.token_id && t.is_active && !t.is_blacklisted && parseRoom('bsv21', t.token_id))
        .sort((a, b) => (b.output_count ?? 0) - (a.output_count ?? 0))
        .map(
          (t): DirectoryToken => ({
            id: t.token_id!,
            sym: (t.symbol || t.token_id!.slice(0, 8)).replace(/^\$/, ''),
            icon: t.icon && isOutpoint(t.icon) ? t.icon : null,
            outputs: t.output_count ?? 0,
          }),
        );
    },
    10 * 60_000,
  );

/** Every active BSV-21 token the 1Sat overlay knows (symbol + icon included), most-used first. */
export const tokenDirectory = (): Promise<DirectoryToken[]> => overlayTokens();

/**
 * Tokens view list: trending tokens first (by heat), then the rest of the overlay's
 * active tokens by usage. Deduped by token id.
 */
export function mergeTokenBoard(trending: HotRoom[], directory: DirectoryToken[]): HotRoom[] {
  const out = new Map<string, HotRoom>();
  const outputs = new Map(directory.map((d) => [d.id, d.outputs]));
  for (const r of [...trending].filter((r) => r.ref.kind === 'bsv21').sort((a, b) => b.heat - a.heat))
    out.set(r.ref.key, { ...r, outputs: r.outputs ?? outputs.get(r.ref.id) });
  for (const d of directory) {
    const ref = parseRoom('bsv21', d.id);
    if (!ref || out.has(ref.key)) continue;
    out.set(ref.key, {
      ref,
      title: `$${d.sym}`,
      subtitle: 'BSV-21 token',
      icon: d.icon,
      trades: 0,
      newListings: 0,
      floorLabel: null,
      heat: 0,
      outputs: d.outputs,
    });
  }
  return [...out.values()];
}

/** Most-used active BSV-21 tokens in the 1Sat overlay. */
export const activeTokens = (limit = 20) =>
  cached(
    'tokens',
    async () => {
      return (await overlayTokens()).map((t) => t.id);
    },
    10 * 60_000,
  ).then((ids) => ids.slice(0, limit));

// ── metadata ─────────────────────────────────────────────────────────────────
export type RoomMeta = {
  title: string;
  subtitle: string;
  icon: string | null;
  dec: number;
  sym: string;
  /** The collection inscription's MAP fields (collections only), for the safety filter. */
  map?: Record<string, unknown> | null;
};

type Bsv21Token = { token?: { sym?: string; icon?: string; dec?: string | number } };

const description = (std: unknown) => {
  if (std && typeof std === 'object') return (std as { description?: string }).description;
  try {
    return (JSON.parse(typeof std === 'string' ? std : '') as { description?: string }).description;
  } catch {
    return undefined;
  }
};

export const roomMeta = (kind: RoomKind, id: string): Promise<RoomMeta | null> =>
  cached(
    `meta:${kind}:${id}`,
    async () => {
      try {
        if (kind === 'bsv21') {
          const { token: t } = await getJson<Bsv21Token>(`${ONESAT}/bsv21/${id}`);
          const sym = (t?.sym ?? id.slice(0, 8)).replace(/^\$/, '');
          return {
            title: `$${sym}`,
            subtitle: 'BSV-21 token',
            icon: t?.icon ?? null,
            dec: Number(t?.dec ?? 0) || 0,
            sym,
          };
        }
        const m = await getJson<OrdfsMeta>(`${ONESAT}/ordfs/metadata/${id.replace('_', '.')}`);
        return {
          title: m.map?.name || `Collection ${id.slice(0, 8)}`,
          subtitle: description(m.map?.subTypeData)?.slice(0, 140) || '1Sat Ordinals collection',
          icon: m.contentType?.startsWith('image/') ? id : null,
          dec: 0,
          sym: '',
          map: m.map ? { ...m.map, subTypeData: parseStd(m.map.subTypeData) } : null,
        };
      } catch {
        return null;
      }
    },
    10 * 60_000,
  );

export function formatAmount(amount: bigint, dec: number): string {
  if (dec <= 0) return amount.toLocaleString('en-US');
  const base = BigInt(10) ** BigInt(dec);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(dec, '0').slice(0, 2).replace(/0+$/, '');
  return whole.toLocaleString('en-US') + (frac ? `.${frac}` : '');
}

/** USD first at the live rate; sats/BSV only when the rate is unknown. (Name kept for callers.) */
export function formatSats(sats: number): string {
  if (hasRate(cachedExchangeRate())) return moneyNow(sats);
  if (sats >= 1e8) return `${(sats / 1e8).toLocaleString('en-US', { maximumFractionDigits: 4 })} BSV`;
  return `${sats.toLocaleString('en-US')} sats`;
}

const formatPerToken = (sats: number) =>
  hasRate(cachedExchangeRate())
    ? moneyNow(sats)
    : sats >= 1
      ? formatSats(Math.round(sats))
      : `${sats.toPrecision(2).replace(/\.?0+$/, '')} sats`;

// ── per-item market ──────────────────────────────────────────────────────────
export type Listing = {
  outpoint: string;
  priceSats: number;
  amount: string | null; // raw token units (BSV-21)
  /** BSV-21: this listing's price per whole token, in sats (decimals applied). */
  perTokenSats?: number;
  label: string;
  origin: string | null; // art (collections)
  seller: string;
  contentType?: string | null;
  /** The item's MAP fields (collections), for the safety filter. */
  map?: Record<string, unknown> | null;
  /** Can be bought in-app (BSV-21: the overlay recognises it; buyBsv21 validates against it). */
  buyable: boolean;
};

export type RoomMarket = {
  listings: Listing[];
  floorLabel: string | null;
  floorSats: number | null;
  live: number;
  buyableCount: number;
};

const EMPTY: RoomMarket = { listings: [], floorLabel: null, floorSats: null, live: 0, buyableCount: 0 };

type GpListing = { outpoint: string; amt: string; price: string; owner?: string; spend?: string; id: string };

/** Live BSV-21 listings from GorillaPool, cheapest first, in the txo/search row shape; null if unavailable. */
async function gorillaListings(tokenId: string): Promise<SearchRow[] | null> {
  try {
    const rows = await getJson<GpListing[] | null>(
      `https://ordinals.gorillapool.io/api/bsv20/market?id=${encodeURIComponent(tokenId)}&limit=100&dir=asc&sort=price_per_token`,
      6_000,
    );
    if (!Array.isArray(rows)) return null;
    return rows
      .filter((r) => !r.spend && r.id === tokenId && Number(r.price) > 0)
      .map(
        (r) =>
          ({
            outpoint: r.outpoint,
            data: {
              bsv21: { id: r.id, amt: r.amt },
              ordlock: { price: Number(r.price), seller: r.owner ? { AddressString: r.owner } : undefined },
            },
          }) as unknown as SearchRow,
      );
  } catch {
    return null;
  }
}

/** Which BSV-21 listing outpoints the 1Sat overlay recognises. */
async function overlayValid(tokenId: string, outpoints: string[]): Promise<Set<string>> {
  if (!outpoints.length) return new Set();
  try {
    const rows = await getJson<{ outpoint: string }[] | null>(`${ONESAT}/bsv21/${tokenId}/outputs`, 15_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(outpoints),
    });
    return new Set((rows ?? []).map((r) => r.outpoint.replace('.', '_')));
  } catch {
    return new Set();
  }
}

async function loadMarket(room: RoomRef, limit: number): Promise<RoomMarket> {
  if (room.kind === 'coll') {
    // 1sat-stack can't search listings by collection yet: use its items among the newest live listings.
    const meta = await roomMeta(room.kind, room.id);
    const listings = (await recentListings('active'))
      .filter((l) => l.kind === 'coll' && l.id === room.id)
      .map(
        (l): Listing => ({
          outpoint: l.outpoint,
          priceSats: l.priceSats,
          amount: null,
          label: l.name ?? meta?.title ?? 'Item',
          origin: l.origin,
          seller: l.seller,
          contentType: l.contentType,
          map: l.map ?? null,
          buyable: true,
        }),
      )
      .sort((a, b) => a.priceSats - b.priceSats);
    await mapLimit(
      listings.slice(0, limit),
      8,
      async (l) => void ((await listingVersion(l.outpoint)) !== 2 && (l.buyable = false)),
    );
    return {
      listings: listings.slice(0, limit),
      floorLabel: listings[0] ? formatSats(listings[0].priceSats) : null,
      floorSats: listings[0]?.priceSats ?? null,
      live: listings.length,
      buyableCount: listings.length,
    };
  }
  // GorillaPool's token market answers in under a second; 1Sat's txo/search takes 7–15 s for busy
  // tokens (measured 3 Oct 2026). Use GorillaPool first, fall back to the search if it fails.
  // eslint-disable-next-line prefer-const
  let [rows, meta] = await Promise.all([
    gorillaListings(room.id).then(
      (r) =>
        r ??
        search({
          key: [`bsv21:${room.id}`, 'ordlock'],
          join: 'intersect',
          unspent: 'true',
          rev: 'true',
          limit: '100',
          tags: 'bsv21,ordlock',
        }),
    ),
    roomMeta(room.kind, room.id),
  ]);
  const seen = new Set<string>();
  rows = rows.filter((r) => !seen.has(r.outpoint) && !!seen.add(r.outpoint)); // search can repeat rows
  const valid = await overlayValid(
    room.id,
    rows.map((r) => r.outpoint),
  );
  const dec = meta?.dec ?? 0;
  const listings = rows
    .filter(
      (r) =>
        r.data?.bsv21?.id === room.id &&
        (r.data.ordlock?.price ?? 0) > 0 &&
        BigInt(r.data.bsv21.amt ?? '0') > BigInt(0),
    )
    .map(
      (r): Listing => ({
        outpoint: r.outpoint.replace('.', '_'),
        priceSats: r.data!.ordlock!.price!,
        amount: r.data!.bsv21!.amt!,
        perTokenSats: r.data!.ordlock!.price! / (Number(r.data!.bsv21!.amt!) / 10 ** dec),
        label: `${formatAmount(BigInt(r.data!.bsv21!.amt!), dec)} $${meta?.sym ?? ''}`,
        origin: null,
        seller: r.data!.ordlock!.seller?.AddressString ?? '',
        buyable: valid.has(r.outpoint.replace('.', '_')),
      }),
    )
    .sort((a, b) => a.priceSats - b.priceSats);
  const perToken = (l: Listing) => l.priceSats / (Number(l.amount) / 10 ** dec);
  const floor = listings.length ? Math.min(...listings.map(perToken)) : null;
  const picked = listings.slice(0, limit);
  for (const l of listings.filter((x) => x.buyable).slice(0, 3)) if (!picked.includes(l)) picked.push(l);
  // OrdLock v1 is retired (ordlockVersion.ts): only v2 listings are offered as buyable.
  await mapLimit(
    picked.filter((l) => l.buyable),
    8,
    async (l) => void ((await listingVersion(l.outpoint)) !== 2 && (l.buyable = false)),
  );
  return {
    listings: picked,
    floorLabel: floor === null ? null : `${formatPerToken(floor)} / token`,
    floorSats: floor,
    live: listings.length,
    buyableCount: listings.filter((l) => l.buyable).length,
  };
}

/** Cheapest listings for a token or collection. */
export const roomMarket = (room: RoomRef, limit = 20) =>
  cached(`market:${room.key}:${limit}`, () => loadMarket(room, limit).catch(() => EMPTY));

// ── trending ("hot board") ───────────────────────────────────────────────────
export type HotRoom = {
  ref: RoomRef;
  title: string;
  subtitle: string;
  icon: string | null;
  trades: number;
  newListings: number;
  floorLabel: string | null;
  heat: number;
  /** Token outputs in the overlay (a holder/usage proxy); tokens only. */
  outputs?: number;
  /** The collection's MAP fields (collections only), for the safety filter. */
  map?: Record<string, unknown> | null;
};

/** Tokens and collections ranked by recent sales and new listings (1satsocial's hot board, no chat signal). */
const rank = (rooms: HotRoom[]) => [...rooms].sort((x, y) => y.heat - x.heat).slice(0, 20);

/** onPartial gets the board as it fills in (the token lookups are slow), on a fresh build only. */
export const hotBoard = (onPartial?: (rooms: HotRoom[]) => void): Promise<HotRoom[]> =>
  cached('hot', async () => {
    const partial: HotRoom[] = [];
    const [listed, sold, tokens] = await Promise.all([
      recentListings('active').catch((): RecentListing[] => []),
      recentListings('sale').catch((): RecentListing[] => []),
      activeTokens(20).catch((): string[] => []),
    ]);
    type Acc = { ref: RoomRef; trades: number; newListings: number };
    const rooms = new Map<string, Acc>();
    const touch = (ref: RoomRef | null) => {
      if (!ref) return null;
      let a = rooms.get(ref.key);
      if (!a) rooms.set(ref.key, (a = { ref, trades: 0, newListings: 0 }));
      return a;
    };
    for (const l of listed) {
      const a = touch(parseRoom(l.kind, l.id));
      if (a) a.newListings++;
    }
    for (const l of sold) {
      const a = touch(parseRoom(l.kind, l.id));
      if (a) a.trades++;
    }
    for (const id of tokens) touch(parseRoom('bsv21', id));

    const enriched = await mapLimit([...rooms.values()], 12, async (a): Promise<HotRoom | null> => {
      const [meta, market] = await Promise.all([roomMeta(a.ref.kind, a.ref.id), roomMarket(a.ref).catch(() => null)]);
      if (!meta) return null;
      if (a.ref.kind === 'bsv21') a.newListings = market?.buyableCount ?? 0;
      if (!market?.live && !a.trades) return null;
      const room: HotRoom = {
        ref: a.ref,
        title: meta.title,
        subtitle: meta.subtitle,
        icon: meta.icon,
        trades: a.trades,
        newListings: a.newListings,
        floorLabel: market?.floorLabel ?? null,
        heat: a.trades + Math.min(a.newListings, 20) * 2,
        map: meta.map ?? null,
      };
      partial.push(room);
      onPartial?.(rank(partial));
      return room;
    });
    return rank(enriched.filter((r): r is HotRoom => !!r));
  });

/** Past sales of a BSV-21 token, oldest first: whole-token price in sats (GorillaPool). For the wallet's price chart. */
export type Sale = { height: number; satsPerToken: number };
export const tokenSales = (tokenId: string, limit = 60): Promise<Sale[]> =>
  cached(`sales:${tokenId}`, async () => {
    const r = await fetch(
      `https://ordinals.gorillapool.io/api/bsv20/market/sales?id=${encodeURIComponent(tokenId)}&limit=${limit}&dir=desc`,
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as {
      amt: string;
      price: string;
      dec?: number;
      spendHeight?: number;
      height: number;
    }[];
    return rows
      .map((s) => {
        const tokens = Number(s.amt) / 10 ** (s.dec ?? 0);
        return { height: s.spendHeight || s.height, satsPerToken: tokens > 0 ? Number(s.price) / tokens : 0 };
      })
      .filter((s) => s.satsPerToken > 0)
      .sort((a, b) => a.height - b.height);
  });
