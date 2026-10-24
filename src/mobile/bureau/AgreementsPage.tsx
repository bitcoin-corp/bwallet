import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Archive, ChevronLeft, FilePen, Hourglass, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { TopNav } from '../../components/TopNav';
import { setAgentDraft } from '../agent/handoff';
import { getChatAccount } from '../chat/chatAccount';
import { resolveCallee } from '../calls/peer';
import { shortKey } from '../calls/machine';
import { money } from '../money/money';
import { SignaturePad } from '../signature/SignaturePad';
import { SIG_VIEWBOX, getSignature, signatureSha256 } from '../signature/signature';
import {
  docContent,
  makeDoc,
  sealOnChain,
  signAgreement,
  CONTENT_MAX,
  type AgreementPart,
  type DocMime,
} from './agreement';
import {
  FOLDERS,
  countFolders,
  firstFolder,
  listFolder,
  stateOf,
  statusLine,
  timeline,
  type AgreementItem,
  type FolderId,
} from './folders';
import { DocView } from './DocView';
import { useBureau } from './useBureau';
import { newMessageId } from '../bmail/envelope';
import { OFFERS_ENABLED } from '../storeBuild';
import './agreements.css';

/**
 * bMail › Agreements (/m/bmail/agreements; /m/bureau redirects here). Owner, 18 Oct 2026: the Bureau moves into bMail.
 * An agreement is a bMail letter carrying a document (protocol unchanged: agreement.ts, postage as any letter).
 * Wide: folders | list | document, the document pane gets the width. Phone: one pane at a time with Back.
 * Sign-first: what needs my signature sits on top with a Review & sign button; drafting with b lives in the composer.
 */
const f = (u: string, i?: RequestInit) => fetch(u, i);
// Company offers: a link shown only to a director, the company account or a named offeree (offer/OffersLink.tsx).
const OffersLink = OFFERS_ENABLED ? lazy(() => import('../offer/OffersLink')) : null;
type Bureau = ReturnType<typeof useBureau>;

const FOLDER_ICON: Record<FolderId, typeof Archive> = {
  needs: FilePen,
  waiting: Hourglass,
  sealed: ShieldCheck,
  archive: Archive,
};

const QUICK_STARTS: { label: string; prompt: string }[] = [
  { label: 'NDA', prompt: 'Draft a mutual NDA between me and ' },
  { label: 'Contractor', prompt: 'Draft a contractor agreement: the work is ' },
  { label: 'From a transcript', prompt: 'Turn this call transcript into an agreement both sides can sign:\n\n' },
  { label: 'Split a venture', prompt: 'Draft a venture split agreement. The partners and their shares are ' },
];

/** A drawn signature, always ink on paper (it was invisible dark-on-dark in the first Bureau). */
const SigImage = ({ path, big }: { path: string; big?: boolean }) => (
  <span className={`ag-paper ag-sigbox${big ? ' big' : ''}`}>
    <svg className="ag-sig" viewBox={SIG_VIEWBOX} aria-label="Signature">
      <path d={path} />
    </svg>
  </span>
);

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const namer = (b: Bureau) => (k: string) => (k === b.me ? 'you' : (b.labels[k] ?? shortKey(k)));

const readFile = (file: File): Promise<{ mime: DocMime; content: string }> =>
  new Promise((resolve, reject) => {
    const mime: DocMime | null =
      file.type === 'application/pdf'
        ? 'application/pdf'
        : file.type === 'text/html'
          ? 'text/html'
          : file.type.startsWith('text/')
            ? 'text/plain'
            : null;
    if (!mime) return reject(new Error('PDF, HTML or text files only.'));
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.onload = () => {
      const v = String(r.result ?? '');
      resolve({ mime, content: mime === 'application/pdf' ? v.slice(v.indexOf(',') + 1) : v });
    };
    if (mime === 'application/pdf') r.readAsDataURL(file);
    else r.readAsText(file);
  });

/** Drafting with b: a quiet section of the composer, not the main screen. */
const DraftWithB = () => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const go = (t: string) => {
    setAgentDraft(t);
    navigate('/m/ask-b');
  };
  if (!open)
    return (
      <button type="button" className="ag-link" onClick={() => setOpen(true)}>
        <Sparkles size={14} aria-hidden="true" /> Draft it with b: NDA, contractor, from a transcript, split a venture
      </button>
    );
  return (
    <div className="ag-drafter">
      <div className="ag-row">
        {QUICK_STARTS.map((q) => (
          <button key={q.label} type="button" className="ag-chip" onClick={() => go(q.prompt)}>
            {q.label}
          </button>
        ))}
      </div>
      <textarea
        className="ag-input"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Or describe it: a one-page NDA with $alice for the bMusic launch"
      />
      <div className="ag-row">
        <span className="ag-fine ag-grow">b drafts it in Ask b; paste the result back here to send it.</span>
        <button type="button" className="ag-btn" disabled={!text.trim()} onClick={() => go(text.trim())}>
          Ask b
        </button>
      </div>
    </div>
  );
};

const Composer = ({ bureau, onDone }: { bureau: Bureau; onDone: () => void }) => {
  const [to, setTo] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; mime: DocMime; content: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const send = async () => {
    setErr('');
    try {
      setBusy('Looking up…');
      const names = to.split(/[\s,]+/).filter(Boolean);
      if (!names.length) throw new Error('Add at least one person to sign with.');
      const peers = await Promise.all(names.map((n) => resolveCallee(f, n)));
      const doc = makeDoc({
        id: newMessageId(),
        title,
        mime: file?.mime ?? 'text/plain',
        content: file?.content ?? text,
        author: bureau.me,
        parties: peers.map((p) => p.key),
        createdAt: Date.now(),
      });
      setBusy('Sending…');
      const labels = Object.fromEntries(peers.map((p) => [p.key, p.label]));
      await bureau.deliver(
        { doc, sigs: [] },
        `Agreement: ${doc.title}`,
        `${doc.title}\n\nAn agreement for you to read and sign. Open it in bMail › Agreements.`,
        labels,
      );
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
        <div className="ag-h ag-grow">New agreement</div>
        <button type="button" className="ag-btn ag-wideonly" onClick={onDone} disabled={!!busy}>
          Cancel
        </button>
        <button type="button" className="ag-btn primary" onClick={() => void send()} disabled={!!busy}>
          {busy || 'Send for signing'}
        </button>
      </div>
      {err && <p className="ag-err">{err}</p>}
      <label className="ag-field">
        <span>Sign with</span>
        <input
          className="ag-input"
          placeholder="$handle, paymail or name (several: commas)"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
      <label className="ag-field">
        <span>Title</span>
        <input
          className="ag-input"
          placeholder="e.g. Mutual NDA: bMusic launch"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <DraftWithB />
      {file ? (
        <div className="ag-row ag-attached">
          <span className="ag-grow">{file.name}</span>
          <button type="button" className="ag-chip" onClick={() => setFile(null)}>
            Remove
          </button>
        </div>
      ) : (
        <textarea
          className="ag-input ag-terms"
          rows={14}
          placeholder="The terms (or attach a file)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <div className="ag-row">
        <label className="ag-chip">
          Attach PDF / HTML / text
          <input
            type="file"
            hidden
            accept="application/pdf,text/html,text/plain"
            onChange={(e) => {
              const fl = e.target.files?.[0];
              if (fl)
                readFile(fl)
                  .then((r) =>
                    r.content.length > CONTENT_MAX
                      ? setErr('Files up to about 22 KB for now: larger files are coming to bWalletX.')
                      : setFile({ name: fl.name, ...r }),
                  )
                  .catch((x: Error) => setErr(x.message));
            }}
          />
        </label>
      </div>
      <p className="ag-fine">
        Sent by bMail: sealed so only the signers can open it, with each person’s normal postage (1¢ unless they set
        more).
      </p>
    </div>
  );
};

/** The sign sheet: your card signature on paper, one big button; drawing a new one is the second choice. */
const SignSheet = ({
  title,
  cost,
  rate,
  onSign,
  onClose,
}: {
  title: string;
  cost: number | null;
  rate: number;
  onSign: (svgPath: string) => void;
  onClose: () => void;
}) => {
  useBackClose(true, onClose);
  const card = getSignature(getChatAccount() ?? undefined);
  const [drawing, setDrawing] = useState(false);
  if (drawing)
    return (
      <SignaturePad
        onCancel={() => setDrawing(false)}
        onSave={(p) => {
          setDrawing(false);
          onSign(p);
        }}
      />
    );
  return createPortal(
    <div className="ag-sheet-back" role="presentation" onClick={onClose}>
      <div
        className="ag-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Sign ${title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ag-row">
          <div className="ag-h ag-grow">Sign “{title}”</div>
          <button type="button" className="ag-icon" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {card ? (
          <>
            <SigImage path={card.svgPath} big />
            <button type="button" className="ag-btn primary ag-full" onClick={() => onSign(card.svgPath)}>
              Sign with this signature
            </button>
            <button type="button" className="ag-btn ag-full" onClick={() => setDrawing(true)}>
              Draw a new one
            </button>
            <p className="ag-fine">Your card signature (set on your wallet card).</p>
          </>
        ) : (
          <button type="button" className="ag-btn primary ag-full" onClick={() => setDrawing(true)}>
            Draw your signature
          </button>
        )}
        <p className="ag-fine">
          Adds your signature and an identity-key proof, then sends the signed copy to the other signers by bMail
          {cost !== null && cost > 0 ? ` (postage ${money(cost, rate)})` : ''}.
        </p>
      </div>
    </div>,
    document.body,
  );
};

const AgreementView = ({ it, bureau, onBack }: { it: AgreementItem; bureau: Bureau; onBack: () => void }) => {
  const { doc, sigs, seal } = it.part;
  const me = bureau.me;
  const s = stateOf(it, me);
  const name = namer(bureau);
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const others = doc.parties.filter((p) => p !== me);
  useEffect(() => {
    let live = true;
    void Promise.all(others.map((k) => bureau.postageFor(k))).then(
      (v) => live && setCost(v.reduce((a, b) => a + b, 0)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);
  const content = useMemo(() => docContent(doc), [doc]);
  const paid = bureau.postagePaid[doc.id] ?? 0;

  const run = async (label: string, fn: () => Promise<void>) => {
    setErr('');
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy('');
    }
  };
  const sign = (svgPath: string) =>
    run('Signing…', async () => {
      const mine = await signAgreement(bureau.wallet, me, doc, svgPath, signatureSha256(svgPath));
      const part: AgreementPart = { doc, sigs: [...sigs.filter((x) => x.key !== me), mine], ...(seal ? { seal } : {}) };
      await bureau.deliver(part, `Signed: ${doc.title}`, `I signed “${doc.title}”. Open it in bMail › Agreements.`);
    });
  const doSeal = () =>
    run('Sealing on chain…', async () => {
      const sl = await sealOnChain(bureau.wallet, me, it.part);
      await bureau.deliver(
        { doc, sigs, seal: sl },
        `Sealed: ${doc.title}`,
        `“${doc.title}” is sealed on chain (${sl.txid}).`,
      );
    });

  return (
    <div className="ag-detail">
      <div className="ag-bar">
        <button type="button" className="ag-btn ag-back" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden="true" /> Back
        </button>
        <div className="ag-grow ag-headtext">
          <div className="ag-h">{doc.title}</div>
          <div className="ag-sub">
            {statusLine(s)} · from {name(doc.author)} · {new Date(doc.createdAt).toLocaleDateString()}
          </div>
        </div>
        <div className="ag-actions">
          {s.needsMe && (
            <button type="button" className="ag-btn primary" disabled={!!busy} onClick={() => setSigning(true)}>
              Review &amp; sign
            </button>
          )}
          {s.complete && !s.sealed && (
            <button type="button" className="ag-btn primary" disabled={!!busy} onClick={() => void doSeal()}>
              Seal on chain
            </button>
          )}
          <button type="button" className="ag-btn" onClick={() => bureau.setArchived(doc.id, !it.archived)}>
            {it.archived ? 'Put back' : 'Archive'}
          </button>
        </div>
      </div>
      {busy && <p className="ag-note">{busy}</p>}
      {err && <p className="ag-err">{err}</p>}
      {s.complete && !s.sealed && (
        <p className="ag-fine">
          Sealing writes the document and signature hashes (never the content) on chain from this wallet, then tells the
          signers{cost !== null && others.length > 0 ? ` (postage ${money(cost, bureau.rate)})` : ''}.
        </p>
      )}
      <div className="ag-paper ag-doc">
        <DocView content={content} title={doc.title} />
      </div>
      <section className="ag-section">
        <div className="ag-label">Signatures</div>
        <div className="ag-parties">
          {doc.parties.map((k) => {
            const sg = sigs.find((x) => x.key === k && it.signed.includes(k));
            return (
              <div key={k} className="ag-party">
                <div className="ag-grow">
                  <div className="ag-pname">{k === me ? 'You' : name(k)}</div>
                  <div className="ag-fine">{sg ? `Signed ${when(sg.at)}` : 'Not signed yet'}</div>
                </div>
                {sg ? <SigImage path={sg.svgPath} /> : <span className="ag-sigbox ag-unsigned">Not signed</span>}
              </div>
            );
          })}
        </div>
      </section>
      <section className="ag-section">
        <div className="ag-label">Timeline</div>
        <ol className="ag-timeline">
          {timeline(it, name).map((t, i) => (
            <li key={i} className={t.done ? 'done' : ''}>
              <span className="ag-dot" aria-hidden="true" />
              <span className="ag-grow">
                {t.label}
                {t.txid && (
                  <>
                    {' · '}
                    <a
                      className="ag-mono"
                      href={`https://whatsonchain.com/tx/${t.txid}`}
                      target="_blank"
                      rel="noreferrer"
                      title={t.txid}
                    >
                      {t.txid.slice(0, 8)}…{t.txid.slice(-6)} ↗
                    </a>
                  </>
                )}
              </span>
              <span className="ag-fine">{t.at ? when(t.at) : 'Pending'}</span>
            </li>
          ))}
        </ol>
        <p className="ag-fine">
          {paid > 0 ? `Postage you paid on this agreement: ${money(paid, bureau.rate)}.` : 'No postage paid by you.'}
        </p>
      </section>
      {signing && (
        <SignSheet
          title={doc.title}
          cost={others.length ? cost : 0}
          rate={bureau.rate}
          onClose={() => setSigning(false)}
          onSign={(p) => {
            setSigning(false);
            void sign(p);
          }}
        />
      )}
    </div>
  );
};

const AgreementsPage = () => {
  const navigate = useNavigate();
  const bureau = useBureau();
  const counts = useMemo(() => countFolders(bureau.items, bureau.me), [bureau.items, bureau.me]);
  const [folder, setFolder] = useState<FolderId | null>(null);
  const shownFolder = folder ?? firstFolder(counts);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const shown = useMemo(
    () => listFolder(bureau.items, shownFolder, bureau.me, q),
    [bureau.items, shownFolder, bureau.me, q],
  );
  const active = bureau.items.find((it) => it.part.doc.id === sel) ?? null;
  const pane = composing ? 'compose' : active ? 'detail' : 'list';
  useBackClose(pane !== 'list', () => {
    setComposing(false);
    setSel(null);
  });
  const name = namer(bureau);
  const open = (id: string) => {
    setSel(id);
    setComposing(false);
  };

  return (
    <div className={`ag ag-pane-${pane}`}>
      {/* The wallet's top bar, as bMail (BMailPage): on the wide layout it is clipped by the shell. */}
      <TopNav />
      <header className="ag-top">
        <button type="button" className="ag-btn ag-back" onClick={() => navigate('/m/bmail')}>
          <ChevronLeft size={16} aria-hidden="true" /> bMail
        </button>
        <h1 className="ag-title">Agreements</h1>
        <span className="ag-grow" />
        {OffersLink && (
          <Suspense fallback={null}>
            <OffersLink />
          </Suspense>
        )}
        <button
          type="button"
          className="ag-btn primary"
          onClick={() => {
            setComposing(true);
            setSel(null);
          }}
        >
          New agreement
        </button>
      </header>
      <div className="ag-body">
        <nav className="ag-rail" aria-label="Agreement folders">
          {/* Wide layout: the shell's title bar already says Agreements with Back, so New sits on top of the folders. */}
          <button
            type="button"
            className="ag-btn primary ag-new"
            onClick={() => {
              setComposing(true);
              setSel(null);
            }}
          >
            New agreement
          </button>
          {FOLDERS.map((fd) => {
            const Icon = FOLDER_ICON[fd.id];
            return (
              <button
                key={fd.id}
                type="button"
                aria-current={fd.id === shownFolder}
                className={`ag-folder${fd.id === shownFolder ? ' on' : ''}${fd.id === 'needs' && counts.needs ? ' hot' : ''}`}
                onClick={() => {
                  setFolder(fd.id);
                  setSel(null);
                  setComposing(false);
                }}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="ag-flabel">{fd.label}</span>
                <span className="ag-count">{counts[fd.id]}</span>
              </button>
            );
          })}
        </nav>
        <div className="ag-list">
          <label className="ag-search">
            <Search size={14} aria-hidden="true" />
            <input placeholder="Search titles" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {shownFolder !== 'needs' && counts.needs > 0 && (
            <button type="button" className="ag-nudge" onClick={() => setFolder('needs')}>
              {counts.needs} {counts.needs === 1 ? 'agreement needs' : 'agreements need'} your signature ›
            </button>
          )}
          {bureau.error && <p className="ag-err">{bureau.error}</p>}
          {shown.length === 0 && (
            <p className="ag-note ag-empty-list">
              {bureau.loading
                ? 'Checking your mail…'
                : shownFolder === 'needs'
                  ? 'Nothing needs your signature.'
                  : 'Nothing here.'}
            </p>
          )}
          {shown.map((it) => {
            const s = stateOf(it, bureau.me);
            const on = active?.part.doc.id === it.part.doc.id;
            const who = s.mine
              ? `to ${
                  it.part.doc.parties
                    .filter((p) => p !== bureau.me)
                    .map(name)
                    .join(', ') || 'you'
                }`
              : `from ${name(it.part.doc.author)}`;
            return (
              <div key={it.part.doc.id} className={`ag-item${on ? ' on' : ''}${s.needsMe ? ' needs' : ''}`}>
                <button type="button" className="ag-item-main" onClick={() => open(it.part.doc.id)}>
                  <span className="ag-item-title">{it.part.doc.title}</span>
                  <span className="ag-item-sub">
                    {statusLine(s)} · {who}
                  </span>
                </button>
                {s.needsMe && (
                  <button type="button" className="ag-btn primary ag-sm" onClick={() => open(it.part.doc.id)}>
                    Review &amp; sign
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="ag-view">
          {composing ? (
            <Composer bureau={bureau} onDone={() => setComposing(false)} />
          ) : active ? (
            <AgreementView key={active.part.doc.id} it={active} bureau={bureau} onBack={() => setSel(null)} />
          ) : (
            <div className="ag-blank">
              <FilePen size={28} aria-hidden="true" />
              <p>Pick an agreement to read it, or start a new one.</p>
              <p className="ag-fine">
                Agreements travel as bMail letters: sealed to the signers, stamped with normal postage, sealed on chain
                once everyone has signed.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgreementsPage;
