/**
 * A room's display-only linked token (metadata.linkedToken = { id, symbol, source }). bit-sign ignores it for
 * gating; the room header shows it as a "$SYMBOL" chip (LinkedTokenChip.tsx). Anything malformed is dropped.
 */
export interface LinkedToken {
  id: string;
  symbol: string;
  source: string;
}

const ID = /^[0-9a-f]{64}_\d+$/;
const SYMBOL = /^[A-Z0-9]{1,16}$/;
const SOURCE = /^[a-z0-9-]{1,32}$/;

export const parseLinkedToken = (metadata: unknown): LinkedToken | null => {
  const v = (metadata as { linkedToken?: unknown } | null | undefined)?.linkedToken;
  if (!v || typeof v !== 'object') return null;
  const { id, symbol, source } = v as Record<string, unknown>;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) return null;
  if (typeof source !== 'string' || !SOURCE.test(source)) return null;
  return { id, symbol, source };
};

/** Where the chip goes outside the wallet: BlastPad's launch page for a BlastPad token, else nowhere. */
export const linkedTokenUrl = (t: LinkedToken): string | null =>
  t.source === 'blastpad' ? `https://www.tokenblaster.lol/launch/${t.id}` : null;
