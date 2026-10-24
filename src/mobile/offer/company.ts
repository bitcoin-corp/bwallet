import type { WalletInterface } from '@bsv/sdk';
import { BWALLET_PAYMAIL_API } from '../names/config';
import { signRequest } from '../names/paymail';
import { KEY_RE, KNOWN_COMPANIES, OfferError } from './offer';
import type { OfferSealed } from './payload';

/**
 * The company side of an offer, over our paymail server (site/lib/paymail.js + offerReceipts.js):
 *   resolveCompany   pki for the company paymail: its identity key + registered name, number and directors
 *   destination      P2P outputs for a payment of N sats (a reference the server matches on receipt)
 *   submit           hand the signed payment (BEEF) + the offer metadata to the server, which writes the receipt
 *   registerOffer    the company key registers a sealed offer (so its payment can be matched)
 *   listReceipts     directors read the subscription receipts
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const api = (path: string) => `${BWALLET_PAYMAIL_API}/api/paymail/${path}`;

export type Company = {
  paymail: string;
  alias: string;
  key: string;
  name: string;
  number: string;
  directors: string[];
};

const json = async (r: Response) => {
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new OfferError(typeof j.error === 'string' ? j.error : `The paymail server said ${r.status}.`);
  return j;
};

export const resolveCompany = async (f: Fetch, paymail: string): Promise<Company> => {
  const known = KNOWN_COMPANIES[paymail];
  if (!known) throw new OfferError('Not a company this wallet can verify.');
  if (!BWALLET_PAYMAIL_API) throw new OfferError('Paymail is off in this build.');
  const j = await json(await f(api(`id/${encodeURIComponent(paymail)}`)));
  const key = String(j.pubkey ?? '').toLowerCase();
  const c = (j.company ?? {}) as { name?: unknown; number?: unknown; directors?: unknown };
  if (!KEY_RE.test(key)) throw new OfferError('The company paymail has no identity key.');
  const directors = (Array.isArray(c.directors) ? c.directors : [])
    .map((d) => String(d).toLowerCase())
    .filter((d) => KEY_RE.test(d));
  return { paymail, alias: known.alias, key, name: String(c.name ?? ''), number: String(c.number ?? ''), directors };
};

export type Verification = { verified: boolean; reason: string };

/**
 * "Verified as the company": the server's record for the payee names the registered company and number this
 * wallet expects, the offer's seal is signed by that paymail's own key, and the company field by one of its directors.
 * `sigs` are the results of checking the seal and director signatures against the HTML (payload.mergeOffers).
 */
export const verifyCompany = (
  co: Company | null,
  offer: Pick<OfferSealed, 'companyKey' | 'directorKey'> & { payee: string },
  sigs: { companySig: boolean; directorSig: boolean },
): Verification => {
  const known = KNOWN_COMPANIES[offer.payee];
  if (!known || !co) return { verified: false, reason: 'Could not look up the company paymail.' };
  if (co.name !== known.name || co.number !== known.number)
    return { verified: false, reason: 'The paymail server does not name the registered company.' };
  if (co.key !== offer.companyKey)
    return { verified: false, reason: 'The seal was not made by the company paymail’s key.' };
  if (!sigs.companySig) return { verified: false, reason: 'The company seal does not match this document.' };
  if (!co.directors.includes(offer.directorKey))
    return { verified: false, reason: 'The company field was not signed by a director.' };
  if (!sigs.directorSig) return { verified: false, reason: 'The director’s signature does not match this document.' };
  return { verified: true, reason: '' };
};

export type Destination = { outputs: { script: string; satoshis: number }[]; reference: string };

export const destination = async (f: Fetch, paymail: string, sats: number): Promise<Destination> => {
  const j = await json(
    await f(api(`p2p-destination/${encodeURIComponent(paymail)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ satoshis: sats }),
    }),
  );
  const outputs = Array.isArray(j.outputs) ? (j.outputs as Destination['outputs']) : [];
  const total = outputs.reduce((a, o) => a + Number(o?.satoshis ?? 0), 0);
  if (!outputs.length || total !== sats || outputs.some((o) => !/^[0-9a-f]+$/i.test(String(o.script))))
    throw new OfferError('The company paymail gave a payment destination that does not match the amount.');
  if (typeof j.reference !== 'string' || !j.reference) throw new OfferError('The company paymail gave no reference.');
  return { outputs, reference: j.reference };
};

export type SubmitMeta = {
  sender: string;
  note: string;
  offer: { identityKey: string; signature: string; completedHash: string; rateUsdPerBsv: string; rateAt: string };
};
export const submit = async (
  f: Fetch,
  paymail: string,
  a: { beef: string; reference: string; metadata: SubmitMeta },
) => {
  await json(
    await f(api(`receive-beef/${encodeURIComponent(paymail)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(a),
    }),
  );
};

type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

export const registerOffer = async (f: Fetch, wallet: Signer, fields: Record<string, string>) =>
  json(
    await f(api('offer-register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await signRequest(wallet, 'offer-register', fields)),
    }),
  );

export type Receipt = {
  status: 'received_pending_allotment' | 'received_shortfall' | 'received_after_lapse';
  offerRef: string;
  offeree: { handle: string | null; identityKey: string };
  payment: {
    txid: string;
    usdValue: string;
    bsv: string;
    rateUsdPerBsv: string;
    shortfallUsd: string;
    firstSeen: string;
  };
  checks?: { subscriberSigValid?: boolean };
  allotment: null;
};
export const listReceipts = async (f: Fetch, wallet: Signer, alias: string): Promise<Receipt[]> => {
  const j = await json(
    await f(api('offer-receipts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await signRequest(wallet, 'offer-receipts', { alias })),
    }),
  );
  return Array.isArray(j.receipts) ? (j.receipts as Receipt[]) : [];
};

export const RECEIPT_STATUS_TEXT: Record<Receipt['status'], string> = {
  received_pending_allotment: 'Received, pending allotment',
  received_shortfall: 'Received, short of the amount',
  received_after_lapse: 'Received after the offer lapsed (held)',
};
