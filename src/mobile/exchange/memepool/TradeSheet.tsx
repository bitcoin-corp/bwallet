import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, ShieldAlert, X } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useBackClose } from '../../backStack';
import { ErrorActions } from '../../errors/ErrorActions';
import { bsvLabel, fiatLabel } from '../exchangeData';
import { openExternal } from '../useTokenRowActions';
import type { MemepoolCoin } from '../memepool';
import { DEFAULT_SLIPPAGE_BPS, MEMEPOOL_PROOF_URL, SLIPPAGE_CHOICES } from './constants';
import { plainError } from './api';
import {
  TradeRefused,
  cancelPrepared,
  executeTrade,
  loadMarket,
  prepareBuy,
  prepareSell,
  watchSpend,
  watchTx,
  type Deps,
  type Prepared,
} from './trade';
import { memepoolWallet } from './wallet';

/**
 * Buy or sell one Memepool coin from this wallet (owner, 25 Oct 2026). One sheet, plain English, nothing to untick:
 * You pay · You get at least · Fees · Price can move by · who holds the pool, then one big Allow. Every number on it
 * is a hard limit the trade was checked against (memepool/validate.ts) before the sheet opened, and is checked again
 * before signing. Exchange only, so never in a store build (MARKET_ENABLED).
 */
const GOLD = '#F5C518';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';

type Phase =
  | { k: 'form' }
  | { k: 'working'; status: string }
  | { k: 'sheet'; p: Prepared; note?: string }
  | { k: 'done'; txid: string; seen: boolean }
  | { k: 'unsure'; message: string; txid?: string };

const fmtInt = (n: bigint) => n.toLocaleString('en-US');

export const MemepoolTradeSheet = ({
  coin,
  rate,
  onClose,
}: {
  coin: MemepoolCoin;
  rate: number;
  onClose: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [slip, setSlip] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [phase, setPhase] = useState<Phase>({ k: 'form' });
  const [error, setError] = useState('');
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const deps: Deps = useMemo(
    () => ({
      fetch: (u, i) => fetch(u, i),
      wallet: memepoolWallet(
        apiContext.wallet,
        apiContext.services as unknown as Parameters<typeof memepoolWallet>[1],
        coin.iconUrl,
      ),
    }),
    [apiContext, coin.iconUrl],
  );
  const busy = phase.k === 'working';
  const money = (sats: bigint) => fiatLabel(Number(sats), rate) || bsvLabel(Number(sats));
  const both = (sats: bigint) => `${bsvLabel(Number(sats))}${rate ? ` (${fiatLabel(Number(sats), rate)})` : ''}`;

  /** Close: a buy's set-aside BSV goes back into the wallet if the trade wasn't made. */
  const close = async () => {
    if (busy) return;
    if (phase.k === 'sheet') await cancelPrepared(deps, phase.p).catch(() => undefined);
    onClose();
  };
  useBackClose(!busy, () => void close());

  const parsed = useMemo(() => {
    if (side === 'sell') return /^\d{1,15}$/.test(amount.trim()) ? BigInt(amount.trim()) : BigInt(0);
    const m = amount.trim().match(/^(\d*)\.?(\d{0,8})$/);
    return m && (m[1] || m[2]) ? BigInt((m[1] || '0') + (m[2] || '').padEnd(8, '0')) : BigInt(0);
  }, [amount, side]);

  const review = async () => {
    setError('');
    setPhase({ k: 'working', status: 'Checking the coin and its proof of reserves…' });
    try {
      const m = await loadMarket(deps, coin.id);
      setPhase({
        k: 'working',
        status: side === 'buy' ? 'Setting your BSV aside for this trade…' : 'Getting a price…',
      });
      const p = side === 'buy' ? await prepareBuy(deps, m, parsed, slip) : await prepareSell(deps, m, parsed, slip);
      if (live.current) setPhase({ k: 'sheet', p });
      else await cancelPrepared(deps, p).catch(() => undefined);
    } catch (e) {
      setError(e instanceof TradeRefused ? e.why : plainError(e));
      setPhase({ k: 'form' });
    }
  };

  const allow = async (p: Prepared) => {
    setError('');
    setPhase({ k: 'working', status: 'Signing and sending…' });
    try {
      const r = await executeTrade(deps, p);
      if (r.kind === 'new-sheet') {
        // Never signed again without the user: show the new numbers on a fresh sheet.
        setPhase({
          k: 'sheet',
          p: r.prepared,
          note: r.brokeMinimum
            ? 'Someone traded first and the price moved past your limit. These are the new numbers.'
            : 'Someone traded first. These are the new numbers.',
        });
        return;
      }
      if (r.kind === 'unsure') {
        setPhase({ k: 'unsure', message: r.message });
        const spentBy = await watchSpend(deps, p.coins[0]);
        if (live.current && spentBy) setPhase({ k: 'unsure', message: 'The network has your trade.', txid: spentBy });
        if (spentBy)
          await deps.wallet
            .receive(spentBy, p.template, { ord: p.ord, pay: p.pay, sym: coin.sym, tokenId: coin.id })
            .catch(() => undefined);
        return;
      }
      setPhase({ k: 'done', txid: r.txid, seen: false });
      const seen = await watchTx(deps, r.txid);
      if (seen)
        await deps.wallet
          .receive(r.txid, p.template, { ord: p.ord, pay: p.pay, sym: coin.sym, tokenId: coin.id })
          .catch(() => undefined);
      if (live.current) setPhase({ k: 'done', txid: r.txid, seen });
    } catch (e) {
      setError(e instanceof TradeRefused ? e.why : plainError(e));
      setPhase({ k: 'form' });
    }
  };

  const row = (label: string, value: string, strong = false) => (
    <div className="flex justify-between gap-3 py-1.5">
      <span className="text-sm" style={{ color: MUTED }}>
        {label}
      </span>
      <span className={`text-right ${strong ? 'text-lg font-extrabold' : 'text-sm font-semibold'} text-white`}>
        {value}
      </span>
    </div>
  );

  const sheet = (p: Prepared, note?: string) => {
    const c = p.checked;
    const buy = p.side === 'buy';
    return (
      <div className="flex flex-col gap-3">
        {note && (
          <p className="m-0 text-sm rounded-xl p-3" style={{ background: '#3a2f0b', color: GOLD }}>
            {note}
          </p>
        )}
        <div className="text-base font-extrabold text-white">
          {buy ? 'Buy' : 'Sell'} ${coin.sym} on Memepool
        </div>
        <div className="rounded-2xl p-4 border" style={{ borderColor: LINE, background: '#0F1013' }}>
          {buy
            ? row('You pay', `at most ${both(p.maxSpend)}`, true)
            : row('You pay', `${fmtInt(c.tokens)} $${coin.sym}`, true)}
          {buy
            ? row('You get at least', `${fmtInt((p.limits as { minTokens: bigint }).minTokens)} $${coin.sym}`, true)
            : row('You get at least', both((p.limits as { minSats: bigint }).minSats), true)}
          {row(
            'Fees',
            `1.25% (${money(c.fee)}): Memepool 0.95%, creator 0.30%. Plus network ${money(c.networkFee + c.indexFee)}`,
          )}
          {row('Price can move by', `up to ${(p.slippageBps / 100).toFixed(0)}%`)}
          {buy && row('Expected', `${fmtInt(c.tokens)} $${coin.sym}`)}
        </div>
        <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: '#1b1d22' }}>
          <ShieldAlert size={18} color={GOLD} className="shrink-0 mt-0.5" />
          <div className="text-sm text-white">
            The pool is held by Memepool (their server), not a contract.{' '}
            <button
              type="button"
              onClick={() => openExternal(MEMEPOOL_PROOF_URL)}
              className="inline-flex items-center gap-1 bg-transparent border-0 p-0 font-bold cursor-pointer"
              style={{ color: GOLD }}
            >
              Proof of reserves <ExternalLink size={12} />
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void allow(p)}
          className="w-full rounded-2xl py-4 text-lg font-extrabold border-0 cursor-pointer"
          style={{ background: GOLD, color: '#000' }}
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => void close()}
          className="w-full rounded-2xl py-3 text-sm font-bold bg-transparent cursor-pointer border"
          style={{ borderColor: LINE, color: '#fff' }}
        >
          Cancel
        </button>
      </div>
    );
  };

  const form = (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Buy or sell">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            onClick={() => {
              setSide(s);
              setAmount('');
            }}
            className="rounded-xl py-2.5 text-sm font-bold cursor-pointer border"
            style={{
              background: side === s ? GOLD : 'transparent',
              color: side === s ? '#000' : '#fff',
              borderColor: side === s ? GOLD : LINE,
            }}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-sm" style={{ color: MUTED }}>
        {side === 'buy' ? 'BSV to spend (up to 1 BSV)' : `$${coin.sym} to sell`}
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={side === 'buy' ? '0.01' : '1000000'}
          className="w-full h-12 rounded-xl px-3 text-base text-white outline-none border bg-[#0F1013]"
          style={{ borderColor: LINE }}
        />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-sm" style={{ color: MUTED }}>
          Price can move by
        </span>
        <div className="grid grid-cols-4 gap-2">
          {SLIPPAGE_CHOICES.map((bps) => (
            <button
              key={bps}
              type="button"
              aria-pressed={slip === bps}
              onClick={() => setSlip(bps)}
              className="rounded-xl py-2 text-sm font-bold cursor-pointer border"
              style={{
                background: slip === bps ? '#2b2f36' : 'transparent',
                color: '#fff',
                borderColor: slip === bps ? GOLD : LINE,
              }}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        disabled={parsed <= BigInt(0)}
        onClick={() => void review()}
        className="w-full rounded-2xl py-3.5 text-base font-extrabold border-0 cursor-pointer disabled:opacity-40"
        style={{ background: GOLD, color: '#000' }}
      >
        Review {side === 'buy' ? 'buy' : 'sell'}
      </button>
      <p className="m-0 text-[11px]" style={{ color: MUTED }}>
        Memecoins can go to zero. Nothing is signed until you press Allow.
      </p>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-end bg-black/60" onClick={() => void close()}>
      <div
        role="dialog"
        aria-label={`Trade $${coin.sym}`}
        className="w-full max-h-[90vh] overflow-y-auto rounded-t-2xl px-5 pt-5 flex flex-col gap-3 border-t"
        style={{
          background: 'var(--bw-surface)',
          borderColor: LINE,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-base font-bold text-white overflow-hidden text-ellipsis whitespace-nowrap">
            ${coin.sym} <span style={{ color: MUTED }}>{coin.name}</span>
          </div>
          <button
            aria-label="Close"
            onClick={() => void close()}
            disabled={busy}
            className="p-1 bg-transparent border-0"
          >
            <X size={18} color={MUTED} />
          </button>
        </div>
        {error && (
          <div
            className="rounded-xl p-3 text-sm flex flex-col gap-2"
            style={{ background: '#3b1414', color: '#ffb4b4' }}
          >
            <span>{error}</span>
            <ErrorActions message={error} color="#ffb4b4" />
          </div>
        )}
        {phase.k === 'form' && form}
        {phase.k === 'working' && (
          <p className="text-sm text-center py-8 m-0" style={{ color: MUTED }}>
            {phase.status}
          </p>
        )}
        {phase.k === 'sheet' && sheet(phase.p, phase.note)}
        {phase.k === 'done' && (
          <div className="flex flex-col gap-3 py-4 text-center">
            <div className="text-lg font-extrabold text-white">Trade sent</div>
            <p className="m-0 text-sm" style={{ color: MUTED }}>
              {phase.seen ? 'The network has it. It shows in your wallet shortly.' : 'Waiting for the network…'}
            </p>
            <button
              type="button"
              onClick={() => openExternal(`https://whatsonchain.com/tx/${phase.txid}`)}
              className="bg-transparent border-0 text-sm font-bold cursor-pointer"
              style={{ color: GOLD }}
            >
              View transaction
            </button>
          </div>
        )}
        {phase.k === 'unsure' && (
          <div className="flex flex-col gap-3 py-4 text-center">
            <p className="m-0 text-sm text-white">{phase.message}</p>
            {phase.txid && (
              <button
                type="button"
                onClick={() => openExternal(`https://whatsonchain.com/tx/${phase.txid}`)}
                className="bg-transparent border-0 text-sm font-bold cursor-pointer"
                style={{ color: GOLD }}
              >
                View transaction
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
