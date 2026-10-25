import type { WalletOutput } from '@bsv/sdk';
import { fmtSats, fmtUsd, satsToUsd, usdToSats } from '../money/money';
import type { Fetch } from './names';
import type { KV } from './opnsBatch';
import { opnsNameOf } from './opnsName';
import { nameTierUsd } from './store/tiers';

/**
 * Sell OpNS names (owner, 13 Oct 2026): list names from the wallet for $1 each, find listed names, buy them.
 *
 *  Owned names (wallet's OPNS basket) → tick some → ONE approval (count + total at the live rate) → each name
 *  is listed one after another with an OrdLock v2 listing (@1sat/actions sellOpns). The queue is saved after
 *  every change, so a closed window resumes where it stopped (same pattern as the mint batch, opnsBatch.ts).
 * Listed names from anyone come from the 1Sat order book (market/listings?type=application/op-ns).
 */

/** The lowest tier price, in USD (5+ characters). Names are priced by store/tiers.ts nameTierUsd. */
export const OPNS_SELL_USD = 1;

/** Rough network fee for one listing tx (the name input + funding + change), shown in the invoice. */
export const OPNS_LIST_FEE_ESTIMATE = 200;

const AUTO_KEY = 'bwallet.opnsAutoList';
/** Mint batch: "Auto-list each name for $1 after it's minted". On by default, remembered on this device. */
export const loadAutoList = (kv: KV | null = ls()): boolean => {
  try {
    return kv?.getItem(AUTO_KEY) !== '0';
  } catch {
    return true;
  }
};
export const saveAutoList = (on: boolean, kv: KV | null = ls()) => {
  try {
    kv?.setItem(AUTO_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
};

const ORDLOCK_TAGS = ['ordlock2', 'ordlock'];

export type OwnedForSale = {
  name: string;
  /** OPNS basket tracking id (sellOpns / cancelOpnsListing take this). */
  id: string;
  /** Asking price in sats when this name is already listed. */
  listedSats: number | null;
};

const tagValue = (o: WalletOutput, prefix: string) => o.tags?.find((t) => t.startsWith(prefix))?.slice(prefix.length);

/**
 * The wallet's names with their listing state. A name listed in the wallet sits in the same basket under an
 * OrdLock tag with `price:<sats>`; when a name has several outputs, the listed one wins (it is the live one).
 */
export const ownedForSale = (outputs: WalletOutput[]): OwnedForSale[] => {
  const byName = new Map<string, OwnedForSale>();
  for (const o of outputs) {
    const name = opnsNameOf(o);
    if (!name) continue;
    const listed = !!o.tags?.some((t) => ORDLOCK_TAGS.includes(t));
    const price = Number(tagValue(o, 'price:'));
    const row: OwnedForSale = {
      name,
      id: tagValue(o, 'id:') ?? o.outpoint,
      listedSats: listed && price > 0 ? price : null,
    };
    const prev = byName.get(name);
    if (!prev || (row.listedSats !== null && prev.listedSats === null)) byName.set(name, row);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/** Whole sats for one name at `usd` (rounded up, so the seller never gets less than asked); null without a rate. */
export const listingSats = (usd: number, rate: number): number | null => usdToSats(usd, rate);

/** Short USD for a sats amount ("$1.00"), or the sats when there is no rate yet. */
export const usdOrSats = (sats: number, rate: number) => {
  const v = satsToUsd(sats, rate);
  return v == null ? fmtSats(sats) : fmtUsd(v);
};

// ---- the sell queue ------------------------------------------------------------------------------------

export type SellStatus = 'pending' | 'listing' | 'done' | 'error';
export type SellItem = {
  name: string;
  id: string;
  usd: number;
  sats: number;
  status: SellStatus;
  txid?: string;
  note?: string;
};
export type SellState = { v: 1; items: SellItem[]; rate: number; createdAt: number };

/**
 * One queue for the approved names. Prices are fixed in sats here, at the rate shown on the approval sheet,
 * so a resume later lists at exactly what was approved. `prices` overrides the tier price per name.
 */
export const newSellBatch = (
  names: { name: string; id: string }[],
  rate: number,
  prices: Record<string, number> = {},
  now = Date.now(),
): SellState | null => {
  const items: SellItem[] = [];
  for (const n of names) {
    // Tier price by length (store/tiers.ts); a premium name is only listed at a price the owner typed.
    const usd = prices[n.name] ?? nameTierUsd(n.name);
    if (usd === null) continue;
    const sats = listingSats(usd, rate);
    if (!sats) return null;
    items.push({ name: n.name, id: n.id, usd, sats, status: 'pending' });
  }
  return items.length ? { v: 1, items, rate, createdAt: now } : null;
};

export const sellTotals = (s: Pick<SellState, 'items'>) => ({
  count: s.items.length,
  sats: s.items.reduce((a, i) => a + i.sats, 0),
  usd: s.items.reduce((a, i) => a + i.usd, 0),
});

export const sellRemaining = (s: SellState | null) =>
  s ? s.items.filter((i) => i.status === 'pending' || i.status === 'listing').length : 0;

const sellKey = (identityAddress: string) => `bwallet.opnsSell.${identityAddress}`;
const ls = (): KV | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export const loadSellBatch = (identityAddress: string, kv: KV | null = ls()): SellState | null => {
  try {
    const s = JSON.parse(kv?.getItem(sellKey(identityAddress)) ?? 'null') as SellState | null;
    if (!s || s.v !== 1 || !Array.isArray(s.items)) return null;
    // Closed mid-listing: try that name again (a name already listed is skipped by the resume check).
    return { ...s, items: s.items.map((i) => (i.status === 'listing' ? { ...i, status: 'pending' } : i)) };
  } catch {
    return null;
  }
};

export const saveSellBatch = (identityAddress: string, s: SellState | null, kv: KV | null = ls()) => {
  try {
    if (s) kv?.setItem(sellKey(identityAddress), JSON.stringify(s));
    else kv?.removeItem(sellKey(identityAddress));
  } catch {
    /* storage unavailable */
  }
};

export type SellDeps = {
  /** Lists one name (sellOpns); returns the txid or throws. */
  list: (item: SellItem) => Promise<string>;
  /** Already listed in the wallet (e.g. listed before the window closed): don't list it twice. */
  isListed: (name: string) => boolean;
  /** OpNS Vault: a kept / to-gift name is never listed, even from a queue approved before it was vaulted. */
  keep?: (name: string) => boolean;
  save: (s: SellState) => void;
  onUpdate: (s: SellState) => void;
  /** Pause before retrying a listing the wallet's broadcast refused (default 5 s). */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Broadcast refusals worth one more try: the wallet's WERR_REVIEW_ACTIONS ("Undelayed createAction or
 * signAction results require review"), seen when a listing spends a name/change output from a chain of
 * still-unconfirmed mints and the previous listing's change the broadcaster hasn't caught up with yet.
 */
export const isRetryableListError = (msg: string) =>
  /REVIEW_ACTIONS|require review|missing.?inputs|orphan|double|conflict|not found|timeout|fetch/i.test(msg);

const LIST_RETRIES = 2;
const LIST_RETRY_MS = 5000;

export type SellResult = { stopped: 'finished' | 'cancelled' | 'error'; error?: string; state: SellState };

/** Lists pending names in order. A wallet error stops the run with that name pending, so Resume retries it. */
export const runSellBatch = async (deps: SellDeps, start: SellState, signal: AbortSignal): Promise<SellResult> => {
  let state = start;
  const set = (i: number, patch: Partial<SellItem>) => {
    state = { ...state, items: state.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) };
    deps.save(state);
    deps.onUpdate(state);
  };
  for (let i = 0; i < state.items.length; i++) {
    const it = state.items[i];
    if (it.status !== 'pending' && it.status !== 'listing') continue;
    if (signal.aborted) return { stopped: 'cancelled', state };
    if (deps.isListed(it.name)) {
      set(i, { status: 'done', note: 'Already listed' });
      continue;
    }
    if (deps.keep?.(it.name)) {
      set(i, { status: 'error', note: 'In your Vault' });
      continue;
    }
    set(i, { status: 'listing', note: undefined });
    let lastErr = '';
    for (let attempt = 0; attempt <= LIST_RETRIES; attempt++) {
      if (attempt > 0) {
        await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(LIST_RETRY_MS * attempt);
        if (signal.aborted) {
          set(i, { status: 'pending', note: undefined });
          return { stopped: 'cancelled', state };
        }
        // The refused attempt may still have gone out: never list a name twice.
        if (deps.isListed(it.name)) {
          lastErr = '';
          break;
        }
      }
      try {
        const txid = await deps.list(it);
        lastErr = '';
        set(i, { status: 'done', txid, note: undefined });
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (!isRetryableListError(lastErr)) break;
      }
    }
    if (state.items[i].status === 'done') continue;
    if (!lastErr && deps.isListed(it.name)) {
      set(i, { status: 'done', note: 'Already listed' });
      continue;
    }
    if (lastErr) {
      set(i, { status: 'pending', note: lastErr });
      return { stopped: 'error', error: lastErr, state };
    }
  }
  return { stopped: 'finished', state };
};

// ---- the order book ------------------------------------------------------------------------------------

export const OPNS_LISTINGS_URL =
  'https://api.1sat.app/1sat/market/listings?status=active&type=application/op-ns&limit=200';

export type OpnsListing = { name: string; outpoint: string; origin: string; priceSats: number; seller: string };

type Row = {
  outpoint?: string;
  score?: number;
  data?: { ordlock?: { name?: string; origin?: string; price?: number; seller?: string; content_type?: string } };
};

/** Live OpNS listings (anyone's), cheapest first. Rows the indexer gives no name for are left out. */
export const fetchOpnsListings = async (f: Fetch, url = OPNS_LISTINGS_URL): Promise<OpnsListing[]> => {
  const res = await f(url);
  if (!res.ok) throw new Error(`Listings unavailable (${res.status})`);
  const rows = ((await res.json().catch(() => null)) ?? []) as Row[];
  return parseListingRows(Array.isArray(rows) ? rows : []);
};

const parseListingRows = (rows: Row[]): OpnsListing[] => {
  const out: OpnsListing[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const l = r.data?.ordlock;
    const name = (l?.name ?? '').trim().toLowerCase();
    const price = Number(l?.price);
    if (!r.outpoint || !name || !(price > 0) || seen.has(name)) continue;
    if (l?.content_type && l.content_type !== 'application/op-ns') continue;
    seen.add(name);
    out.push({
      name,
      outpoint: r.outpoint.replace('_', '.'),
      origin: (l?.origin ?? '').replace('_', '.'),
      priceSats: price,
      seller: l?.seller ?? '',
    });
  }
  return out.sort((a, b) => a.priceSats - b.priceSats || a.name.localeCompare(b.name));
};

/**
 * Every live OpNS listing: the indexer pages by descending score, `from=<last score>` gives the next page.
 * Stops on an empty or non-advancing page, or after maxPages.
 */
export const fetchAllOpnsListings = async (f: Fetch, maxPages = 40): Promise<OpnsListing[]> => {
  const rows: Row[] = [];
  let from: number | null = null;
  for (let i = 0; i < maxPages; i++) {
    const res = await f(from === null ? OPNS_LISTINGS_URL : `${OPNS_LISTINGS_URL}&from=${from}`);
    if (!res.ok) {
      if (rows.length) break;
      throw new Error(`Listings unavailable (${res.status})`);
    }
    const page = ((await res.json().catch(() => null)) ?? []) as Row[];
    const fresh = (Array.isArray(page) ? page : []).filter(
      (r) => typeof r.score === 'number' && (from === null || r.score < from),
    );
    if (!fresh.length) break;
    rows.push(...fresh);
    from = fresh[fresh.length - 1].score as number;
  }
  return parseListingRows(rows);
};

/** Search box: case-insensitive substring; a leading @ or $ is ignored. Exact match first. */
export const filterListings = (list: OpnsListing[], q: string): OpnsListing[] => {
  const n = q
    .trim()
    .toLowerCase()
    .replace(/^[@$]+/, '');
  if (!n) return list;
  const hits = list.filter((l) => l.name.includes(n));
  return [...hits.filter((l) => l.name === n), ...hits.filter((l) => l.name !== n)];
};

// ---- name search on /bmint/opns ------------------------------------------------------------------------

export type SearchLabel = { kind: 'free' | 'mine' | 'buy' | 'taken'; label: string };

/**
 * What the search row says. Taken and listed → "Buy for $X" (only where buying is allowed: not in a store
 * build, which has no market); taken and not listed → "Taken".
 */
export const searchLabel = (
  c: { state: 'free' } | { state: 'mine' } | { state: 'taken'; listing?: { priceSats: number } },
  fmtPrice: (sats: number) => string,
  canBuy: boolean,
): SearchLabel => {
  if (c.state === 'free') return { kind: 'free', label: 'Free' };
  if (c.state === 'mine') return { kind: 'mine', label: 'Already yours' };
  if (c.listing && canBuy) return { kind: 'buy', label: `Buy for ${fmtPrice(c.listing.priceSats)}` };
  return { kind: 'taken', label: 'Taken' };
};
