/**
 * Feed › bMovies: a full-screen vertical reel of bmovies.app clips (see bmovies.ts). One clip per
 * screen, snap scrolling. Only the clip on screen plays (muted until tapped); the next one preloads its metadata;
 * only the slides either side of it hold a poster, and every other slide is just its gold title card, so at most
 * three media items are mounted (reelMemory.ts). Off-window players are unloaded, and nothing mounts while the
 * Feed page or the app is hidden, so iOS does not kill the web view for memory.
 *
 * The overlay mirrors bmovies.app's own feed (SwipeFeedView): black top/bottom scrims, sound chip
 * top-left, then bottom-up a white scrubber, a green Buy $TICKER button, the title and $TICKER in
 * Bebas Neue (ticker in bMovies yellow), the blurb in grey, and the blue mono @handle with ↗ to the
 * original post. Buy/Sell open the clip on bmovies.app (where real trades happen); Share shares its page.
 * With BMOVIES_ONE_MODEL on, title/Buy/Sell/Register open the bApps tile's webview at /film/<TICKER>?t=&action=
 * (or /claim/<offerId>) instead: one surface, one session, one claim path (bmovies-ONE-MODEL.md).
 *
 * Swipe to trade: on a clip, swipe RIGHT = buy 1p of its token, LEFT = sell 1p (long-press Buy/Sell does
 * the same). Vertical swipes still change clip; in this reel the Feed's own left/right feed-swipe is off
 * (change feed with the chips). Trades are a MOCK for now (swipeTrade.ts, BMOVIES_SWIPE_TRADE_MOCK).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type TouchEvent } from 'react';
import { ExternalLink, History, Share2, Volume2, VolumeX } from 'lucide-react';
import { haptic } from '../../swipe/haptics';
import bebasUrl from '../../bmint/assets/fonts/bebas-neue-400.woff2?url';
import { shareLink } from '../../chat/shareLink';
import { openDappBrowser } from '../../dappBrowser';
import { openBapp } from '../../bappFrame/bappFrame';
import {
  BMOVIES_ONE_MODEL,
  BMOVIES_ORIGIN,
  filmUrl,
  FEED_URL,
  appendPage,
  avatarUrl,
  clipPageUrl,
  creditedHandle,
  findPoster,
  firstFrameUrl,
  type Clip,
  clipTweetId,
  registerUrl,
} from './bmovies';
import { RegisterSheet } from './RegisterSheet';
import { applyClaims, checkClaim, claimTicker, fetchClaims, registerClip, xConnectUrl } from './claim';
import { useServiceContext } from '../../../hooks/useServiceContext';
import {
  BMOVIES_SWIPE_TRADE_MOCK,
  BMOVIES_SWIPE_TRADE_ENABLED,
  DEFAULT_DAILY_BUDGET_PENCE,
  UNDO_MS,
  addTrade,
  checkBudget,
  executeTrade,
  loadBudget,
  loadTrades,
  removeTrade,
  saveBudget,
  saveTrades,
  spend,
  tradeSide,
  type Budget,
  type Side,
  type SwipeTrade,
} from './swipeTrade';
import { BMUSIC_SOURCES, fetchMerged, type Cursors, type VideoSource } from './videoSources';
import { inReelWindow, phonePoster, useAppVisible, useReelDevLog, useReelVideo } from '../reelMemory';
import { useInPeek } from '../../phone/pageEl';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
// bmovies.app's feed palette (SwipeFeedView): X-blue handle, yellow ticker, green Buy.
const BM_BLUE = '#1d9bf0';
const BM_YELLOW = '#facc15';
const BM_GREEN = '#6bff8a';
const BM_GREEN_EDGE = 'rgba(47,175,90,0.8)';
const BM_RED = '#ff5c5c';
const BM_RED_EDGE = 'rgba(220,60,60,0.8)';
const BEBAS = "'Bebas Neue', 'Oswald', Impact, sans-serif";

/** The reel's brand: bMovies (gold title cards, bMovies' yellow/green) or bMusic (its blue). */
type Theme = {
  name: string;
  accent: string;
  /** Text on the accent. */
  onAccent: string;
  backdrop: string;
  ticker: string;
  home: string;
  sources: readonly VideoSource[];
};

const BMUSIC_BLUE = '#3E8BFF';

const THEMES: Record<'bmovies' | 'bmusic', Theme> = {
  bmovies: {
    name: 'bMovies',
    accent: GOLD,
    onAccent: '#1a1300',
    backdrop: 'radial-gradient(circle at 50% 35%, #3a2a00 0%, #120d00 55%, #010101 100%)',
    ticker: BM_YELLOW,
    home: `${BMOVIES_ORIGIN}/feed`,
    sources: [{ id: 'bmovies', label: 'bMovies', url: FEED_URL, enabled: true }],
  },
  bmusic: {
    name: 'bMusic',
    accent: BMUSIC_BLUE,
    onAccent: '#04122b',
    backdrop: 'radial-gradient(circle at 50% 35%, #0c2a5c 0%, #050f22 55%, #010101 100%)',
    ticker: BMUSIC_BLUE,
    home: `${BMOVIES_ORIGIN}/bmusic`,
    sources: BMUSIC_SOURCES,
  },
};

/** bMovies' display face, self-hosted (the same woff2 bMint ships), loaded once with the reel. */
let bebasLoading: Promise<void> | null = null;
const loadBebas = () =>
  (bebasLoading ??= (async () => {
    try {
      if (typeof FontFace === 'undefined' || !document.fonts) return;
      document.fonts.add(await new FontFace('Bebas Neue', `url(${bebasUrl})`).load());
    } catch {
      // offline: the fallback faces
    }
  })());

/** Gold title card: what a slide shows before (or without) a poster. Never a grey box. */
const TitleCard = ({ c, t }: { c: Clip; t: Theme }) => (
  <div
    className="absolute inset-0 flex items-center justify-center px-8 text-center"
    style={{ background: t.backdrop }}
  >
    <p className="text-[22px] font-bold leading-snug" style={{ color: t.accent }}>
      {c.title}
    </p>
  </div>
);

/** Gold bAvatar-style disc: the creator's initial on gold (never a grey placeholder). */
const GoldAvatar = ({ handle }: { handle: string }) => (
  <span
    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
    style={{
      background: 'radial-gradient(circle at 35% 30%, #ffe48a 0%, #FFD24D 45%, #b8860b 100%)',
      color: '#1a1300',
    }}
  >
    {(handle[0] ?? 'b').toUpperCase()}
  </span>
);

/**
 * The creator as author (only when the original post is theirs, see creditedHandle): avatar and the
 * blue mono @handle, as bmovies.app shows it, then "via bMovies"; otherwise "via bMovies" alone.
 * "Original on X ↗" opens the post when it is valid. The avatar is lazy (unavatar takes ~0.7–3.3s);
 * the gold disc shows until it loads or if it fails.
 */
const Attribution = ({ c, t }: { c: Clip; t: Theme }) => {
  const handle = creditedHandle(c);
  const [state, setState] = useState<'loading' | 'ok' | 'broken'>('loading');
  return (
    <div className="flex min-w-0 items-center gap-2">
      {handle && (
        <span className="relative h-7 w-7 shrink-0">
          {state !== 'ok' && <GoldAvatar handle={handle} />}
          {state !== 'broken' && (
            <img
              src={avatarUrl(handle)}
              alt=""
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-7 w-7 rounded-full object-cover"
              style={{ opacity: state === 'ok' ? 1 : 0 }}
              onLoad={() => setState('ok')}
              onError={() => setState('broken')}
            />
          )}
        </span>
      )}
      {handle && (
        <span
          className="min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] font-bold"
          style={{ color: BM_BLUE }}
        >
          @{handle}
        </span>
      )}
      <span className="shrink-0 text-[11px]" style={{ color: MUTED }}>
        via {c.via ?? t.name}
      </span>
      {c.tweetUrl && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void openDappBrowser(c.tweetUrl as string);
          }}
          className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-semibold"
          style={{ color: '#9aa0a6' }}
        >
          Original on X <span aria-hidden>↗</span>
        </button>
      )}
    </div>
  );
};

const Slide = ({
  c,
  i,
  active,
  shown,
  muted,
  onToggleSound,
  onTrade,
  onRegister,
  notYours,
  registering,
  t,
}: {
  t: Theme;
  c: Clip;
  i: number;
  active: number;
  /** False while the Feed page or the app is hidden: no media at all. */
  shown: boolean;
  muted: boolean;
  onToggleSound: () => void;
  onTrade: (c: Clip, side: Side) => void;
  onRegister: (c: Clip) => void;
  /** The original poster's X handle once the server said this viewer is not them. */
  notYours?: string;
  registering?: boolean;
}) => {
  const [poster, setPoster] = useState<string | null>(c.poster);
  const [posterBroken, setPosterBroken] = useState(false);
  const near = inReelWindow(i, active, shown);
  const playing = shown && i === active;
  const preloading = shown && i === active + 1;
  const video = useReelVideo(playing);

  useEffect(() => {
    if (poster || !near) return;
    let live = true;
    void findPoster(c).then((p) => live && p && setPoster(p));
    return () => {
      live = false;
    };
  }, [c, near, poster]);

  // The white scrubber under the overlay (0..1), from the playing clip.
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!playing) setProgress(0);
  }, [playing]);

  const shownPoster = poster && !posterBroken ? phonePoster(poster) : null;
  // Where the viewer is in this clip, so the film page carries on from there (ONE MODEL ?t=).
  const at = useRef(0);
  const openOnBmovies = (action?: Side) => {
    if (!BMOVIES_ONE_MODEL) return void openDappBrowser(clipPageUrl(c));
    // The same in-wallet webview as the bApps tile (one session, one sign-in), at the one film page.
    const url = filmUrl(c, at.current, action);
    void openBapp('bMovies', url).catch(() => openDappBrowser(url));
  };
  const share = () =>
    void shareLink({
      title: c.title,
      text: c.ticker ? `${c.title} $${c.ticker} on ${t.name}` : c.title,
      url: clipPageUrl(c),
    });

  // Horizontal swipe on the clip = 1p trade (right buys, left sells). Vertical is the reel's scroll.
  const start = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const p = e.touches[0];
    start.current = p && e.touches.length === 1 ? { x: p.clientX, y: p.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const s0 = start.current;
    const p = e.changedTouches[0];
    start.current = null;
    if (!BMOVIES_SWIPE_TRADE_ENABLED || !s0 || !p || !c.ticker || !c.registered) return;
    const side = tradeSide(p.clientX - s0.x, p.clientY - s0.y);
    if (side) onTrade(c, side);
  };
  // Long-press Buy/Sell = the same 1p quick trade; a tap opens bmovies.app's trade page.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const pressProps = (side: Side) => ({
    onPointerDown: () => {
      if (!BMOVIES_SWIPE_TRADE_ENABLED) return;
      const st = {
        fired: false,
        timer: setTimeout(() => {
          st.fired = true;
          onTrade(c, side);
        }, 500),
      };
      press.current = st;
    },
    onPointerUp: () => press.current && clearTimeout(press.current.timer),
    onPointerLeave: () => press.current && clearTimeout(press.current.timer),
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick: () => {
      if (press.current?.fired) return;
      openOnBmovies(side);
    },
  });

  return (
    <div
      data-i={i}
      data-trade-reel={BMOVIES_SWIPE_TRADE_ENABLED || undefined}
      onTouchStart={BMOVIES_SWIPE_TRADE_ENABLED ? onTouchStart : undefined}
      onTouchEnd={BMOVIES_SWIPE_TRADE_ENABLED ? onTouchEnd : undefined}
      className="relative w-full overflow-hidden"
      style={{ height: '100%', scrollSnapAlign: 'start' }}
    >
      <TitleCard c={c} t={t} />
      {shownPoster && near && (
        <img
          src={shownPoster}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          decoding="async"
          onError={() => setPosterBroken(true)}
        />
      )}
      {/* No poster yet: the clip's first frame, only for the slide just above (metadata only). */}
      {!shownPoster && near && !playing && !preloading && (
        <video
          src={firstFrameUrl(c.src)}
          preload="metadata"
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {(playing || preloading) && (
        <video
          ref={video}
          src={c.src}
          poster={shownPoster ?? undefined}
          preload={playing ? 'auto' : 'metadata'}
          autoPlay={playing}
          muted={muted}
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          onClick={onToggleSound}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            at.current = v.currentTime;
            if (playing && v.duration > 0) setProgress(v.currentTime / v.duration);
          }}
        />
      )}
      {/* Scrims, as on bmovies.app: a short one at the top, the tall one carrying the overlay. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-28"
        style={{ background: 'linear-gradient(rgba(0,0,0,0.7), transparent)' }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-72"
        style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.6) 40%, #000)' }}
      />
      {/* Sound: top-left, like bmovies.app. */}
      <button
        onClick={onToggleSound}
        aria-label={muted ? 'Sound on' : 'Sound off'}
        className="absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-full"
        style={{
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid rgba(255,255,255,0.2)',
          backdropFilter: 'blur(12px)',
        }}
      >
        {muted ? <VolumeX size={17} color="#fff" /> : <Volume2 size={17} color="#fff" />}
      </button>
      <div className="absolute inset-x-0 bottom-0 px-4 pb-3 pt-4">
        <Attribution c={c} t={t} />
        {c.blurb && (
          <p className="mt-2 text-[13px] leading-snug line-clamp-3" style={{ color: '#bbb' }}>
            {c.blurb}
          </p>
        )}
        <button onClick={() => openOnBmovies()} className="mt-2 block w-full text-left" style={{ fontFamily: BEBAS }}>
          <span className="block text-[30px] uppercase leading-none tracking-[0.03em] text-white line-clamp-2">
            {c.title}
          </span>
          {c.ticker && c.registered && (
            <span
              className="mt-1 block text-[22px] uppercase leading-none tracking-[0.03em]"
              style={{ color: t.ticker }}
            >
              ${c.ticker}
            </span>
          )}
        </button>
        <div className="mt-3 flex items-center gap-2">
          {c.registered && c.ticker ? (
            <>
              {/* Tap: the clip's trade page on bmovies.app. Long-press (or swipe →/←): a 1p quick trade. */}
              <button
                {...pressProps('buy')}
                aria-label={`Buy $${c.ticker} on ${t.name}`}
                className="min-w-0 flex-1 basis-0 select-none overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-3 py-2 text-center text-[18px] uppercase tracking-[0.06em] active:opacity-70"
                style={{
                  fontFamily: BEBAS,
                  background: '#0c0c0c',
                  border: `1px solid ${BM_GREEN_EDGE}`,
                  color: BM_GREEN,
                }}
              >
                Buy
              </button>
              <button
                {...pressProps('sell')}
                aria-label={`Sell $${c.ticker} on ${t.name}`}
                className="min-w-0 flex-1 basis-0 select-none overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-3 py-2 text-center text-[18px] uppercase tracking-[0.06em] active:opacity-70"
                style={{ fontFamily: BEBAS, background: '#0c0c0c', border: `1px solid ${BM_RED_EDGE}`, color: BM_RED }}
              >
                Sell
              </button>
            </>
          ) : notYours ? (
            <span
              aria-disabled="true"
              className="min-w-0 flex-1 select-none overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-3 py-2 text-center text-[18px] uppercase tracking-[0.06em]"
              style={{ fontFamily: BEBAS, background: '#0c0c0c', border: `1px solid ${BM_YELLOW}`, color: BM_YELLOW }}
            >
              Only @{notYours} can register this
            </span>
          ) : (
            <button
              onClick={() => onRegister(c)}
              disabled={registering}
              aria-label="Is this yours? Register it on chain"
              className="min-w-0 flex-1 select-none overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-3 py-2 text-center text-[18px] uppercase tracking-[0.06em] active:opacity-70 disabled:opacity-60"
              style={{ fontFamily: BEBAS, background: BM_YELLOW, color: '#1a1300' }}
            >
              {registering ? 'Checking…' : 'Register'}
            </button>
          )}
          <button
            onClick={share}
            aria-label="Share"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-md active:opacity-70"
            style={{ background: '#0c0c0c', border: '1px solid rgba(255,255,255,0.2)' }}
          >
            <Share2 size={16} color="#fff" />
          </button>
        </div>
        {BMOVIES_SWIPE_TRADE_ENABLED && c.registered && c.ticker ? (
          <p className="mt-2 text-center text-[10px]" style={{ color: MUTED }}>
            Swipe → buy 1p · ← sell 1p{BMOVIES_SWIPE_TRADE_MOCK ? ' · practice mode, no money moves' : ''}
          </p>
        ) : (
          <p className="mt-2 text-center text-[11px]" style={{ color: MUTED }}>
            Is this yours? Sign in with X to prove it, then register it on chain.
          </p>
        )}
        {/* Scrubber: fills left to right as the clip plays (white on white/25, 3px). */}
        <div className="mb-1 mt-3 h-[3px] w-full rounded-full" style={{ background: 'rgba(255,255,255,0.25)' }}>
          <div className="h-full rounded-full bg-white" style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
        </div>
      </div>
    </div>
  );
};

const BmoviesReel = ({ brand = 'bmovies' }: { brand?: keyof typeof THEMES }) => {
  const t = THEMES[brand];
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [next, setNext] = useState<Cursors | null>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  // The phone layout keeps the Feed mounted while another page is on screen: then, or in the background, no media.
  const offScreen = useInPeek();
  const appVisible = useAppVisible();
  const shown = !offScreen && appVisible;
  useReelDevLog(brand, shown && clips?.length ? Math.min(clips.length, active + 2) - Math.max(0, active - 1) : 0);
  const [height, setHeight] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const loading = useRef(false);

  // Swipe trading: the daily budget, the (mock) trades, the toast with Undo, the one-time ask.
  const [budget, setBudgetState] = useState<Budget>(() => loadBudget(Date.now()));
  const [trades, setTradesState] = useState<SwipeTrade[]>(() => loadTrades());
  const [toast, setToast] = useState<{ trade?: SwipeTrade; text: string; tone: 'buy' | 'sell' | 'info' } | null>(null);
  const [asking, setAsking] = useState<{ c: Clip; side: Side } | null>(null);
  const [showSwipes, setShowSwipes] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // REGISTER (claim.ts): who the server said a clip belongs to, the clip being checked, the sheet.
  const { apiContext } = useServiceContext();
  const [notYours, setNotYours] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [registerAsk, setRegisterAsk] = useState<{ c: Clip; tweetId: string; author: string } | null>(null);
  const [registerBusy, setRegisterBusy] = useState('');
  const [registerError, setRegisterError] = useState('');
  const budgetRef = useRef(budget);
  const setBudget = (b: Budget) => {
    budgetRef.current = b;
    setBudgetState(b);
    saveBudget(b);
  };
  const setTrades = (f: (t: SwipeTrade[]) => SwipeTrade[]) =>
    setTradesState((have) => {
      const next = f(have);
      saveTrades(next);
      return next;
    });
  const flash = (v: NonNullable<typeof toast>) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(v);
    toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
  };
  useEffect(() => () => void (toastTimer.current && clearTimeout(toastTimer.current)), []);

  const markRegistered = (id: string, ticker: string) =>
    setClips(
      (have) => have?.map((x) => (x.id === id ? { ...x, registered: true, ticker: ticker || x.ticker } : x)) ?? have,
    );

  /** REGISTER: ask bit-sign what this viewer may do with this clip (see claim.ts). */
  const onRegister = async (c: Clip) => {
    // ONE MODEL: one claim path, bmovies.app /claim/<offerId> (or /tweet/<id>), in the bApps webview.
    if (BMOVIES_ONE_MODEL) {
      const url = registerUrl(c);
      return void openBapp('bMovies', url).catch(() => openDappBrowser(url));
    }
    const tweetId = clipTweetId(c);
    // No X post behind it (a bMovies original): its own claim page on bmovies.app, as before.
    if (!tweetId) return void openDappBrowser(registerUrl(c));
    setChecking(c.id);
    try {
      const e = await checkClaim(apiContext, tweetId);
      if (e.status === 'claimed') {
        markRegistered(c.id, e.claim.ticker);
        flash({ text: `Already registered as $${e.claim.ticker}`, tone: 'info' });
      } else if (e.status === 'not_author') {
        setNotYours((m) => ({ ...m, [c.id]: e.author }));
      } else if (e.status === 'connect_x' || e.status === 'sign_in') {
        flash({ text: `Sign in with X as @${e.author} to prove it's yours, then tap Register again.`, tone: 'info' });
        void openDappBrowser(await xConnectUrl(apiContext));
      } else if (e.status === 'eligible') {
        setRegisterError('');
        setRegisterAsk({ c, tweetId, author: e.author });
      } else {
        flash({ text: "X doesn't know this post any more.", tone: 'info' });
      }
    } catch (err) {
      flash({ text: err instanceof Error ? err.message : "Couldn't check just now.", tone: 'info' });
    } finally {
      setChecking(null);
    }
  };

  const allowRegister = async () => {
    if (!registerAsk || registerBusy) return;
    setRegisterBusy('Registering on chain…');
    setRegisterError('');
    try {
      const k = await registerClip(apiContext, registerAsk.c, registerAsk.tweetId);
      markRegistered(registerAsk.c.id, k.ticker);
      setRegisterAsk(null);
      haptic('medium');
      flash({ text: `Registered as $${k.ticker}. BUY / SELL are live.`, tone: 'buy' });
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : 'Registration did not complete');
    } finally {
      setRegisterBusy('');
    }
  };

  const doTrade = async (c: Clip, side: Side, b: Budget) => {
    if (!c.ticker || !c.registered) return;
    const now = Date.now();
    const trade = await executeTrade(c.ticker, side, now);
    setBudget(spend(b, now));
    setTrades((have) => addTrade(have, trade));
    haptic(side === 'buy' ? 'medium' : 'light');
    flash({ trade, text: `${side === 'buy' ? '+' : '−'}1p $${c.ticker}`, tone: side });
  };
  const onTrade = (c: Clip, side: Side) => {
    const b = budgetRef.current;
    const verdict = checkBudget(b, Date.now());
    if (verdict === 'ask') return setAsking({ c, side });
    if (verdict === 'denied') return flash({ text: 'Swipe trades are off', tone: 'info' });
    if (verdict === 'over') return flash({ text: "Today's swipe budget is used", tone: 'info' });
    void doTrade(c, side, b);
  };
  const undo = (trade: SwipeTrade) => {
    setTrades((have) => removeTrade(have, trade.id));
    setBudget(spend(budgetRef.current, Date.now(), -trade.pence));
    haptic('light');
    flash({ text: 'Undone', tone: 'info' });
  };
  const answer = (yes: boolean) => {
    const pending = asking;
    setAsking(null);
    const b = { ...budgetRef.current, allowed: yes };
    setBudget(b);
    if (yes && pending) void doTrade(pending.c, pending.side, b);
  };

  // The reel fills the screen between the Feed header and the tab bar (--dock-h) + the home-indicator
  // inset, so Buy/Sell and the scrubber always sit above the tab bar on every iPhone.
  useLayoutEffect(() => {
    const fit = () => {
      const top = box.current?.getBoundingClientRect().top ?? 0;
      setHeight(Math.max(0, top));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Every source in the theme (plain bMovies is one), merged and deduped, newest first per page.
  const load = useCallback(
    async (cursors: Cursors | null) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const page = await fetchMerged(t.sources, cursors ?? {});
        // Clips their original poster registered through bWalletX (bit-sign claims) trade too.
        const claims = await fetchClaims(page.clips.map(clipTweetId).filter((x): x is string => !!x));
        const clipsNow = applyClaims(page.clips, claims, clipTweetId);
        setClips((have) => (cursors && have ? appendPage(have, clipsNow) : clipsNow));
        setNext(page.more ? page.cursors : null);
        setError('');
      } catch {
        if (!cursors) setError(`Couldn't reach ${t.name} just now.`);
      } finally {
        loading.current = false;
      }
    },
    [t],
  );

  useEffect(() => {
    void loadBebas();
    void load(null);
  }, [load]);

  // The slide most on screen is the active one.
  useEffect(() => {
    const root = box.current;
    if (!root || !clips?.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i ?? 0));
      },
      { root, threshold: 0.6 },
    );
    root.querySelectorAll('[data-i]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [clips]);

  // Near the end: the next page.
  useEffect(() => {
    if (clips && next && active >= clips.length - 3) void load(next);
  }, [active, clips, next, load]);

  return (
    <div className="relative w-full">
      <div
        ref={box}
        className="w-full overflow-y-auto"
        style={{
          height:
            height === null
              ? '70vh'
              : `max(320px, calc(100dvh - ${height}px - var(--dock-h, 3.75rem) - env(safe-area-inset-bottom, 0px)))`,
          scrollSnapType: 'y mandatory',
          overscrollBehavior: 'contain',
          background: '#010101',
        }}
      >
        {clips === null && !error && (
          <div className="relative h-full w-full">
            <div className="absolute inset-0 animate-pulse" style={{ background: t.backdrop }} />
          </div>
        )}
        {error && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="text-sm font-semibold text-white">{error}</p>
            <button
              onClick={() => void openDappBrowser(t.home)}
              className="flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-bold"
              style={{ background: t.accent, color: t.onAccent }}
            >
              Open bmovies.app <ExternalLink size={14} />
            </button>
          </div>
        )}
        {clips?.length === 0 && (
          <p className="pt-20 text-center text-sm" style={{ color: MUTED }}>
            No clips yet.
          </p>
        )}
        {clips?.map((c, i) => (
          <Slide
            key={c.id}
            t={t}
            c={c}
            i={i}
            active={active}
            shown={shown}
            muted={muted}
            onToggleSound={() => setMuted((m) => !m)}
            onTrade={onTrade}
            onRegister={(x) => void onRegister(x)}
            notYours={notYours[c.id]}
            registering={checking === c.id}
          />
        ))}
      </div>
      {/* My swipes: top-right. */}
      {BMOVIES_SWIPE_TRADE_ENABLED && (
        <button
          onClick={() => setShowSwipes(true)}
          aria-label="My swipes"
          className="absolute right-3 top-3 flex h-9 items-center gap-1 rounded-full px-3 text-[12px] font-semibold text-white"
          style={{
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid rgba(255,255,255,0.2)',
            backdropFilter: 'blur(12px)',
          }}
        >
          <History size={14} /> {trades.length}
        </button>
      )}
      {registerAsk && (
        <RegisterSheet
          title={registerAsk.c.title}
          ticker={claimTicker(registerAsk.c)}
          author={registerAsk.author}
          busy={registerBusy}
          error={registerError}
          onAllow={() => void allowRegister()}
          onCancel={() => !registerBusy && setRegisterAsk(null)}
        />
      )}
      {toast && (
        <div
          role="status"
          className="absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-3 rounded-full px-4 py-2 text-[15px] font-bold"
          style={{
            background: toast.tone === 'buy' ? '#0f2e18' : toast.tone === 'sell' ? '#3a1010' : 'rgba(0,0,0,0.8)',
            border: `1px solid ${toast.tone === 'buy' ? BM_GREEN_EDGE : toast.tone === 'sell' ? BM_RED_EDGE : '#333'}`,
            color: toast.tone === 'buy' ? BM_GREEN : toast.tone === 'sell' ? BM_RED : '#fff',
          }}
        >
          {toast.text}
          {toast.trade && (
            <button
              onClick={() => undo(toast.trade as SwipeTrade)}
              className="text-[13px] underline"
              style={{ color: '#fff' }}
            >
              Undo
            </button>
          )}
        </div>
      )}
      {asking && (
        <div className="absolute inset-0 flex items-end bg-black/60" onClick={() => answer(false)}>
          <div
            className="w-full rounded-t-2xl p-5"
            style={{ background: '#111', paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[17px] font-bold text-white">
              Allow 1p trades from swipes, up to £{(DEFAULT_DAILY_BUDGET_PENCE / 100).toFixed(2)} a day?
            </p>
            <p className="mt-1 text-[13px]" style={{ color: MUTED }}>
              Swipe right to buy 1p of a clip's token, left to sell 1p. Undo within 3 seconds.
              {BMOVIES_SWIPE_TRADE_MOCK && ' Practice mode for now: trades are kept on this phone and no money moves.'}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => answer(false)}
                className="flex-1 rounded-lg py-3 font-semibold text-white"
                style={{ border: '1px solid #333' }}
              >
                Not now
              </button>
              <button
                onClick={() => answer(true)}
                className="flex-1 rounded-lg py-3 font-bold"
                style={{ background: t.accent, color: t.onAccent }}
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
      {showSwipes && (
        <div className="absolute inset-0 flex items-end bg-black/60" onClick={() => setShowSwipes(false)}>
          <div
            className="max-h-[70%] w-full overflow-y-auto rounded-t-2xl p-5"
            style={{ background: '#111', paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[17px] font-bold text-white">My swipes{BMOVIES_SWIPE_TRADE_MOCK ? ' (practice)' : ''}</p>
            <p className="mt-1 text-[12px]" style={{ color: MUTED }}>
              Today {budget.spentPence}p of £{(budget.dailyPence / 100).toFixed(2)}
            </p>
            {trades.length === 0 && (
              <p className="mt-4 text-[13px]" style={{ color: MUTED }}>
                No swipes yet. Swipe a clip right to buy 1p, left to sell 1p.
              </p>
            )}
            <ul className="mt-3 divide-y divide-white/10">
              {trades.map((tr) => (
                <li key={tr.id} className="flex items-center gap-3 py-2 text-[14px]">
                  <span className="w-10 font-bold" style={{ color: tr.side === 'buy' ? BM_GREEN : BM_RED }}>
                    {tr.side === 'buy' ? 'BUY' : 'SELL'}
                  </span>
                  <span className="flex-1 font-semibold" style={{ color: t.ticker }}>
                    ${tr.ticker}
                  </span>
                  <span className="text-white">{tr.pence}p</span>
                  <span className="w-14 text-right text-[12px]" style={{ color: MUTED }}>
                    {new Date(tr.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};

export default BmoviesReel;
