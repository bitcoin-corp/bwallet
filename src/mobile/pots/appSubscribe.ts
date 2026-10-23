/**
 * "Subscribe with bWalletX": the request any framed bApp can make (docs/SUBSCRIBE-API.md).
 *
 *   page → wallet: { type: 'BWX_SUBSCRIBE', isInvocation: true, id, call, args }
 *   wallet → page: { type: 'BWX_SUBSCRIBE', isInvocation: false, id, status: 'success', result }
 *                | { type: 'BWX_SUBSCRIBE', isInvocation: false, id, status: 'error', description }
 *
 *   call 'subscribe'  args { merchantName, payTo, usdPerMonth, description?, appOrigin,
 *                            merchantKey, nonce, expiresAt, signature }   (signed: merchantSig.ts)
 *   call 'status'     args { id }            → only subscriptions this origin made
 *   call 'cancel'     args { id }            → only subscriptions this origin made
 *   call 'list'       args {}                → this origin's subscriptions
 *
 * Owner decisions (16 Oct 2026): priced in dollars, charged monthly in BSV at that day's rate; no locked or prepaid
 * subscriptions; one approval sheet; missed months never stack (catchUp 'latest', payDue.ts). The subscription is an
 * ordinary pots Subscription, so it shows in Pots & Locks › Subscriptions with Pause/Cancel and every payment goes
 * through the pot's spend limits (checkAgentSpend).
 *
 * Pure apart from the pots store; the sheet and the frame host come in from BappFrameHost.tsx.
 * ⚠ bWalletX only: the host wires this behind SUBSCRIPTIONS_ENABLED, so a store build never answers it.
 */
import { isMainnetAddress } from '../names/address';
import {
  type KeyTrust,
  type MerchantProof,
  merchantKeyTrust,
  parseProof,
  pinMerchantKey,
  recordNonce,
  verifyMerchant,
} from './merchantSig';
import { addSubscription, cancelSub, getSub, isPayingPot, listSubs, nextDue, type Subscription } from './pots';

export const SUBSCRIBE_MSG = 'BWX_SUBSCRIBE';
export type SubscribeCall = 'subscribe' | 'status' | 'cancel' | 'list';
const CALLS: readonly string[] = ['subscribe', 'status', 'cancel', 'list'];

export type AppSubscribeRequest = {
  /** Free text chosen by the page: always shown as named by appOrigin, never as a verified identity. */
  merchantName: string;
  /** A paymail (name@host) or a mainnet P2PKH address. */
  payTo: string;
  usdPerMonth: number;
  description: string;
  appOrigin: string;
  /**
   * The key whose signature over this request the wallet verified. The page supplied it, so it proves nothing about
   * who the merchant is; see keyTrust.
   */
  merchantKey: string;
  /** merchantKey against the keys the user approved before for this exact origin (merchantSig.ts). */
  keyTrust: KeyTrust;
};

/** Most a single app subscription may charge a month. Bigger needs a standing order the user types in. */
export const MAX_USD_PER_MONTH = 100;
export const MIN_USD_PER_MONTH = 0.01;
const MAX_NAME = 40;
const MAX_DESC = 140;
const MAX_ID = 128;
const PAYMAIL_RE = /^[a-z0-9._+-]{1,64}@(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}$/i;

export class SubscribeError extends Error {}
const fail = (m: string): never => {
  throw new SubscribeError(m);
};

export type SubscribeMessage = { id: string | number; call: SubscribeCall; args: Record<string, unknown> };

/** A well-formed BWX_SUBSCRIBE invocation, or null. */
export const parseSubscribeMessage = (msg: unknown): SubscribeMessage | null => {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;
  const d = msg as Record<string, unknown>;
  if (d.type !== SUBSCRIBE_MSG || d.isInvocation !== true) return null;
  const idOk =
    (typeof d.id === 'string' && d.id.length > 0 && d.id.length <= MAX_ID) ||
    (typeof d.id === 'number' && Number.isFinite(d.id));
  if (!idOk || typeof d.call !== 'string' || !CALLS.includes(d.call)) return null;
  const args = d.args === undefined ? {} : d.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return { id: d.id as string | number, call: d.call as SubscribeCall, args: args as Record<string, unknown> };
};

export const subscribeReply = (id: string | number, result: unknown) =>
  ({ type: SUBSCRIBE_MSG, isInvocation: false, id, status: 'success', result }) as const;
export const subscribeErrorReply = (id: string | number, description: string) =>
  ({ type: SUBSCRIBE_MSG, isInvocation: false, id, status: 'error', description }) as const;

/** Round to whole cents. */
export const cents = (n: number) => Math.round(n * 100) / 100;

const text = (v: unknown, max: number, what: string, required: boolean): string => {
  if (v === undefined || v === null || v === '') return required ? fail(`${what} is required`) : '';
  if (typeof v !== 'string') return fail(`${what} must be text`);
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
  if (required && !t) fail(`${what} is required`);
  if (t.length > max) fail(`${what} must be at most ${max} characters`);
  return t;
};

/**
 * Checks a subscribe request against the origin that really sent it. `appOrigin` must be that exact origin: an app
 * can't ask on another site's behalf.
 */
const parseSigned = (
  args: Record<string, unknown>,
  senderOrigin: string,
  now: number,
): { req: AppSubscribeRequest; proof: MerchantProof } => {
  if (args.appOrigin !== senderOrigin) fail('appOrigin must be the origin of the page asking');
  const merchantName = text(args.merchantName, MAX_NAME, 'merchantName', true);
  const description = text(args.description, MAX_DESC, 'description', false);
  const payTo = text(args.payTo, 120, 'payTo', true);
  if (!PAYMAIL_RE.test(payTo) && !isMainnetAddress(payTo)) fail('payTo must be a paymail or a BSV address');
  const usd = args.usdPerMonth;
  if (typeof usd !== 'number' || !Number.isFinite(usd)) fail('usdPerMonth must be a number');
  const usdPerMonth = cents(usd as number);
  if (usdPerMonth < MIN_USD_PER_MONTH || usdPerMonth > MAX_USD_PER_MONTH)
    fail(`usdPerMonth must be between $${MIN_USD_PER_MONTH} and $${MAX_USD_PER_MONTH}`);
  // Signed over exactly what the sheet shows, bound to the REAL sender origin. The nonce is checked here and only
  // recorded after the user approves (handleSubscribeCall).
  const proof = parseProof(args);
  const merchantKey = verifyMerchant(
    { origin: senderOrigin, payTo, usdPerMonth, merchantName, description },
    proof,
    now,
  );
  const keyTrust = merchantKeyTrust(senderOrigin, merchantKey);
  return {
    req: { merchantName, payTo, usdPerMonth, description, appOrigin: senderOrigin, merchantKey, keyTrust },
    proof,
  };
};

export const parseSubscribeArgs = (
  args: Record<string, unknown>,
  senderOrigin: string,
  now = Date.now(),
): AppSubscribeRequest => parseSigned(args, senderOrigin, now).req;

/** Subscribe requests one origin may make a minute. Each origin has its own count; one never blocks another. */
export const MAX_ASKS_PER_MINUTE = 5;
const pending = new Set<string>();
const recent = new Map<string, number[]>();
/** Tests only. */
export const resetSubscribeLimits = () => {
  pending.clear();
  recent.clear();
};
const takeSlot = (origin: string, now: number) => {
  if (pending.has(origin)) fail('A subscription request from this site is already waiting');
  const times = (recent.get(origin) ?? []).filter((t) => t > now - 60_000);
  if (times.length >= MAX_ASKS_PER_MINUTE) fail('Too many subscription requests from this site, try again soon');
  times.push(now);
  recent.set(origin, times);
  pending.add(origin);
};

/** The pots Subscription an approved request becomes: $X a month, first payment now, no end, no stacking. */
export const newAppSub = (r: AppSubscribeRequest, potId: string, now: number) => ({
  potId,
  payee: {
    name: r.merchantName,
    origin: r.appOrigin,
    merchantKey: r.merchantKey,
    ...(PAYMAIL_RE.test(r.payTo) ? { paymail: r.payTo.toLowerCase() } : { address: r.payTo }),
  },
  amount: { value: r.usdPerMonth, currency: 'USD' as const },
  period: 'month' as const,
  start: now,
  maxCount: null,
  catchUp: 'latest' as const,
  ...(r.description ? { description: r.description } : {}),
});

/** Stores an approved request. bsvUsd is only used for the pot's default daily cap. */
export const createAppSub = (r: AppSubscribeRequest, potId: string, bsvUsd: number, now = Date.now()) => {
  // Pot only, never the main balance (owner, 18 Oct 2026).
  if (!isPayingPot(potId)) fail('Only a pot can pay');
  return addSubscription(newAppSub(r, potId, now), bsvUsd, now);
};

export type AppSubStatus = {
  id: string;
  status: 'active' | 'paused' | 'cancelled' | 'ended' | 'lowFunds';
  merchantName: string;
  usdPerMonth: number;
  /** ISO time of the next charge, or null once it can't charge again. */
  nextCharge: string | null;
  lastPayment: { at: string; txid: string; usd: number; sats: number } | null;
  lastError: string | null;
};

/** What an app may see about its own subscription: no pot, no balance, no keys. */
export const toStatus = (s: Subscription): AppSubStatus => {
  const live = s.status === 'active' || s.status === 'lowFunds' || s.status === 'paused';
  const next = live ? nextDue(s) : null;
  return {
    id: s.id,
    status: s.status,
    merchantName: s.payee.name,
    usdPerMonth: s.amount.value,
    nextCharge: next === null ? null : new Date(next).toISOString(),
    lastPayment: s.lastReceipt ? { ...s.lastReceipt, at: new Date(s.lastReceipt.at).toISOString() } : null,
    lastError: s.lastError ?? null,
  };
};

/** One of this origin's subscriptions; an id from another origin is "unknown", never a hint that it exists. */
const own = (origin: string, id: unknown): Subscription => {
  if (typeof id !== 'string' || !id || id.length > MAX_ID) fail('id must be a subscription id');
  const s = getSub(id as string);
  if (!s || s.payee.origin !== origin) fail('Unknown subscription');
  return s as Subscription;
};

export type SubscribeDeps = {
  /** The wallet's one approval sheet. Resolves with the pot the user picked, or null when declined. */
  approve: (r: AppSubscribeRequest) => Promise<string | null>;
  bsvUsd: () => number;
  /** Ask the charger to run now (the first month is due at once). */
  chargeSoon?: () => void;
  now?: () => number;
};

/** Answers one call from `origin`. Throws for an error reply. */
export const handleSubscribeCall = async (
  call: SubscribeCall,
  args: Record<string, unknown>,
  origin: string,
  deps: SubscribeDeps,
): Promise<unknown> => {
  const now = deps.now?.() ?? Date.now();
  switch (call) {
    case 'subscribe': {
      takeSlot(origin, now);
      try {
        const { req: r, proof } = parseSigned(args, origin, now);
        const potId = await deps.approve(r);
        if (!potId) return fail('Declined');
        // Approved: burn the nonce (re-checked for a replay while the sheet was open), then pin the key.
        const at = deps.now?.() ?? Date.now();
        recordNonce(origin, proof, at);
        pinMerchantKey(origin, r.merchantKey);
        const s = createAppSub(r, potId, deps.bsvUsd(), at);
        deps.chargeSoon?.();
        return toStatus(s);
      } finally {
        pending.delete(origin);
      }
    }
    case 'status':
      return toStatus(own(origin, args.id));
    case 'list':
      return listSubs()
        .filter((s) => s.payee.origin === origin)
        .map(toStatus);
    case 'cancel': {
      const s = own(origin, args.id);
      cancelSub(s.id, now);
      return toStatus(getSub(s.id) ?? s);
    }
  }
};

/** handleSubscribeCall as a reply message: never throws. */
export const answerSubscribe = async (m: SubscribeMessage, origin: string, deps: SubscribeDeps) => {
  try {
    return subscribeReply(m.id, await handleSubscribeCall(m.call, m.args, origin, deps));
  } catch (e) {
    return subscribeErrorReply(m.id, e instanceof Error ? e.message : String(e));
  }
};
