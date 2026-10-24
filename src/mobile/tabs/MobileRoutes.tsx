import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { TermsGate } from '../ugc/UgcSheets';
import { SectionBoundary } from '../wallet/SectionBoundary';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { BannerActions } from '../../web/BannerActions';
import { ReportOutboxRunner } from '../agent/reportSend';
import { setAgentDraft } from '../agent/handoff';
import { OpenPartnerRequest } from '../placement/partnership/OpenPartnerRequest';
import {
  ARTIST_PROGRAMME_ENABLED,
  BPOSITIVE_ENABLED,
  BSPACES_ENABLED,
  BUREAU_ENABLED,
  DIRECT_UPDATE_ENABLED,
  MARKET_ENABLED,
  PAY_STREAM_ENABLED,
  PLACEMENT_ENABLED,
  BTRUST_ENABLED,
  RELEASES_ENABLED,
} from '../storeBuild';

/** Mobile-only tab routes, mounted by vite.config.mobile.ts at /m/* in App.tsx. */
const SettingsHub = lazy(() => import('./SettingsHub'));
// Android direct APK only: once-per-version "update available" banner (update/UpdateCard.tsx).
const DirectUpdateBanner = DIRECT_UPDATE_ENABLED
  ? lazy(() => import('../update/UpdateCard').then((m) => ({ default: m.DirectUpdateBanner })))
  : null;
const UpdateBanner = () => {
  const { handleSelect } = useBottomMenu();
  return DirectUpdateBanner ? <DirectUpdateBanner onOpen={() => handleSelect('settings', 'about')} /> : null;
};
// bSpaces (Apps › bSpaces): bWalletX only, not even built into a store edition.
const SpacesPage = BSPACES_ENABLED ? lazy(() => import('../spaces/SpacesPage')) : null;
const CalendarPage = BSPACES_ENABLED ? lazy(() => import('../spaces/CalendarPage')) : null;
// bPositive (bpositive/): bWalletX only, not even built into a store edition.
const BPositivePage = BPOSITIVE_ENABLED ? lazy(() => import('../bpositive/BPositivePage')) : null;
// No Market in a store build (storeBuild.ts MARKET_ENABLED): the chunk is not even built.
const ExchangePage = MARKET_ENABLED ? lazy(() => import('../exchange/ExchangePage')) : null;
// bPics (Apps › bPics): picture ordinals; mint, shared library, mine.
const BPicsPage = lazy(() => import('../bpics/BPicsPage'));
const FeedTab = lazy(() => import('../feed/FeedTab'));
const ChatPage = lazy(() => import('./ChatPage'));
const MediaPage = lazy(() => import('../media/MediaPage'));
// bMusic artist screens (/bmusic/artists[/<slug>]): bWalletX only, with prices, so not in a store build.
const ArtistsPage = PAY_STREAM_ENABLED ? lazy(() => import('../media/artists/ArtistsPage')) : null;
// Join as an artist (docs/ARTIST-PROGRAMME.md): off by default until the bMusic server's programme routes are on.
const JoinArtistPage = ARTIST_PROGRAMME_ENABLED
  ? lazy(() => import('../media/artists/programme/JoinArtistPage'))
  : null;
// bWalletX only: absent from a store build (RELEASES_ENABLED).
const AddReleasePage = RELEASES_ENABLED ? lazy(() => import('../media/releases/AddReleasePage')) : null;
const AgentPage = lazy(() => import('../agent/AgentPage'));
const MyReportsPage = lazy(() => import('../agent/MyReportsPage'));
// bMail › Agreements (was the Bureau): bWalletX only (storeBuild.ts BUREAU_ENABLED); not built for the stores.
const AgreementsPage = BUREAU_ENABLED ? lazy(() => import('../bureau/AgreementsPage')) : null;
const BitSignImportPage = BUREAU_ENABLED ? lazy(() => import('../bureau/BitSignImportPage')) : null;
// The top bar's mailbox: bMail in the content area, between the top bar and the tab bar.
const BMailPage = lazy(() => import('../bmail/BMailPage'));
// The top bar's phone button: bPhone Calls in the content area (active calls stay full-screen via CallScreen).
const CallsPage = lazy(() => import('../calls/CallsPage'));
// You: Names, Rooms and Tickets as three separate things (you/YouPage.tsx).
const YouPage = lazy(() => import('../you/YouPage'));
// Phone layout (phone/, Settings › Testing switch): HOME, Games and People swipe screens. Apps stays /browser.
const HomeScreen = lazy(() => import('../phone/HomeScreen'));
const PeopleScreen = lazy(() => import('../phone/PeopleScreen'));
const BrowserPage = lazy(() => import('../BrowserPage'));
const BappLinkPage = lazy(() => import('../bappFrame/BappLinkPage'));
// The phone top bar's Lock BSV button (locks/, docs/TIME-LOCK-PLAN.md).
const LockScreen = lazy(() => import('../locks/LockScreen'));
// Desktop sidebar › Tickets / Credits (wide/WalletKindPages.tsx).
const TicketsPage = lazy(() => import('../wide/WalletKindPages').then((m) => ({ default: m.TicketsPage })));
const MyNamesPage = lazy(() => import('../wide/WalletKindPages').then((m) => ({ default: m.MyNamesPage })));
// Wallet › Friends is the address book notebook (wallet/AddressBook.tsx, owner 15 Oct 2026); /m/friends/<slug> keeps
// a friend's own page.
const AddressBookPage = lazy(() => import('../wallet/AddressBook').then((m) => ({ default: m.AddressBookPage })));
const CreditsPage = lazy(() => import('../wide/WalletKindPages').then((m) => ({ default: m.CreditsPage })));
// Wallet › NFTs library (Desktop /wallet/nfts[/<outpoint>], docs/NFT-LIBRARY.md).
const NftLibraryPage = lazy(() => import('../nfts/NftLibraryPage'));
// Desktop sidebar › Friends (/wallet/friends, docs/FRIENDS.md).
const FriendsPage = lazy(() => import('../friends/FriendsPage'));
// bMint (/m/bmint/*: Notes, OpNS names…), bmint/BmintPage.tsx; OpNS names renders inside it at /m/bmint/opns.
// Old /opns-mint links redirect there, keeping ?mint=.
const BmintPage = lazy(() => import('../bmint/BmintPage'));
// bTrust (/m/btrust): recovery slices, passing on, important papers. btrust/BTrustPage.tsx.
const BTrustPage = BTRUST_ENABLED ? lazy(() => import('../btrust/BTrustPage')) : null;
// bShares (/m/bshares, docs/BCORP-PLACEMENT.md): restricted share placement; bWalletX only, dropped from the store bundle.
const BsharesPage = PLACEMENT_ENABLED ? lazy(() => import('../placement/BsharesPage')) : null;
// The Name Store (/m/names, public /names): search, buy, claim and give names (names/store/).
const NameStorePage = lazy(() => import('../names/store/NameStorePage'));
// bStore (/m/store, themeStore/, docs/BSTORE.md): Themes + Names everywhere; bWalletX also paid themes, Subscriptions, Credits, Stickers, Services, Community (THEME_STORE_PAID_ENABLED).
const ThemeStorePage = lazy(() => import('../themeStore/ThemeStorePage'));
// /names/store: the shop's stock (listed by tier, other sellers, held unlisted), names/store/StockPage.tsx.
const StockPage = MARKET_ENABLED ? lazy(() => import('../names/store/StockPage')) : null;
// Short share link for Check this mint: /check?o=<outpoint> → /m/bmint/check?o=….
const ToCheck = () => <Navigate to={`/m/bmint/check${useLocation().search}`} replace />;
const ToOpnsMint = () => <Navigate to={`/m/bmint/opns${useLocation().search}`} replace />;
// Short mint link: /m/mint/<type>[?…] → /m/bmint/mint/<type>[?…]. dns-dex.com links /m/mint/domain?d=<domain>.
const ToMint = () => {
  const { type = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/m/bmint/mint/${encodeURIComponent(type)}${search}`} replace />;
};
// Link into b with a request typed in: /m/ask-b?ask=<text> (badvertisingx.com "Ask b to make your ad").
// It only fills the composer: the user still presses send, and paid work still goes through the consent sheet.
const ASK_MAX = 500;
const AskB = () => {
  const { search } = useLocation();
  const ask = new URLSearchParams(search).get('ask');
  if (ask) {
    setAgentDraft(ask.slice(0, ASK_MAX));
    return <Navigate to="/m/ask-b" replace />;
  }
  return <AgentPage />;
};
// Desktop top bar bell: notifications as a page in the main column (notify/NotificationsPage.tsx).
const NotificationsPage = lazy(() => import('../notify/NotificationsPage'));
const LockVerify = () => <LockScreen initialVerify={new URLSearchParams(window.location.search).get('tx') ?? ''} />;

// No app-wide error boundary upstream: one throw blanked the whole page (owner, 6 Oct 2026).
const MobileRoutes = () => (
  <SectionBoundary name="mobile tab" screen>
    <Suspense fallback={null}>
      {DirectUpdateBanner && <UpdateBanner />}
      {/* The web build's hazard-tape banner buttons (src/web/betaBanner.ts). */}
      <BannerActions />
      {/* Sends reports to b that couldn't go at the time (agent/reportOutbox.ts). */}
      <ReportOutboxRunner />
      {/* A tapped shared-account request push opens the Lock page (placement/partnership/openRequest.ts). */}
      <OpenPartnerRequest />
      <Routes>
        <Route path="settings" element={<SettingsHub />} />
        {/* The top bar's Play button: music & video. */}
        <Route path="media" element={<MediaPage />} />
        <Route path="media/album/:albumId" element={<MediaPage />} />
        <Route path="media/browse" element={<MediaPage />} />
        <Route path="media/artists" element={ArtistsPage ? <ArtistsPage /> : <MediaPage />} />
        {JoinArtistPage && <Route path="media/artists/join" element={<JoinArtistPage />} />}
        <Route path="media/artists/:slug" element={ArtistsPage ? <ArtistsPage /> : <MediaPage />} />
        {AddReleasePage && <Route path="media/new" element={<AddReleasePage />} />}
        <Route
          path="bpics"
          element={
            <TermsGate>
              <BPicsPage />
            </TermsGate>
          }
        />
        {/* The top bar's centre b: the b agent. */}
        <Route path="ask-b" element={<AskB />} />
        {/* Everything you told b, and where each report stands (18 Oct 2026). */}
        <Route path="reports" element={<MyReportsPage />} />
        {AgreementsPage && <Route path="bmail/agreements" element={<AgreementsPage />} />}
        {BitSignImportPage && <Route path="bmail/agreements/bit-sign" element={<BitSignImportPage />} />}
        {/* The Bureau moved into bMail (18 Oct 2026): old links land there. */}
        {AgreementsPage && <Route path="bureau" element={<Navigate to="/m/bmail/agreements" replace />} />}
        {/* Old links (/agent, /m/agent) keep working (renamed Ask b, 12 Oct 2026). */}
        <Route path="agent" element={<Navigate to="/m/ask-b" replace />} />
        <Route path="bmail" element={<BMailPage />} />
        <Route path="bmint/*" element={<BmintPage />} />
        <Route path="check" element={<ToCheck />} />
        <Route path="mint/:type" element={<ToMint />} />
        {BTrustPage && <Route path="btrust" element={<BTrustPage />} />}
        {BsharesPage && <Route path="bshares" element={<BsharesPage />} />}
        <Route path="opns-mint" element={<ToOpnsMint />} />
        <Route path="names" element={<NameStorePage />} />
        <Route path="store" element={<ThemeStorePage />} />
        {StockPage && <Route path="names/store" element={<StockPage />} />}
        <Route path="calls" element={<CallsPage />} />
        <Route path="you" element={<YouPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="lock" element={<LockScreen />} />
        <Route path="lock/locks" element={<LockScreen />} />
        <Route path="lock/subscriptions" element={<LockScreen />} />
        <Route path="lock/verify" element={<LockVerify />} />
        <Route path="nfts" element={<NftLibraryPage />} />
        <Route path="nfts/:outpoint" element={<NftLibraryPage />} />
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="credits" element={<CreditsPage />} />
        <Route path="my-names" element={<MyNamesPage />} />
        <Route path="friends" element={<AddressBookPage />} />
        <Route path="friends/:slug" element={<FriendsPage />} />
        <Route path="home" element={<HomeScreen />} />
        <Route path="apps" element={<BrowserPage only="apps" />} />
        <Route path="bapp/:slug" element={<BappLinkPage />} />
        {/* Phone layout app screens 2, 3… (phone/pager.tsx renders them; this is the fallback with the switch off). */}
        <Route path="screen/:n" element={<BrowserPage only="apps" />} />
        <Route path="games" element={<BrowserPage only="games" />} />
        <Route path="people" element={<PeopleScreen />} />
        {/* The Exchange (was Market, 12 Oct 2026): /m/exchange, /m/exchange/swap, /m/exchange/<token>… */}
        {ExchangePage && <Route path="exchange/*" element={<ExchangePage />} />}
        {ExchangePage && <Route path="market/*" element={<Navigate to="/m/exchange" replace />} />}
        {BPositivePage && <Route path="bpositive" element={<BPositivePage />} />}
        {SpacesPage && <Route path="spaces" element={<SpacesPage />} />}
        {CalendarPage && <Route path="calendar" element={<CalendarPage />} />}
        {/* Shared spaces: the terms (zero tolerance, Apple 1.2) are agreed once before first use. */}
        <Route
          path="feed"
          element={
            <TermsGate>
              <FeedTab />
            </TermsGate>
          }
        />
        <Route
          path="chat"
          element={
            <TermsGate>
              <ChatPage />
            </TermsGate>
          }
        />
        {/* Chat › bApps on its own URL (/chat/bapps on Desktop and web): every bApp room, entry by ticket. */}
        <Route
          path="chat/bapps"
          element={
            <TermsGate>
              <ChatPage />
            </TermsGate>
          }
        />
      </Routes>
    </Suspense>
  </SectionBoundary>
);

export default MobileRoutes;
