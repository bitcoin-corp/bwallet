/**
 * Re-ask on reconnect (owner, 24 Oct 2026). A site the user already approved gets its identity key without a sheet,
 * which is right while it stays connected, but wrong once the user pressed the site's own Disconnect: the next
 * "Connect wallet › bWalletX" must open the wallet ("Reconnect to <site>?"), never answer silently.
 *
 * Signals (either one means the next identity-key request asks first):
 *  1. The site said it disconnected. The page posts `{ type: 'bwallet:disconnect' }` to itself (content.ts forwards
 *     it; the origin comes from Chrome's sender, never from the message), or it removes its
 *     `<meta name="bwalletx-theme">` after having one (what @bwalletx/connect does on disconnect).
 *  2. A gap: nothing from that site for RECONNECT_GAP_MS. Coming back after a day asks again.
 *
 * Approving the reconnect sheet clears the flag. Liveness checks while connected (a game calling getPublicKey to
 * see whether the wallet is awake) stay silent: only the signals above flip a site to "ask".
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
