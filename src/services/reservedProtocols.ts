/**
 * Wallet-internal BRC-43 protocols that no outside site or app may use (security audit 19 Oct 2026, C1).
 *
 * BRC-42 key derivation does not include the calling app: protocol [1, 'btrust'] with keyID 'owner' gives a
 * dApp exactly the key the wallet uses for the user's bTrust lock, so one approval would let a site sign the
 * lock's withdrawal. Level 0 is worse: the permissions manager asks nothing at all, so [0, 'onesat'] (the
 * wallet's funds, ordinals and Locks keys) was open to any connected site.
 *
 * Every protocol the wallet itself derives keys under is listed in reservedProtocolList.ts, and a call from any originator other
 * than the wallet's own is refused BEFORE any permission prompt, on every method that takes a protocolID.
 * src/services/reservedProtocols.test.ts scans src for protocol constants, so a new internal protocol fails
 * the tests until it is classified there.
 */

type Protocol = readonly [number, string];

const key = (p: Protocol) => `${p[0]}:${p[1].trim().toLowerCase()}`;
/**
 * FNV-1a (32-bit) of "level:name" for every reserved protocol in reservedProtocolList.ts. Hashes, not names, so
 * store builds don't carry store-hidden feature names. A collision could only over-refuse an outside app.
 */
const RESERVED_HASHES = new Set<number>(
  [
    0x96f7845f, 0x5c1efc8e, 0xec8cb43a, 0x989014a2, 0x3a98170a, 0xa392b7f4, 0x06a1d43a, 0xcd609e3f, 0x8b22ea1d,
    0xf7be44e7, 0xd59296c1, 0x8ef2a248, 0x3f7de0fa, 0x9220f557, 0x5e9de672, 0xd057f30f, 0x82eb9c44, 0xbd16812f,
    0xed10a363, 0x7dcea8b8, 0x94347fb5, 0xeb45ebe9, 0xb9a0b206, 0xcb1fe820, 0x7ce83ef7, 0x37432cf7, 0x4bb19af2,
    0xae00f773, 0x86730eac, 0x13a25b95, 0xaf904c6c,
  ].map((h) => h >>> 0),
);

/** Shared protocols whose keys hold the user's money (BRC-29 payments): never sign a raw hash for an outside app. */
const NO_RAW_HASH: readonly Protocol[] = [[2, '3241645161d8']];

export const protocolHash = (p: Protocol): number => {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(key(p))) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h >>> 0;
};

const RAW_HASH_REFUSED = new Set(NO_RAW_HASH.map(key));

const asProtocol = (p: unknown): Protocol | null =>
  Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'string' ? [p[0], p[1]] : null;

export const isReservedProtocol = (protocolID: unknown): boolean => {
  const p = asProtocol(protocolID);
  return !!p && RESERVED_HASHES.has(protocolHash(p));
};

export const RESERVED_REFUSAL = 'This protocol is reserved for bWalletX itself';
export const RAW_HASH_REFUSAL =
  'Signing a raw hash with these keys could move your money; bWalletX refuses it for apps';

/** Wallet methods whose args carry a protocolID that selects a derived key. */
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
 * Why an outside caller's wallet call must be refused, or null when it may go on to the normal permission
 * checks. Callers decide "outside": anything but the wallet's own admin originator.
 */
export const reservedProtocolRefusal = (method: string, args: unknown): string | null => {
  if (!PROTOCOL_METHODS.has(method) || !args || typeof args !== 'object') return null;
  const a = args as { protocolID?: unknown; hashToDirectlySign?: unknown };
  if (a.protocolID === undefined || a.protocolID === null) return null;
  const p = asProtocol(a.protocolID);
  if (!p) return 'Invalid protocolID';
  if (RESERVED_HASHES.has(protocolHash(p))) return `${RESERVED_REFUSAL}: "${p[1]}"`;
  if (method === 'createSignature' && a.hashToDirectlySign !== undefined && a.hashToDirectlySign !== null) {
    // Level-0 keys are shared by every app and the wallet; BRC-29 keys receive the user's payments.
    if (p[0] === 0 || RAW_HASH_REFUSED.has(key(p))) return RAW_HASH_REFUSAL;
  }
  return null;
};

/** Grouped (BRC-73) protocol entries an outside app may be granted: reserved ones are dropped. */
export const withoutReservedProtocols = <T extends { protocolID?: unknown }>(items: T[] | undefined): T[] =>
  (items ?? []).filter((p) => !isReservedProtocol(p.protocolID));

type ProtocolGrantStore = {
  listGrants(filter?: {
    type?: 'protocol';
  }): Promise<{ key: { type: string; originator: string; protocolLevel?: number; protocolName?: string } }[]>;
  deleteGrant(key: never): Promise<void>;
};

/**
 * Remove every stored grant an outside originator holds for a reserved protocol (upgrade migration; safe to
 * run on every unlock). Returns how many were removed.
 */
export const revokeReservedProtocolGrants = async (store: ProtocolGrantStore, adminOriginator: string) => {
  const grants = await store.listGrants({ type: 'protocol' });
  let removed = 0;
  for (const g of grants) {
    const k = g.key;
    if (k.type !== 'protocol' || k.originator === adminOriginator) continue;
    if (!isReservedProtocol([k.protocolLevel, k.protocolName])) continue;
    await store.deleteGrant(k as never);
    removed++;
  }
  return removed;
};

/**
 * Defence in depth inside the permissions manager: refuse reserved protocols for outside originators before
 * ensureProtocolPermission can prompt, and on every protocol method, whatever path reached the manager.
 */
export function guardReservedProtocols<T extends object>(manager: T, adminOriginator: string): T {
  const m = manager as Record<string, unknown>;
  const isOutside = (originator: unknown) => originator !== adminOriginator;
  for (const method of PROTOCOL_METHODS) {
    const original = m[method];
    if (typeof original !== 'function') continue;
    m[method] = async (args: unknown, originator?: string) => {
      if (isOutside(originator)) {
        const refusal = reservedProtocolRefusal(method, args);
        if (refusal) throw new Error(refusal);
      }
      return (original as (a: unknown, o?: string) => Promise<unknown>).call(manager, args, originator);
    };
  }
  const ensure = m.ensureProtocolPermission;
  if (typeof ensure === 'function') {
    m.ensureProtocolPermission = async (args: { originator?: string; protocolID?: unknown }) => {
      if (isOutside(args?.originator) && isReservedProtocol(args?.protocolID))
        throw new Error(`${RESERVED_REFUSAL}: "${String((args.protocolID as Protocol)[1])}"`);
      return (ensure as (a: unknown) => Promise<boolean>).call(manager, args);
    };
  }
  const grouped = m.grantGroupedPermission;
  if (typeof grouped === 'function') {
    m.grantGroupedPermission = async (params: { granted?: { protocolPermissions?: { protocolID?: unknown }[] } }) => {
      if (params?.granted?.protocolPermissions)
        params = {
          ...params,
          granted: {
            ...params.granted,
            protocolPermissions: withoutReservedProtocols(params.granted.protocolPermissions),
          },
        };
      return (grouped as (p: unknown) => Promise<void>).call(manager, params);
    };
  }
  const pact = m.grantCounterpartyPermission;
  if (typeof pact === 'function') {
    m.grantCounterpartyPermission = async (params: {
      granted?: { protocols?: { protocolID?: unknown; protocolName?: string }[] };
    }) => {
      if (params?.granted?.protocols)
        params = {
          ...params,
          granted: {
            ...params.granted,
            protocols: params.granted.protocols.filter(
              (p) => !isReservedProtocol(p.protocolID ?? [2, String(p.protocolName ?? '')]),
            ),
          },
        };
      return (pact as (p: unknown) => Promise<void>).call(manager, params);
    };
  }
  return manager;
}
