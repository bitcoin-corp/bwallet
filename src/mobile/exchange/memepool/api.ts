/**
 * Memepool HTTP API (https://txblaster.xyz/memepool/api, OpenAPI at /openapi.json). CORS open, no key. Every answer
 * is untrusted data: the trade verifier decides what may be signed, not these calls.
 */
import { CREATOR_BPS, FEE_BPS, MEMEPOOL_API, PLATFORM_ADDRESS } from './constants';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** An HTTP failure with Memepool's own error code, when it sent one. */
export class MemepoolHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(message);
  }
}

const HEADERS = { 'X-Memepool-Client': 'bWalletX' };
const TIMEOUT_MS = 15_000;

async function call<T>(f: Fetcher, path: string, body?: unknown): Promise<T> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  let r: Response;
  try {
    r = await f(`${MEMEPOOL_API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? HEADERS : { ...HEADERS, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      signal: ctl?.signal,
    });
  } catch (e) {
    throw new MemepoolHttpError(e instanceof Error ? e.message : 'Network error', 0, null);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok) {
    const code = typeof j?.code === 'string' ? j.code : typeof j?.error === 'string' ? j.error : null;
    const msg = typeof j?.message === 'string' ? j.message : (code ?? `Memepool answered ${r.status}`);
    throw new MemepoolHttpError(msg.slice(0, 200), r.status, code);
  }
  return j as T;
}

export const getConfig = (f: Fetcher) => call<Record<string, unknown>>(f, '/config');
export const getCoin = (f: Fetcher, id: string) => call<Record<string, unknown>>(f, `/tokens/${id}`);
export const getProof = (f: Fetcher) => call<unknown>(f, '/proof');
export const getQuote = (f: Fetcher, id: string, side: 'buy' | 'sell', amount: bigint) =>
  call<Record<string, unknown>>(f, `/quote?id=${id}&side=${side}&${side === 'buy' ? 'sats' : 'tokens'}=${amount}`);
export const prepareTrade = (f: Fetcher, body: unknown) => call<Record<string, unknown>>(f, '/trade/prepare', body);
export const submitTrade = (f: Fetcher, body: unknown) => call<Record<string, unknown>>(f, '/trade/submit', body);

/** Null when Memepool's /config still matches what we pinned; else the plain-English reason we won't trade. */
export function configProblem(cfg: Record<string, unknown>): string | null {
  if (cfg.trading === false) return 'Memepool has paused trading.';
  if (cfg.network !== 'main' || cfg.demo === true) return 'Memepool is not on the live network right now.';
  if (cfg.platformAddress !== PLATFORM_ADDRESS || BigInt(Number(cfg.feeBps) || 0) !== FEE_BPS)
    return 'Memepool changed its fees or fee address. bWalletX needs an update before it trades there again.';
  if (BigInt(Number(cfg.creatorBps) || 0) !== CREATOR_BPS)
    return 'Memepool changed its fees or fee address. bWalletX needs an update before it trades there again.';
  return null;
}

/** Plain English for Memepool's 400/429 answers. */
export function plainError(e: unknown): string {
  if (e instanceof MemepoolHttpError) {
    if (e.status === 429) return 'Memepool is busy. Try again in a minute.';
    if (e.status === 0) return "Memepool isn't answering. Check your connection and try again.";
    const known: Record<string, string> = {
      slippage: 'The price moved more than you allowed. Try again.',
      stale: 'Someone else traded first. Try again.',
      expired: 'This price expired. Try again.',
      insufficient_funds: "There isn't enough BSV for this trade.",
      insufficient_tokens: "You don't hold enough of this coin yet (new coins can take a minute to show).",
      coins_short: "There isn't enough BSV for this trade.",
      pool_tokens_short: "The pool doesn't have that many tokens left.",
      sell_too_small: 'That sell is too small to cover its fees.',
      halted: 'Memepool has paused trading this coin.',
      wait_block: 'Trading on this coin resumes with the next block.',
    };
    if (e.code && known[e.code]) return known[e.code];
    return `Memepool said: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
