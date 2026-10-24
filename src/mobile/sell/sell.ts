/**
 * Sell tickets / BSV-21 tokens: the pure part (unit-tested in sell.test.ts).
 *
 * A listing is the 1Sat marketplace format for BSV-21: one 1-sat output whose script is the
 * BSV-21 transfer inscription (`{"p":"bsv-20","op":"transfer","id":…,"amt":…}`) followed by an
 * OrdLock (cancel PKH + payout output). 1sat-stack indexes it as `bsv21:<id>` + `ordlock`, so it
 * shows on 1sat.market and in our Market (indexer.ts `loadMarket`), and `buyBsv21` can buy it.
 *
 * Upstream Yours disables listing creation (ORDLOCK_LISTING_DISABLED); bWallet re-enables it for
 * BSV-21 only, behind `SELL_ENABLED` (true in the mobile build, see vite.config.mobile.ts).
 */
import { BSV21, OrdLock, OrdLockV2 } from '@1sat/templates';
import { MARKET_ENABLED, bcorpFeeAddress } from '../storeBuild';
import { LockingScript, Script } from '@bsv/sdk';

declare const __BWALLET_SELL__: boolean | undefined;
declare const __MARKET_FEE_ADDRESS__: string | undefined;
declare const __TICKET_RESALE_FEE_RATE__: string | undefined;

/** bWallet-only switch: listing creation is on in the mobile build, off elsewhere (extension). */
/** Off in a store build: the Market is view-only there (storeBuild.ts). */
// Paused (4 Oct 2026): @1sat/templates 0.0.41 turned off OrdLock v1 listing creation (OPL-4690:
// "List via OrdLock v2"), and @1sat/actions has no v2 listing for BSV-21 yet. Buying and cancelling
// existing listings still work. Re-enable on a v2 token listing.
const SELL_PAUSED = false;
export const SELL_ENABLED =
  !SELL_PAUSED && MARKET_ENABLED && typeof __BWALLET_SELL__ !== 'undefined' && __BWALLET_SELL__ === true;

// ── ticket resale fee (owner: 0 by default; NOT the general 1% Market fee) ──

const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const feeAddress = bcorpFeeAddress(typeof __MARKET_FEE_ADDRESS__ === 'string' ? __MARKET_FEE_ADDRESS__.trim() : '');
const feeRate = typeof __TICKET_RESALE_FEE_RATE__ === 'string' ? Number(__TICKET_RESALE_FEE_RATE__) : 0;

/** Rate in [0, 0.5]; anything else (unset, NaN, negative) = 0. */
export const clampRate = (r: number) => (Number.isFinite(r) && r > 0 ? Math.min(r, 0.5) : 0);

/**
 * Options for buyBsv21 when the token is a ticket. Build with
 * BWALLET_TICKET_RESALE_FEE_RATE=0.02 (and BWALLET_MARKET_FEE_ADDRESS) to charge one; default none.
 */
export const ticketResaleFeeOptions = (
  address = feeAddress,
  rate = feeRate,
): { marketplaceAddress?: string; marketplaceRate?: number } => {
  const r = clampRate(rate);
  return r > 0 && ADDRESS_RE.test(address) ? { marketplaceAddress: address, marketplaceRate: r } : {};
};
export const ticketResaleFeeSats = (priceSats: number, address = feeAddress, rate = feeRate) => {
  const o = ticketResaleFeeOptions(address, rate);
  return o.marketplaceRate ? Math.ceil(priceSats * o.marketplaceRate) : 0;
};

// ── amounts and price ──

/** "1.5" with dec 2 → 150n. null when not a valid positive amount at that precision. */
export function toRaw(input: string, dec: number): bigint | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > dec) return null;
  const raw = BigInt((whole || '0') + frac.padEnd(dec, '0'));
  return raw > 0n ? raw : null;
}

/** 150n with dec 2 → "1.5". */
export function fromRaw(raw: bigint, dec: number): string {
  if (dec <= 0) return raw.toString();
  const s = raw.toString().padStart(dec + 1, '0');
  const frac = s.slice(-dec).replace(/0+$/, '');
  return frac ? `${s.slice(0, -dec)}.${frac}` : s.slice(0, -dec);
}

/**
 * Total asking price in sats for `raw` units at `pricePerToken` sats per whole token (one ticket).
 * Rounded up so the seller never gets less than they asked. The OrdLock carries this total.
 */
export function totalPriceSats(raw: bigint, dec: number, pricePerToken: number): number {
  if (!Number.isFinite(pricePerToken) || pricePerToken <= 0 || raw <= 0n) return 0;
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) return 0; // BSV-21 max; a crafted dec must not hang BigInt math
  const scale = 10n ** BigInt(dec);
  // price as integer millisats to keep fractional per-unit prices exact enough
  const milli = BigInt(Math.round(pricePerToken * 1000));
  const num = raw * milli;
  const den = scale * 1000n;
  return Number((num + den - 1n) / den);
}

/** Price per whole token implied by a listing (for display). */
export const unitPrice = (totalSats: number, raw: bigint, dec: number) =>
  raw > 0n ? (totalSats * 10 ** dec) / Number(raw) : 0;

/**
 * Per-token price in sats from what the user typed: dollars-and-cents when the BSV/USD rate is known
 * (converted at listing time), else sats (fallback). 0 when invalid.
 */
export function perTokenSats(input: string, rate: number): number {
  if (rate > 0) {
    const t = input.trim().replace(/^\$/, '');
    if (!/^\d*(\.\d{0,2})?$/.test(t) || !/\d/.test(t)) return 0;
    const usdEach = Number(t);
    return usdEach > 0 ? (usdEach / rate) * 1e8 : 0;
  }
  const n = Number(input);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export const usd = (sats: number, exchangeRate: number) =>
  exchangeRate > 0 ? `≈ $${((sats / 1e8) * exchangeRate).toFixed(sats * exchangeRate >= 1e8 ? 2 : 4)}` : '';

export type SellError = 'quantity' | 'over-balance' | 'price' | null;

/** Validate the sheet. A listing must ask at least 1 sat (OrdLock rejects 0). */
export function validateSell(qtyRaw: bigint | null, held: bigint, priceSats: number): SellError {
  if (qtyRaw === null || qtyRaw <= 0n) return 'quantity';
  if (qtyRaw > held) return 'over-balance';
  if (!(priceSats >= 1)) return 'price';
  return null;
}

// ── fees shown on the confirm sheet ──

export const DEFAULT_FEE_PER_OUTPUT = 1000;

/**
 * Token outputs the listing tx creates: the listing, plus token change when not selling all of
 * the selected inputs. Each one costs the overlay fee (sendBsv21 adds exactly
 * fee_per_output × token outputs).
 */
export const tokenOutputCount = (qtyRaw: bigint, held: bigint) => (qtyRaw < held ? 2 : 1);

export const indexingFeeSats = (qtyRaw: bigint, held: bigint, feePerOutput = DEFAULT_FEE_PER_OUTPUT) =>
  tokenOutputCount(qtyRaw, held) * feePerOutput;

/** Byte estimate of the listing tx: token inputs, listing (inscription + OrdLock), change, fee, funding. */
export function listingTxBytes(tokenInputs: number, listingScriptLen: number, withChange: boolean): number {
  const tokenIn = tokenInputs * 148;
  const listing = 9 + listingScriptLen + 3;
  const change = withChange ? 9 + 170 : 0; // token change: inscription + P2PKH
  const feeOut = 34;
  const funding = 148 + 34; // one funding input + BSV change
  return 10 + tokenIn + listing + change + feeOut + funding;
}

export const networkFeeSats = (bytes: number, satsPerKb: number) => Math.max(1, Math.ceil((bytes * satsPerKb) / 1000));

/** Cancel tx: OrdLock cancel input (~110 B unlock) + token output back to us + overlay fee + funding. */
export const CANCEL_TX_BYTES = 10 + (41 + 110) + (9 + 170) + 34 + 148 + 34;

// ── scripts ──

/**
 * The listing locking script: BSV-21 transfer inscription wrapped around an OrdLock v2 (the format
 * 1Sat now lists in; v1 creation is off in @1sat/templates 0.0.41, OPL-4690). buyBsv21 reads v2 first.
 */
export function buildListingScript(
  tokenId: string,
  amount: bigint,
  cancelAddress: string,
  payAddress: string,
  priceSats: number,
): LockingScript {
  if (!(priceSats >= 1) || !Number.isInteger(priceSats)) throw new Error('Price must be a whole number of sats');
  const ordLock = OrdLockV2.lock(cancelAddress, payAddress, priceSats);
  return BSV21.transfer(tokenId, amount).lock(new LockingScript(ordLock.chunks));
}

export type DecodedListing = { tokenId: string; amount: bigint; priceSats: number; seller: string; v2: boolean };

/** Read a listing script back (what a buyer / the indexer sees). null when it isn't one. */
export function decodeListing(script: Script): DecodedListing | null {
  const v2 = OrdLockV2.decode(script);
  const lock = v2 ?? OrdLock.decode(script);
  const tok = BSV21.decode(script);
  if (!lock || !tok) return null;
  const tokenId = tok.getTokenId();
  if (!tokenId || tok.getOperation() !== 'transfer') return null;
  return { tokenId, amount: tok.getAmount(), priceSats: Number(lock.price), seller: lock.seller, v2: !!v2 };
}

// ── local record of our listings (cancel needs the key, the indexer is the truth for "still live") ──

export type ListingRecord = {
  outpoint: string; // txid.vout
  tokenId: string;
  symbol: string;
  dec: number;
  amount: string; // raw units
  priceSats: number;
  keyID: string; // P1SAT keyID of the cancel key (counterparty self)
  createdAt: number;
};

const KEY = 'bwallet.sell.listings';

/** Cancel key per token: deterministic, so a lost record can still be cancelled by re-deriving it. */
export const cancelKeyID = (tokenId: string) => `ordlock-${tokenId.replace('.', '_')}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadRecords(store: Store | null = defaultStore()): ListingRecord[] {
  try {
    const v = store?.getItem(KEY);
    const list = v ? (JSON.parse(v) as ListingRecord[]) : [];
    return Array.isArray(list) ? list.filter((r) => r && typeof r.outpoint === 'string') : [];
  } catch {
    return [];
  }
}

const saveRecords = (list: ListingRecord[], store: Store | null) => {
  try {
    store?.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
  for (const fn of listeners) fn();
};

export function addRecord(r: ListingRecord, store: Store | null = defaultStore()) {
  saveRecords([r, ...loadRecords(store).filter((x) => x.outpoint !== r.outpoint)], store);
}

export function removeRecord(outpoint: string, store: Store | null = defaultStore()) {
  saveRecords(
    loadRecords(store).filter((x) => x.outpoint !== outpoint),
    store,
  );
}

const listeners = new Set<() => void>();
export const onListingsChanged = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
