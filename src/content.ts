/* global chrome */

import { isCWIEventName } from '@1sat/wallet-browser';
import { isSpendingAuthAction } from './services/streamGrants';
import { CustomListenerName, RequestEventDetail, RequestParams } from './inject';
import { originatorForOrigin } from './services/originKey';
import { forwardCwiCall } from './services/cwiForward';
import { SUBSCRIPTIONS_ENABLED } from './mobile/storeBuild';
import { HANDOFF_ENABLED, HANDOFF_WEB_ORIGIN } from './mobile/passkey/extHandoff';

console.log('🌱 Yours Wallet Loaded');

// inject.js runs as a MAIN-world content script (see manifest.json), so
// window.CWI is bound before any page script executes.

// Forward CWI requests from page to background service worker
self.addEventListener(CustomListenerName.YOURS_REQUEST, (e: Event) => {
  const { type, messageId, params: originalParams = {} } = (e as CustomEvent<RequestEventDetail>).detail;
  if (!type || !(isCWIEventName(type) || isSpendingAuthAction(type))) return;

  let params: RequestParams = {};

  if (Array.isArray(originalParams)) {
    params.data = originalParams;
  } else if (typeof originalParams === 'object') {
    params = { ...params, ...originalParams };
  }

  // Use originator at message level (BRC-100 standard). Keyed by origin: plain-http pages (other than loopback)
  // are refused so they never share an https site's grants or allowances (security review M3).
  const { originator, error } = originatorForOrigin(window.location.origin);
  if (!originator) {
    self.dispatchEvent(new CustomEvent(messageId, { detail: { success: false, error } }));
    return;
  }

  // Always answers the page, even when the extension was reloaded under this tab (services/cwiForward.ts).
  forwardCwiCall(chrome.runtime as unknown as Parameters<typeof forwardCwiCall>[0], { action: type, params, originator }, (detail) =>
    self.dispatchEvent(new CustomEvent(messageId, { detail })),
  );
  try {
    siteThemeConnected();
  } catch {
    /* extension reloaded */
  }
});

// Connected-site theme (src/mobile/theme/connectTheme.ts): once this page has talked to the wallet, tell the
// background which theme it declares (<meta name="bwalletx-theme" content="npgx">), and again when that changes
// (@bwalletx/connect removes it on disconnect). Only the id is sent; the background takes the origin from Chrome
// and paints only a pack the wallet bundles. Top frame only.
let themeWatch: MutationObserver | undefined;
let sentTheme: string | null | undefined;
// Path sub-themes (docs/SITE-THEME.md): a single-page app changing route re-sends, so the background reads the new
// path from Chrome's sender.url. Nothing about the path is taken from this message.
let sentPath: string | undefined;
const sendSiteTheme = () => {
  const v = document.querySelector('meta[name="bwalletx-theme"]')?.getAttribute('content')?.trim() || null;
  const theme = v && v.length <= 32 ? v : null;
  if (theme === sentTheme && location.pathname === sentPath) return;
  sentPath = location.pathname;
  // The meta going away is NOT a disconnect (25 Oct 2026): a React re-render or a route to a page without it removes
  // it mid-session, and that made the wallet ask "Reconnect?" in the middle of a paid game. Sites post
  // bwallet:disconnect instead (below; services/reconnectGate.ts).
  sentTheme = theme;
  try {
    chrome.runtime.sendMessage({ action: 'bwxSiteTheme', theme })?.catch(() => undefined);
  } catch {
    /* extension reloaded */
  }
};
function sendDisconnect() {
  try {
    chrome.runtime.sendMessage({ action: 'bwxSiteDisconnect' })?.catch(() => undefined);
  } catch {
    /* extension reloaded */
  }
}
// A site's own Disconnect button: window.postMessage({ type: 'bwallet:disconnect' }, location.origin). Top frame
// only; the background takes the origin from Chrome. It only makes the next identity-key request ask first.
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || window.top !== window) return;
  if ((e.data as { type?: unknown } | null)?.type === 'bwallet:disconnect') sendDisconnect();
});
function siteThemeConnected() {
  if (themeWatch || window.top !== window) return;
  themeWatch = new MutationObserver(sendSiteTheme);
  themeWatch.observe(document.head ?? document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['content', 'name'],
  });
  sendSiteTheme();
  setInterval(sendSiteTheme, 1000);
}

// bWalletX: tell the page whether to be the wallet websites connect to (window.CWI over another
// wallet such as Yours). Default on; Settings › Websites turns it off (src/brand/cwi.ts).
chrome.storage?.local.get('bwalletxTakeCwi', (r) => {
  const take = r?.bwalletxTakeCwi !== false;
  const send = () => self.dispatchEvent(new CustomEvent('bwalletx:cwi-pref', { detail: { take } }));
  send();
  setTimeout(send, 300); // the MAIN-world script may not be listening yet at document_start
});

// Live balance (docs/LIVE-BALANCE.md): a dApp that funded a session through this wallet (a TokenBlaster gun pack)
// may report what it spends from it with window.postMessage({ type: 'bwallet:session-spend', … }). Forwarded to the
// wallet page with this page's host; the page checks it against the sender origin and only lowers its meter.
// Never sent to wallet methods (background.ts ignores the action). Light pre-check and at most 20 a second here.
let liveSec = 0;
let liveN = 0;
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || (e.data as { type?: unknown } | null)?.type !== 'bwallet:session-spend') return;
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== liveSec) {
    liveSec = sec;
    liveN = 0;
  }
  if (++liveN > 20) return;
  try {
    chrome.runtime
      .sendMessage({ action: 'bwxSessionSpend', data: e.data, originator: window.location.host })
      ?.catch(() => undefined);
  } catch {
    /* extension reloaded: nothing to tell */
  }
});

// Subscribe with bWalletX (docs/SUBSCRIBE-API.md): the page posts { type: 'BWX_SUBSCRIBE', … } to itself. Forwarded
// to the open wallet page (side panel / popup), which takes the origin from Chrome's sender, never from here or the
// page. background.ts ignores the action. Only the page's own window (not a child frame); at most one in flight.
if (SUBSCRIPTIONS_ENABLED) {
  let subBusy = false;
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: unknown; isInvocation?: unknown; id?: unknown } | null;
    if (e.source !== window || d?.type !== 'BWX_SUBSCRIBE' || d.isInvocation !== true) return;
    const reply = (r: unknown) => window.postMessage(r, location.origin);
    const error = (description: string) =>
      reply({ type: 'BWX_SUBSCRIBE', isInvocation: false, id: d.id, status: 'error', description });
    if (subBusy) return error('Another subscription request is open');
    subBusy = true;
    try {
      chrome.runtime.sendMessage({ action: 'bwxSubscribe', data: d }, (r: unknown) => {
        subBusy = false;
        if (chrome.runtime.lastError || !r) return error('Open bWalletX (click its icon), then try again');
        reply(r);
      });
    } catch {
      subBusy = false;
      error('bWalletX was updated: reload this page');
    }
  });
}

// Passkey hand-off (notes/extension-passkey-handoff.md, VITE_SEEDLESS=1 builds only). web.bwalletx.com posts
// { type: 'BWX_EXT_HANDOFF', isInvocation: true, msg } to its own window; ONLY that exact origin, from its own window
// (not a child frame), is forwarded, over Chrome's internal route, to the background, which re-checks sender.origin
// and the one-time request. The reply carries only ok true/false. The words are never logged here.
if (HANDOFF_ENABLED) {
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: unknown; isInvocation?: unknown; msg?: unknown } | null;
    if (e.source !== window || e.origin !== HANDOFF_WEB_ORIGIN || d?.type !== 'BWX_EXT_HANDOFF') return;
    if (d.isInvocation !== true) return;
    const reply = (ok: boolean) =>
      window.postMessage({ type: 'BWX_EXT_HANDOFF', isInvocation: false, ok }, HANDOFF_WEB_ORIGIN);
    try {
      chrome.runtime.sendMessage({ action: 'bwxExtHandoff', data: d.msg }, (r: { ok?: boolean } | undefined) =>
        reply(!chrome.runtime.lastError && r?.ok === true),
      );
    } catch {
      reply(false);
    }
  });
}

// In-page wallet sheet (docs/ONE-SHEET-PERMISSIONS.md §3d). When the side panel can't open, the background asks
// for the wallet's own approval page (prompt.html, extension origin) as a sheet over this site. It sits in a
// closed shadow root, so the site's scripts can't reach the frame or read its address (which carries the
// one-time token); the page inside checks that token with the background and only arms its buttons once it is
// fully visible. Answers go from that page straight to the background, never through the site.
let sheetHost: HTMLElement | undefined;
const hideSheet = () => {
  sheetHost?.remove();
  sheetHost = undefined;
};
const showSheet = (src: string) => {
  hideSheet();
  const host = document.createElement('div');
  host.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483647;');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .scrim{position:fixed;inset:0;background:rgba(0,0,0,.45)}
    .sheet{position:fixed;right:16px;bottom:16px;width:min(380px,calc(100vw - 32px));height:min(600px,calc(100vh - 32px));
      border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);border:1px solid #ffffff1f;background:#010101}
    @media (max-width:520px){.sheet{right:0;bottom:0;width:100vw;height:min(620px,92vh);border-radius:20px 20px 0 0}}
    iframe{width:100%;height:100%;border:0;display:block;color-scheme:normal}`;
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.title = 'bWalletX';
  frame.allow = 'usb; hid';
  sheet.appendChild(frame);
  root.append(style, scrim, sheet);
  (document.body ?? document.documentElement).appendChild(host);
  sheetHost = host;
};
try {
  chrome.runtime.onMessage.addListener((msg: { action?: string; query?: string }, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.action === 'BWX_INPAGE_SHEET_SHOW' && typeof msg.query === 'string') {
      if (window.top !== window) return false; // only the top frame shows the sheet (and answers)
      // Always the wallet's own prompt page, never an address from the message.
      showSheet(`${chrome.runtime.getURL('prompt.html')}?${msg.query}`);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.action === 'BWX_EXIT_FULLSCREEN') {
      // A fullscreen page hides the wallet's approval surfaces; only the wallet's own background can ask.
      const wasFullscreen = !!document.fullscreenElement;
      if (wasFullscreen) document.exitFullscreen().catch(() => undefined);
      sendResponse({ ok: true, wasFullscreen });
      return false;
    }
    if (msg?.action === 'BWX_INPAGE_SHEET_HIDE') {
      if (window.top !== window) return false;
      hideSheet();
      sendResponse({ ok: true });
    }
    return false;
  });
} catch {
  /* extension reloaded */
}
