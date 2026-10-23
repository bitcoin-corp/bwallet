import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { sendBsv } from '../../utils/guardedSendBsv';
import { publishBalance } from '../wallet/balanceStore';
import { History, X } from 'lucide-react';
import { onCreditsSheet, takeCreditsSheet } from './creditsNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getErrorMessage } from '../../utils/tools';
import { useBackClose } from '../backStack';
import { ChatApiError } from '../chat/api';
import { signedInClient } from '../kyc/kycWallet';
import { ErrorActions } from '../errors/ErrorActions';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { fmtSats } from '../money/money';
import { SUPPORT_EMAIL } from '../ugc/ugc';
import {
  BCREDITS_LINE_LABEL,
  CREDITS_CARD_TITLE,
  TOP_UP_PRESETS_PENCE,
  addPending,
  creditLines,
  creditsStopped,
  depositOutcome,
  depositRequests,
  emitCreditsChanged,
  entryAmount,
  entryLabel,
  fmtCredits,
  fmtPence,
  loadPending,
  onCreditsChanged,
  parseCreditsInfo,
  parseLedger,
  parsePounds,
  planTopUp,
  removePending,
  savePending,
  setCreditsStopped,
  spentSoFar,
  type CreditEntry,
  type CreditsInfo,
  type Pending,
  type TopUpPlan,
} from './credits';
import { liveGbpPerBsv } from './rate';
import { accentById } from '../theme/accents';
import { useAccentId } from '../theme/useAccent';

/**
 * The bCredits card (Wallet › Credits, desktop /m/credits). Lazy chunk behind BCREDITS_ENABLED (CreditsRow.tsx).
 * Front: issuer b, the balance in bCredits, ticking down as b replies (Ask b emits bwx:bcredits after each one).
 * Back: the rate, spent so far, Stop and Contact. Top up: pick an amount (≤ £20), read the terms, ONE approval
 * sheet, the wallet sends BSV + the reference output to the treasury, posts the txid, and the card shows it
 * pending until the server has one confirmation, then credited.
 */
const GOLD = 'var(--bw-accent-hi)';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const POLL_MS = 60_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-4 max-h-[85vh] overflow-y-auto"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-semibold">{title}</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

const FullSheet = ({ children }: { children: ReactNode }) =>
  createPortal(
    <div
      className="fixed inset-0 z-[420] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {children}
    </div>,
    document.body,
  );

const BTile = () => (
  <div
    aria-hidden="true"
    className="flex items-center justify-center flex-shrink-0"
    style={{ width: 36, height: 36, borderRadius: 18, background: CARD.gold, color: CARD.bg, fontWeight: 800 }}
  >
    b
  </div>
);

export default function CreditsPanel() {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [info, setInfo] = useState<CreditsInfo | null>(null);
  const [rows, setRows] = useState<CreditEntry[] | null>(null);
  const [pending, setPending] = useState<Pending>(loadPending);
  const [sheet, setSheet] = useState<'topup' | 'history' | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [stopped, setStopped] = useState(creditsStopped);
  const [tick, setTick] = useState(false);
  const prevBalance = useRef<number | null>(null);
  // White and paper themes: a light card with black text, never a dark card.
  const accentId = useAccentId();
  const light = accentId === 'white' || !!accentById(accentId).paper;
  const ink = light ? '#111111' : CARD.ink;
  const muted = light ? '#555555' : CARD.muted;
  const soft = light ? '#333333' : CARD.soft;
  const chip = light ? 'var(--bw-tint, #EDEDED)' : CARD.chip;
  // The bCredits card's back opens Top up or History here (creditsNav.ts).
  useEffect(() => {
    const take = () => {
      const s = takeCreditsSheet();
      if (s) setSheet(s);
    };
    take();
    return onCreditsSheet(take);
  }, []);

  const updatePending = (fn: (p: Pending) => Pending) =>
    setPending((p) => {
      const next = fn(p);
      savePending(next);
      return next;
    });

  const refresh = useCallback(async () => {
    if (!apiContext) return;
    try {
      // Silent: the wallet signs in to bit-sign with its own key, the user never sees it.
      const client = await signedInClient(apiContext);
      // Retry top-ups the server had not credited yet (it waits for one confirmation).
      for (const p of loadPending()) {
        try {
          if (depositOutcome(200, await client.depositCredits(p.txid)) !== 'pending') {
            updatePending((x) => removePending(x, p.txid));
          }
        } catch (e) {
          // A 4xx is the server refusing this txid for good; network / 5xx stays pending.
          const st = e instanceof ChatApiError ? e.status : 0;
          if (st >= 400 && st < 500 && st !== 401) {
            updatePending((x) => removePending(x, p.txid));
            addSnackbar(`Top-up not credited: ${errText(e)}`, 'error');
          }
        }
      }
      setInfo(parseCreditsInfo(await client.credits()));
      setRows(parseLedger(await client.creditLedger(200)));
    } catch (e) {
      console.warn('[bcredits] read failed:', e);
      setInfo((i) => i ?? parseCreditsInfo(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiContext]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Ask b replied (or Stop changed): show the new balance at once, then re-read the ledger.
  useEffect(
    () =>
      onCreditsChanged((balance) => {
        setStopped(creditsStopped());
        if (typeof balance === 'number') setInfo((i) => (i ? { ...i, balance } : i));
        void refresh();
      }),
    [refresh],
  );

  // While a top-up waits for its confirmation, check again every minute.
  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [pending.length, refresh]);

  // The tick-down: a short flash when the balance drops.
  const balance = info?.balance ?? 0;
  useEffect(() => {
    if (info && info.enabled) publishBalance('bcredits', info.balance, 'bCredits');
  }, [info]);
  useEffect(() => {
    if (prevBalance.current !== null && balance < prevBalance.current) {
      setTick(true);
      const t = setTimeout(() => setTick(false), 900);
      prevBalance.current = balance;
      return () => clearTimeout(t);
    }
    prevBalance.current = balance;
  }, [balance]);

  const enabled = !!info?.enabled;
  const pendingCredits = pending.reduce((n, p) => n + p.credits, 0);
  const spent = rows ? spentSoFar(rows) : 0;

  return (
    <>
      <div className="w-full px-4 mt-3">
        <div
          role="button"
          tabIndex={0}
          aria-label={flipped ? 'Show your credits' : 'Show the bCredits terms'}
          onClick={() => enabled && setFlipped((f) => !f)}
          onKeyDown={(e) => e.key === 'Enter' && enabled && setFlipped((f) => !f)}
          className="rounded-3xl px-5 py-4"
          style={{
            background: light ? 'var(--bw-card, #FFFFFF)' : 'linear-gradient(135deg, #1b1608 0%, #0b0a08 60%)',
            border: `1px solid ${light ? '#D6D6D6' : CARD.goldLo}`,
            minHeight: 168,
            cursor: enabled ? 'pointer' : 'default',
          }}
          data-testid="bcredits-card"
        >
          <div className="flex items-center gap-3">
            <BTile />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold" style={{ color: ink }}>
                {CREDITS_CARD_TITLE}
              </div>
              <div className="text-[11px]" style={{ color: muted }}>
                Prepaid credits, one line per type
              </div>
            </div>
            {enabled && !flipped && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setSheet('history');
                }}
                aria-label="bCredits history"
                className="p-2"
              >
                <History size={18} color={MUTED} />
              </button>
            )}
          </div>

          {!flipped ? (
            <>
              {(enabled && info
                ? creditLines(balance)
                : [{ type: 'bcredits', label: BCREDITS_LINE_LABEL, balance: 0 }]
              ).map((line) => (
                <div key={line.type} className="mt-4" data-testid={`credit-line-${line.type}`}>
                  <div className="text-xs font-semibold" style={{ color: soft }}>
                    {line.label}
                  </div>
                  <div
                    className="font-extrabold tabular-nums"
                    style={{
                      fontSize: 30,
                      color: tick && line.type === 'bcredits' ? (light ? '#8A6400' : CARD.goldHi) : ink,
                      transition: 'color 0.6s ease',
                    }}
                    aria-live="polite"
                  >
                    {!info ? 'Loading…' : enabled ? fmtCredits(line.balance) : 'Coming soon'}
                  </div>
                  {line.type === 'bcredits' && enabled && info && (
                    <div className="text-xs mt-1" style={{ color: muted }}>
                      ≈ {fmtPence(line.balance * info.pencePerCredit)}
                      {pendingCredits ? ` · ${fmtCredits(pendingCredits)} pending` : ''}
                      {stopped ? ' · Stopped' : ''}
                    </div>
                  )}
                </div>
              ))}
              {enabled && (
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSheet('topup');
                    }}
                    className="rounded-xl px-4 py-2 text-sm font-bold"
                    style={{ background: GOLD, color: '#1a1300' }}
                  >
                    Top up
                  </button>
                </div>
              )}
            </>
          ) : (
            info && (
              <div className="mt-3 text-xs flex flex-col gap-1.5" style={{ color: soft }}>
                <div>Rate: what each b reply costs to run × {info.markup}, rounded up to whole bCredits.</div>
                <div>1 bCredit = {fmtPence(info.pencePerCredit)}. No expiry.</div>
                <div>Spent so far: {fmtCredits(spent)}</div>
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setCreditsStopped(!stopped);
                      setStopped(!stopped);
                      addSnackbar(stopped ? 'b can use bCredits again' : 'Stopped: b won’t spend bCredits', 'success');
                    }}
                    className="rounded-xl px-3 py-1.5 text-xs font-bold"
                    style={{ background: stopped ? GOLD : '#2A1010', color: stopped ? '#1a1300' : CARD.redSoft }}
                  >
                    {stopped ? 'Resume' : 'Stop'}
                  </button>
                  <a
                    onClick={(e) => e.stopPropagation()}
                    href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('bCredits')}`}
                    className="rounded-xl px-3 py-1.5 text-xs font-bold"
                    style={{ background: chip, color: ink }}
                  >
                    Contact
                  </a>
                </div>
              </div>
            )
          )}
        </div>
      </div>
      {sheet === 'topup' && info && (
        <TopUpSheet
          info={info}
          onClose={() => setSheet(null)}
          onSent={(txid, credits, outcome) => {
            if (outcome === 'pending') updatePending((p) => addPending(p, txid, credits));
            addSnackbar(
              outcome === 'credited'
                ? `Added ${fmtCredits(credits)}`
                : `Sent. ${fmtCredits(credits)} will be added after one confirmation (about ten minutes).`,
              'success',
            );
            setSheet(null);
            emitCreditsChanged();
          }}
        />
      )}
      {sheet === 'history' && <HistorySheet rows={rows} onClose={() => setSheet(null)} />}
    </>
  );
}

const TopUpSheet = ({
  info,
  onClose,
  onSent,
}: {
  info: CreditsInfo;
  onClose: () => void;
  onSent: (txid: string, credits: number, outcome: 'credited' | 'pending') => void;
}) => {
  const { apiContext } = useServiceContext();
  const [gbpPerBsv, setGbpPerBsv] = useState<number | null>(null);
  const [rateFailed, setRateFailed] = useState(false);
  const [pick, setPick] = useState<number>(TOP_UP_PRESETS_PENCE[1]);
  const [other, setOther] = useState('');
  const [approve, setApprove] = useState<TopUpPlan | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void liveGbpPerBsv().then((r) => {
      if (!live) return;
      setGbpPerBsv(r);
      setRateFailed(r === null);
    });
    return () => {
      live = false;
    };
  }, []);

  const pence = other.trim() ? (parsePounds(other) ?? 0) : pick;
  const planned = gbpPerBsv ? planTopUp(info, pence, gbpPerBsv) : null;

  const send = async (plan: TopUpPlan) => {
    if (!apiContext || !info.treasury || !info.depositReference) return;
    setError('');
    setBusy('Sending…');
    try {
      const res = await sendBsv.execute(apiContext, {
        requests: depositRequests(info.treasury, info.depositReference, plan.sats),
      });
      if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
      setBusy('Recording…');
      let outcome: 'credited' | 'pending' = 'pending';
      try {
        const client = await signedInClient(apiContext);
        outcome = depositOutcome(200, await client.depositCredits(res.txid)) === 'credited' ? 'credited' : 'pending';
      } catch {
        outcome = 'pending'; // sent on chain; the card retries posting the txid
      }
      onSent(res.txid, plan.credits, outcome);
    } catch (e) {
      setError(errText(e));
      setApprove(null);
    } finally {
      setBusy('');
    }
  };

  if (approve)
    return (
      <FullSheet>
        <ApprovalCard
          ours
          site="bWalletX"
          siteSub="bCredits for b"
          onClose={() => !busy && setApprove(null)}
          closeDisabled={!!busy}
          hero={<PayHero amount={fmtPence(approve.pence)} sub={fmtSats(approve.sats)} badge="TOP UP" />}
          title={
            <>
              Get <span style={{ color: CARD.gold }}>{fmtCredits(approve.credits)}</span>
            </>
          }
          primary={{ label: busy || 'Allow', onClick: () => void send(approve), busy: !!busy, disabled: !!busy }}
          secondary={{ label: 'Not now', onClick: () => setApprove(null), disabled: !!busy }}
          error={error || undefined}
        >
          <div className="flex flex-wrap gap-2">
            <Chip>Spent only on b</Chip>
            <Chip>No expiry</Chip>
            <Chip>Non-refundable</Chip>
            <Chip>Plus a small network fee</Chip>
          </div>
        </ApprovalCard>
      </FullSheet>
    );

  return (
    <Sheet title="Top up bCredits" onClose={onClose}>
      <div className="grid grid-cols-4 gap-2">
        {TOP_UP_PRESETS_PENCE.filter((p) => p <= info.topupCapPence).map((p) => (
          <button
            key={p}
            onClick={() => {
              setPick(p);
              setOther('');
            }}
            className="rounded-2xl py-3 text-sm font-bold"
            style={{
              background: !other.trim() && pick === p ? GOLD : '#17191E',
              color: !other.trim() && pick === p ? '#1a1300' : '#fff',
              border: `1px solid ${LINE}`,
            }}
          >
            {fmtPence(p)}
          </button>
        ))}
      </div>
      <input
        inputMode="decimal"
        value={other}
        onChange={(e) => setOther(e.target.value)}
        placeholder={`Other amount (£, up to ${fmtPence(info.topupCapPence)})`}
        className="w-full mt-2 rounded-2xl px-3 py-3 bg-transparent text-white outline-none"
        style={{ background: '#17191E', border: `1px solid ${LINE}` }}
      />
      <div className="text-xs mt-2 min-h-[16px]" style={{ color: MUTED }}>
        {rateFailed
          ? "The BSV price isn't available. Try again in a minute."
          : !planned
            ? 'Getting the BSV price…'
            : planned.ok
              ? `${fmtSats(planned.plan.sats)} for ${fmtCredits(planned.plan.credits)}, at today's BSV price`
              : planned.error}
      </div>
      <div
        className="rounded-2xl p-3 mt-3 text-[12px] leading-relaxed"
        style={{ background: '#17191E', color: '#D0D5DD' }}
      >
        <div className="font-semibold text-white mb-1">The terms, in plain words</div>
        <ul className="list-disc pl-4 flex flex-col gap-0.5">
          <li>bCredits pay for b, the bWalletX agent. Nothing else.</li>
          <li>1 bCredit = {fmtPence(info.pencePerCredit)}. You pay in BSV at today’s rate.</li>
          <li>
            Each b reply costs what it costs to run × {info.markup}, rounded up to whole bCredits. b never runs you into
            debt.
          </li>
          <li>No expiry. They can’t be cashed out, sent or spent anywhere else.</li>
          <li>Non-refundable except where the law requires.</li>
          <li>Top-ups are up to {fmtPence(info.topupCapPence)} each.</li>
        </ul>
        <div className="mt-2 font-semibold" style={{ color: CARD.gold }}>
          Top-ups pay for b. Keep it small.
        </div>
      </div>
      {error && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs mt-2" style={{ color: '#F97066' }}>
            {error}
          </div>
          <ErrorActions message={String(error)} />
        </div>
      )}
      <button
        onClick={() => planned?.ok && setApprove(planned.plan)}
        disabled={!planned?.ok}
        className="w-full mt-4 rounded-2xl py-3 font-bold disabled:opacity-50"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {planned?.ok ? `Top up ${fmtPence(planned.plan.pence)}` : 'Top up'}
      </button>
    </Sheet>
  );
};

const HistorySheet = ({ rows, onClose }: { rows: CreditEntry[] | null; onClose: () => void }) => (
  <Sheet title="bCredits history" onClose={onClose}>
    {!rows && (
      <div className="text-xs" style={{ color: MUTED }}>
        Loading…
      </div>
    )}
    {rows && !rows.length && (
      <div className="text-xs" style={{ color: MUTED }}>
        No bCredits activity yet.
      </div>
    )}
    {rows?.map((r) => (
      <div key={r.id} className="flex items-center justify-between py-2" style={{ borderBottom: `1px solid ${LINE}` }}>
        <div>
          <div className="text-sm text-white">{entryLabel(r)}</div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            {r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}
          </div>
        </div>
        <div className="text-sm font-semibold" style={{ color: r.kind === 'deposit' ? '#32D583' : '#FFFFFF' }}>
          {entryAmount(r)}
        </div>
      </div>
    ))}
  </Sheet>
);
