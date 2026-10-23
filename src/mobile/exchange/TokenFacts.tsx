/**
 * Token page facts (market plan PR 1): the committed launch curve (verified), price now vs the 1¢ floor,
 * % sold when known, holders (count + top), and the token's room with its gate rule.
 * Copy rule: no profit / price-goes-up wording. "Early seats", "be early in rooms you care about".
 */
import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, ShieldCheck } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { usd, type Curve } from '../../lib/curves';
import { formatAmount, roomMeta } from '../market/indexer';
import { cachedExchangeRate } from '../../utils/exchangeRate';
import { useServiceContext } from '../../hooks/useServiceContext';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { curvePoints, tokenCurve, tokenHolders, vsFloor, type HolderInfo, type TokenCurve } from '../market/tokenPage';

const MUTED = '#98A2B3';
const GOLD = 'var(--bw-accent)';
const CARD = 'rounded-2xl bg-[var(--bw-surface)] border border-[#2b2f36]';
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Small SVG of the curve: price (USD) against share of supply sold; a dot for the market price if on scale. */
export const CurveChart = ({ curve, marketUsd }: { curve: Curve; marketUsd: number | null }) => {
  const pts = useMemo(() => curvePoints(curve), [curve]);
  const W = 300;
  const H = 90;
  const max = Math.max(...pts.map((p) => p[1]));
  const y = (v: number) => H - 6 - (v / (max || 1)) * (H - 12);
  const d = pts.map(([f, v], i) => `${i ? 'L' : 'M'}${(f * W).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const onScale = marketUsd !== null && marketUsd <= max;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[90px]" role="img" aria-label="Launch curve">
      <line x1={0} x2={W} y1={y(curve.floorUsd)} y2={y(curve.floorUsd)} stroke="#2b2f36" strokeDasharray="3 3" />
      <path d={d} fill="none" stroke="var(--bw-accent)" strokeWidth={2} />
      {onScale && <circle cx={4} cy={y(marketUsd!)} r={3.5} fill="#A1FF8B" />}
    </svg>
  );
};

export const TokenFacts = ({
  tokenId,
  sym,
  dec,
  rate,
  priceSats,
  held,
}: {
  tokenId: string;
  sym: string;
  /** Omitted: read from the token's metadata. */
  dec?: number;
  /** USD per BSV; omitted: the cached rate. */
  rate?: number;
  /** Market price per token (last trade, else best ask), sats. */
  priceSats: number | null;
  /** Omitted: read from the wallet. */
  held?: bigint | null;
}) => {
  const { handleSelect } = useBottomMenu();
  const { apiContext } = useServiceContext();
  const [metaDec, setMetaDec] = useState(0);
  const [ownHeld, setOwnHeld] = useState<bigint | null>(null);
  useEffect(() => {
    let live = true;
    if (dec === undefined) void roomMeta('bsv21', tokenId).then((m) => live && m && setMetaDec(m.dec));
    if (held === undefined)
      heldBsv21Balances(apiContext)
        .then((b) => {
          const t = b.find((x) => x.id.replace('.', '_') === tokenId.replace('.', '_'));
          if (live) setOwnHeld(t ? t.all.confirmed + t.all.pending : 0n);
        })
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tokenId, dec, held, apiContext]);
  const d = dec ?? metaDec;
  const h = held === undefined ? ownHeld : held;
  const r = rate ?? cachedExchangeRate();
  const [curve, setCurve] = useState<TokenCurve | undefined>(undefined);
  const [holders, setHolders] = useState<HolderInfo | null>(null);
  useEffect(() => {
    let live = true;
    setCurve(undefined);
    setHolders(null);
    void tokenCurve(tokenId).then((c) => live && setCurve(c));
    void tokenHolders(tokenId, 10).then((h) => live && setHolders(h));
    return () => {
      live = false;
    };
  }, [tokenId]);

  const marketUsd = priceSats !== null && r > 0 ? (priceSats / 1e8) * r : null;
  const floorUsd = curve?.curve.floorUsd ?? 0.01;
  const ratio = vsFloor(marketUsd, floorUsd);
  const openRoom = () => {
    requestChatRoom(`bsv21:${tokenId}`);
    handleSelect(asMenuItem('chat'));
  };

  return (
    <div className={`${CARD} p-3 flex flex-col gap-3`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-white">Launch curve</div>
        {curve && (
          <span className="flex items-center gap-1 text-[11px]" style={{ color: '#A1FF8B' }}>
            <ShieldCheck size={12} /> Committed at launch · verified
          </span>
        )}
      </div>
      {curve === undefined ? (
        <p className="text-xs m-0" style={{ color: MUTED }}>
          Checking the launch…
        </p>
      ) : curve ? (
        <>
          <CurveChart curve={curve.curve} marketUsd={marketUsd} />
          <div className="text-[11px]" style={{ color: MUTED }}>
            {usd(curve.curve.floorUsd)} floor →{' '}
            {usd(curve.curve.floorUsd + curve.curve.ceilingRaiseUsd / curve.curve.supply)} · {curve.curve.shape} · curve
            id {curve.hash.slice(0, 12)}…
          </div>
        </>
      ) : (
        <p className="text-xs m-0" style={{ color: MUTED }}>
          No committed curve on this token&apos;s launch. Prices are set by holders&apos; own listings.
        </p>
      )}

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div style={{ color: MUTED }}>Price now</div>
          <div className="text-white font-bold">{marketUsd === null ? '—' : usd(marketUsd)}</div>
          <div style={{ color: MUTED }}>
            {ratio === null
              ? `floor ${usd(floorUsd)}`
              : `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}× the ${usd(floorUsd)} floor`}
          </div>
        </div>
        <div>
          <div style={{ color: MUTED }}>Sold</div>
          {/* Supply sold needs the primary ladder or contract (plan PR 3 / C5): not tracked yet. */}
          <div className="text-white font-bold">—</div>
          <div style={{ color: MUTED }}>not tracked yet</div>
        </div>
        <div>
          <div style={{ color: MUTED }}>Holders</div>
          <div className="text-white font-bold">{holders?.count ?? (holders ? '—' : '…')}</div>
        </div>
      </div>

      {holders && holders.top.length > 0 && (
        <div className="flex flex-col text-xs">
          <div className="font-semibold mb-1" style={{ color: MUTED }}>
            Top holders
          </div>
          {holders.top.slice(0, 5).map((h) => (
            <div key={h.address} className="flex justify-between py-0.5 border-t border-[#2b2f36]">
              <span className="text-white font-mono">{short(h.address)}</span>
              <span style={{ color: MUTED }}>{formatAmount(h.amt, d)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-xs">
        <span style={{ color: MUTED }}>Room: hold 1 ${sym} to enter</span>
        {h !== null && h > 0n ? (
          <button
            type="button"
            onClick={openRoom}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 font-bold border-0 cursor-pointer"
            style={{ background: GOLD, color: 'var(--bw-on-accent, #010101)' }}
          >
            <MessageCircle size={13} /> Open room
          </button>
        ) : (
          <span style={{ color: MUTED }}>Buy some to join</span>
        )}
      </div>
    </div>
  );
};
