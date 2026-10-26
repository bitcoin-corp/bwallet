/**
 * Space pages, invites and room pages opening the app (invite.ts parses them):
 *   bwalletx://space/<slug>  · https://<host>/s/<slug>  → the Spaces screen on that Space    (BSPACES_ENABLED)
 *   bwalletx://invite/<code> · https://<host>/i/<code>  → counts a use, then the Space or the room
 *   bwalletx://room/<ticker> · https://<host>/r/<ticker> → the room; without the token, its existing
 *                                                          get-entry (locked) screen with Buy   (token rooms)
 * The https forms need universal / app links (docs/BSPACES-PLAN.md, "To make it live").
 *
 * Gating: Space links only with BSPACES_ENABLED (inlined, so a store build drops them); room links
 * and room invites follow token rooms (tokenRoomsEnabled(), off in a store build). Held until a
 * screen with the router takes it.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { BSPACES_ENABLED, tokenRoomsEnabled, XINVITES_ENABLED } from '../storeBuild';
import { offerXInvite, openXInviteInBrowser, parseXInviteLink } from '../chat/xInvites';
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { requestChatRoom } from '../chat/nav';
import { isNative } from '../native';
import { parseThemeLink } from '../theme/themeLink';
import { requestThemeSheet } from '../theme/themeNav';
import { parseComposeLink } from '../bmail/meeting';
import { openBMailDraft } from '../bmail/store';
import { parseAppLink, parsePage, parseSpaceInvite, type AppLink, type RoomPage } from './invite';

const ROOM_LINKS = tokenRoomsEnabled();
const LINKS_ON = BSPACES_ENABLED || ROOM_LINKS;

let pending: AppLink | null = null;
let xPending = false;
const listeners = new Set<() => void>();

/** Accepts a link if this build handles its kind. */
export const offerAppLink = (url?: string | null) => {
  // bwalletx://theme/<pack> (bwalletx.com/themes Install): Theme › App colours offers that pack, every build.
  const theme = parseThemeLink(url);
  if (theme) return requestThemeSheet(theme);
  // bwalletx://mail/compose?to=&subject=&body= (bChatX meeting invites, owner 26 Oct 2026): Compose, pre-filled.
  // Every build. The user presses Send; nothing is sent from a link.
  const compose = parseComposeLink(url);
  if (compose) return openBMailDraft(compose);
  // Room X invite (…/i/x/<code>#k=…): the key stays in memory until the Chat claim screen takes it.
  // A build without X invites (Play / App Store) never swallows one: bchatx.com's web page opens instead.
  if (!XINVITES_ENABLED) {
    if (url && openXInviteInBrowser(url)) return;
  }
  const x = XINVITES_ENABLED ? parseXInviteLink(url) : null;
  if (x) {
    offerXInvite(x);
    xPending = true;
    listeners.forEach((l) => l());
    return;
  }
  const link = parseAppLink(url);
  if (!link) return;
  if (link.kind === 'space' && !BSPACES_ENABLED) return;
  if (link.kind === 'room' && !ROOM_LINKS) return;
  if (link.kind === 'invite' && !LINKS_ON) return;
  pending = link;
  listeners.forEach((l) => l());
};
export const takeAppLink = () => {
  const c = pending;
  pending = null;
  return c;
};

export const onAppLink = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

// Always listen on device: even a build without these screens must hand /i/x/ links to the browser.
if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => offerAppLink(url));
  void CapApp.getLaunchUrl().then((r) => offerAppLink(r?.url));
}

const client = () => new BchatClient(defaultHttp(isNative), loadSession());

/** The room's token key from its public page; null when it has none (then the chat list opens). */
const roomKey = (page: RoomPage | null) => {
  const g = page?.gate;
  return g?.key && (g.kind === 'bsv21' || g.kind === 'coll') ? g.key : null;
};

/**
 * Opens a room: requestChatRoom(key) shows the room to a holder and the existing locked screen
 * (entry rule, Buy in the Market) to anyone else, so "buy to enter" reuses that flow.
 */
const openRoom = async (ticker: string, go: (path: string) => void) => {
  const page = await client()
    .roomPage(ticker)
    .then(parsePage)
    .catch(() => null);
  const key = roomKey(page?.kind === 'room' ? page : null);
  if (key) requestChatRoom(key);
  go('/m/chat');
};

/** Mounted once by the top bar (or PhoneShell): a link goes to its screen. */
export const useSpaceInviteLinks = (enabled = true) => {
  const navigate = useNavigate();
  useEffect(() => {
    if (!LINKS_ON || !enabled) return;
    const go = () => {
      if (xPending) {
        xPending = false;
        navigate('/m/chat');
        return;
      }
      const link = takeAppLink();
      if (!link) return;
      if (link.kind === 'space') return navigate(`/m/spaces?space=${link.slug}`);
      if (link.kind === 'room') return void openRoom(link.ticker, navigate);
      // An invite: what it opens is only known from the server.
      void (async () => {
        const inv = parseSpaceInvite(
          await client()
            .openInvite(link.code)
            .catch(() => null),
        );
        if (inv?.target.kind === 'room') {
          if (ROOM_LINKS) await openRoom(inv.target.ticker, navigate);
          return;
        }
        if (BSPACES_ENABLED) navigate(`/m/spaces?invite=${link.code}`);
      })();
    };
    go();
    return onAppLink(go);
  }, [navigate, enabled]);
};
