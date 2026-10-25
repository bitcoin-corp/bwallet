/* eslint-disable @typescript-eslint/no-explicit-any */
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { createChromeShim } from './chromeShim';
import { Hub } from './hub';
import { IS_TAURI, invoke as tauriInvoke } from './desktop/ipc';
import { tauriLocalBackend } from './desktop/storage';
import type { PlatformHooks } from '../platform';
import { initBiometricUnlock } from './biometricUnlock';
import { handleBack } from './backStack';
import { phoneBack } from './phone/phoneBack';
import './phone/flag';
import { UNOFFICIAL_NOTICE } from './brandText';
import { initDappBrowser, onOverlayCountChanged, routeWindowOpen } from './dappBrowser';
import {
  closeOverlayForFrame,
  handleHostOp,
  removeOverlay,
  setOverlayCountHandler,
  setOverlayRemovedHandler,
  topOverlayId,
} from './overlays';
import { INTERNAL_ORIGIN, MOBILE_EXTENSION_ID, type Sender } from './protocol';
import { installOverlayFetch } from './overlayFetch';
import { initPushTaps } from './push/register';
import { initTesterCheckins } from './testers/checkin';
import '@fontsource/space-grotesk/700.css';
import './mobile.css';
import { applyBootAccent } from './theme/accent';

// App accent (Theme → App colours) before the first paint, so a non-gold accent never flashes gold.
applyBootAccent();

/**
 * Mobile entry point. Stands up the hub (the "browser"), the background
 * worker, and a chrome shim for this window, then loads the unmodified
 * extension popup UI (src/index.tsx).
 */

declare const __MOBILE_VERSION__: string;

// Token submissions to the 1Sat indexer go through native HTTP (CORS bug on api.1sat.app).
installOverlayFetch();

// Scopes Android-only WebView paint workarounds in mobile.css.
if (Capacitor.getPlatform() === 'android') document.documentElement.classList.add('android');

const rootUrl = new URL('./', location.href).href;
const senderFor = (url: string): Sender => ({ id: MOBILE_EXTENSION_ID, url, origin: INTERNAL_ORIGIN });
const defineChrome = (target: any, chrome: unknown) =>
  Object.defineProperty(target, 'chrome', { value: chrome, writable: true, configurable: true });

// Desktop (Tauri): storage.local lives in an owner-only file on the Rust side, not in the webview (desktop/storage.ts).
// Web + Desktop keep storage.session (the unlock key) in memory only; phones mirror it to the in-process WebView.
const hub = new Hub(handleHostOp, IS_TAURI ? tauriLocalBackend(tauriInvoke) : undefined, {
  persistSession: Capacitor.isNativePlatform(),
});

// Frames (overlay iframes) register here; swept when their overlay closes.
const frames = new Map<string, Window>();
setOverlayRemovedHandler((windowId) => {
  for (const [id, win] of frames) {
    if (win.closed || !win.frameElement) {
      frames.delete(id);
      hub.unregister(id);
    }
  }
  hub.broadcast({ t: 'windowRemoved', windowId });
});

const attachContext = (id: string, win: Window, sender: Sender = senderFor(win.location.href)) => {
  const { chrome, receive } = createChromeShim({
    post: (json) => queueMicrotask(() => void hub.handle(id, JSON.parse(json))),
    parse: (json) => (win as Window & typeof globalThis).JSON.parse(json),
    rootUrl,
    version: __MOBILE_VERSION__,
    timers: {
      setInterval: win.setInterval.bind(win),
      setTimeout: win.setTimeout.bind(win),
      clearInterval: win.clearInterval.bind(win),
    },
  });
  hub.register(id, { post: (json) => win.setTimeout(() => receive(json), 0), sender });
  return chrome;
};

// Called synchronously by an inline script at the top of every overlay page.
let frameSeq = 0;
(window as any).__yoursMobile = {
  attachFrame: (win: Window) => {
    const id = `frame-${++frameSeq}`;
    frames.set(id, win);
    win.addEventListener('pagehide', () => {
      frames.delete(id);
      hub.unregister(id);
    });
    // The prompt and USB pages close themselves when done.
    (win as any).close = () => closeOverlayForFrame(win);
    routeWindowOpen(win);
    return attachContext(id, win);
  },
};

// Background worker.
const worker = new Worker(new URL('./background.worker.ts', import.meta.url), { type: 'module' });
hub.register('background', { post: (json) => worker.postMessage(json), sender: senderFor(rootUrl + 'background.js') });
worker.addEventListener('message', (e) => {
  if (typeof e.data === 'string') void hub.handle('background', JSON.parse(e.data));
  else if (e.data?.t === 'ready') hub.markBackgroundReady();
  else if (e.data?.t === 'error') {
    // Release held messages anyway: listeners registered before the throw still answer, and without this every
    // runtime.sendMessage waited forever (owner, 6 Oct 2026: balance, tokens and sync all timing out).
    console.error('[background worker] failed to start:', e.data.message);
    hub.markBackgroundReady();
  } else if (e.data?.t === 'console') console[e.data.level as 'error' | 'warn' | 'log']('[background]', e.data.text);
});
worker.addEventListener('error', (e) => console.error('[background worker]', e.message, e));
worker.postMessage({ t: 'init', rootUrl, version: __MOBILE_VERSION__ });

// This window's own chrome (the "popup").
const mainChrome = attachContext('main', window);
defineChrome(window, mainChrome);
routeWindowOpen(window);
// Upstream's embedder hooks (src/platform.ts); overlay frames share this object.
const platform: PlatformHooks = { welcomeNotice: UNOFFICIAL_NOTICE, ...(await initBiometricUnlock(mainChrome)) };
(window as any).__yoursPlatform = platform;

// dApp browser: each site gets an endpoint carrying its real origin, not the
// internal one, so the background applies its external-caller rules.
setOverlayCountHandler(onOverlayCountChanged);
initDappBrowser((id, origin, url) => attachContext(id, window, { id: MOBILE_EXTENSION_ID, url, origin }));

// Web app (web.bwalletx.com, the iPhone route): the wallet's encrypted keys live in this site's storage. Ask the
// browser to keep it persistent so it isn't cleared under storage pressure (Safari grants this to Home Screen apps;
// Chrome to installed or engaged sites). The recovery phrase is still the only real backup.
if (!Capacitor.isNativePlatform() && !IS_TAURI) {
  void navigator.storage?.persist?.().catch(() => false);
}

if (Capacitor.isNativePlatform()) {
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
  CapApp.addListener('backButton', () => {
    const top = topOverlayId();
    if (top !== undefined) removeOverlay(top);
    // In-app sheets (useBackClose) first; then, in the phone layout, a strip page other than HOME goes HOME.
    else if (!handleBack() && !phoneBack()) void CapApp.minimizeApp();
  });
}

// Before the UI: a push tap that launched the app is held until PushEngine (after unlock) takes it.
initPushTaps();
initTesterCheckins();
// PROTOTYPE (demo/desktop-shell): wide web layout (wide/flag.ts) wraps the same app; otherwise nothing changes.
if ((await import('./wide/flag')).WIDE_ON) {
  document.querySelector('.bwallet-web-banner')?.remove();
  // Desktop opens with the Just b advert before any screen (welcome, unlock or wallet): its own root, on top.
  void import('./wide/mountIntro').then((m) => m.mountJustBIntro());
}
await import('../index');
// Desktop (Tauri): deep links, tray (lock), native notifications, external links (desktop/boot.ts).
if (IS_TAURI) void import('./desktop/boot').then((m) => m.initDesktop(mainChrome));
