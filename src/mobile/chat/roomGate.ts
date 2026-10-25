import type { TokenGate } from './tokenRooms';

/**
 * Open rooms that also carry a token gate (metadata.tokenGate, e.g. a game's room: ASSAULT gated on 1 $TERRORNODE).
 *
 * Owner, 25 Oct 2026: a token-gated room the user doesn't qualify for must not sit in "Your rooms" and must not
 * open; it may show only in discovery as a locked card ("Hold 1 $TERRORNODE to join · Play to earn"). bit-sign lets
 * a room's creator in without the token (token-room-gate.ts), so the wallet checks the holding itself, using
 * bit-sign's own count (GET /rooms/token-gated?key= → held_raw).
 */
export function roomTokenGate(metadata: unknown): TokenGate | null {
  const g = (metadata as { tokenGate?: unknown } | null | undefined)?.tokenGate as
    | { key?: unknown; symbol?: unknown; dec?: unknown; minAmountRaw?: unknown }
    | null
    | undefined;
  if (!g || typeof g.key !== 'string' || !/^[a-z0-9]+:[^\s]{1,200}$/i.test(g.key)) return null;
  const symbol = typeof g.symbol === 'string' && g.symbol.trim() ? g.symbol.trim().slice(0, 32) : 'TOKEN';
  const dec = Number.isInteger(g.dec) && (g.dec as number) >= 0 && (g.dec as number) <= 18 ? (g.dec as number) : 0;
  const minRaw = typeof g.minAmountRaw === 'string' && /^\d{1,40}$/.test(g.minAmountRaw) ? g.minAmountRaw : '1';
  return { key: g.key, symbol, dec, minRaw: BigInt(minRaw) > 0n ? minRaw : '1' };
}

/**
 * True only when bit-sign's count is known and below the minimum. Unknown (no answer yet, outage) keeps the room,
 * so a slow indexer never hides a room the user holds.
 */
export function lacksGate(gate: TokenGate | null, heldRaw: string | null | undefined): boolean {
  if (!gate || typeof heldRaw !== 'string' || !/^\d{1,40}$/.test(heldRaw)) return false;
  return BigInt(heldRaw) < BigInt(gate.minRaw);
}

/** "1", "2.5": a raw amount in whole tokens for the lock line. */
function whole(raw: string, dec: number): string {
  if (!dec) return raw;
  const s = raw.padStart(dec + 1, '0');
  const frac = s.slice(-dec).replace(/0+$/, '');
  return frac ? `${s.slice(0, -dec)}.${frac}` : s.slice(0, -dec);
}

/** "Hold 1 $TERRORNODE to join · Play to earn" (the play line only for a room with its own site). */
export function lockedLine(gate: TokenGate, hasSite: boolean): string {
  return `Hold ${whole(gate.minRaw, gate.dec)} $${gate.symbol} to join${hasSite ? ' · Play to earn' : ''}`;
}

/** The token's on-chain icon for a BSV-21 gate: its deploy outpoint's _0 output on ORDFS. Null for anything else. */
export function gateIconUrl(gate: TokenGate | null): string | null {
  const m = gate?.key.match(/^bsv21:([0-9a-f]{64})_\d+$/i);
  return m ? `https://ordfs.network/content/${m[1]!.toLowerCase()}_0` : null;
}
