/**
 * "Pay per message" mode: each message is paid in BSV from this wallet BEFORE it is answered.
 *
 *   1. price   GET  {origin}/api/bitsign/agent/price  → flat price per message (sats, ≈USD), shown up front
 *   2. quote   POST {origin}/api/bitsign/agent/quote  → { quoteId, sats, payTo, expiresAt } for THIS message
 *   3. pay     the wallet sends `sats` to `payTo` (one-click under the user's limit, else a confirm sheet;
 *              never above the daily limit in Settings › b agent)
 *   4. answer  POST {origin}/api/bitsign/agent/turn   { quoteId, txid, messages } → { text }
 *
 * bit-sign must provide these endpoints (see the report / docs in the PR); the wallet never sends a
 * provider key on this path. If the turn fails after paying, the same quoteId + txid is retried —
 * never paid twice. Pure helpers here (tested in paid.test.ts) plus the PaidBackend interface.
 */
import type { AgentMessage } from './agent';
import { fmtUsd, money } from '../money/money';
import { enabledAddOns, loadBWeb } from '../bweb/bweb';

export type PriceInfo = {
  enabled: boolean;
  /** Price of one message in US dollars, when the server says (USD-first display). null = derive from sats. */
  usd: number | null;
  /** Price of one message, in sats. */
  sats: number;
  /** BSV price in USD the server used (0 = unknown). */
  bsvUsd: number;
  model: string;
  reason?: string;
};

export type Quote = { quoteId: string; sats: number; payTo: string; expiresAt: number };

export interface PaidBackend {
  price(): Promise<PriceInfo>;
  quote(messages: AgentMessage[]): Promise<Quote>;
  /** `beef` = the signed payment (hex BEEF / raw tx) so the server can verify + broadcast it without waiting on indexers. */
  turn(quote: Quote, txid: string, messages: AgentMessage[], system: string, beef?: string): Promise<string>;
  /** Free Ask b (agent.ts ASK_B_FREE): answered with no quote and no payment, under bit-sign's daily cap. */
  free(messages: AgentMessage[], system: string): Promise<string>;
}

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const posInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);

/** A P2PKH mainnet address (1…, base58). Pay-to must be one; anything else is refused. */
export const isP2pkhAddress = (a: unknown): a is string =>
  typeof a === 'string' && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

/** Hard ceiling on any single message payment, whatever the server says (≈ a few dollars). */
export const MAX_MESSAGE_SATS = 1_000_000;

export const parsePrice = (data: unknown): PriceInfo => {
  const d = obj(data);
  const sats = posInt(d.sats);
  const bsvUsd = typeof d.bsvUsd === 'number' && d.bsvUsd > 0 ? d.bsvUsd : 0;
  const enabled = d.enabled === true && sats > 0 && sats <= MAX_MESSAGE_SATS;
  const usd = typeof d.usd === 'number' && Number.isFinite(d.usd) && d.usd > 0 ? d.usd : null;
  return {
    enabled,
    usd,
    sats,
    bsvUsd,
    model: typeof d.model === 'string' ? d.model : '',
    reason: enabled ? undefined : typeof d.reason === 'string' ? d.reason : 'Paid messages are not available yet.',
  };
};

export const parseQuote = (data: unknown, now = Date.now()): Quote => {
  const d = obj(data);
  const sats = posInt(d.sats);
  const expiresAt = typeof d.expiresAt === 'number' ? d.expiresAt : 0;
  if (typeof d.quoteId !== 'string' || !/^[\w-]{8,64}$/.test(d.quoteId)) throw new Error('Bad quote from server.');
  if (!sats || sats > MAX_MESSAGE_SATS) throw new Error('The quoted price is out of range.');
  if (!isP2pkhAddress(d.payTo)) throw new Error('The quote has no valid pay-to address.');
  if (expiresAt <= now) throw new Error('The quote has expired. Try again.');
  return { quoteId: d.quoteId, sats, payTo: d.payTo, expiresAt };
};

export const parseTurn = (data: unknown): string => {
  const t = obj(data).text;
  return typeof t === 'string' && t.trim() ? t.trim() : 'No reply.';
};

/** USD first: the server's `usd` when given, else sats at the rate ("$0.0005"); "1,234 sats" when neither is known. */
export const formatPrice = (sats: number, bsvUsd: number, usd: number | null = null): string =>
  usd !== null && usd > 0 ? fmtUsd(usd) : money(sats, bsvUsd);

export type PayDecision =
  | { kind: 'auto' }
  | { kind: 'confirm' }
  | { kind: 'refuse'; reason: 'limit-off' | 'over-daily' | 'over-max' };

/**
 * How to pay a quoted message. The daily limit is absolute (no confirm can exceed it); within it,
 * one-click pay (settings/oneClick.ts) decides auto vs confirm. `oneClickOk` = oneClick.take(sats).ok,
 * evaluated only when the daily limit allows (so a refused message never consumes a one-click slot).
 */
export const payDecision = (
  sats: number,
  dailyLimitSats: number,
  spentTodaySats: number,
  oneClickOk: () => boolean,
): PayDecision => {
  if (sats > MAX_MESSAGE_SATS) return { kind: 'refuse', reason: 'over-max' };
  if (dailyLimitSats <= 0) return { kind: 'refuse', reason: 'limit-off' };
  if (spentTodaySats + sats > dailyLimitSats) return { kind: 'refuse', reason: 'over-daily' };
  return oneClickOk() ? { kind: 'auto' } : { kind: 'confirm' };
};

export const refuseText = (reason: 'limit-off' | 'over-daily' | 'over-max', limit: number, bsvUsd = 0) =>
  reason === 'limit-off'
    ? 'Paid messages are switched off. Set a daily limit in Settings › b agent.'
    : reason === 'over-daily'
      ? `This would go over your daily b agent limit (${money(limit, bsvUsd)}). Raise it in Settings › b agent, or use your own API key.`
      : 'That price is higher than bWallet allows for one message.';

/** Body for the answer call. Only the transcript and the guide: never a key. */
export const turnBody = (quote: Quote, txid: string, messages: AgentMessage[], system: string, beef?: string) => ({
  quoteId: quote.quoteId,
  txid,
  messages,
  system,
  // The signed payment itself: the server checks it pays this quote and broadcasts it, so a
  // fresh tx is never "not on the network yet". Older servers ignore it (txid-only fallback).
  ...(beef && /^[0-9a-f]+$/i.test(beef) ? { beef } : {}),
  // So b can log a bug report with the platform without asking (bit-sign lib/b-feedback.ts).
  client: clientInfo(),
  // Ask b add-ons switched on in Settings › bWeb (bweb.ts). Same price per message; omitted when none.
  ...addOnsField(),
});

/** Body for a free turn: the transcript, the guide, the client and add-ons. No quote, no txid, never a key. */
export const freeBody = (messages: AgentMessage[], system: string) => ({
  messages,
  system,
  client: clientInfo(),
  ...addOnsField(),
});

/** The error `code` bit-sign returns when b's free daily allowance is used up (429). */
export const FREE_CAP_CODE = 'free_cap';
export const FREE_REST_TEXT =
  "b needs a rest — back tomorrow. Bug reports still go through: tell me what's wrong and it reaches the team.";

/**
 * When b can't answer for free (allowance used, or a server without /agent/free yet) the message still goes to
 * the team (reportToB). What b shows: the server's rest words (or ours), then the report's ack.
 */
export const freeFallbackReply = (restText: string | null, reportLine: string) =>
  `${restText?.trim() || "b can't answer just now, but your message was passed to the team."}\n\n${reportLine}`;

const addOnsField = (): { addOns?: string[] } => {
  try {
    const on = enabledAddOns(loadBWeb());
    return on.length ? { addOns: on } : {};
  } catch {
    return {};
  }
};

export const clientInfo = (): { platform: string; version?: string } => {
  const g = globalThis as {
    chrome?: { runtime?: { getManifest?: () => { version?: string } } };
    Capacitor?: { getPlatform?: () => string };
  };
  const native = g.Capacitor?.getPlatform?.();
  if (native === 'ios') return { platform: 'iPhone' };
  if (native === 'android') return { platform: 'Android' };
  try {
    const v = g.chrome?.runtime?.getManifest?.().version;
    if (v) return { platform: 'Chrome extension', version: v };
  } catch {
    /* not the extension */
  }
  return { platform: 'web' };
};

/**
 * What the person sees when the payment for a paid message fails (owner, 14 Oct 2026: Desktop showed only
 * "An unknown error has occurred! Try again."). Names the reason in plain words and says the message wasn't sent.
 */
export const paymentFailedText = (err: unknown): string => {
  const raw = (err instanceof Error ? err.message : typeof err === 'string' ? err : '').trim();
  let reason: string;
  if (/WERR_REVIEW_ACTIONS|require review/i.test(raw))
    reason = 'the network refused it because an earlier payment from this wallet is still being settled';
  else if (/insufficient/i.test(raw)) reason = 'not enough spendable BSV in this wallet';
  else if (/timed? ?out/i.test(raw)) reason = 'the wallet took too long to respond';
  else if (/refused|cancel|denied|reject/i.test(raw)) reason = 'it was cancelled';
  else if (raw && !/unknown error/i.test(raw))
    reason = raw
      .replace(/\s+/g, ' ')
      .replace(/[.!]+$/, '')
      .slice(0, 160);
  else reason = 'the wallet gave no reason';
  return `Payment didn't go through: ${reason}. Your message wasn't sent.`;
};

/** Waits before re-asking when the server has not seen the payment yet (it also polls ~12 s itself). */
export const NOT_YET_RETRY_MS = [3000, 6000] as const;

/** bit-sign implementation over any JSON caller (the signed-in bChat client). */
/**
 * Tell b something without an answer (owner, 14 Oct 2026). In bWallet, the store edition, b runs only on the
 * person's own AI key; with no key nothing could reach the team. Now what they type goes to
 * POST /api/bitsign/agent/feedback, which classifies and logs it (bit-sign lib/b-feedback.ts) and returns the
 * words b shows: the ack with a reference, or a note that it could not be logged.
 */
export type ReportResult = { ok: boolean; ack: string; ref?: string };
export const parseReport = (v: unknown): ReportResult => {
  const o = obj(v);
  const ack = typeof o.ack === 'string' && o.ack.trim() ? o.ack.trim() : '';
  if (!ack) throw new Error(typeof o.error === 'string' ? o.error : 'b could not take that just now.');
  return { ok: o.ok === true, ack, ...(typeof o.ref === 'string' ? { ref: o.ref } : {}) };
};
export const reportToB = async (
  call: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>,
  text: string,
): Promise<ReportResult> =>
  parseReport(await call('POST', '/api/bitsign/agent/feedback', { text, client: clientInfo() }));

/** What b says in place of an answer when it has no key: the ack, then how to get answers. */
export const noKeyReply = (r: ReportResult, providerLabel: string) =>
  `${r.ack}\n\nI can't answer questions in this edition without an AI key. Add your ${providerLabel} key in Settings › b agent and I'll reply here too.`;

export const bitsignPaidBackend = (
  call: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>,
): PaidBackend => ({
  price: async () => parsePrice(await call('GET', '/api/bitsign/agent/price')),
  quote: async (messages) =>
    parseQuote(
      await call('POST', '/api/bitsign/agent/quote', {
        turns: messages.length,
        chars: messages.reduce((n, m) => n + m.text.length, 0),
      }),
    ),
  turn: async (quote, txid, messages, system, beef) =>
    parseTurn(await call('POST', '/api/bitsign/agent/turn', turnBody(quote, txid, messages, system, beef))),
  free: async (messages, system) =>
    parseTurn(await call('POST', '/api/bitsign/agent/free', freeBody(messages, system))),
});
