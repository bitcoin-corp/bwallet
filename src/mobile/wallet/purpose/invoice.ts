import { ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk';
import type { HistoryRow } from '../txHistory';
import { cleanPurpose } from './purpose';

/**
 * Invoices in the main wallet (owner, 23 Oct 2026), v1: local and signed links only, no server.
 *
 * An invoice names the payee's paymail, the payee's identity key, an amount (US cents or sats), what it is for, an
 * optional due date and an id. The payee's wallet signs it with its identity key (BRC-3 style, counterparty
 * 'anyone', protocol 'bwallet invoice'), and the pay link carries invoice + signature. The payer's wallet checks the
 * signature AND that the paymail's published key (paymail pki, the same key the name binding signs) is that key,
 * before it shows "from <paymail>". A changed amount, payee or purpose breaks the signature; a valid signature from
 * someone else's key breaks the pki check. Opening a link never pays: it only pre-fills Send, whose confirm sheet
 * still asks.
 */

export const INVOICE_PROTOCOL: [2, string] = [2, 'bwallet invoice'];
export const INVOICE_KEY_ID = '1';
export const INVOICE_HOST = 'https://web.bwalletx.com';
/** Upper bounds a link is allowed to ask for (a typo guard, not a limit on what people can pay). */
export const MAX_INVOICE_USD_CENTS = 10_000_000; // $100,000
export const MAX_INVOICE_SATS = 2_100_000_000_000_000;

export type Invoice = {
  v: 1;
  /** "INV-" + 8 base32 characters. */
  id: string;
  /** Who gets paid: a paymail (name@domain). */
  payee: string;
  /** The payee's identity key (compressed pubkey hex). */
  key: string;
  /** Exactly one of usdCents / sats. */
  usdCents?: number;
  sats?: number;
  purpose: string;
  /** YYYY-MM-DD, optional. */
  due?: string;
  /** Unix ms. */
  created: number;
};

export type SignedInvoice = { inv: Invoice; sig: string };

const ID_RE = /^INV-[A-Z2-9]{8}$/;
const PAYMAIL_RE = /^[a-z0-9._-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;
const KEY_RE = /^0[23][0-9a-f]{64}$/i;
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const newInvoiceId = (rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))) =>
  `INV-${Array.from(rand(8), (b) => B32[b % B32.length]).join('')}`;

/** The exact bytes that are signed: fixed field order, absent fields as empty. */
export const invoiceMessage = (i: Invoice): string =>
  [
    'bwallet-invoice',
    'v1',
    `id=${i.id}`,
    `payee=${i.payee.toLowerCase()}`,
    `key=${i.key.toLowerCase()}`,
    `usdCents=${i.usdCents ?? ''}`,
    `sats=${i.sats ?? ''}`,
    `purpose=${i.purpose}`,
    `due=${i.due ?? ''}`,
    `created=${i.created}`,
  ].join('\n');

/** Is this a well-formed invoice (before any signature check)? */
export const invoiceShapeOk = (i: unknown): i is Invoice => {
  if (!i || typeof i !== 'object') return false;
  const x = i as Partial<Invoice>;
  if (x.v !== 1 || typeof x.id !== 'string' || !ID_RE.test(x.id)) return false;
  if (typeof x.payee !== 'string' || !PAYMAIL_RE.test(x.payee)) return false;
  if (typeof x.key !== 'string' || !KEY_RE.test(x.key)) return false;
  const hasUsd = x.usdCents !== undefined;
  const hasSats = x.sats !== undefined;
  if (hasUsd === hasSats) return false;
  if (hasUsd && !(Number.isInteger(x.usdCents) && x.usdCents! > 0 && x.usdCents! <= MAX_INVOICE_USD_CENTS))
    return false;
  if (hasSats && !(Number.isInteger(x.sats) && x.sats! > 0 && x.sats! <= MAX_INVOICE_SATS)) return false;
  if (typeof x.purpose !== 'string' || cleanPurpose(x.purpose) !== x.purpose) return false;
  if (x.due !== undefined && (typeof x.due !== 'string' || !DUE_RE.test(x.due))) return false;
  if (typeof x.created !== 'number' || !Number.isFinite(x.created) || x.created <= 0) return false;
  return true;
};

type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

/** Make and sign an invoice with this wallet's identity key. Throws on bad input. */
export const createInvoice = async (
  wallet: Signer,
  f: { payee: string; usdCents?: number; sats?: number; purpose: string; due?: string },
  now = Date.now(),
  id = newInvoiceId(),
): Promise<SignedInvoice> => {
  const { publicKey: key } = await wallet.getPublicKey({ identityKey: true });
  const inv: Invoice = {
    v: 1,
    id,
    payee: f.payee.trim().toLowerCase(),
    key,
    ...(f.usdCents !== undefined ? { usdCents: Math.round(f.usdCents) } : { sats: Math.round(f.sats ?? 0) }),
    purpose: cleanPurpose(f.purpose),
    ...(f.due ? { due: f.due } : {}),
    created: now,
  };
  if (!invoiceShapeOk(inv)) throw new Error('That invoice is not complete: check the amount and your paymail.');
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(invoiceMessage(inv), 'utf8'),
    protocolID: INVOICE_PROTOCOL,
    keyID: INVOICE_KEY_ID,
    counterparty: 'anyone',
  });
  return { inv, sig: Utils.toHex(signature) };
};

const b64url = (s: string) =>
  Utils.toBase64(Utils.toArray(s, 'utf8')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Utils.toUTF8(Utils.toArray(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64'));
};

/** The pay link (opens the web wallet, or the app when it handles the link) and the app scheme twin. */
export const invoiceLink = (s: SignedInvoice): string => `${INVOICE_HOST}/?invoice=${b64url(JSON.stringify(s))}`;
export const invoiceAppLink = (s: SignedInvoice): string => `bwalletx://invoice?d=${b64url(JSON.stringify(s))}`;

/** The signed invoice in a link, or null for anything else. No signature check here (see verifyInvoice). */
export const parseInvoiceLink = (url: string | null | undefined): SignedInvoice | null => {
  if (!url || url.length > 8000) return null;
  try {
    const u = new URL(url.trim());
    let d: string | null = null;
    if (u.protocol === 'bwalletx:' && u.host === 'invoice') d = u.searchParams.get('d');
    else if (u.protocol === 'https:' || u.protocol === 'http:') d = u.searchParams.get('invoice');
    if (!d) return null;
    const v = JSON.parse(unb64url(d)) as Partial<SignedInvoice>;
    if (!v || !invoiceShapeOk(v.inv) || typeof v.sig !== 'string' || !/^[0-9a-f]{16,200}$/i.test(v.sig)) return null;
    return { inv: v.inv, sig: v.sig };
  } catch {
    return null;
  }
};

/** The first invoice link in a piece of text (a bMail letter), or null. Still unverified. */
export const findInvoiceLink = (text: string | null | undefined): { url: string; s: SignedInvoice } | null => {
  for (const m of (text ?? '').matchAll(
    /(?:https:\/\/web\.bwalletx\.com\/\S*[?&]invoice=|bwalletx:\/\/invoice\?d=)[A-Za-z0-9_-]+/g,
  )) {
    const s = parseInvoiceLink(m[0]);
    if (s) return { url: m[0], s };
  }
  return null;
};

/** Signature check alone: the invoice was signed by the key it names, and nothing in it changed. */
export const invoiceSignatureOk = async (s: SignedInvoice): Promise<boolean> => {
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(invoiceMessage(s.inv), 'utf8'),
      signature: Utils.toArray(s.sig, 'hex'),
      protocolID: INVOICE_PROTOCOL,
      keyID: INVOICE_KEY_ID,
      counterparty: s.inv.key,
    });
    return valid;
  } catch {
    return false;
  }
};

export type VerifyResult = { ok: true; inv: Invoice } | { ok: false; reason: string };

/**
 * Full check before the wallet shows "from <paymail>": the signature, then the paymail's published identity key
 * (`lookupKey`, paymail pki) must be the signing key.
 */
export const verifyInvoice = async (
  s: SignedInvoice | null,
  lookupKey: (paymail: string) => Promise<string | undefined>,
): Promise<VerifyResult> => {
  if (!s || !invoiceShapeOk(s.inv)) return { ok: false, reason: 'This is not a valid invoice link.' };
  if (!(await invoiceSignatureOk(s)))
    return { ok: false, reason: 'This invoice was changed or forged. Nothing was filled in.' };
  let published: string | undefined;
  try {
    published = await lookupKey(s.inv.payee);
  } catch {
    published = undefined;
  }
  if (!published) return { ok: false, reason: `Couldn't check who ${s.inv.payee} is right now. Try again later.` };
  if (published.toLowerCase() !== s.inv.key.toLowerCase())
    return { ok: false, reason: `This invoice was not signed by ${s.inv.payee}. Nothing was filled in.` };
  return { ok: true, inv: s.inv };
};

export const invoiceAmountText = (i: Pick<Invoice, 'usdCents' | 'sats'>): string =>
  i.usdCents !== undefined
    ? `$${(i.usdCents / 100).toFixed(2)}`
    : `${((i.sats ?? 0) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} BSV`;

/* ── My invoices (issued by this account) and invoices I paid ───────────────────────────── */

export type InvoiceStatus = 'open' | 'paid' | 'cancelled';
export type IssuedInvoice = SignedInvoice & { status: InvoiceStatus; txid?: string; updated: number };

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const ISSUED = (acct: string) => `bwallet.invoices.issued.${acct}`;
const PAID = (acct: string) => `bwallet.invoices.paid.${acct}`;
const storage = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
const readJson = <T>(s: Store | null, k: string, fallback: T): T => {
  try {
    return (s && (JSON.parse(s.getItem(k) ?? 'null') as T)) || fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (s: Store | null, k: string, v: unknown) => {
  try {
    s?.setItem(k, JSON.stringify(v));
    return !!s;
  } catch {
    return false;
  }
};

export const listIssued = (acct: string | undefined, s: Store | null = storage()): IssuedInvoice[] => {
  if (!acct) return [];
  const v = readJson<unknown>(s, ISSUED(acct), []);
  return (Array.isArray(v) ? v : [])
    .filter((x): x is IssuedInvoice => !!x && invoiceShapeOk((x as IssuedInvoice).inv))
    .sort((a, b) => b.inv.created - a.inv.created);
};

export const saveIssued = (acct: string, s: SignedInvoice, now = Date.now(), st: Store | null = storage()) =>
  writeJson(st, ISSUED(acct), [
    { ...s, status: 'open', updated: now },
    ...listIssued(acct, st).filter((x) => x.inv.id !== s.inv.id),
  ]);

const TXID = /^[0-9a-f]{64}$/i;

/** Mark one of my invoices paid (with the txid that paid it) or cancelled, or open again. */
export const setIssuedStatus = (
  acct: string,
  id: string,
  status: InvoiceStatus,
  txid?: string,
  now = Date.now(),
  st: Store | null = storage(),
): boolean => {
  if (status === 'paid' && (!txid || !TXID.test(txid.trim()))) return false;
  const all = listIssued(acct, st);
  if (!all.some((x) => x.inv.id === id)) return false;
  return writeJson(
    st,
    ISSUED(acct),
    all.map((x) =>
      x.inv.id === id
        ? { ...x, status, txid: status === 'paid' ? txid!.trim().toLowerCase() : undefined, updated: now }
        : x,
    ),
  );
};

export type PaidInvoice = { id: string; payee: string; txid: string; at: number };

/** The payer side: this account paid invoice `id` in `txid` (so the same link shows "already paid"). */
export const notePaidInvoice = (acct: string, p: PaidInvoice, st: Store | null = storage()) =>
  writeJson(st, PAID(acct), [p, ...listPaid(acct, st).filter((x) => x.id !== p.id)].slice(0, 500));

export const listPaid = (acct: string | undefined, st: Store | null = storage()): PaidInvoice[] => {
  if (!acct) return [];
  const v = readJson<unknown>(st, PAID(acct), []);
  return Array.isArray(v) ? v.filter((x): x is PaidInvoice => !!x && typeof (x as PaidInvoice).id === 'string') : [];
};

export const paidBefore = (acct: string | undefined, id: string, st: Store | null = storage()) =>
  listPaid(acct, st).find((p) => p.id === id);

/**
 * An incoming payment in History that looks like it paid this invoice: received after the invoice was made, for the
 * exact sats (BSV invoices), or within 2% of the dollar amount at that day's rate (USD invoices), and not already
 * used by another of my invoices. The payee's wallet can't see the payer's note, so this is a suggestion the owner
 * confirms ("Mark as paid"), never automatic.
 */
export const matchPayment = (
  inv: Invoice,
  rows: Pick<HistoryRow, 'txid' | 'time' | 'direction' | 'amountSats' | 'usdRate'>[],
  used: Set<string> = new Set(),
): string | undefined => {
  const hit = rows
    .filter((r) => r.direction === 'in' && r.amountSats > 0 && r.time >= inv.created && !used.has(r.txid))
    .sort((a, b) => a.time - b.time)
    .find((r) => {
      if (inv.sats !== undefined) return r.amountSats === inv.sats;
      if (!r.usdRate || !inv.usdCents) return false;
      const cents = (r.amountSats / 1e8) * r.usdRate * 100;
      return Math.abs(cents - inv.usdCents) <= inv.usdCents * 0.02;
    });
  return hit?.txid;
};
