/**
 * Payee binding for standing orders. A paymail payee is resolved at setup and its identity key is pinned on the
 * order (Payee.pinnedKey). Every automatic payment re-resolves the paymail through destinationFor, the same
 * checks as an interactive send, and must also match the pinned key. Anything else is not paid: the order is
 * flagged needsReview and the user confirms the new destination by hand.
 *
 * Legacy orders saved before pinning have no pinnedKey. They are pinned on their first resolution that passes
 * destinationFor and serves a key (payDue does this), so the first verified key becomes the reference.
 * A paymail whose host serves no identity key can't be pinned; it is still checked by destinationFor each time.
 */
import { destinationFor, type Resolved } from '../names/names';
import type { Payee } from './pots';

/** The destination could not be verified: don't pay, ask the user to confirm it again. */
export class PayeeReviewError extends Error {
  constructor(
    message: string,
    /** The key the paymail serves now, if any (shown on the review card). */
    public readonly servedKey?: string,
  ) {
    super(message);
    this.name = 'PayeeReviewError';
  }
}

export const PAYEE_KEY_CHANGED =
  'This paymail now points to a different wallet than when you set up this subscription. Not paying it until you confirm the new destination.';
export const PAYEE_KEY_MISSING =
  'This paymail no longer shows the wallet key it had when you set up this subscription. Not paying it until you confirm.';
export const P2P_ONLY = (paymail: string) => `${paymail} only takes P2P payments, which subscriptions can’t send yet`;

/** Short form of an identity key for confirm cards: first 8 and last 6 hex characters. */
export const keyFingerprint = (key: string) => (key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key);

export type PayeeDestination = { address: string; pubkey?: string };

/**
 * Where to pay a resolved paymail payee, or throw. destinationFor first (unbound / bad binding / BRC-169 key change
 * all refuse); then the pinned key must match unless `ignorePin` (the user is reviewing a new destination).
 * Bad bindings and key changes throw PayeeReviewError; other refusals throw a plain Error.
 */
export const payeeDestination = (p: Payee, r: Resolved, opts: { ignorePin?: boolean } = {}): PayeeDestination => {
  const d = destinationFor(r, 'bsv');
  if (!d.ok) {
    if (r.nameBinding === 'bad' || r.nameBinding === 'changed') throw new PayeeReviewError(d.error, r.pubkey);
    throw new Error(d.error);
  }
  if (p.pinnedKey && !opts.ignorePin) {
    if (!r.pubkey) throw new PayeeReviewError(PAYEE_KEY_MISSING);
    if (r.pubkey !== p.pinnedKey) throw new PayeeReviewError(PAYEE_KEY_CHANGED, r.pubkey);
  }
  if (r.targetKind !== 'address') throw new Error(P2P_ONLY(p.paymail ?? r.input));
  return { address: d.to, ...(r.pubkey ? { pubkey: r.pubkey } : {}) };
};
