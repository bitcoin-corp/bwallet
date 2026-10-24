import {
  KEY_RE,
  OFFER_HTML_MAX,
  REF_RE,
  SIG_PNG_MAX,
  docHash,
  embedSignature,
  parseManifest,
  verifyOfferHash,
  type Manifest,
} from './offer';

/**
 * What an offer letter carries in bMail (Sealed.offer, BRC-2 encrypted like any letter). Three stages:
 *   draft     director → company account: the HTML with the director's signature at the company anchor
 *   offer     company → offeree (copy to the director): sealed by the company key and inscribed on chain
 *   accepted  offeree → company + director: the subscriber's signature PNG, completedHash, payment txid
 * Every party rebuilds the hashes from the HTML; nothing is taken on trust from the letter.
 */
const HEX64 = /^[0-9a-f]{64}$/;
const TXID = HEX64;
const SIG = /^[0-9a-f]{16,200}$/i;

type Base = { k: 'bcorp-offer'; v: 1; ref: string };
export type OfferDraft = Base & {
  stage: 'draft';
  html: string;
  sealHash: string;
  directorKey: string;
  directorSig: string;
  offereeKey: string;
  offereeHandle: string;
  at: number;
};
export type OfferSealed = Omit<OfferDraft, 'stage'> & {
  stage: 'offer';
  companyKey: string;
  companySig: string;
  sealTxid: string;
};
export type OfferPayment = { txid: string; sats: number; rate: number; rateAt: string; usd: string };
export type OfferAccepted = Base & {
  stage: 'accepted';
  sealHash: string;
  completedHash: string;
  pngB64: string;
  subscriberKey: string;
  subscriberSig: string;
  payment: OfferPayment;
  at: number;
};
export type OfferPayload = OfferDraft | OfferSealed | OfferAccepted;

const s = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Parse an untrusted payload. Null unless well formed; for draft/offer the sealHash must match the HTML. */
export const parseOffer = (raw: unknown): (OfferPayload & { manifest?: Manifest }) | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.k !== 'bcorp-offer' || r.v !== 1) return null;
  const ref = s(r.ref, 64);
  if (!ref || !REF_RE.test(ref)) return null;
  const at = n(r.at);
  if (at === null) return null;
  if (r.stage === 'draft' || r.stage === 'offer') {
    const html = s(r.html, OFFER_HTML_MAX + 2 * SIG_PNG_MAX);
    const sealHash = s(r.sealHash, 64);
    const directorKey = s(r.directorKey, 66);
    const directorSig = s(r.directorSig, 200);
    const offereeKey = s(r.offereeKey, 66);
    const offereeHandle = s(r.offereeHandle, 64) ?? '';
    if (!html || !sealHash || !HEX64.test(sealHash) || docHash(html) !== sealHash) return null;
    if (!directorKey || !KEY_RE.test(directorKey) || !directorSig || !SIG.test(directorSig)) return null;
    if (!offereeKey || !KEY_RE.test(offereeKey)) return null;
    let manifest: Manifest;
    try {
      manifest = parseManifest(html);
    } catch {
      return null;
    }
    if (
      manifest.documentRef !== ref ||
      !html.includes('data-sig-img="company"') ||
      html.includes('data-sig-img="subscriber"')
    )
      return null;
    const base = {
      k: 'bcorp-offer' as const,
      v: 1 as const,
      ref,
      html,
      sealHash,
      directorKey,
      directorSig,
      offereeKey,
      offereeHandle,
      at,
    };
    if (r.stage === 'draft') return { ...base, stage: 'draft', manifest };
    const companyKey = s(r.companyKey, 66);
    const companySig = s(r.companySig, 200);
    const sealTxid = s(r.sealTxid, 64);
    if (!companyKey || !KEY_RE.test(companyKey) || !companySig || !SIG.test(companySig)) return null;
    if (!sealTxid || !TXID.test(sealTxid)) return null;
    return { ...base, stage: 'offer', companyKey, companySig, sealTxid, manifest };
  }
  if (r.stage === 'accepted') {
    const sealHash = s(r.sealHash, 64);
    const completedHash = s(r.completedHash, 64);
    const pngB64 = s(r.pngB64, SIG_PNG_MAX);
    const subscriberKey = s(r.subscriberKey, 66);
    const subscriberSig = s(r.subscriberSig, 200);
    const p = (r.payment ?? {}) as Record<string, unknown>;
    const txid = s(p.txid, 64);
    const sats = n(p.sats);
    const rate = n(p.rate);
    const rateAt = s(p.rateAt, 40);
    const usd = s(p.usd, 16);
    if (!sealHash || !HEX64.test(sealHash) || !completedHash || !HEX64.test(completedHash) || !pngB64) return null;
    if (!subscriberKey || !KEY_RE.test(subscriberKey) || !subscriberSig || !SIG.test(subscriberSig)) return null;
    if (!txid || !TXID.test(txid) || !sats || !rate || !rateAt || !usd) return null;
    return {
      k: 'bcorp-offer',
      v: 1,
      stage: 'accepted',
      ref,
      sealHash,
      completedHash,
      pngB64,
      subscriberKey,
      subscriberSig,
      payment: { txid, sats, rate, rateAt, usd },
      at,
    };
  }
  return null;
};

/** One offer as a party sees it: the sealed offer plus the acceptance, each checked. */
export type OfferRecord = {
  ref: string;
  draft?: OfferDraft & { manifest?: Manifest };
  offer?: OfferSealed & { manifest?: Manifest };
  accepted?: OfferAccepted;
  checks: {
    directorSig: boolean;
    companySig: boolean;
    /** The acceptance's completedHash is the offer HTML + its PNG, and the subscriber key signed it. */
    completed: boolean;
  };
};

/** Merge every payload by ref and verify each signature against the HTML (not the letter's claims). */
export const mergeOffers = async (payloads: OfferPayload[]): Promise<OfferRecord[]> => {
  const by = new Map<string, OfferRecord>();
  const get = (ref: string) =>
    by.get(ref) ?? by.set(ref, { ref, checks: { directorSig: false, companySig: false, completed: false } }).get(ref)!;
  for (const p of payloads) {
    const rec = get(p.ref);
    if (p.stage === 'draft' && !rec.draft) rec.draft = p;
    if (p.stage === 'offer' && !rec.offer) rec.offer = p;
    if (p.stage === 'accepted' && !rec.accepted) rec.accepted = p;
  }
  for (const rec of by.values()) {
    const base = rec.offer ?? rec.draft;
    if (base)
      rec.checks.directorSig = await verifyOfferHash(
        base.directorKey,
        rec.ref,
        'director',
        base.sealHash,
        base.directorSig,
      );
    if (rec.offer)
      rec.checks.companySig = await verifyOfferHash(
        rec.offer.companyKey,
        rec.ref,
        'company',
        rec.offer.sealHash,
        rec.offer.companySig,
      );
    if (rec.offer && rec.accepted && rec.accepted.subscriberKey === rec.offer.offereeKey) {
      try {
        const completed = docHash(embedSignature(rec.offer.html, 'subscriber', rec.accepted.pngB64));
        rec.checks.completed =
          completed === rec.accepted.completedHash &&
          rec.accepted.sealHash === rec.offer.sealHash &&
          (await verifyOfferHash(
            rec.accepted.subscriberKey,
            rec.ref,
            'subscriber',
            completed,
            rec.accepted.subscriberSig,
          ));
      } catch {
        rec.checks.completed = false;
      }
    }
  }
  return [...by.values()].sort((a, b) => (b.offer?.at ?? b.draft?.at ?? 0) - (a.offer?.at ?? a.draft?.at ?? 0));
};

export const wocTx = (txid: string) => `https://whatsonchain.com/tx/${txid}`;
