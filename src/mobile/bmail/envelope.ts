/**
 * bMail envelope (docs/BMAIL.md, basic version, 9 Oct 2026): the JSON that travels through the message box.
 *
 * Outside (readable by the relay): who, when, the postage claim and its payment.
 * Inside (`sealed`): subject + body, BRC-2 encrypted to the recipient's identity key with
 * protocolID [2,'bmail'] and keyID = the message id. Only the two parties can open it.
 *
 * Postage is a normal BRC-29 wallet payment to the recipient, made in the same send; the envelope carries the
 * txid and the Atomic BEEF so the recipient can check the output before ranking (verify.ts).
 *
 * TODO(bmail pay-to-open): `postage.mode = 'escrow'` with a 2-of-2 + nLockTime refund (BMAIL.md §5.3).
 * TODO(bmail receipts): signed on-chain open receipts spending the stamp (BMAIL.md §5.2).
 */

export const BMAIL_BOX = 'bmail';
export const BMAIL_PROTOCOL: [2, string] = [2, 'bmail'];
/** BRC-29 payment protocol id. */
export const BRC29_PROTOCOL: [2, string] = [2, '3241645161d8'];
export const SUBJECT_MAX = 120;
export const BODY_MAX = 10_000;
const KEY_RE = /^0[23][0-9a-f]{64}$/i;
const HEX_RE = /^[0-9a-f]*$/i;
const TXID_RE = /^[0-9a-f]{64}$/i;

export type Postage = {
  txid: string;
  /** Total sats paid to the recipient in the output (stamp + any reply-paid credit). */
  sats: number;
  outputIndex: number;
  /** Atomic BEEF (hex) of the payment tx. */
  beef: string;
  derivationPrefix: string;
  derivationSuffix: string;
};

export type Envelope = {
  t: 'bmail';
  v: 1;
  id: string;
  from: string;
  to: string;
  /** Unix ms, as claimed by the sender. */
  at: number;
  /** base64 BRC-2 ciphertext of `Sealed`. */
  sealed: string;
  postage?: Postage;
  /** Part of `postage.sats` the sender prepaid so the reply costs the recipient nothing. */
  replyPaidSats?: number;
  /** Message this one answers. */
  inReplyTo?: string;
  /** This reply uses the reply-paid credit of `inReplyTo` (sent with no postage of its own). */
  usesReplyCredit?: boolean;
  // TODO(bmail pay-to-open): escrow?: { lockScript, refundAfter }
};

export type Sealed = {
  subject: string;
  body: string;
  /**
   * Bureau agreement part (src/mobile/bureau/agreement.ts parses and checks it). Opaque here so bMail stays
   * independent of the Bureau; older clients drop it and still read subject + body, which always say what it is.
   */
  agreement?: unknown;
  /**
   * An NFT sent to this identity key (send to a public key, 24 Oct 2026): the transfer txid and sendOrdinals'
   * BRC-29 delivery details, so the recipient's wallet can derive the key and internalize the output.
   */
  ordinal?: SealedOrdinal;
  /**
   * Company offer (src/mobile/offer/payload.ts parses and checks it): draft, sealed offer or acceptance. Opaque here,
   * like `agreement`; the subject + body always say what it is for older clients.
   */
  offer?: unknown;
};
/** `tags`: the NFT's own ordinal tags (type:, origin:, …) so it lists properly in the recipient's NFTs. */
export type SealedOrdinal = { txid: string; deliveries: unknown[]; name?: string; tags?: string[] };
const ordinalOk = (o: unknown): o is SealedOrdinal =>
  !!o &&
  typeof o === 'object' &&
  typeof (o as SealedOrdinal).txid === 'string' &&
  Array.isArray((o as SealedOrdinal).deliveries) &&
  JSON.stringify(o).length <= 4000;
/** The agreement part's JSON may use at most this many characters (the whole envelope must stay under 64 000). */
export const AGREEMENT_JSON_MAX = 40_000;

export const newMessageId = (rand: (n: number) => Uint8Array = defaultRand): string =>
  [...rand(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
const defaultRand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** The offer payload's JSON may use at most this many characters (offer HTML ≤ 24 000 + signatures). */
export const OFFER_JSON_MAX = 40_000;
const offerOk = (o: unknown) => !!o && typeof o === 'object' && JSON.stringify(o).length <= OFFER_JSON_MAX;

const agreementOk = (a: unknown) => !!a && typeof a === 'object' && JSON.stringify(a).length <= AGREEMENT_JSON_MAX;

export const sealedToBytes = (s: Sealed): number[] => {
  if (s.agreement !== undefined && !agreementOk(s.agreement)) throw new Error('This document is too large to send.');
  if (s.offer !== undefined && !offerOk(s.offer)) throw new Error('This offer is too large to send.');
  return [
    ...new TextEncoder().encode(
      JSON.stringify({
        subject: s.subject.slice(0, SUBJECT_MAX),
        body: s.body.slice(0, BODY_MAX),
        ...(s.agreement !== undefined ? { agreement: s.agreement } : {}),
        ...(ordinalOk(s.ordinal) ? { ordinal: s.ordinal } : {}),
        ...(s.offer !== undefined ? { offer: s.offer } : {}),
      }),
    ),
  ];
};
export const bytesToSealed = (b: number[] | Uint8Array): Sealed => {
  const j = JSON.parse(new TextDecoder().decode(new Uint8Array(b))) as Partial<Sealed>;
  const out: Sealed = {
    subject: typeof j.subject === 'string' ? j.subject.slice(0, SUBJECT_MAX) : '',
    body: typeof j.body === 'string' ? j.body.slice(0, BODY_MAX) : '',
  };
  if (agreementOk(j.agreement)) out.agreement = j.agreement;
  if (ordinalOk(j.ordinal)) out.ordinal = j.ordinal;
  if (offerOk(j.offer)) out.offer = j.offer;
  return out;
};

export const encodeEnvelope = (e: Envelope): string => JSON.stringify(e);

const nat = (x: unknown): number | null => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null);

export const parsePostage = (raw: unknown): Postage | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const sats = nat(r.sats);
  const outputIndex = nat(r.outputIndex);
  if (
    typeof r.txid !== 'string' ||
    !TXID_RE.test(r.txid) ||
    sats === null ||
    sats === 0 ||
    outputIndex === null ||
    typeof r.beef !== 'string' ||
    !HEX_RE.test(r.beef) ||
    typeof r.derivationPrefix !== 'string' ||
    typeof r.derivationSuffix !== 'string' ||
    r.derivationPrefix.length > 200 ||
    r.derivationSuffix.length > 200
  )
    return undefined;
  return {
    txid: r.txid.toLowerCase(),
    sats,
    outputIndex,
    beef: r.beef,
    derivationPrefix: r.derivationPrefix,
    derivationSuffix: r.derivationSuffix,
  };
};

/** Parse whatever the relay handed us (string or already-parsed object). Null for anything that is not bMail. */
export const decodeEnvelope = (raw: unknown): Envelope | null => {
  let j: unknown = raw;
  if (typeof raw === 'string') {
    try {
      j = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!j || typeof j !== 'object') return null;
  const r = j as Record<string, unknown>;
  if (r.t !== 'bmail' || r.v !== 1) return null;
  if (typeof r.id !== 'string' || !/^[0-9a-f]{8,64}$/i.test(r.id)) return null;
  if (typeof r.from !== 'string' || !KEY_RE.test(r.from)) return null;
  if (typeof r.to !== 'string' || !KEY_RE.test(r.to)) return null;
  if (typeof r.sealed !== 'string' || !r.sealed || r.sealed.length > 64_000) return null;
  const at = nat(r.at);
  if (at === null) return null;
  const postage = parsePostage(r.postage);
  const replyPaid = nat(r.replyPaidSats);
  const e: Envelope = {
    t: 'bmail',
    v: 1,
    id: r.id.toLowerCase(),
    from: r.from.toLowerCase(),
    to: r.to.toLowerCase(),
    at,
    sealed: r.sealed,
  };
  if (postage) e.postage = postage;
  if (postage && replyPaid && replyPaid <= postage.sats) e.replyPaidSats = replyPaid;
  if (typeof r.inReplyTo === 'string' && /^[0-9a-f]{8,64}$/i.test(r.inReplyTo)) e.inReplyTo = r.inReplyTo.toLowerCase();
  if (r.usesReplyCredit === true && e.inReplyTo) e.usesReplyCredit = true;
  return e;
};
