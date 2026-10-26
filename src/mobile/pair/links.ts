import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PAIR_HOST } from '../../pair/protocol';
import { IS_EXTENSION } from '../extension';
import { isWebApp } from '../webApp';

/**
 * App links: scanning a site's pairing QR with the phone's own camera opens
 * https://www.bwallet.space/pair?… straight into bWallet (iOS universal link / Android app link,
 * site/.well-known). The link is held here until the wallet is unlocked and TopNav can show the
 * confirm screen.
 */
let pending: string | null = null;
const listeners = new Set<() => void>();

export const isPairLink = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.host === PAIR_HOST || u.host === 'bwallet.space') && u.pathname === '/pair';
  } catch {
    return false;
  }
};

/**
 * The https pairing link a URL stands for, or null:
 * - https://www.bwallet.space/pair?… itself;
 * - bwalletx://pair?… (site/pair.html "Open in the bWallet app": iOS ignores a universal link tapped on its own
 *   domain, so that button uses the app's scheme);
 * - the web wallet's entry, https://web.bwalletx.com/m/settings?bwxpair=1&<the same pairing params>.
 * Whatever comes back is still parsed and checked in full by parsePairUrl.
 */
export const pairLinkFrom = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (isPairLink(url)) return url;
    const rebuilt = (q: URLSearchParams) => {
      q.delete('bwxpair');
      return `https://${PAIR_HOST}/pair?${q}`;
    };
    if (u.protocol === 'bwalletx:' && (u.host === 'pair' || u.pathname.replace(/^\/+/, '') === 'pair'))
      return rebuilt(u.searchParams);
    if (u.protocol === 'https:' && u.searchParams.get('bwxpair') === '1') return rebuilt(u.searchParams);
    return null;
  } catch {
    return null;
  }
};
export const offerPairLink = (url?: string | null) => {
  const link = url ? pairLinkFrom(url) : null;
  if (!link) return;
  pending = link;
  listeners.forEach((l) => l());
};

/** Web wallet: a pairing handed over in this page's own URL (bwxpair=1). Taken once, then removed from the bar. */
if (isWebApp() && typeof location !== 'undefined' && new URLSearchParams(location.search).get('bwxpair') === '1') {
  offerPairLink(location.href);
  try {
    history.replaceState(null, '', location.pathname);
  } catch {
    /* no history */
  }
}

export const takePairLink = () => {
  const u = pending;
  pending = null;
  return u;
};
export const onPairLink = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => offerPairLink(url));
  void CapApp.getLaunchUrl().then((r) => offerPairLink(r?.url));
}

/**
 * Extension: opening https://www.bwallet.space/pair?… in Chrome is caught by the background worker
 * (background.ts, tabs.onUpdated), which stores it under PAIR_LINK_KEY and opens the side panel. The
 * panel takes it from there (on load, or live via storage.onChanged) and clears it.
 */
export const PAIR_LINK_KEY = 'bwalletxPendingPairLink';
if (IS_EXTENSION && typeof chrome !== 'undefined' && chrome.storage?.local) {
  const pick = (url?: unknown) => {
    if (typeof url !== 'string' || !url) return;
    void chrome.storage.local.remove(PAIR_LINK_KEY);
    offerPairLink(url);
  };
  chrome.storage.local.get(PAIR_LINK_KEY, (r) => pick(r?.[PAIR_LINK_KEY]));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch[PAIR_LINK_KEY]?.newValue) pick(ch[PAIR_LINK_KEY].newValue);
  });
}
