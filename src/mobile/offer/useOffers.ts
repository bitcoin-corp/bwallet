import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WalletInterface } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBMail } from '../bmail/useBMail';
import { openMail } from '../bmail/client';
import { isLive } from '../bmail/store';
import { quote, PENNY_POST_USD } from '../bmail/route';
import { fetchPeerBPhone } from '../calls/bphone';
import { usdToSats } from '../money/money';
import { lookupPaymail } from '../names/paymail';
import { OFFERS_ENABLED } from '../storeBuild';
import { resultIsQueued } from '../../services/bigDelayed';
import { acceptAndPay, localPending, retryPending, type AcceptResult } from './accept';
import {
  destination,
  listReceipts,
  registerOffer,
  resolveCompany,
  submit,
  verifyCompany,
  type Company,
  type Receipt,
  type Verification,
} from './company';
import {
  KNOWN_COMPANIES,
  OfferError,
  docHash,
  embedSignature,
  parseManifest,
  sealScriptHex,
  signOfferHash,
  verifyOfferHash,
  type Quote,
} from './offer';
import {
  mergeOffers,
  parseOffer,
  type OfferDraft,
  type OfferPayload,
  type OfferRecord,
  type OfferSealed,
} from './payload';

const f = (u: string, i?: RequestInit) => fetch(u, i);
/** The one company payee phase 1 knows. */
export const COMPANY_PAYMAIL = Object.keys(KNOWN_COMPANIES)[0];

const scanKey = (me: string) => `bwallet.offers.scan.${me}`;
const readScan = (me: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(localStorage.getItem(scanKey(me)) || '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Offers for the active identity, from bMail (sent + received), checked. Who sees what:
 *   director  (a key in the company paymail's directors list): compose; every offer they are on; receipts
 *   company   (the company paymail's own key): drafts to seal; every offer; receipts
 *   offeree   only offers sealed by the company and addressed to their key
 * `visible` is false for everyone else, so the Offers screens never show.
 */
export const useOffers = () => {
  const { apiContext } = useServiceContext();
  const wallet = apiContext.wallet as unknown as WalletInterface;
  const mail = useBMail();
  const { me, state, rate } = mail;

  const [company, setCompany] = useState<Company | null>(null);
  const [companyError, setCompanyError] = useState('');
  useEffect(() => {
    if (!OFFERS_ENABLED) return;
    let live = true;
    resolveCompany(f, COMPANY_PAYMAIL)
      .then((c) => live && setCompany(c))
      .catch((e: Error) => live && setCompanyError(e.message));
    return () => {
      live = false;
    };
  }, []);

  // Unopened letters: look inside for an offer without marking them read (as the Agreements scan does).
  const [scan, setScan] = useState<Record<string, unknown>>({});
  useEffect(() => setScan(me ? readScan(me) : {}), [me]);
  useEffect(() => {
    if (!OFFERS_ENABLED || !me) return;
    const known = readScan(me);
    const todo = state.received
      .filter((r) => !r.opened && !r.erased && isLive(r, state.blocked ?? []) && !(r.id in known))
      .sort((a, b) => b.at - a.at)
      .slice(0, 200);
    if (!todo.length) return;
    let live = true;
    void (async () => {
      for (const r of todo) {
        if (!live) return;
        const sealed = await openMail(wallet, r.env).catch(() => null);
        if (!sealed) continue;
        const next = { ...readScan(me), [r.id]: sealed.offer ?? null };
        try {
          localStorage.setItem(scanKey(me), JSON.stringify(next));
        } catch {
          /* scanned again next time */
        }
        if (live) setScan(next);
      }
    })();
    return () => {
      live = false;
    };
  }, [me, wallet, state.received, state.blocked]);

  const payloads = useMemo(() => {
    const raw = [
      // Received: from anyone, but an offer counts only once its signatures check out (mergeOffers + verifyCompany).
      ...state.received.filter((r) => !r.deleted && !r.spam).map((r) => r.opened?.offer ?? scan[r.id]),
      ...state.sent.map((s) => s.offer),
    ];
    return raw.map(parseOffer).filter((p): p is OfferPayload => !!p);
  }, [state.received, state.sent, scan]);

  const [records, setRecords] = useState<OfferRecord[]>([]);
  useEffect(() => {
    let live = true;
    void mergeOffers(payloads).then((r) => live && setRecords(r));
    return () => {
      live = false;
    };
  }, [payloads]);

  const isDirector = !!company && company.directors.includes(me);
  const isCompany = !!company && company.key === me;
  const verification = useCallback(
    (rec: OfferRecord): Verification =>
      rec.offer
        ? verifyCompany(company, { ...rec.offer, payee: rec.offer.manifest?.payment.payee ?? '' }, rec.checks)
        : { verified: false, reason: 'Not sealed by the company yet.' },
    [company],
  );
  // What this identity may see: offerees only their own, verified, sealed offers.
  const mine = useMemo(
    () =>
      records.filter((r) =>
        isDirector || isCompany ? true : !!r.offer && r.offer.offereeKey === me && verification(r).verified,
      ),
    [records, isDirector, isCompany, me, verification],
  );
  const visible = OFFERS_ENABLED && !!me && (isDirector || isCompany || mine.length > 0);

  const postageFor = useCallback(
    async (key: string) => {
      const card = await fetchPeerBPhone(f, key).catch(() => null);
      const usd = card?.profile.mail?.usd ?? PENNY_POST_USD;
      return quote(usdToSats(usd, rate) ?? 0, 'standard').total;
    },
    [rate],
  );
  const letter = useCallback(
    async (to: string, toLabel: string, subject: string, body: string, offer: OfferPayload) => {
      await mail.send({ to, toLabel, sealed: { subject, body, offer }, sats: await postageFor(to), replyPaidSats: 0 });
    },
    [mail, postageFor],
  );

  /** Director: sign the company field and send the draft to the company account to seal. */
  const sendDraft = useCallback(
    async (a: { html: string; pngB64: string; offereeKey: string; offereeHandle: string }) => {
      if (!company || !isDirector) throw new OfferError('Only a director of the company can do this.');
      const m = parseManifest(a.html);
      const withCompany = embedSignature(a.html, 'company', a.pngB64);
      const sealHash = docHash(withCompany);
      const draft: OfferDraft = {
        k: 'bcorp-offer',
        v: 1,
        stage: 'draft',
        ref: m.documentRef,
        html: withCompany,
        sealHash,
        directorKey: me,
        directorSig: await signOfferHash(wallet, m.documentRef, 'director', sealHash),
        offereeKey: a.offereeKey,
        offereeHandle: a.offereeHandle,
        at: Date.now(),
      };
      await letter(
        company.key,
        company.paymail,
        `To seal: offer ${m.documentRef}`,
        `Offer ${m.documentRef}, signed by the director. Open bMail › Agreements › Offers to seal it and send it.`,
        draft,
      );
      return draft;
    },
    [company, isDirector, me, wallet, letter],
  );

  /** Company account: seal (sign + inscribe hashes and signers), register with the paymail, send to the offeree. */
  const sealAndSend = useCallback(
    async (rec: OfferRecord, step: (s: string) => void) => {
      const d = rec.draft;
      if (!company || !isCompany || !d) throw new OfferError('Only the company account can seal an offer.');
      if (
        !company.directors.includes(d.directorKey) ||
        !(await verifyOfferHash(d.directorKey, d.ref, 'director', d.sealHash, d.directorSig))
      )
        throw new OfferError('The director’s signature does not check out, so this was not sealed.');
      step('Signing as the company…');
      const companySig = await signOfferHash(wallet, d.ref, 'company', d.sealHash);
      step('Sealing on chain…');
      const r = await wallet.createAction({
        description: `Seal offer ${d.ref} (hashes and signers only)`,
        outputs: [
          {
            satoshis: 0,
            lockingScript: sealScriptHex(d.ref, d.sealHash, me, d.directorKey),
            outputDescription: 'Offer seal',
          },
        ],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      });
      if (!r.txid) throw new OfferError('The wallet did not return a transaction, so nothing was sealed.');
      if (resultIsQueued(r as Parameters<typeof resultIsQueued>[0]))
        throw new OfferError(
          'The network has not accepted the seal yet, so the offer was not sent. Try again in a minute.',
        );
      const m = d.manifest ?? parseManifest(d.html);
      step('Registering with the company paymail…');
      await registerOffer(f, wallet, {
        alias: company.alias,
        ref: d.ref,
        amountUsd: m.payment.amountUsd,
        expires: m.payment.expires,
        sealHash: d.sealHash,
        sealTxid: r.txid.toLowerCase(),
        offereeKey: d.offereeKey,
        offereeHandle: d.offereeHandle,
        directorKey: d.directorKey,
        directorHandle: m.signatureFields.find((x) => x.id === 'company')?.signerHandle ?? '',
      });
      const offer: OfferSealed = {
        ...d,
        stage: 'offer',
        companyKey: me,
        companySig,
        sealTxid: r.txid.toLowerCase(),
        at: Date.now(),
      };
      delete (offer as { manifest?: unknown }).manifest;
      step('Sending to the offeree…');
      const body = `${m.documentTitle}\n\nAn offer for you to read. To accept it, sign and pay in bMail › Agreements › Offers. It lapses on ${new Date(m.payment.expires).toUTCString()}.`;
      await letter(
        d.offereeKey,
        d.offereeHandle || d.offereeKey.slice(0, 10),
        `Offer ${d.ref} from ${company.name}`,
        body,
        offer,
      );
      await letter(
        d.directorKey,
        'director',
        `Sealed and sent: offer ${d.ref}`,
        `Offer ${d.ref} is sealed (${offer.sealTxid}) and sent to the offeree.`,
        offer,
      );
      return offer;
    },
    [company, isCompany, me, wallet, letter],
  );

  /** Offeree: sign to pay (accept.ts), then send the acceptance to the company and the director. */
  const accept = useCallback(
    async (rec: OfferRecord, pngB64: string, q: Quote): Promise<AcceptResult> => {
      const o = rec.offer;
      if (!o || !o.manifest || !company) throw new OfferError('This offer is not sealed by the company.');
      if (!verification(rec).verified) throw new OfferError(verification(rec).reason);
      const myHandle = (await lookupPaymail(f, me).catch(() => undefined)) ?? '';
      const paymail = o.manifest.payment.payee;
      const deps = {
        wallet,
        destination: (sats: number) => destination(f, paymail, sats),
        submit: (x: Parameters<typeof submit>[2]) => submit(f, paymail, x),
        pending: localPending(me),
      };
      const res = await acceptAndPay(deps, {
        offer: { ...o, manifest: o.manifest },
        me,
        myHandle,
        pngB64,
        quote: q,
        alreadyPaid: !!rec.accepted,
      });
      const body = `Offer ${o.ref} accepted: signed and paid (${res.accepted.payment.txid}).`;
      // The payment is on chain either way; these letters are the parties' copies for their Documents vault.
      await letter(o.companyKey, company.paymail, `Accepted: offer ${o.ref}`, body, res.accepted).catch(
        () => undefined,
      );
      await letter(o.directorKey, 'director', `Accepted: offer ${o.ref}`, body, res.accepted).catch(() => undefined);
      return res;
    },
    [company, me, wallet, letter, verification],
  );

  // Paid-but-unconfirmed acceptances: try again whenever the screen opens.
  useEffect(() => {
    if (!OFFERS_ENABLED || !me || !company) return;
    void retryPending({ submit: (x) => submit(f, COMPANY_PAYMAIL, x), pending: localPending(me) }).catch(
      () => undefined,
    );
  }, [me, company]);

  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const loadReceipts = useCallback(async () => {
    if (!company || !(isDirector || isCompany)) return;
    setReceipts(await listReceipts(f, wallet, company.alias));
  }, [company, isDirector, isCompany, wallet]);

  return {
    me,
    wallet,
    rate,
    company,
    companyError,
    isDirector,
    isCompany,
    visible,
    records: mine,
    verification,
    sendDraft,
    sealAndSend,
    accept,
    receipts,
    loadReceipts,
    loading: mail.loading,
    error: mail.error,
  };
};
