/**
 * Re-ask on reconnect (owner, 24 Oct 2026). A site the user already approved gets its identity key without a sheet,
 * which is right while it stays connected, but wrong once the user pressed the site's own Disconnect: the next
 * "Connect wallet › bWalletX" must open the wallet ("Reconnect to <site>?"), never answer silently.
 *
 * Signals (either one means the next identity-key request asks first):
 *  1. The site said it disconnected. The page posts `{ type: 'bwallet:disconnect' }` to itself (content.ts forwards
 *     it; the origin comes from Chrome's sender, never from the message). Only this explicit message counts: the
 *     theme meta going away is not a signal (25 Oct 2026), since a React re-render or a route to a page without the
 *     meta removes it in the middle of a session.
 *  2. A gap: nothing at all from that site for RECONNECT_GAP_MS. Every call of any kind (isAuthenticated,
 *     getVersion, getNetwork, waitForAuthentication included) refreshes it, so a site in use never hits it.
 *
 * Only a real connect asks (getPublicKey with identityKey: true, see gatesConnect). Liveness checks never open the
 * sheet. Approving the reconnect sheet clears the flag.
 *
 * Pure: state in, state out. background.ts keeps it in chrome.storage.local.
 */

export const RECONNECT_STATE_KEY = 'bwx.reconnectGate';
export const RECONNECT_GAP_MS = 24 * 60 * 60 * 1000;
const MAX_SITES = 500;

export type ReconnectState = {
  /** host → when the site said it disconnected (ms). */
  off: Record<string, number>;
  /** host → last call from the site (ms). */
  seen: Record<string, number>;
};

export const emptyReconnectState = (): ReconnectState => ({ off: {}, seen: {} });

const nums = (v: unknown): Record<string, number> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>))
    if (typeof n === 'number' && isFinite(n)) out[k] = n;
  return out;
};

export const parseReconnectState = (v: unknown): ReconnectState => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { off: nums(o.off), seen: nums(o.seen) };
};

/** The key a site is tracked under: its host, lower case, no scheme or path. */
export const reconnectHost = (originator: string): string =>
  originator
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();

const trim = (m: Record<string, number>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SITES),
  );

/** The site said it disconnected: its next identity-key request asks first. */
export const noteDisconnect = (s: ReconnectState, originator: string, now: number): ReconnectState => {
  const h = reconnectHost(originator);
  if (!h) return s;
  return { ...s, off: trim({ ...s.off, [h]: now }) };
};

/** Whether this identity-key request must show the reconnect sheet instead of being answered silently. */
export const needsReconnect = (s: ReconnectState, originator: string, now: number): boolean => {
  const h = reconnectHost(originator);
  if (!h) return false;
  if (s.off[h] !== undefined) return true;
  const last = s.seen[h];
  return last !== undefined && now - last > RECONNECT_GAP_MS;
};

/** Any call from the site (checked after needsReconnect, so the gap is measured to the previous call). */
export const noteCall = (s: ReconnectState, originator: string, now: number): ReconnectState => {
  const h = reconnectHost(originator);
  if (!h) return s;
  return { ...s, seen: trim({ ...s.seen, [h]: now }) };
};

/** The user approved the reconnect sheet: connected again. */
export const noteReconnected = (s: ReconnectState, originator: string, now: number): ReconnectState => {
  const h = reconnectHost(originator);
  const off = { ...s.off };
  delete off[h];
  return { off, seen: trim({ ...s.seen, [h]: now }) };
};

/** A synthetic sheet line for the reconnect question; never sent to the permissions manager. */
export const RECONNECT_ID_PREFIX = 'reconnect-';
export const isReconnectRequestId = (id: string | undefined): boolean => !!id && id.startsWith(RECONNECT_ID_PREFIX);

/**
 * Whether a call is a real connect that the gate may hold for the sheet. Liveness checks (isAuthenticated,
 * getVersion, getNetwork, waitForAuthentication, getHeight) never open it: they answer as they always did.
 */
export const gatesConnect = (action: string, params: unknown): boolean =>
  action === 'getPublicKey' &&
  !!params &&
  typeof params === 'object' &&
  (params as { identityKey?: unknown }).identityKey === true;

/**
 * One reconnect sheet per site at a time: identity-key calls that arrive while it is open wait for the same answer
 * instead of each adding a line to it.
 */
export class ReconnectAsks {
  private open = new Map<string, Promise<void>>();
  ask(originator: string, show: () => Promise<void>): Promise<void> {
    const h = reconnectHost(originator);
    const cur = this.open.get(h);
    if (cur) return cur;
    const p = show().finally(() => this.open.delete(h));
    this.open.set(h, p);
    return p;
  }
}
