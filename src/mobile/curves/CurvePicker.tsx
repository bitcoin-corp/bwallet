import { useEffect, useMemo, useState } from 'react';
import {
  BURN_CHOICES,
  PRESETS,
  curveHash,
  curveLines,
  makeCurve,
  maxPrice,
  priceAt,
  standardCurve,
  usd,
  type Curve,
  type CurveShape,
  type PresetId,
} from '../../lib/curves';
import { fetchExchangeRate, isExchangeRateStale, lastKnownExchangeRate } from '../../utils/exchangeRate';
import { PERMANENT_NOTE, burnLabel, satsView } from './curveChoice';

/**
 * Launch curve picker (every token launch): ONE standard launch for everyone (owner, 23 Oct 2026):
 * 1,000,000,000 supply all on the curve, first token 1¢, fair-launch early tier, unsold burnt after
 * 12 months by default. The issuer picks only the climb, the shape and the burn deadline. The curve is
 * committed on the deploy tx (curves/curveMap.ts) and FIXED from then on, so the picker asks for an
 * explicit "permanent" tick. It only describes the curve: buying and listing live elsewhere.
 */
const GOLD = 'var(--bw-accent)';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

const CLIMBS: PresetId[] = ['standard', 'big', 'huge'];
const SHAPES: { id: CurveShape; label: string }[] = [
  { id: 'linear', label: 'Straight' },
  { id: 'sigmoid', label: 'S-curve' },
  { id: 'exponential', label: 'Steep' },
];

/** The wallet's shared BSV/USD price, with whether it is stale and when it was fetched. */
const useLiveRate = () => {
  const read = () => {
    const e = lastKnownExchangeRate();
    return { rate: e?.rate ?? 0, at: e?.timestamp ?? null, stale: isExchangeRateStale() };
  };
  const [r, setR] = useState(read);
  useEffect(() => {
    let live = true;
    const tick = () =>
      void fetchExchangeRate('main')
        .catch(() => 0)
        .then(() => live && setR(read()));
    tick();
    const id = setInterval(tick, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return r;
};

export const CurvePicker = ({
  curve,
  onChange,
  accepted,
  onAccept,
  tokenSupply,
  onUseStandardSupply,
}: {
  curve: Curve;
  onChange: (c: Curve) => void;
  accepted: boolean;
  onAccept: (v: boolean) => void;
  tokenSupply: number;
  /** Sets the form's supply to 1,000,000,000 (shown when it differs). */
  onUseStandardSupply?: () => void;
}) => {
  const set = (c: Curve) => {
    onAccept(false);
    onChange(c);
  };
  const rate = useLiveRate();
  const lines = useMemo(() => curveLines(curve), [curve]);
  const sats = satsView(priceAt(curve, 0), rate.rate, rate.stale, rate.at);
  const chip = (active: boolean) => ({
    borderColor: active ? GOLD : LINE,
    color: active ? GOLD : '#fff',
    background: active ? 'rgba(255,200,0,0.08)' : 'transparent',
  });
  const btn = 'rounded-full border px-3 min-h-[36px] text-xs font-semibold cursor-pointer flex-1';
  const climb = curve.preset ?? 'standard';

  return (
    <div className="flex flex-col gap-3 rounded-xl border p-3" style={{ borderColor: LINE }} data-testid="curve-picker">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold text-white">Launch curve</span>
        <span className="text-[11px]" style={{ color: MUTED }}>
          Same start for everyone: 1B tokens, first one 1¢
        </span>
      </div>
      <Row label="How far it climbs">
        {CLIMBS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={climb === id}
            className={btn}
            style={chip(climb === id)}
            onClick={() => set(standardCurve(id, curve.shape, curve.burnAfterMonths))}
          >
            {PRESETS[id].label}
          </button>
        ))}
      </Row>
      <p className="text-[11px] m-0 -mt-1" style={{ color: MUTED }}>
        {PRESETS[climb].blurb}
      </p>
      <Row label="Shape">
        {SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={curve.shape === s.id}
            className={btn}
            style={chip(curve.shape === s.id)}
            onClick={() => set(makeCurve({ ...curve, shape: s.id }))}
          >
            {s.label}
          </button>
        ))}
      </Row>
      <CurveChart curve={curve} />
      <ul className="m-0 p-0 list-none flex flex-col gap-1 text-xs text-white">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
        <li style={{ color: sats.stale ? '#FFB020' : MUTED }}>
          First token {sats.text} · smallest buy {usd(curve.minBuyUsd)}
        </li>
      </ul>
      <Row label="Unsold tokens burnt after">
        {BURN_CHOICES.map((m) => (
          <button
            key={String(m)}
            type="button"
            role="radio"
            aria-checked={curve.burnAfterMonths === m}
            className={btn}
            style={chip(curve.burnAfterMonths === m)}
            onClick={() => set(makeCurve({ ...curve, burnAfterMonths: m }))}
          >
            {m === null ? 'Never' : burnLabel(m)}
          </button>
        ))}
      </Row>
      <label className="flex items-center gap-2 text-xs text-white cursor-pointer">
        <input
          type="checkbox"
          checked={!!curve.earlyTier}
          onChange={(e) => set(makeCurve({ ...curve, earlyTier: e.target.checked ? undefined : null }))}
        />
        Fair launch: max $10 each in the cheapest 1%
      </label>
      {tokenSupply !== curve.supply && (
        <div
          className="flex items-center justify-between gap-2 rounded-lg border p-2 text-xs"
          style={{ borderColor: '#5a2a2a', color: '#FF6B6B' }}
        >
          <span>Every launch is 1,000,000,000 tokens, all on the curve.</span>
          {onUseStandardSupply && (
            <button
              type="button"
              className="rounded-full border px-3 min-h-[32px] cursor-pointer bg-transparent"
              style={{ borderColor: GOLD, color: GOLD }}
              onClick={onUseStandardSupply}
            >
              Use 1B
            </button>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1 rounded-lg border p-2" style={{ borderColor: '#5a4a1a' }}>
        <label className="flex items-start gap-2 text-xs text-white cursor-pointer">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => onAccept(e.target.checked)}
            aria-label="Curve is permanent"
          />
          <span>{PERMANENT_NOTE}</span>
        </label>
        <span className="text-[10px] break-all" style={{ color: MUTED }}>
          Curve id {curveHash(curve).slice(0, 16)}…
        </span>
      </div>
    </div>
  );
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[11px]" style={{ color: MUTED }}>
      {label}
    </span>
    <div className="flex gap-1.5" role="radiogroup" aria-label={label}>
      {children}
    </div>
  </div>
);

/** Price line over 0–100% sold, early tier shaded. Linear scale except Steep, which reads better on log. */
export const CurveChart = ({ curve, height = 120 }: { curve: Curve; height?: number }) => {
  const W = 300;
  const H = height;
  const pad = 4;
  const log = curve.shape === 'exponential' && curve.floorUsd > 0;
  const top = maxPrice(curve);
  const y = (p: number) => {
    const lo = log ? Math.log10(curve.floorUsd) : 0;
    const hi = log ? Math.log10(top) : top;
    const v = log ? Math.log10(Math.max(p, curve.floorUsd)) : p;
    return H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  };
  const pts: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const f = i / 60;
    pts.push(`${(pad + f * (W - 2 * pad)).toFixed(1)},${y(priceAt(curve, f)).toFixed(1)}`);
  }
  const tierW = curve.earlyTier ? Math.max(2, curve.earlyTier.fraction * (W - 2 * pad)) : 0;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Price as the supply sells">
        <rect x={0} y={0} width={W} height={H} rx={8} fill="#0d0e11" />
        {tierW > 0 && <rect x={pad} y={pad} width={tierW} height={H - 2 * pad} fill="rgba(161,255,139,0.18)" />}
        <polyline
          points={`${pad},${H - pad} ${pts.join(' ')} ${W - pad},${H - pad}`}
          fill="rgba(255,200,0,0.10)"
          stroke="none"
        />
        <polyline points={pts.join(' ')} fill="none" stroke="var(--bw-accent)" strokeWidth={2} />
      </svg>
      <figcaption className="flex justify-between text-[10px]" style={{ color: MUTED }}>
        <span>{usd(curve.floorUsd)} at the start</span>
        <span>
          {log ? 'log scale · ' : ''}
          {usd(top)} at 100% sold
        </span>
      </figcaption>
    </figure>
  );
};
