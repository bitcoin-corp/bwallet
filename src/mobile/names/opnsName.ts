/**
 * Name NFTs: a 1Sat ordinal whose inscription type is application/op-ns holds a name as its content. It is shown as
 * a name card, never run or embedded: the content is read as text and only a name that passes the charset and length
 * check is shown.
 */
import type { WalletOutput } from '@bsv/sdk';

export const OPNS_TYPE = 'application/op-ns';

/** Longest name shown (matches the send box's name check). */
export const OPNS_NAME_MAX = 64;
const NAME_RE = /^[a-z0-9-]+$/;

/** True for the name inscription type (parameters and case ignored). */
export const isOpnsType = (contentType: string | null | undefined) =>
  (contentType ?? '').split(';')[0].trim().toLowerCase() === OPNS_TYPE;

/** The name in an inscription's content, or null when it isn't a valid name (empty, too long, other characters). */
export const opnsNameFrom = (content: string | null | undefined): string | null => {
  if (typeof content !== 'string') return null;
  const s = content.trim().toLowerCase();
  if (!s || s.length > OPNS_NAME_MAX || !NAME_RE.test(s)) return null;
  return s;
};

/** Bytes read at most when fetching a name's content (a name is tiny; anything bigger is not a name). */
export const OPNS_FETCH_MAX = 256;

/**
 * A Names-basket row's name: its name: tag, else the name in its custom instructions. A gifted name moved in from
 * the NFTs (opnsAdopt.ts) has only the latter, because the wallet writes tags for new rows only.
 */
export const opnsNameOf = (o: Pick<WalletOutput, 'tags' | 'customInstructions'>): string | undefined => {
  const tag = o.tags?.find((t) => t.startsWith('name:'))?.slice(5);
  if (tag) return tag;
  try {
    const n = o.customInstructions ? (JSON.parse(o.customInstructions) as { name?: unknown }).name : undefined;
    return typeof n === 'string' && n ? n.slice(0, OPNS_NAME_MAX) : undefined;
  } catch {
    return undefined;
  }
};
