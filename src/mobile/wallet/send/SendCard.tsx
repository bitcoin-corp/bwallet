import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { useDisplayCurrency } from '../../../hooks/useDisplayCurrency';
import { fiatCode, fiatSymbol, fiatToUsd, usdToFiat } from '../../../utils/displayCurrency';
import { ClipboardPaste, Plus, ScanLine, Trash2, Users } from 'lucide-react';

const ScanSheet = lazy(() => import('../../scan/ScanSheet'));
import type { Theme } from '../../../theme.types';
import { NameInput } from '../../names/NameInput';
import { useContacts } from '../../chat/useContacts';
import { payTarget } from '../../chat/contacts';
import { noteContacts } from './payee';
import { applyChip, PURPOSE_CHIPS, PURPOSE_MAX } from '../purpose/purpose';
import {
  balanceLine,
  fmtBsv,
  fmtSats,
  fmtUsd,
  loadRecents,
  notePending,
  parseAmount,
  pastedRecipient,
  QUICK_BSV,
  QUICK_USD,
  rowSats,
  rowUsd,
  SATS_PER_BSV,
  sendButton,
  type RowStatus,
  type SendRow,
} from './sendLogic';

/**
 * Send BSV card (owner, 9 Oct 2026: "as easy as HandCash"). Recipient first with quick picks and an
 * explicit Paste button, a big dollar amount with $1 · $5 · $10 · $20, and one button that says
 * exactly what happens ("Send $5.00 to $alice"). All send logic stays in BsvWallet.handleSendBsv;
 * this only edits its recipients.
 *
 * Clipboard: read only when the user taps Paste (navigator.clipboard.readText in the tap handler), or
 * through the field's own paste. Never on open or focus — on iOS a read without the user's gesture
 * shows the system "Allow Paste" prompt, and silently reading it would leak whatever was copied.
 */
type Field = 'address' | 'satSendAmount' | 'usdSendAmount' | 'amountType' | 'error';

type Props = {
  theme: Theme;
  rows: (SendRow & { error?: string })[];
  balanceBsv: number;
  rate: number;
  sendAll: boolean;
  processing: boolean;
  account: string;
  onUpdate: (id: string, field: Field, value: string | number | null) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onMax: () => void;
  /** The amount was edited after Max: it is no longer a send-all. */
  onAmountEdited: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  /** What the payment is for (purpose/purpose.ts): optional, kept with the transaction, shown on the confirm sheet. */
  purpose: string;
  onPurpose: (v: string) => void;
  /** "Also write it on-chain (public)": offered only for payments to plain addresses (canWriteOnChain). */
  canOnChain: boolean;
  onChain: boolean;
  onOnChain: (v: boolean) => void;
  /** Set when this send pays a verified invoice (purpose/invoice.ts). */
  invoice?: { id: string; payee: string } | null;
};

const GOLD = 'var(--bw-accent-hi)';
const RED = '#ff4444';

export const SendCard = (p: Props) => {
  const fx = useDisplayCurrency();
  const { theme } = p;
  const fg = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  const row = theme.color.global.row;
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string | undefined>>({});
  const [pasteMsg, setPasteMsg] = useState<Record<string, string>>({});
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [picksOpen, setPicksOpen] = useState<Record<string, boolean | undefined>>({});
  const contacts = useContacts();
  const recents = useMemo(() => loadRecents(p.account), [p.account]);

  // Quick picks: recent recipients first, then contacts (bPhone friends, bChat, follows).
  const picks = useMemo(() => {
    const seen = new Set<string>();
    const out: { input: string; label: string; avatar?: string }[] = [];
    const push = (input: string, label: string, avatar?: string | null) => {
      const k = input.toLowerCase();
      if (!input || seen.has(k)) return;
      seen.add(k);
      out.push({ input, label, avatar: avatar ?? undefined });
    };
    for (const r of recents) push(r.input, r.label, r.avatar);
    for (const c of contacts) {
      const t = payTarget(c);
      if (t) push(c.handle ? `$${c.handle}` : t, c.handle ? `$${c.handle}` : c.name, c.avatar);
    }
    return out.slice(0, 10);
  }, [recents, contacts]);
  // The confirm sheet's look-alike check compares against saved contacts too (payee.ts).
  useEffect(() => {
    noteContacts(
      contacts.flatMap((c) =>
        c.paymail
          ? [{ paymail: c.paymail, label: c.handle ? `$${c.handle}` : c.name, avatar: c.avatar ?? undefined }]
          : [],
      ),
    );
  }, [contacts]);

  const btn = sendButton({
    rows: p.rows,
    status,
    names,
    rate: p.rate,
    balanceBsv: p.balanceBsv,
    sendAll: p.sendAll,
    processing: p.processing,
  });
  const multi = p.rows.length > 1;

  const setAddress = (id: string, v: string) => {
    setNames((n) => ({ ...n, [id]: '' }));
    p.onUpdate(id, 'address', v);
  };

  const paste = async (id: string) => {
    setPasteMsg((m) => ({ ...m, [id]: '' }));
    try {
      // Called from the tap handler only: this IS the user's paste gesture.
      const text = await navigator.clipboard.readText();
      const v = pastedRecipient(text);
      if (v) setAddress(id, v);
      else setPasteMsg((m) => ({ ...m, [id]: 'Nothing to paste: copy an address, $handle or paymail first' }));
    } catch {
      setPasteMsg((m) => ({ ...m, [id]: 'Paste was not allowed. Long-press the box and choose Paste.' }));
    }
  };

  const setAmount = (r: SendRow, v: number | null) => {
    p.onAmountEdited();
    // Typed in the display currency (Settings › Currency); stored in US dollars.
    if (r.amountType === 'usd') p.onUpdate(r.id, 'usdSendAmount', v === null ? null : fiatToUsd(v, fx));
    else p.onUpdate(r.id, 'satSendAmount', v === null ? null : Math.round(v * SATS_PER_BSV));
  };

  const amountText = (r: SendRow) => {
    const d = drafts[r.id];
    if (d !== undefined) return d;
    if (r.amountType === 'usd') return r.usdSendAmount ? usdToFiat(r.usdSendAmount, fx).toFixed(2) : '';
    return r.satSendAmount ? String(r.satSendAmount / SATS_PER_BSV) : '';
  };

  const chip =
    'flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-xl text-sm font-semibold cursor-pointer';
  const chipStyle = {
    background: `color-mix(in srgb, ${GOLD} 10%, transparent)`,
    color: GOLD,
    border: `1px solid color-mix(in srgb, ${GOLD} 30%, transparent)`,
  };
  const step = (n: number, label: string) => (
    <span className="text-xs font-bold uppercase tracking-widest" style={{ color: gray }}>
      <span style={{ color: GOLD }}>{n}</span> · {label}
    </span>
  );

  return (
    <form noValidate onSubmit={p.onSubmit} className="flex flex-col w-full gap-3" aria-label="Send BSV">
      {/* Available balance: small, clear, Max as a chip */}
      <div className="flex items-center justify-between w-full px-1">
        <span className="text-xs" style={{ color: gray }}>
          Available <span style={{ color: fg, fontWeight: 600 }}>{balanceLine(p.balanceBsv, p.rate)}</span>
        </span>
        {!multi && (
          <button
            type="button"
            aria-label="Send everything (Max)"
            onClick={() => {
              setDrafts({});
              p.onMax();
            }}
            className="min-h-[36px] text-xs font-bold px-3 rounded-full cursor-pointer"
            style={p.sendAll ? { background: GOLD, color: '#000', border: `1px solid ${GOLD}` } : chipStyle}
          >
            Max
          </button>
        )}
      </div>

      {p.rows.map((r, idx) => {
        const sats = rowSats(r, p.rate);
        const usd = rowUsd(r, p.rate);
        const isUsd = r.amountType === 'usd';
        const showPicks = picksOpen[r.id] ?? !r.address;
        const setUnit = (unit: 'usd' | 'bsv') => {
          if (unit === r.amountType) return;
          setDrafts((d) => ({ ...d, [r.id]: undefined }));
          p.onAmountEdited();
          p.onUpdate(r.id, 'amountType', unit);
        };
        return (
          <motion.div
            key={r.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="w-full rounded-2xl p-4 flex flex-col gap-3"
            style={{ background: row }}
          >
            {/* 1 · Who */}
            <div className="flex items-center justify-between">
              {step(1, multi ? `Who · recipient ${idx + 1}` : 'Who are you paying?')}
              {multi && (
                <button
                  type="button"
                  aria-label={`Remove recipient ${idx + 1}`}
                  onClick={() => p.onRemove(r.id)}
                  className="flex items-center justify-center w-11 h-11 rounded-full border-0 cursor-pointer"
                  style={{ background: `${RED}15`, color: RED }}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={() => void paste(r.id)} className={chip} style={chipStyle}>
                <ClipboardPaste size={16} /> Paste
              </button>
              <button
                type="button"
                aria-label="Scan a QR code"
                onClick={() => setScanFor(r.id)}
                className={chip}
                style={chipStyle}
              >
                <ScanLine size={16} /> Scan
              </button>
              <button
                type="button"
                aria-label="Choose from contacts"
                aria-expanded={showPicks}
                onClick={() => setPicksOpen((m) => ({ ...m, [r.id]: !showPicks }))}
                className={chip}
                style={chipStyle}
              >
                <Users size={16} /> Contacts
              </button>
            </div>
            <NameInput
              theme={theme}
              asset="bsv"
              autoConfirm
              big
              value={r.address}
              onChange={(v) => p.onUpdate(r.id, 'address', v)}
              onStatus={(s, resolved) => {
                setStatus((m) => ({ ...m, [r.id]: s }));
                const label = resolved
                  ? resolved.input.startsWith('$')
                    ? resolved.input
                    : (resolved.displayName ?? resolved.input)
                  : '';
                setNames((n) => ({ ...n, [r.id]: label }));
                if (s === 'ready' && resolved) {
                  notePending(resolved.target, {
                    input: resolved.input,
                    label,
                    avatar: resolved.avatar,
                    pubkey: resolved.pubkey,
                  });
                }
              }}
              style={{ width: '100%', margin: '0' }}
            />
            {pasteMsg[r.id] && (
              <p role="status" className="text-xs -mt-1" style={{ color: gray }}>
                {pasteMsg[r.id]}
              </p>
            )}
            {showPicks && status[r.id] !== 'loading' && picks.length === 0 && (
              <p className="text-xs" style={{ color: gray }}>
                No contacts yet. Paste or scan to pay someone new.
              </p>
            )}
            {showPicks && status[r.id] !== 'loading' && picks.length > 0 && (
              <div className="flex flex-wrap gap-2 pb-1">
                {picks.map((k) => (
                  <button
                    key={k.input}
                    type="button"
                    aria-label={`Pay ${k.label}`}
                    onClick={() => {
                      setPicksOpen((m) => ({ ...m, [r.id]: false }));
                      setAddress(r.id, k.input);
                    }}
                    className="flex flex-col items-center gap-1 shrink-0 w-16 border-0 bg-transparent cursor-pointer p-0"
                  >
                    {k.avatar ? (
                      <img src={k.avatar} alt="" className="w-12 h-12 rounded-full object-cover" />
                    ) : (
                      <span
                        className="w-12 h-12 rounded-full flex items-center justify-center text-base font-bold"
                        style={{ background: `color-mix(in srgb, ${GOLD} 13%, transparent)`, color: GOLD }}
                      >
                        {k.label.replace(/^\$/, '').slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="text-[11px] w-full truncate text-center" style={{ color: gray }}>
                      {k.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {r.error && (
              <p role="alert" className="text-xs" style={{ color: RED }}>
                {r.error}
              </p>
            )}

            {/* 2 · How much */}
            <div className="flex items-center justify-between pt-2">
              {step(2, 'How much?')}
              <div
                role="radiogroup"
                aria-label="Amount unit"
                className="flex rounded-full p-0.5"
                style={{ border: `1px solid ${gray}50` }}
              >
                {(['usd', 'bsv'] as const).map((u) => {
                  const on = r.amountType === u;
                  return (
                    <button
                      key={u}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setUnit(u)}
                      className="min-h-[36px] min-w-[52px] px-3 rounded-full text-xs font-bold border-0 cursor-pointer"
                      style={{ background: on ? GOLD : 'transparent', color: on ? '#000' : fg }}
                    >
                      {u === 'usd' ? fiatCode(fx) : 'BSV'}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center justify-center gap-1 w-full">
                <span className="font-bold" style={{ color: fg, fontSize: multi ? 28 : 44 }}>
                  {isUsd ? fiatSymbol(fx) : ''}
                </span>
                <input
                  aria-label={isUsd ? `Amount in ${fiatCode(fx)}` : 'Amount in BSV'}
                  inputMode="decimal"
                  placeholder={isUsd ? '0.00' : '0.000'}
                  value={amountText(r)}
                  onChange={(e) => {
                    const t = e.target.value;
                    setDrafts((d) => ({ ...d, [r.id]: t }));
                    setAmount(r, parseAmount(t));
                  }}
                  onBlur={() => setDrafts((d) => ({ ...d, [r.id]: undefined }))}
                  className="bg-transparent border-0 outline-none font-bold text-left min-w-0 p-0"
                  style={{
                    color: fg,
                    fontSize: multi ? 28 : 44,
                    width: `${Math.max(amountText(r).length, isUsd ? 4 : 5) + 0.5}ch`,
                    maxWidth: '70%',
                  }}
                />
                {!isUsd && (
                  <span className="font-bold" style={{ color: gray, fontSize: multi ? 14 : 18 }}>
                    BSV
                  </span>
                )}
              </div>
              <p className="text-xs" style={{ color: gray }} aria-live="polite">
                {sats > 0
                  ? isUsd
                    ? `≈ ${fmtBsv(sats)} BSV · ${fmtSats(sats)}`
                    : `${p.rate > 0 ? `≈ ${fmtUsd(usd)} · ` : ''}${fmtSats(sats)}`
                  : isUsd
                    ? 'Type an amount or tap a chip'
                    : 'Type an amount in BSV'}
              </p>
              {(!isUsd || p.rate > 0) && (
                <div className="flex flex-wrap justify-center gap-2 mt-1">
                  {isUsd
                    ? QUICK_USD.map((n) => {
                        const usdN = fiatToUsd(n, fx);
                        const on = !!r.usdSendAmount && Math.abs(r.usdSendAmount - usdN) < 1e-9;
                        return (
                          <button
                            key={n}
                            type="button"
                            aria-pressed={on}
                            onClick={() => {
                              setDrafts((d) => ({ ...d, [r.id]: undefined }));
                              p.onAmountEdited();
                              p.onUpdate(r.id, 'usdSendAmount', usdN);
                            }}
                            className="min-h-[40px] px-4 rounded-full text-sm font-semibold cursor-pointer"
                            style={{
                              background: on ? GOLD : 'transparent',
                              color: on ? '#000' : fg,
                              border: `1px solid ${on ? GOLD : gray + '50'}`,
                            }}
                          >
                            {fiatSymbol(fx)}
                            {n}
                          </button>
                        );
                      })
                    : QUICK_BSV.map((n) => {
                        const satN = Math.round(n * SATS_PER_BSV);
                        const on = r.satSendAmount === satN;
                        return (
                          <button
                            key={n}
                            type="button"
                            aria-pressed={on}
                            onClick={() => {
                              setDrafts((d) => ({ ...d, [r.id]: undefined }));
                              p.onAmountEdited();
                              p.onUpdate(r.id, 'satSendAmount', satN);
                            }}
                            className="min-h-[40px] px-4 rounded-full text-sm font-semibold cursor-pointer"
                            style={{
                              background: on ? GOLD : 'transparent',
                              color: on ? '#000' : fg,
                              border: `1px solid ${on ? GOLD : gray + '50'}`,
                            }}
                          >
                            {n} BSV
                          </button>
                        );
                      })}
                </div>
              )}
            </div>
          </motion.div>
        );
      })}

      {/* What's it for? (owner, 23 Oct 2026: "the whole world economy will fit inside that little memo") */}
      <div className="w-full rounded-2xl p-4 flex flex-col gap-2" style={{ background: row }}>
        {p.invoice && (
          <p role="status" className="text-xs font-semibold" style={{ color: GOLD }}>
            Paying invoice {p.invoice.id} from {p.invoice.payee}
          </p>
        )}
        <label htmlFor="send-purpose">{step(3, "What's it for?")}</label>
        <textarea
          id="send-purpose"
          aria-label="What's it for? (optional)"
          placeholder="Optional: a few words, like a memo"
          maxLength={PURPOSE_MAX}
          rows={2}
          value={p.purpose}
          onChange={(e) => p.onPurpose(e.target.value)}
          className="w-full rounded-xl p-3 text-sm outline-none resize-none"
          style={{ background: 'transparent', color: fg, border: `1px solid ${gray}50` }}
        />
        <div className="flex flex-wrap gap-2">
          {PURPOSE_CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => p.onPurpose(applyChip(p.purpose, c))}
              className="min-h-[36px] px-3 rounded-full text-xs font-semibold cursor-pointer"
              style={chipStyle}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="flex justify-between gap-2 text-[11px]" style={{ color: gray }}>
          <span>
            {p.onChain && p.canOnChain
              ? 'Public: anyone can read this on the blockchain.'
              : 'Private: saved on this device with the payment.'}
          </span>
          <span className="tabular-nums">
            {p.purpose.length}/{PURPOSE_MAX}
          </span>
        </div>
        {p.canOnChain && p.purpose.trim() && (
          <label className="flex items-center gap-2 text-xs cursor-pointer min-h-[36px]" style={{ color: fg }}>
            <input type="checkbox" checked={p.onChain} onChange={(e) => p.onOnChain(e.target.checked)} />
            Also write it on-chain (public)
          </label>
        )}
      </div>

      {/* Secondary: a quiet outline button. The bMail note stays hidden until it works (live features only). */}
      {!p.sendAll && (
        <button
          type="button"
          onClick={p.onAdd}
          className="self-start flex items-center gap-1.5 min-h-[44px] px-4 rounded-xl text-sm font-semibold bg-transparent cursor-pointer"
          style={{ color: fg, border: `1px solid ${gray}50` }}
        >
          <Plus size={16} /> Add another recipient
        </button>
      )}

      {/* 3 · Send: one big primary button that says what happens next */}
      <button
        type="submit"
        disabled={btn.disabled}
        className="yours-sheet-primary w-full cursor-pointer disabled:cursor-not-allowed"
        style={{ height: 56, fontSize: 16, fontWeight: 700, borderRadius: 16, opacity: btn.disabled ? 0.45 : 1 }}
      >
        {btn.label}
      </button>
      {scanFor && (
        <Suspense fallback={null}>
          <ScanSheet
            onClose={() => setScanFor(null)}
            onPay={(to, sats) => {
              const id = scanFor;
              setAddress(id, to);
              if (sats) {
                setDrafts((d) => ({ ...d, [id]: undefined }));
                p.onAmountEdited();
                p.onUpdate(id, 'amountType', 'bsv');
                p.onUpdate(id, 'satSendAmount', sats);
              }
            }}
          />
        </Suspense>
      )}
    </form>
  );
};
