/**
 * Launch curves: how a token's price climbs as its supply sells. Pure TypeScript, no dependencies, no
 * imports, so it can be lifted out as a small package (bmovies-app, b0ase.com) unchanged.
 *
 * Unifies b0ase.com's two libraries:
 *  - lib/path402/pricing.ts "Alice Bond" grades (ceiling raise 10K / 10M / 100M / 1G);
 *  - lib/tokenomics/bonding-curve.ts shapes (linear, sigmoid, exponential).
 *
 * Everything is USD-first. Positions are in whole tokens; `fraction` is sold / supply in [0, 1].
 * A curve is pure data (JSON-safe) so it can be written into a token's launch metadata and read back by
 * any market or sale engine. This file never buys or lists anything.
 *
 * Fair launch (owner, 23 Oct 2026: "lots of people can buy in worldwide before the big money shows up"):
 * an optional `earlyTier` caps how much one verified identity/wallet may spend inside the cheapest slice
 * of supply. It is data only: the sale engine enforces it.
 */
import { sha256Hex } from './sha256';

export type CurveShape = 'linear' | 'sigmoid' | 'exponential';

export interface EarlyTier {
  /** The cheapest slice of supply the cap applies to, e.g. 0.01 = the first 1%. */
  fraction: number;
  /** Most one verified identity / wallet may spend in that slice, in USD. */
  maxUsdPerIdentity: number;
}

export interface Curve {
  /** Tokens sold along the curve (whole tokens). */
  supply: number;
  shape: CurveShape;
  /** Price of the first token, USD. */
  floorUsd: number;
  /** USD raised once the whole curve supply has sold. */
  ceilingRaiseUsd: number;
  /** Fair-launch rule for the cheapest slice; null = off. */
  earlyTier: EarlyTier | null;
  /** Smallest buy a sale should accept, USD (tiny-friendly: 10¢ by default). */
  minBuyUsd: number;
  /** Months after launch when unsold curve supply is burnt; null = never (sells forever). */
  burnAfterMonths: number | null;
  /** Preset id it started from, for display only. */
  preset?: PresetId;
}

export interface CurveInput {
  supply?: number;
  shape?: CurveShape;
  floorUsd?: number;
  /** Give either a ceiling raise… */
  ceilingRaiseUsd?: number;
  /** …or the last token's price; the raise is worked out from it. */
  maxPrice?: number;
  earlyTier?: EarlyTier | null;
  minBuyUsd?: number;
  /** undefined = the standard 12 months; null = forever. */
  burnAfterMonths?: number | null;
  preset?: PresetId;
}

export const DEFAULT_SUPPLY = 1_000_000_000;
export const DEFAULT_FLOOR_USD = 0.01;
export const DEFAULT_MIN_BUY_USD = 0.1;
/** Sigmoid steepness over the unit interval (fraction space). */
export const SIGMOID_STEEPNESS = 10;

/** Alice Bond grades: the ceiling raise in USD (b0ase.com pricing.ts: ceiling = 100 × onePercentCost). */
export const GRADES = {
  '10K': 10_000,
  '10M': 10_000_000,
  '100M': 100_000_000,
  '1G': 1_000_000_000,
  '10G': 10_000_000_000,
} as const;
export type Grade = keyof typeof GRADES;

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const sig = (x: number) => 1 / (1 + Math.exp(-x));
/** ∫ sig(x) dx = ln(1 + e^x), computed without overflow. */
const softplus = (x: number) => (x > 30 ? x : Math.log1p(Math.exp(x)));

// ── Shape kernels on [0, 1]. Each g rises from 0 to 1; G is its integral from 0. ──

const S = SIGMOID_STEEPNESS;
const SIG_LO = sig(-S / 2);
const SIG_SPAN = sig(S / 2) - SIG_LO;
const sigG = (f: number) => (sig(S * (f - 0.5)) - SIG_LO) / SIG_SPAN;
const sigInt = (f: number) => ((softplus(S * (f - 0.5)) - softplus(-S / 2)) / S - SIG_LO * f) / SIG_SPAN;

/** Exponential: p = floor · e^{k f}; raise = supply · floor · (e^{k f} − 1) / k. */
const expRaiseFactor = (k: number) => (k < 1e-9 ? 1 : Math.expm1(k) / k);

/** Solve (e^k − 1)/k = m for k ≥ 0 (m ≥ 1) by bisection. */
export function expRateFor(m: number): number {
  if (!(m > 1)) return 0;
  let lo = 0;
  let hi = 1;
  while (expRaiseFactor(hi) < m) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (expRaiseFactor(mid) < m) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Build a valid curve. The ceiling raise must be at least floor × supply (a flat curve); a smaller one is
 * raised to that. `maxPrice` wins over `ceilingRaiseUsd` when both are given.
 */
export function makeCurve(input: CurveInput = {}): Curve {
  const supply = Math.max(1, Math.floor(input.supply ?? DEFAULT_SUPPLY));
  const shape = input.shape ?? 'linear';
  const floorUsd = Math.max(0, input.floorUsd ?? DEFAULT_FLOOR_USD);
  const flat = floorUsd * supply;
  let raise = input.ceilingRaiseUsd ?? GRADES['100M'];
  if (input.maxPrice !== undefined) raise = raiseForMaxPrice(shape, supply, floorUsd, input.maxPrice);
  if (!(raise >= flat)) raise = flat;
  // undefined = the standard early tier (on for everyone); null = off.
  const tier = input.earlyTier === undefined ? STANDARD_EARLY_TIER : input.earlyTier;
  const burn = input.burnAfterMonths === undefined ? DEFAULT_BURN_AFTER_MONTHS : input.burnAfterMonths;
  return {
    supply,
    shape,
    floorUsd,
    ceilingRaiseUsd: raise,
    earlyTier:
      tier && tier.fraction > 0 && tier.maxUsdPerIdentity > 0
        ? { fraction: clamp01(tier.fraction), maxUsdPerIdentity: tier.maxUsdPerIdentity }
        : null,
    minBuyUsd: Math.max(0, input.minBuyUsd ?? DEFAULT_MIN_BUY_USD),
    burnAfterMonths: burn !== null && burn > 0 ? Math.floor(burn) : null,
    ...(input.preset ? { preset: input.preset } : {}),
  };
}

function raiseForMaxPrice(shape: CurveShape, supply: number, floor: number, max: number): number {
  const top = Math.max(floor, max);
  if (shape === 'exponential') {
    if (floor <= 0) return (supply * top) / 2;
    return supply * floor * expRaiseFactor(Math.log(top / floor));
  }
  // linear and sigmoid both average to the midpoint of floor and max.
  return (supply * (floor + top)) / 2;
}

/** Price of the last token on the curve, USD. */
export function maxPrice(c: Curve): number {
  const avg = c.ceilingRaiseUsd / c.supply;
  if (c.shape === 'exponential') {
    if (c.floorUsd <= 0) return 2 * avg;
    return c.floorUsd * Math.exp(expRateFor(avg / c.floorUsd));
  }
  return 2 * avg - c.floorUsd;
}

/** Price per token at a point in the sale, USD. */
export function priceAt(c: Curve, fractionSold: number): number {
  const f = clamp01(fractionSold);
  const top = maxPrice(c);
  switch (c.shape) {
    case 'linear':
      return c.floorUsd + (top - c.floorUsd) * f;
    case 'sigmoid':
      return c.floorUsd + (top - c.floorUsd) * sigG(f);
    case 'exponential': {
      if (c.floorUsd <= 0) return top * f;
      return c.floorUsd * Math.exp(Math.log(top / c.floorUsd) * f);
    }
  }
}

/** USD raised once `fraction` of the curve supply has sold (the area under the price line). */
export function raiseAt(c: Curve, fraction: number): number {
  const f = clamp01(fraction);
  const top = maxPrice(c);
  const n = c.supply;
  switch (c.shape) {
    case 'linear':
      return n * (c.floorUsd * f + ((top - c.floorUsd) * f * f) / 2);
    case 'sigmoid':
      return n * (c.floorUsd * f + (top - c.floorUsd) * sigInt(f));
    case 'exponential': {
      if (c.floorUsd <= 0) return (n * top * f * f) / 2;
      const k = Math.log(top / c.floorUsd);
      return k < 1e-12 ? n * c.floorUsd * f : (n * c.floorUsd * Math.expm1(k * f)) / k;
    }
  }
}

/** USD cost to buy from token position `from` to `to` (whole tokens, from < to). */
export function costToBuy(c: Curve, from: number, to: number): number {
  const a = Math.max(0, Math.min(from, c.supply));
  const b = Math.max(a, Math.min(to, c.supply));
  return raiseAt(c, b / c.supply) - raiseAt(c, a / c.supply);
}

/** Whole tokens `usd` buys when `soldSoFar` tokens have already sold. Capped at what is left. */
export function tokensForUsd(c: Curve, soldSoFar: number, usd: number): number {
  const sold = Math.max(0, Math.min(soldSoFar, c.supply));
  if (!(usd > 0) || sold >= c.supply) return 0;
  const target = raiseAt(c, sold / c.supply) + usd;
  if (target >= c.ceilingRaiseUsd) return Math.floor(c.supply - sold);
  let lo = sold;
  let hi = c.supply;
  for (let i = 0; i < 200 && hi - lo > 1e-6; i++) {
    const mid = (lo + hi) / 2;
    if (raiseAt(c, mid / c.supply) < target) lo = mid;
    else hi = mid;
  }
  // Tiny epsilon so exact answers on a flat curve don't floor one short.
  return Math.floor(lo - sold + 1e-6);
}

// ── Fair launch ──

export interface EarlyTierSummary {
  /** Whole tokens in the early slice. */
  tokens: number;
  /** USD the early slice raises in total. */
  usd: number;
  /** At least this many separate identities can buy in it (each at the cap). */
  people: number;
  /** Price at the end of the slice, USD. */
  topPriceUsd: number;
}

export function earlyTierSummary(c: Curve): EarlyTierSummary | null {
  const t = c.earlyTier;
  if (!t) return null;
  const usd = raiseAt(c, t.fraction);
  return {
    tokens: Math.floor(c.supply * t.fraction),
    usd,
    people: Math.floor(usd / t.maxUsdPerIdentity),
    topPriceUsd: priceAt(c, t.fraction),
  };
}

/**
 * Most USD one identity may still spend right now under the early-tier rule. `spentInTierUsd` is what
 * that identity has already spent inside the tier. Infinity = no cap applies (tier off, or sold past it).
 * For the sale engine; the curve only describes the rule.
 */
export function earlyTierAllowanceUsd(c: Curve, soldSoFar: number, spentInTierUsd: number): number {
  const t = c.earlyTier;
  if (!t || soldSoFar >= c.supply * t.fraction) return Infinity;
  return Math.max(0, t.maxUsdPerIdentity - spentInTierUsd);
}

// ── Climbs: the one standard launch (owner, 23 Oct 2026) ──
//
// Every token launches on identical terms: 1,000,000,000 supply, all of it on the curve, first token 1¢,
// fair-launch early tier on, unsold supply burnt after 12 months. The issuer picks only how far it climbs
// (and the shape). A nobody's $name room and a celebrity's start the same way.

export type PresetId = 'standard' | 'big' | 'huge';

export interface Preset {
  id: PresetId;
  label: string;
  /** One line for the picker. */
  blurb: string;
  curve: Curve;
}

export const STANDARD_EARLY_TIER: EarlyTier = { fraction: 0.01, maxUsdPerIdentity: 10 };
export const DEFAULT_BURN_AFTER_MONTHS = 12;
export const BURN_CHOICES: readonly (number | null)[] = [null, 6, 12];

export const PRESETS: Record<PresetId, Preset> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    blurb: '1¢ to 19¢. $100M if all sell.',
    curve: makeCurve({ preset: 'standard', ceilingRaiseUsd: 100_000_000 }),
  },
  big: {
    id: 'big',
    label: 'Big',
    blurb: '1¢ to $1.99. $1B if all sell.',
    curve: makeCurve({ preset: 'big', ceilingRaiseUsd: 1_000_000_000 }),
  },
  huge: {
    id: 'huge',
    label: 'Huge',
    blurb: '1¢ to $19.99. $10B if all sell.',
    curve: makeCurve({ preset: 'huge', ceilingRaiseUsd: 10_000_000_000 }),
  },
};

export const DEFAULT_PRESET: PresetId = 'standard';

export const preset = (id: PresetId = DEFAULT_PRESET): Curve => ({ ...PRESETS[id].curve });

/** The standard launch with the issuer's three choices. */
export const standardCurve = (
  climb: PresetId = DEFAULT_PRESET,
  shape: CurveShape = 'linear',
  burnAfterMonths: number | null = DEFAULT_BURN_AFTER_MONTHS,
): Curve => makeCurve({ ...PRESETS[climb].curve, shape, burnAfterMonths });

/** Fit a curve to a token whose supply is smaller than the curve's: the curve can't sell more than exists. */
export const fitToSupply = (c: Curve, tokenSupply: number): Curve =>
  tokenSupply > 0 && tokenSupply < c.supply
    ? makeCurve({ ...c, supply: tokenSupply, ceilingRaiseUsd: (c.ceilingRaiseUsd * tokenSupply) / c.supply })
    : c;

// ── Metadata (what a market reads) ──

export const CURVE_SCHEMA = 'bwx.curve.v1';

export interface CurveMeta extends Curve {
  schema: typeof CURVE_SCHEMA;
}

/**
 * Canonical, versioned JSON: fixed key order, preset dropped (display only), numbers as JS prints them.
 * The issuer's curve is FIXED once launched (owner, 23 Oct 2026): this string and its hash go into the
 * deploy's metadata so anyone can verify the committed curve; there is no edit path afterwards.
 */
export function canonicalCurve(c: Curve): string {
  const t = c.earlyTier;
  return JSON.stringify({
    schema: CURVE_SCHEMA,
    shape: c.shape,
    supply: c.supply,
    floorUsd: c.floorUsd,
    ceilingRaiseUsd: c.ceilingRaiseUsd,
    earlyTier: t ? { fraction: t.fraction, maxUsdPerIdentity: t.maxUsdPerIdentity } : null,
    minBuyUsd: c.minBuyUsd,
    burnAfterMonths: c.burnAfterMonths,
  });
}

export const curveHash = (c: Curve): string => sha256Hex(canonicalCurve(c));

export const toMeta = (c: Curve): CurveMeta => ({ schema: CURVE_SCHEMA, ...c });
export const curveJson = (c: Curve): string => canonicalCurve(c);

/** What a launch writes: the canonical curve plus its sha256. */
export const curveCommitment = (c: Curve): { curve: string; curveHash: string } => {
  const curve = canonicalCurve(c);
  return { curve, curveHash: sha256Hex(curve) };
};

export type CurveVerification = { ok: true; curve: Curve; hash: string } | { ok: false; reason: string };

/**
 * Check launch metadata ({ curve, curveHash } object, or the MAP fields as a flat record): the JSON must be
 * a valid curve, already canonical, and hash to curveHash.
 */
export function verifyCurve(metadata: unknown): CurveVerification {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const raw = typeof m.curve === 'string' ? m.curve : null;
  const hash = typeof m.curveHash === 'string' ? m.curveHash.toLowerCase() : null;
  if (!raw) return { ok: false, reason: 'No curve in this launch' };
  if (!hash) return { ok: false, reason: 'No curve hash in this launch' };
  const c = parseCurve(raw);
  if (!c) return { ok: false, reason: 'Curve is not valid' };
  if (canonicalCurve(c) !== raw) return { ok: false, reason: 'Curve is not in canonical form' };
  if (sha256Hex(raw) !== hash) return { ok: false, reason: 'Curve hash does not match' };
  return { ok: true, curve: c, hash };
}

const SHAPES: readonly CurveShape[] = ['linear', 'sigmoid', 'exponential'];
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Read a curve back from launch metadata (object or JSON string). Null when it isn't one. */
export function parseCurve(v: unknown): Curve | null {
  let o: unknown = v;
  if (typeof v === 'string') {
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const r = (o ?? {}) as Record<string, unknown>;
  if (r.schema !== CURVE_SCHEMA) return null;
  const shape = SHAPES.includes(r.shape as CurveShape) ? (r.shape as CurveShape) : null;
  const supply = num(r.supply);
  const raise = num(r.ceilingRaiseUsd);
  if (!shape || !supply || raise === undefined) return null;
  const t = r.earlyTier as Record<string, unknown> | null | undefined;
  const fraction = num(t?.fraction);
  const cap = num(t?.maxUsdPerIdentity);
  return makeCurve({
    supply,
    shape,
    floorUsd: num(r.floorUsd),
    ceilingRaiseUsd: raise,
    earlyTier: fraction && cap ? { fraction, maxUsdPerIdentity: cap } : null,
    minBuyUsd: num(r.minBuyUsd),
    burnAfterMonths: num(r.burnAfterMonths) ?? null,
    ...(typeof r.preset === 'string' && r.preset in PRESETS ? { preset: r.preset as PresetId } : {}),
  });
}

// ── Plain words ──

/** "1¢", "0.5¢", "$1.20", "$10K", "$100M", "$1B". */
export function usd(v: number): string {
  if (v >= 1e9) return `$${trim(v / 1e9)}B`;
  if (v >= 1e6) return `$${trim(v / 1e6)}M`;
  if (v >= 1e4) return `$${trim(v / 1e3)}K`;
  if (v >= 1) return Number.isInteger(v) ? `$${v.toLocaleString('en-US')}` : `$${v.toFixed(2)}`;
  const cents = v * 100;
  if (cents >= 0.01) return `${trim(cents)}¢`;
  return `$${v.toPrecision(2)}`;
}
const trim = (x: number) => String(Number(x.toPrecision(3)));

export const tokens = (n: number) => Math.floor(n).toLocaleString('en-US');

/** The picker's plain lines. */
export function curveLines(c: Curve, firstUsd = 10): string[] {
  const lines = [
    `First ${usd(firstUsd)} buys ${tokens(tokensForUsd(c, 0, firstUsd))} tokens`,
    `If all sell: ${usd(c.ceilingRaiseUsd)} raised`,
    `Price now ${usd(priceAt(c, 0))} · last token ${usd(maxPrice(c))}`,
  ];
  lines.push(c.burnAfterMonths ? `Unsold after ${c.burnAfterMonths} months: burnt` : 'Unsold: stays on sale forever');
  const e = earlyTierSummary(c);
  if (e && c.earlyTier)
    lines.push(
      `Early tier: first ${trim(c.earlyTier.fraction * 100)}% · max ${usd(c.earlyTier.maxUsdPerIdentity)} each · ` +
        `~${tokens(e.people)} people can get in at ${usd(priceAt(c, 0))}`,
    );
  return lines;
}

/** USD → sats with a BSV/USD rate (the wallet's shared price feed). 0 when the rate is unknown. */
export const usdToSats = (v: number, bsvUsd: number): number => (bsvUsd > 0 ? Math.round((v / bsvUsd) * 1e8) : 0);
