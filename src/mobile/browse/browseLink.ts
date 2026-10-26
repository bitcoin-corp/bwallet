import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/**
 * "Open in bWallet's browser": a site links to
 *   https://www.bwallet.space/browse?url=<https url>      (iOS universal link / Android app link)
 *   bwalletx://browse?url=<https url>                      (app-scheme fallback, site/browse.html)
 * and the app shows the target's host and, on Open, loads it in the in-app browser (dappBrowser). Nothing is
 * connected or granted: the page asks to connect as usual.
 */
const LINK_HOSTS = new Set(['www.bwallet.space', 'bwallet.space']);
export const BROWSE_URL_MAX = 2048;

/** The https page a browse link opens, or null for anything else (other schemes, userinfo, junk). */
export const parseBrowseLink = (link: string | null | undefined): string | null => {
  if (!link) return null;
  try {
    const u = new URL(link);
    const ours =
      (u.protocol === 'https:' && LINK_HOSTS.has(u.host) && u.pathname === '/browse') ||
      (u.protocol === 'bwalletx:' && (u.host === 'browse' || u.pathname.replace(/^\/+/, '') === 'browse'));
    if (!ours) return null;
    const raw = u.searchParams.get('url');
    if (!raw || raw.length > BROWSE_URL_MAX) return null;
    const t = new URL(raw);
    if (t.protocol !== 'https:' || t.username || t.password || !t.hostname) return null;
    return t.toString();
  } catch {
    return null;
  }
};

let pending: string | null = null;
const listeners = new Set<() => void>();
export const offerBrowseLink = (link?: string | null) => {
  const target = parseBrowseLink(link);
  if (!target) return false;
  pending = target;
  listeners.forEach((l) => l());
  return true;
};
export const takeBrowseLink = () => {
  const t = pending;
  pending = null;
  return t;
};
export const onBrowseLink = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => void offerBrowseLink(url));
  void CapApp.getLaunchUrl().then((r) => void offerBrowseLink(r?.url));
}
