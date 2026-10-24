import { Utils, type WalletInterface } from '@bsv/sdk';
import { resultIsQueued, withBroadcastNow } from '../../services/bigDelayed';
import type { Destination, SubmitMeta } from './company';
import {
  OfferError,
  docHash,
  embedSignature,
  isExpired,
  offerOpReturnHex,
  satsToBsv,
  signOfferHash,
  usdToSatsCeil,
  type Manifest,
  type Quote,
} from './offer';
import type { OfferAccepted, OfferSealed } from './payload';

/**
 * Accept = sign to pay, one action (offer template §A, spec §3). In order:
 *   1. embed the signature PNG at the subscriber anchor; completedHash = sha256 of the completed HTML
 *   2. sign completedHash with the identity key                         ← fails: nothing paid
 *   3. ask the company paymail for its payment outputs                  ← fails: the signature is dropped
 *   4. one transaction: those outputs + OP_RETURN ["bcorp-offer", ref, completedHash], broadcast NOW
 *      (acceptDelayedBroadcast: false, as PR #65: a refusal is an error, never a txid)   ← fails: nothing paid,
 *      nothing submitted
 *   5. submit the payment with the signature to the company server, which writes the receipt
 * The signature leaves the device only in step 5, with a payment the network has accepted. If the network has not
 * answered yet (queued) or step 5 fails, the payment and signature are kept together locally and resubmitted
 * (retryPending); they are never sent apart.
 */
export type AcceptDeps = {
  wallet: Pick<WalletInterface, 'createSignature' | 'createAction'>;
  destination: (sats: number) => Promise<Destination>;
  submit: (a: { beef: string; reference: string; metadata: SubmitMeta }) => Promise<void>;
  pending: PendingStore;
  now?: () => number;
};
export type AcceptInput = {
  offer: OfferSealed & { manifest: Manifest };
  me: string;
  myHandle: string;
  pngB64: string;
  quote: Quote;
  /** This wallet already holds an acceptance for the offer (vault): never pay twice. */
  alreadyPaid?: boolean;
};
export type AcceptResult = { state: 'done' | 'waiting'; accepted: OfferAccepted; note?: string };

export type Pending = {
  ref: string;
  txid: string;
  beef: string;
  reference: string;
  metadata: SubmitMeta;
  accepted: OfferAccepted;
  at: number;
};
export type PendingStore = {
  load: () => Pending[];
  put: (p: Pending) => void;
  drop: (ref: string) => void;
};

export const WAITING_NOTE =
  'Paid. The company has not confirmed it yet, so your signature is kept with the payment and sent as soon as it can be.';

export const acceptAndPay = async (deps: AcceptDeps, a: AcceptInput): Promise<AcceptResult> => {
  const now = deps.now ?? Date.now;
  const { offer, quote } = a;
  const m = offer.manifest;
  if (a.me !== offer.offereeKey) throw new OfferError('This offer is addressed to someone else.');
  if (isExpired(m, now())) throw new OfferError(`This offer lapsed on ${new Date(m.payment.expires).toUTCString()}.`);
  if (quote.amountUsd !== m.payment.amountUsd || usdToSatsCeil(quote.amountUsd, quote.rate) !== quote.sats)
    throw new OfferError('The amount to pay does not match the offer.');
  if (a.alreadyPaid || deps.pending.load().some((p) => p.ref === offer.ref))
    throw new OfferError('You have already paid this offer.');

  // 1 + 2: the signature, before anything is paid.
  const completedHash = docHash(embedSignature(offer.html, 'subscriber', a.pngB64));
  const subscriberSig = await signOfferHash(deps.wallet, offer.ref, 'subscriber', completedHash);

  // 3: where to pay.
  const dest = await deps.destination(quote.sats);

  // 4: one transaction, broadcast now.
  const args = withBroadcastNow({
    description: `Accept offer ${offer.ref}`,
    outputs: [
      ...dest.outputs.map((o) => ({
        lockingScript: o.script,
        satoshis: o.satoshis,
        outputDescription: `Payment for ${offer.ref}`,
      })),
      { lockingScript: offerOpReturnHex(offer.ref, completedHash), satoshis: 0, outputDescription: 'Offer reference' },
    ],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  });
  const r = await deps.wallet.createAction(args);
  if (!r?.txid || !r.tx) throw new OfferError('The wallet did not return a payment, so nothing was paid or signed.');
  const txid = r.txid.toLowerCase();
  const beef = Utils.toHex(r.tx);

  const accepted: OfferAccepted = {
    k: 'bcorp-offer',
    v: 1,
    stage: 'accepted',
    ref: offer.ref,
    sealHash: offer.sealHash,
    completedHash,
    pngB64: a.pngB64,
    subscriberKey: a.me,
    subscriberSig,
    payment: {
      txid,
      sats: quote.sats,
      rate: quote.rate,
      rateAt: quote.rateAt,
      usd: ((quote.sats * quote.rate) / 1e8).toFixed(2),
    },
    at: now(),
  };
  const metadata: SubmitMeta = {
    sender: a.myHandle,
    note: `${offer.ref} · ${satsToBsv(quote.sats)} BSV`,
    offer: {
      identityKey: a.me,
      signature: subscriberSig,
      completedHash,
      rateUsdPerBsv: quote.rate.toFixed(2),
      rateAt: quote.rateAt,
    },
  };
  const pend: Pending = { ref: offer.ref, txid, beef, reference: dest.reference, metadata, accepted, at: now() };

  // Queued (no network verdict yet): keep payment + signature together; retryPending sends them.
  if (resultIsQueued(r as Parameters<typeof resultIsQueued>[0])) {
    deps.pending.put(pend);
    return { state: 'waiting', accepted, note: WAITING_NOTE };
  }
  // 5: hand both to the company server.
  deps.pending.put(pend);
  try {
    await deps.submit({ beef, reference: dest.reference, metadata });
    deps.pending.drop(offer.ref);
    return { state: 'done', accepted };
  } catch {
    return { state: 'waiting', accepted, note: WAITING_NOTE };
  }
};

/** Resubmit any paid-but-unconfirmed acceptances. Returns the refs that went through. */
export const retryPending = async (deps: Pick<AcceptDeps, 'submit' | 'pending'>): Promise<string[]> => {
  const done: string[] = [];
  for (const p of deps.pending.load()) {
    try {
      await deps.submit({ beef: p.beef, reference: p.reference, metadata: p.metadata });
      deps.pending.drop(p.ref);
      done.push(p.ref);
    } catch {
      /* still waiting: kept */
    }
  }
  return done;
};

/** localStorage-backed pending store, per identity. */
export const localPending = (me: string): PendingStore => {
  const key = `bwx.offer.pending.${me}`;
  const read = (): Pending[] => {
    try {
      const v = JSON.parse(localStorage.getItem(key) || '[]') as unknown;
      return Array.isArray(v) ? (v as Pending[]) : [];
    } catch {
      return [];
    }
  };
  const write = (xs: Pending[]) => {
    try {
      localStorage.setItem(key, JSON.stringify(xs));
    } catch {
      /* storage blocked: the payment is on chain with its OP_RETURN; the bMail copy still carries the signature */
    }
  };
  return {
    load: read,
    put: (p) => write([p, ...read().filter((x) => x.ref !== p.ref)]),
    drop: (ref) => write(read().filter((x) => x.ref !== ref)),
  };
};
