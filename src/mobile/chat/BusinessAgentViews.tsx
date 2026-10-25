/**
 * Business agents in a room (logic: ./businessAgent.ts).
 *
 *   - OrderCard: the agent's order in the chat. The customer taps Pay → the wallet's approval card
 *     (one sheet: amount, who gets it, "proposed by an AI agent") → Allow sends from THIS wallet.
 *     Nothing pays without that tap.
 *   - BusinessSheet: the host's "Set up your business agent" (paste a link → review the draft →
 *     publish) and the Orders list (refund = a normal send from the host's own wallet).
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { RoomLook } from './roomLook';
import { BIZ_AGENT_ACCOUNT_ENABLED } from '../storeBuild';
import { createPortal } from 'react-dom';
import { sendBsv } from '../../utils/guardedSendBsv';
import { Bot, Plus, Trash2, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getErrorMessage } from '../../utils/tools';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { CARD } from '../../components/approval/cardTheme';
import { celebrateSend } from '../../components/sent/sent';
import { useBackClose } from '../backStack';
import type { BchatClient } from './api';
import {
  AI_LABEL,
  ORDER_MAX_USD,
  cancelOrder,
  checkPaySpec,
  disableBusiness,
  draftBusiness,
  emptyProfile,
  fmtUsd,
  getBusiness,
  getOrder,
  isExpired,
  listOrders,
  looksLikeUrl,
  parsePriceInput,
  payRequests,
  recordOrderPayment,
  recordRefund,
  recordWithRetry,
  refundCheck,
  saveBusiness,
  type BizProfile,
  type BizState,
  type OrderCardInfo,
  type OrderRow,
  type OrderStatus,
  type PaySpec,
} from './businessAgent';

const GOLD = '#d4af37';
const MUTED = '#8a8576';
const LINE = '#2a2618';
const PANEL = '#161410';
// Business agent account (capped, Stop): bWalletX only, a lazy chunk behind the inlined flag (STORE-AUDIT.md).
const BizAgentAccount = BIZ_AGENT_ACCOUNT_ENABLED ? lazy(() => import('../agents/business/BizAgentAccount')) : null;
const AgentRefundButton = BIZ_AGENT_ACCOUNT_ENABLED
  ? lazy(() => import('../agents/business/BizAgentAccount').then((m) => ({ default: m.AgentRefundButton })))
  : null;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sats = (n: number) => `${n.toLocaleString('en-US')} sats`;

/** The agent's label. In a game's themed room (chat/roomLook.ts) it carries the game's name and colours. */
export const AiLabel = ({ look }: { look?: Pick<RoomLook, 'name' | 'accent' | 'onAccent'> | null } = {}) => (
  <span
    className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-[1px] rounded"
    style={
      look
        ? { background: look.accent, color: look.onAccent, border: `1px solid ${look.accent}` }
        : { background: '#2b2410', color: GOLD, border: `1px solid ${LINE}` }
    }
  >
    <Bot size={10} /> {look ? `${look.name} · ${AI_LABEL}`.toUpperCase() : AI_LABEL.toUpperCase()}
  </span>
);

const FullSheet = ({ children }: { children: React.ReactNode }) =>
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

const STATUS: Record<OrderStatus, { word: string; color: string }> = {
  proposed: { word: 'Awaiting payment', color: GOLD },
  paid: { word: 'Paid', color: '#32D583' },
  cancelled: { word: 'Cancelled', color: MUTED },
  refunded: { word: 'Refunded', color: '#53B1FD' },
};

/** The agent's order in the room. */
export const OrderCard = ({
  info,
  status,
  client,
  ticker,
  me,
  onChanged,
}: {
  info: OrderCardInfo;
  status: OrderStatus;
  client: BchatClient;
  ticker: string;
  me: string;
  onChanged: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [approve, setApprove] = useState<{ spec: PaySpec; paymail: string | null } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [unrecorded, setUnrecorded] = useState<string | null>(null);
  const mine = info.customer === me;
  const expired = status === 'proposed' && isExpired(info.expiresAt);
  const shown = expired ? { word: 'Expired', color: MUTED } : STATUS[status];

  const start = async () => {
    setBusy('Checking…');
    setError('');
    try {
      const d = await getOrder(client, ticker, info.orderId);
      const c = checkPaySpec(d, me, info);
      if (!c.ok) throw new Error(c.why);
      setApprove({ spec: c.spec, paymail: d.order.pay_to_paymail ?? null });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const record = async (txid: string) => {
    const ok = await recordWithRetry(() => recordOrderPayment(client, ticker, info.orderId, txid));
    setUnrecorded(ok ? null : txid);
    if (ok) onChanged();
    return ok;
  };

  const pay = async () => {
    if (!approve) return;
    setBusy('Sending…');
    setError('');
    try {
      const res = await sendBsv.execute(apiContext, { requests: payRequests(approve.spec) });
      if (!res.txid || res.error) throw new Error(getErrorMessage(res.error) || 'Payment failed');
      setApprove(null);
      setBusy('Recording…');
      const ok = await record(res.txid);
      const shownSent = celebrateSend(res.txid, {
        amount: { kind: 'token', display: fmtUsd(info.totalUsd), ticker: '' },
        recipients: [`$${info.business}`],
        title: 'Paid!',
      });
      if (!shownSent)
        addSnackbar(
          ok ? `Paid $${info.business}` : 'Paid. Recording the receipt failed; tap Retry.',
          ok ? 'success' : 'error',
        );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const cancel = async () => {
    setBusy('Cancelling…');
    try {
      await cancelOrder(client, ticker, info.orderId);
      onChanged();
    } catch (e) {
      setError(errText(e));
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
          siteSub={`Order in $${ticker}`}
          onClose={() => !busy && setApprove(null)}
          closeDisabled={!!busy}
          hero={<PayHero amount={fmtUsd(info.totalUsd)} sub={sats(approve.spec.sats)} badge="ORDER" />}
          title={
            <>
              Pay <span style={{ color: CARD.gold }}>${info.business}</span>
            </>
          }
          primary={{ label: busy || 'Allow', onClick: () => void pay(), busy: !!busy, disabled: !!busy }}
          secondary={{ label: 'Not now', onClick: () => setApprove(null), disabled: !!busy }}
          error={error || undefined}
          details={
            <div className="text-[12px] break-all" style={{ color: CARD.soft }}>
              {info.lines.map((l) => (
                <div key={l.id}>
                  {l.qty} × {l.name} — {fmtUsd(l.unitUsd * l.qty)}
                </div>
              ))}
              <div className="mt-2">To: {approve.paymail || `$${info.business}`}</div>
              <div>Address: {approve.spec.address}</div>
              <div>Reference: {approve.spec.reference}</div>
            </div>
          }
        >
          <div className="flex flex-wrap gap-2">
            <Chip>{info.lines.reduce((n, l) => n + l.qty, 0)} item(s)</Chip>
            <Chip>Proposed by an AI agent</Chip>
            <Chip>Straight to the business</Chip>
            <Chip>Plus a small network fee</Chip>
          </div>
        </ApprovalCard>
      </FullSheet>
    );

  return (
    <div className="flex justify-start my-2">
      <div className="rounded-2xl p-3 max-w-[88%] w-[320px]" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="text-[12px] font-semibold text-white">Order for ${info.customer}</span>
          <AiLabel />
        </div>
        {info.lines.map((l) => (
          <div key={l.id} className="flex justify-between text-[13px]" style={{ color: '#e8e2d2' }}>
            <span>
              {l.qty} × {l.name}
            </span>
            <span>{fmtUsd(l.unitUsd * l.qty)}</span>
          </div>
        ))}
        {info.note && (
          <div className="text-[11px] mt-1" style={{ color: MUTED }}>
            “{info.note}”
          </div>
        )}
        <div
          className="flex justify-between mt-2 pt-2 text-[13px] font-bold"
          style={{ borderTop: `1px solid ${LINE}` }}
        >
          <span className="text-white">Total</span>
          <span style={{ color: GOLD }}>
            {fmtUsd(info.totalUsd)}{' '}
            <span className="font-normal text-[11px]" style={{ color: MUTED }}>
              ≈ {sats(info.sats)}
            </span>
          </span>
        </div>
        <div className="text-[11px] mt-1.5" style={{ color: shown.color }}>
          {shown.word}
        </div>
        {mine && status === 'proposed' && !expired && (
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => void start()}
              disabled={!!busy}
              className="flex-1 rounded-xl py-2 text-sm font-bold disabled:opacity-50"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              {busy || `Pay ${fmtUsd(info.totalUsd)}`}
            </button>
            <button
              onClick={() => void cancel()}
              disabled={!!busy}
              className="rounded-xl px-3 text-sm"
              style={{ background: '#222', color: MUTED }}
            >
              Cancel
            </button>
          </div>
        )}
        {unrecorded && (
          <button onClick={() => void record(unrecorded)} className="mt-2 text-xs underline" style={{ color: GOLD }}>
            Paid on chain; retry saving the receipt
          </button>
        )}
        {error && <div className="text-[11px] mt-1.5 text-[#F97066]">{error}</div>}
      </div>
    </div>
  );
};

// ── The business sheet: setup (owner), what they sell (everyone), orders ──

const Field = ({
  label,
  value,
  onChange,
  area,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  area?: boolean;
  placeholder?: string;
}) => (
  <label className="block mt-2">
    <span className="text-[11px]" style={{ color: MUTED }}>
      {label}
    </span>
    {area ? (
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full mt-0.5 rounded-xl px-3 py-2 text-sm text-white outline-none"
        style={{ background: '#111', border: `1px solid ${LINE}` }}
      />
    ) : (
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full mt-0.5 rounded-xl px-3 py-2 text-sm text-white outline-none"
        style={{ background: '#111', border: `1px solid ${LINE}` }}
      />
    )}
  </label>
);

const ProfileEditor = ({ p, set }: { p: BizProfile; set: (p: BizProfile) => void }) => {
  const [prices, setPrices] = useState<string[]>(() =>
    p.items.map((i) => (i.priceUsd == null ? '' : String(i.priceUsd))),
  );
  const item = (i: number, patch: Partial<BizProfile['items'][number]>) =>
    set({ ...p, items: p.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const faq = (i: number, patch: Partial<BizProfile['faqs'][number]>) =>
    set({ ...p, faqs: p.faqs.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div>
      <Field label="Business name" value={p.name} onChange={(v) => set({ ...p, name: v })} />
      <Field label="What you do" value={p.summary} onChange={(v) => set({ ...p, summary: v })} area />
      <Field label="Hours" value={p.hours} onChange={(v) => set({ ...p, hours: v })} />
      <Field
        label="Tone (how the agent should sound)"
        value={p.tone}
        onChange={(v) => set({ ...p, tone: v })}
        placeholder="Friendly, short"
      />
      <div className="flex items-center justify-between mt-4">
        <span className="text-white text-sm font-semibold">Products & services</span>
        <button
          onClick={() => {
            set({ ...p, items: [...p.items, { name: '', description: '', priceUsd: null }] });
            setPrices([...prices, '']);
          }}
          className="p-1"
          aria-label="Add item"
        >
          <Plus size={18} color={GOLD} />
        </button>
      </div>
      <div className="text-[11px]" style={{ color: MUTED }}>
        Only items with a USD price can be ordered in chat (up to ${ORDER_MAX_USD} an order).
      </div>
      {p.items.map((it, i) => (
        <div key={i} className="rounded-xl p-2 mt-2" style={{ background: '#111', border: `1px solid ${LINE}` }}>
          <div className="flex gap-2">
            <input
              value={it.name}
              placeholder="Name"
              onChange={(e) => item(i, { name: e.target.value })}
              className="flex-1 min-w-0 bg-transparent text-sm text-white outline-none"
            />
            <input
              value={prices[i] ?? ''}
              placeholder="$ price"
              inputMode="decimal"
              onChange={(e) => {
                const next = [...prices];
                next[i] = e.target.value;
                setPrices(next);
                item(i, { priceUsd: parsePriceInput(e.target.value) });
              }}
              className="w-20 bg-transparent text-sm text-right outline-none"
              style={{ color: GOLD }}
            />
            <button
              onClick={() => {
                set({ ...p, items: p.items.filter((_, j) => j !== i) });
                setPrices(prices.filter((_, j) => j !== i));
              }}
              aria-label="Remove item"
            >
              <Trash2 size={15} color={MUTED} />
            </button>
          </div>
          <input
            value={it.description}
            placeholder="Short description"
            onChange={(e) => item(i, { description: e.target.value })}
            className="w-full bg-transparent text-[12px] outline-none mt-1"
            style={{ color: MUTED }}
          />
        </div>
      ))}
      <div className="flex items-center justify-between mt-4">
        <span className="text-white text-sm font-semibold">FAQs</span>
        <button onClick={() => set({ ...p, faqs: [...p.faqs, { q: '', a: '' }] })} className="p-1" aria-label="Add FAQ">
          <Plus size={18} color={GOLD} />
        </button>
      </div>
      {p.faqs.map((f, i) => (
        <div key={i} className="rounded-xl p-2 mt-2" style={{ background: '#111', border: `1px solid ${LINE}` }}>
          <div className="flex gap-2">
            <input
              value={f.q}
              placeholder="Question"
              onChange={(e) => faq(i, { q: e.target.value })}
              className="flex-1 bg-transparent text-sm text-white outline-none"
            />
            <button onClick={() => set({ ...p, faqs: p.faqs.filter((_, j) => j !== i) })} aria-label="Remove FAQ">
              <Trash2 size={15} color={MUTED} />
            </button>
          </div>
          <input
            value={f.a}
            placeholder="Answer"
            onChange={(e) => faq(i, { a: e.target.value })}
            className="w-full bg-transparent text-[12px] outline-none mt-1"
            style={{ color: MUTED }}
          />
        </div>
      ))}
    </div>
  );
};

const OrdersList = ({ client, ticker, me }: { client: BchatClient; ticker: string; me: string }) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await listOrders(client, ticker);
      setOrders(r.orders);
      setIsOwner(r.isOwner);
    } catch (e) {
      setError(errText(e));
      setOrders([]);
    }
  }, [client, ticker]);
  useEffect(() => {
    void load();
  }, [load]);

  /** A refund is an ordinary send from the business's own wallet, then the txid is recorded. */
  const refund = async (o: OrderRow) => {
    setBusy(o.id);
    setError('');
    try {
      const c = refundCheck(await getOrder(client, ticker, o.id), me);
      if (!c.ok) throw new Error(c.why);
      if (
        !window.confirm(
          `Refund ${sats(Number(o.sats))} (${fmtUsd(Number(o.total_usd))}) to $${o.customer_handle} from your wallet?`,
        )
      )
        return;
      const res = await sendBsv.execute(apiContext, {
        requests: [
          { address: c.address, satoshis: Number(o.sats) },
          { satoshis: 0, data: c.data },
        ],
      });
      if (!res.txid || res.error) throw new Error(getErrorMessage(res.error) || 'Refund failed');
      const ok = await recordWithRetry(() => recordRefund(client, ticker, o.id, res.txid!));
      addSnackbar(
        ok ? `Refunded $${o.customer_handle}` : 'Refund sent; recording it failed. Try again from Orders.',
        ok ? 'success' : 'error',
      );
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  if (!orders)
    return (
      <div className="text-xs py-6 text-center" style={{ color: MUTED }}>
        Loading orders…
      </div>
    );
  if (!orders.length)
    return (
      <div className="text-xs py-6 text-center" style={{ color: MUTED }}>
        No orders yet.
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      {orders.map((o) => {
        const st =
          o.status === 'proposed' && isExpired(o.expires_at) ? { word: 'Expired', color: MUTED } : STATUS[o.status];
        return (
          <div
            key={o.id}
            className="rounded-2xl p-3 text-[13px]"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <div className="flex justify-between">
              <span className="text-white font-semibold">
                {isOwner ? `$${o.customer_handle}` : `$${o.business_handle}`}
              </span>
              <span style={{ color: GOLD }}>{fmtUsd(Number(o.total_usd))}</span>
            </div>
            <div className="text-[11px]" style={{ color: MUTED }}>
              {new Date(o.created_at).toLocaleString()} · {sats(Number(o.sats))}
            </div>
            <div className="text-[11px] mt-1" style={{ color: st.color }}>
              {st.word}
            </div>
            {o.paid_txid && (
              <a
                href={`https://whatsonchain.com/tx/${o.paid_txid}`}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] underline break-all"
                style={{ color: MUTED }}
              >
                Receipt {o.paid_txid.slice(0, 16)}…
              </a>
            )}
            {o.refund_txid && (
              <div className="text-[11px] break-all" style={{ color: MUTED }}>
                Refund {o.refund_txid.slice(0, 16)}…
              </div>
            )}
            {isOwner && o.status === 'paid' && o.refund_to && (
              <button
                onClick={() => void refund(o)}
                disabled={!!busy}
                className="mt-2 rounded-xl px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                style={{ border: `1px solid ${GOLD}`, color: GOLD }}
              >
                {busy === o.id ? 'Refunding…' : 'Refund from my wallet'}
              </button>
            )}
            {AgentRefundButton && isOwner && o.status === 'paid' && o.refund_to && (
              <Suspense fallback={null}>
                <AgentRefundButton
                  ticker={ticker}
                  resolve={async () => {
                    const c = refundCheck(await getOrder(client, ticker, o.id), me);
                    if (!c.ok) throw new Error(c.why);
                    return { address: c.address, data: c.data };
                  }}
                  sats={Number(o.sats)}
                  label={`Refund $${o.customer_handle}`}
                  disabled={!!busy}
                  onPaid={async (txid) => {
                    const ok = await recordWithRetry(() => recordRefund(client, ticker, o.id, txid));
                    addSnackbar(
                      ok
                        ? `Refunded $${o.customer_handle}`
                        : 'Refund sent; recording it failed. Try again from Orders.',
                      ok ? 'success' : 'error',
                    );
                    await load();
                  }}
                />
              </Suspense>
            )}
          </div>
        );
      })}
      {error && <div className="text-xs text-[#F97066]">{error}</div>}
    </div>
  );
};

export const BusinessSheet = ({
  client,
  ticker,
  me,
  onClose,
}: {
  client: BchatClient;
  ticker: string;
  me: string;
  onClose: () => void;
}) => {
  useBackClose(true, onClose);
  const { addSnackbar } = useSnackbar();
  const [state, setState] = useState<BizState | null>(null);
  const [tab, setTab] = useState<'about' | 'setup' | 'orders' | 'agent'>('about');
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState<BizProfile | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await getBusiness(client, ticker);
      setState(s);
      if (s.canEdit) {
        setDraft(s.config?.draft ?? s.config?.profile ?? null);
        setUrl(s.config?.draft?.sourceUrl || s.config?.profile?.sourceUrl || '');
        if (!s.agent) setTab('setup');
      }
    } catch (e) {
      setError(errText(e));
    }
  }, [client, ticker]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const canEdit = !!state?.canEdit;
  const agent = state?.agent;
  const cfg = state?.config;

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-4 max-h-[88vh] overflow-y-auto"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-semibold flex items-center gap-2">
            {agent?.name || 'Business'} <AiLabel />
          </span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        <div className="flex gap-2 mb-3">
          {(
            [
              'about',
              ...(canEdit ? ['setup'] : []),
              'orders',
              ...(canEdit && BizAgentAccount ? ['agent'] : []),
            ] as const
          ).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t as typeof tab)}
              className="px-3 py-1 rounded-full text-xs font-semibold"
              style={tab === t ? { background: GOLD, color: '#1a1300' } : { border: `1px solid ${LINE}`, color: MUTED }}
            >
              {t === 'about'
                ? 'What they sell'
                : t === 'setup'
                  ? 'Set up'
                  : t === 'agent'
                    ? 'Agent account'
                    : canEdit
                      ? 'Orders'
                      : 'My orders'}
            </button>
          ))}
        </div>

        {!state && !error && (
          <div className="text-xs py-6 text-center" style={{ color: MUTED }}>
            Loading…
          </div>
        )}

        {state &&
          tab === 'about' &&
          (agent ? (
            <div className="text-[13px]" style={{ color: '#e8e2d2' }}>
              <p>{agent.summary}</p>
              {agent.hours && (
                <p className="mt-1 text-[12px]" style={{ color: MUTED }}>
                  Hours: {agent.hours}
                </p>
              )}
              {agent.items.map((i) => (
                <div key={i.id} className="flex justify-between mt-2">
                  <span>{i.name}</span>
                  <span style={{ color: GOLD }}>{i.priceUsd != null ? fmtUsd(i.priceUsd) : '—'}</span>
                </div>
              ))}
              <p className="text-[11px] mt-3" style={{ color: MUTED }}>
                Ask ${agent.handle} in the chat to order. It is an AI agent: it proposes, your wallet asks before
                anything is paid.
              </p>
            </div>
          ) : (
            <div className="text-xs py-4" style={{ color: MUTED }}>
              {canEdit
                ? 'No business agent yet. Open Set up to make one from your website.'
                : 'This room has no business agent.'}
            </div>
          ))}

        {state && tab === 'agent' && canEdit && BizAgentAccount && (
          <Suspense fallback={null}>
            <BizAgentAccount ticker={ticker} />
          </Suspense>
        )}

        {state && tab === 'setup' && canEdit && (
          <div>
            <div className="text-[13px] text-white font-semibold">Set up your business agent</div>
            <div className="text-[11px] mb-2" style={{ color: MUTED }}>
              Paste your website. We read it once and draft what your agent knows; you check it before it goes live.
            </div>
            <div className="flex gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="yourbusiness.com"
                inputMode="url"
                className="flex-1 min-w-0 rounded-xl px-3 py-2 text-sm text-white outline-none"
                style={{ background: '#111', border: `1px solid ${LINE}` }}
              />
              <button
                disabled={!!busy || !looksLikeUrl(url)}
                onClick={() => void run('Reading…', async () => setDraft(await draftBusiness(client, ticker, url)))}
                className="rounded-xl px-3 text-sm font-bold disabled:opacity-50"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                {busy === 'Reading…' ? busy : 'Draft'}
              </button>
            </div>
            {!draft && (
              <button
                onClick={() => setDraft(emptyProfile())}
                className="mt-2 text-xs underline"
                style={{ color: MUTED }}
              >
                Or write it by hand
              </button>
            )}
            <div
              className="rounded-xl p-2 mt-3 text-[11px]"
              style={{ background: '#111', color: cfg?.payments.ready ? '#32D583' : '#F5C542' }}
            >
              {cfg?.payments.ready
                ? `Payments go straight to ${cfg.payments.paymail} (your bWalletX). No one else can change that.`
                : 'Payments are not set up: open bWalletX signed in to this account so your receive address is registered. Until then the agent answers but cannot take orders.'}
            </div>
            {draft && (
              <>
                <ProfileEditor key={draft.sourceUrl + draft.items.length} p={draft} set={setDraft} />
                <div className="flex gap-2 mt-4">
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void run('Saving…', async () => {
                        await saveBusiness(client, ticker, draft, false);
                        addSnackbar('Draft saved', 'success');
                      })
                    }
                    className="flex-1 rounded-2xl py-3 font-bold text-white disabled:opacity-50"
                    style={{ background: PANEL }}
                  >
                    Save draft
                  </button>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void run('Publishing…', async () => {
                        await saveBusiness(client, ticker, draft, true);
                        addSnackbar('Your business agent is live', 'success');
                        await load();
                        setTab('about');
                      })
                    }
                    className="flex-1 rounded-2xl py-3 font-bold disabled:opacity-50"
                    style={{ background: GOLD, color: '#1a1300' }}
                  >
                    {busy === 'Publishing…' ? busy : 'Publish'}
                  </button>
                </div>
                {cfg?.enabled && (
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void run('Turning off…', async () => {
                        await disableBusiness(client, ticker);
                        await load();
                      })
                    }
                    className="w-full mt-2 text-xs underline"
                    style={{ color: MUTED }}
                  >
                    Turn the agent off
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {state && tab === 'orders' && <OrdersList client={client} ticker={ticker} me={me} />}
        {error && <div className="text-xs mt-2 text-[#F97066]">{error}</div>}
      </div>
    </div>,
    document.body,
  );
};
