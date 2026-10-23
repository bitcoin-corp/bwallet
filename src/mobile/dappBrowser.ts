/* eslint-disable @typescript-eslint/no-explicit-any */
import { IS_TAURI, openExternal } from './desktop/ipc';
import { isCWIEventName } from '@1sat/wallet-browser';
import { YoursNative, isNative } from './native';
import { MOBILE_EXTENSION_ID } from './protocol';
import { isReservedHost } from '../services/adminOriginator';
import { isPairedHost, originatorForOrigin } from '../services/originKey';
import { liveBchatUrl } from '../services/bchatOrigin';

/**
 * In-app dApp browser. Each site is a hub endpoint whose sender origin is the
 * site's real origin (reported by the native WebView), so background.ts
 * treats it exactly as it treats a content script: originator must match
 * sender.origin, and every sensitive call goes through the permission prompts.
 */

type ContextFactory = (id: string, origin: string, url: string) => any;

let providerSource: Promise<string> | undefined;
let open = false;
let hiddenForOverlay = false;
let overlayCount = 0;
const contexts = new Map<string, any>();
const lastUrls = new Map<string, string>();

/** Last page URL a site was on when it called the wallet (this session), e.g. to reopen bChat where it was. */
export const lastUrlFor = (origin: string) => lastUrls.get(origin);

export const isDappBrowserOpen = () => open;

export const openDappBrowser = async (rawUrl: string) => {
  // bChatX links follow the live origin (chat.bwalletx.com while www.bchatx.com is unreachable). Sync: pop-up blockers.
  const url = liveBchatUrl(rawUrl);
  // Web wallet and extension: no in-app browser, and dapp-provider.js isn't in those builds. Open a tab
  // straight away, inside the tap, or Safari's pop-up blocker eats it (owner, 6 Oct 2026: ChangeNOW and
  // Alchemy Pay "don't open anything" on the web).
  if (!isNative) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  providerSource ??= fetch(new URL('dapp-provider.js', document.baseURI)).then((r) => {
    if (!r.ok) throw new Error('dapp-provider.js missing from the app bundle');
    return r.text();
  });
  await YoursNative.browserOpen({ url, provider: await providerSource });
  open = true;
  // Opened (or re-shown) while a prompt is up: stay behind it until it closes.
  hiddenForOverlay = false;
  onOverlayCountChanged(overlayCount);
};

/** Wallet-drawn sheets (the subscribe sheet) up right now; counted like overlays. */
let sheets = 0;
export const sheetOverBrowser = (on: boolean) => {
  sheets = Math.max(0, sheets + (on ? 1 : -1));
  onOverlayCountChanged(overlayCount);
};

/** Approval prompts render in the wallet WebView, under the browser: step it aside. */
export const onOverlayCountChanged = (raw: number) => {
  overlayCount = raw;
  const count = raw + sheets;
  if (!open) return;
  if (count > 0 && !hiddenForOverlay) {
    hiddenForOverlay = true;
    void YoursNative.browserSetHidden({ hidden: true });
  } else if (count === 0 && hiddenForOverlay) {
    hiddenForOverlay = false;
    void YoursNative.browserSetHidden({ hidden: false });
  }
};

let contextFactory: ContextFactory | undefined;

/**
 * One wallet call from a site, on behalf of `origin` (already verified by the caller: the native
 * WebView's frame info, or a postMessage from our own bApp iframe). Returns the wallet's
 * { success, data, error } reply. Shared by the full-screen browser and in-frame bApps.
 */
export const handleSiteCall = async (origin: string, url: string, type: string, params: unknown, paired = false) => {
  if (!contextFactory) throw new Error('Wallet not ready');
  const o = new URL(origin);
  // Phone-paired sessions have their own permission key (originKey.ts pairedOrigin); only they may use it.
  if (isPairedHost(o.hostname) !== paired) throw new Error('Reserved originator');
  // https only (plus loopback http for development): plain http must not share an https site's grants (M3).
  const key = originatorForOrigin(o.origin);
  if (!key.originator) throw new Error(key.error);
  // A site at http://yours-mobile/ would carry the wallet's own admin originator (security review H1).
  if (isReservedHost(o.host, MOBILE_EXTENSION_ID)) throw new Error('Reserved originator');
  if (!isCWIEventName(type)) throw new Error(`Unsupported request: ${type}`);
  if (url.startsWith(o.origin)) lastUrls.set(o.origin, url);
  let chrome = contexts.get(o.origin);
  if (!chrome) {
    chrome = contextFactory(`dapp:${o.origin}`, o.origin, url);
    contexts.set(o.origin, chrome);
  }
  // originator is derived from the verified origin, as content.ts derives it from window.location.host.
  return chrome.runtime.sendMessage({ action: type, params: params ?? {}, originator: key.originator });
};

export const initDappBrowser = (createContext: ContextFactory) => {
  contextFactory = createContext;
  if (!isNative) return;

  void YoursNative.addListener('browserClosed', () => {
    open = false;
    hiddenForOverlay = false;
  });

  void YoursNative.addListener('browserRequest', async (req) => {
    let response: unknown;
    try {
      const { type, params } = JSON.parse(req.payload) as { type: string; params?: unknown };
      // Subscribe with bWalletX (docs/SUBSCRIBE-API.md): origin from the native WebView, never the page.
      // SUBSCRIPTIONS_ENABLED written out (literal env) so the minifier drops it from a store bundle.
      if (
        !(
          import.meta.env.VITE_STORE_BUILD === '1' ||
          import.meta.env.VITE_CHANNEL === 'ios-store' ||
          import.meta.env.VITE_CHANNEL === 'android-play'
        ) &&
        type === 'BWX_SUBSCRIBE'
      )
        response = await (await import('./pots/siteSubscribe')).answerSiteSubscribe(req.origin, params);
      else response = await handleSiteCall(req.origin, req.url ?? '', type, params);
    } catch (error) {
      response = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    await YoursNative.browserRespond({
      requestId: req.requestId,
      response: JSON.stringify(response ?? { success: false, error: 'No response from wallet' }),
    });
  });
};

/** Route a context's window.open(http[s]) into the dApp browser. */
export const routeWindowOpen = (win: Window) => {
  if (IS_TAURI) return routeWindowOpenDesktop(win);
  if (!isNative) return;
  const original = win.open.bind(win);
  win.open = ((url?: string | URL, target?: string, features?: string) => {
    const raw = url === undefined ? '' : String(url);
    const href = raw === '' ? '' : new URL(raw, win.location.href).href;
    if (/^https?:/i.test(href)) {
      openDappBrowser(href).catch((error) => console.error('[dapp browser]', error));
      return null;
    }
    return original(url, target, features);
  }) as typeof win.open;
};

/** Desktop (Tauri): the webview opens no windows of its own; web links go to the default browser. */
const routeWindowOpenDesktop = (win: Window) => {
  const original = win.open.bind(win);
  win.open = ((url?: string | URL, target?: string, features?: string) => {
    const raw = url === undefined ? '' : String(url);
    const href = raw === '' ? '' : new URL(raw, win.location.href).href;
    if (/^(https?|mailto):/i.test(href)) {
      openExternal(href).catch((error) => console.error('[desktop] open link', error));
      return null;
    }
    return original(url, target, features);
  }) as typeof win.open;
};
