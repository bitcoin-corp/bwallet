/**
 * Plain-language labels for protocols whose BRC-43 names are opaque to users.
 * Protocols absent from the table render their raw name unchanged.
 */
import { PINNED_PROTOCOLS } from '../services/pinnedProtocols';

const KNOWN_PROTOCOLS: Record<string, { label: string; description: string }> = {
  '2:3241645161d8': {
    label: 'BRC-29 payment',
    description: 'An application is requesting permission to derive payment addresses for a specific recipient.',
  },
  ...Object.fromEntries(
    PINNED_PROTOCOLS.map((p) => [
      `${p.protocolID[0]}:${p.protocolID[1]}`,
      { label: p.label, description: p.description },
    ]),
  ),
};

export const knownProtocol = (protocolID?: [number, string]) =>
  protocolID ? KNOWN_PROTOCOLS[`${protocolID[0]}:${protocolID[1]}`] : undefined;

/** Display name for a protocol: the friendly label when we have one. */
export const protocolLabel = (protocolID?: [number, string]) => knownProtocol(protocolID)?.label ?? protocolID?.[1];

/** Plain-language reading of the BRC-43 security level. */
export const securityLevelLabel = (level?: number): string => {
  switch (level) {
    case 0:
      return 'Level 0 · any app';
    // BRC-43 keys do not depend on the app: any app asking for the same protocol gets the same keys (audit C1).
    case 1:
      return 'Level 1 · same keys for any app using this protocol';
    case 2:
      return 'Level 2 · same keys for any app using this protocol with this recipient';
    default:
      return `Level ${level ?? 0}`;
  }
};
