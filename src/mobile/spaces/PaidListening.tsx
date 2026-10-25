/**
 * Paid listening inside a Space (paidListen.ts). bWalletX only — SpaceScreen loads this lazily
 * behind PAID_LISTENING_ENABLED, so a store build never contains it.
 *
 *   speaker/host  their wallet tells bChatX where their share goes (receive + ordinals address)
 *   host          "Paid listening" sheet: price, unit, currency, destination, host share
 *   listener      one approval sheet with a session limit, then the wallet pays each minute
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { payForCharges, releasePayment } from '../chat/roomSpend';
import { useBsvUsd } from '../money/money';
import { ErrorActions } from '../errors/ErrorActions';
import {
  formatSpent,
  limitRaw,
  parsePaidState,
  payPlan,
  planTotal,
  shouldPay,
  type PaidClient,
  type PaidConfig,
  type PaidState,
} from './paidListen';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
const POLL_MS = 15_000;

type Props = { client: PaidClient; ticker: string; role: string };

export default function PaidListening({ client, ticker, role }: Props) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const bsvUsd = useBsvUsd();
  const [st, setSt] = useState<PaidState | null>(null);
  const [asked, setAsked] = useState(false);
  const [approved, setApproved] = useState(false);
  const [limitUsd, setLimitUsd] = useState('1');
  const [spent, setSpent] = useState(BigInt(0));
  const [minutes, setMinutes] = useState(0);
  const [error, setError] = useState('');
  const [stopped, setStopped] = useState<'' | 'limit'>('');
  const [settings, setSettings] = useState(false);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setSt(parsePaidState(await client.spacePaid(ticker)));
    } catch {
      /* next poll */
    }
  }, [client, ticker]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Speakers and the host: tell bChatX where your share goes (your own receive + ordinals address).
  useEffect(() => {
    if (role !== 'host' && role !== 'speaker') return;
    const acct = chromeStorageService?.getCurrentAccountObject?.()?.account as
      | { primaryAddress?: string; addresses?: { bsvAddress?: string; ordAddress?: string } }
      | undefined;
    const bsv = acct?.primaryAddress ?? acct?.addresses?.bsvAddress;
    const ord = acct?.addresses?.ordAddress;
    if (bsv || ord) void client.spacePaidAction(ticker, { action: 'payout', bsv, ord }).catch(() => undefined);
  }, [role, client, ticker, chromeStorageService]);

  const cfg = st?.config;
  const listener = role === 'listener' && !!cfg?.enabled && !!st?.me;
  const limit = cfg ? limitRaw(Number(limitUsd) || 0, cfg.currency, bsvUsd) : BigInt(0);

  // Pay each minute shortly before the paid time ends.
  useEffect(() => {
    if (!listener || !st) return;
    const step = shouldPay({
      approved,
      plan: st.plan,
      paidThrough: st.me?.paidThrough ?? null,
      now: Date.now(),
      spent,
      limit,
      busy: busy.current,
    });
    if (step === 'limit') {
      setStopped('limit');
      return;
    }
    if (step !== 'pay' || !st.plan || !st.sig) return;
    busy.current = true;
    const plan = st.plan;
    void payPlan(apiContext, client, plan, st.sig, { payForMessage: payForCharges, releasePayment })
      .then(() => {
        setSpent((s) => s + planTotal(plan));
        setMinutes((m) => m + 1);
        setError('');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        busy.current = false;
        void refresh();
      });
  }, [listener, st, approved, spent, limit, apiContext, client, refresh]);

  if (!cfg && !st?.canConfigure) return null;

  return (
    <>
      {st?.canConfigure && (
        <button
          onClick={() => setSettings(true)}
          className="mx-3 mt-2 self-start rounded-full px-3 py-1 text-xs font-semibold"
          style={{ border: `1px solid ${LINE}`, color: cfg?.enabled ? GOLD : MUTED }}
        >
          {cfg?.enabled ? `Paid listening · ${st.price}` : 'Paid listening: off'}
        </button>
      )}

      {listener && approved && (
        <div
          className="mx-3 mt-2 self-start rounded-full px-3 py-1 text-xs"
          style={{ background: '#1d1e23', color: '#fff' }}
        >
          {stopped === 'limit'
            ? `Limit reached · ${formatSpent(spent, cfg!.currency, bsvUsd)} paid`
            : `Paid ${formatSpent(spent, cfg!.currency, bsvUsd)} · ${minutes} min · ${st?.price}`}
        </div>
      )}

      {listener && st?.me && !st.me.hearing && (
        <div className="mx-3 mt-2 rounded-xl p-3 text-sm" style={{ background: '#2a1d0b', color: '#fff' }}>
          Top up to keep listening.{' '}
          <button
            className="underline"
            style={{ color: GOLD }}
            onClick={() => {
              setStopped('');
              setAsked(false);
              setApproved(false);
            }}
          >
            Continue
          </button>
        </div>
      )}

      {error && (
        <div className="mx-3 mt-2 rounded-xl p-3 text-sm" style={{ background: '#2a0f0f', color: '#fff' }}>
          <span className="select-text">Payment didn't go through: {error}</span>
          <ErrorActions message={`Paid listening: ${error}`} />
        </div>
      )}

      {listener && !asked && !st?.free && (
        <ApproveSheet
          price={st?.price ?? ''}
          dest={cfg!.dest}
          free={cfg!.freeFirstMinute}
          currency={cfg!.currency}
          limit={limitUsd}
          setLimit={setLimitUsd}
          onYes={() => {
            setAsked(true);
            setApproved(true);
          }}
          onNo={() => setAsked(true)}
        />
      )}

      {settings && (
        <SettingsSheet
          initial={cfg ?? null}
          onClose={() => setSettings(false)}
          onSave={async (next) => {
            await client.spacePaidAction(ticker, { action: 'config', config: next });
            setSettings(false);
            void refresh();
          }}
        />
      )}
    </>
  );
}

const destText = (d: PaidConfig['dest']) =>
  d === 'stage' ? 'split between the people on stage' : d === 'issuer' ? "paid to the token's issuer" : 'burned';

function ApproveSheet(p: {
  price: string;
  dest: PaidConfig['dest'];
  free: boolean;
  currency: PaidConfig['currency'];
  limit: string;
  setLimit: (v: string) => void;
  onYes: () => void;
  onNo: () => void;
}) {
  const unit = p.currency.kind === 'bsv' ? '$' : `$${p.currency.sym || 'tokens'} `;
  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/70 p-3">
      <div
        className="w-full max-w-md rounded-2xl p-5"
        style={{ background: '#0b0a08', border: `1px solid color-mix(in srgb, ${GOLD} 25%, transparent)` }}
      >
        <p className="text-lg font-bold text-white">Paid listening</p>
        <p className="mt-1 text-sm" style={{ color: MUTED }}>
          {p.price}, {destText(p.dest)}.{p.free ? ' The first minute is free.' : ''} Your wallet pays each minute
          directly; bChatX takes nothing.
        </p>
        <label className="mt-4 block text-sm text-white" htmlFor="paid-limit">
          Most I'll spend this session ({unit.trim()})
        </label>
        <input
          id="paid-limit"
          inputMode="decimal"
          value={p.limit}
          onChange={(e) => p.setLimit(e.target.value.replace(/[^0-9.]/g, ''))}
          className="mt-1 w-full rounded-full px-4 py-2 text-white"
          style={{ background: '#000', border: `1px solid ${LINE}` }}
        />
        <div className="mt-5 flex gap-2">
          <button
            onClick={p.onNo}
            className="flex-1 rounded-full py-2.5 font-semibold text-white"
            style={{ border: `1px solid ${LINE}` }}
          >
            Just the free minute
          </button>
          <button
            onClick={p.onYes}
            className="flex-1 rounded-full py-2.5 font-bold"
            style={{ background: GOLD, color: '#010101' }}
          >
            Pay {p.price.replace(/ a /, '/')}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsSheet({
  initial,
  onSave,
  onClose,
}: {
  initial: PaidConfig | null;
  onSave: (c: PaidConfig) => Promise<void>;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [amount, setAmount] = useState(String(initial?.amount ?? 0.01));
  const [per, setPer] = useState<PaidConfig['per']>(initial?.per ?? 'minute');
  const [kind, setKind] = useState<'bsv' | 'bsv21'>(initial?.currency.kind ?? 'bsv');
  const [tokenId, setTokenId] = useState(initial?.currency.kind === 'bsv21' ? initial.currency.tokenId : '');
  const [sym, setSym] = useState(initial?.currency.kind === 'bsv21' ? initial.currency.sym : '');
  const [dec, setDec] = useState(String(initial?.currency.kind === 'bsv21' ? initial.currency.dec : 0));
  const [dest, setDest] = useState<PaidConfig['dest']>(initial?.dest ?? 'stage');
  const [share, setShare] = useState(String(initial?.hostSharePct ?? 0));
  const [free, setFree] = useState(initial?.freeFirstMinute ?? true);
  const [issuer, setIssuer] = useState(initial?.issuerAddress ?? '');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const field = 'mt-1 w-full rounded-full px-4 py-2 text-white';
  const fs = { background: '#000', border: `1px solid ${LINE}` };

  const save = async () => {
    setErr('');
    setSaving(true);
    try {
      await onSave({
        enabled,
        amount: Number(amount),
        per,
        currency:
          kind === 'bsv'
            ? { kind: 'bsv' }
            : { kind: 'bsv21', tokenId: tokenId.trim(), sym: sym.trim(), dec: Number(dec) || 0 },
        dest,
        hostSharePct: Number(share) || 0,
        freeFirstMinute: free,
        issuerAddress: dest === 'issuer' ? issuer.trim() : undefined,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/70 p-3">
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl p-5"
        style={{ background: '#0b0a08', border: `1px solid color-mix(in srgb, ${GOLD} 25%, transparent)` }}
      >
        <p className="text-lg font-bold text-white">Paid listening</p>
        <label className="mt-3 flex items-center gap-2 text-sm text-white">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Charge listeners
        </label>
        <label className="mt-3 block text-sm text-white" htmlFor="pl-amount">
          Price
        </label>
        <div className="flex gap-2">
          <input
            id="pl-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={field}
            style={fs}
          />
          <select
            aria-label="Per"
            value={per}
            onChange={(e) => setPer(e.target.value as PaidConfig['per'])}
            className={field}
            style={fs}
          >
            <option value="second">per second</option>
            <option value="minute">per minute</option>
            <option value="hour">per hour</option>
          </select>
        </div>
        <label className="mt-3 block text-sm text-white" htmlFor="pl-kind">
          Paid in
        </label>
        <select
          id="pl-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'bsv' | 'bsv21')}
          className={field}
          style={fs}
        >
          <option value="bsv">BSV (price in dollars)</option>
          <option value="bsv21">A token (PNEE or any BSV-21)</option>
        </select>
        {kind === 'bsv21' && (
          <>
            <input
              aria-label="Token ID"
              placeholder="Token ID (txid_0)"
              value={tokenId}
              onChange={(e) => setTokenId(e.target.value)}
              className={field}
              style={fs}
            />
            <div className="flex gap-2">
              <input
                aria-label="Symbol"
                placeholder="Symbol"
                value={sym}
                onChange={(e) => setSym(e.target.value)}
                className={field}
                style={fs}
              />
              <input
                aria-label="Decimals"
                placeholder="Decimals"
                inputMode="numeric"
                value={dec}
                onChange={(e) => setDec(e.target.value)}
                className={field}
                style={fs}
              />
            </div>
          </>
        )}
        <label className="mt-3 block text-sm text-white" htmlFor="pl-dest">
          Goes to
        </label>
        <select
          id="pl-dest"
          value={dest}
          onChange={(e) => setDest(e.target.value as PaidConfig['dest'])}
          className={field}
          style={fs}
        >
          <option value="stage">Split between the people on stage</option>
          <option value="issuer">The token's issuer</option>
          {kind === 'bsv21' && <option value="burn">Burned</option>}
        </select>
        {dest === 'stage' && (
          <>
            <label className="mt-3 block text-sm text-white" htmlFor="pl-share">
              Host's share first (%)
            </label>
            <input
              id="pl-share"
              inputMode="numeric"
              value={share}
              onChange={(e) => setShare(e.target.value)}
              className={field}
              style={fs}
            />
          </>
        )}
        {dest === 'issuer' && (
          <input
            aria-label="Issuer address"
            placeholder="Issuer address (1…)"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            className={field}
            style={fs}
          />
        )}
        <label className="mt-3 flex items-center gap-2 text-sm text-white">
          <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} /> First minute free
        </label>
        <p className="mt-3 text-xs" style={{ color: MUTED }}>
          Listeners pay the speakers directly. bChatX takes nothing.
        </p>
        {err && (
          <div className="mt-2 text-sm" style={{ color: '#ff8a8a' }}>
            <span className="select-text">{err}</span>
            <ErrorActions message={`Paid listening settings: ${err}`} />
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-full py-2.5 font-semibold text-white"
            style={{ border: `1px solid ${LINE}` }}
          >
            Cancel
          </button>
          <button
            disabled={saving}
            onClick={() => void save()}
            className="flex-1 rounded-full py-2.5 font-bold"
            style={{ background: GOLD, color: '#010101' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
