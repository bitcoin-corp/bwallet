/**
 * Signed subscription requests (docs/SUBSCRIBE-API.md › Signing). Every `subscribe` call must carry a Bitcoin Signed
 * Message (BSM) signature by the merchant's identity key over one canonical string:
 *
 *   JSON.stringify(["bwx-subscribe-v1", origin, payTo, usdPerMonth.toFixed(2), "month", merchantName, description,
 *                   nonce, expiresAt])
 *
 * `origin` is the origin the wallet saw the request come from (frame MessageEvent, native WebView, or Chrome's
 * sender), never a value the page supplies, so a request signed for one site can't be replayed from another.
 * Requests expire (at most MAX_LIFETIME_MS ahead) and each nonce is accepted once per origin + merchant key.
 *
 * A valid signature only proves the request came from whoever holds `merchantKey`, and the page supplies that key
 * itself, so it is NOT proof of who the merchant is. The wallet's identity for a request is the real origin; the key
 * is pinned per origin on first approval (trust on first use) so a later request can be shown as the same merchant
 * key as before, or warned about when it changes.
 *
 * Nonces are checked before the sheet and recorded only after the user approves, in a store per origin with its own
 * cap, so no page can use up another page's room.
 *
 * Pure apart from the used-nonce and pinned-key stores (localStorage).
 */
import { BSM, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';

export const SIG_VERSION = 'bwx-subscribe-v1';
/** The longest a signed request may stay valid. */
export const MAX_LIFETIME_MS = 15 * 60_000;
/** Clock skew allowed between the merchant's server and this device. */
const SKEW_MS = 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_RE = /^0[23][0-9a-f]{64}$/i;
/** Per-origin used-nonce store: NONCES_PREFIX + origin. */
const NONCES_PREFIX = 'bwx.subNonces.v2:';
/** Live nonces kept per origin. One origin filling its own store never affects another. */
export const MAX_NONCES_PER_ORIGIN = 200;
/** origin → merchant keys the user has approved a subscription for. */
const PINS = 'bwx.subMerchantKeys.v1';
const MAX_PINS_PER_ORIGIN = 8;

export type SignedFields = {
  origin: string;
  payTo: string;
  usdPerMonth: number;
  merchantName: string;
  description: string;
  nonce: string;
  expiresAt: number;
};

export type MerchantProof = { merchantKey: string; nonce: string; expiresAt: number; signature: string };

/** The exact string a merchant signs. */
export const canonicalSubscribe = (f: SignedFields): string =>
  JSON.stringify([
    SIG_VERSION,
    f.origin,
    f.payTo,
    f.usdPerMonth.toFixed(2),
    'month',
    f.merchantName,
    f.description,
    f.nonce,
    f.expiresAt,
  ]);

class SigError extends Error {}
const fail = (m: string): never => {
  throw new SigError(m);
};

/** Pulls merchantKey / nonce / expiresAt / signature out of the args, or throws naming what's wrong. */
export const parseProof = (args: Record<string, unknown>): MerchantProof => {
  const { merchantKey, nonce, expiresAt, signature } = args;
  if (merchantKey === undefined && signature === undefined)
    fail('Unsigned request: merchantKey and signature are required');
  if (typeof merchantKey !== 'string' || !KEY_RE.test(merchantKey))
    fail('merchantKey must be a compressed public key (66 hex)');
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) fail('nonce must be 16-64 characters of A-Z a-z 0-9 _ -');
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) fail('expiresAt must be a time in ms');
  if (typeof signature !== 'string' || signature.length < 80 || signature.length > 100)
    fail('signature must be a base64 BSM signature');
  return {
    merchantKey: (merchantKey as string).toLowerCase(),
    nonce: nonce as string,
    expiresAt: expiresAt as number,
    signature: signature as string,
  };
};

type NonceMap = Record<string, number>;
const readJson = <T extends object>(k: string): T => {
  try {
    const v = localStorage.getItem(k);
    const m = v ? (JSON.parse(v) as unknown) : {};
    return (m && typeof m === 'object' && !Array.isArray(m) ? m : {}) as T;
  } catch {
    return {} as T;
  }
};
const liveNonces = (origin: string, now: number): NonceMap => {
  const live: NonceMap = {};
  for (const [k, exp] of Object.entries(readJson<NonceMap>(NONCES_PREFIX + origin)))
    if (typeof exp === 'number' && exp > now) live[k] = exp;
  return live;
};

/**
 * Verifies a merchant's signed request for `fields` (origin = the real sender origin) and checks its nonce has not
 * been used from this origin. Records nothing: call recordNonce once the user approves. Throws on an unsigned,
 * malformed, badly signed, expired, too-long-lived or replayed request. Returns the merchant key.
 */
export const verifyMerchant = (fields: Omit<SignedFields, 'nonce' | 'expiresAt'>, p: MerchantProof, now: number) => {
  if (p.expiresAt <= now) fail('This request has expired');
  if (p.expiresAt > now + MAX_LIFETIME_MS + SKEW_MS) fail('expiresAt is too far ahead (15 minutes at most)');
  let ok = false;
  try {
    const msg = Utils.toArray(canonicalSubscribe({ ...fields, nonce: p.nonce, expiresAt: p.expiresAt }), 'utf8');
    ok = BSM.verify(msg, Signature.fromCompact(p.signature, 'base64'), PublicKey.fromString(p.merchantKey));
  } catch {
    ok = false;
  }
  if (!ok) fail('The merchant signature doesn’t match this request');
  if (liveNonces(fields.origin, now)[`${p.merchantKey}:${p.nonce}`]) fail('This request was already used');
  return p.merchantKey;
};

/**
 * Burns an approved request's nonce in `origin`'s own store, kept until it expires. Throws if it was used meanwhile,
 * or if this origin's store is full (never forgets a live nonce to make room: that would reopen replays).
 */
export const recordNonce = (origin: string, p: MerchantProof, now: number) => {
  const live = liveNonces(origin, now);
  const key = `${p.merchantKey}:${p.nonce}`;
  if (live[key]) fail('This request was already used');
  if (Object.keys(live).length >= MAX_NONCES_PER_ORIGIN)
    fail('Too many subscription requests from this site, try again in a few minutes');
  live[key] = p.expiresAt + SKEW_MS;
  try {
    localStorage.setItem(NONCES_PREFIX + origin, JSON.stringify(live));
  } catch {
    fail('Can’t record this request, so it can’t be accepted');
  }
};

/**
 * How `merchantKey` compares with the keys previously approved for this exact origin: 'same' (approved before),
 * 'new' (nothing approved for this origin yet) or 'changed' (this origin was approved with a different key).
 */
export type KeyTrust = 'same' | 'new' | 'changed';
export const merchantKeyTrust = (origin: string, merchantKey: string): KeyTrust => {
  const pinned = readJson<Record<string, unknown>>(PINS)[origin];
  const keys = Array.isArray(pinned) ? pinned.filter((k): k is string => typeof k === 'string') : [];
  if (!keys.length) return 'new';
  return keys.includes(merchantKey.toLowerCase()) ? 'same' : 'changed';
};

/** Pins `merchantKey` for `origin` after the user approved a subscription signed by it. */
export const pinMerchantKey = (origin: string, merchantKey: string) => {
  const all = readJson<Record<string, unknown>>(PINS);
  const prev = Array.isArray(all[origin]) ? (all[origin] as unknown[]).filter((k) => typeof k === 'string') : [];
  const k = merchantKey.toLowerCase();
  all[origin] = [...prev.filter((x) => x !== k), k].slice(-MAX_PINS_PER_ORIGIN);
  try {
    localStorage.setItem(PINS, JSON.stringify(all));
  } catch {
    // Not pinned: the next request from this origin is shown as a new merchant key, which is the safe side.
  }
};

/** Short, readable form of a merchant key for the sheet: 02ab12…9f0e. */
export const keyFingerprint = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;

/**
 * Merchant side (server only, never in a page): signs a request for `origin`. Returns the four fields to add to the
 * `subscribe` args. Copy of the recipe in docs/SUBSCRIBE-API.md › Signing.
 */
export const signSubscribeRequest = (
  f: Omit<SignedFields, 'nonce' | 'expiresAt'>,
  merchantWif: string,
  now = Date.now(),
  nonce = Utils.toBase64(PrivateKey.fromRandom().toArray().slice(0, 18)).replace(/[+/=]/g, (c) =>
    c === '+' ? '-' : c === '/' ? '_' : '',
  ),
): MerchantProof => {
  const key = PrivateKey.fromWif(merchantWif);
  const expiresAt = now + 5 * 60_000;
  const msg = Utils.toArray(canonicalSubscribe({ ...f, nonce, expiresAt }), 'utf8');
  return {
    merchantKey: key.toPublicKey().toString(),
    nonce,
    expiresAt,
    signature: BSM.sign(msg, key, 'base64') as string,
  };
};
