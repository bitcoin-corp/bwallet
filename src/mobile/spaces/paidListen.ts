import type { OneSatContext } from '@1sat/actions';
import type { MessageCharge } from '../chat/roomSpend';

/**
 * Paid listening in a Space (bit-sign lib/paid-listening.ts; owner, 11 Oct 2026).
 *
 * The host sets a price per second / minute / hour in BSV (priced in dollars) or a BSV-21 token,
 * paid to the people on stage, to the token's issuer, or burned. A listener approves once with a
 * spending limit for the session; the wallet then pays one minute at a time, straight to the
 * speakers (never through bChatX), and stops at the limit or when they leave.
 *
 * bWalletX only: never in a store build (literal env check so Vite drops the whole module there).
 */
export const PAID_LISTENING_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

export type PaidPer = 'second' | 'minute' | 'hour';
export type PaidCurrency = { kind: 'bsv' } | { kind: 'bsv21'; tokenId: string; sym: string; dec: number };
export type PaidDest = 'stage' | 'issuer' | 'burn';

export interface PaidConfig {
  enabled: boolean;
  amount: number;
  per: PaidPer;
  currency: PaidCurrency;
  dest: PaidDest;
  hostSharePct: number;
  freeFirstMinute: boolean;
  issuerAddress?: string;
}

export interface ListenPlan {
  v: 1;
  ticker: string;
  spaceId: string;
  payer: string;
  minute: number;
  body: string;
  rule: 'space-listen';
  charges: MessageCharge[];
  issuedAt: number;
}

export interface PaidState {
  config: PaidConfig | null;
  price: string | null;
  canConfigure: boolean;
  me: { role: string; paidThrough: number | null; hearing: boolean; minutesPaid?: number } | null;
  plan?: ListenPlan;
  sig?: string;
  free?: boolean;
  error?: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function parsePaidState(data: unknown): PaidState {
  const d = obj(data);
  const c = obj(d.config);
  const cur = obj(c.currency);
  const currency: PaidCurrency | null =
    cur.kind === 'bsv'
      ? { kind: 'bsv' }
      : cur.kind === 'bsv21' && typeof cur.tokenId === 'string'
        ? { kind: 'bsv21', tokenId: cur.tokenId, sym: String(cur.sym ?? ''), dec: Number(cur.dec ?? 0) }
        : null;
  const config: PaidConfig | null =
    currency && typeof c.amount === 'number'
      ? {
          enabled: c.enabled === true,
          amount: c.amount,
          per: c.per === 'second' || c.per === 'hour' ? c.per : 'minute',
          currency,
          dest: c.dest === 'issuer' || c.dest === 'burn' ? c.dest : 'stage',
          hostSharePct: Number(c.hostSharePct ?? 0) || 0,
          freeFirstMinute: c.freeFirstMinute !== false,
          issuerAddress: typeof c.issuerAddress === 'string' ? c.issuerAddress : undefined,
        }
      : null;
  const me = obj(d.me);
  return {
    config,
    price: typeof d.price === 'string' ? d.price : null,
    canConfigure: d.canConfigure === true,
    me: d.me
      ? {
          role: String(me.role ?? 'listener'),
          paidThrough: typeof me.paidThrough === 'number' ? me.paidThrough : null,
          hearing: me.hearing !== false,
          minutesPaid: typeof me.minutesPaid === 'number' ? me.minutesPaid : undefined,
        }
      : null,
    plan: d.plan && typeof d.sig === 'string' ? (d.plan as ListenPlan) : undefined,
    sig: typeof d.sig === 'string' ? d.sig : undefined,
    free: d.free === true,
    error: typeof d.error === 'string' ? d.error : undefined,
  };
}

/** Total of a plan in its own unit (sats or raw token units). */
export const planTotal = (p: ListenPlan): bigint => p.charges.reduce((n, c) => n + BigInt(c.amount), BigInt(0));

/** Pay this minute now? Pays shortly before the paid time ends, never past the session limit. */
export function shouldPay(o: {
  approved: boolean;
  plan: ListenPlan | undefined;
  paidThrough: number | null;
  now: number;
  spent: bigint;
  limit: bigint;
  busy: boolean;
  leadMs?: number;
}): 'pay' | 'wait' | 'limit' {
  if (!o.approved || !o.plan || o.busy) return 'wait';
  const lead = o.leadMs ?? 20_000;
  if (o.paidThrough !== null && o.paidThrough - o.now > lead) return 'wait';
  if (o.spent + planTotal(o.plan) > o.limit) return 'limit';
  return 'pay';
}

/** "$0.04" for sats at a rate, or "12.5 $PNEE" for raw token units. */
export function formatSpent(raw: bigint, currency: PaidCurrency, bsvUsd: number | null): string {
  if (currency.kind === 'bsv') {
    if (!bsvUsd) return `${raw.toString()} sats`;
    return `$${((Number(raw) / 1e8) * bsvUsd).toFixed(2)}`;
  }
  const v = Number(raw) / 10 ** currency.dec;
  return `${v} $${currency.sym || 'tokens'}`;
}

/** The session limit in the payment's own unit, from a dollar (BSV) or token amount the listener chose. */
export function limitRaw(amount: number, currency: PaidCurrency, bsvUsd: number | null): bigint {
  if (!(amount > 0)) return BigInt(0);
  if (currency.kind === 'bsv') return bsvUsd ? BigInt(Math.floor((amount / bsvUsd) * 1e8)) : BigInt(0);
  return BigInt(Math.floor(amount * 10 ** currency.dec));
}

export interface PaidClient {
  spacePaid(ticker: string): Promise<unknown>;
  spacePaidAction(ticker: string, body: Record<string, unknown>): Promise<unknown>;
}

/**
 * Pay one minute: the wallet signs a transaction paying exactly the plan (and committing to this
 * Space and minute); bit-sign checks it, broadcasts it and records it. A refused payment is
 * released so its coins are spendable again.
 */
export async function payPlan(
  ctx: OneSatContext,
  client: PaidClient,
  plan: ListenPlan,
  sig: string,
  deps: {
    payForMessage: (
      ctx: OneSatContext,
      m: {
        ticker: string;
        handle: string;
        text: string;
        charge: { rule: string; charges: MessageCharge[]; unenforced: null; exempt: false };
      },
    ) => Promise<{ beef: string; txid: string }>;
    releasePayment: (ctx: OneSatContext, txid: string, cause: unknown) => Promise<void>;
  },
): Promise<{ txid: string; paidThrough: number | null }> {
  const signed = await deps.payForMessage(ctx, {
    ticker: plan.ticker,
    handle: plan.payer,
    text: plan.body,
    charge: { rule: plan.rule, charges: plan.charges, unenforced: null, exempt: false },
  });
  try {
    const r = obj(await client.spacePaidAction(plan.ticker, { action: 'pay', plan, sig, beef: signed.beef }));
    return { txid: signed.txid, paidThrough: typeof r.paidThrough === 'number' ? r.paidThrough : null };
  } catch (e) {
    void deps.releasePayment(ctx, signed.txid, e);
    throw e;
  }
}
