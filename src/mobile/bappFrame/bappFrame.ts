import { CapacitorHttp } from '@capacitor/core';
import { BAPPS } from '../bapps';
import { STORE_BUILD } from '../storeBuild';
import { openDappBrowser } from '../dappBrowser';
import { isNative } from '../native';
import { IS_EXTENSION } from '../extension';
import { frameAllowlist, frameOriginFor, framingAllowed } from './frameBridge';
import { frameModeFor } from './webFrame';
import { BCHAT_FALLBACK_ORIGIN, ensureBchatOrigin, liveBchatUrl } from '../../services/bchatOrigin';

/**
 * In-frame bApps: our own apps (Apps › bApps) run inside bWallet's main frame, between TopNav
 * and the tab bar, instead of the full-screen browser. Third-party apps never come here.
 * One bApp session at a time; it stays alive while you visit other tabs.
 */
export type BappSession = { name: string; url: string; origin: string; key: number };

/** Exact origins of every bApp tile: the only pages we will frame or answer. */
export const BAPP_FRAME_ALLOWLIST = frameAllowlist([
  ...BAPPS.filter((a) => !a.noFrame && !(STORE_BUILD && a.privateOnly) && !a.url.startsWith('/')).map((a) => a.url),
  // bChatX's fallback origin (same bit-sign deployment) while www.bchatx.com is unreachable.
  BCHAT_FALLBACK_ORIGIN,
]);

/** Every curated app tile may run in-frame too (headers permitting); typed URLs stay full screen. */
export const allowFrameUrls = (urls: readonly string[]) => {
  for (const o of frameAllowlist(urls)) BAPP_FRAME_ALLOWLIST.add(o);
};

type State = { session: BappSession | null; visible: boolean; opening: string | null };
let state: State = { session: null, visible: false, opening: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
export const subscribeBappFrame = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const getBappFrameState = () => state;

/** The Apps tab is on screen (the frame shows only there; elsewhere it is kept alive, hidden). */
export const setBappFrameVisible = (visible: boolean) => {
  if (state.visible !== visible) set({ visible });
};

// Per-origin result of the header probe, for this app session.
const probed = new Map<string, boolean>();

/**
 * Asks the site (natively, so CORS does not apply) whether it lets the wallet frame it:
 * X-Frame-Options / CSP frame-ancestors. Any failure → not frameable (use full screen).
 */
const canFrame = async (url: string, origin: string): Promise<boolean> => {
  const hit = probed.get(origin);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    if (IS_EXTENSION) {
      // The extension has host permission for every bApp origin (scripts/build.ts), so CORS doesn't apply.
      const r = await fetch(url, { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout(6000) });
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => (headers[k] = v));
      ok = r.ok && framingAllowed(headers, window.location.origin);
      probed.set(origin, ok);
      return ok;
    }
    const res = await CapacitorHttp.request({
      url,
      method: 'GET',
      responseType: 'text',
      connectTimeout: 6000,
      readTimeout: 6000,
    });
    ok = res.status >= 200 && res.status < 400 && framingAllowed(res.headers ?? {}, window.location.origin);
  } catch {
    ok = false;
  }
  probed.set(origin, ok);
  return ok;
};

let seq = 0;

/**
 * Opens a bApp tile: in-frame when it is on the allowlist and its headers allow framing,
 * otherwise in the full-screen browser (today's behaviour).
 */
export const openBapp = async (name: string, rawUrl: string): Promise<void> => {
  // bChatX URLs move to the live origin; whether a tile may frame is decided on the URL it was given.
  const url = liveBchatUrl(rawUrl, await ensureBchatOrigin());
  const origin = frameOriginFor(rawUrl, BAPP_FRAME_ALLOWLIST) && frameOriginFor(url, BAPP_FRAME_ALLOWLIST);
  // Phone apps and the Chrome extension run bApps in-frame (headers probed); the web/Desktop wallet frames only the
  // bApps that allow it (WEB_FRAME_ORIGINS) and opens the rest in a tab.
  const mode = frameModeFor(origin, { native: isNative, extension: IS_EXTENSION });
  if (mode === 'tab' || !origin) return openDappBrowser(url);
  if (state.session?.origin === origin && state.session.url === url) return set({ visible: true });
  set({ opening: name });
  try {
    if (mode === 'frame' && !(await canFrame(url, origin))) return await openDappBrowser(url);
    set({ session: { name, url, origin, key: ++seq } });
  } finally {
    set({ opening: null });
  }
};

/** Reload: remount the iframe at the page it was last on (as reported by its wallet calls) or its start URL. */
export const reloadBapp = (url?: string) => {
  const s = state.session;
  if (s) set({ session: { ...s, url: url ?? s.url, key: ++seq } });
};

export const closeBapp = () => set({ session: null });

/** Leave the frame for the full-screen browser (same page, native window.CWI). */
export const bappFullScreen = (url: string) => {
  closeBapp();
  return openDappBrowser(url);
};
