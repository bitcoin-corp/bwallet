import { LockingScript, OP, Utils } from '@bsv/sdk';
import { MAP_PREFIX } from '../names/personalToken';
import { curveCommitment, type Curve } from '../../lib/curves';

/**
 * The launch curve on the deploy tx: one extra 0-sat MAP SET output
 *   app=bWallet type=curve curve=<canonical JSON> curveHash=<sha256 hex>
 * so any market can read and verify it (lib/curves verifyCurve). Written once at mint; the issuer's curve
 * is fixed from then on (owner, 23 Oct 2026). There is no edit path.
 */
export function curveMapFields(c: Curve): string[] {
  const { curve, curveHash } = curveCommitment(c);
  return ['app', 'bWallet', 'type', 'curve', 'curve', curve, 'curveHash', curveHash];
}

export function curveMapScript(c: Curve): LockingScript {
  const s = new LockingScript();
  s.writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  for (const part of [MAP_PREFIX, 'SET', ...curveMapFields(c)]) s.writeBin(Utils.toArray(part, 'utf8'));
  return s;
}

/** Rough output size for fee estimates. */
export const curveMapBytes = (c: Curve): number => 60 + curveMapFields(c).reduce((n, x) => n + x.length + 2, 0);

export const CURVE_MAP_DESCRIPTION = 'bWallet launch curve (MAP)';
