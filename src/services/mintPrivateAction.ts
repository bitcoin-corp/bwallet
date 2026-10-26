/**
 * The tiny, dependency-free part of `wallet.mintPrivate` (services/mintPrivateSite.ts): the message type and the
 * feature-detect caps. Page scripts (inject.js) and content scripts import this, never the minting code.
 */

/** Page → wallet message type (content.ts, mobile provider, bApp frame and pairing forward it like a CWI call). */
export const MINT_PRIVATE_ACTION = 'bwxMintPrivate';
export const isMintPrivateAction = (type: unknown): boolean => type === MINT_PRIVATE_ACTION;
/** Same as mobile/private/privateMint.ts MAX_REQUEST_ITEMS (a test keeps them equal). */
export const MINT_PRIVATE_MAX_ITEMS = 25_000;
/** Feature detection on the provider: `wallet.mintPrivateCaps`. */
export const MINT_PRIVATE_CAPS = Object.freeze({ sequence: true, maxItems: MINT_PRIVATE_MAX_ITEMS });
/** Codes a site may read on a refusal (MintPrivateError codes). */
export const MINT_PRIVATE_CODES: readonly string[] = [
  'USER_REFUSED',
  'REQUEST_ID_REUSED',
  'BAD_REQUEST',
  'TOO_MANY_ITEMS',
];
export const isMintPrivateCode = (c: unknown): c is string => typeof c === 'string' && MINT_PRIVATE_CODES.includes(c);
