import { DEFAULT_SUPPLY, standardCurve, type Curve } from '../../lib/curves';

export const PERMANENT_NOTE = 'This curve is permanent once you launch. Nobody, you included, can change it later.';
export const STANDARD_SUPPLY = String(DEFAULT_SUPPLY);

/** The one standard launch (owner, 23 Oct 2026): Standard climb, straight, early tier on, 12-month burn. */
export const defaultCurve = (): Curve => standardCurve();

/** Why the curve blocks review (null = fine). Every curve launch is the whole 1,000,000,000 supply. */
export const curveProblem = (curve: Curve, accepted: boolean, tokenSupply: number): string | null => {
  if (tokenSupply !== curve.supply)
    return `Every launch is ${curve.supply.toLocaleString('en-US')} tokens, all on the curve. Set the supply to that.`;
  if (!accepted) return 'Tick "permanent" under the launch curve to go on.';
  return null;
};

export const burnLabel = (m: number | null): string => (m ? `${m} months` : 'Forever');

export type RateView = { text: string; stale: boolean };

/** "≈ 55,960 sats" at the live rate; says so when the price is old or unknown. */
export function satsView(usd: number, rate: number, stale: boolean, at: number | null, now = Date.now()): RateView {
  if (!(rate > 0)) return { text: 'BSV price unavailable', stale: true };
  const sats = Math.round((usd / rate) * 1e8).toLocaleString('en-US');
  if (!stale) return { text: `≈ ${sats} sats (BSV $${rate.toFixed(2)})`, stale: false };
  const mins = at ? Math.max(1, Math.round((now - at) / 60_000)) : null;
  return {
    text: `≈ ${sats} sats (BSV $${rate.toFixed(2)}, price ${mins ? `${mins} min old` : 'may be old'})`,
    stale: true,
  };
}
