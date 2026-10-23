import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assertOrdLockV2 } from './ordlockVersion';
import { purchaseError } from '../exchange/purchase';
import { useTabHome } from '../tabs/useTabHome';
import { cachedExchangeRate } from '../../utils/wallet';
import { useBackClose } from '../backStack';
import { IssuerBadge } from '../issuer/IssuerBadge';
import { duplicateTickers } from '../issuer/issuerVerify';
import { isPersonalTokenId, knownPersonal, tickerLabel } from '../names/personalToken';
import type { WalletOutput } from '@bsv/sdk';
import { buyBsv21, buyOrdinal, cancelOrdinalListing, listOrdinals } from '@1sat/actions';
import { readAssetIdTag } from '@1sat/types';
import {
  ArrowLeft,
  Coins,
  Flag,
  Flame,
  Image as ImageIcon,
  Palette,
  Rocket,
  Search,
  ShieldCheck,
  Tag,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { TopNav } from '../../components/TopNav';
import { PageLoader } from '../../components/PageLoader';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { getErrorMessage } from '../../utils/tools';
import { getOutputName } from '../../utils/format';
import { ORDLOCK_LISTING_DISABLED_MESSAGE } from '../../utils/cancelOrdLockListings';
import { marketFeeOptions, marketFeeSats, MARKET_FEE_RATE } from './fee';
import {
  clearMarketCache,
  contentUrls,
  formatSats,
  hotBoard,
  mergeTokenBoard,
  tokenDirectory,
  type DirectoryToken,
  parseRoom,
  roomMarket,
  roomMeta,
  type HotRoom,
  type Listing,
  type RoomMarket,
} from './indexer';
import { hotRoomSafe, roomListingSafe } from './roomSafety';
import { categoryOf, listingsIn, nftFeed, type Feed as BaseFeed, type NftCategory, type NftListing } from './classify';
import { onSafetyChange, refreshSafety, reportItem, safety } from './safety';
import { Blurred, ContentImg, NftCard } from './NftCard';
import { groupCollections } from './groupCollections';
import { thumbOrFullUrls } from './thumbs';
import { pauseAudio, playQueue } from '../media/player';
import { OpenTokenRoomButton } from '../chat/OpenTokenRoomButton';
import { TokenLinks } from '../tokens/TokenLinks';
import { TokenIdentity } from '../tokens/TokenIdPanel';
import { shortTokenId } from '../tokens/tokenIdentity';
import { onTokenNav, takeMarketNft, takeMarketToken } from '../chat/nav';
import { showOnWallet } from '../tokens/indexFund';
import { isBappToken, unlaunchedBapps } from './bappTokens';
import { BAPPS } from '../bapps';
import { CURVE_FILTER, CURVE_LABEL, loadCurvePanel } from './launchpad/tile';
import {
  CURVE_COINS_ENABLED,
  TOKENBLASTER_ENABLED,
  marketFiltersFor,
  marketLabel,
  marketTradingEnabled,
} from '../storeBuild';
import { MyTokenListings } from '../sell/MyTokenListings';
import { TokenFacts } from '../exchange/TokenFacts';
import { STALE_LISTING_MESSAGE, listingSpendState } from './tokenPage';
import { sellRoute } from '../exchange/rowActions';
import { useNavigate } from 'react-router-dom';
import { SELL_ENABLED, ticketResaleFeeOptions, ticketResaleFeeSats } from '../sell/sell';
import { TicketsPanel } from '../tickets/TicketsPanel';
import { openTicketRoomInChat } from '../tickets/ticketRoom';
import { TICKET_COPY, eventLabel, type Ticket } from '../tickets/tickets';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { PullToRefresh } from '../ui/PullToRefresh';
import { openDappBrowser } from '../dappBrowser';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from './walletOutpoint';
import { ContractsMarket } from '../contracts/ContractsMarket';
import { GamesMarket } from '../games/GamesMarket';
import { ErrorActions } from '../errors/ErrorActions';

/**
 * Market tab: trending BSV-21 tokens and collections on the 1Sat order book
 * (ranking ported from 1satsocial), their cheapest listings, and in-app
 * purchase via upstream's @1sat/actions buyBsv21 / buyOrdinal with an optional
 * marketplace fee (./fee.ts). "My listings" shows your OrdLock listings with cancel.
 * New listings are not offered: upstream disabled OrdLock listing creation.
 */
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

const Art = ({
  outpoint,
  kind,
  collectionId,
}: {
  outpoint: string | null;
  kind: 'bsv21' | 'coll';
  collectionId?: string;
}) => {
  const urls = thumbOrFullUrls(outpoint, 96);
  const [i, setI] = useState(0);
  if (i < urls.length) {
    const img = (
      <img
        src={urls[i]}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setI(i + 1)}
        className="h-10 w-10 rounded-lg object-cover shrink-0 bg-[#2b2f36]"
      />
    );
    // Collection art shows as-is; blocked collections are already filtered out.
    return kind === 'coll' ? (
      <div className="h-10 w-10 rounded-lg overflow-hidden shrink-0 text-[0px]">
        <Blurred collectionId={collectionId}>{img}</Blurred>
      </div>
    ) : (
      img
    );
  }
  return (
    <div className="h-10 w-10 rounded-lg bg-[#2b2f36] flex items-center justify-center shrink-0">
      {kind === 'bsv21' ? <Coins size={16} color="#98A2B3" /> : <ImageIcon size={16} color="#98A2B3" />}
    </div>
  );
};

type Feed = BaseFeed & { partial?: boolean };
type Pending = { room: Pick<HotRoom, 'ref' | 'title'>; listing: Listing };
type Kind = 'tokens' | 'nfts';
/** NFTs side: trending collections, or the listing feed by media type. */
type View = 'collections' | NftCategory;
/**
 * Tokens side sub-filters. bApps = the bApps' own tokens (bappTokens.ts), listed like any other token.
 * Curve coins = bonding-curve coins (./launchpad/tile.ts), not in a store build.
 * Tickets = rooms you can buy into (src/mobile/tickets/TicketsPanel.tsx).
 */
type TokenFilter = 'all' | 'names' | 'bapps' | typeof CURVE_FILTER | 'tickets';
// Store build: no Tickets or curve coins (storeBuild.ts).
const TOKEN_FILTERS: [TokenFilter, string, boolean][] = marketFiltersFor<[TokenFilter, string, boolean]>([
  ['all', 'All tokens', true],
  // Names (owner, 15 Oct 2026; replaces Friends: people aren't bought and sold, names are): the OpNS names market.
  ['names', 'Names', true],
  ['bapps', 'bApps', true],
  ...(CURVE_COINS_ENABLED ? [[CURVE_FILTER, CURVE_LABEL, true] as [TokenFilter, string, boolean]] : []),
  ['tickets', 'Tickets', true],
]);
const TRADING = marketTradingEnabled();
// Curve coins load on demand and only outside a store build: CURVE_COINS_ENABLED folds to false there
// and Rollup drops ./launchpad/* entirely (code, strings and sourcemap sources).
const CurvePanel = CURVE_COINS_ENABLED ? lazy(loadCurvePanel) : null;
// The Names tile shows the Exchange's OpNS names market (the same screen as Exchange › Names).
const OpnsMarket = lazy(() => import('../exchange/OpnsMarket').then((m) => ({ default: m.OpnsMarket })));
// three.js viewer for a 3D (GLB) listing: same gate as the 3D tab, so three.js stays out of a store build.
const ModelPreview = TOKENBLASTER_ENABLED
  ? lazy(() => import('../three3d/Cabinet').then((m) => ({ default: m.ModelPreview })))
  : null;
// 1Sat Ordnance (tokenblaster.lol) 3D catalogue: bWalletX only, dropped from a store build.
const OrdnanceGrid = TOKENBLASTER_ENABLED
  ? lazy(() => import('../three3d/OrdnanceGrid').then((m) => ({ default: m.OrdnanceGrid })))
  : null;
const KIND_KEY = 'bwallet.market.kind';
const readKind = (): Kind => {
  try {
    return localStorage.getItem(KIND_KEY) === 'nfts' ? 'nfts' : 'tokens';
  } catch {
    return 'tokens';
  }
};
const isTokenOutput = (o: WalletOutput) => !!o.tags?.some((t) => t === 'bsv21' || t.startsWith('bsv21:'));

/** Market-side safety check for a trending room (token or collection). */
const roomSafe = (r: HotRoom) => hotRoomSafe(r);
const nftSafe = (n: NftListing) =>
  !safety().check({ ids: [n.outpoint, n.origin], collectionId: n.collectionId, texts: [n.name, n.collectionName] })
    .blocked;

const MarketPage = () => {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [section, setSection] = useState<'trending' | 'mine'>('trending');
  const [tokenFilter, setTokenFilter] = useState<TokenFilter>('all');
  const [rooms, setRooms] = useState<HotRoom[] | null>(null);
  const [error, setError] = useState('');
  const [room, setRoom] = useState<HotRoom | null>(null);
  const [market, setMarket] = useState<RoomMarket | null>(null);
  const [gamesOpen, setGamesOpen] = useState(false);
  // Strategies / Contracts / Bonds: panels that replace the token list (bWalletX only).
  const [panel, setPanel] = useState<'contracts' | 'bonds' | 'strategies' | 'shares' | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState('');
  const [mine, setMine] = useState<WalletOutput[] | null>(null);
  const [kind, setKindState] = useState<Kind>(readKind);
  const setKind = (k: Kind) => {
    setKindState(k);
    setRoom(null);
    try {
      localStorage.setItem(KIND_KEY, k);
    } catch {
      // private mode: just don't remember
    }
  };
  const [view, setView] = useState<View>('collections');
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedError, setFeedError] = useState('');
  const [preview, setPreview] = useState<NftListing | null>(null);
  const [reporting, setReporting] = useState<{
    outpoint: string;
    origin?: string | null;
    collectionId?: string | null;
    name: string;
  } | null>(null);
  const [safetyRev, setSafetyRev] = useState(0);
  useBackClose(!!pending && !busy, () => setPending(null));
  useBackClose(!!preview, () => setPreview(null));
  useBackClose(!!reporting, () => setReporting(null));
  const { handleSelect } = useBottomMenu();
  /** Set while the open room page is a ticket's (from the Tickets filter). */
  const [ticketPage, setTicketPage] = useState<{ ticket: Ticket; holder: boolean } | null>(null);
  // Tapping the Market tab returns to the board from a room, an NFT preview or a ticket page.
  useTabHome('market', () => {
    setRoom(null);
    setPreview(null);
    setTicketPage(null);
    setPending(null);
  });

  useEffect(() => {
    void refreshSafety();
    return onSafetyChange(() => setSafetyRev((n) => n + 1));
  }, []);

  const loadFeed = useCallback(async () => {
    setFeedError('');
    setFeed(null);
    try {
      setFeed(
        await nftFeed(300, (items) =>
          setFeed({
            items,
            stats: {
              scanned: 0,
              nft: 0,
              unclassified: 0,
              blocked: 0,
              counts: { music: 0, video: 0, images: 0, documents: 0, '3d': 0 },
            },
            partial: true,
          }),
        ),
      );
    } catch (e) {
      setFeedError(e instanceof Error ? e.message : String(e));
      setFeed({
        items: [],
        stats: {
          scanned: 0,
          nft: 0,
          unclassified: 0,
          blocked: 0,
          counts: { music: 0, video: 0, images: 0, documents: 0, '3d': 0 },
        },
      });
    }
  }, []);

  useEffect(() => {
    if (kind === 'nfts' && view !== 'collections' && feed === null) void loadFeed();
  }, [kind, view, feed, loadFeed]);

  const [loadingBoard, setLoadingBoard] = useState(false);
  const [directory, setDirectory] = useState<DirectoryToken[] | null>(null);
  const [directoryFailed, setDirectoryFailed] = useState(false);
  const loadBoard = useCallback(async () => {
    setError('');
    setRooms(null);
    setLoadingBoard(true);
    // The full active-token list is one fast request: show it while trending ranks.
    setDirectoryFailed(false);
    void tokenDirectory()
      .then(setDirectory)
      .catch(() => (setDirectory([]), setDirectoryFailed(true)));
    try {
      setRooms(await hotBoard((partial) => setRooms(partial)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRooms([]);
    } finally {
      setLoadingBoard(false);
    }
  }, []);

  const loadMine = useCallback(async () => {
    setMine(null);
    try {
      const { outputs } = await listOrdinals.execute(apiContext, { limit: 100, offset: 0 });
      setMine(outputs.filter((o) => o.tags?.includes('ordlock')));
    } catch {
      setMine([]);
    }
  }, [apiContext]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    if (section === 'mine' && mine === null) void loadMine();
  }, [section, mine, loadMine]);

  const openRoom = async (r: HotRoom, ticket: { ticket: Ticket; holder: boolean } | null = null) => {
    setTicketPage(ticket);
    setRoom(r);
    setMarket(null);
    setMarket(await roomMarket(r.ref));
  };

  // Open a token / collection page by id (never by ticker: tickers aren't unique).
  const openRoomById = (kind: string, id: string) => {
    const ref = parseRoom(kind, id);
    if (!ref) return;
    void roomMeta(ref.kind, ref.id).then((m) =>
      openRoom({
        ref,
        title: m?.title ?? (ref.kind === 'bsv21' ? 'Token' : 'Collection'),
        subtitle: m?.subtitle ?? '',
        icon: m?.icon ?? null,
        trades: 0,
        newListings: 0,
        floorLabel: null,
        heat: 0,
      }),
    );
  };

  // "Buy in Market" from a locked token room in Chat: open that token's page.
  useEffect(() => {
    const take = () => {
      const nft = takeMarketNft();
      if (nft) {
        setView('3d');
        setPreview(nft);
      }
      const want = takeMarketToken();
      if (want) openRoomById(want.kind, want.id);
    };
    take();
    return onTokenNav(take);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only listener; openRoomById only sets state
  }, []);

  const buy = async ({ room: r, listing }: Pending) => {
    if (!TRADING) return;
    setBusy('Buying…');
    try {
      // Ticket resales use the ticket resale fee (default 0), not the general Market fee.
      const fee = ticketPage ? ticketResaleFeeOptions() : marketFeeOptions();
      const outpoint = walletOutpoint(listing.outpoint);
      const ctx = purchaseContext(apiContext, outpoint);
      // Pre-buy: drop a listing someone already bought (1Sat's search can lag a sale).
      if ((await listingSpendState(listing.outpoint)) === 'spent') {
        addSnackbar(STALE_LISTING_MESSAGE, 'info');
        setMarket((m) => (m ? { ...m, listings: m.listings.filter((x) => x.outpoint !== listing.outpoint) } : m));
        setPending(null);
        clearMarketCache();
        return;
      }
      await assertOrdLockV2(outpoint);
      const res =
        r.ref.kind === 'bsv21'
          ? await buyBsv21.execute(ctx, {
              tokenId: r.ref.id,
              outpoint,
              amount: listing.amount ?? '0',
              ...fee,
              ...MODULE_FINISHES,
            })
          : await buyOrdinal.execute(ctx, { outpoint, ...fee, ...MODULE_FINISHES });
      if (!res.txid || res.error) {
        addSnackbar(purchaseError(res.error), 'error');
        return;
      }
      // The Wallet tab lists favourite tokens only: show what was just bought there.
      if (r.ref.kind === 'bsv21') void showOnWallet(chromeStorageService, r.ref.id);
      addSnackbar(ticketPage ? 'Ticket bought: you can open the room now.' : 'Purchase sent!', 'success');
      if (ticketPage) setTicketPage({ ...ticketPage, holder: true });
      setPending(null);
      clearMarketCache();
      // Refresh in the background: the purchase is done, and listings can take a while to reload.
      if (room) void roomMarket(room.ref).then(setMarket, () => {});
      else void loadFeed();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Purchase failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const cancel = async (o: WalletOutput) => {
    const id = readAssetIdTag(o.tags);
    if (!id) return addSnackbar('Listing is missing a tracking id', 'error');
    setBusy('Cancelling listing…');
    try {
      const res = await cancelOrdinalListing.execute(apiContext, { id });
      if (!res.txid || res.error) addSnackbar(getErrorMessage(res.error), 'error');
      else {
        addSnackbar('Listing cancelled', 'success');
        await loadMine();
      }
    } finally {
      setBusy('');
    }
  };

  // Big category tiles (owner, 4 Oct 2026): everything that's for sale, visible at a glance instead of
  // hidden in a Tokens/NFTs switch and small chips. Tokens stays the default view.
  type Cat = { id: string; label: string; kind: Kind; token?: TokenFilter; view?: View; soon?: boolean };
  const CATS: Cat[] = [
    { id: 'tokens', label: 'Tokens', kind: 'tokens', token: 'all' },
    { id: 'names', label: 'Names', kind: 'tokens', token: 'names' },
    { id: 'music', label: 'Music', kind: 'nfts', view: 'music' },
    { id: 'video', label: 'Video', kind: 'nfts', view: 'video' },
    { id: 'images', label: 'Images', kind: 'nfts', view: 'images' },
    { id: 'documents', label: 'Documents', kind: 'nfts', view: 'documents' },
    { id: 'collections', label: 'Collections', kind: 'nfts', view: 'collections' },
    { id: 'bapps', label: 'bApps', kind: 'tokens', token: 'bapps' },
    ...(TOKEN_FILTERS.some(([f]) => f === 'tickets')
      ? [{ id: 'tickets', label: 'Tickets', kind: 'tokens' as Kind, token: 'tickets' as TokenFilter }]
      : []),
    ...(TRADING
      ? [
          { id: 'contracts', label: 'Contracts', kind: 'tokens' as Kind },
          // Games (owner, 17 Oct 2026): our games + game tokens. bWalletX only: the cards open tokenblaster.lol
          // (per-action fees, TOKENBLASTER_ENABLED) and the tokens open trading rooms, so a store build would be empty.
          { id: 'games', label: 'Games', kind: 'tokens' as Kind },
          // 3D NFTs: 1Sat Ordnance game guns from tokenblaster.lol as spinning models (owner, 6 Oct 2026).
          // bWalletX only: buying sends you to an outside store, which the app stores reject.
        ]
      : []),
    ...(TRADING && TOKENBLASTER_ENABLED ? [{ id: '3d', label: '3D', kind: 'nfts' as Kind, view: '3d' as View }] : []),
  ];
  // Bonds and Strategies are tabs inside Contracts (owner, 7 / 17 Oct 2026): panel 'bonds' means Contracts › Bonds.
  const activeCat =
    (panel ? 'contracts' : null) ??
    (gamesOpen ? 'games' : null) ??
    (kind === 'tokens' ? (tokenFilter === 'all' ? 'tokens' : tokenFilter) : view);
  // A grid of square filter buttons, all visible at once: no sideways scrolling, so nothing (e.g. Bonds) is
  // hidden (owner, 5 Oct 2026). Four across, wrapping onto more rows as categories are added.
  const pick = (c: Cat) => {
    setGamesOpen(c.id === 'games');
    setPanel(c.id === 'contracts' ? 'contracts' : null);
    setKind(c.kind);
    if (c.token) setTokenFilter(c.token);
    if (c.view) setView(c.view);
    setRoom(null);
  };
  // Launchpad: a full-width gold bar above the grid (owner, 7 Oct 2026), like the Send / Receive / Mint pills.
  // Never in a store build (CURVE_COINS_ENABLED).
  const launchOn = CURVE_COINS_ENABLED && activeCat === CURVE_FILTER;
  const categoryTiles = (
    <div className="flex flex-col gap-1.5">
      {/* Launchpad (left half, never in a store build) + bStore (right half, or the full width alone). */}
      <div className="flex gap-1.5">
        {CURVE_COINS_ENABLED && (
          <button
            type="button"
            aria-pressed={launchOn}
            onClick={() => pick({ id: CURVE_FILTER, label: CURVE_LABEL, kind: 'tokens', token: CURVE_FILTER })}
            className="bw-pill bw-pill-gold flex min-h-[44px] flex-1 basis-0 items-center justify-center gap-2 py-2.5 text-sm font-bold"
            style={launchOn ? { boxShadow: '0 0 0 2px #010101, 0 0 0 4px var(--bw-accent)' } : { opacity: 0.85 }}
          >
            <Rocket size={16} /> {CURVE_LABEL}
            {launchOn && <span className="text-[10px] font-semibold uppercase tracking-wide">· open</span>}
          </button>
        )}
        <Link
          to="/m/store"
          className="bw-pill bw-pill-gold flex min-h-[44px] flex-1 basis-0 items-center justify-center gap-2 py-2.5 text-sm font-bold no-underline"
          style={{ opacity: 0.85 }}
        >
          <Palette size={16} /> Store
        </Link>
      </div>
      <div className="grid grid-cols-4 gap-1.5" role="tablist" aria-label="What's for sale">
        {CATS.map((c) => {
          const on = !c.soon && activeCat === c.id;
          return (
            <button
              key={c.id}
              role="tab"
              aria-selected={on}
              disabled={c.soon}
              onClick={() => {
                if (!c.soon) pick(c);
              }}
              className="flex min-h-[44px] items-center justify-center rounded-xl px-1 py-2 text-center text-[12px] font-semibold leading-tight"
              style={{
                background: on ? 'var(--bw-accent)' : '#17191E',
                color: c.soon ? '#667085' : on ? '#010101' : '#98A2B3',
              }}
            >
              {c.label}
              {c.soon && <span className="ml-1 text-[9px] font-medium uppercase tracking-wide">soon</span>}
            </button>
          );
        })}
      </div>
    </div>
  );

  const segment = (
    <div className="flex gap-1 rounded-xl p-1 bg-[var(--bw-surface)]">
      {(
        [
          ['trending', 'Trending'],
          ['mine', 'My listings'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          onClick={() => setSection(id)}
          className="flex-1 rounded-lg py-1.5 text-xs font-semibold"
          style={{ background: section === id ? '#2b2f36' : 'transparent', color: section === id ? '#fff' : '#98A2B3' }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const playPreview = (n: NftListing) => {
    playQueue(
      [
        {
          id: n.outpoint,
          title: n.name,
          url: contentUrls(n.origin)[0],
          artwork: n.collectionIcon ? contentUrls(n.collectionIcon)[0] : undefined,
        },
      ],
      0,
    );
  };

  const shownNfts = feed && view !== 'collections' ? listingsIn(feed.items, view).filter(nftSafe) : [];
  // 3D: collapse repetitive collections (e.g. "Kowry Glider (12)") and rank them after one-offs; tap to expand.
  const [expanded3d, setExpanded3d] = useState<ReadonlySet<string>>(() => new Set());
  const cells =
    view === '3d'
      ? groupCollections(shownNfts, expanded3d)
      : shownNfts.map((n) => ({ item: n, key: null as string | null, count: 1, label: n.name }));
  const nftGrid = (
    <section className="flex flex-col gap-2">
      {feed === null && <p className="text-xs text-[#98A2B3] text-center py-8">Loading NFT listings…</p>}
      {feedError && <p className="text-xs text-[#F97066]">{feedError}</p>}
      {feed && shownNfts.length === 0 && (
        <p className="text-xs text-[#98A2B3] text-center py-8">Nothing listed here right now.</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {cells.map(({ item: n, key: gk, count, label }) => (
          <div key={n.outpoint} className="flex flex-col gap-1 min-w-0">
            <NftCard
              item={n}
              onPlay={() => playPreview(n)}
              onOpen={() => {
                // Documents open as-is from ORDFS in the dApp browser (no in-app viewer for PDF / Office).
                if (n.category === 'documents') return void openDappBrowser(contentUrls(n.origin)[0]);
                if (n.category === 'video') pauseAudio();
                setPreview(n);
              }}
              onReport={() =>
                setReporting({ outpoint: n.outpoint, origin: n.origin, collectionId: n.collectionId, name: n.name })
              }
              onBuy={() =>
                setPending({
                  room: { ref: { kind: 'coll', id: n.collectionId ?? '', key: '' }, title: n.collectionName ?? 'NFT' },
                  listing: {
                    outpoint: n.outpoint,
                    priceSats: n.priceSats,
                    amount: null,
                    label: n.name,
                    origin: n.origin,
                    seller: n.seller,
                    buyable: n.buyable,
                  },
                })
              }
            />
            {gk && count > 1 && (
              <button
                type="button"
                onClick={() => setExpanded3d((prev) => new Set(prev).add(gk))}
                className={`text-[11px] text-[#98A2B3] bg-[var(--bw-surface)] border border-[#2b2f36] rounded-full px-2 py-1 ${ELLIPSIS}`}
              >
                {label} · show all
              </button>
            )}
          </div>
        ))}
      </div>
      {feed?.partial && <p className="text-[10px] text-[#667085] text-center">Still loading…</p>}
      {feed && !feed.partial && (
        <p className="text-[10px] text-[#667085] text-center flex items-center justify-center gap-1">
          <ShieldCheck size={11} /> Safety filter on · {feed.stats.blocked} hidden · {feed.stats.unclassified}{' '}
          unsupported
        </p>
      )}
    </section>
  );

  // Tokens view: trending first, then every active overlay token, paged on scroll.
  const PAGE = 40;
  const [shown, setShown] = useState(PAGE);
  const [q, setQ] = useState('');
  const [floors, setFloors] = useState<Record<string, { floor: string | null; listings: number }>>({});
  const tokenRows = useMemo(
    () => mergeTokenBoard(rooms ?? [], directory ?? []).filter(roomSafe),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rooms, directory, safetyRev],
  );
  // Search (owner, 5 Oct 2026): ticker or token id, across every token whatever the filter.
  const query = q.trim().replace(/^\$/, '').toLowerCase();
  const searched = useMemo(() => {
    if (!query) return null;
    const all = new Map<string, HotRoom>();
    for (const r of tokenRows) all.set(r.ref.key, r);
    const hits = [...all.values()].filter(
      (r) => r.title.replace(/^\$/, '').toLowerCase().includes(query) || r.ref.id.toLowerCase() === query,
    );
    const rank = (r: HotRoom) => {
      const t = r.title.replace(/^\$/, '').toLowerCase();
      return t === query ? 0 : t.startsWith(query) ? 1 : 2;
    };
    hits.sort((a, b) => rank(a) - rank(b));
    // A pasted token id the lists don't know yet still opens.
    const ref = hits.length ? null : parseRoom('bsv21', q.trim());
    if (ref)
      hits.push({
        ref,
        title: 'Token',
        subtitle: 'BSV-21 token',
        icon: null,
        trades: 0,
        newListings: 0,
        floorLabel: null,
        heat: 0,
      });
    return hits;
  }, [query, q, tokenRows]);
  const filteredTokens = searched
    ? searched
    : tokenFilter === 'bapps'
      ? tokenRows.filter((r) => isBappToken(r.ref.id))
      : tokenRows;
  const visibleTokens = filteredTokens.slice(0, shown);
  // Tickers are not unique: flag every ticker more than one token id uses (issuer check on those rows).
  const dupTickers = useMemo(
    () =>
      duplicateTickers(
        [...tokenRows, ...(rooms ?? [])]
          .filter((r) => r.ref.kind === 'bsv21')
          .map((r) => ({ ticker: r.title.replace(/^\$/, ''), tokenId: r.ref.id })),
      ),
    [tokenRows, rooms],
  );
  const dupFor = (title: string) => dupTickers.get(title.replace(/^\$/, '').toUpperCase());
  const personalLinks = knownPersonal();
  const personalRow = (r: Pick<HotRoom, 'ref' | 'title' | 'icon'>, i: number) => (
    <button
      key={r.ref.key}
      onClick={() => void openRoom(r as HotRoom)}
      className="flex items-center gap-3 rounded-xl bg-[var(--bw-surface)] px-3 py-3 text-left"
    >
      <span className="w-6 text-[11px] font-semibold text-[#667085]">{i + 1}</span>
      <Art outpoint={r.icon} kind="bsv21" collectionId={r.ref.id} />
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>
          {tickerLabel(r.title.replace(/^\$/, ''), r.ref.id, personalLinks)}
        </div>
        <div className="text-[11px] text-[#98A2B3]">Access to a holders' room</div>
      </div>
      <span
        className="shrink-0 rounded-full px-2 py-[1px] text-[10px] font-bold"
        style={{ background: '#2a2208', color: 'var(--bw-accent-hi)', border: '1px solid #3a2f0c' }}
      >
        Personal token
      </span>
    </button>
  );
  const floorsAsked = useRef(new Set<string>());
  useEffect(() => {
    if (kind !== 'tokens') return;
    const todo = visibleTokens.filter((r) => r.heat === 0 && !floorsAsked.current.has(r.ref.key));
    todo.forEach((r) => floorsAsked.current.add(r.ref.key));
    let i = 0;
    const next = async (): Promise<void> => {
      const r = todo[i++];
      if (!r) return;
      const m = await roomMarket(r.ref).catch(() => null);
      if (m) setFloors((f) => ({ ...f, [r.ref.key]: { floor: m.floorLabel ?? null, listings: m.buyableCount ?? 0 } }));
      return next();
    };
    void Promise.all([next(), next(), next(), next()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, visibleTokens.length, tokenRows]);
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [kind, tokenRows.length, shown]);

  const tokenList = (
    <section className="flex flex-col gap-2">
      {tokenRows.length === 0 && (rooms === null || directory === null) && (
        <p className="text-xs text-[#98A2B3] text-center py-8">Loading tokens…</p>
      )}
      {loadingBoard && tokenRows.length > 0 && <p className="text-[10px] text-[#667085] text-center">Still ranking…</p>}
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[#F97066]">{error}</p>
          <ErrorActions message={String(error)} />
        </div>
      )}
      {searched?.length === 0 && (
        <p className="text-xs text-[#98A2B3] text-center py-8">No token matches “{q.trim()}”.</p>
      )}
      {!searched && directoryFailed && filteredTokens.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-8">
          <p className="text-xs text-[#98A2B3] text-center m-0">
            Couldn’t reach the token index (1Sat / GorillaPool). It’s usually back in a minute.
          </p>
          <button
            type="button"
            onClick={() => {
              clearMarketCache();
              void loadBoard();
            }}
            className="rounded-full px-4 py-2 text-sm font-semibold"
            style={{ background: 'var(--bw-accent)', color: '#010101' }}
          >
            Retry
          </button>
        </div>
      )}
      {!searched &&
        !directoryFailed &&
        tokenFilter !== 'bapps' &&
        filteredTokens.length === 0 &&
        rooms !== null &&
        directory !== null &&
        !error && <p className="text-xs text-[#98A2B3] text-center py-8">No tokens found.</p>}
      {visibleTokens.map((r, i) => {
        // Personal tokens ($BOASE): social / access only. Badge, no floor, no price talk.
        if (isPersonalTokenId(r.ref.id, personalLinks)) return personalRow(r, i);
        const f = floors[r.ref.key];
        const listings = r.heat > 0 ? r.newListings : f?.listings;
        const floor = r.floorLabel ?? f?.floor ?? null;
        const stats = [
          r.trades ? `${r.trades} sales` : null,
          listings ? `${listings} listed` : null,
          r.outputs ? `${r.outputs.toLocaleString()} outputs` : null,
        ].filter(Boolean);
        return (
          <button
            key={r.ref.key}
            onClick={() => void openRoom(r)}
            className="flex items-center gap-3 rounded-xl bg-[var(--bw-surface)] px-3 py-3 text-left"
          >
            <span className="w-6 text-[11px] font-semibold text-[#667085]">{i + 1}</span>
            <Art outpoint={r.icon} kind="bsv21" collectionId={r.ref.id} />
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>
                {r.title}
                {r.heat > 0 && <Flame size={11} className="inline ml-1" style={{ color: '#A1FF8B' }} />}
              </div>
              <div className={`text-[11px] text-[#98A2B3] ${ELLIPSIS}`}>{['Token', ...stats].join(' · ')}</div>
              {dupFor(r.title) && (
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[10px] font-mono text-[#667085] shrink-0">{shortTokenId(r.ref.id)}</span>
                  <IssuerBadge tokenId={r.ref.id} compact />
                </div>
              )}
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] text-[#667085]">Floor</div>
              <div className="text-xs font-semibold" style={{ color: '#A1FF8B' }}>
                {floor ?? '—'}
              </div>
            </div>
          </button>
        );
      })}
      {shown < filteredTokens.length && <div ref={sentinel} className="h-8" />}
      {/* bApps with no token yet: what they are, nothing for sale. */}
      {!searched &&
        tokenFilter === 'bapps' &&
        unlaunchedBapps(BAPPS).map((a) => (
          <button
            key={a.name}
            onClick={() => void openDappBrowser(a.url)}
            className="flex items-center gap-3 rounded-xl bg-[var(--bw-surface)] px-3 py-3 text-left"
          >
            {a.icon ? (
              <img src={a.icon} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
            ) : (
              <div className="h-10 w-10 shrink-0 rounded-lg bg-[#2b2f36]" />
            )}
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>${a.name}</div>
              <div className={`text-[11px] text-[#98A2B3] ${ELLIPSIS}`}>{a.verb}</div>
            </div>
            <span className="shrink-0 rounded-full bg-[#2b2f36] px-2 py-0.5 text-[10px] font-semibold text-[#98A2B3]">
              Not launched
            </span>
          </button>
        ))}
    </section>
  );

  const trending = (
    <section className="flex flex-col gap-2">
      {rooms === null && <p className="text-xs text-[#98A2B3] text-center py-8">Loading the order book…</p>}
      {loadingBoard && rooms !== null && <p className="text-[10px] text-[#667085] text-center">Still ranking…</p>}
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[#F97066]">{error}</p>
          <ErrorActions message={String(error)} />
        </div>
      )}
      {rooms?.length === 0 && !error && (
        <p className="text-xs text-[#98A2B3] text-center py-8">Nothing trending right now.</p>
      )}
      {rooms
        ?.filter(roomSafe)
        .filter((r) => (kind === 'tokens' ? r.ref.kind === 'bsv21' : r.ref.kind === 'coll'))
        .map((r, i) =>
          r.ref.kind === 'bsv21' && isPersonalTokenId(r.ref.id, personalLinks) ? (
            personalRow(r, i)
          ) : (
            <button
              key={r.ref.key}
              onClick={() => void openRoom(r)}
              className="flex items-center gap-3 rounded-xl bg-[var(--bw-surface)] px-3 py-3 text-left"
            >
              <span className="w-4 text-[11px] font-semibold text-[#667085]">{i + 1}</span>
              <Art outpoint={r.icon} kind={r.ref.kind} collectionId={r.ref.id} />
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{r.title}</div>
                <div className="text-[11px] text-[#98A2B3]">
                  {r.ref.kind === 'bsv21' ? 'Token' : 'Collection'} · {r.trades} sales · {r.newListings} new listings
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] text-[#667085]">Floor</div>
                <div className="text-xs font-semibold" style={{ color: '#A1FF8B' }}>
                  {r.floorLabel ?? '—'}
                </div>
              </div>
            </button>
          ),
        )}
    </section>
  );

  const roomView = room && (
    <section className="flex flex-col gap-2">
      <button
        onClick={() => {
          setRoom(null);
          setTicketPage(null);
        }}
        className="flex items-center gap-1 text-xs text-[#98A2B3] self-start"
      >
        <ArrowLeft size={14} /> {ticketPage ? 'Tickets' : 'Trending'}
      </button>
      <div className="flex items-center gap-3">
        <Art outpoint={room.icon} kind={room.ref.kind} collectionId={room.ref.id} />
        <div className="min-w-0">
          <div className="text-base font-bold text-white">{room.title}</div>
          <div className={`text-[11px] text-[#98A2B3] ${ELLIPSIS}`}>{room.subtitle}</div>
          {room.ref.kind === 'bsv21' && <IssuerBadge tokenId={room.ref.id} />}
        </div>
        {ticketPage ? (
          ticketPage.holder && (
            <button
              onClick={() => openTicketRoomInChat(ticketPage.ticket.tokenId, handleSelect)}
              className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold shrink-0"
              style={{ background: '#2a2208', color: 'var(--bw-accent-hi)', border: '1px solid #3a2f0c' }}
            >
              Open room
            </button>
          )
        ) : (
          <OpenTokenRoomButton
            kind={room.ref.kind}
            id={room.ref.id}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold shrink-0"
            style={{ background: '#2a2208', color: 'var(--bw-accent-hi)', border: '1px solid #3a2f0c' }}
          />
        )}
      </div>
      {room.ref.kind === 'bsv21' && !ticketPage && (
        <TokenIdentity
          tokenId={room.ref.id}
          ticker={room.title === 'Token' ? null : room.title}
          onPick={(id) => openRoomById('bsv21', id)}
        />
      )}
      {room.ref.kind === 'bsv21' && !ticketPage && <TokenLinks tokenId={room.ref.id} sym={room.title} />}
      {room.ref.kind === 'bsv21' && !ticketPage && (
        <TokenFacts tokenId={room.ref.id} sym={room.title.replace(/^\$/, '')} priceSats={market?.floorSats ?? null} />
      )}
      {room.ref.kind === 'bsv21' && !ticketPage && SELL_ENABLED && TRADING && (
        <button
          type="button"
          onClick={() => navigate(sellRoute(room.ref.id))}
          className="rounded-xl py-2.5 text-xs font-bold border"
          style={{ background: '#2a2208', color: 'var(--bw-accent-hi)', borderColor: '#3a2f0c' }}
        >
          <Tag size={12} className="inline mr-1" /> List mine for sale
        </button>
      )}
      {ticketPage && (
        <div className="text-[11px] leading-relaxed text-[#98A2B3] rounded-xl bg-[var(--bw-surface)] px-3 py-2.5">
          {TICKET_COPY}
          {ticketPage.ticket.description && <div className="mt-1 text-white">{ticketPage.ticket.description}</div>}
          {eventLabel(ticketPage.ticket.eventDate) && (
            <div className="mt-1">Event: {eventLabel(ticketPage.ticket.eventDate)}</div>
          )}
          {ticketPage.holder && (
            <div className="mt-1 text-[color:var(--bw-accent-hi)]">You hold a ticket: the room is yours to open.</div>
          )}
        </div>
      )}
      <div className="text-[11px] text-[#98A2B3]">
        {room.ref.kind === 'bsv21' && isPersonalTokenId(room.ref.id, personalLinks)
          ? "Personal token · holding one opens its holders' room. Not an investment; issuers may reward holders with airdrops."
          : `Floor ${market?.floorLabel ?? '—'} · ${market?.live ?? 0} live · ${market?.buyableCount ?? 0} buyable in-app`}
      </div>
      {market === null && <p className="text-xs text-[#98A2B3] text-center py-6">Loading listings…</p>}
      {market?.listings.length === 0 && (
        <p className="text-xs text-[#98A2B3] text-center py-6">
          {ticketPage ? 'No tickets listed for sale right now. Ask a holder to send you one.' : 'No live listings.'}
        </p>
      )}
      {market?.listings
        .filter(
          (l) =>
            room.ref.kind === 'bsv21' ||
            (!!categoryOf(l.contentType) && roomListingSafe(l, { id: room.ref.id, title: room.title })),
        )
        .map((l) => (
          <div key={l.outpoint} className="flex items-center gap-3 rounded-xl bg-[var(--bw-surface)] px-3 py-2.5">
            {room.ref.kind === 'coll' && (
              <Art
                outpoint={categoryOf(l.contentType) === 'images' ? l.origin : room.icon}
                kind="coll"
                collectionId={room.ref.id}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className={`text-sm text-white ${ELLIPSIS}`}>{l.label}</div>
              <div className="text-[11px] font-semibold" style={{ color: '#A1FF8B' }}>
                {formatSats(l.priceSats)}
              </div>
            </div>
            {TRADING && (
              <button
                disabled={!l.buyable}
                onClick={() => setPending({ room, listing: l })}
                className="rounded-lg px-3 py-1.5 text-xs font-bold"
                style={{ background: l.buyable ? '#A1FF8B' : '#2b2f36', color: l.buyable ? '#010101' : '#667085' }}
              >
                {l.buyable ? (ticketPage ? 'Buy ticket' : 'Buy') : 'Unavailable'}
              </button>
            )}
            {room.ref.kind === 'coll' && (
              <button
                aria-label="Report"
                className="p-1"
                onClick={() =>
                  setReporting({ outpoint: l.outpoint, origin: l.origin, collectionId: room.ref.id, name: l.label })
                }
              >
                <Flag size={14} color="#F97066" />
              </button>
            )}
          </div>
        ))}
    </section>
  );

  const mineView = (
    <section className="flex flex-col gap-2">
      {SELL_ENABLED && kind === 'tokens' ? (
        <MyTokenListings emptyText="No token listings. Sell from a token's page or Wallet › Tickets." />
      ) : (
        <p className="text-[11px] leading-relaxed text-[#98A2B3] rounded-xl bg-[var(--bw-surface)] px-3 py-2.5">
          <Tag size={11} className="inline mr-1" />
          {ORDLOCK_LISTING_DISABLED_MESSAGE}
        </p>
      )}
      {mine === null && <p className="text-xs text-[#98A2B3] text-center py-6">Loading…</p>}
      {!(SELL_ENABLED && kind === 'tokens') &&
        mine?.filter((o) => isTokenOutput(o) === (kind === 'tokens')).length === 0 && (
          <p className="text-xs text-[#98A2B3] text-center py-6">
            You have no open {kind === 'tokens' ? 'token' : 'NFT'} listings.
          </p>
        )}
      {mine
        ?.filter((o) => isTokenOutput(o) === (kind === 'tokens'))
        .map((o) => (
          <div key={o.outpoint} className="flex items-center gap-3 rounded-xl bg-[var(--bw-surface)] px-3 py-2.5">
            <div className={`min-w-0 flex-1 text-sm text-white ${ELLIPSIS}`}>{getOutputName(o, 'Listing')}</div>
            <button
              onClick={() => void cancel(o)}
              className="rounded-lg px-3 py-1.5 text-xs font-bold bg-[#2b2f36] text-white"
            >
              Cancel
            </button>
          </div>
        ))}
    </section>
  );

  const fee = pending
    ? ticketPage
      ? ticketResaleFeeSats(pending.listing.priceSats)
      : marketFeeSats(pending.listing.priceSats)
    : 0;
  const confirm = pending && (
    <div className="fixed inset-0 z-[200] flex items-end bg-black/60" onClick={() => !busy && setPending(null)}>
      <div
        className="w-full rounded-t-2xl bg-[var(--bw-surface)] px-5 pt-5 flex flex-col gap-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-bold text-white">Confirm purchase</div>
        <div className="text-sm text-white">
          {pending.listing.label}
          <span className="text-[#98A2B3]"> · {pending.room.title}</span>
        </div>
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex justify-between text-[#98A2B3]">
            <span>Price (to seller)</span>
            <span className="text-white">{formatSats(pending.listing.priceSats)}</span>
          </div>
          <div className="flex justify-between text-[#98A2B3]">
            <span>{ticketPage ? 'Resale fee' : `Marketplace fee (${MARKET_FEE_RATE * 100}%)`}</span>
            <span className="text-white">{fee ? formatSats(fee) : ticketPage ? 'None' : 'None (not configured)'}</span>
          </div>
          <div className="flex justify-between text-[#98A2B3]">
            <span>Network fee</span>
            <span className="text-white">a few sats, from your balance</span>
          </div>
          <div className="flex justify-between border-t border-[#2b2f36] pt-1.5 font-semibold">
            <span className="text-white">Total</span>
            <span style={{ color: '#A1FF8B' }}>{formatSats(pending.listing.priceSats + fee)} + network fee</span>
          </div>
        </div>
        <button
          disabled={!!busy}
          onClick={() => void buy(pending)}
          className="rounded-xl py-3 text-sm font-bold"
          style={{ background: '#A1FF8B', color: '#010101' }}
        >
          Buy for {formatSats(pending.listing.priceSats + fee)}
        </button>
        <button disabled={!!busy} onClick={() => setPending(null)} className="py-2 text-xs text-[#98A2B3]">
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36"
      style={{ height: '100%', background: 'var(--bw-bg)' }}
    >
      <PullToRefresh
        onRefresh={() => {
          clearMarketCache();
          if (section === 'mine') return loadMine();
          if (room) return openRoom(room);
          if (kind === 'tokens' || view === 'collections') return loadBoard();
          return loadFeed();
        }}
      />
      <TopNav />
      {busy && <PageLoader theme={theme} message={busy} />}
      <div className="w-full px-4 pt-16 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-white flex items-center gap-1.5">
            <Flame size={18} style={{ color: '#A1FF8B' }} /> {marketLabel()}
          </h1>
        </div>
        {section === 'trending' && !room && categoryTiles}
        {segment}
        {section === 'mine' ? (
          mineView
        ) : gamesOpen && !room ? (
          <GamesMarket tokens={tokenRows} onOpenToken={(r) => void openRoom(r)} />
        ) : panel && !room ? (
          <ContractsMarket
            tab={panel === 'contracts' ? 'all' : panel}
            onTab={(t) => setPanel(t === 'all' ? 'contracts' : t)}
          />
        ) : room ? (
          roomView
        ) : kind === 'tokens' ? (
          tokenFilter === CURVE_FILTER && CurvePanel ? (
            <Suspense fallback={null}>
              <CurvePanel />
            </Suspense>
          ) : tokenFilter === 'names' ? (
            <Suspense fallback={null}>
              <OpnsMarket rate={cachedExchangeRate()} />
            </Suspense>
          ) : tokenFilter === 'tickets' ? (
            <TicketsPanel
              art={(icon, id) => <Art outpoint={icon} kind="bsv21" collectionId={id} />}
              onBuy={(t, holder) =>
                void openRoom(
                  {
                    ref: parseRoom('bsv21', t.tokenId)!,
                    title: t.name,
                    subtitle: `$${t.ticker} · ticket`,
                    icon: t.icon,
                    trades: 0,
                    newListings: 0,
                    floorLabel: null,
                    heat: 0,
                  },
                  { ticket: t, holder },
                )
              }
            />
          ) : (
            <>
              {tokenList}
              <div className="h-16" />
              <div
                className="fixed left-0 right-0 z-[60] px-4 py-2"
                style={{
                  bottom: 'calc(var(--dock-h, 3.75rem) + env(safe-area-inset-bottom))',
                  background: 'linear-gradient(transparent, #010101 35%)',
                }}
              >
                <label className="flex items-center gap-2 rounded-full bg-[var(--bw-surface)] px-4 py-2.5 border border-[#2b2f36]">
                  <Search size={16} color="#98A2B3" />
                  <input
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setShown(PAGE);
                    }}
                    placeholder="Search tokens: $TICKER or token id"
                    enterKeyHint="search"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 bg-transparent text-sm text-white outline-none border-0"
                  />
                  {q && (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() => setQ('')}
                      className="p-0 bg-transparent border-0"
                    >
                      <X size={16} color="#98A2B3" />
                    </button>
                  )}
                </label>
              </div>
            </>
          )
        ) : view === 'collections' ? (
          trending
        ) : view === '3d' ? (
          // Market › 3D (owner, 8 Oct 2026): Featured (1Sat Ordnance) first, then the rest of the 3D order book.
          <>
            {OrdnanceGrid && (
              <>
                <h3 className="m-0 text-sm font-semibold text-white">Featured</h3>
                <Suspense fallback={null}>
                  <OrdnanceGrid />
                </Suspense>
                <h3 className="m-0 mt-2 text-sm font-semibold text-white">More 3D</h3>
              </>
            )}
            {nftGrid}
          </>
        ) : (
          nftGrid
        )}
        <p className="text-[10px] text-[#667085] text-center">Listings from the 1Sat order book (api.1sat.app).</p>
      </div>
      {confirm}
      {preview && (
        <div
          className="fixed inset-0 z-[200] flex flex-col bg-black"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <span className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{preview.name}</span>
            <button aria-label="Close" onClick={() => setPreview(null)} className="p-2">
              <X size={20} color="#fff" />
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center min-h-0">
            {preview.category === 'video' && (
              <video src={contentUrls(preview.origin)[0]} controls playsInline className="max-w-full max-h-full" />
            )}
            {preview.category === '3d' &&
              (ModelPreview ? (
                <Suspense fallback={<p className="text-xs text-[#98A2B3]">Loading 3D viewer…</p>}>
                  <ModelPreview url={contentUrls(preview.origin)[0]} />
                </Suspense>
              ) : null)}
            {preview.category === 'images' && (
              <ContentImg
                outpoint={preview.origin}
                alt={preview.name}
                className="max-w-full max-h-full object-contain"
              />
            )}
          </div>
          <div className="px-4 py-3 text-[10px] text-[#667085] break-all">
            {preview.collectionName ?? 'No collection'} · {preview.priceLabel} · {preview.contentType}
          </div>
        </div>
      )}
      {reporting && (
        <div className="fixed inset-0 z-[210] flex items-end bg-black/60" onClick={() => setReporting(null)}>
          <div
            className="w-full rounded-t-2xl bg-[var(--bw-surface)] px-5 pt-5 flex flex-col gap-3"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-base font-bold text-white">Report this item?</div>
            <div className="text-xs text-[#98A2B3]">
              “{reporting.name}” will be hidden on this device right away and flagged for review.
            </div>
            {(['Sexual or adult content', 'Violence or abuse', 'Scam or spam', 'Other'] as const).map((reason) => (
              <button
                key={reason}
                onClick={() => {
                  void reportItem({ ...reporting, reason });
                  setReporting(null);
                  setPreview(null);
                  addSnackbar('Reported and hidden', 'success');
                }}
                className="rounded-xl bg-[#2b2f36] py-2.5 text-sm font-semibold text-white"
              >
                {reason}
              </button>
            ))}
            <button onClick={() => setReporting(null)} className="py-2 text-xs text-[#98A2B3]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MarketPage;
