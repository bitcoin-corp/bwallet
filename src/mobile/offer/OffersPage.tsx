import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { BadgeCheck, ChevronLeft, FileSignature, ShieldAlert, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { TopNav } from '../../components/TopNav';
import { resolveCallee } from '../calls/peer';
import { SignaturePad } from '../signature/SignaturePad';
import { SIG_H, SIG_W } from '../signature/signature';
import { RECEIPT_STATUS_TEXT } from './company';
import {
  HASH_BASIS,
  OFFER_HTML_MAX,
  QUOTE_MAX_AGE_MS,
  SIG_PNG_MAX,
  atEnd,
  coingeckoRate,
  companyLine,
  embedSignature,
  isExpired,
  makeQuote,
  parseManifest,
  payeeLine,
  satsToBsv,
  type Manifest,
  type Quote,
} from './offer';
import { wocTx, type OfferRecord } from './payload';
import { useOffers } from './useOffers';
import '../bureau/agreements.css';
import './offers.css';

/**
 * bMail › Agreements › Offers (/m/bmail/offers): company offers, accepted by signing to pay. bWalletX only
 * (OFFERS_ENABLED), and shown only to the company's directors, the company account and the named offeree.
 * Styled sheets only: no browser dialogs.
 */
type Offers = ReturnType<typeof useOffers>;
const f = (u: string, i?: RequestInit) => fetch(u, i);

const usd = (v: string | number) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/** The drawn signature (an SVG path in a 1000 × 250 box) as a small black-ink PNG, base64. */
const pathToPngB64 = (path: string): string => {
  for (const scale of [0.4, 0.3, 0.2]) {
    const c = document.createElement('canvas');
    c.width = Math.round(SIG_W * scale);
    c.height = Math.round(SIG_H * scale);
    const g = c.getContext('2d');
    if (!g) break;
    g.scale(scale, scale);
    g.fillStyle = '#111111';
    g.fill(new Path2D(path));
    const b64 = c.toDataURL('image/png').split(',')[1] ?? '';
    if (b64 && b64.length <= SIG_PNG_MAX) return b64;
  }
  throw new Error('That signature is too detailed to attach. Please sign again, a little simpler.');
};

const statusOf = (rec: OfferRecord, me: string): string => {
  if (rec.accepted) return rec.checks.completed ? 'Signed and paid' : 'Paid · signature does not check out';
  if (rec.offer) {
    if (rec.offer.manifest && isExpired(rec.offer.manifest)) return 'Lapsed';
    return rec.offer.offereeKey === me ? 'Waiting for you to accept' : 'Sent · waiting for the offeree';
  }
  return 'Signed by the director · waiting for the company seal';
};

const Verified = ({ ok, reason, payee }: { ok: boolean; reason: string; payee: string }) =>
  ok ? (
    <div className="of-verified">
      <BadgeCheck size={16} aria-hidden="true" /> Verified: {companyLine(payee)}
    </div>
  ) : (
    <div className="of-unverified">
      <ShieldAlert size={16} aria-hidden="true" /> Not verified: {reason}
    </div>
  );

/** The document with a read-to-the-end gate. Scripts never run (sandbox without allow-scripts). */
const ReadGate = ({ html, title, onEnd }: { html: string; title: string; onEnd: () => void }) => {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(1200);
  const check = () => box.current && atEnd(box.current) && onEnd();
  return (
    <div className="ag-paper of-doc" ref={box} onScroll={check}>
      <iframe
        ref={frame}
        className="of-frame"
        title={title}
        sandbox="allow-same-origin"
        srcDoc={html}
        style={{ height: h }}
        onLoad={() => {
          const d = frame.current?.contentDocument?.documentElement;
          if (d) setH(Math.max(400, d.scrollHeight + 24));
          setTimeout(check, 50);
        }}
      />
    </div>
  );
};

/** The one approval sheet: dollar amount large; BSV, sats and rate small; payee and reference; then sign & pay. */
const PaySheet = ({
  m,
  quote,
  pngB64,
  verified,
  busy,
  error,
  onRefresh,
  onConfirm,
  onClose,
}: {
  m: Manifest;
  quote: Quote | null;
  pngB64: string;
  verified: boolean;
  busy: string;
  error: string;
  onRefresh: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) => {
  useBackClose(true, () => !busy && onClose());
  return createPortal(
    <div className="ag-sheet-back" role="presentation" onClick={() => !busy && onClose()}>
      <div
        className="ag-sheet of-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Accept and pay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ag-row">
          <div className="ag-h ag-grow">Accept &amp; pay</div>
          <button type="button" className="ag-icon" aria-label="Close" onClick={onClose} disabled={!!busy}>
            <X size={18} />
          </button>
        </div>
        <div className="of-amount">{usd(m.payment.amountUsd)}</div>
        {quote ? (
          <div className="of-small">
            {satsToBsv(quote.sats)} BSV · {quote.sats.toLocaleString('en-US')} sats
            <br />
            Rate {usd(quote.rate)} per BSV (CoinGecko, {new Date(quote.rateAt).toLocaleTimeString()})
          </div>
        ) : (
          <div className="of-small">Getting the BSV price from CoinGecko…</div>
        )}
        <dl className="of-facts">
          <dt>To</dt>
          <dd>{payeeLine(m.payment.payee)}</dd>
          <dt>Reference</dt>
          <dd className="ag-mono">{m.payment.reference}</dd>
        </dl>
        <div className="of-sigprev">
          <img alt="Your signature" src={`data:image/png;base64,${pngB64}`} />
        </div>
        <p className="ag-fine">
          One step: your signature is added to the offer and signed with your identity key, and the payment carries the
          offer reference and the signed document’s fingerprint. Both go together, or neither does.
        </p>
        {error && <p className="ag-err">{error}</p>}
        {busy ? (
          <p className="ag-note">{busy}</p>
        ) : (
          <>
            <button type="button" className="ag-btn primary ag-full" disabled={!quote || !verified} onClick={onConfirm}>
              Sign &amp; pay {usd(m.payment.amountUsd)}
            </button>
            <button type="button" className="ag-btn ag-full" onClick={onRefresh}>
              Refresh the rate
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};

const VerifyLinks = ({ rec }: { rec: OfferRecord }) => (
  <section className="ag-section">
    <div className="ag-label">Verify</div>
    <ul className="of-links">
      {rec.offer && (
        <li>
          Company seal on chain:{' '}
          <a className="ag-mono" href={wocTx(rec.offer.sealTxid)} target="_blank" rel="noreferrer">
            {rec.offer.sealTxid.slice(0, 10)}… ↗
          </a>
        </li>
      )}
      {rec.accepted && (
        <li>
          Payment:{' '}
          <a className="ag-mono" href={wocTx(rec.accepted.payment.txid)} target="_blank" rel="noreferrer">
            {rec.accepted.payment.txid.slice(0, 10)}… ↗
          </a>
        </li>
      )}
      <li>Director’s signature: {rec.checks.directorSig ? 'checks out' : 'does not check out'}</li>
      {rec.offer && <li>Company seal: {rec.checks.companySig ? 'checks out' : 'does not check out'}</li>}
      {rec.accepted && (
        <li>Subscriber’s signature and fingerprint: {rec.checks.completed ? 'check out' : 'do not check out'}</li>
      )}
    </ul>
    {(rec.offer || rec.draft) && (
      <p className="ag-fine">
        Seal fingerprint <span className="ag-mono">{(rec.offer ?? rec.draft)!.sealHash}</span>
        {rec.accepted && (
          <>
            <br />
            Signed document fingerprint <span className="ag-mono">{rec.accepted.completedHash}</span>
          </>
        )}
        <br />
        {HASH_BASIS}.
      </p>
    )}
  </section>
);

const OfferView = ({ rec, o, onBack }: { rec: OfferRecord; o: Offers; onBack: () => void }) => {
  const base = rec.offer ?? rec.draft!;
  const m = base.manifest ?? parseManifest(base.html);
  const v = o.verification(rec);
  const offeree = rec.offer?.offereeKey === o.me;
  const [read, setRead] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [png, setPng] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const lapsed = isExpired(m);
  // The vault copy: once accepted (and checked), the document with both signatures.
  const html = useMemo(() => {
    if (rec.offer && rec.accepted && rec.checks.completed) {
      try {
        return embedSignature(rec.offer.html, 'subscriber', rec.accepted.pngB64);
      } catch {
        /* shown unsigned */
      }
    }
    return base.html;
  }, [base.html, rec]);

  const fetchQuote = async () => {
    setQuote(null);
    setErr('');
    try {
      setQuote(makeQuote(m.payment.amountUsd, await coingeckoRate()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not get the BSV price.');
    }
  };
  const confirm = async () => {
    if (!quote) return;
    if (Date.now() - Date.parse(quote.rateAt) > QUOTE_MAX_AGE_MS) {
      setErr('The rate was more than two minutes old, so it has been refreshed. Check the amount and tap again.');
      return void fetchQuote();
    }
    setErr('');
    setBusy('Signing and paying…');
    try {
      const r = await o.accept(rec, png, quote);
      setPng('');
      setNote(
        r.state === 'done'
          ? 'Accepted: signed and paid. Copies are in your Documents vault and the company’s.'
          : (r.note ?? ''),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not go through. Nothing was paid.');
    } finally {
      setBusy('');
    }
  };
  const seal = async () => {
    setErr('');
    try {
      await o.sealAndSend(rec, setBusy);
      setNote('Sealed on chain and sent to the offeree by bMail.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not seal it.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="ag-detail">
      <div className="ag-bar">
        <button type="button" className="ag-btn ag-back" onClick={onBack} disabled={!!busy}>
          <ChevronLeft size={16} aria-hidden="true" /> Back
        </button>
        <div className="ag-grow ag-headtext">
          <div className="ag-h">{m.documentTitle}</div>
          <div className="ag-sub">
            {statusOf(rec, o.me)} · {m.documentRef}
          </div>
        </div>
      </div>
      {rec.offer && <Verified ok={v.verified} reason={v.reason} payee={m.payment.payee} />}
      <dl className="of-facts of-request">
        <dt>Payment request</dt>
        <dd>
          {usd(m.payment.amountUsd)} to {payeeLine(m.payment.payee)}
        </dd>
        <dt>Reference</dt>
        <dd className="ag-mono">{m.payment.reference}</dd>
        <dt>{lapsed ? 'Lapsed' : 'Open until'}</dt>
        <dd>{day(m.payment.expires)}</dd>
      </dl>
      {busy && <p className="ag-note">{busy}</p>}
      {err && !drawing && !png && <p className="ag-err">{err}</p>}
      {note && <p className="ag-note">{note}</p>}
      <ReadGate html={html} title={m.documentTitle} onEnd={() => setRead(true)} />
      {offeree && !rec.accepted && !note && (
        <div className="of-accept">
          {lapsed ? (
            <p className="ag-fine">This offer has lapsed and can no longer be accepted.</p>
          ) : (
            <>
              {!read && <p className="ag-fine">Read to the end to accept.</p>}
              <button
                type="button"
                className="ag-btn primary ag-full"
                disabled={!read || !v.verified || !!busy}
                onClick={() => setDrawing(true)}
              >
                Accept &amp; pay
              </button>
            </>
          )}
        </div>
      )}
      {o.isCompany && rec.draft && !rec.offer && (
        <div className="of-accept">
          <p className="ag-fine">
            Director’s signature: {rec.checks.directorSig ? 'checks out' : 'does not check out'}. Sealing signs the
            document as the company, writes its fingerprint and the signers’ keys on chain (never the document),
            registers the payment reference with the company paymail and sends the offer to the offeree by bMail.
          </p>
          <button
            type="button"
            className="ag-btn primary ag-full"
            disabled={!rec.checks.directorSig || !!busy}
            onClick={() => void seal()}
          >
            Seal &amp; send
          </button>
        </div>
      )}
      <VerifyLinks rec={rec} />
      {drawing && (
        <SignaturePad
          onCancel={() => setDrawing(false)}
          onSave={(p) => {
            setDrawing(false);
            try {
              setPng(pathToPngB64(p));
              void fetchQuote();
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'Could not use that signature.');
            }
          }}
        />
      )}
      {png && (
        <PaySheet
          m={m}
          quote={quote}
          pngB64={png}
          verified={v.verified}
          busy={busy}
          error={err}
          onRefresh={() => void fetchQuote()}
          onConfirm={() => void confirm()}
          onClose={() => {
            setPng('');
            setErr('');
          }}
        />
      )}
    </div>
  );
};

const Compose = ({ o, onDone }: { o: Offers; onDone: () => void }) => {
  const [html, setHtml] = useState('');
  const [m, setM] = useState<Manifest | null>(null);
  const [to, setTo] = useState('');
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const send = async (path: string) => {
    setErr('');
    try {
      setBusy('Looking up the offeree…');
      const peer = await resolveCallee(f, to.trim());
      setBusy('Signing as director and sending to the company account…');
      await o.sendDraft({
        html,
        pngB64: pathToPngB64(path),
        offereeKey: peer.key,
        offereeHandle: to.trim().replace(/^\$/, ''),
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send it.');
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="ag-detail">
      <div className="ag-bar">
        <button type="button" className="ag-btn ag-back" onClick={onDone} disabled={!!busy}>
          <ChevronLeft size={16} aria-hidden="true" /> Back
        </button>
        <div className="ag-h ag-grow">New company offer</div>
      </div>
      {err && <p className="ag-err">{err}</p>}
      {busy && <p className="ag-note">{busy}</p>}
      <label className="ag-chip">
        Choose the offer document (HTML with a signing manifest)
        <input
          type="file"
          hidden
          accept="text/html"
          onChange={(e) => {
            const fl = e.target.files?.[0];
            if (!fl) return;
            setErr('');
            void fl.text().then((t) => {
              try {
                if (t.length > OFFER_HTML_MAX)
                  throw new Error('This document is too large to send by bMail (about 24 KB at most).');
                const mm = parseManifest(t);
                setHtml(t);
                setM(mm);
                const sub = mm.signatureFields.find((x) => x.id === 'subscriber');
                if (sub?.signerHandle && !sub.signerHandle.startsWith('<')) setTo(`$${sub.signerHandle}`);
              } catch (x) {
                setHtml('');
                setM(null);
                setErr(x instanceof Error ? x.message : 'Could not read that document.');
              }
            });
          }}
        />
      </label>
      {m && (
        <>
          <dl className="of-facts of-request">
            <dt>Document</dt>
            <dd>{m.documentTitle}</dd>
            <dt>Reference</dt>
            <dd className="ag-mono">{m.documentRef}</dd>
            <dt>Payment request</dt>
            <dd>
              {usd(m.payment.amountUsd)} to {payeeLine(m.payment.payee)}
            </dd>
            <dt>Open until</dt>
            <dd>{day(m.payment.expires)}</dd>
          </dl>
          <label className="ag-field">
            <span>Offeree</span>
            <input className="ag-input" placeholder="$handle" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            type="button"
            className="ag-btn primary ag-full"
            disabled={!to.trim() || !!busy}
            onClick={() => setDrawing(true)}
          >
            Sign as director
          </button>
          <p className="ag-fine">
            Your signature goes in the company field and is signed with your identity key. The draft then goes by bMail
            to the company account, which seals it on chain and sends it to the offeree. Only the offeree sees it.
          </p>
        </>
      )}
      {drawing && (
        <SignaturePad
          onCancel={() => setDrawing(false)}
          onSave={(p) => {
            setDrawing(false);
            void send(p);
          }}
        />
      )}
    </div>
  );
};

const Receipts = ({ o }: { o: Offers }) => {
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const load = () => {
    setErr('');
    setLoading(true);
    o.loadReceipts()
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [o.company?.alias, o.isDirector, o.isCompany]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="ag-section">
      <div className="ag-row">
        <div className="ag-label ag-grow">Payments received</div>
        <button type="button" className="ag-chip" onClick={load} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      {err && <p className="ag-err">{err}</p>}
      {o.receipts?.length === 0 && <p className="ag-fine">None yet.</p>}
      {(o.receipts ?? []).map((r) => (
        <div key={r.payment.txid} className="of-receipt">
          <div className="ag-grow">
            <div className="ag-pname">
              {r.offerRef} · {usd(r.payment.usdValue)}
            </div>
            <div className="ag-fine">
              {RECEIPT_STATUS_TEXT[r.status]}
              {r.status === 'received_shortfall' ? ` (short ${usd(r.payment.shortfallUsd)})` : ''} ·{' '}
              {r.checks?.subscriberSigValid ? 'signature checks out' : 'signature does not check out'} · allotment: not
              made
            </div>
          </div>
          <a className="ag-mono" href={wocTx(r.payment.txid)} target="_blank" rel="noreferrer">
            {r.payment.txid.slice(0, 8)}… ↗
          </a>
        </div>
      ))}
      <p className="ag-fine">Nothing is allotted or issued here. Allotment is a board decision, recorded separately.</p>
    </section>
  );
};

const OffersPage = () => {
  const navigate = useNavigate();
  const o = useOffers();
  const [sel, setSel] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  useBackClose(!!sel || composing, () => {
    setSel(null);
    setComposing(false);
  });
  const active = o.records.find((r) => r.ref === sel) ?? null;
  const pane = composing ? 'compose' : active ? 'detail' : 'list';

  return (
    <div className={`ag ag-pane-${pane} of`}>
      <TopNav />
      <header className="ag-top">
        <button type="button" className="ag-btn ag-back" onClick={() => navigate('/m/bmail/agreements')}>
          <ChevronLeft size={16} aria-hidden="true" /> Agreements
        </button>
        <h1 className="ag-title">Offers</h1>
        <span className="ag-grow" />
        {o.isDirector && (
          <button type="button" className="ag-btn primary" onClick={() => setComposing(true)}>
            New offer
          </button>
        )}
      </header>
      <div className="of-body">
        {composing ? (
          <Compose o={o} onDone={() => setComposing(false)} />
        ) : active ? (
          <OfferView key={active.ref} rec={active} o={o} onBack={() => setSel(null)} />
        ) : !o.visible ? (
          <p className="ag-note ag-empty-list">{o.loading ? 'Checking your mail…' : 'Nothing here.'}</p>
        ) : (
          <div className="of-list">
            {o.records.length === 0 && <p className="ag-note">No offers yet.</p>}
            {o.records.map((r) => {
              const base = r.offer ?? r.draft;
              const title = base?.manifest?.documentTitle ?? r.ref;
              return (
                <button key={r.ref} type="button" className="ag-item of-item" onClick={() => setSel(r.ref)}>
                  <FileSignature size={16} aria-hidden="true" />
                  <span className="ag-item-main">
                    <span className="ag-item-title">{title}</span>
                    <span className="ag-item-sub">
                      {statusOf(r, o.me)} · {r.ref}
                    </span>
                  </span>
                </button>
              );
            })}
            {(o.isDirector || o.isCompany) && <Receipts o={o} />}
          </div>
        )}
      </div>
    </div>
  );
};

export default OffersPage;
