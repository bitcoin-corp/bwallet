import { hasOwnComposer, isAddAccountFlow } from './composer';
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import bgVideo from '../brand/bg/wallet-card.mp4';
import bgPoster from '../brand/bg/wallet-card.jpg';
import mark from '../brand/bwalletx-glyph.svg';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useAccountNames } from '../names/accountNames';
import { setWalletKind, getWalletKind, subscribeWalletKind, type WalletKind } from '../wallet/walletKind';
import {
  BSPACES_ENABLED,
  BUREAU_ENABLED,
  MARKET_ENABLED,
  marketLabel,
  STORE_HIDDEN_WALLET_KINDS,
  STORE_BUILD,
  BTRUST_ENABLED,
  PEOPLE_LABEL,
  SPACES_LABEL,
} from '../storeBuild';
import { badgeLabel, badgeText } from '../tabs/tabBadges';
import { useTabBadges } from '../tabs/useTabBadges';
import { NotificationsBell } from '../notify/NotificationsPanel';
import { CALLS_ROUTE } from '../calls/route';
import {
  DISPLAY_CURRENCIES,
  getDisplayCurrency,
  onDisplayCurrencyChange,
  setDisplayCurrency,
} from '../../utils/displayCurrency';
import { wwOpen } from './flag';
import { useHomeLayout } from '../home/useHomeLayout';
import { LockCoin } from '../tabs/TopNav';
import { AgentConversation } from '../agent/AgentConversation';
import { useWalletFeed } from './walletFeed';
import { BappHost } from './BappHost';
import { PersonPic } from './PersonPic';
import { useAvatar } from '../names/useAvatar';
import { WidePage, WideEmpty, WideTitle } from './WidePage';
import { WideAuth } from './WideAuth';
import { useCanInstall, installApp } from './install';
import { BAPPS, BAPP_ROUTE, bappFromPath, useBappBadge } from './bapps';
import { BAPPS as BAPP_ROOMS } from '../chat/bappRooms';

/** bApps with their own in-wallet page; the rest open their room (Chat › bApps). */
const BAPP_PAGES: Record<string, string> = {
  bcal: '/m/calendar',
  bstore: '/m/store',
  bmail: '/m/bmail',
  bmusic: '/m/media',
};
import './wide.css';

const HistoryScreen = lazy(() => import('../wallet/HistoryScreen'));
const BsvPriceChart = lazy(() => import('../wallet/PriceChart').then((m) => ({ default: m.BsvPriceChart })));
const Holdings = lazy(() => import('../home/Holdings'));

/* ---------- Wallet side pane (the classic Desktop wallet, restored 19 Oct 2026): the card column on the left, and
   here, right of it, the BSV price chart, History right under it, then Holdings. ---------- */
const WalletSide = () => (
  <div className="ww-side-stack">
    <div className="ww-panel">
      <div className="ww-panel-head">
        <span>BSV price</span>
        <span className="ww-muted ww-small">WhatsOnChain daily rate</span>
      </div>
      <Suspense fallback={null}>
        <BsvPriceChart />
      </Suspense>
    </div>
    <div className="ww-panel ww-flush ww-history">
      <Suspense fallback={null}>
        <HistoryScreen inline onClose={() => undefined} />
      </Suspense>
    </div>
    <Suspense fallback={null}>
      <Holdings />
    </Suspense>
  </div>
);

/**
 * PROTOTYPE (demo/desktop-shell): the wide web layout. Runs inside the real app (same providers, router and
 * services); the real screens render in the main column. Phone chrome (TopNav bar, tab bar, phone dock) is off
 * in this mode; TopNav stays mounted for its drawer, sheets and background jobs, opened from here (flag.ts wwOpen).
 * Every entry point is listed in PARITY.md.
 */

const Icon = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);
const I = {
  wallet: 'M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zm0 0 2-3h12M16 13.5h2',
  nfts: 'M4 4h16v16H4zM4 15l5-5 4 4 3-3 4 4',
  // A coin with a stamped star: bMint.
  mint: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5l1.3 2.7 3 .4-2.2 2.1.5 3-2.6-1.4-2.6 1.4.5-3-2.2-2.1 3-.4z',
  friends: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6',
  ticket: 'M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 1 0-4V4H3zM13 4v12',
  credits: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9h4a2 2 0 0 1 0 4H9v4M9 13h5',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  exchange: 'M7 7h13l-4-4M17 17H4l4 4',
  lockbsv: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4M12 15v2',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  calls: 'M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 6a2 2 0 0 1 2-2',
  chat: 'M21 12a8 8 0 0 1-12 7l-5 1 1-4a8 8 0 1 1 16-4z',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  spaces: 'M12 3a4 4 0 0 1 4 4v4a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4zM5 11a7 7 0 0 0 14 0M12 18v3',
  calendar: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 10h16M8 2v4M16 2v4',
  feed: 'M4 5h16M4 12h16M4 19h10',
  media: 'M8 5v14l11-7z',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  games: 'M6 12h4M8 10v4M15 11h.01M18 13h.01M3 8h18v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z',
  agent: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9v6h3.5a2 2 0 0 0 0-4H9',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 1-2-1V4h-4v3l-2 1-2-1-2 4 2 1-2 1 2 4 2-1 2 1v3h4v-3l2-1 2 1 2-4z',
  tools: 'M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 0-2-2z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
};

type Item = {
  id: string;
  label: string;
  icon: string;
  /** Bundled image icon (bApp rooms); drawn in place of the path icon. */
  img?: string | null;
  /** Route, a wallet view, or an action. */
  to?: string;
  kind?: WalletKind;
  select?: 'settings' | 'tools';
  act?: () => void;
  badge?: number;
  hidden?: boolean;
};

const ONBOARDING = ['/', '/create-wallet', '/restore-wallet', '/import-wallet', '/master-restore'];

const useCurrency = () => useSyncExternalStore(onDisplayCurrencyChange, getDisplayCurrency, getDisplayCurrency);

/* ---------- Shell ---------- */

const WideShell = ({ children }: { children: ReactNode }) => {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const canInstall = useCanInstall();
  const bmoviesBadge = useBappBadge('bmovies');
  const { chromeStorageService, lockWallet } = useServiceContext();
  const { handleSelect, selected, query } = useBottomMenu();
  const ccy = useCurrency();
  // bMail = airdrops + mail (same as the top-bar mailbox); Chat and Feed unread (tabs/tabBadges.ts).
  const unread = useTabBadges();
  const mail = unread.bmail;
  const kind = useSyncExternalStore(subscribeWalletKind, getWalletKind, getWalletKind);
  const feed = useWalletFeed();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const names = useAccountNames(
    account?.addresses?.identityAddress,
    account?.name ?? '',
    account?.settings?.socialProfile?.displayName ?? '',
  );
  // The account's own picture (names/useAvatar: X / Google photo, NFT or bAvatar), the same one the card shows.
  const myPic = useAvatar(account?.addresses?.identityAddress);

  const [section, setSection] = useState<'settings' | 'tools'>('settings');
  const go = (it: Item) => {
    if (it.act) return it.act();
    if (it.select) {
      setSection(it.select);
      handleSelect(it.select);
      navigate('/m/settings');
      return;
    }
    if (it.kind) setWalletKind(it.kind);
    if (it.to && it.to !== pathname) navigate(it.to);
  };

  const onWallet = pathname === '/bsv-wallet';
  const hiddenKind = (k: string) => STORE_BUILD && STORE_HIDDEN_WALLET_KINDS.includes(k);
  const groups: { title: string; items: Item[] }[] = [
    // Ask b first, above everything (owner, 11 Oct 2026).
    { title: '', items: [{ id: 'agent', label: 'Ask b', icon: I.agent, to: '/m/ask-b' }] },
    {
      title: 'Money',
      items: [
        { id: 'tokens', label: 'Wallet', icon: I.wallet, to: '/bsv-wallet', kind: 'tokens' },
        // Its own library page, /wallet/nfts (nfts/NftLibraryPage.tsx).
        { id: 'nfts', label: 'NFTs', icon: I.nfts, to: '/m/nfts' },
        // Every mint type in one place (bmint/BmintPage.tsx, owner 13 Oct 2026).
        { id: 'bmint', label: 'bMint', icon: I.mint, to: '/m/bmint' },
        // Names replaces Friends (owner, 15 Oct 2026): OpNS names + $handle paymails (wallet/NamesSection.tsx).
        { id: 'names', label: 'Names', icon: I.friends, to: '/m/my-names' },
        // Friends live in the address book notebook (/wallet/friends, wallet/AddressBook.tsx); a friend's own page
        // stays at /wallet/friends/<handle>.
        { id: 'friends', label: 'Address book', icon: I.friends, to: '/m/friends' },
        {
          id: 'tickets',
          label: 'Tickets',
          icon: I.ticket,
          to: '/m/tickets',
          hidden: hiddenKind('tickets'),
        },
        {
          id: 'credits',
          label: 'Credits',
          icon: I.credits,
          to: '/m/credits',
          hidden: hiddenKind('credits'),
        },
        { id: 'market', label: marketLabel(), icon: I.exchange, to: '/m/exchange', hidden: !MARKET_ENABLED },
        { id: 'lock', label: 'Lock BSV', icon: I.lockbsv, to: '/m/lock' },
        // bTrust: recovery slices and passing on. bWalletX only (BTRUST_ENABLED).
        ...(BTRUST_ENABLED ? [{ id: 'btrust', label: 'bTrust', icon: I.shield, to: '/m/btrust' }] : []),
      ],
    },
    {
      title: 'Talk',
      items: [
        // bMail and bMusic live in the bApps group in bWalletX (one entry each); the store edition keeps them here.
        { id: 'bmail', label: 'bMail', icon: I.mail, to: '/m/bmail', badge: mail, hidden: BSPACES_ENABLED },
        { id: 'chat', label: 'bChat', icon: I.chat, to: '/m/chat', badge: unread.chat },
        { id: 'calls', label: 'bPhone', icon: I.calls, to: CALLS_ROUTE },
        { id: 'people', label: PEOPLE_LABEL, icon: I.people, to: '/m/people' },
        { id: 'spaces', label: SPACES_LABEL, icon: I.spaces, to: '/m/spaces', hidden: !BSPACES_ENABLED },
      ],
    },
    {
      title: 'Discover',
      items: [
        { id: 'feed', label: 'bChatX Feed', icon: I.feed, to: '/m/feed', badge: unread.feed },
        { id: 'media', label: 'bMusic', icon: I.media, to: '/m/media', hidden: BSPACES_ENABLED },
        { id: 'apps', label: 'bApps', icon: I.apps, to: '/m/apps' },
        { id: 'games', label: 'bGames', icon: I.games, to: '/m/games' },
      ],
    },
    // The bApps (owner, 18 Oct 2026): each opens its in-wallet page, else its room under /chat/bapps. Not in a store build.
    {
      title: BSPACES_ENABLED ? 'bApps' : '',
      items: BAPP_ROOMS.map((b) => ({
        id: `room-${b.id}`,
        label: b.name,
        icon: I.apps,
        img: b.icon,
        // Rooms without a page open their own room: /m/chat/bapps?room=<TICKER> (ChatPage.tsx).
        to: BAPP_PAGES[b.id] ?? `/m/chat/bapps?room=${b.ticker}`,
        badge: b.id === 'bmail' ? mail : 0,
        hidden: !BSPACES_ENABLED,
      })),
    },
    // bApps pinned in the wide layout (BappHost.tsx, shell protocol v2).
    {
      title: 'bApps',
      items: BAPPS.map((b) => ({
        id: `bapp-${b.id}`,
        label: b.name,
        icon: I.media,
        to: BAPP_ROUTE + b.id,
        // bmovies.app does not allow framing yet (X-Frame-Options: DENY): dev builds only; the bApps dock opens it in a tab.
        hidden: !(import.meta.env.DEV || import.meta.env.VITE_BAPP_DEV === '1'),
        badge: b.id === 'bmovies' ? bmoviesBadge : 0,
      })),
    },
  ];
  const bottom: Item[] = [
    { id: 'settings', label: 'Settings', icon: I.settings, select: 'settings' },
    { id: 'tools', label: 'Tools', icon: I.tools, select: 'tools' },
    { id: 'addagent', label: 'Add agent account', icon: I.agent, act: () => wwOpen('add-agent') },
    { id: 'connect', label: 'Connect CLI & MCP', icon: I.link, act: () => wwOpen('tools') },
    { id: 'lockapp', label: 'Lock wallet (⌘L)', icon: I.lock, act: () => void lockWallet() },
  ];
  const isOn = (it: Item) =>
    it.kind
      ? onWallet && kind === it.kind
      : !!it.to &&
        // A link with a query (a bApp room) is on only for that exact query, so the rooms don't all light up together.
        (it.to.includes('?')
          ? pathname + search === it.to
          : pathname.startsWith(it.to) && !(it.to === '/m/chat' && pathname.startsWith('/m/chat/bapps')));

  // Deep link on a cold load (the app router is in memory): ?view=bapps|bmail|chat|… opens that view once.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || ONBOARDING.includes(pathname)) return;
    deepLinked.current = true;
    const v = new URLSearchParams(location.search).get('view');
    const to: Record<string, string> = {
      bapps: '/m/apps',
      bmail: '/m/bmail',
      mail: '/m/bmail',
      chat: '/m/chat',
      ...(BSPACES_ENABLED ? { 'chat-bapps': '/m/chat/bapps' } : {}),
      feed: '/m/feed',
      calls: CALLS_ROUTE,
      settings: '/m/settings',
      exchange: '/m/exchange',
      // bcalx.com "Open in bWalletX" lands on ?view=calendar.
      ...(BSPACES_ENABLED ? { calendar: '/m/calendar', spaces: '/m/spaces' } : {}),
      // Agreements live in bMail (18 Oct 2026); ?view=bureau stays as a quiet alias.
      ...(BUREAU_ENABLED ? { agreements: '/m/bmail/agreements', bureau: '/m/bmail/agreements' } : {}),
    };
    if (v && to[v]) navigate(to[v]);
  }, [pathname, navigate]);

  // ⌘K or "/": focus the Ask b bar (floating, or the /m/ask-b one). ⌘L: lock.
  useEffect(() => {
    const focusBar = () => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-agent-input]');
      if (el) el.focus();
      else navigate('/m/ask-b');
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        focusBar();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'k') {
        e.preventDefault();
        focusBar();
      } else if (e.key === 'l') {
        e.preventDefault();
        void lockWallet();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [navigate, lockWallet]);

  // Unlocked wallet pages: leave the auth composition flag.ts set before first paint.
  const onAuth = ONBOARDING.includes(pathname);
  // The home's Ask b module is the prompt there: no second, floating bar over the modules (owner, 18 Oct 2026).
  const homeIds = useHomeLayout().ids;
  const askOnHome = onWallet && homeIds.includes('askB');
  useLayoutEffect(() => {
    if (!onAuth) document.documentElement.classList.remove('ww-onb');
  }, [onAuth]);

  // Create / restore / welcome: no chrome; the shared welcome / unlock composition (WideAuth, mobile.css html.ww-onb).
  if (ONBOARDING.includes(pathname)) return <WideAuth>{children}</WideAuth>;

  const bapp = bappFromPath(pathname);
  // NFTs and Friends take the whole area right of the menu (owner, 11 Oct 2026); the holdings pane is for Wallet.
  // Tokens (the home) keeps the classic two columns: card left, price / History / Holdings right (owner, 19 Oct 2026).
  const fullWallet = onWallet && kind !== 'tokens';
  const view = bapp
    ? 'bapp'
    : pathname.startsWith('/m/bmail')
      ? 'mail'
      : pathname.startsWith('/m/chat')
        ? 'chat'
        : onWallet
          ? 'wallet'
          : 'page';
  // Page header: the sidebar item this route belongs to; sub-routes get their last segment and a Back button.
  const allItems = [...groups.flatMap((g) => g.items), ...bottom];
  // bApps is the phone's own scrolling app screen (/m/apps), not a separate Desktop grid (owner, 11 Oct 2026).
  const current =
    pathname === '/m/settings'
      ? allItems.find((i) => i.id === section)
      : (allItems.find((i) => i.to && !i.kind && pathname === i.to.split('?')[0]) ??
        (onWallet ? allItems.find((i) => i.kind === kind) : undefined));
  const seg = pathname.split('/').filter(Boolean).pop() ?? '';
  // A friend's page (/m/friends/<slug>) keeps the Friends title: the slug can be an identity key.
  const friendPage = pathname.startsWith('/m/friends/');
  const page = {
    title: pathname.startsWith('/m/nfts/')
      ? 'NFT'
      : pathname.startsWith('/m/bmint')
        ? 'bMint'
        : pathname.startsWith('/m/chat/bapps')
          ? 'bApp rooms'
          : friendPage
            ? 'Friends'
            : (current?.label.replace(/\s*\(⌘L\)$/, '') ??
              (seg ? seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ') : '')),
    root: !!current,
  };
  const navBtn = (it: Item) =>
    it.hidden ? null : (
      <button
        key={it.id}
        className={isOn(it) ? 'on' : ''}
        onClick={() => go(it)}
        aria-label={badgeLabel(it.label, it.badge ?? 0)}
      >
        {it.img ? <img className="ww-navimg" src={it.img} alt="" aria-hidden /> : <Icon d={it.icon} />}
        <span className="ww-grow">{it.label}</span>
        {!!it.badge && (
          <span className="ww-badge" aria-hidden>
            {badgeText(it.badge)}
          </span>
        )}
      </button>
    );

  // Portalled to <body>: the app root is a centred phone-width column (and an ancestor transform would trap fixed).
  return createPortal(
    <div className="ww-root">
      <video className="ww-bg" src={bgVideo} poster={bgPoster} autoPlay muted loop playsInline />
      <div className="ww-scrim" />
      <aside className="ww-sidebar">
        <div className="ww-brand">
          <img src={mark} alt="" width={28} height={28} />
          <span>
            bWallet<b>X</b>
          </span>
        </div>
        <button className="ww-account" onClick={() => wwOpen('drawer')} title="Accounts">
          {myPic ? (
            <img className="ww-av" src={myPic} alt="" referrerPolicy="no-referrer" style={{ objectFit: 'cover' }} />
          ) : (
            <PersonPic className="ww-av" handle={names.handle || account?.name || 'b'} />
          )}
          <div className="ww-grow">
            {/* Owner, 24 Oct 2026: the account chip shows the FULL paymail (b0asex@bwalletx.com) when there is one. */}
            <div className="ww-clip">{names.paymail || names.displayName || account?.name || 'Account'}</div>
            <div className="ww-muted ww-small ww-clip">
              {!names.paymail && names.handle ? `$${names.handle}` : ''}
              {feed
                ? `${!names.paymail && names.handle ? ' · ' : ''}${feed.bsvBalance.toLocaleString('en-GB', { maximumFractionDigits: 4 })} BSV`
                : ''}
            </div>
          </div>
          <span className="ww-muted">⌄</span>
        </button>
        <div className="ww-navscroll">
          {groups
            .filter((g) => g.items.some((i) => !i.hidden))
            .map((g, gi) => (
              <nav key={`${gi}-${g.title}`} className="ww-nav">
                {g.title && <div className="ww-navtitle">{g.title}</div>}
                {g.items.map(navBtn)}
              </nav>
            ))}
        </div>
        <nav className="ww-nav ww-nav-bottom">{bottom.map(navBtn)}</nav>
      </aside>
      <main className="ww-main">
        <header className="ww-top">
          {view !== 'bapp' && <WideTitle title={page.title} onBack={page.root ? undefined : () => navigate(-1)} />}
          <button
            className="ww-search"
            onClick={() => {
              const el = document.querySelector<HTMLTextAreaElement>('[data-agent-input]');
              if (el) el.focus();
              else navigate('/m/ask-b');
            }}
          >
            <Icon d={I.search} />
            <span className="ww-grow">Ask b to do something…</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="ww-top-right">
            {canInstall && (
              <button
                className="ww-install"
                title="Install bWalletX Desktop as an app"
                onClick={() => void installApp()}
              >
                Install app
              </button>
            )}
            <button className="ww-icon-btn" title="Scan / pay / connect" onClick={() => wwOpen('scan')}>
              <Icon d={I.qr} />
            </button>
            <span className="ww-bellwrap">
              <NotificationsBell onOpenPost={() => navigate('/m/feed')} onOpen={() => navigate('/m/notifications')} />
            </span>
            <div className="ww-seg" role="group" aria-label="Display currency">
              {DISPLAY_CURRENCIES.map((c) => (
                <button key={c} className={ccy === c ? 'on' : ''} onClick={() => setDisplayCurrency(c)}>
                  {c}
                </button>
              ))}
            </div>
            {/* Same as the phone top bar: Lock BSV (time-locks). Locking the wallet is the sidebar's Lock wallet and ⌘L. */}
            <button
              className={`ww-icon-btn${pathname.startsWith('/m/lock') ? ' on' : ''}`}
              title="Lock BSV (time-locks)"
              aria-label="Lock BSV"
              onClick={() => navigate('/m/lock')}
            >
              <LockCoin color="currentColor" accent="var(--bw-accent)" />
            </button>
          </div>
        </header>
        <WidePage bleed={view === 'bapp'}>
          <div className={`ww-content view-${view}${fullWallet ? ' is-full' : ''}`}>
            <div className="ww-colwrap">
              <div className="ww-col">
                {bapp ? <BappHost key={bapp.id} app={bapp} onClose={() => navigate('/m/feed')} /> : children}
              </div>
            </div>
            {view === 'wallet' && !fullWallet && <WalletSide />}
            {view === 'chat' && (
              <div className="ww-panel ww-chat-empty">
                <WideEmpty
                  title="Pick a room"
                  body="Rooms, DMs and token rooms open here, with the room's members, token gate and live Space beside them."
                />
              </div>
            )}
          </div>
        </WidePage>
      </main>
      {/* Ask b's chat bar, floating bottom-centre; replies float above it as dismissable bubbles (owner, 12 Oct 2026).
          Not on pages with their own bottom composer (bChat rooms + DMs, bMail, Ask b): it sat behind their
          composer and its mic peeked out (owner, 18 Oct 2026). */}
      {!bapp && !hasOwnComposer(pathname) && !askOnHome && !isAddAccountFlow(selected, query) && (
        <AgentConversation variant="float" screen={pathname} />
      )}
    </div>,
    document.body,
  );
};

export default WideShell;
