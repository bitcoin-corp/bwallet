/**
 * Name NFTs: a 1Sat ordinal whose inscription type is application/op-ns holds a name as its content. It is shown as
 * a name card, never run or embedded: the content is read as text and only a name that passes the charset and length
 * check is shown.
 */
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
