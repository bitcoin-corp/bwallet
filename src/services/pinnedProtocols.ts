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
  /**
   * A paid action on this protocol that gets ONE sheet (services/pinnedMint.ts): "Mint 3 videos, locked to you on
   * bvideox.com". `countFrom` reads the item count from the createAction description the site sends.
   */
  mint?: { verb: string; noun: string; countFrom: RegExp };
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
    // bvideox.com mint/records.js: description `bVideoX: 3 private video records`.
    mint: { verb: 'Mint', noun: 'video', countFrom: /(\d+) private video records?/i },
  },
  {
    // bjobsx.com (24 Oct 2026): imported LinkedIn profile sections, encrypted with these keys (counterparty self).
    protocolID: [2, 'bjobsx records'],
    origins: ['bjobsx.com', 'www.bjobsx.com'],
    label: 'Your work records (bJobsX)',
    description:
      'bJobsX wants to lock your profile records with your own keys before they go on chain. Only your 12 words can open them; nothing is made public unless you choose.',
    // bjobsx.com mint: description `bJobsX: 3 private profile records`.
    mint: { verb: 'Mint', noun: 'profile record', countFrom: /(\d+) private profile records?/i },
  },
  {
    // bdrivex.com (24 Oct 2026): records of the user's files (name, type, size, fingerprint), encrypted with these keys.
    protocolID: [2, 'bdrivex records'],
    origins: ['bdrivex.com', 'www.bdrivex.com'],
    label: 'Your file records (bDriveX)',
    description:
      'bDriveX wants to lock your file records with your own keys before they go on chain. Only your 12 words can open them; nothing is made public unless you choose.',
    // bdrivex.com mint: description `bDriveX: 3 private file records`.
    mint: { verb: 'Mint', noun: 'file record', countFrom: /(\d+) private file records?/i },
  },
  {
    // bcalx.com (24 Oct 2026): imported calendar events, encrypted with these keys (bx-starter-kit).
    protocolID: [2, 'bcalx records'],
    origins: ['bcalx.com', 'www.bcalx.com'],
    label: 'Your calendar records (bCalX)',
    description:
      'bCalX wants to lock your calendar records with your own keys before they go on chain. Only your 12 words can open them; nothing is made public unless you choose.',
    // bx-starter-kit mint: description `bCalX: 3 private calendar records`.
    mint: { verb: 'Mint', noun: 'calendar record', countFrom: /(\d+) private (?:calendar )?records?/i },
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
 * added: 1 = bmintx archive (bmintx.com checks >= 1), 2 = + bvideox records (bvideox.com checks >= 2),
 * 3 = + bjobsx, bdrivex, bcalx records (those sites check >= 3).
 */
export const PINNED_PROTOCOLS_VERSION = 3;

/** BRC-205 `base`: vendor "-" major.minor.patch, no leading zeroes, 7–30 ASCII bytes. */
const BRC205_BASE = /^[A-Za-z0-9][A-Za-z0-9._-]*-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** Older @bsv/sdk validators (result validation, the binary wire) still cap the whole string at 30 bytes. */
const SDK_MAX = 30;

/**
 * The getVersion string in BRC-205 form with the pin level as an attribute: `bwalletx-5.2.44; pin=3;`. Some
 * transports (e.g. the @bwalletx/connect binary wire) carry only `version`, so the pin level must live in the string
 * itself. Sites read it with pinLevelFromVersion (or /(?:\+p|; pin=)(\d+)\b/). When the attribute would push the
 * string past the SDK's 30 bytes, or the base isn't a BRC-205 base, only the base is sent (BRC-205: omit optional
 * attributes to stay within limits); the pin level still goes in the `pinnedProtocols` field.
 */
export const versionWithPins = (base: string): string => {
  const v = `${base}; pin=${PINNED_PROTOCOLS_VERSION};`;
  return BRC205_BASE.test(base) && base.length <= SDK_MAX && v.length <= SDK_MAX ? v : base;
};

/**
 * The pin level a version string advertises: the BRC-205 `pin` attribute (`…; pin=3;`) or the legacy `+p3` suffix
 * (wallets up to 5.2.44). 0 when there is none. Takes the larger of that and a `pinnedProtocols` field when given.
 */
export const pinLevelFromVersion = (
  v: { version?: unknown; pinnedProtocols?: unknown } | string | null | undefined,
) => {
  const o = typeof v === 'string' ? { version: v } : (v ?? {});
  const s = typeof o.version === 'string' && o.version.length <= 2048 ? o.version : '';
  const m = s.match(/(?:\+p|; pin=)(\d{1,6})(?=;|$|\b)/);
  const field = Number(o.pinnedProtocols);
  return Math.max(Number.isSafeInteger(field) && field > 0 ? field : 0, m ? Number(m[1]) : 0);
};

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
