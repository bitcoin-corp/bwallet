/**
 * Our own Memepool curve maths. Nothing here asks the server what a trade should give: the coin's reserves come from
 * GET /tokens/{id} (checked against its /proof row by the caller) and the formulas are ours, checked against their
 * live /quote answers on 25 Oct 2026 (see curve.test.ts).
 *
 * Stage 1 (bonding curve): constant product on VIRTUAL reserves (vSats × vTokens), as on pump-style launchpads.
 * Stage 2 ("tail", after graduation): constant product on the REAL reserves the pool holds (realSats × realTokens).
 * Fees: 1.25% of the BSV side, rounded up; the creator's 0.30% of it rounded down; Memepool keeps the rest.
 */
import { CREATOR_BPS, FEE_BPS } from './constants';

const ZERO = BigInt(0);
const ONE = BigInt(1);
const BPS = BigInt(10_000);
const ceilDiv = (a: bigint, b: bigint) => (a + b - ONE) / b;

export type CurveParams = {
  totalSupply: bigint;
  curveSupply: bigint;
  vSats0: bigint;
  vTokens0: bigint;
  tailAt: bigint;
};
export type CurveState = { vSats: bigint; vTokens: bigint; realSats: bigint; realTokens: bigint; tail: boolean };

/** The fee on `gross` sats: the total, the creator's share, Memepool's share. */
export const feeSplit = (gross: bigint) => {
  const fee = ceilDiv(gross * FEE_BPS, BPS);
  const creator = (gross * CREATOR_BPS) / BPS;
  return { fee, creator, platform: fee - creator };
};

/** The reserves the price comes from in the coin's current stage. */
const reserves = (s: CurveState) => (s.tail ? { x: s.realSats, y: s.realTokens } : { x: s.vSats, y: s.vTokens });

export class CurveError extends Error {}

/**
 * Tokens a buy with `budget` sats (fee included) gets. Refuses a buy that would cross from the curve into the tail
 * (the graduating buy): those are priced by rules we don't reproduce, so we don't sign them.
 */
export function buyTokens(p: CurveParams, s: CurveState, budget: bigint): bigint {
  if (budget <= ZERO) return ZERO;
  const { fee } = feeSplit(budget);
  const net = budget - fee;
  const { x, y } = reserves(s);
  if (x <= ZERO || y <= ZERO) throw new CurveError('The pool is empty.');
  let tokens = y - ceilDiv(x * y, x + net);
  if (tokens > s.realTokens) tokens = s.realTokens;
  if (tokens < ZERO) tokens = ZERO;
  if (!s.tail && s.realTokens - tokens < p.tailAt)
    throw new CurveError('This buy would finish the curve. Buy a smaller amount, or finish it on Memepool itself.');
  return tokens;
}

/** Sats a sell of `tokens` frees from the pool: gross, fee and what's left for the seller (net, before network fees). */
export function sellSats(p: CurveParams, s: CurveState, tokens: bigint) {
  if (tokens <= ZERO) return { gross: ZERO, fee: ZERO, net: ZERO };
  if (s.tail && s.realTokens + tokens > p.tailAt)
    throw new CurveError('This sell would take the coin back onto its curve. Sell a smaller amount.');
  const { x, y } = reserves(s);
  if (x <= ZERO || y <= ZERO) throw new CurveError('The pool is empty.');
  const gross = x - ceilDiv(x * y, y + tokens);
  if (gross > s.realSats) throw new CurveError('The pool does not hold enough BSV for this sell.');
  const { fee } = feeSplit(gross);
  return { gross, fee, net: gross - fee };
}

/** The fewest tokens a buy accepts: our own figure less the user's slippage. */
export const minTokensFor = (ours: bigint, slippageBps: number) => (ours * (BPS - BigInt(slippageBps))) / BPS;

/** Parse the coin's `params` + `state` from GET /tokens/{id}. Null when anything is missing or malformed. */
export function parseCurve(detail: unknown): { params: CurveParams; state: CurveState } | null {
  const d = (detail ?? {}) as { params?: Record<string, unknown>; state?: Record<string, unknown> };
  const int = (v: unknown): bigint | null => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : null);
  const p = d.params ?? {};
  const s = d.state ?? {};
  const totalSupply = int(p.totalSupply);
  const curveSupply = int(p.curveSupply);
  const vSats0 = int(p.vSats0);
  const vTokens0 = int(p.vTokens0);
  const tailAt = int(p.tailAt);
  const vSats = int(s.vSats);
  const vTokens = int(s.vTokens);
  const realSats = int(s.realSats);
  const realTokens = int(s.realTokens);
  if (
    totalSupply === null ||
    curveSupply === null ||
    vSats0 === null ||
    vTokens0 === null ||
    tailAt === null ||
    vSats === null ||
    vTokens === null ||
    realSats === null ||
    realTokens === null ||
    typeof s.tail !== 'boolean'
  )
    return null;
  // The coin's own fee params must be the ones we pinned.
  if (int(p.feeBps) !== FEE_BPS || int(p.creatorBps) !== CREATOR_BPS) return null;
  // Stage 1's virtual reserves are the real ones plus the coin's starting virtual amounts (e.g. 1,017,059,099
  // virtual tokens = 944,059,099 real + 73,000,000): anything else is a made-up state.
  if (!s.tail && (vSats - realSats !== vSats0 || vTokens - realTokens !== vTokens0 - totalSupply)) return null;
  if (tailAt !== totalSupply - curveSupply) return null;
  // The tail starts exactly where the curve's supply runs out.
  if (s.tail !== realTokens <= tailAt) return null;
  return {
    params: { totalSupply, curveSupply, vSats0, vTokens0, tailAt },
    state: { vSats, vTokens, realSats, realTokens, tail: s.tail },
  };
}
