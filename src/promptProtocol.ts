export type PromptKind =
  | 'unlock'
  | 'permission'
  | 'bundle'
  | 'groupedPermission'
  | 'counterpartyPermission'
  | 'oneSatPermission'
  | 'usbCheck'
  | 'streamGrant';

/** A gated wallet call is waiting for a registered USB key to be confirmed present. */
export interface UsbCheckRequest {
  requestID: string;
  /** What the call does, for the copy: "sign a transaction", "decrypt data". */
  reason: string;
  originator?: string;
}

/** A site asks to stream payments while the user watches (services/streamGrants.ts). */
export interface StreamGrantPrompt {
  requestID: string;
  /** Browser-derived, never page-claimed. */
  originator: string;
  protocolName: string;
  capSatsPerHour: number;
  /** The wallet's global ceiling: the sheet never offers more. */
  ceilingSatsPerHour: number;
  /** ms since epoch. */
  expiresAt: number;
  description?: string;
  usdPerBsv?: number;
}

export interface PromptRef {
  kind: PromptKind;
  requestID: string;
}
