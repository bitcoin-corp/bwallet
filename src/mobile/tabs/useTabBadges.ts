import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';
import { useAirdrops } from '../airdrops/useAirdrops';
import { useBMailUnread } from '../bmail/useBMail';
import { loadSession, SESSION_EVENT } from '../chat/api';
import { roomKeyOf, useListPrefs } from '../chat/listPrefs';
import { setIconBadge } from './iconBadge';
import { badgesVersion, chatUnread, chatUnreadSplit, feedNew, markFeedViewed, subscribeBadges } from './tabBadges';

/** The signed-in chat handle (null when signed out), live across sign in / out. */
export const useChatHandle = () => {
  const [handle, setHandle] = useState<string | null>(() => loadSession()?.handle ?? null);
  useEffect(() => {
    const on = () => setHandle(loadSession()?.handle ?? null);
    window.addEventListener(SESSION_EVENT, on);
    return () => window.removeEventListener(SESSION_EVENT, on);
  }, []);
  return handle;
};

/** Live unread counts for the tabs (tabBadges.ts). Wallet has none: new tokens show in bMail. */
export const useTabBadges = () => {
  const v = useSyncExternalStore(subscribeBadges, badgesVersion);
  // On the Feed: everything known is seen (and stays seen as new posts load there).
  // The classic tab bar (BottomMenu) is rendered by BottomMenuProvider, ABOVE <Router>: the location hook throws there
  // (react-router invariant), which blanked the whole wallet right after unlock (owner, 16 Oct 2026). The context
  // read is null outside a router instead of throwing.
  const onFeed = (useContext(UNSAFE_LocationContext)?.location.pathname ?? '').startsWith('/m/feed');
  useEffect(() => {
    if (onFeed) markFeedViewed();
  }, [onFeed, v]);
  const handle = useChatHandle();
  const [prefs] = useListPrefs(handle);
  const muted = new Set(prefs.muted);
  const chat = handle ? chatUnread((t) => muted.has(roomKeyOf(t))) : 0;
  const bmail = useBMailBadge();
  // The extension's toolbar icon shows the same bMail number (iconBadge.ts; a no-op outside the extension).
  useEffect(() => setIconBadge(bmail), [bmail]);
  return { chat, feed: feedNew(), bmail };
};

/** bMail's count: new airdrops plus unread mail (the same number as the top-bar mailbox). */
export const useBMailBadge = () => {
  const { badge: drops } = useAirdrops();
  return drops + useBMailUnread();
};

/** Chat tab top filters: unread DMs and unread group / room messages (muted left out). Calls are counted in ChatSegments. */
export const useChatSplitBadges = (): { dms: number; rooms: number } => {
  useSyncExternalStore(subscribeBadges, badgesVersion);
  const handle = useChatHandle();
  const [prefs] = useListPrefs(handle);
  const muted = new Set(prefs.muted);
  return handle ? chatUnreadSplit((t) => muted.has(roomKeyOf(t))) : { dms: 0, rooms: 0 };
};
