import { BGamesHero } from './games/BGamesHero';
import { TerrornodeHero } from './games/TerrornodeHeroX';
import {
  BSPACES_ENABLED,
  MARKET_ENABLED,
  STORE_BUILD,
  TOKENBLASTER_ENABLED,
  appsTileShown,
  radarGroupShown,
} from './storeBuild';
import { TAB_TAP } from './tabs/tabs';
import { createPortal } from 'react-dom';
import { lazy, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, Suspense } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { FAV_KEY, FAVOURITES_CHANGED, mergeFavouriteExtras } from './phone/homeFavourites';
import {
  APP_SCREENS_KEY,
  defaultScreens,
  gatherBapps,
  ownIconsFirst,
  parseScreens,
  serialiseScreens,
  moveToScreen,
  removeKey,
  renameScreen,
  reorderScreen,
  screenOf,
  screenTitle,
} from './phone/appScreens';
import {
  getAppScreens,
  REQUIRED_TILES,
  setAppScreens,
  setDefaultBuilder,
  useAppScreens,
} from './phone/appScreensStore';
import { useDock } from './phone/dockStore';
import { screenById, type ScreenId } from './phone/screens';
import { SCREEN_ICON, screenLabel } from './phone/icons';
import { PHONE_APPS_TOP, PHONE_GO } from './phone/events';
import { useInPeek } from './phone/pageEl';
import bGlyph from './brand/bwallet-glyph.svg';
import bspacesGlyph from './brand/bspaces-glyph.svg';
import bpicsGlyph from './brand/bpics-glyph.svg';
import { ArrowRight, Clock, Github, Globe, Lock, Plus, Search, Star, X } from 'lucide-react';
import { BAPP_GROUPS, bappsIn, type BApp } from './bapps';
import { ALL_BAPP_ICON_SLUGS, bappIconUrl, useThemedIcon } from './brand/bappIcons';
import { RADAR_APPS, RADAR_GROUPS } from './radarApps';
import { GAME_SOURCES, gamesFor } from './games/gamesCatalog';
import { AddAppSheet } from './apps/AddAppSheet';
import { appIconFor, useUserApps } from './apps/userApps';
import { useBackClose } from './backStack';
import { moveItem } from './reorder';
import { TopNav } from '../components/TopNav';
import { featuredApps } from '../utils/constants';
import { UNOFFICIAL_NOTICE } from './brandText';
import { openDappBrowser } from './dappBrowser';
import {
  allowFrameUrls,
  getBappFrameState,
  openBapp,
  setBappFrameVisible,
  subscribeBappFrame,
} from './bappFrame/bappFrame';
import app_onesatsocialIcon from './brand/apps/1satsocial.png';
import app_treechatIcon from './brand/apps/treechat.png';
import app_twetchIcon from './brand/apps/twetch.png';
import app_tempoIcon from './brand/apps/tempo.png';
import bgVideo from './brand/bg/liquid-gold.mp4';
import bgPoster from './brand/bg/liquid-gold.jpg';
import { VideoBackground } from './ui/VideoBackground';
import { IS_EXTENSION } from './extension';
import { openInExtensionTab } from './bappFrame/extensionTab';
import { BappsStore, type StoreItem } from './BappsStore';
import { builtinStandard } from './bappStandard';

/** Home's "Live now" Spaces row: bWalletX only, a lazy chunk behind the inlined flag. */
const LiveSpacesBarLazy = BSPACES_ENABLED
  ? lazy(() => import('./bradio/LiveSpacesBar').then((m) => ({ default: m.LiveSpacesBar })))
  : null;
const LiveSpacesBar = LiveSpacesBarLazy
  ? () => (
      <Suspense fallback={null}>
        <LiveSpacesBarLazy />
      </Suspense>
    )
  : null;
import { useKeyboardInset } from './ui/keyboardInset';
import { usePhoneLayout } from './phone/flag';
import { PHONE_ADD_TO_DOCK } from './phone/events';
import type { DockItem } from './phone/dockModel';
import { ErrorActions } from './errors/ErrorActions';
import { accentById } from './theme/accents';
import { SiteThemeOffer } from './theme/SiteThemeOffer';
import { familySite, type ThemeSite } from './theme/themeSites';
import { useServiceContext } from '../hooks/useServiceContext';
import { useAccentId } from './theme/useAccent';

// The VexVoid live set heads the Music (Media) section (owner, 16 Oct 2026); its own chunk, loaded on demand.
const VexVoidHero = lazy(() => import('./media/vexvoid/VexVoidHero'));
/** bRacer goes white with black edges on light themes (owner, 16 Oct 2026); the game reads ?theme=white. */
const BRACER = '/arcade/bracer';
const useLightScheme = () => accentById(useAccentId()).scheme === 'light';

/**
 * Apps tab (theme.settings.services.browser), laid out like a phone home
 * screen. Sites open in the in-app dApp browser, where they get window.CWI and
 * ask the wallet for permission.
 */

const RECENT_KEY = 'bwallet:recent-sites';
const MAX_RECENT = 6;

const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};

const rememberRecent = (url: string) => {
  try {
    const next = [url, ...readRecent().filter((u) => u !== url)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: history is a convenience only
  }
};

/** Accepts "1sat.market", "https://…"; rejects anything that isn't http(s). */
const normaliseUrl = (typed: string): string | null => {
  const text = typed.trim();
  if (!text || /\s/.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch {
    return null;
  }
};

// Upstream's featured list, minus sites that no longer resolve (checked 2026-09-29).
const DEAD_HOSTS = new Set(['taleofshua.com']);

// Third-party apps (Apps › Other apps). Our own live in ./bapps.ts.
const apps = [
  // 1sat.market/market answers 307 with no Location (24 Oct 2026); the site root loads.
  { name: '1Sat Market', link: 'https://1sat.market/', icon: undefined as string | undefined },
  { name: '1satsocial', link: 'https://1satsocial.online', icon: app_onesatsocialIcon },
  { name: 'Treechat', link: 'https://treechat.com', icon: app_treechatIcon },
  { name: 'Twetch', link: 'https://twetch.com', icon: app_twetchIcon },
  { name: 'Tempo', link: 'https://tempomusic.net', icon: app_tempoIcon },
  ...featuredApps
    .filter((a) => a.link && a.name && !DEAD_HOSTS.has(new URL(a.link).hostname))
    .filter((a) => new URL(a.link).hostname !== 'yours.org')
    // Haste pays leaderboard prizes, so the store edition leaves it out (as in the games catalogue).
    .filter((a) => !STORE_BUILD || new URL(a.link).hostname !== 'hastearcade.com')
    .map((a) => ({ name: a.name, link: a.link, icon: a.icon })),
];

type Tile = {
  key: string;
  name: string;
  url: string;
  icon?: string;
  demo?: boolean;
  /** Restricted bApp (bShares): its badge text; the app itself checks membership. Absent from store bundles. */
  restricted?: string;
  bapp?: BApp;
  /** One-line tagline for third-party apps (from BSVRadar or the Metanet app store). */
  desc?: string;
  /** Phone layout: a strip screen shown as a Home tile (Wallet, Exchange, Feed, Chat…), not a web app. */
  screen?: ScreenId;
};

const ICON = 'h-[60px] w-[60px] rounded-[16px]';
/** Phone layout HOME: 4 columns × 6 rows, sized to the space between the top bar (3.5rem) and the dock. */
const HOME_ROWS = 6;
const HOME_SLOTS = 4 * HOME_ROWS;
const HOME_PAGE_H = 'calc(var(--wallet-height, 100dvh) - 3.5rem - var(--dock-h, 3.75rem) - 1.75rem)';
const ONE_LINE = 'overflow-hidden text-ellipsis whitespace-nowrap';

/** Home-screen icon: the site's icon, else a monogram ("b" in gold for bApps). */
const TileIcon = ({ tile }: { tile: Tile }) => {
  const [failed, setFailed] = useState(false);
  // Theme packs redraw the set icons; Mono puts own artwork on a white paper tile (themes.css .bw-paper-icon).
  const themed = useThemedIcon(tile.icon);
  const light = useLightScheme();
  if (tile.screen) {
    const Icon = SCREEN_ICON[tile.screen];
    return (
      <div className={`${ICON} flex items-center justify-center`} style={{ background: 'var(--bw-surface)' }}>
        <Icon size={28} color="var(--bw-accent-hi)" />
      </div>
    );
  }
  if (tile.icon && !failed) {
    return (
      <img
        src={themed.src}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        decoding="async"
        loading="lazy"
        width={60}
        height={60}
        className={`${ICON} object-cover bg-[var(--bw-surface)]${themed.paper ? ' bw-paper-icon' : ''}`}
        // bRacer's neon-on-black cover turns white with black edges (GPU filter, no extra asset).
        style={light && tile.url.includes(BRACER) ? { filter: 'grayscale(1) invert(1) contrast(1.6)' } : undefined}
      />
    );
  }
  if (tile.bapp) {
    return (
      <div
        className={`${ICON} flex items-center justify-center font-bold text-2xl`}
        style={{ background: 'var(--bw-accent-lo)', color: '#010101' }}
      >
        b
      </div>
    );
  }
  return (
    <div className={`${ICON} bg-[var(--bw-surface)] flex items-center justify-center`}>
      <Globe size={26} style={{ color: 'var(--bw-accent-hi)' }} />
    </div>
  );
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// A bApp whose url is a wallet path (bMint: /m/bmint) is a wallet screen: a sys: tile, opened by route.
const bappTile = (a: BApp): Tile => ({
  key: a.url.startsWith('/') ? `sys:${a.name}` : `b:${a.url}`,
  name: a.name,
  url: a.url,
  icon: a.icon,
  demo: a.status === 'demo',
  restricted: a.restricted,
  bapp: a,
});

// Featured first (bChatX, bMoviesX, bMusicX, bMintX, bWriterX), then the rest by group.
// Store build: no exchange / swap tiles (storeBuild.ts STORE_HIDDEN_APPS, App Review 3.1.5(iii)).
const BAPP_TILES = BAPP_GROUPS.flatMap((g) => bappsIn(g.id))
  .filter((a) => appsTileShown(a.name))
  .map(bappTile);
/** The b agent as an Apps tile (owner, 7 Oct 2026): opens /m/ask-b, the same as "Ask b" in the top bar. */
const AGENT_KEY = 'sys:agent';
const AGENT_TILE: Tile = { key: AGENT_KEY, name: 'Ask b', url: '/m/ask-b', icon: bGlyph };
/** bSpaces (docs/BSPACES-PLAN.md): live audio/video spaces in your token rooms. bWalletX only (no token rooms in a store build). */
const BSPACES_KEY = 'sys:bspaces';
const BSPACES_TILE: Tile = { key: BSPACES_KEY, name: 'bSpaces', url: '/m/spaces', icon: bspacesGlyph };
/** bPics (owner, 12 Oct 2026; src/mobile/bpics): mint your photos as ordinals, browse shared ones. Both editions. */
const BPICS_TILE: Tile = { key: 'sys:bpics', name: 'bPics', url: '/m/bpics', icon: bpicsGlyph };
const SYS_TILES: Tile[] = BSPACES_ENABLED ? [AGENT_TILE, BPICS_TILE, BSPACES_TILE] : [AGENT_TILE, BPICS_TILE];
/** Wallet screens rather than web apps: they open by route. */
const isSys = (t: Tile) => t.key.startsWith('sys:');
/** Generated bApp-icon-set images (gold b badge); a tile without an icon also draws a gold-b monogram. */
const B_ICON_URLS = new Set(ALL_BAPP_ICON_SLUGS.map((slug) => bappIconUrl(slug)));
/** Own artwork vs the gold-b icon set (owner, 15 Oct 2026: group them in the one bApps section). Ask b is the b. */
const hasOwnIcon = (t: Tile) => t.key !== AGENT_KEY && !!t.icon && !B_ICON_URLS.has(t.icon);
/** Every bApp, own-artwork icons first, then the gold-b ones (each group in catalogue order). */
const BAPPS_GROUPED: Tile[] = ownIconsFirst([...SYS_TILES, ...BAPP_TILES], hasOwnIcon);
const OTHER_TILES: Tile[] = apps.map((a) => ({ key: `o:${a.link}`, name: a.name, url: a.link, icon: a.icon }));

// BSVRadar + Metanet app store apps, grouped, minus any host already in OTHER_TILES.
const bareHost = (url: string) => hostOf(url).replace(/^www\./, '');
const OTHER_HOSTS = new Set(OTHER_TILES.map((t) => bareHost(t.url)));
const RADAR_SECTIONS = RADAR_GROUPS.filter((g) => radarGroupShown(g.id))
  .map((g) => ({
    label: g.label,
    tiles: RADAR_APPS.filter((a) => a.group === g.id && !OTHER_HOSTS.has(bareHost(a.url))).map(
      (a): Tile => ({ key: `r:${a.url}`, name: a.name, url: a.url, icon: a.icon, desc: a.desc }),
    ),
  }))
  .filter((g) => g.tiles.length > 0);
// Games get their own page (owner, 5 Oct 2026), from the bGames catalogue (games/gamesCatalog.ts), grouped
// by source; Other apps shows the rest. Store build: gamesFor drops TokenBlaster and real-money games.
const RADAR_ICONS = new Map(RADAR_APPS.map((a) => [bareHost(a.url), a.icon]));
const GAME_SECTIONS = GAME_SOURCES.map((s) => ({
  label: s.label,
  tiles: gamesFor()
    .filter((g) => g.source === s.id)
    .map(
      (g): Tile => ({
        key: `g:${g.name}`,
        name: g.name,
        url: g.url,
        // The game's own cover first, so each TokenBlaster arcade game gets its own tile instead of the shared
        // TokenBlaster host icon (owner, 13 Oct 2026); host icon only for games without one.
        icon: g.img ?? RADAR_ICONS.get(bareHost(g.url)),
        desc: g.desc,
      }),
    ),
})).filter((s) => s.tiles.length > 0);
const OTHER_SECTIONS = RADAR_SECTIONS.filter((g) => g.label !== 'Games');

const LONG_PRESS_MS = 450;
/** Keep holding a Home tile this long and Home goes straight into arrange mode (like iPhone). */
const ARRANGE_PRESS_MS = 1100;

const AppTile = ({
  tile,
  onOpen,
  onInfo,
  onArrange,
  label = true,
}: {
  tile: Tile;
  onOpen: () => void;
  onInfo: () => void;
  onArrange?: () => void;
  label?: boolean;
}) => {
  const timer = useRef<number>();
  const arrangeTimer = useRef<number>();
  const fired = useRef(false);
  const start = () => {
    fired.current = false;
    timer.current = window.setTimeout(() => {
      fired.current = true;
      onInfo();
    }, LONG_PRESS_MS);
    if (onArrange) arrangeTimer.current = window.setTimeout(onArrange, ARRANGE_PRESS_MS);
  };
  const cancel = () => {
    window.clearTimeout(timer.current);
    window.clearTimeout(arrangeTimer.current);
  };
  return (
    <motion.button
      whileTap={{ scale: 0.9 }}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
        if (!fired.current) {
          fired.current = true;
          onInfo();
        }
      }}
      onClick={() => {
        if (fired.current) return;
        onOpen();
      }}
      className="flex flex-col items-center gap-1.5 min-w-0 select-none"
      style={{ WebkitTouchCallout: 'none' }}
      aria-label={tile.name}
    >
      <div className="relative">
        <TileIcon tile={tile} />
        {tile.demo && (
          <span
            className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#010101]"
            style={{ background: '#98A2B3' }}
            aria-label="Demo"
          />
        )}
        {tile.restricted && (
          <span
            className="absolute -top-1 -right-1 h-4 w-4 rounded-full border-2 border-[#010101] flex items-center justify-center"
            style={{ background: '#F5B800' }}
            aria-label={tile.restricted}
            title={tile.restricted}
          >
            <Lock size={8} color="#1a1300" aria-hidden="true" />
          </span>
        )}
      </div>
      {label && (
        <span className={`w-full ${ONE_LINE} text-center text-[11px] leading-tight text-white`}>{tile.name}</span>
      )}
    </motion.button>
  );
};

/**
 * Home in arrange mode (iPhone-style): tiles jiggle, drag to reorder (pointer events, so touch and
 * mouse both work in WKWebView / Android WebView), "−" removes. Tapping a tile opens nothing.
 * touch-action:none is only set here, so the page scrolls normally outside arrange mode.
 */
const ArrangeGrid = ({
  tiles,
  onReorder,
  onRemove,
}: {
  tiles: Tile[];
  onReorder: (from: number, to: number) => void;
  onRemove: (t: Tile) => void;
}) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; from: number; to: number; sx: number; sy: number; rects: DOMRect[] } | null>(null);
  const [live, setLive] = useState<{ from: number; to: number; dx: number; dy: number } | null>(null);
  const order = live ? moveItem(tiles, live.from, live.to) : tiles;
  const dragKey = live ? tiles[live.from]?.key : undefined;

  const down = (i: number, e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current || (e.target as HTMLElement).closest('[data-remove]')) return;
    const cells = Array.from(gridRef.current?.children ?? []) as HTMLElement[];
    drag.current = {
      id: e.pointerId,
      from: i,
      to: i,
      sx: e.clientX,
      sy: e.clientY,
      rects: cells.map((c) => c.getBoundingClientRect()),
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported: moves still arrive while the finger stays on the tile
    }
    setLive({ from: i, to: i, dx: 0, dy: 0 });
  };

  const move = (e: React.PointerEvent) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.id) return;
    let best = s.to;
    let bestD = Infinity;
    s.rects.forEach((r, k) => {
      const d = (r.left + r.width / 2 - e.clientX) ** 2 + (r.top + r.height / 2 - e.clientY) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    s.to = best;
    setLive({ from: s.from, to: best, dx: e.clientX - s.sx, dy: e.clientY - s.sy });
  };

  const up = (e: React.PointerEvent) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.id) return;
    drag.current = null;
    setLive(null);
    if (s.to !== s.from) onReorder(s.from, s.to);
  };

  return (
    <div ref={gridRef} className="bw-app-grid grid grid-cols-4 gap-x-3 gap-y-5">
      {order.map((t, slot) => {
        const dragging = t.key === dragKey;
        const s = drag.current;
        // The dragged tile follows the finger: its start cell + pointer delta, relative to its current slot.
        const x = dragging && live && s ? s.rects[live.from].left + live.dx - s.rects[slot].left : 0;
        const y = dragging && live && s ? s.rects[live.from].top + live.dy - s.rects[slot].top : 0;
        const from = tiles.indexOf(t);
        return (
          <motion.div
            key={t.key}
            layout={!dragging}
            transition={{ type: 'spring', stiffness: 500, damping: 38 }}
            onPointerDown={(e) => down(from, e)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onContextMenu={(e) => e.preventDefault()}
            className="relative flex flex-col items-center gap-1.5 min-w-0 select-none"
            style={{
              x,
              y,
              zIndex: dragging ? 10 : 0,
              touchAction: 'none',
              WebkitTouchCallout: 'none',
              WebkitUserSelect: 'none',
            }}
            aria-label={`${t.name}, drag to move`}
          >
            <div
              className={`relative ${dragging ? '' : `bw-jiggle${slot % 2 ? ' bw-jiggle-alt' : ''}`}`}
              style={{ transform: dragging ? 'scale(1.12)' : undefined, opacity: dragging ? 0.9 : 1 }}
            >
              <TileIcon tile={t} />
              <button
                data-remove
                type="button"
                aria-label={`Remove ${t.name} from Home`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemove(t)}
                className="absolute -top-1.5 -left-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[13px] font-bold leading-none"
                style={{ background: '#d0d5dd', color: '#010101' }}
              >
                −
              </button>
            </div>
            <span className={`w-full ${ONE_LINE} text-center text-[11px] leading-tight text-white`}>{t.name}</span>
          </motion.div>
        );
      })}
    </div>
  );
};

const ALL_TILES = [...BAPP_TILES, ...OTHER_TILES, ...RADAR_SECTIONS.flatMap((g) => g.tiles)];
allowFrameUrls(ALL_TILES.filter((t) => !t.bapp?.noFrame && !t.url.startsWith('/')).map((t) => t.url));

// Favourites: tile URLs, persisted once the user changes them; until then the default set.
// The featured suite: our own bApps, then the ones with their original icons, then Treechat and Twetch.
const DEFAULT_FAVOURITES = [
  'bChatX',
  'bMoviesX',
  ...(TOKENBLASTER_ENABLED ? ['TERRORNODE'] : []),
  'bMusicX',
  'bMintX',
  'bWriterX',
  'bSheets',
  'bMailX',
  'bDriveX',
  'bCalX',
  'bCode',
  'bJobsX',
  'bArt',
  'bPaint',
  'b3D',
  // bWalletX only: the name is not in a store bundle (MARKET_ENABLED).
  ...(MARKET_ENABLED ? ['bExchange'] : []),
  'Treechat',
  'Twetch',
]
  .map((name) => ALL_TILES.find((t) => t.name === name)?.url)
  .filter((u): u is string => !!u);

// Apps added to Home once for people who already arranged it (they can still remove them).
const HOME_ADDITIONS: { flag: string; name: string }[] = TOKENBLASTER_ENABLED
  ? [
      { flag: 'bwallet:home-add:tokenblaster', name: 'TokenBlaster' },
      // Owner, 26 Oct 2026: TERRORNODE on Home for people who already arranged it, next to the start.
      { flag: 'bwallet:home-add:terrornode', name: 'TERRORNODE' },
    ]
  : [];

const readFavourites = (): string[] => mergeFavouriteExtras(readSavedFavourites());
const readSavedFavourites = (): string[] => {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return DEFAULT_FAVOURITES;
    let favs = JSON.parse(raw) as string[];
    for (const a of HOME_ADDITIONS) {
      if (localStorage.getItem(a.flag)) continue;
      localStorage.setItem(a.flag, '1');
      const url = ALL_TILES.find((t) => t.name === a.name)?.url;
      if (url && !favs.includes(url)) favs = [...favs.slice(0, 2), url, ...favs.slice(2)];
      localStorage.setItem(FAV_KEY, JSON.stringify(favs));
    }
    return favs;
  } catch {
    return DEFAULT_FAVOURITES;
  }
};

const writeFavourites = (urls: string[]) => {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(urls));
  } catch {
    // storage unavailable: favourites last for this session only
  }
};

// Home-screen pages, swiped left/right (CSS scroll-snap); the switch tracks the page.
const PAGES = ['Home', 'bApps', 'Other apps', 'Games'] as const;
const PAGE_KEY = 'bwallet:apps-page';

const readPage = () => {
  try {
    const n = Number(sessionStorage.getItem(PAGE_KEY) ?? 0);
    return Number.isInteger(n) && n >= 0 && n < PAGES.length ? n : 0;
  } catch {
    return 0;
  }
};

/** Bottom address bar: 0.5rem above the tab bar / phone dock (--dock-h, mobile.css). */
const SEARCH_BAR_BOTTOM = 'calc(var(--dock-h, 3.75rem) + 0.5rem)';
/** Page grids scroll clear of the tab bar + the address bar (~3.25rem) + gaps. */
const PAGE_BOTTOM_PAD = 'calc(var(--dock-h, 3.75rem) + 5.5rem)';

/**
 * Phone layout (phone/, test switch): Apps' pages become swipe screens of their own. `only` shows one of them with
 * no inner pager or switch: 'home' (HOME: favourites, under `header`), 'apps' (bApps + Other apps), 'games'.
 * With the switch on and no `only`, /browser is Apps.
 */
type Only = 'home' | 'apps' | 'games';

/** The app screens' wallpaper (phone/pager.tsx draws it once, still, behind the moving track). */
export const AppsWallpaper = () => <VideoBackground src={bgVideo} poster={bgPoster} />;

const BrowserPage = ({
  only: onlyProp,
  header,
  screen,
  sections,
}: {
  only?: Only;
  header?: React.ReactNode;
  /** Phone layout app screen index (phone/pager.tsx): Home is 0. */
  screen?: number;
  /**
   * Phone layout, round 8 (APPS_PAGED off): every app screen as a section of one vertical page, with sticky
   * headers; `screen` is then the section to scroll to.
   */
  sections?: boolean;
} = {}) => {
  const phone = usePhoneLayout();
  const navigate = useNavigate();
  const lightScheme = useLightScheme();
  const only: Only | undefined = onlyProp ?? (phone ? 'apps' : undefined);
  const keyboard = useKeyboardInset();
  const reduce = useReducedMotion();
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  // A family site just opened: offer its colours (theme/siteTheme.ts). Never applied without the tap.
  const [themeSite, setThemeSite] = useState<ThemeSite | null>(null);
  const { chromeStorageService } = useServiceContext();
  const accountKey = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
  const [recent, setRecent] = useState(readRecent);
  const [favourites, setFavourites] = useState(readFavourites);
  // The dock puts an app back on Home when it leaves the dock (phone/homeFavourites.ts).
  useEffect(() => {
    const reread = () => setFavourites(readFavourites());
    window.addEventListener(FAVOURITES_CHANGED, reread);
    return () => window.removeEventListener(FAVOURITES_CHANGED, reread);
  }, []);
  const [dock] = useDock();
  const appScreens = useAppScreens();
  const [moving, setMoving] = useState(false);
  /** Sections mode: which section is being arranged. */
  const [arrangeIdx, setArrangeIdx] = useState(0);
  const scrollRef = useRef<HTMLElement>(null);
  // Sections mode: a route to screen n scrolls to that section; the dock b on Apps scrolls to the top.
  const reduceScroll = useReducedMotion();
  useEffect(() => {
    if (!sections || screen === undefined) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = screen > 0 ? el.querySelector<HTMLElement>(`[data-apps-section="${screen}"]`) : null;
    el.scrollTo({ top: target ? target.offsetTop : 0, behavior: reduceScroll ? 'auto' : 'smooth' });
  }, [sections, screen, reduceScroll]);
  useEffect(() => {
    if (!sections) return;
    const top = () => scrollRef.current?.scrollTo({ top: 0, behavior: reduceScroll ? 'auto' : 'smooth' });
    window.addEventListener(PHONE_APPS_TOP, top);
    return () => window.removeEventListener(PHONE_APPS_TOP, top);
  }, [sections, reduceScroll]);
  const [info, setInfo] = useState<Tile | null>(null);
  const [page, setPage] = useState(() =>
    only === 'home' ? 0 : only === 'games' ? 3 : only === 'apps' ? 1 : readPage(),
  );
  // Apps › Add app: the user's own sites, saved to the wallet (apps/userApps.ts).
  const userApps = useUserApps();
  const [addingApp, setAddingApp] = useState(false);
  const userTiles: Tile[] = userApps.apps.map((a) => ({
    key: `u:${a.url}`,
    name: a.name,
    url: a.url,
    icon: appIconFor(a.url),
  }));
  // Bumped when the switch moves to a page, so that page's grid replays a gentle zoom.
  const [replay, setReplay] = useState<{ page: number; n: number }>({ page: -1, n: 0 });
  const pager = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  const [arranging, setArranging] = useState(false);
  useBackClose(!!info, () => setInfo(null));
  useBackClose(arranging, () => setArranging(false));
  // An open bApp owns the frame: hide the address bar while it shows.
  const bappOpen = useSyncExternalStore(subscribeBappFrame, () => !!getBappFrameState().session);
  // Arranging ends (auto "Done") when leaving Home: another page/filter, a tab tap or the app backgrounding.
  useEffect(() => {
    if (page !== 0) setArranging(false);
  }, [page]);
  useEffect(() => {
    if (!arranging) return;
    const done = () => setArranging(false);
    const onHide = () => document.hidden && done();
    window.addEventListener(TAB_TAP, done);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener(TAB_TAP, done);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [arranging]);

  useLayoutEffect(() => {
    const el = pager.current;
    if (el) el.scrollLeft = pageRef.current * el.clientWidth;
  }, []);

  const showPage = (i: number) => {
    pageRef.current = i;
    setPage(i);
    try {
      sessionStorage.setItem(PAGE_KEY, String(i));
    } catch {
      // storage unavailable: the page just isn't remembered
    }
  };

  const onPagerScroll = () => {
    const el = pager.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== pageRef.current && i >= 0 && i < PAGES.length) showPage(i);
  };

  const goPage = (i: number) => {
    const el = pager.current;
    if (!el || i === pageRef.current) return;
    showPage(i);
    setReplay((r) => ({ page: i, n: r.n + 1 }));
    el.scrollTo({ left: i * el.clientWidth, behavior: reduce ? 'auto' : 'smooth' });
  };

  const isFavourite = (t: Tile) => favourites.includes(t.url);
  const toggleFavourite = (t: Tile) => {
    const next = isFavourite(t) ? favourites.filter((u) => u !== t.url) : [...favourites, t.url];
    setFavourites(next);
    writeFavourites(next);
  };
  // An app lives in one place: on Home it leaves bApps / Other apps, and returns when removed from Home.
  const notHome = (tiles: Tile[]) => tiles.filter((t) => !favourites.includes(t.url));
  const favouriteTiles = favourites.map((u) => ALL_TILES.find((t) => t.url === u)).filter((t): t is Tile => !!t);
  // Indices come from the visible tiles; map them back to the stored list (which may hold unknown URLs).
  const reorderHome = (from: number, to: number) => {
    const next = moveItem(
      favourites,
      favourites.indexOf(favouriteTiles[from].url),
      favourites.indexOf(favouriteTiles[to].url),
    );
    setFavourites(next);
    writeFavourites(next);
  };
  const removeFromHome = (t: Tile) => {
    const next = favourites.filter((u) => u !== t.url);
    setFavourites(next);
    writeFavourites(next);
    if (!next.some((u) => ALL_TILES.some((x) => x.url === u))) setArranging(false);
  };

  // The in-frame bApp shows only while this page (the Apps tab) is on screen. Phone layout: the page stays
  // mounted off to the side (phone/pager.tsx), so only the page on screen claims the frame.
  const offScreen = useInPeek();
  useEffect(() => {
    if (offScreen) return;
    setBappFrameVisible(true);
    return () => setBappFrameVisible(false);
  }, [offScreen]);

  const go = (url: string, bapp?: BApp) => {
    setError('');
    setThemeSite(familySite(url));
    rememberRecent(url);
    setRecent(readRecent());
    // Every app tile runs inside the wallet frame when its site allows it (else full screen);
    // typed addresses open full screen.
    const tile = ALL_TILES.find((t) => t.url === url);
    const name = bapp?.name ?? tile?.name;
    // bRacer in a light theme: ask the game for its white palette (gameplay unchanged; ignored until it ships).
    if (lightScheme && url.includes(BRACER)) url += `${url.includes('?') ? '&' : '?'}theme=white`;
    // Chrome extension (owner, 23 Oct 2026; docs/BAPP-STANDARD.md): the side panel is the launcher only. A bApp opens
    // in a normal browser tab (or focuses the tab already on its origin), where the injected BRC-100 provider connects
    // it and the site-theme rule applies. Never an in-panel iframe. Phones: full-screen in-wallet webview below.
    if (IS_EXTENSION) return void openInExtensionTab(url).catch((e: unknown) => setError(String(e)));
    (name ? openBapp(name, url) : openDappBrowser(url)).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = normaliseUrl(address);
    if (!url) return setError('Enter a web address, like 1sat.market');
    go(url);
  };

  // Entrance: the grid settles from slightly zoomed-in, like an iOS home screen after unlock
  // (transform/opacity only). A gentler version replays when the switch picks a page.
  const grid = (i: number, tiles: Tile[]) => {
    const replayed = replay.page === i;
    return (
      <motion.div
        key={replayed ? `r${replay.n}` : 'enter'}
        className="bw-app-grid grid grid-cols-4 gap-x-3 gap-y-5"
        style={{ transformOrigin: '50% 30%' }}
        initial={reduce ? { opacity: 0 } : { opacity: replayed ? 0.6 : 0, scale: replayed ? 1.06 : 1.2 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
        transition={reduce ? { duration: 0.2 } : { type: 'spring', stiffness: 260, damping: 28, mass: 0.9 }}
      >
        {tiles.map((t) => (
          <AppTile
            key={t.key}
            tile={t}
            onOpen={() => (isSys(t) ? navigate(t.url) : go(t.url, t.bapp))}
            onInfo={() => (isSys(t) ? navigate(t.url) : setInfo(t))}
            onArrange={
              i === 0
                ? () => {
                    setInfo(null);
                    setArranging(true);
                  }
                : undefined
            }
          />
        ))}
      </motion.div>
    );
  };

  /**
   * Phone layout HOME (owner, round 3): a fixed 4 × 6 page (24 slots) filling the height between the top bar and
   * the dock, like an iPhone home page. Empty slots stay empty; more than 24 apps continue below it.
   */
  const homePage = (tiles: Tile[], flow?: { section: number }) => {
    // Round 8: sections flow (4 columns, natural rows, no filler slots).
    if (flow)
      return tiles.length ? (
        <div className="grid grid-cols-4 gap-x-3 gap-y-5 items-start justify-items-center">
          {tiles.map((t) => (
            <AppTile
              key={t.key}
              tile={t}
              onOpen={() =>
                t.screen
                  ? window.dispatchEvent(new CustomEvent(PHONE_GO, { detail: t.screen }))
                  : isSys(t)
                    ? navigate(t.url)
                    : go(t.url, t.bapp)
              }
              onInfo={() => setInfo(t)}
              onArrange={() => {
                setInfo(null);
                setArrangeIdx(flow.section);
                setArranging(true);
              }}
            />
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-[#98A2B3] m-0">Empty. Touch and hold an app, then Move to section….</p>
      );
    const first = tiles.slice(0, HOME_SLOTS);
    const rest = tiles.slice(HOME_SLOTS);
    return (
      <>
        <div
          data-testid="home-page-grid"
          className="grid grid-cols-4 gap-x-3 items-start justify-items-center"
          style={{ gridTemplateRows: `repeat(${HOME_ROWS}, minmax(0, 1fr))`, height: HOME_PAGE_H, minHeight: '28rem' }}
        >
          {first.map((t) => (
            <AppTile
              key={t.key}
              tile={t}
              onOpen={() =>
                t.screen
                  ? window.dispatchEvent(new CustomEvent(PHONE_GO, { detail: t.screen }))
                  : isSys(t)
                    ? navigate(t.url)
                    : go(t.url, t.bapp)
              }
              onInfo={() => setInfo(t)}
              onArrange={() => {
                setInfo(null);
                setArranging(true);
              }}
            />
          ))}
          {Array.from({ length: HOME_SLOTS - first.length }, (_, i) => (
            <span key={`empty${i}`} aria-hidden className="h-[60px] w-[60px]" />
          ))}
        </div>
        {first.length === 0 && (
          <p className="text-[12px] text-[#98A2B3] text-center -mt-2">Touch and hold any app, then Add to Home.</p>
        )}
        {rest.length > 0 && grid(0, rest)}
      </>
    );
  };

  /** A tile key (phone/appScreens.ts) → its tile. */
  const keyTile = (k: string): Tile | null => {
    const sys = SYS_TILES.find((t) => t.key === k);
    if (sys) return sys;
    if (k.startsWith('screen:')) {
      const id = k.slice(7) as ScreenId;
      const sc = screenById(id);
      return sc ? { key: k, name: screenLabel(id, sc.label), url: sc.route, screen: id } : null;
    }
    return ALL_TILES.find((t) => t.url === k) ?? userTiles.find((t) => t.url === k) ?? null;
  };
  const tileKey = (t: Tile) => (isSys(t) ? t.key : t.screen ? `screen:${t.screen}` : t.url);
  const placed = new Set([
    ...appScreens.screens.flatMap((x) => x.items),
    ...dock.flatMap((i) => (i.kind === 'app' ? [i.url] : [])),
  ]);
  const notPlaced = (tiles: Tile[]) => tiles.filter((t) => !placed.has(t.url));

  /** Phone layout app screen i: its 4 × 6 grid; Home also has Your apps, Recents and More apps below. */
  const screenBody = (i: number, flow = false) => {
    const items = appScreens.screens[i]?.items ?? [];
    const tiles = items.map(keyTile).filter((t): t is Tile => !!t);
    return (
      <>
        {arranging && (!flow || arrangeIdx === i) && tiles.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#98A2B3]">Drag to rearrange. Tap − to take it off this screen.</span>
              <button
                onClick={() => setArranging(false)}
                className="rounded-full px-4 py-1.5 text-[13px] font-bold"
                style={{ background: 'var(--bw-accent-hi)', color: '#010101' }}
              >
                Done
              </button>
            </div>
            <ArrangeGrid
              tiles={tiles}
              onReorder={(from, to) =>
                setAppScreens(
                  reorderScreen(
                    getAppScreens(),
                    i,
                    items.indexOf(tileKey(tiles[from])),
                    items.indexOf(tileKey(tiles[to])),
                  ),
                )
              }
              onRemove={(t) => setAppScreens(removeKey(getAppScreens(), tileKey(t)))}
            />
          </div>
        ) : (
          homePage(tiles, flow ? { section: i } : undefined)
        )}
        {i === 0 && !flow && homeExtras()}
      </>
    );
  };

  /** Your apps, Recents and the catalogue: under Home (paged) or at the end of the sections page. */
  const homeExtras = () => (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--bw-accent-hi)]">
            Your apps
          </h2>
          <button
            type="button"
            onClick={() => setAddingApp(true)}
            className="rounded-full px-3 py-1 text-[12px] font-bold border-0"
            style={{ background: 'var(--bw-accent)', color: '#010101' }}
          >
            + Add app
          </button>
        </div>
        {userTiles.length > 0 ? (
          grid(0, notPlaced(userTiles))
        ) : (
          <p className="text-[12px] text-[#98A2B3] m-0">Add any website, like zanaadu.com. Saved to your wallet.</p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--bw-accent-hi)]">Recents</h2>
        {recent.length === 0 && <p className="text-[12px] text-[#98A2B3] m-0">Apps you open show here.</p>}
        <div className="flex flex-wrap gap-2">
          {recent.map((url) => (
            <button
              key={url}
              onClick={() => go(url)}
              className="shrink-0 flex items-center gap-1 rounded-full bg-[var(--bw-surface)]/80 px-3 py-1.5 text-[11px] text-[#98A2B3]"
            >
              <Clock size={11} /> {hostOf(url)}
            </button>
          ))}
        </div>
      </div>
      {/* The catalogue: every app not on a screen or in the dock. Touch and hold to place one. */}
      {[
        { label: 'More bApps', tiles: BAPPS_GROUPED.filter((t) => !SYS_TILES.includes(t)) },
        { label: 'More apps', tiles: OTHER_TILES },
        ...RADAR_SECTIONS.map((g) => ({ label: g.label, tiles: g.tiles })),
      ]
        .map((g) => ({ ...g, tiles: notPlaced(g.tiles) }))
        .filter((g) => g.tiles.length)
        .map((g) => (
          <div key={g.label} className="flex flex-col gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--bw-accent-hi)]">
              {g.label}
            </h2>
            {grid(0, g.tiles)}
          </div>
        ))}
      {note(`Touch and hold an app to add it to the Dock or move it to another section. ${UNOFFICIAL_NOTICE}`)}
    </>
  );

  /** Round 8: all app screens as sections of one page, each with a sticky header (tap to rename). */
  const sectionsBody = () => (
    <>
      {/* TERRORNODE hero opens the bApps page (owner P0, 26 Oct 2026). bWalletX only (TOKENBLASTER_ENABLED). */}
      {TOKENBLASTER_ENABLED && <TerrornodeHero onPlay={(u) => go(u)} />}
      {appScreens.screens.map((x, i) => (
        <div key={i} data-apps-section={i} className="flex flex-col gap-3">
          {/* The Games section opens with the bGames hero (owner, 11 Oct 2026). */}
          {/^games$/i.test(screenTitle(x, i).trim()) && <BGamesHero top={false} />}
          {/^(music|media)$/i.test(screenTitle(x, i).trim()) && (
            <Suspense fallback={<div className="-mx-4" style={{ height: 200, background: 'var(--bw-bg)' }} />}>
              <VexVoidHero />
            </Suspense>
          )}
          <button
            type="button"
            onClick={() => {
              const name = window.prompt('Name this section', screenTitle(x, i));
              if (name !== null) setAppScreens(renameScreen(getAppScreens(), i, name));
            }}
            aria-label={`${screenTitle(x, i)}. Tap to rename`}
            // Solid background, no blur: cheap to keep stuck while scrolling on old iPhones.
            className="sticky top-0 z-[2] -mx-4 px-4 py-2 text-left text-[12px] font-bold uppercase tracking-wider border-0"
            style={{ background: 'var(--bw-bg)', color: 'var(--bw-accent-hi)' }}
          >
            {screenTitle(x, i)}
          </button>
          {/* The bApps section is the tiered bApps screen (search, badges, tiers); other sections keep their tiles. */}
          {/^bapps$/i.test(screenTitle(x, i).trim()) ? bappsStore() : screenBody(i, true)}
        </div>
      ))}
      {homeExtras()}
    </>
  );

  /** Tiered bApps screen (owner, 23 Oct 2026): b*X, commercial, built-ins, standard-meeting community apps. */
  const bappsStore = () => (
    <BappsStore
      open={(url, name) => go(url, { name, url } as BApp)}
      builtins={BAPPS_GROUPED.map(
        (t): StoreItem => ({
          key: t.key,
          name: t.name,
          verb: t.bapp?.verb,
          url: t.url,
          icon: t.icon,
          demo: t.demo,
          standard: t.bapp ? builtinStandard(t.bapp) : undefined,
          onOpen: () => (isSys(t) ? navigate(t.url) : go(t.url, t.bapp)),
        }),
      )}
      community={[...OTHER_TILES, ...OTHER_SECTIONS.flatMap((g) => g.tiles)].map(
        (t): StoreItem => ({
          key: t.key,
          name: t.name,
          verb: t.desc,
          url: t.url,
          icon: t.icon,
          // Third-party apps: no token, room or theme pack registered with us, no in-wallet BRC-100 check yet.
          standard: { token: null, room: null, theme: familySite(t.url)?.id ?? null, inWallet: false },
          onOpen: () => go(t.url),
        }),
      )}
    />
  );

  const note = (text: string) => <p className="text-[10px] leading-relaxed text-[#98A2B3] text-center px-2">{text}</p>;

  const pageBody = (i: number) => {
    if (i === 0) {
      return (
        <>
          {LiveSpacesBar && !arranging && <LiveSpacesBar />}
          {arranging && favouriteTiles.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#98A2B3]">Drag to rearrange. Tap − to remove.</span>
                <button
                  onClick={() => setArranging(false)}
                  className="rounded-full px-4 py-1.5 text-[13px] font-bold"
                  style={{ background: 'var(--bw-accent-hi)', color: '#010101' }}
                >
                  Done
                </button>
              </div>
              <ArrangeGrid tiles={favouriteTiles} onReorder={reorderHome} onRemove={removeFromHome} />
            </div>
          ) : favouriteTiles.length > 0 ? (
            grid(0, favouriteTiles)
          ) : (
            <p className="text-sm text-[#98A2B3] text-center py-10">
              Nothing on Home yet. Touch and hold any app, then Add to Home.
            </p>
          )}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--bw-accent-hi)]">
                Your apps
              </h2>
              <button
                type="button"
                onClick={() => setAddingApp(true)}
                className="rounded-full px-3 py-1 text-[12px] font-bold border-0"
                style={{ background: 'var(--bw-accent)', color: '#010101' }}
              >
                + Add app
              </button>
            </div>
            {userTiles.length > 0 ? (
              grid(0, userTiles)
            ) : (
              <p className="text-[12px] text-[#98A2B3] m-0">Add any website, like zanaadu.com. Saved to your wallet.</p>
            )}
          </div>
          {(recent.length > 0 || (phone && only === 'home')) && (
            <div className="flex flex-col gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--bw-accent-hi)]">
                Recents
              </h2>
              {recent.length === 0 && <p className="text-[12px] text-[#98A2B3] m-0">Apps you open show here.</p>}
              <div className="flex flex-wrap gap-2">
                {recent.map((url) => (
                  <button
                    key={url}
                    onClick={() => go(url)}
                    className="shrink-0 flex items-center gap-1 rounded-full bg-[var(--bw-surface)]/80 px-3 py-1.5 text-[11px] text-[#98A2B3]"
                  >
                    <Clock size={11} /> {hostOf(url)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {note('Touch and hold an app to add or remove it here.')}
        </>
      );
    }
    if (i === 1) {
      return (
        <>
          {TOKENBLASTER_ENABLED && <TerrornodeHero onPlay={(u) => go(u)} />}
          {bappsStore()}
          {note(`Open a bApp to use it inside your wallet. ${UNOFFICIAL_NOTICE}`)}
        </>
      );
    }
    if (i === 3) {
      return (
        <>
          {GAME_SECTIONS.filter((g) => notHome(g.tiles).length).map((g) => (
            <div key={g.label} className="flex flex-col gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--bw-accent-hi)]">
                {g.label}
              </h2>
              {grid(3, notHome(g.tiles))}
            </div>
          ))}
          {note('More BSV games are not made by The Bitcoin Corporation. Touch and hold a game for details.')}
        </>
      );
    }
    return (
      <>
        {grid(2, notHome(OTHER_TILES))}
        {OTHER_SECTIONS.filter((g) => notHome(g.tiles).length).map((g) => (
          <div key={g.label} className="flex flex-col gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--bw-accent-hi)]">
              {g.label}
            </h2>
            {grid(2, notHome(g.tiles))}
          </div>
        ))}
        {note('Not made by The Bitcoin Corporation. Sources: BSVRadar, Metanet app store.')}
      </>
    );
  };

  return (
    <div
      className="relative w-full overflow-hidden"
      style={{ height: '100%', background: screen === undefined ? '#010101' : 'transparent' }}
    >
      {addingApp && <AddAppSheet store={userApps} onClose={() => setAddingApp(false)} />}
      {screen === undefined && <VideoBackground src={bgVideo} poster={bgPoster} />}
      <TopNav />
      {screen !== undefined ? (
        <div className="relative h-full w-full pt-14">
          <section
            ref={scrollRef}
            aria-label={sections ? 'Apps' : screenTitle(appScreens.screens[screen], screen)}
            className="h-full w-full overflow-y-auto overflow-x-hidden"
            style={{ overscrollBehaviorY: 'contain' }}
          >
            <div
              className={`w-full px-4 flex flex-col gap-6 ${sections ? 'pt-0' : 'pt-4'}`}
              style={{ paddingBottom: 'calc(var(--dock-h, 3.75rem) + 2.5rem)' }}
            >
              {sections ? sectionsBody() : screenBody(screen)}
            </div>
          </section>
        </div>
      ) : only ? (
        <div className="relative h-full w-full pt-14">
          <section
            aria-label={only === 'home' ? 'Home' : only === 'games' ? 'Games' : 'Apps'}
            className="h-full w-full overflow-y-auto overflow-x-hidden"
            style={{ overscrollBehaviorY: 'contain' }}
          >
            <div
              className="w-full px-4 pt-4 flex flex-col gap-6"
              style={{ paddingBottom: only === 'apps' ? PAGE_BOTTOM_PAD : 'calc(var(--dock-h, 3.75rem) + 2.5rem)' }}
            >
              {header}
              {only === 'home' ? (
                pageBody(0)
              ) : only === 'games' ? (
                <>
                  <BGamesHero />
                  {pageBody(3)}
                </>
              ) : (
                <>
                  {pageBody(1)}
                  {pageBody(2)}
                </>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="relative flex h-full w-full flex-col pt-14">
          {/* The page switch stays pinned at the top; the address bar lives at the bottom (Safari-style). */}
          <div
            className="w-full px-4 pt-3 pb-2 flex flex-col gap-2 backdrop-blur-md"
            style={{ background: 'rgba(1,1,1,0.75)' }}
          >
            <div className="flex gap-1 rounded-xl p-1 bg-[var(--bw-surface)]" role="tablist" aria-label="App pages">
              {PAGES.map((label, i) => (
                <button
                  key={label}
                  role="tab"
                  aria-selected={page === i}
                  onClick={() => goPage(i)}
                  className="flex-1 min-w-0 rounded-lg py-2 px-0.5 text-[13px] font-bold border-0 outline-none cursor-pointer transition-colors"
                  style={{
                    background: page === i ? '#A1FF8B' : 'transparent',
                    color: page === i ? '#010101' : '#98A2B3',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div
            ref={pager}
            onScroll={onPagerScroll}
            className="flex min-h-0 w-full flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
            style={{ scrollbarWidth: 'none', overscrollBehaviorX: 'contain', WebkitOverflowScrolling: 'touch' }}
          >
            {PAGES.map((label, i) => (
              <section
                key={label}
                aria-label={label}
                className="h-full w-full shrink-0 snap-start snap-always overflow-y-auto overflow-x-hidden"
                style={{ overscrollBehaviorY: 'contain' }}
              >
                <div className="w-full px-4 pt-4 flex flex-col gap-6" style={{ paddingBottom: PAGE_BOTTOM_PAD }}>
                  {pageBody(i)}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      {/* Address bar, pinned just above the tab bar (Safari-style). With the keyboard open (iOS doesn't
          resize the page) it rides on top of the keyboard instead. */}
      <div
        className="absolute left-0 right-0 z-[101] px-4"
        style={{
          bottom: keyboard ? `${keyboard + 8}px` : SEARCH_BAR_BOTTOM,
          display: bappOpen || screen !== undefined || (only && only !== 'apps') ? 'none' : undefined,
        }}
      >
        <div
          className="rounded-[22px] p-1 backdrop-blur-md"
          style={{
            background: 'rgba(16,17,20,0.78)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <form onSubmit={submit} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 rounded-full bg-[var(--bw-surface)] pl-4 pr-1">
              <Search size={15} style={{ color: '#98A2B3' }} />
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Search or enter address"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="flex-1 min-w-0 bg-transparent py-2.5 text-sm text-white outline-none placeholder:text-[#667085]"
                aria-label="Web address"
              />
              <button type="submit" aria-label="Go" className="p-2">
                <ArrowRight size={17} style={{ color: 'var(--bw-accent-hi)' }} />
              </button>
            </div>
            {error && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-[#F97066] px-2">{error}</p>
                <ErrorActions message={String(error)} />
              </div>
            )}
          </form>
        </div>
      </div>

      {themeSite &&
        createPortal(
          <div
            className="fixed left-3 right-3 z-[120] flex justify-center"
            style={{ bottom: 'calc(var(--dock-h, 3.75rem) + env(safe-area-inset-bottom) + 0.75rem)' }}
          >
            <SiteThemeOffer site={themeSite} account={accountKey} style={{ width: '100%', maxWidth: 520 }} />
          </div>,
          document.body,
        )}
      {/* Portalled above the tab bar (z-100) so the sheet's buttons are never hidden behind it. */}
      {createPortal(
        <AnimatePresence>
          {info && (
            <motion.div
              className="fixed inset-0 z-[150] flex items-end"
              style={{ background: 'rgba(0,0,0,0.6)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setInfo(null)}
            >
              <motion.div
                className="w-full rounded-t-3xl bg-[var(--bw-surface)] px-5 pt-5 flex flex-col gap-4"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}
                initial={{ y: 40 }}
                animate={{ y: 0 }}
                exit={{ y: 40 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-4">
                  <TileIcon tile={info} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-lg font-bold text-white ${ONE_LINE}`}>{info.name}</span>
                      {info.bapp && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                          style={
                            info.demo
                              ? { background: '#2b2f36', color: '#98A2B3' }
                              : { background: 'rgb(var(--bw-accent-lo-rgb)/0.13)', color: 'var(--bw-accent-hi)' }
                          }
                        >
                          {info.restricted ? info.restricted : info.demo ? 'Demo' : 'Live'}
                        </span>
                      )}
                    </div>
                    {!info.screen && <div className={`text-xs text-[#98A2B3] ${ONE_LINE}`}>{hostOf(info.url)}</div>}
                  </div>
                  <button onClick={() => setInfo(null)} aria-label="Close" className="p-1">
                    <X size={20} style={{ color: '#98A2B3' }} />
                  </button>
                </div>
                {info.screen ? null : info.bapp ? (
                  <p className="text-sm text-[#D0D5DD] leading-relaxed">{info.bapp.verb}</p>
                ) : (
                  <>
                    {info.desc && <p className="text-sm text-[#D0D5DD] leading-relaxed">{info.desc}</p>}
                    <p className="text-xs text-[#98A2B3]">Not made by The Bitcoin Corporation.</p>
                  </>
                )}
                <button
                  onClick={() => {
                    const { url, screen } = info;
                    setInfo(null);
                    if (screen) window.dispatchEvent(new CustomEvent(PHONE_GO, { detail: screen }));
                    else go(url);
                  }}
                  className="rounded-xl py-3 text-sm font-bold"
                  style={{ background: 'var(--bw-accent-hi)', color: '#010101' }}
                >
                  Open
                </button>
                {/* Phone layout: any app can go in the dock (owner, 7 Oct 2026). */}
                {phone && (
                  <button
                    onClick={() => {
                      const item: DockItem = info.screen
                        ? { kind: 'screen', id: info.screen }
                        : {
                            kind: 'app',
                            url: info.url,
                            name: info.name,
                            icon: typeof info.icon === 'string' ? info.icon : undefined,
                          };
                      setInfo(null);
                      window.dispatchEvent(new CustomEvent(PHONE_ADD_TO_DOCK, { detail: item }));
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold bg-[#2b2f36] text-white"
                  >
                    <Plus size={15} style={{ color: 'var(--bw-accent-hi)' }} /> Add to Dock
                  </button>
                )}
                {phone && screen !== undefined && (
                  <>
                    <button
                      onClick={() => setMoving((v) => !v)}
                      className="rounded-xl py-3 text-sm font-bold bg-[#2b2f36] text-white"
                      aria-expanded={moving}
                    >
                      {screenOf(appScreens, tileKey(info)) < 0
                        ? `Add to a ${sections ? 'section' : 'screen'}…`
                        : `Move to ${sections ? 'section' : 'screen'}…`}
                    </button>
                    {moving && (
                      <div className="flex flex-col gap-1 rounded-xl bg-[#101114] p-1" role="menu">
                        {[
                          ...appScreens.screens.map((x, n) => screenTitle(x, n)),
                          sections ? 'New section' : 'New screen',
                        ].map((title, n) => (
                          <button
                            key={n}
                            role="menuitem"
                            disabled={n === screenOf(appScreens, tileKey(info))}
                            onClick={() => {
                              setAppScreens(moveToScreen(getAppScreens(), tileKey(info), n));
                              setMoving(false);
                              setInfo(null);
                            }}
                            className="rounded-lg py-2.5 text-sm font-semibold text-white bg-transparent disabled:opacity-40"
                          >
                            {title}
                          </button>
                        ))}
                      </div>
                    )}
                    {screenOf(appScreens, tileKey(info)) >= 0 && !REQUIRED_TILES.includes(tileKey(info)) && (
                      <button
                        onClick={() => {
                          setAppScreens(removeKey(getAppScreens(), tileKey(info)));
                          setInfo(null);
                        }}
                        className="rounded-xl py-3 text-sm font-bold bg-[#2b2f36] text-white"
                      >
                        {sections ? 'Remove from sections' : 'Remove from screens'}
                      </button>
                    )}
                  </>
                )}
                {!info.screen && screen === undefined && (
                  <button
                    onClick={() => toggleFavourite(info)}
                    className="flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold bg-[#2b2f36] text-white"
                  >
                    <Star
                      size={15}
                      style={{ color: 'var(--bw-accent-hi)' }}
                      fill={isFavourite(info) ? 'var(--bw-accent-hi)' : 'none'}
                    />
                    {isFavourite(info) ? 'Remove from Home' : 'Add to Home'}
                  </button>
                )}
                {screen === undefined && isFavourite(info) && (!only || only === 'home') && (
                  <button
                    onClick={() => {
                      setInfo(null);
                      setArranging(true);
                      goPage(0);
                    }}
                    className="rounded-xl py-3 text-sm font-bold bg-[#2b2f36] text-white"
                  >
                    Arrange Home
                  </button>
                )}
                {info.bapp?.source && (
                  <button
                    onClick={() => {
                      const src = info.bapp?.source ?? '';
                      setInfo(null);
                      go(src);
                    }}
                    className="flex items-center justify-center gap-1.5 text-xs text-[#98A2B3]"
                  >
                    <Github size={13} /> {new URL(info.bapp.source).pathname.slice(1)}
                  </button>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
};

// The first app-screens layout (or the migration from Home favourites + the bApps and Games pages).
/** Screen key of a bApp tile: the wallet's own tiles (Ask b, bPics, bSpaces) by key, bApps by URL (keyTile). */
const screenKeyOf = (t: Tile) => (SYS_TILES.includes(t) ? t.key : t.url);
const BAPP_KEYS = BAPPS_GROUPED.map(screenKeyOf);
const OWN_ICON_KEYS = new Set(BAPPS_GROUPED.filter(hasOwnIcon).map(screenKeyOf));
const oneBappsSection = (s: ReturnType<typeof defaultScreens>) =>
  gatherBapps(s, BAPP_KEYS, (k) => OWN_ICON_KEYS.has(k));

// Existing layouts: all bApps into the one bApps section, once (owner, 15 Oct 2026). Runs before the store reads.
const ONE_SECTION_FLAG = 'bwallet:bapps-one-section:v1';
try {
  if (!localStorage.getItem(ONE_SECTION_FLAG)) {
    const saved = parseScreens(localStorage.getItem(APP_SCREENS_KEY));
    if (saved) localStorage.setItem(APP_SCREENS_KEY, serialiseScreens(oneBappsSection(saved)));
    localStorage.setItem(ONE_SECTION_FLAG, '1');
  }
} catch {
  /* storage unavailable: the default layout below already has one bApps section */
}

setDefaultBuilder(() =>
  oneBappsSection(
    defaultScreens(
      readFavourites(),
      BAPP_TILES.map((t) => t.url),
      GAME_SECTIONS.flatMap((s) => s.tiles.map((t) => t.url)),
    ),
  ),
);

export default BrowserPage;
