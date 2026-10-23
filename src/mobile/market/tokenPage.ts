/**
 * Token page data (market plan PR 1, 23 Oct 2026): the pieces the token page, the Sell sheet and the Buy sheet
 * share. Pure parsers are exported for tests; the fetchers are thin and cached.
 *
 *  - Stale listings: 1Sat's search can return an OrdLock that was already bought. Before a buy the wallet asks
 *    GorillaPool whether the listing outpoint is still unspent, and the order book drops asks known to be spent.
 *  - Holders: GorillaPool `bsv20/id/<id>` (`accounts` = holder count) and `/holders` (top holders).
 *  - Launch curve: the deploy tx carries a MAP output `app=bWallet type=curve curve=<json> curveHash=<sha256>`
 *    (curves/curveMap.ts). It is read back and checked with lib/curves verifyCurve; an unverified curve is never shown.
 */
import { Script, Transaction, Utils } from '@bsv/sdk';
import { priceAt, verifyCurve, type Curve } from '../../lib/curves';
import { MAP_PREFIX } from '../names/personalToken';
import { cached } from './indexer';

const GP = 'https://ordinals.gorillapool.io/api';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const op_ = (outpoint: string) => outpoint.replace('.', '_');

type Fetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string> }>;
const defaultFetch: Fetch = (url) => fetch(url, { signal: AbortSignal.timeout(8_000) });

// ── stale listings ───────────────────────────────────────────────────────────

/** 'spent' / 'unspent' from a GorillaPool txo row; 'unknown' when the row can't tell. */
export type SpendState = 'spent' | 'unspent' | 'unknown';
export const spendStateOf = (row: unknown): SpendState => {
  if (!row || typeof row !== 'object') return 'unknown';
  const spend = (row as { spend?: unknown }).spend;
  if (typeof spend !== 'string') return 'unknown';
  return spend.length > 0 ? 'spent' : 'unspent';
};

/** Is a listing outpoint still unspent? Short cache (20 s, plan §2.4) so a fresh sale shows quickly. */
export const listingSpendState = (outpoint: string, f: Fetch = defaultFetch): Promise<SpendState> =>
  cached(
    `spend:${op_(outpoint)}`,
    async () => {
      try {
        const r = await f(`${GP}/txos/${encodeURIComponent(op_(outpoint))}`);
        if (r.status === 404) return 'unknown';
        if (!r.ok) return 'unknown';
        return spendStateOf(await r.json());
      } catch {
        return 'unknown';
      }
    },
    20_000,
  );

export const STALE_LISTING_MESSAGE = 'Someone bought that listing a moment ago. The order book is updating.';

/** Drop asks known to be spent. Unknown stays (the buy re-checks it). */
export const dropSpent = <T extends { outpoint: string }>(asks: readonly T[], spent: ReadonlySet<string>): T[] =>
  asks.filter((a) => !spent.has(op_(a.outpoint)));

/** The next ask after one that went stale: the cheapest remaining buyable one that isn't `gone`. */
export const nextAsk = <T extends { outpoint: string; buyable: boolean }>(
  asksCheapestFirst: readonly T[],
  gone: string,
): T | null => asksCheapestFirst.find((a) => a.buyable && op_(a.outpoint) !== op_(gone)) ?? null;

// ── holders ──────────────────────────────────────────────────────────────────

export type TopHolder = { address: string; amt: bigint };
export type HolderInfo = { count: number | null; top: TopHolder[] };

export const parseHolderCount = (body: unknown): number | null => {
  const n = (body as { accounts?: unknown } | null)?.accounts;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
};

/** Tolerant parse of `/holders` rows (display only; holderDrop.parseHolders is the fail-closed one for payouts). */
export const parseTopHolders = (body: unknown): TopHolder[] => {
  if (!Array.isArray(body)) return [];
  const out: TopHolder[] = [];
  for (const row of body) {
    const { address, amt } = (row ?? {}) as { address?: unknown; amt?: unknown };
    const s = String(amt ?? '');
    if (typeof address === 'string' && address && /^\d+$/.test(s)) out.push({ address, amt: BigInt(s) });
  }
  return out.sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0));
};

export const tokenHolders = (tokenId: string, limit = 20, f: Fetch = defaultFetch): Promise<HolderInfo> =>
  cached(`holders:${op_(tokenId)}:${limit}`, async () => {
    const id = encodeURIComponent(op_(tokenId));
    const [count, top] = await Promise.all([
      f(`${GP}/bsv20/id/${id}`)
        .then(async (r) => (r.ok ? parseHolderCount(await r.json()) : null))
        .catch(() => null),
      f(`${GP}/bsv20/id/${id}/holders?limit=${limit}&offset=0`)
        .then(async (r) => (r.ok ? parseTopHolders(await r.json()) : []))
        .catch(() => [] as TopHolder[]),
    ]);
    return { count, top };
  });

// ── launch curve ─────────────────────────────────────────────────────────────

/** MAP SET fields from one OP_RETURN script (`OP_FALSE OP_RETURN <MAP> SET k v k v …`), or null. */
export const mapFields = (script: Script): Record<string, string> | null => {
  const c = script.chunks;
  let i = 0;
  if (c[i]?.op === 0) i++; // OP_FALSE
  if (c[i]?.op !== 0x6a) return null; // OP_RETURN
  i++;
  const str = (k: number) => (c[k]?.data ? Utils.toUTF8(c[k].data!) : null);
  if (str(i) !== MAP_PREFIX || str(i + 1) !== 'SET') return null;
  const out: Record<string, string> = {};
  for (let k = i + 2; k + 1 < c.length; k += 2) {
    const key = str(k);
    const val = str(k + 1);
    if (key === null || val === null) break;
    out[key] = val;
  }
  return out;
};

export type TokenCurve = { curve: Curve; hash: string } | null;

/** The committed, verified launch curve in a deploy tx, or null (no curve, or it doesn't verify). */
export const curveFromTx = (tx: Transaction): TokenCurve => {
  for (const o of tx.outputs) {
    const m = mapFields(o.lockingScript);
    if (!m || m.app !== 'bWallet' || m.type !== 'curve') continue;
    const v = verifyCurve(m);
    if (v.ok) return { curve: v.curve, hash: v.hash };
  }
  return null;
};

/** The launch curve of a token id (`<deploy txid>_<vout>`), cached for an hour (it can never change). */
export const tokenCurve = (tokenId: string, f: Fetch = defaultFetch): Promise<TokenCurve> =>
  cached(
    `curve:${op_(tokenId)}`,
    async () => {
      try {
        const txid = op_(tokenId).split('_')[0];
        if (!/^[0-9a-f]{64}$/i.test(txid)) return null;
        const r = await f(`${WOC}/tx/${txid}/hex`);
        if (!r.ok || !r.text) return null;
        return curveFromTx(Transaction.fromHex((await r.text()).trim()));
      } catch {
        return null;
      }
    },
    60 * 60_000,
  );

/** Curve price now in USD for a known fraction sold (0 when unknown: the floor). */
export const curvePriceUsd = (c: Curve, fractionSold: number | null): number => priceAt(c, fractionSold ?? 0);

/** Points for a small curve chart: [fraction, usd] pairs, `n` samples. */
export const curvePoints = (c: Curve, n = 48): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [i / n, priceAt(c, i / n)] as [number, number]);

/** "3.2× the 1¢ floor" style comparison of a market price to the curve floor; null when either is missing. */
export const vsFloor = (priceUsd: number | null, floorUsd: number): number | null =>
  priceUsd !== null && priceUsd > 0 && floorUsd > 0 ? priceUsd / floorUsd : null;
