/**
 * One sheet on first connect (owner rule: ONE permission sheet per connect or pay, never 3–5 popups).
 *
 * A new player on a site used to see three sheets one after another: the site's grouped permissions (its
 * manifest), then the identity-key line, then "Sign in" (a level-1 signature anyone can check). The site asks for
 * them one call at a time, so they could never share a sheet. Now the connect sheet names all three ("Connect,
 * your identity key, sign in") and its Allow is the consent for the identity-key and sign-in calls that follow
 * from the SAME site within CONNECT_CONSENT_MS. Those are granted through the manager's own grantPermission with
 * the default expiry, without another sheet.
 *
 * What it never covers (the bridge fixes stay):
 * - paired sessions ("<host>.paired.invalid"): no inherited trust, they always ask on their own sheet;
 * - another site, or the same site after the window;
 * - anything but the identity key and a level-0/1 signing protocol with counterparty self/anyone/empty:
 *   no level-2 (counterparty-specific) keys, no privileged keys, no reserved wallet protocols, no baskets,
 *   certificates or spending, no reconnect line ("Reconnect to <site>?" after a disconnect asks again).
 * The site's own name on every sheet keeps its "claims to be <host>" wording; nothing here changes what a sheet shows.
 * Pure (time injected) so it can be unit tested.
 */

export const CONNECT_CONSENT_MS = 2 * 60 * 1000;
export const IDENTITY_LINE = 'identity key retrieval';

export type ConsentRequest = {
  type?: string;
  originator?: string;
  privileged?: boolean;
  protocolID?: unknown;
  counterparty?: string;
  reconnect?: boolean;
};

export type ConsentDeps = {
  isPaired: (originator: string) => boolean;
  isReserved: (protocolID: unknown) => boolean;
  normalize?: (originator: string) => string;
};

/** True for the identity-key line or a sign-in signature (level 0/1, counterparty self/anyone/empty). */
export function isConnectLine(r: ConsentRequest, isReserved: (p: unknown) => boolean): boolean {
  if (r.type !== 'protocol' || r.privileged === true || r.reconnect === true) return false;
  const p = r.protocolID;
  if (!Array.isArray(p) || p.length !== 2 || typeof p[1] !== 'string') return false;
  const level = Number(p[0]);
  if (!(level === 0 || level === 1)) return false;
  if (isReserved(p)) return false;
  const cp = r.counterparty ?? '';
  return cp === '' || cp === 'self' || cp === 'anyone';
}

export class ConnectConsent {
  private readonly given = new Map<string, number>();
  constructor(private readonly deps: ConsentDeps) {}

  private key(originator: string): string {
    return this.deps.normalize ? this.deps.normalize(originator) : originator;
  }

  /** The user approved a connect sheet for this site. Paired sessions never record a consent. */
  record(originator: string | undefined, now: number): void {
    if (!originator || this.deps.isPaired(originator)) return;
    this.given.set(this.key(originator), now);
  }

  /** Every line covered: a whole bundle may go through without a sheet. */
  coversAll(items: ConsentRequest[], now: number): boolean {
    return items.length > 0 && items.every((r) => this.covers(r, now));
  }

  covers(r: ConsentRequest, now: number): boolean {
    if (!r.originator || this.deps.isPaired(r.originator)) return false;
    const at = this.given.get(this.key(r.originator));
    if (at === undefined || now - at > CONNECT_CONSENT_MS || now < at) return false;
    return isConnectLine(r, this.deps.isReserved);
  }

  /** Forget site / disconnect / block: the consent ends at once. */
  forget(originator: string): void {
    this.given.delete(this.key(originator));
  }
}
