import { useAvatarPlayback } from '../names/useAvatarPlayback';
import { setFeedLatest } from '../tabs/tabBadges';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent,
} from 'react';
import { readListCache, writeListCache } from '../ui/listCache';
import { FlipBavatar } from '../bavatar/FlipBavatar';
import { isPayAddress } from '../bavatar/flipQr';
import { useBackClose } from '../backStack';
import { NotificationsBell } from '../notify/NotificationsPanel';
import { askNotifyPermissionOnce } from '../notify/engine';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Ban,
  Bookmark,
  BookmarkCheck,
  Coins,
  ExternalLink,
  Flag,
  Heart,
  Link,
  Lock,
  LockOpen,
  Film,
  ImagePlus,
  Music,
  MessageCircle,
  MoreHorizontal,
  PenLine,
  Quote,
  Repeat2,
  UserCheck,
  UserPlus,
  VolumeX,
  WifiOff,
  X,
  ChevronDown,
  Check,
  Clock,
  Trophy,
  EyeOff,
  Plus,
  Star,
} from 'lucide-react';
import { inscribe } from '@1sat/actions';
import { SendConfirmation } from '../../components/SendConfirmation';
import { TopNav } from '../../components/TopNav';
import { useTheme } from '../../hooks/useTheme';
import { SegmentRow, SegmentTitle } from './ChatSegments';
import { useServiceContext } from '../../hooks/useServiceContext';
import { resolveImageUrl, useIdentity } from '../../hooks/useIdentity';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getErrorMessage } from '../../utils/tools';
import { openDappBrowser } from '../dappBrowser';
import { REMOTE_ACTIONS, actionLabel, postActions, type PostAction } from './sources';
import { fileToBase64, formatBytes, txFeeSats } from '../mint/mint';
import { PostMedia } from './FeedMedia';
import { FEED_APP, SOURCE_REGISTRY, migrateSourceId, textOn } from './sources';
import { kindOf, MAX_POST_IMAGES, planAv } from './media';
import { onSafetyChange, refreshSafety, reportItem, safety } from '../market/safety';
import { ReportSheet } from '../ugc/UgcSheets';
import {
  buildFollowScript,
  buildBranchScript,
  buildHideScript,
  buildLikeScript,
  buildPostScript,
  quoteText,
  estimatePostFee,
  avatarSeed,
  avatarUrl,
  feedTimeLabel,
  filterFeed,
  MAX_INLINE_IMAGE_BYTES,
  MAX_POST_CHARS,
  mergePosts,
  shortAddress,
  sourceLabel,
  sourceUrl,
  SOURCES,
  threadRoot,
  validatePost,
  type Author,
  type FeedPost,
  type PostImage,
  type Source,
} from './post';
import {
  authorDeps,
  fetchFollowing,
  fetchForYou,
  fetchLeaderboard,
  fetchPostLocks,
  fetchAncestors,
  fetchBmapPost,
  fetchTwetchPost,
  fetchThread,
  lockToPost,
  publish,
  PostCancelledError,
  setIdentitySetupHandler,
} from './feedApi';
import {
  BLOCKS_PER_DAY,
  formatLocked,
  LOCK_AMOUNTS,
  LOCK_DURATIONS,
  MAX_LOCK_BLOCKS,
  rankByLocked,
  summarizeLocks,
  unlockDate,
  type LockSummary,
  type PostLock,
} from './locks';
import { loadPrefs, initialFeed, savePrefs } from '../settings/prefs';
import {
  homeShareFor,
  payDestination,
  planPayment,
  TIP_MIN_SATS,
  TIP_PRESETS_SATS,
  TIP_PRESETS_USD,
  validateAmount,
  type PayKind,
} from './tip';
import { oneClick } from '../settings/oneClick';
import { isMe, rankPeople, rankPosts, TIMEFRAMES, cutoff, type LeaderboardData, type Timeframe } from './leaderboard';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';
import {
  addBlock,
  addLiked,
  addMyLock,
  addMute,
  blockKeys,
  isBookmarked,
  loadBlocks,
  loadBookmarks,
  rememberMuteName,
  type HiddenAccount,
  isFollowing,
  loadFollows,
  loadLiked,
  loadMyLocks,
  loadMutes,
  toggleFollow,
  visiblePosts,
  filterFavourites,
  isFavourite,
  loadFavourites,
  toggleFavourite,
  type Favourite,
  type Follow,
} from './store';
import { bookmarkClient, syncBookmarks, toggleSyncedBookmark } from './bookmarkSync';
import { PullToRefresh } from '../ui/PullToRefresh';
import { FILTER_NOTE, HIDDEN_NAME, isSlur, languageOf, languageView, nameView, safeName } from './language';
import { usePrefs } from '../settings/usePrefs';
import { languageOptsFor } from '../storeBuild';
import { VideoBackground } from '../ui/VideoBackground';
import feedBg from '../brand/bg/feed-waves.mp4';
import feedPoster from '../brand/bg/feed-waves.jpg';
import { fmtSats, fmtUsd, hasRate, money, moneyNow, satsNote, usdToSats, useBsvUsd } from '../money/money';
import { celebrateSend } from '../../components/sent/sent';
import {
  chosenDests,
  DEST_LABEL,
  destSummary,
  TIP_MESSAGE_MAX,
  tipDestinations,
  tipMailBody,
  toggleDest,
  validateTipMessage,
  willSendMessage,
  type TipDest,
} from './tipMessage';
import { resolvePaymail } from '../names/names';
import { bavatarSeedDataUri } from '../names/avatar';
import { sendMail } from '../bmail/client';
import type { WalletInterface } from '@bsv/sdk';
import { ErrorActions } from '../errors/ErrorActions';
import { NewsList, NewsThread } from './NewsThread';
import { loadNewsMode, saveNewsMode, type NewsItem } from './bnews';
import { AllFeedsSheet, FeedPicker } from './FeedPicker';
import { BrandFeed } from './BrandFeed';
import { rememberFeed, takeCrashFeed } from '../url/crashResume';
import { BradioFeed } from '../bradio/BradioFeed';
import { authorProfileUrl, authorRef, fetchAuthorPage, fetchAuthorProfile, type AuthorProfile } from './authorFeed';
import { FeaturedAlbum } from './FeaturedAlbum';
import {
  FEED_COLORS,
  feedColor,
  feedDef,
  hasCustomView,
  loadPins,
  migrateFeedId,
  savePins,
  stepFeed,
  swipeDir,
  togglePin,
  movePin,
  type FeedId,
} from './feeds';
import { BEX_REEL_ENABLED, BMOVIES_FEED_ENABLED, TOKENBLASTER_ENABLED } from '../storeBuild';

// bWalletX only: the store build has no bMovies reel, not even as code (storeBuild.ts).
const BmoviesReel = BMOVIES_FEED_ENABLED ? lazy(() => import('./bmovies/BmoviesReel')) : null;
// Feed › b3D: the Exchange's 3D listings with live models. bWalletX only (no 3D market in a store build).
const B3dFeed = TOKENBLASTER_ENABLED ? lazy(() => import('./B3dFeed')) : null;
const NewsVideos = BMOVIES_FEED_ENABLED ? lazy(() => import('./bmovies/NewsVideos')) : null;
// Feed › bApps (every build) and Feed › bExchange (bWalletX only: BEX_REEL_ENABLED drops the chunk from a store build).
const BappsReel = lazy(() => import('./reels/BappsReel'));
const BexReel = BEX_REEL_ENABLED ? lazy(() => import('./reels/BexReel')) : null;
/** Full-screen reels: a horizontal swipe doesn't change feed there and the Post button is hidden. */
const isReel = (f: FeedId) => f === 'bmovies' || f === 'bmusic' || f === 'bapps' || f === 'bexchange';

/**
 * Chat → Feed: a Twitter-style timeline over Bitcoin Schema posts (B + MAP + AIP), read from
 * the bmap API (feedApi.ts) and written by this wallet's BAP identity key. Following / For you,
 * compose (text + images, video, audio), like, reply, follow, tip, profile, report, mute.
 * Every post and media ref passes the market safety filter; syndicated images, video posters
 * and previews stay blurred until tapped.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const RED = '#F97066';
// AIP adds prefix + algorithm + address + 65-byte signature.
const AIP_BYTES = 140;

type Tab = 'following' | 'foryou';
const HOME_FILTERS: { id: Tab; label: string }[] = [
  { id: 'following', label: 'Following' },
  { id: 'foryou', label: 'For you' },
];
const SOURCE_KEY = 'bwallet.feed.source';
const loadSource = (): Source | 'all' => {
  try {
    const v = migrateSourceId(localStorage.getItem(SOURCE_KEY));
    // No saved choice → Twetch, the one source still live (owner, 6 Oct 2026: the bmap indexer behind
    // bChat and Treechat stopped in April). A choice the person made is kept.
    return SOURCES.some((s) => s.id === v) ? (v as Source | 'all') : v === 'all' ? 'all' : 'twetch';
  } catch {
    return 'twetch';
  }
};
const saveSource = (v: Source | 'all') => {
  try {
    localStorage.setItem(SOURCE_KEY, v);
  } catch {
    // storage unavailable
  }
};

/**
 * Source badge: the app's bundled logo (sources.ts registry) inline on the author row, between the
 * name and the time. Compact (14px logo + small-caps label) so it never crowds the post. Tappable
 * to open the original post where the source has a URL pattern.
 */
const Via = ({ post }: { post: FeedPost }) => {
  const info = SOURCE_REGISTRY[post.source] ?? SOURCE_REGISTRY.other;
  const label = sourceLabel(post.app) || info.label;
  const url = sourceUrl(post);
  const badge = (
    <>
      <img
        src={info.icon}
        alt=""
        width={14}
        height={14}
        className="h-[14px] w-[14px] shrink-0 rounded-full object-cover"
      />
      <span
        className="truncate max-w-[72px] text-[9px] font-semibold uppercase leading-none tracking-wide"
        style={{ color: MUTED }}
      >
        {label}
      </span>
    </>
  );
  const cls = 'flex min-w-0 shrink items-center gap-1 self-center';
  if (!url)
    return (
      <span className={cls} title={label} aria-label={`From ${label}`}>
        {badge}
      </span>
    );
  return (
    <button
      className={cls}
      aria-label={`View on ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        void openDappBrowser(url);
      }}
    >
      {badge}
    </button>
  );
};

/** Selected source chip colour: the source's brand colour ("All" is gold). */
const chipColor = (id: Source | 'all') => (id === 'all' ? GOLD : (SOURCE_REGISTRY[id].color ?? GOLD));
const chipOff = { background: PANEL, color: MUTED, border: `1px solid ${LINE}` };

type FeedSort = 'latest' | 'popular' | 'locked';

const SORT_OPTIONS: { id: FeedSort; label: string; hint: string; icon: ReactNode }[] = [
  { id: 'latest', label: 'Latest', hint: 'Newest posts first', icon: <Clock size={16} /> },
  { id: 'popular', label: 'Most popular', hint: 'Most likes and replies', icon: <Heart size={16} /> },
  { id: 'locked', label: 'Most locked', hint: 'Ranked by BSV locked behind them', icon: <Lock size={16} /> },
];

/** Feed sort: a gold pill left of the source chips that opens a small styled popover. */
const SortMenu = ({ sort, onChange, on = true }: { sort: FeedSort; onChange: (s: FeedSort) => void; on?: boolean }) => {
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useBackClose(!!at, () => setAt(null));
  const current = SORT_OPTIONS.find((o) => o.id === sort) ?? SORT_OPTIONS[0];
  const open = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(12, r.left), top: r.bottom + 8 });
  };
  return (
    <>
      <button
        ref={btn}
        onClick={open}
        aria-haspopup="menu"
        aria-expanded={!!at}
        aria-label={`Sort: ${current.label}`}
        className="bw-feed-sort flex w-full min-w-0 items-center justify-center gap-1 rounded-full px-1.5 py-1 text-[12px] font-semibold"
        style={
          on
            ? { background: '#1a1408', color: GOLD, border: `1px solid ${GOLD}` }
            : { background: PANEL, color: MUTED, border: `1px solid ${LINE}` }
        }
      >
        {sort === 'locked' && <Lock size={12} className="shrink-0" />}
        <span className="truncate">{current.label}</span>
        <ChevronDown
          size={12}
          className="shrink-0"
          style={{ transform: at ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }}
        />
      </button>
      {at &&
        createPortal(
          <div className="fixed inset-0 z-[200]" onClick={() => setAt(null)}>
            <div
              role="menu"
              className="absolute w-64 overflow-hidden rounded-2xl p-1.5 shadow-2xl"
              style={{ left: at.left, top: at.top, background: '#121317', border: `1px solid ${LINE}` }}
              onClick={(e) => e.stopPropagation()}
            >
              {SORT_OPTIONS.map((o) => {
                const on = o.id === sort;
                return (
                  <button
                    key={o.id}
                    role="menuitemradio"
                    aria-checked={on}
                    onClick={() => {
                      onChange(o.id);
                      setAt(null);
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left"
                    style={{ background: on ? '#1a1408' : 'transparent' }}
                  >
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                      style={{ background: on ? GOLD : PANEL, color: on ? '#1a1300' : MUTED }}
                    >
                      {o.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold" style={{ color: on ? GOLD : '#F2F2F0' }}>
                        {o.label}
                      </span>
                      <span className="block text-[11px]" style={{ color: MUTED }}>
                        {o.hint}
                      </span>
                    </span>
                    {on && <Check size={16} color={GOLD} />}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

const useOnline = () => {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
};

const Avatar = ({
  author,
  size = 40,
  source,
  place = 'list',
}: {
  author: Pick<Author, 'name' | 'avatar' | 'address'> & { bapId?: string | null };
  size?: number;
  place?: 'full' | 'list';
  source?: Source;
}) => {
  const [broken, setBroken] = useState(false);
  // Treechat exposes no avatar (not on chain, not in the overlay): its authors get a gold bAvatar
  // seeded by username, with a Treechat-purple ring. Never a bare letter.
  const ring =
    source === 'treechat' || source === 'coingeek' ? `2px solid ${SOURCE_REGISTRY[source].color}` : `1px solid ${LINE}`;
  // CoinGeek posts wear CoinGeek's official CG logo (bundled; owner, 25 Oct 2026). avatarUrl would read a
  // bundled /assets path as a Treechat one, so it is used as is.
  const photo = source === 'coingeek' ? SOURCE_REGISTRY.coingeek.icon : avatarUrl(author.avatar);
  // Feeds: a still first frame of an animated picture, played on press/hover (names/animatedAvatar.ts).
  const play = useAvatarPlayback(photo, place);
  const real = photo && !broken;
  const src = real ? play.src : bavatarSeedDataUri(avatarSeed({ bapId: null, ...author }, source));
  return (
    <img
      {...(real ? play.handlers : {})}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="rounded-full object-cover shrink-0"
      style={{ width: size, height: size, border: ring, background: '#16181c' }}
    />
  );
};

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl p-4 pb-10 max-h-[85vh] overflow-y-auto"
        style={{ background: '#0b0c0e', borderTop: `1px solid ${LINE}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={18} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

/** Full-screen layer inside the tab (profile, thread). */
const Layer = ({
  title,
  onBack,
  onRefresh,
  children,
}: {
  title: string;
  onBack: () => void;
  onRefresh?: () => unknown;
  children: ReactNode;
}) => {
  useBackClose(true, onBack);
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <button onClick={onBack} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white truncate">{title}</span>
      </div>
      <div className="flex-1 overflow-y-auto bw-dock-pad">
        {onRefresh && <PullToRefresh onRefresh={onRefresh} />}
        {children}
      </div>
    </div>,
    document.body,
  );
};

type PostActions = {
  liked: Set<string>;
  onLike: (p: FeedPost) => void;
  onReply: (p: FeedPost) => void;
  onTip: (p: FeedPost) => void;
  locks: Record<string, LockSummary | undefined>;
  onLock: (p: FeedPost) => void;
  onOpen: (p: FeedPost) => void;
  onAuthor: (a: Author) => void;
  onMore: (p: FeedPost) => void;
  /** Saved to this phone's Bookmarks list (store.ts); separate from Twetch's own bookmarks under "…". */
  bookmarked: (txid: string) => boolean;
  onBookmark: (p: FeedPost) => void;
  /** Branch, quote, copy link, open / bookmark / unlock in the source app. */
  onAction: (p: FeedPost, action: PostAction) => void;
};

const ACTION_ICONS: Partial<Record<PostAction, typeof Heart>> = {
  branch: Repeat2,
  quote: Quote,
  copyLink: Link,
  open: ExternalLink,
  bookmark: Bookmark,
  unlock: LockOpen,
  report: Flag,
  mute: VolumeX,
};

/**
 * An author's display name. A name with a slur is blurred until tapped in bWalletX, and reads
 * "Hidden name" in the store edition (feed/language.ts nameView). Plain-text uses keep safeName.
 */
const AuthorName = ({ name, className }: { name: string; className: string }) => {
  const [shown, setShown] = useState(false);
  const v = nameView(name, { store: languageOptsFor({ filterStrong: false }).store });
  if (v === 'hidden') return <span className={className}>{HIDDEN_NAME}</span>;
  if (v === 'show' || shown) return <span className={className}>{name}</span>;
  return (
    // A span, not a <button>: names sit inside row buttons (search, who to follow).
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        setShown(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          setShown(true);
        }
      }}
      aria-label="Name blurred: offensive language. Tap to show."
      className={`${className} select-none blur-sm`}
    >
      {name}
    </span>
  );
};

/** "Why hidden? / Why blurred?": what the filter does, and that nothing is deleted. */
const WhyFiltered = ({ hidden }: { hidden: boolean }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 text-[12px]" style={{ color: MUTED }} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="underline">
        {hidden ? 'Why hidden?' : 'Why blurred?'}
      </button>
      {open && (
        <p className="mt-1">
          {hidden
            ? 'This post contains slurs or offensive language, which this edition hides. '
            : 'This post contains language your Feed settings blur (Settings › Feed). '}
          {FILTER_NOTE}
        </p>
      )}
    </div>
  );
};

/** The "Show anyway" veil over blurred language. */
const ShowAnyway = ({ onShow, label = 'Strong language' }: { onShow: () => void; label?: string }) => (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onShow();
    }}
    className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-lg text-[12px] text-white"
    style={{ background: 'rgba(0,0,0,0.4)' }}
  >
    <span className="font-bold">{label}</span>
    <span className="underline">Show anyway</span>
  </button>
);

/**
 * Bad language (feed/language.ts): in bWalletX a slur post is blurred behind a per-post "Show
 * anyway" (filters only change what you see; nothing is deleted); in the store edition it
 * collapses to "Post hidden: offensive language" with no reveal. Swearing is blurred per post in
 * the store edition, or in bWalletX with "Filter strong language" on.
 */
const PostCard = ({ post, a }: { post: FeedPost; a: PostActions }) => {
  const [prefs] = usePrefs();
  const lang = post.language !== undefined ? post.language : languageOf(post.text);
  const view = languageView(lang, languageOptsFor(prefs));
  if (view === 'hide-final')
    return (
      <div role="note" className="px-4 py-3 text-[13px]" style={{ borderBottom: `1px solid ${LINE}`, color: MUTED }}>
        <span>Post hidden: offensive language</span>
        <WhyFiltered hidden />
      </div>
    );
  return (
    <PostCardBody
      post={post}
      a={a}
      blurText={view === 'blur'}
      blurLabel={lang === 'slur' ? 'Offensive language' : 'Strong language'}
    />
  );
};

const PostCardBody = ({
  post,
  a,
  blurText,
  blurLabel,
}: {
  post: FeedPost;
  a: PostActions;
  blurText: boolean;
  blurLabel: string;
}) => {
  const [textShown, setTextShown] = useState(false);
  const veiled = blurText && !textShown;
  const liked = a.liked.has(post.txid);
  const locked = a.locks[post.txid];
  return (
    <article
      className="flex gap-3 px-4 py-3"
      // Off-screen cards skip layout / paint, which keeps long scrolls light.
      style={{ borderBottom: `1px solid ${LINE}` }}
      onClick={() => a.onOpen(post)}
    >
      <button
        className="self-start shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          a.onAuthor(post.author);
        }}
        aria-label={`${safeName(post.author.name)} profile`}
      >
        <Avatar author={post.author} source={post.source} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <AuthorName name={post.author.name} className="text-[14px] font-bold text-white truncate" />
          <Via post={post} />
          <span className="text-[12px] shrink-0 whitespace-nowrap" style={{ color: MUTED }}>
            · {feedTimeLabel(post.at)}
          </span>
          <button
            className="ml-auto p-1 -mr-1"
            aria-label="More"
            onClick={(e) => {
              e.stopPropagation();
              a.onMore(post);
            }}
          >
            <MoreHorizontal size={16} color={MUTED} />
          </button>
        </div>
        {post.replyTo && (
          <div className="text-[11px]" style={{ color: MUTED }}>
            Replying to a post
          </div>
        )}
        {post.text && (
          <div className="relative">
            {veiled && <ShowAnyway onShow={() => setTextShown(true)} label={blurLabel} />}
            <p
              aria-hidden={veiled}
              className={`text-[14px] text-white whitespace-pre-wrap break-words mt-[2px] ${veiled ? 'select-none blur-sm' : ''}`}
            >
              {post.text}
            </p>
            {veiled && <WhyFiltered hidden={false} />}
          </div>
        )}
        <PostMedia media={post.media ?? []} links={post.links ?? []} blur={post.source !== 'bchat'} />
        <div className="flex items-center gap-5 mt-2" onClick={(e) => e.stopPropagation()}>
          {postActions(post).row.map((act) => {
            const cls = 'flex items-center gap-1 text-[12px]';
            if (act === 'reply')
              return (
                <button
                  key={act}
                  onClick={() => a.onReply(post)}
                  className={cls}
                  style={{ color: MUTED }}
                  aria-label="Reply"
                >
                  <MessageCircle size={16} /> {post.replies || ''}
                </button>
              );
            if (act === 'like')
              return (
                <button
                  key={act}
                  onClick={() => !liked && a.onLike(post)}
                  className={cls}
                  style={{ color: liked ? GOLD : MUTED }}
                  aria-label="Like"
                >
                  <Heart size={16} fill={liked ? GOLD : 'none'} /> {post.likes + (liked ? 1 : 0) || ''}
                </button>
              );
            if (act === 'tip')
              return (
                <button
                  key={act}
                  onClick={() => a.onTip(post)}
                  className={cls}
                  style={{ color: post.tipped ? GOLD : MUTED, opacity: payDestination(post).ok ? 1 : 0.4 }}
                  aria-label="Tip"
                  title={payDestination(post).ok ? undefined : 'Tips unavailable on Treechat posts'}
                >
                  <Coins size={16} /> {post.tipped ? moneyNow(post.tipped) : 'Tip'}
                </button>
              );
            if (act === 'lock')
              return (
                <button
                  key={act}
                  onClick={() => a.onLock(post)}
                  className={cls}
                  style={{ color: locked?.total ? GOLD : MUTED }}
                  aria-label="Lock BSV to back this post"
                >
                  <Lock size={16} /> {locked?.total ? '' : 'Lock'}
                </button>
              );
            const Icon = ACTION_ICONS[act] ?? MoreHorizontal;
            return (
              <button
                key={act}
                onClick={() => a.onAction(post, act)}
                className={cls}
                style={{ color: MUTED }}
                aria-label={actionLabel(act, post.source)}
              >
                <Icon size={16} />
              </button>
            );
          })}
          <button
            onClick={() => a.onBookmark(post)}
            className="ml-auto flex items-center"
            style={{ color: a.bookmarked(post.txid) ? GOLD : MUTED }}
            aria-label={a.bookmarked(post.txid) ? 'Remove bookmark' : 'Bookmark'}
            aria-pressed={a.bookmarked(post.txid)}
          >
            <Bookmark size={16} fill={a.bookmarked(post.txid) ? GOLD : 'none'} />
          </button>
        </div>
        {!!locked?.total && (
          <div className="mt-1 flex items-center gap-1 text-[11px]" style={{ color: GOLD }}>
            <Lock size={11} /> {formatLocked(locked.total)} locked
            <span style={{ color: MUTED }}>
              · {locked.lockers} {locked.lockers === 1 ? 'locker' : 'lockers'}
            </span>
          </div>
        )}
      </div>
    </article>
  );
};

const PostList = ({ posts, a, empty }: { posts: FeedPost[] | null; a: PostActions; empty: ReactNode }) => {
  if (posts === null)
    return (
      <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
        Loading…
      </div>
    );
  if (!posts.length) return <>{empty}</>;
  return (
    <div>
      {posts.map((p) => (
        <PostCard key={p.txid} post={p} a={a} />
      ))}
    </div>
  );
};

// ── composer ──────────────────────────────────────────────────────────────────

const shrinkImage = async (file: File | Blob, limit = MAX_INLINE_IMAGE_BYTES, edges = [1280, 1024, 800, 640]) => {
  const bmp = await createImageBitmap(file);
  try {
    for (const edge of edges) {
      for (const q of [0.82, 0.7, 0.6]) {
        const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * scale);
        canvas.height = Math.round(bmp.height * scale);
        canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
        if (blob && blob.size <= limit) return blob;
      }
    }
  } finally {
    bmp.close();
  }
  throw new Error('That image is too large to post, even after shrinking.');
};

const toPart = async (blob: Blob, mime: string, filename: string): Promise<PostImage> => ({
  bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
  mime,
  filename,
});

/** A small JPEG of a video's first second, posted inline as the poster (filename poster.jpg). */
const videoPoster = (file: File): Promise<PostImage | null> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (r: PostImage | null) => {
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      v.load();
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 8000);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onloadeddata = () => {
      v.currentTime = Math.min(1, (v.duration || 0) / 2);
    };
    v.onseeked = async () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight, 1));
        canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
        canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.6));
        done(blob && blob.size <= 60 * 1024 ? await toPart(blob, 'image/jpeg', 'poster.jpg') : null);
      } catch {
        done(null);
      }
    };
    v.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    v.src = url;
  });

type Attachment = {
  id: number;
  kind: 'image' | 'video' | 'audio';
  preview: string;
  name: string;
  bytes: number;
  mime: string;
  /** Inline B part (images, small AV). */
  part?: PostImage;
  /** Large AV: inscribed as a 1Sat ordinal before the post. */
  file?: File;
  poster?: PostImage | null;
};

let attachSeq = 0;

const Composer = ({
  replyTo,
  quote = null,
  link = null,
  onClose,
  onPosted,
}: {
  replyTo: FeedPost | null;
  /** Post being quoted: the new post names it (MAP quote) and links it. */
  quote?: FeedPost | null;
  /** bNews story being discussed: the post links it, so it shows in the story's thread. */
  link?: { url: string; title: string } | null;
  onClose: () => void;
  onPosted: (txid: string) => void;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const [text, setText] = useState('');
  const [items, setItems] = useState<Attachment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  const inscribed = items.filter((i) => i.file);
  // Fee preview: the post itself, with placeholder outpoints for media still to be inscribed.
  const input = {
    text: quote
      ? quoteText(text, sourceUrl(quote) ?? `https://whatsonchain.com/tx/${quote.txid}`)
      : link
        ? quoteText(text, link.url)
        : text,
    quote: quote?.txid ?? null,
    media: items.flatMap((i) => [...(i.part ? [i.part] : []), ...(i.poster ? [i.poster] : [])]),
    refs: inscribed.map((i) => ({ outpoint: `${'0'.repeat(64)}_0`, mime: i.mime })),
    replyTo: replyTo ? threadRoot(replyTo) : null,
    threadId: replyTo?.source === 'treechat' ? replyTo.threadId : null,
  };
  const invalid = validatePost(input);
  const rate = chromeStorageService.getCustomFeeRate();
  const fee = useMemo(() => {
    if (invalid) return null;
    try {
      const post = estimatePostFee(buildPostScript(input).toBinary().length + AIP_BYTES, rate);
      return post + inscribed.reduce((n, i) => n + txFeeSats(i.bytes, rate), 0);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, items, invalid, rate]);

  const add = async (file: File) => {
    const kind = kindOf(file.type);
    const preview = URL.createObjectURL(file);
    const base = { id: ++attachSeq, preview, name: file.name || kind || 'file', mime: file.type.toLowerCase() };
    try {
      if (/^image\//i.test(file.type)) {
        if (items.filter((i) => i.kind === 'image').length >= MAX_POST_IMAGES)
          throw new Error(`Up to ${MAX_POST_IMAGES} images per post.`);
        const blob = await shrinkImage(file);
        const part = await toPart(blob, 'image/jpeg', `image${items.length + 1}.jpg`);
        return { ...base, kind: 'image' as const, mime: 'image/jpeg', bytes: blob.size, part };
      }
      const plan = planAv(file.size, file.type);
      if (plan.mode === 'reject') throw new Error(plan.message);
      const av = kind as 'video' | 'audio';
      const poster = av === 'video' ? await videoPoster(file) : null;
      if (plan.mode === 'inline')
        return { ...base, kind: av, bytes: file.size, part: await toPart(file, base.mime, file.name || av), poster };
      return { ...base, kind: av, bytes: file.size, file, poster };
    } catch (e) {
      URL.revokeObjectURL(preview);
      throw e;
    }
  };

  const pick = async (files?: FileList | null) => {
    setError('');
    for (const f of Array.from(files ?? [])) {
      try {
        const a = await add(f);
        setItems((list) => [...list, a]);
      } catch (e) {
        setError(getErrorMessage(e instanceof Error ? e.message : String(e)));
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const remove = (id: number) =>
    setItems((list) => {
      const gone = list.find((i) => i.id === id);
      if (gone) URL.revokeObjectURL(gone.preview);
      return list.filter((i) => i.id !== id);
    });

  const send = async () => {
    setError('');
    if (invalid) return setError(invalid);
    if (safety().check({ texts: [text, ...items.map((i) => i.name)] }).blocked)
      return setError("This can't be posted from bWallet.");
    try {
      // 1. Large video / audio → 1Sat ordinals (one wallet approval each), through the Mint inscribe path.
      const refs: { outpoint: string; mime: string }[] = [];
      for (const [n, i] of inscribed.entries()) {
        setBusy(`Inscribing ${i.kind} ${n + 1}/${inscribed.length}…`);
        const res = await inscribe.execute(apiContext, {
          base64Content: fileToBase64(await i.file!.arrayBuffer()),
          contentType: i.mime,
          map: { app: FEED_APP, type: 'ord', name: i.name.slice(0, 100), context: 'feed' },
        });
        if (!res.txid || res.error) throw new Error(res.error || 'Inscribing the media failed');
        refs.push({ outpoint: `${res.txid}_0`, mime: i.mime });
      }
      // 2. The post: text, inline parts, and the ordinals by outpoint.
      setBusy('Posting…');
      const tags = [
        'app:bWallet',
        'type:post',
        ...(input.quote ? [`quote:${input.quote}`] : []),
        ...(input.replyTo ? [`context:tx`, `contextValue:${input.replyTo}`] : []),
      ];
      const txid = await publish(
        apiContext,
        buildPostScript({ ...input, refs }),
        replyTo ? 'Feed reply' : quote ? 'Feed quote' : 'Feed post',
        tags,
      );
      onPosted(txid);
    } catch (e) {
      if (e instanceof PostCancelledError) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <Sheet
      title={
        replyTo
          ? `Reply to ${safeName(replyTo.author.name)}`
          : quote
            ? `Quote ${safeName(quote.author.name)}`
            : link
              ? 'Discuss'
              : 'New post'
      }
      onClose={onClose}
    >
      {link && !replyTo && !quote && (
        <p className="text-xs mb-2 line-clamp-2" style={{ color: MUTED }}>
          {link.title}
        </p>
      )}
      {(replyTo ?? quote) && (
        <p className="text-xs mb-2 line-clamp-2" style={{ color: MUTED }}>
          {(replyTo ?? quote)!.text}
        </p>
      )}
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={replyTo ? 'Post your reply' : quote || link ? 'Add a comment' : "What's happening on-chain?"}
        rows={5}
        className="w-full rounded-2xl p-3 text-[15px] text-white outline-none resize-none"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
      />
      {items.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {items.map((i) => (
            <div
              key={i.id}
              className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl"
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            >
              {i.kind === 'image' ? (
                <img src={i.preview} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-center">
                  {i.kind === 'video' ? <Film size={20} color={GOLD} /> : <Music size={20} color={GOLD} />}
                  <span className="text-[10px] text-white">{formatBytes(i.bytes)}</span>
                  <span className="text-[9px]" style={{ color: MUTED }}>
                    {i.file ? '1Sat ordinal' : 'inline'}
                  </span>
                </div>
              )}
              <button
                onClick={() => remove(i.id)}
                className="absolute top-1 right-1 rounded-full p-[2px]"
                style={{ background: 'rgba(0,0,0,0.7)' }}
                aria-label="Remove attachment"
              >
                <X size={14} color="white" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between mt-3">
        <button
          onClick={() => fileRef.current?.click()}
          className="p-2 rounded-full"
          aria-label="Add photos, video or audio"
        >
          <ImagePlus size={20} color={GOLD} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,video/mp4,video/webm,video/quicktime,audio/*"
          className="hidden"
          onChange={(e) => void pick(e.target.files)}
        />
        <span className="text-[11px]" style={{ color: text.length > MAX_POST_CHARS ? RED : MUTED }}>
          {text.length}/{MAX_POST_CHARS}
          {fee != null ? ` · fee ≈ ${moneyNow(fee)}` : ''}
        </span>
      </div>
      <p className="text-[11px] mt-1" style={{ color: MUTED }}>
        Posts are permanent and public on the BSV chain, signed by your posting profile.
        {inscribed.length > 0 &&
          ` Large video / audio is inscribed first as a 1Sat ordinal you own (${inscribed.length + 1} approvals).`}
      </p>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs mt-2" style={{ color: RED }}>
            {error}
          </p>
          <ErrorActions message={String(error)} />
        </div>
      )}
      <button
        onClick={() => void send()}
        disabled={!!busy || !!invalid}
        className="mt-3 w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-40"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {busy || (replyTo ? 'Reply' : quote ? 'Quote' : link ? 'Post to thread' : 'Post')}
      </button>
    </Sheet>
  );
};

type ApiCtx = ReturnType<typeof useServiceContext>['apiContext'];
/**
 * Tip or paid like (BCHAT-PROTOCOL-v2 §5): MAP `type tip` / `type like … paid 1`, signed by the
 * posting identity, and the payment to the author in the SAME transaction. planPayment refuses
 * Treechat (shared relay signer) and anything without a payable author address.
 */
const sendPayment = async (
  apiContext: ApiCtx,
  post: FeedPost,
  sats: number,
  kind: PayKind = 'tip',
): Promise<string> => {
  const plan = planPayment(kind, post, sats);
  return publish(
    apiContext,
    plan.script,
    kind === 'tip' ? 'bChat tip' : 'bChat paid like',
    ['app:bWallet', `type:${kind}`, `tx:${post.txid}`],
    plan.payment,
  );
};

/** Tip presets in sats: $0.05 / $0.25 / $1 at today's rate (never under dust), sats when unknown. */
const tipPresets = (rate: number) =>
  TIP_PRESETS_USD.map((u, i) => Math.max(TIP_MIN_SATS, usdToSats(u, rate) ?? TIP_PRESETS_SATS[i]));

const TipSheet = ({
  post,
  onClose,
  onLiked,
}: {
  post: FeedPost;
  onClose: () => void;
  onLiked: (p: FeedPost) => void;
}) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const rate = useBsvUsd();
  const presets = tipPresets(rate);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // USD-first: the custom amount is typed in dollars when the rate is known (sent as sats).
  const [usdText, setUsdText] = useState('');
  const dest = payDestination(post);
  const sats = picked ?? presets[1];
  const likeSats = loadPrefs().paidLikeSats;
  // Optional message with the tip, and where it goes (tipMessage.ts).
  const [message, setMessage] = useState('');
  const [dests, setDests] = useState(() => tipDestinations(post));
  const msgError = validateTipMessage(message);
  const sendingMessage = willSendMessage(message, dests);
  /** Deliver the message after the tip landed. Returns what failed (the tip itself already went). */
  const deliverMessage = async (tipLabel: string): Promise<string[]> => {
    const failed: string[] = [];
    const text = message.trim();
    for (const k of chosenDests(dests)) {
      try {
        if (k === 'reply') {
          await publish(
            apiContext,
            buildPostScript({
              text,
              replyTo: post.txid,
              threadId: post.source === 'treechat' ? post.threadId : null,
            }),
            'Feed reply',
            ['app:bWallet', 'type:post', 'context:tx', `contextValue:${post.txid}`],
          );
        } else {
          const r = await resolvePaymail(fetch.bind(globalThis), post.author.paymail!);
          if (!r.pubkey) throw new Error('no key');
          await sendMail(apiContext.wallet as unknown as WalletInterface, {
            to: r.pubkey,
            toLabel: post.author.paymail!,
            sealed: tipMailBody(text, tipLabel, post.txid),
            sats: 0,
            replyPaidSats: 0,
          });
        }
      } catch (e) {
        if (e instanceof PostCancelledError) failed.push(`${DEST_LABEL[k]} (cancelled)`);
        else failed.push(DEST_LABEL[k]);
      }
    }
    return failed;
  };
  const pay = async (kind: PayKind, n: number) => {
    const bad = validateAmount(n);
    if (bad) return setError(bad);
    if (kind === 'tip' && msgError) return setError(msgError);
    setBusy(true);
    setError('');
    try {
      const txid = await sendPayment(apiContext, post, n, kind);
      if (kind === 'tip' && sendingMessage) {
        const failed = await deliverMessage(money(n, rate));
        if (failed.length) addSnackbar(`Tip sent. Your message did not reach: ${failed.join(', ')}`, 'info');
      }
      const shown = celebrateSend(txid, {
        amount: { kind: 'bsv', sats: n },
        recipients: [safeName(post.author.name)],
        rate,
        title: kind === 'tip' ? 'Tipped!' : 'Liked and paid!',
      });
      if (kind === 'tip') {
        // The next one-click tip (Settings → Payments) sends this amount, if it is within the limit.
        savePrefs({ quickTip: n });
        if (!shown) addSnackbar(`Tipped ${safeName(post.author.name)} ${money(n, rate)}`, 'success');
      } else {
        onLiked(post);
        if (!shown) addSnackbar(`Liked and paid ${safeName(post.author.name)} ${money(n, rate)}`, 'success');
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!dest.ok)
    return (
      <Sheet title={`Tip ${safeName(post.author.name)}`} onClose={onClose}>
        <p className="text-sm" style={{ color: MUTED }}>
          Tips are not available on this post. {dest.reason}
        </p>
      </Sheet>
    );
  return (
    <Sheet title={`Tip ${safeName(post.author.name)}`} onClose={onClose}>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        Sent in BSV to{' '}
        {post.source === 'twetch' ? "the author's Twetch signing key" : 'the address that signed this post'} (
        {shortAddress(dest.address)}), in the same transaction as the tip. No bChat fee.
      </p>
      <div className="flex gap-2">
        {presets.map((v) => (
          <button
            key={v}
            onClick={() => {
              setPicked(v);
              setUsdText('');
            }}
            className="flex-1 rounded-xl py-2 text-sm font-bold"
            style={
              v === sats
                ? { background: GOLD, color: '#1a1300' }
                : { background: PANEL, color: 'white', border: `1px solid ${LINE}` }
            }
          >
            {money(v, rate)}
          </button>
        ))}
      </div>
      {hasRate(rate) ? (
        <input
          inputMode="decimal"
          placeholder={`Other amount, e.g. ${fmtUsd(0.1)}`}
          value={usdText}
          onChange={(e) => {
            const v = e.target.value.replace(/^\$/, '');
            if (!/^\d*(\.\d{0,2})?$/.test(v)) return;
            setUsdText(v);
            const n = usdToSats(Number(v), rate);
            if (n) setPicked(n);
          }}
          className="mt-2 w-full rounded-xl px-3 py-2 text-sm text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
          aria-label="Amount in US dollars"
        />
      ) : (
        <input
          type="number"
          inputMode="numeric"
          min={TIP_MIN_SATS}
          value={sats}
          onChange={(e) => setPicked(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
          className="mt-2 w-full rounded-xl px-3 py-2 text-sm text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
          aria-label="Satoshis"
        />
      )}
      <p className="text-[11px] mt-1" style={{ color: MUTED }}>
        {satsNote(sats, rate) || `Minimum ${fmtSats(TIP_MIN_SATS)}`}
      </p>
      {(() => {
        // Spec §6.2: the post's home app gets 5% on top, as its own output, when it has published an address.
        const home = homeShareFor(post.source, sats);
        return home ? (
          <p className="text-[11px] mt-1" style={{ color: MUTED }}>
            {home.app} gets {money(home.satoshis, rate)} on top, for hosting this post. The author still gets the full
            amount.
          </p>
        ) : null;
      })()}
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Say something (optional)"
        rows={2}
        maxLength={TIP_MESSAGE_MAX + 20}
        className="mt-3 w-full rounded-xl px-3 py-2 text-sm text-white outline-none resize-none"
        style={{ background: PANEL, border: `1px solid ${msgError ? RED : LINE}` }}
        aria-label="Message with your tip"
      />
      <div className="flex items-center justify-between text-[11px]" style={{ color: msgError ? RED : MUTED }}>
        <span>{msgError ?? ''}</span>
        <span>
          {[...message.trim()].length}/{TIP_MESSAGE_MAX}
        </span>
      </div>
      {message.trim() && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {(['reply', 'bmail', 'note'] as TipDest[])
            .filter((k) => dests[k].available)
            .map((k) => (
              <button
                key={k}
                onClick={() => setDests((d) => toggleDest(d, k))}
                className="rounded-full px-3 py-1 text-[11px] font-bold"
                style={
                  dests[k].on
                    ? { background: GOLD, color: '#1a1300' }
                    : { background: PANEL, color: 'white', border: `1px solid ${LINE}` }
                }
                aria-pressed={dests[k].on}
              >
                {DEST_LABEL[k]}
              </button>
            ))}
        </div>
      )}
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs mt-2" style={{ color: RED }}>
            {error}
          </p>
          <ErrorActions message={String(error)} />
        </div>
      )}
      <div className="mt-3 rounded-xl px-3 py-2 text-xs" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
        <div className="font-bold text-white">Tip {money(sats, rate)}</div>
        {sendingMessage ? (
          <>
            <div className="mt-1 text-white break-words">“{message.trim()}”</div>
            <div className="mt-1" style={{ color: MUTED }}>
              {destSummary(dests)}
              {dests.reply.on ? ' · the reply is public, on chain, in its own transaction' : ''}
            </div>
          </>
        ) : (
          message.trim() &&
          !msgError && (
            <div className="mt-1" style={{ color: MUTED }}>
              No destination picked: only the tip is sent.
            </div>
          )
        )}
      </div>
      <button
        onClick={() => void pay('tip', sats)}
        disabled={busy || !!msgError}
        className="mt-3 w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-40"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {busy ? 'Sending…' : sendingMessage ? `Tip ${money(sats, rate)} + message` : `Tip ${money(sats, rate)}`}
      </button>
      <button
        onClick={() => void pay('like', likeSats)}
        disabled={busy}
        className="mt-2 w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-40 flex items-center justify-center gap-2"
        style={{ background: PANEL, color: 'white', border: `1px solid ${LINE}` }}
      >
        <Heart size={16} fill={GOLD} color={GOLD} /> Paid like · {money(likeSats, rate)}
        {hasRate(rate) ? ` (${fmtSats(likeSats)})` : ''}
      </button>
      <p className="text-[11px] mt-1 text-center" style={{ color: MUTED }}>
        Paid like amount: Settings → Payments
      </p>
    </Sheet>
  );
};

const LockSheet = ({
  post,
  height,
  onClose,
  onLocked,
}: {
  post: FeedPost;
  height: number | null;
  onClose: () => void;
  onLocked: (l: PostLock) => void;
}) => {
  const { apiContext } = useServiceContext();
  const { theme } = useTheme();
  const { addSnackbar } = useSnackbar();
  const [sats, setSats] = useState<number>(LOCK_AMOUNTS[0]);
  const [blocks, setBlocks] = useState<number>(LOCK_DURATIONS[1].blocks);
  const [custom, setCustom] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useBackClose(confirming, () => setConfirming(false));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const date = unlockDate(blocks).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const valid = sats >= 1 && blocks >= 1 && blocks <= MAX_LOCK_BLOCKS && !!height;
  const lock = async () => {
    setBusy(true);
    setError('');
    try {
      // Re-read the tip so the lock runs `blocks` from now, not from when the sheet opened.
      const tip = (await apiContext.services?.chaintracks.currentHeight()) ?? height;
      if (!tip) throw new Error('Could not read the current block height. Try again.');
      const l = await lockToPost(apiContext, { postTxid: post.txid, satoshis: sats, until: tip + blocks });
      addSnackbar(`Locked ${formatLocked(sats)} until ${date}`, 'success');
      onLocked(l);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  const pill = (on: boolean) =>
    on ? { background: GOLD, color: '#1a1300' } : { background: PANEL, color: 'white', border: `1px solid ${LINE}` };
  return (
    <Sheet title="Lock BSV to back this post" onClose={onClose}>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        Back <AuthorName name={post.author.name} className="" />
        's post with your own coins. Nothing is sent to anyone: the BSV is locked in your wallet, and the post shows how
        much is locked behind it.
      </p>
      <p className="text-[12px] font-semibold text-white mb-1">Amount</p>
      <div className="flex gap-2">
        {LOCK_AMOUNTS.map((v) => (
          <button
            key={v}
            onClick={() => setSats(v)}
            className="flex-1 rounded-xl py-2 text-sm font-bold"
            style={pill(v === sats)}
          >
            {formatLocked(v)}
          </button>
        ))}
      </div>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.001"
        value={sats / 1e8}
        onChange={(e) => setSats(Math.max(0, Math.round((Number(e.target.value) || 0) * 1e8)))}
        className="mt-2 w-full rounded-xl px-3 py-2 text-sm text-white outline-none"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
        aria-label="Amount in BSV"
      />
      <p className="text-[12px] font-semibold text-white mt-3 mb-1">Lock for</p>
      <div className="flex gap-2">
        {LOCK_DURATIONS.map((d) => (
          <button
            key={d.label}
            onClick={() => {
              setCustom(false);
              setBlocks(d.blocks);
            }}
            className="flex-1 rounded-xl py-2 text-[13px] font-bold"
            style={pill(!custom && d.blocks === blocks)}
          >
            {d.label}
          </button>
        ))}
        <button
          onClick={() => setCustom(true)}
          className="flex-1 rounded-xl py-2 text-[13px] font-bold"
          style={pill(custom)}
        >
          Custom
        </button>
      </div>
      {custom && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_LOCK_BLOCKS}
            value={blocks}
            onChange={(e) => setBlocks(Math.max(1, Math.min(MAX_LOCK_BLOCKS, Math.floor(Number(e.target.value) || 0))))}
            className="flex-1 rounded-xl px-3 py-2 text-sm text-white outline-none"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
            aria-label="Blocks"
          />
          <span className="text-xs" style={{ color: MUTED }}>
            blocks (~{(blocks / BLOCKS_PER_DAY).toFixed(1)} days)
          </span>
        </div>
      )}
      <div className="mt-3 rounded-xl px-3 py-2 text-xs" style={{ background: '#1a1408', color: '#e6c76a' }}>
        Your BSV stays yours. It's locked until {date}, then you can unlock it.
        <span className="block mt-1" style={{ color: MUTED }}>
          {blocks.toLocaleString()} blocks{height ? `, until block ${(height + blocks).toLocaleString()}` : ''}. The
          date is an estimate (about 10 minutes a block). Locked coins can't be spent early. Locking backs a post; it
          earns nothing.
        </span>
      </div>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs mt-2" style={{ color: RED }}>
            {error}
          </p>
          <ErrorActions message={String(error)} />
        </div>
      )}
      <button
        // One-click pay (Settings → Payments) skips the confirm for amounts within the limit.
        onClick={() => (oneClick.take(sats).ok ? void lock() : setConfirming(true))}
        disabled={busy || !valid}
        className="mt-3 w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-40"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {height ? `Lock ${formatLocked(sats)}` : 'Reading block height…'}
      </button>
      {confirming &&
        createPortal(
          <div className="fixed inset-0 z-[70]">
            <SendConfirmation
              show
              theme={theme}
              lineItems={[
                { address: 'Lock (stays yours)', amount: formatLocked(sats) },
                { address: 'Unlocks', amount: date },
              ]}
              total={formatLocked(sats)}
              isProcessing={busy}
              onConfirm={() => void lock()}
              onCancel={() => setConfirming(false)}
            />
          </div>,
          document.body,
        )}
    </Sheet>
  );
};

/**
 * One-tap posting identity, shown the first time someone posts (or likes, follows…) without one.
 * The same on-chain profile Settings → Identity creates; here it is a single step in the flow.
 */
const IdentitySetupSheet = ({
  initialName,
  image,
  onSave,
  onDone,
}: {
  initialName: string;
  image: string | null;
  onSave: (name: string) => Promise<string | undefined>;
  onDone: (ok: boolean) => void;
}) => {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    const err = await onSave(name.trim());
    setBusy(false);
    if (err) setError(err);
    else onDone(true);
  };
  return (
    <Sheet title="Set up your posting profile" onClose={() => !busy && onDone(false)}>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        A name and photo that sign your posts on-chain, so every BSV app knows they're yours. Costs a fraction of a
        cent.
      </p>
      <div className="flex items-center gap-3">
        {image && <img src={image} alt="" className="h-10 w-10 rounded-full object-cover" />}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          placeholder="Your name"
          aria-label="Your name"
          className="flex-1 rounded-xl px-3 py-2 text-sm text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        />
      </div>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs mt-2" style={{ color: RED }}>
            {error}
          </p>
          <ErrorActions message={String(error)} />
        </div>
      )}
      <button
        onClick={() => void save()}
        disabled={busy || !name.trim()}
        className="mt-3 w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-40"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {busy ? 'Setting up…' : 'Set up and continue'}
      </button>
    </Sheet>
  );
};

// ── page ────────────────────────────────────────────────────────────────────

export const FeedPage = ({ header }: { header?: ReactNode }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const identity = useIdentity(apiContext, chromeStorageService);
  const online = useOnline();
  const [start] = useState(() => initialFeed(loadPrefs().defaultFeed, loadFollows().length > 0));
  const [tab, setTab] = useState<Tab>(start.tab);
  const [follows, setFollows] = useState<Follow[]>(loadFollows);
  const [mutes, setMutes] = useState<string[]>(loadMutes);
  const [liked, setLiked] = useState<string[]>(loadLiked);
  // Cache first (owner round 6): the last posts show at once; the live feed replaces them quietly.
  const [raw, setRaw] = useState<Record<Tab, FeedPost[] | null>>(() => ({
    following: readListCache<FeedPost>('feed:following'),
    foryou: readListCache<FeedPost>('feed:foryou'),
  }));
  const [error, setError] = useState('');
  const [source, setSource] = useState<Source | 'all'>(loadSource);
  const [safetyTick, setSafetyTick] = useState(0);
  const [composing, setComposing] = useState<{
    replyTo: FeedPost | null;
    quote?: FeedPost;
    link?: { url: string; title: string };
  } | null>(null);
  const [feed, setFeed] = useState<FeedId>(() => {
    // After iOS killed the web view (crashResume.ts): back on the sub-feed that was open.
    const crashed = takeCrashFeed();
    if (crashed && crashed in FEED_COLORS) return migrateFeedId(crashed as FeedId);
    return loadNewsMode() ? 'bnews' : 'home';
  });
  const [pins, setPins] = useState<FeedId[]>(loadPins);
  const [allFeeds, setAllFeeds] = useState(false);
  const news = feed === 'bnews';
  const pickFeed = (picked: FeedId) => {
    const id = migrateFeedId(picked);
    setFeed(id);
    setAllFeeds(false);
    saveNewsMode(id === 'bnews');
    rememberFeed(id);
  };
  // Home's two filters (Following | For you), remembered per device as the Feed setting's default
  // (For you keeps "Latest" when that was the setting).
  const pickHomeFilter = (f: Tab) => {
    setTab(f);
    const was = loadPrefs().defaultFeed;
    if (f === 'following' ? was !== 'following' : was === 'following') savePrefs({ defaultFeed: f });
  };
  // Swipe the feed left / right for the next / previous feed (a vertical scroll never switches).
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onSwipeStart = (e: TouchEvent) => {
    const t = e.touches[0];
    swipeStart.current = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onSwipeEnd = (e: TouchEvent) => {
    const s0 = swipeStart.current;
    const t = e.changedTouches[0];
    swipeStart.current = null;
    if (!s0 || !t) return;
    const dir = swipeDir(t.clientX - s0.x, t.clientY - s0.y);
    // bNews cards close on a left swipe, so there only a right swipe changes feed.
    if (!dir || (news && dir === 1 && (e.target as HTMLElement).closest?.('[data-news-card]'))) return;
    // In the bMovies / bMusic reel a horizontal swipe is a 1p buy/sell; feeds change via the chips there.
    if (isReel(feed)) return;
    const to = stepFeed(pins, feed, dir);
    if (to) pickFeed(to);
  };
  const [story, setStory] = useState<NewsItem | null>(null);
  const [postedTick, setPostedTick] = useState(0);
  const [tipping, setTipping] = useState<FeedPost | null>(null);
  // The inline identity step: publish() waits on this when the wallet has no posting identity.
  const [settingUp, setSettingUp] = useState<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    setIdentitySetupHandler(() => new Promise<boolean>((resolve) => setSettingUp(() => resolve)));
    return () => setIdentitySetupHandler(null);
  }, []);
  const [locking, setLocking] = useState<FeedPost | null>(null);
  const [sort, setSort] = useState<FeedSort>(start.sort);
  const [blocks, setBlocks] = useState<HiddenAccount[]>(loadBlocks);
  const [bookmarks, setBookmarks] = useState<FeedPost[]>(loadBookmarks);
  const [showBookmarks, setShowBookmarks] = useState(false);
  // Row-1 filters (owner, 25 Oct 2026): Favourites (sources + people the user picked) and
  // Leaderboard (the 'Most locked' ranking as one tap). 'feed' = the normal source chips.
  const [view, setView] = useState<'feed' | 'favourites' | 'leaderboard'>('feed');
  const [favs, setFavs] = useState<Favourite[]>(loadFavourites);
  const [pickingFavs, setPickingFavs] = useState(false);
  const toggleFav = (f: Favourite) => {
    const on = isFavourite(favs, f);
    setFavs((x) => toggleFavourite(x, f));
    addSnackbar(on ? 'Removed from favourites' : 'Added to favourites', 'success');
  };
  // Pull bookmarks saved on this account's other devices when the Feed opens and when the list opens.
  useEffect(() => {
    void syncBookmarks(bookmarkClient()).then(setBookmarks);
  }, [showBookmarks]);
  // Mutes + blocks: hidden in the feed and threads. Blocks alone: hidden on profiles too.
  const blocked = useMemo(() => blockKeys(blocks), [blocks]);
  const hidden = useMemo(() => [...mutes, ...blocked], [mutes, blocked]);
  const [height, setHeight] = useState<number | null>(null);
  const [fetchedLocks, setFetchedLocks] = useState<Record<string, PostLock[]>>({});
  const [myLocks, setMyLocks] = useState<PostLock[]>(loadMyLocks);
  const lockFetches = useRef(new Set<string>());
  const [more, setMore] = useState<FeedPost | null>(null);
  const [profile, setProfile] = useState<Author | 'me' | null>(null);
  const [thread, setThread] = useState<FeedPost | null>(null);
  const [board, setBoard] = useState(false);

  useEffect(() => {
    void refreshSafety();
    return onSafetyChange(() => setSafetyTick((t) => t + 1));
  }, []);

  const load = useCallback(
    async (which: Tab) => {
      setError('');
      try {
        const posts = which === 'foryou' ? await fetchForYou() : await fetchFollowing(follows);
        setRaw((r) => ({ ...r, [which]: posts }));
        writeListCache(`feed:${which}`, posts);
        // Feed tab badge: the newest posts known (cleared by viewing the Feed route, useTabBadges.ts).
        if (which === 'foryou') setFeedLatest(posts.map((x) => x.at));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setRaw((r) => ({ ...r, [which]: r[which] ?? [] }));
      }
    },
    [follows],
  );
  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  const shown = useMemo(
    () =>
      raw[tab]
        ? view === 'favourites'
          ? filterFavourites(visiblePosts(raw[tab]!, hidden), favs)
          : filterFeed(visiblePosts(raw[tab]!, hidden), source, (a) => tab === 'foryou' && isFollowing(follows, a))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [raw, tab, hidden, safetyTick, source, follows, view, favs],
  );
  const likedSet = useMemo(() => new Set(liked), [liked]);

  useEffect(() => {
    let live = true;
    const read = () =>
      apiContext.services?.chaintracks
        .currentHeight()
        .then((h) => live && setHeight(h))
        .catch(() => undefined);
    void read();
    const t = setInterval(read, 5 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [apiContext]);

  // Lock totals for what is on screen (first 60), a few posts at a time; each post fetched once.
  useEffect(() => {
    const todo = (shown ?? [])
      .slice(0, 60)
      .map((p) => p.txid)
      .filter((t) => !lockFetches.current.has(t));
    if (!todo.length) return;
    todo.forEach((t) => lockFetches.current.add(t));
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const txid = todo[i++];
        try {
          const locks = await fetchPostLocks(txid);
          if (locks.length) setFetchedLocks((m) => ({ ...m, [txid]: locks }));
        } catch {
          lockFetches.current.delete(txid);
        }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
  }, [shown]);

  const lockSummaries = useMemo(() => {
    const by: Record<string, PostLock[]> = { ...fetchedLocks };
    for (const l of myLocks) by[l.postTxid] = [...(by[l.postTxid] ?? []), l];
    const out: Record<string, LockSummary> = {};
    if (height) for (const [txid, ls] of Object.entries(by)) out[txid] = summarizeLocks(ls, height);
    return out;
  }, [fetchedLocks, myLocks, height]);
  const knownPosts = useMemo(() => [...(raw.foryou ?? []), ...(raw.following ?? [])], [raw]);
  const sorted = useMemo(
    () =>
      shown && (view === 'leaderboard' || (tab === 'foryou' && sort === 'locked'))
        ? rankByLocked(shown, lockSummaries)
        : shown && tab === 'foryou' && sort === 'popular'
          ? [...shown].sort((a, b) => b.likes + b.replies - (a.likes + a.replies) || b.at - a.at)
          : shown,
    [shown, tab, sort, lockSummaries, view],
  );

  const like = async (p: FeedPost) => {
    try {
      await publish(apiContext, buildLikeScript(p.txid), 'Feed like', ['app:bWallet', 'type:like', `tx:${p.txid}`]);
      setLiked((l) => addLiked(l, p.txid));
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const follow = async (a: Author) => {
    const on = isFollowing(follows, a);
    if (a.bapId) {
      try {
        await publish(apiContext, buildFollowScript(a.bapId, undefined, on), on ? 'Feed unfollow' : 'Feed follow', [
          'app:bWallet',
          `type:${on ? 'unfollow' : 'follow'}`,
          `bapId:${a.bapId}`,
        ]);
      } catch (e) {
        return addSnackbar(e instanceof Error ? e.message : String(e), 'error');
      }
    }
    // Authors without a BAP identity can only be followed on this device.
    setFollows((f) => toggleFollow(f, { bapId: a.bapId, address: a.address, name: a.name }));
    addSnackbar(on ? `Unfollowed ${a.name}` : `Following ${a.name}`, 'success');
  };

  const mute = (p: FeedPost) => {
    rememberMuteName(safeName(p.author.name), p.author.address, p.author.bapId);
    setMutes((m) => addMute(m, p.author.address, p.author.bapId));
    setMore(null);
    addSnackbar(`Muted ${safeName(p.author.name)}`, 'info');
  };
  const block = (p: FeedPost) => {
    setBlocks((b) => addBlock(b, { address: p.author.address, bapId: p.author.bapId, name: safeName(p.author.name) }));
    setMore(null);
    addSnackbar(`Blocked ${safeName(p.author.name)}. Unblock in Settings → Privacy.`, 'info');
  };
  const bookmark = (p: FeedPost) => {
    const on = isBookmarked(bookmarks, p.txid);
    setBookmarks((b) => toggleSyncedBookmark(b, p));
    setMore(null);
    void syncBookmarks(bookmarkClient()).then(setBookmarks);
    addSnackbar(on ? 'Removed from bookmarks' : 'Saved to bookmarks', 'success');
  };
  const tip = async (p: FeedPost) => {
    const sats = loadPrefs().quickTip;
    // One-click pay: send the last tip amount without the sheet, if within the limit and the rate guard.
    // Unpayable posts (Treechat) open the sheet, which says why.
    if (!payDestination(p).ok || validateAmount(sats) || !oneClick.take(sats).ok) return setTipping(p);
    try {
      const txid = await sendPayment(apiContext, p, sats);
      const shown = celebrateSend(txid, {
        amount: { kind: 'bsv', sats },
        recipients: [safeName(p.author.name)],
        rate: cachedExchangeRate(),
        title: 'Tipped!',
      });
      if (!shown) addSnackbar(`Tipped ${safeName(p.author.name)} ${moneyNow(sats)} (one-click)`, 'success');
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  const report = (p: FeedPost) => {
    void reportItem({ outpoint: p.txid, name: p.author.name, reason: 'feed-post' });
    // Hide the post's on-chain media too, wherever else it is referenced.
    for (const ref of new Set((p.media ?? []).map((m) => m.ref).filter((r): r is string => !!r && r !== p.txid)))
      void reportItem({ outpoint: ref, name: p.author.name, reason: 'feed-media' });
    setMore(null);
    addSnackbar('Reported. It is hidden on this device.', 'info');
  };

  const branch = async (p: FeedPost) => {
    try {
      await publish(apiContext, buildBranchScript(p.txid), 'Feed branch', [
        'app:bWallet',
        'type:repost',
        'context:tx',
        `contextValue:${p.txid}`,
      ]);
      addSnackbar(`Branched ${safeName(p.author.name)}'s post`, 'success');
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  // "Hide my post" (spec §7.1): a signed hide with this wallet's posting key. Readers honour it only
  // when that key signed the post, so it is offered on posts that look like ours.
  const myKeys = {
    bapId: identity.bapId,
    addresses: Object.values(chromeStorageService.getCurrentAccountObject().account?.addresses ?? {}).filter(
      (x): x is string => typeof x === 'string' && !!x,
    ),
  };
  const hideMine = async (p: FeedPost) => {
    setMore(null);
    try {
      await publish(apiContext, buildHideScript(p.txid), 'Hide my post', ['app:bWallet', 'type:hide', `tx:${p.txid}`]);
      addSnackbar('Hidden. Open Feed apps drop it once they see your signed request.', 'success');
    } catch (e) {
      if (e instanceof PostCancelledError) return;
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const onAction = (p: FeedPost, act: PostAction) => {
    setMore(null);
    const url = sourceUrl(p);
    if (act === 'branch') return void branch(p);
    if (act === 'quote') return setComposing({ replyTo: null, quote: p });
    if (act === 'mute') return mute(p);
    if (act === 'report') return report(p);
    if (act === 'copyLink' && url)
      return void navigator.clipboard
        ?.writeText(url)
        .then(() => addSnackbar('Link copied', 'success'))
        .catch(() => addSnackbar('Could not copy the link', 'error'));
    // Open, and actions that live on the source's servers (Twetch bookmarks, paid unlocks).
    if ((act === 'open' || REMOTE_ACTIONS.has(act)) && url) return void openDappBrowser(url);
  };

  const actions: PostActions = {
    liked: likedSet,
    onLike: (p) => void like(p),
    onReply: (p) => setComposing({ replyTo: p }),
    onTip: (p) => void tip(p),
    locks: lockSummaries,
    onLock: setLocking,
    onOpen: setThread,
    onAuthor: setProfile,
    onMore: setMore,
    bookmarked: (txid) => isBookmarked(bookmarks, txid),
    onBookmark: bookmark,
    onAction,
  };

  /** A notification's post: from what is loaded, else fetched (Twetch by id, else bmap by txid). */
  const openTarget = async (t: { txid: string; twetchId?: number }) => {
    const loaded = [...(raw.foryou ?? []), ...(raw.following ?? [])].find((p) => p.txid === t.txid);
    try {
      const p = loaded ?? (t.twetchId ? await fetchTwetchPost(t.twetchId) : await fetchBmapPost(t.txid));
      if (p) setThread(p);
      else addSnackbar('That post is not indexed yet', 'info');
    } catch {
      addSnackbar('Could not load that post', 'error');
    }
  };

  const me: Author = {
    address: '',
    bapId: identity.bapId,
    name: identity.profile.name || 'You',
    avatar: identity.profile.image ? resolveImageUrl(identity.profile.image, apiContext) : null,
  };

  return (
    <div
      className="isolate flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36"
      style={{ height: '100%', background: 'var(--bw-bg)' }}
    >
      <PullToRefresh onRefresh={() => load(tab)} />
      <VideoBackground src={feedBg} poster={feedPoster} scrim="dark" position="fixed" />
      <TopNav />
      <div className="w-full pt-16 flex flex-col">
        {header && <SegmentRow>{header}</SegmentRow>}
        <SegmentTitle title={feed === 'home' ? 'Feed' : feedDef(feed).label}>
          <NotificationsBell onOpenPost={(t) => void openTarget(t)} />
          <button onClick={() => setShowBookmarks(true)} aria-label="Bookmarks" className="p-2 active:opacity-60">
            <Bookmark size={18} color={MUTED} />
          </button>
          <button onClick={() => setProfile('me')} aria-label="My profile" className="p-1">
            <Avatar author={me} size={28} />
          </button>
          <button
            onClick={() => setBoard(true)}
            aria-label="Most locked leaderboard"
            className="p-2 rounded-full active:opacity-60"
          >
            <Trophy size={18} color={GOLD} />
          </button>
        </SegmentTitle>

        <FeedPicker
          pins={pins}
          current={feed}
          allOpen={allFeeds}
          onPick={pickFeed}
          onOpenAll={() => setAllFeeds(true)}
        />
        <div style={{ borderBottom: `1px solid ${LINE}` }} />

        {feed === 'home' && (
          <div className="px-4 pt-3">
            <div
              role="tablist"
              aria-label="Home filter"
              className="flex rounded-full p-0.5"
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            >
              {HOME_FILTERS.map((f) => (
                <button
                  key={f.id}
                  role="tab"
                  aria-selected={tab === f.id}
                  onClick={() => pickHomeFilter(f.id)}
                  className="flex-1 rounded-full py-1.5 text-[13px] font-semibold"
                  style={tab === f.id ? { background: GOLD, color: '#1a1300' } : { color: MUTED }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {feed === 'home' && (
          <div className="flex flex-col gap-2 px-4 py-2">
            {/* Row 1: All, sort, Favourites, Leaderboard in four equal cells. */}
            <div className="grid grid-cols-4 gap-2">
              <button
                onClick={() => {
                  setView('feed');
                  setSource('all');
                  saveSource('all');
                }}
                className={`bw-feed-chip min-w-0 truncate rounded-full px-1.5 py-1 text-[12px] font-semibold${view === 'feed' && source === 'all' ? ' is-on' : ''}`}
                style={view === 'feed' && source === 'all' ? { background: GOLD, color: '#1a1300' } : chipOff}
              >
                All
              </button>
              <SortMenu
                sort={sort}
                on={view === 'feed'}
                onChange={(s) => {
                  setSort(s);
                  setView('feed');
                }}
              />
              <div
                className={`bw-feed-chip flex min-w-0 items-center rounded-full text-[12px] font-semibold${view === 'favourites' ? ' is-on' : ''}`}
                style={view === 'favourites' ? { background: GOLD, color: '#1a1300' } : chipOff}
              >
                <button
                  onClick={() => setView('favourites')}
                  className="min-w-0 flex-1 truncate py-1 pl-2 text-left"
                  aria-pressed={view === 'favourites'}
                >
                  Favourites
                </button>
                <button
                  onClick={() => setPickingFavs(true)}
                  aria-label="Add favourites"
                  className="shrink-0 py-1 pl-0.5 pr-1.5"
                >
                  <Plus size={13} />
                </button>
              </div>
              <button
                onClick={() => setView('leaderboard')}
                aria-pressed={view === 'leaderboard'}
                aria-label="Leaderboard: most BSV locked"
                className={`bw-feed-chip flex min-w-0 items-center justify-center gap-1 rounded-full px-1.5 py-1 text-[12px] font-semibold${view === 'leaderboard' ? ' is-on' : ''}`}
                style={view === 'leaderboard' ? { background: GOLD, color: '#1a1300' } : chipOff}
              >
                <span className="truncate">Leaderboard</span>
                <Lock size={12} className="shrink-0" />
              </button>
            </div>
            {/* Two rows of four source chips. */}
            <div className="grid grid-cols-4 gap-2" role="tablist" aria-label="Source">
              {SOURCES.filter((s) => s.id !== 'all').map((s) => {
                const on = view === 'feed' && source === s.id;
                return (
                  <button
                    key={s.id}
                    role="tab"
                    aria-selected={on}
                    onClick={() => {
                      setView('feed');
                      setSource(s.id);
                      saveSource(s.id);
                    }}
                    className={`bw-feed-chip min-w-0 truncate rounded-full px-1.5 py-1 text-[12px] font-semibold${on ? ' is-on' : ''}`}
                    style={on ? { background: chipColor(s.id), color: textOn(chipColor(s.id)) } : chipOff}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!online && (
          <div
            className="mx-4 mt-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
            style={{ background: '#1a1408', color: '#e6c76a' }}
          >
            <WifiOff size={14} /> You're offline.
          </div>
        )}
        {error && (
          <div className="flex flex-col gap-1.5">
            <div className="text-center text-xs pt-4" style={{ color: RED }}>
              {error}
            </div>
            <ErrorActions message={String(error)} />
          </div>
        )}

        <div onTouchStart={onSwipeStart} onTouchEnd={onSwipeEnd} className="flex flex-col">
          {(feed === 'bmovies' || feed === 'bmusic') && BmoviesReel ? (
            <>
              {feed === 'bmusic' && <FeaturedAlbum color={feedColor('bmusic')} />}
              <Suspense fallback={null}>
                <BmoviesReel key={feed} brand={feed} />
              </Suspense>
            </>
          ) : feed === 'bapps' ? (
            <Suspense fallback={null}>
              <BappsReel />
            </Suspense>
          ) : feed === 'bexchange' && BexReel ? (
            <Suspense fallback={null}>
              <BexReel />
            </Suspense>
          ) : feed === 'b3d' && B3dFeed ? (
            <Suspense fallback={null}>
              <B3dFeed />
            </Suspense>
          ) : feed === 'bradio' ? (
            <BradioFeed />
          ) : !hasCustomView(feed) ? (
            <BrandFeed slug={feed} />
          ) : news ? (
            <>
              {NewsVideos && (
                <Suspense fallback={null}>
                  <NewsVideos />
                </Suspense>
              )}
              <NewsList posts={knownPosts} onOpen={setStory} />
            </>
          ) : (
            <PostList
              posts={sorted}
              a={actions}
              empty={
                <div className="px-8 pt-14 text-center">
                  {view === 'favourites' ? (
                    <>
                      <p className="text-sm text-white font-semibold">
                        {favs.length ? 'Nothing from your favourites yet' : 'No favourites yet'}
                      </p>
                      <button
                        onClick={() => setPickingFavs(true)}
                        className="text-xs mt-1 inline-flex items-center gap-1"
                        style={{ color: MUTED }}
                      >
                        <Plus size={12} /> Tap + to add feeds or people you like
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-white font-semibold">
                        {tab === 'following' && !follows.length ? 'Nobody followed yet' : 'Nothing here yet'}
                      </p>
                      <p className="text-xs mt-1" style={{ color: MUTED }}>
                        {tab === 'following' ? 'Tap a name in For you and follow them.' : 'Pull refresh in a moment.'}
                      </p>
                    </>
                  )}
                </div>
              }
            />
          )}
        </div>
      </div>

      {allFeeds && (
        <AllFeedsSheet
          pins={pins}
          current={feed}
          onPick={pickFeed}
          onTogglePin={(id) =>
            setPins((p) => {
              const next = togglePin(p, id);
              savePins(next);
              return next;
            })
          }
          onMovePin={(id, dir) =>
            setPins((p) => {
              const next = movePin(p, id, dir);
              savePins(next);
              return next;
            })
          }
          onClose={() => setAllFeeds(false)}
        />
      )}

      {/* No Post button over a reel (bMovies, bMusic, bApps, bExchange): it covered the card's buttons. */}
      {!isReel(feed) && (
        <button
          onClick={() => setComposing({ replyTo: null })}
          aria-label="New post"
          className="fixed right-5 z-40 h-14 w-14 rounded-full flex items-center justify-center shadow-lg"
          style={{ bottom: 'calc(env(safe-area-inset-bottom) + 96px)', background: GOLD }}
        >
          <PenLine size={22} color="#1a1300" />
        </button>
      )}

      {composing && (
        <Composer
          replyTo={composing.replyTo}
          quote={composing.quote ?? null}
          link={composing.link ?? null}
          onClose={() => setComposing(null)}
          onPosted={(txid) => {
            setComposing(null);
            setPostedTick((t) => t + 1);
            addSnackbar(`Posted · ${txid.slice(0, 8)}…`, 'success');
            // First post: now there is something to be notified about (replies, likes).
            void askNotifyPermissionOnce();
            setTimeout(() => void load(tab), 2500);
          }}
        />
      )}
      {tipping && (
        <TipSheet
          post={tipping}
          onClose={() => setTipping(null)}
          onLiked={(p) => setLiked((l) => addLiked(l, p.txid))}
        />
      )}
      {settingUp && (
        <IdentitySetupSheet
          initialName={identity.profile.name || chromeStorageService.getCurrentAccountObject().account?.name || ''}
          image={identity.profile.image ? resolveImageUrl(identity.profile.image, apiContext) : null}
          onSave={async (name) =>
            (
              await identity.saveProfile({
                name,
                image: identity.profile.image,
                description: identity.profile.description,
              })
            ).error
          }
          onDone={(ok) => {
            settingUp(ok);
            setSettingUp(null);
          }}
        />
      )}
      {locking && (
        <LockSheet
          post={locking}
          height={height}
          onClose={() => setLocking(null)}
          onLocked={(l) => {
            setMyLocks((m) => addMyLock(m, l));
            setLocking(null);
          }}
        />
      )}
      {more && (
        <Sheet title={safeName(more.author.name)} onClose={() => setMore(null)}>
          {postActions(more).more.map((act) => {
            const Icon = ACTION_ICONS[act] ?? MoreHorizontal;
            const danger = act === 'report';
            return (
              <button
                key={act}
                onClick={() => onAction(more, act)}
                className="w-full flex items-center gap-3 py-3 text-sm"
                style={{ color: danger ? RED : '#fff' }}
              >
                <Icon size={18} color={danger ? RED : MUTED} />
                {act === 'mute' ? `Mute ${safeName(more.author.name)}` : actionLabel(act, more.source)}
              </button>
            );
          })}
          {more.source !== 'treechat' && isMe(more.author, myKeys) && (
            <button
              onClick={() => void hideMine(more)}
              className="w-full flex items-center gap-3 py-3 text-sm text-white"
            >
              <EyeOff size={18} color={MUTED} />
              Hide my post
            </button>
          )}
          <button onClick={() => bookmark(more)} className="w-full flex items-center gap-3 py-3 text-sm text-white">
            {isBookmarked(bookmarks, more.txid) ? (
              <BookmarkCheck size={18} color={GOLD} />
            ) : (
              <Bookmark size={18} color={MUTED} />
            )}
            {isBookmarked(bookmarks, more.txid) ? 'Remove bookmark' : 'Save to bookmarks'}
          </button>
          {more.author.address &&
            (() => {
              const fav: Favourite = {
                kind: 'author',
                address: more.author.address,
                bapId: more.author.bapId,
                name: more.author.name,
              };
              const on = isFavourite(favs, fav);
              return (
                <button
                  onClick={() => {
                    toggleFav(fav);
                    setMore(null);
                  }}
                  className="w-full flex items-center gap-3 py-3 text-sm text-white"
                >
                  <Star size={18} color={on ? GOLD : MUTED} fill={on ? GOLD : 'none'} />
                  {on ? 'Remove from favourites' : 'Add to favourites'}
                </button>
              );
            })()}
          {more.author.address && (
            <button
              onClick={() => block(more)}
              className="w-full flex items-center gap-3 py-3 text-sm"
              style={{ color: RED }}
            >
              <Ban size={18} color={RED} />
              Block {safeName(more.author.name)}
            </button>
          )}
        </Sheet>
      )}
      {story && (
        <NewsThread
          story={story}
          known={knownPosts}
          postedTick={postedTick}
          onBack={() => setStory(null)}
          onDiscuss={() => setComposing({ replyTo: null, link: { url: story.link, title: story.title } })}
          renderPosts={(posts) => (
            <PostList
              posts={posts === null ? null : visiblePosts(posts, hidden)}
              a={actions}
              empty={
                <p className="text-center text-xs pt-6 px-8" style={{ color: MUTED }}>
                  No one has discussed this yet. Start the thread.
                </p>
              }
            />
          )}
        />
      )}
      {pickingFavs && (
        <Sheet title="Favourites" onClose={() => setPickingFavs(false)}>
          {SOURCES.filter((x) => x.id !== 'all').map((x) => {
            const f: Favourite = { kind: 'source', id: x.id as Source };
            const on = isFavourite(favs, f);
            return (
              <button
                key={x.id}
                onClick={() => setFavs((v) => toggleFavourite(v, f))}
                aria-pressed={on}
                className="w-full flex items-center gap-3 py-3 text-sm text-white"
              >
                <Star size={18} color={on ? GOLD : MUTED} fill={on ? GOLD : 'none'} />
                <span className="flex-1 text-left">{x.label}</span>
                {on && <Check size={16} color={GOLD} />}
              </button>
            );
          })}
          {favs
            .filter((f): f is Extract<Favourite, { kind: 'author' }> => f.kind === 'author')
            .map((f) => (
              <button
                key={f.address}
                onClick={() => setFavs((v) => toggleFavourite(v, f))}
                className="w-full flex items-center gap-3 py-3 text-sm text-white"
              >
                <Star size={18} color={GOLD} fill={GOLD} />
                <span className="min-w-0 flex-1 truncate text-left">{safeName(f.name)}</span>
                <Check size={16} color={GOLD} />
              </button>
            ))}
          <p className="pt-2 text-xs" style={{ color: MUTED }}>
            Add people from a post's ••• menu.
          </p>
        </Sheet>
      )}
      {showBookmarks && (
        <Layer title="Bookmarks" onBack={() => setShowBookmarks(false)}>
          <PostList
            posts={visiblePosts(bookmarks, blocked)}
            a={actions}
            empty={
              <div className="px-8 pt-14 text-center">
                <p className="text-sm text-white font-semibold">No bookmarks yet</p>
                <p className="text-xs mt-1" style={{ color: MUTED }}>
                  Tap the bookmark on a post to save it here.
                </p>
              </div>
            }
          />
        </Layer>
      )}
      {profile && (
        <ProfileView
          author={profile === 'me' ? me : profile}
          isMe={profile === 'me'}
          following={profile !== 'me' && isFollowing(follows, profile)}
          onFollow={() => profile !== 'me' && void follow(profile)}
          onBack={() => setProfile(null)}
          actions={actions}
          mutes={blocked}
          safetyTick={safetyTick}
          onBlock={() => {
            if (profile === 'me') return;
            setBlocks((b) => addBlock(b, { address: profile.address, bapId: profile.bapId, name: profile.name }));
            setProfile(null);
            addSnackbar(`Blocked ${profile.name}. Unblock in Settings → Privacy.`, 'info');
          }}
        />
      )}
      {board && (
        <Leaderboard
          me={{
            bapId: identity.bapId,
            addresses: Object.values(chromeStorageService.getCurrentAccountObject().account?.addresses ?? {}).filter(
              (x): x is string => typeof x === 'string' && !!x,
            ),
          }}
          myLocks={myLocks}
          onBack={() => setBoard(false)}
          onOpen={setThread}
          onAuthor={setProfile}
        />
      )}
      {thread && !thread.threadId && (
        <PostThread
          post={thread}
          onBack={() => setThread(null)}
          actions={actions}
          mutes={hidden}
          safetyTick={safetyTick}
        />
      )}
      {thread && thread.threadId && (
        <ThreadView
          post={thread}
          onBack={() => setThread(null)}
          actions={actions}
          mutes={hidden}
          safetyTick={safetyTick}
        />
      )}
    </div>
  );
};

const ProfileView = ({
  author,
  isMe,
  following,
  onFollow,
  onBack,
  actions,
  mutes,
  safetyTick,
  onBlock,
}: {
  author: Author;
  isMe: boolean;
  following: boolean;
  onFollow: () => void;
  onBack: () => void;
  actions: PostActions;
  mutes: string[];
  safetyTick: number;
  /** Block this author (hides their posts on this device). */
  onBlock: () => void;
}) => {
  const [reporting, setReporting] = useState(false);
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [error, setError] = useState('');
  // Read the author's posts from the source they came from (Twetch user id, Peck key, Treechat
  // name, Fwetch address, or bChat address / BAP): bmap alone had none for most authors.
  const ref = useMemo(
    () => authorRef(author),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [author.address, author.bapId, author.source, author.sourceId],
  );
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [info, setInfo] = useState<AuthorProfile | null>(null);
  const reqRef = useRef(0);
  useEffect(() => {
    const req = ++reqRef.current;
    setPosts(null);
    setError('');
    setNext(null);
    setInfo(null);
    fetchAuthorPage(ref, null, authorDeps)
      .then((pg) => {
        if (req !== reqRef.current) return;
        setPosts(pg.posts);
        setNext(pg.next);
      })
      .catch((e) => {
        if (req !== reqRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setPosts([]);
      });
    fetchAuthorProfile(ref, authorDeps)
      .then((p) => req === reqRef.current && setInfo(p))
      .catch(() => undefined);
  }, [ref]);
  const loadMore = () => {
    if (!next || loadingMore) return;
    const req = reqRef.current;
    setLoadingMore(true);
    fetchAuthorPage(ref, next, authorDeps)
      .then((pg) => {
        if (req !== reqRef.current) return;
        setPosts((cur) => mergePosts(cur ?? [], pg.posts));
        setNext(pg.next);
      })
      .catch((e) => req === reqRef.current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => req === reqRef.current && setLoadingMore(false));
  };
  const homeUrl = authorProfileUrl(ref);
  const homeLabel = sourceLabel(ref.source === 'bchat' ? FEED_APP : ref.source === 'peck' ? 'peck.to' : ref.source);
  const shown = useMemo(
    () => (posts ? visiblePosts(posts, isMe ? [] : mutes) : null),
    // safetyTick isn't read here: it bumps when the hide/block lists (module state that
    // visiblePosts reads) change, and is what makes this recompute. Removing it would break that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [posts, mutes, isMe, safetyTick],
  );
  return (
    <Layer title={safeName(author.name)} onBack={onBack}>
      <div
        className="flex flex-col items-center px-6 pt-6 pb-4 text-center"
        style={{ borderBottom: `1px solid ${LINE}` }}
      >
        {/* Tap to turn it over: their pay code, an Art QR of their payable address (public data only). */}
        <FlipBavatar
          front={<Avatar author={author} size={80} place="full" />}
          artSeed={author.address}
          address={isPayAddress(author.address) ? author.address : ''}
          caption={safeName(author.name)}
          size={80}
          backSize={200}
          label={isMe ? 'Your bAvatar' : `${safeName(author.name)}'s bAvatar`}
        />
        <AuthorName name={author.name} className="mt-3 block text-lg font-bold text-white" />
        <p className="text-[11px] mt-1 break-all" style={{ color: MUTED }}>
          {author.bapId
            ? `BAP ${author.bapId}`
            : ref.source === 'twetch'
              ? `@${ref.id} on Twetch`
              : ref.source === 'treechat'
                ? `@${ref.id} on Treechat`
                : author.address && !author.address.includes(':')
                  ? shortAddress(author.address)
                  : ref.id
                    ? `${shortAddress(ref.id)} on ${homeLabel}`
                    : ''}
        </p>
        {info?.bio && (
          <p className="text-xs mt-2 whitespace-pre-line break-words" style={{ color: 'white' }}>
            {info.bio}
          </p>
        )}
        {info && (info.followers !== null || info.following !== null) && (
          <p className="text-xs mt-2" style={{ color: MUTED }}>
            {info.followers !== null && (
              <>
                <b className="text-white">{info.followers}</b> followers
              </>
            )}
            {info.followers !== null && info.following !== null && ' · '}
            {info.following !== null && (
              <>
                <b className="text-white">{info.following}</b> following
              </>
            )}
          </p>
        )}
        {homeUrl && (
          <a
            href={homeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 text-xs font-semibold"
            style={{ color: GOLD }}
          >
            Open on {homeLabel} ↗
          </a>
        )}
        {isMe && !author.bapId && (
          <p className="text-xs mt-2" style={{ color: MUTED }}>
            Your first post sets up your posting profile.
          </p>
        )}
        {!isMe && (
          <button
            onClick={onFollow}
            className="mt-3 rounded-2xl px-5 py-2 text-sm font-bold inline-flex items-center gap-2"
            style={
              following
                ? { background: PANEL, color: 'white', border: `1px solid ${LINE}` }
                : { background: GOLD, color: '#1a1300' }
            }
          >
            {following ? <UserCheck size={15} /> : <UserPlus size={15} />} {following ? 'Following' : 'Follow'}
          </button>
        )}
        {!isMe && (
          <button
            onClick={() => setReporting(true)}
            className="mt-2 inline-flex items-center gap-1.5 text-xs"
            style={{ color: MUTED }}
          >
            <Flag size={12} /> Report or block
          </button>
        )}
      </div>
      {reporting && (
        <ReportSheet
          title={`Report or block ${safeName(author.name)}`}
          report={{
            kind: 'user',
            target: author.bapId ? `bap:${author.bapId}` : author.address ? `address:${author.address}` : author.name,
            details: `feed author: ${author.name}`,
          }}
          onClose={() => setReporting(false)}
          extra={
            <button
              onClick={() => {
                setReporting(false);
                onBlock();
              }}
              className="rounded-xl py-2.5 text-sm font-semibold"
              style={{ background: '#2b2f36', color: '#ff6b6b' }}
            >
              Block {safeName(author.name)}
            </button>
          }
        />
      )}
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-center text-xs pt-4" style={{ color: RED }}>
            {error}
          </p>
          <ErrorActions message={String(error)} />
        </div>
      )}
      <PostList
        posts={shown}
        a={{ ...actions, onAuthor: () => undefined }}
        empty={
          <div className="text-center text-xs pt-10 flex flex-col items-center gap-2" style={{ color: MUTED }}>
            <p>No posts yet.</p>
            {homeUrl && (
              <a href={homeUrl} target="_blank" rel="noopener noreferrer" style={{ color: GOLD }}>
                See {safeName(author.name)} on {homeLabel} ↗
              </a>
            )}
          </div>
        }
      />
      {next && posts && posts.length > 0 && (
        <div className="flex justify-center py-4">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-2xl px-5 py-2 text-sm font-semibold"
            style={{ background: PANEL, color: 'white', border: `1px solid ${LINE}` }}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </Layer>
  );
};

const ThreadView = ({
  post,
  onBack,
  actions,
  mutes,
  safetyTick,
}: {
  post: FeedPost;
  onBack: () => void;
  actions: PostActions;
  mutes: string[];
  safetyTick: number;
}) => {
  const [thread, setThread] = useState<FeedPost[] | null>(null);
  useEffect(() => {
    setThread(null);
    fetchThread(post)
      .then(setThread)
      .catch(() => setThread([post]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.txid]);
  // Treechat: the whole thread (every post with this treechat_thread_id), oldest first.
  // Tapping a post in it opens that post's own thread view (ancestors + replies).
  const [focus, setFocus] = useState<FeedPost | null>(null);
  const shown = useMemo(
    () => (thread ? visiblePosts(thread, mutes) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thread, mutes, safetyTick],
  );
  const authorFromThread = (a: Author) => {
    onBack();
    actions.onAuthor(a);
  };
  return (
    <Layer title={`Thread · via ${sourceLabel(post.app) || 'Treechat'}`} onBack={onBack}>
      <PostList
        posts={shown}
        a={{ ...actions, onOpen: (p) => p.txid !== post.txid && setFocus(p), onAuthor: authorFromThread }}
        empty={
          <p className="text-center text-xs pt-8" style={{ color: MUTED }}>
            Nothing to show in this thread.
          </p>
        }
      />
      {focus && (
        <PostThread
          post={focus}
          onBack={() => setFocus(null)}
          actions={actions}
          mutes={mutes}
          safetyTick={safetyTick}
        />
      )}
    </Layer>
  );
};

/**
 * Twetch / bChat / other posts: the canonical ancestor chain (what this replies to or quotes, up
 * to the root) above a thin connector line, then the post, then its replies. Tapping an ancestor
 * or a reply re-roots the view there; Back walks back through those re-roots before closing.
 */
const PostThread = ({
  post,
  onBack,
  actions,
  mutes,
  safetyTick,
}: {
  post: FeedPost;
  onBack: () => void;
  actions: PostActions;
  mutes: string[];
  safetyTick: number;
}) => {
  const [stack, setStack] = useState<FeedPost[]>([post]);
  const focus = stack[stack.length - 1];
  const [ancestors, setAncestors] = useState<FeedPost[] | null>(null);
  const [replies, setReplies] = useState<FeedPost[] | null>(null);
  useEffect(() => {
    let live = true;
    setAncestors(null);
    setReplies(null);
    fetchAncestors(focus)
      .then((a) => live && setAncestors(a))
      .catch(() => live && setAncestors([]));
    fetchThread(focus)
      .then((t) => live && setReplies(t.filter((p) => p.txid !== focus.txid)))
      .catch(() => live && setReplies([]));
    return () => {
      live = false;
    };
  }, [focus]);
  const reroot = (p: FeedPost) => {
    if (p.txid !== focus.txid) setStack((s) => [...s, p]);
  };
  const back = () => (stack.length > 1 ? setStack((s) => s.slice(0, -1)) : onBack());
  const shownReplies = useMemo(
    () => (replies ? visiblePosts(replies, mutes) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replies, mutes, safetyTick],
  );
  const shownAncestors = useMemo(
    () => visiblePosts(ancestors ?? [], mutes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ancestors, mutes, safetyTick],
  );
  const authorFromThread = (a: Author) => {
    onBack();
    actions.onAuthor(a);
  };
  const a = { ...actions, onOpen: reroot, onAuthor: authorFromThread };
  return (
    <Layer title={shownAncestors.length ? 'Thread' : 'Post'} onBack={back}>
      {ancestors === null && (focus.replyTo || focus.parentId || focus.quoteId || focus.quoteTxid) && (
        <p className="text-center text-[11px] pt-3" style={{ color: MUTED }}>
          Loading the thread above…
        </p>
      )}
      {shownAncestors.map((p) => (
        <div key={p.txid} className="relative" style={{ opacity: 0.92 }}>
          {/* thin connector from this ancestor's avatar down to the next post */}
          <div
            aria-hidden
            className="absolute pointer-events-none"
            style={{ left: 35, top: 56, bottom: -12, width: 2, background: LINE, zIndex: 1 }}
          />
          <PostCard post={p} a={a} />
        </div>
      ))}
      <div style={{ background: 'rgb(var(--bw-accent-hi-rgb) / 0.04)' }}>
        <PostCard post={focus} a={{ ...a, onOpen: () => undefined }} />
      </div>
      <PostList
        posts={shownReplies}
        a={a}
        empty={
          <p className="text-center text-xs pt-8" style={{ color: MUTED }}>
            No replies yet.
          </p>
        }
      />
    </Layer>
  );
};

type BoardKind = 'people' | 'posts';

/** Twetch-style "Most locked" leaderboard: People / Posts, 1D · 7D · 1M · ALL. */
const Leaderboard = ({
  me,
  myLocks,
  onBack,
  onOpen,
  onAuthor,
}: {
  me: { bapId: string | null; addresses: string[] };
  myLocks: PostLock[];
  onBack: () => void;
  onOpen: (p: FeedPost) => void;
  onAuthor: (a: Author) => void;
}) => {
  const [kind, setKind] = useState<BoardKind>('people');
  const [tf, setTf] = useState<Timeframe>('7d');
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [rate, setRate] = useState(0);

  useEffect(() => {
    void fetchExchangeRate('main').then(setRate);
  }, []);

  const load = useCallback(async (which: Timeframe, force = false) => {
    setLoading(true);
    setError('');
    try {
      setData(await fetchLeaderboard(which, force));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(tf);
  }, [tf, load]);

  // This device's own locks count before the indexer catches up.
  const locks = useMemo(() => {
    const by: Record<string, PostLock[]> = { ...(data?.locks ?? {}) };
    for (const l of myLocks) by[l.postTxid] = [...(by[l.postTxid] ?? []), l];
    return by;
  }, [data, myLocks]);
  const since = useMemo(() => cutoff(tf, data?.at), [tf, data]);
  const people = useMemo(() => (data ? rankPeople(data.posts, locks, since) : []), [data, locks, since]);
  const posts = useMemo(() => (data ? rankPosts(data.posts, locks, since) : []), [data, locks, since]);
  const rows = kind === 'people' ? people : posts;
  const tfLabel = TIMEFRAMES.find((t) => t.id === tf)?.label ?? '';

  const scope = data
    ? data.complete
      ? `Locks on the ${data.posts.length} most recent bmap posts covering ${tfLabel}. Twetch locks are not indexed.`
      : `Loaded window only: the ${data.posts.length} most recent bmap posts, back to ${new Date(data.oldest).toLocaleDateString()}. No indexer serves full ${tfLabel} totals.`
    : '';

  const amount = (sats: number) => (
    <div className="text-right shrink-0">
      <div className="text-[14px] font-bold" style={{ color: GOLD }}>
        {formatLocked(sats)}
      </div>
      {rate > 0 && (
        <div className="text-[11px]" style={{ color: MUTED }}>
          {satsNote(sats, rate)}
        </div>
      )}
    </div>
  );
  const rowStyle = (mine: boolean) => ({
    background: mine ? 'rgb(var(--bw-accent-hi-rgb) / 0.08)' : BOARD_PANEL,
    border: `1px solid ${mine ? GOLD : BOARD_LINE}`,
  });
  const rank = (n: number) => (
    <span className="w-7 shrink-0 text-center text-[15px] font-bold" style={{ color: n <= 3 ? GOLD : MUTED }}>
      {n}
    </span>
  );

  return (
    <Layer title="Most locked" onBack={onBack} onRefresh={() => load(tf, true)}>
      <div className="flex px-4" style={{ borderBottom: `1px solid ${LINE}` }}>
        {(['people', 'posts'] as BoardKind[]).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className="flex-1 py-2 text-[14px] font-bold"
            style={{
              color: kind === k ? 'white' : MUTED,
              borderBottom: `2px solid ${kind === k ? GOLD : 'transparent'}`,
            }}
          >
            {k === 'people' ? 'People' : 'Posts'}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 px-4 py-3">
        {TIMEFRAMES.map((t) => (
          <button
            key={t.id}
            onClick={() => setTf(t.id)}
            className={`bw-feed-chip shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold${tf === t.id ? ' is-on' : ''}`}
            style={
              tf === t.id
                ? { background: GOLD, color: '#1a1300' }
                : { background: BOARD_PANEL, color: MUTED, border: `1px solid ${BOARD_LINE}` }
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {scope && (
        <p className="px-4 pb-2 text-[11px]" style={{ color: MUTED }}>
          {scope}
        </p>
      )}
      {error && (
        <div className="px-8 pt-10 text-center">
          <p className="text-sm" style={{ color: RED }}>
            {error}
          </p>
          <button onClick={() => void load(tf, true)} className="mt-3 text-xs font-semibold" style={{ color: GOLD }}>
            Try again
          </button>
        </div>
      )}
      {!error && loading && !data && (
        <p className="px-8 pt-14 text-center text-sm" style={{ color: MUTED }}>
          Adding up locks…
        </p>
      )}
      {!error && data && !rows.length && (
        <div className="px-8 pt-14 text-center">
          <p className="text-sm text-white font-semibold">No locks in this period yet</p>
          <p className="text-xs mt-1" style={{ color: MUTED }}>
            Lock BSV behind a post to put it on the board.
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2 px-4">
        {kind === 'people'
          ? people.map((r) => {
              const mine = isMe(r.author, me);
              return (
                <button
                  key={r.key}
                  onClick={() => onAuthor(r.author)}
                  className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left"
                  style={rowStyle(mine)}
                >
                  {rank(r.rank)}
                  <Avatar author={r.author} source={r.source} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold text-white">
                      <AuthorName name={r.author.name} className="" />
                      {mine && <span style={{ color: GOLD }}> · You</span>}
                    </div>
                    <div className="truncate text-[11px]" style={{ color: MUTED }}>
                      {r.author.address ? shortAddress(r.author.address) : r.source} · {r.posts} post
                      {r.posts === 1 ? '' : 's'}
                    </div>
                  </div>
                  {amount(r.sats)}
                </button>
              );
            })
          : posts.map((r) => {
              const mine = isMe(r.post.author, me);
              return (
                <button
                  key={r.post.txid}
                  onClick={() => onOpen(r.post)}
                  className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left"
                  style={rowStyle(mine)}
                >
                  {rank(r.rank)}
                  <Avatar author={r.post.author} source={r.post.source} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-[13px] font-semibold text-white">
                        <AuthorName name={r.post.author.name} className="" />
                        {mine && <span style={{ color: GOLD }}> · You</span>}
                      </span>
                      <Via post={r.post} />
                    </div>
                    <div className="truncate text-[12px]" style={{ color: '#c9ccd2' }}>
                      {isSlur(r.post.text) ? 'Post hidden: offensive language' : r.post.text || 'Media post'}
                    </div>
                    <div className="text-[11px]" style={{ color: MUTED }}>
                      {feedTimeLabel(r.post.at)} · {r.lockers} locker{r.lockers === 1 ? '' : 's'}
                    </div>
                  </div>
                  {amount(r.sats)}
                </button>
              );
            })}
      </div>
    </Layer>
  );
};

const BOARD_PANEL = '#17191E';
const BOARD_LINE = '#2b2f36';
