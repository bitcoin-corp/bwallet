/**
 * Protocols an outside app may use only from its own site (selective disclosure by default, 24 Oct 2026).
 *
 * BRC-42/43 keys do not depend on the calling app: any site the user approves for [2, 'bmintx archive'] with
 * counterparty 'self' derives the very keys that encrypt the user's private X archive, so it could decrypt every
 * post. For protocols that hold a user's private records we pin the protocol to its home origin(s): a call from
 * any other originator is refused before any permission sheet, the same way reserved protocols are
 * (services/reservedProtocols.ts). The home site still asks once (one protocol sheet), and the grant it gets is
 * stored per originator as usual.
 *
 * Originators are compared after normalizeOriginator (host[:port], lowercase, default port stripped).
 */

type Protocol = readonly [number, string];

export interface PinnedProtocol {
  protocolID: Protocol;
  /** Normalised originators allowed to use it. */
  origins: readonly string[];
  /** What the sheet says, in plain words. */
  label: string;
  description: string;
}

export const PINNED_PROTOCOLS: readonly PinnedProtocol[] = [
  {
    protocolID: [2, 'bmintx archive'],
    origins: ['bmintx.com', 'www.bmintx.com'],
    label: 'Your private archive (bMintX)',
    description:
      'bMintX wants to lock your imported posts with your own keys before they go on chain. Only your 12 words can open them; nothing is made public unless you choose.',
  },
  {
    // bvideox.com mint step (24 Oct 2026): each video's record is encrypted with these keys (counterparty self).
    protocolID: [2, 'bvideox records'],
    origins: ['bvideox.com', 'www.bvideox.com'],
    label: 'Your video records (bVideoX)',
    description:
      'bVideoX wants to lock your video records with your own keys before they go on chain. Only your 12 words can open them; nothing is made public unless you choose.',
  },
];

const key = (p: Protocol) => `${p[0]}:${p[1].trim().toLowerCase()}`;
const BY_KEY = new Map(PINNED_PROTOCOLS.map((p) => [key(p.protocolID), p]));

const asProtocol = (p: unknown): Protocol | null =>
  Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'string' ? [p[0], p[1]] : null;

export const pinnedProtocol = (protocolID: unknown): PinnedProtocol | undefined => {
  const p = asProtocol(protocolID);
  return p ? BY_KEY.get(key(p)) : undefined;
};

/**
 * Advertised in getVersion's result so a site can check the wallet pins its protocol. Bumped whenever a protocol is
 * added: 1 = bmintx archive (bmintx.com checks >= 1), 2 = + bvideox records (bvideox.com checks >= 2).
 */
export const PINNED_PROTOCOLS_VERSION = 2;

/**
 * The getVersion string with the pin level appended (`bwalletx-5.2.40+p2`). Some transports (e.g. the
 * @bwalletx/connect binary wire) carry only `version`, so the pin level must live in the string itself.
 * Sites parse it with /\+p(\d+)\b/. Stays within the SDK's 7–30 character limit.
 */
export const versionWithPins = (base: string): string => `${base}+p${PINNED_PROTOCOLS_VERSION}`;

export const PINNED_REFUSAL = 'This protocol belongs to another site';

/** Methods whose args carry a protocolID that selects a derived key (same set as reservedProtocols.ts). */
const PROTOCOL_METHODS = new Set([
  'getPublicKey',
  'createSignature',
  'verifySignature',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'revealSpecificKeyLinkage',
]);

/**
 * Why this outside originator's call must be refused, or null. `originator` must already be normalised (and
 * browser-derived, never page-supplied). Admin calls never reach here.
 */
export const pinnedProtocolRefusal = (method: string, args: unknown, originator: string | undefined): string | null => {
  if (!PROTOCOL_METHODS.has(method) || !args || typeof args !== 'object') return null;
  const pin = pinnedProtocol((args as { protocolID?: unknown }).protocolID);
  if (!pin) return null;
  if (originator && pin.origins.includes(originator)) return null;
  return `${PINNED_REFUSAL}: "${pin.protocolID[1]}" (${pin.origins[0]})`;
};

/** May this originator be granted this protocol at all (permission sheets, grouped grants)? */
export const pinnedAllowed = (protocolID: unknown, originator: string | undefined): boolean => {
  const pin = pinnedProtocol(protocolID);
  return !pin || (!!originator && pin.origins.includes(originator));
};
