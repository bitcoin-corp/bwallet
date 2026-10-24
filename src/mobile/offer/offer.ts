import { Hash, ProtoWallet, Script, Utils, type WalletInterface } from '@bsv/sdk';

/**
 * Company-sealed offers, accepted by signing to pay (phase 1). Pure: no network, no React.
 *
 * The offer document is HTML carrying an NDS manifest (`<script type="application/npg-sig-manifest+json">`) and two
 * anchors, `data-sig-anchor="company"` and `data-sig-anchor="subscriber"`. Signatures are PNG images inserted at
 * the anchors by a fixed string rule (embedSignature), so every party computes the same bytes:
 *
 *   sealHash      = sha256(UTF-8 of the HTML with only the company field filled)
 *   completedHash = sha256(UTF-8 of the HTML with both fields filled)
 *
 * Phase 1 hashes the HTML, not a rendered PDF (a PDF render is not reproducible across devices); the hash basis is
 * recorded as HASH_BASIS wherever a hash is shown.
 *
 * Identity-key signatures: protocol [2,'bcorp offer'], keyID = the offer reference, counterparty 'anyone', over
 * sigRecord(ref, role, hash). The same string is checked by the paymail server (site/lib/offerReceipts.js).
 *
 * Generic code: the only company named here is the payee the wallet can show as verified (its registered name and
 * number are public). Offerees, amounts and keys come from the offer itself at run time.
 */
export const OFFER_SIG_PROTOCOL: [2, string] = [2, 'bcorp offer'];
export const OFFER_TAG = 'bcorp-offer';
export const SEAL_TAG = 'bcorp-offer-seal';
export const HASH_BASIS = 'sha-256 over the offer HTML (UTF-8) with signature images at the anchors';
export const MANIFEST_TYPE = 'application/npg-sig-manifest+json';

/** Company payees the wallet can show as verified, with the registered name and number it must see from the server. */
export const KNOWN_COMPANIES: Readonly<Record<string, { alias: string; name: string; number: string }>> = {
  'bcorp@bwalletx.com': { alias: 'bcorp', name: 'The Bitcoin Corporation Ltd', number: '16735102' },
};
export const payeeLine = (paymail: string) => {
  const c = KNOWN_COMPANIES[paymail];
  return c ? `${c.name} — ${paymail}` : paymail;
};
export const companyLine = (paymail: string) => {
  const c = KNOWN_COMPANIES[paymail];
  return c ? `${c.name} · ${c.number}` : paymail;
};

export const REF_RE = /^[A-Z0-9][A-Z0-9-]{3,63}$/;
const USD_RE = /^\d{1,9}(\.\d{1,2})?$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const KEY_RE = /^0[23][0-9a-f]{64}$/;
/** Largest offer HTML that still fits a bMail envelope with its signatures (bMail envelope + postage stay under the relay’s 64 KB). */
export const OFFER_HTML_MAX = 24_000;
/** A signature PNG (base64) must stay small: it travels inside the envelope. */
export const SIG_PNG_MAX = 6_000;

export type SignatureField = {
  id: string;
  role?: string;
  name?: string;
  capacity?: string;
  party: 'company' | 'subscriber';
  signerHandle?: string;
  sealHandle?: string;
  required?: boolean;
  order?: number;
  method?: string;
  bindsPayment?: boolean;
};
export type PaymentRequest = {
  payee: string;
  amountUsd: string;
  rateSource: string;
  rateAt: string;
  reference: string;
  expires: string;
  opReturn: string[];
};
export type Manifest = {
  nds: string;
  documentTitle: string;
  documentRef: string;
  payment: PaymentRequest;
  signatureFields: SignatureField[];
};

export class OfferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfferError';
  }
}

const sha256Hex = (s: string) => Utils.toHex(Hash.sha256(Utils.toArray(s, 'utf8')));

/** Read and check the NDS manifest. Throws OfferError with a plain reason. */
export const parseManifest = (html: string): Manifest => {
  const m = html.match(/<script[^>]*type=["']application\/npg-sig-manifest\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new OfferError('This document has no signing manifest.');
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    throw new OfferError('The signing manifest is not valid JSON.');
  }
  const ref = String(j.documentRef ?? '');
  if (!REF_RE.test(ref)) throw new OfferError('The offer reference is missing or malformed.');
  const p = (j.payment ?? {}) as Record<string, unknown>;
  const payment: PaymentRequest = {
    payee: String(p.payee ?? '').toLowerCase(),
    amountUsd: String(p.amountUsd ?? ''),
    rateSource: String(p.rateSource ?? ''),
    rateAt: String(p.rateAt ?? ''),
    reference: String(p.reference ?? ''),
    expires: String(p.expires ?? ''),
    opReturn: Array.isArray(p.opReturn) ? p.opReturn.map(String) : [],
  };
  if (!KNOWN_COMPANIES[payment.payee]) throw new OfferError('The payee is not a company this wallet can verify.');
  if (!USD_RE.test(payment.amountUsd) || Number(payment.amountUsd) <= 0)
    throw new OfferError('The amount in the offer is not a dollar amount.');
  if (payment.reference !== ref) throw new OfferError('The payment reference does not match the offer reference.');
  if (!Number.isFinite(Date.parse(payment.expires))) throw new OfferError('The offer has no valid expiry date.');
  if (payment.opReturn[0] !== OFFER_TAG) throw new OfferError('The offer does not use the bcorp-offer payment format.');
  const fields = (Array.isArray(j.signatureFields) ? j.signatureFields : []) as SignatureField[];
  const company = fields.find((f) => f?.id === 'company' && f.party === 'company');
  const subscriber = fields.find((f) => f?.id === 'subscriber' && f.party === 'subscriber');
  if (!company || !subscriber) throw new OfferError('The offer needs a company and a subscriber signature field.');
  if (subscriber.bindsPayment !== true) throw new OfferError('The subscriber signature must be bound to the payment.');
  for (const id of ['company', 'subscriber'])
    if (anchorCount(html, id) !== 1) throw new OfferError(`The document needs exactly one “${id}” signature anchor.`);
  return {
    nds: String(j.nds ?? ''),
    documentTitle: String(j.documentTitle ?? ref).slice(0, 160),
    documentRef: ref,
    payment,
    signatureFields: fields,
  };
};

const anchorRe = (id: string) => new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bdata-sig-anchor=(["'])${id}\\2[^>]*>`, 'g');
const anchorCount = (html: string, id: string) => (html.match(anchorRe(id)) ?? []).length;

/** The exact tag inserted at an anchor (part of the hashed bytes: never change it without a version bump). */
export const sigImgTag = (id: string, pngB64: string) =>
  `<img data-sig-img="${id}" alt="Signature" style="max-height:64px;max-width:100%" src="data:image/png;base64,${pngB64}">`;

/** Insert a signature PNG right after the anchor's opening tag. Exactly one anchor, never signed twice. */
export const embedSignature = (html: string, id: 'company' | 'subscriber', pngB64: string): string => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pngB64) || pngB64.length > SIG_PNG_MAX)
    throw new OfferError('The signature image is missing or too large.');
  if (html.includes(`data-sig-img="${id}"`)) throw new OfferError(`The ${id} field is already signed.`);
  const re = anchorRe(id);
  const m = [...html.matchAll(re)];
  if (m.length !== 1 || m[0].index === undefined) throw new OfferError(`The document has no single “${id}” anchor.`);
  const end = m[0].index + m[0][0].length;
  return html.slice(0, end) + sigImgTag(id, pngB64) + html.slice(end);
};

export const docHash = (html: string) => sha256Hex(html);

/** The text an identity key signs for one role. Same string on the server (site/lib/offerReceipts.js sigRecord). */
export const sigRecord = (ref: string, role: 'company' | 'director' | 'subscriber', hash: string) =>
  `bcorp-offer|v1|ref=${ref}|role=${role}|hash=${hash}`;

export const signOfferHash = async (
  wallet: Pick<WalletInterface, 'createSignature'>,
  ref: string,
  role: 'company' | 'director' | 'subscriber',
  hash: string,
): Promise<string> => {
  if (!HEX64.test(hash)) throw new OfferError('Bad document hash.');
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(sigRecord(ref, role, hash), 'utf8'),
    protocolID: OFFER_SIG_PROTOCOL,
    keyID: ref,
    counterparty: 'anyone',
  });
  return Utils.toHex(signature);
};

export const verifyOfferHash = async (
  key: string,
  ref: string,
  role: 'company' | 'director' | 'subscriber',
  hash: string,
  sig: string,
): Promise<boolean> => {
  if (!KEY_RE.test(key) || !/^[0-9a-f]{16,200}$/i.test(sig)) return false;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(sigRecord(ref, role, hash), 'utf8'),
      signature: Utils.toArray(sig, 'hex'),
      protocolID: OFFER_SIG_PROTOCOL,
      keyID: ref,
      counterparty: key,
    });
    return valid === true;
  } catch {
    return false;
  }
};

const pushes = (items: string[]) => {
  const s = new Script().writeOpCode(0).writeOpCode(0x6a);
  for (const it of items) s.writeBin(Utils.toArray(it, 'utf8'));
  return s.toHex();
};

/** Payment OP_RETURN: OP_FALSE OP_RETURN "bcorp-offer" <ref> <completedHash hex>, each a UTF-8 push. */
export const offerOpReturnHex = (ref: string, completedHash: string): string => {
  if (!REF_RE.test(ref) || !HEX64.test(completedHash)) throw new OfferError('Bad offer reference or hash.');
  return pushes([OFFER_TAG, ref, completedHash]);
};

/** Seal inscription: hash + signers only. OP_FALSE OP_RETURN "bcorp-offer-seal" <ref> <sealHash> <companyKey> <directorKey>. */
export const sealScriptHex = (ref: string, sealHash: string, companyKey: string, directorKey: string): string => {
  if (!REF_RE.test(ref) || !HEX64.test(sealHash) || !KEY_RE.test(companyKey) || !KEY_RE.test(directorKey))
    throw new OfferError('Bad seal fields.');
  return pushes([SEAL_TAG, ref, sealHash, companyKey, directorKey]);
};

// ── money ──

/** USD → whole satoshis at `rate` USD/BSV, rounded UP so the payment is never a cent short. */
export const usdToSatsCeil = (amountUsd: string, rate: number): number => {
  if (!USD_RE.test(amountUsd) || !Number.isFinite(rate) || rate <= 0) throw new OfferError('Bad amount or rate.');
  const [w, f = ''] = amountUsd.split('.');
  const cents = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return Math.ceil((cents * 1e6) / rate);
};
export const satsToBsv = (sats: number) => (sats / 1e8).toFixed(8);

export type Quote = { amountUsd: string; rate: number; rateAt: string; sats: number };
export const makeQuote = (amountUsd: string, rate: number, at = Date.now()): Quote => ({
  amountUsd,
  rate,
  rateAt: new Date(at).toISOString(),
  sats: usdToSatsCeil(amountUsd, rate),
});
/** A quote older than this is refreshed before paying. */
export const QUOTE_MAX_AGE_MS = 2 * 60_000;

export const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=usd';
export const coingeckoRate = async (f: typeof fetch = fetch): Promise<number> => {
  const r = await f(COINGECKO_URL);
  const j = (r.ok ? await r.json() : null) as { 'bitcoin-cash-sv'?: { usd?: unknown } } | null;
  const v = Number(j?.['bitcoin-cash-sv']?.usd);
  if (!Number.isFinite(v) || v <= 0) throw new OfferError('Could not get the BSV price from CoinGecko. Try again.');
  return v;
};

export const isExpired = (m: Pick<Manifest, 'payment'>, now = Date.now()) => now > Date.parse(m.payment.expires);

// ── scroll gate ──

export type ScrollBox = { scrollTop: number; clientHeight: number; scrollHeight: number };
/** True once the reader is within `slack` px of the end (a document shorter than the box counts as read). */
export const atEnd = (b: ScrollBox, slack = 8) => b.scrollTop + b.clientHeight >= b.scrollHeight - slack;
