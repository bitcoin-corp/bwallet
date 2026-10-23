/**
 * Feed › bExchange (bWalletX only, BEX_REEL_ENABLED): one full-screen card per token the Exchange lists (the 1Sat
 * BSV-21 board, Launchpad coins and people's tokens), snap scrolling like the bMovies reel. Each card: the token's
 * art (or the creator's own advert video, labelled "made by the creator"), name and ticker, price, 24h change, a
 * sparkline, equal-width green BUY / red SELL (both open the token's Exchange page, where every trade gets its one
 * approval sheet) and the risk line.
 *
 * De minimis (owner, 15 Oct 2026): neutral user-chosen sorts only (New by default, 24h change, 24h volume, holders,
 * A–Z), no "Pumping / Hot / Trending", no flames or rockets, no featured coins, no paid placement, no price push
 * notifications. Only the card on screen plays video and refreshes its price.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { hotBoard, mergeTokenBoard, roomMarket, tokenDirectory, type HotRoom } from '../../market/indexer';
import { refreshSafety, safety } from '../../market/safety';
import {
  chainTip,
  changeLabel,
  dayStats,
  fiatLabel,
  tokenTrades,
  tradeRoute,
  unitPriceLabel,
} from '../../exchange/exchangeData';
import type { DayStats, Trade } from '../../exchange/exchangeData';
import { localLaunches, type Launch } from '../../exchange/launch/launch';
import { registryLaunches } from '../../exchange/launch/launchNet';
import { usePeopleTokens } from '../../exchange/usePeopleTokens';
import { TokenIcon } from '../../exchange/TokenIcon';
import { useBsvUsd } from '../../money/money';
import {
  RISK_LINE,
  TOKEN_SORTS,
  mergeTokens,
  sortTokens,
  sparkPath,
  sparkline,
  type TokenCard,
  type TokenSort,
} from './bexCards';
import { useReel } from './useReel';
import { FundLike } from './FundLike';
import {
  isActiveOnMarket,
  marketActivity,
  withTokenEvidence,
  type MarketActivity,
} from '../../exchange/marketActivity';
import { inReelWindow, useAppVisible, useReelDevLog, useReelVideo } from '../reelMemory';
import { useInPeek } from '../../phone/pageEl';

const GOLD = '#FFD24D';
const MUTED = '#a3a8b0';
const GREEN = '#6bff8a';
const GREEN_EDGE = 'rgba(47,175,90,0.8)';
const RED = '#ff5c5c';
const RED_EDGE = 'rgba(220,60,60,0.8)';
const BACKDROP = 'radial-gradient(circle at 50% 35%, #3a2a00 0%, #120d00 55%, #010101 100%)';
/** The card on screen refreshes this often (the indexer cache decides when a fetch really goes out). */
const LIVE_MS = 30_000;
/** Cards whose 24h stats load up front, so the change / volume sorts have data. */
const STATS_CAP = 80;

const tokenSafe = (r: HotRoom) =>
  !safety().check({ ids: [r.ref.id], collectionId: null, texts: [r.title, r.subtitle], map: r.map }).blocked;

type Live = { stats: DayStats; trades: Trade[]; floor: number | null };

const loadLive = async (id: string): Promise<Live> => {
  const [tip, trades, m] = await Promise.all([
    chainTip(),
    tokenTrades(id),
    roomMarket({ kind: 'bsv21', id, key: `bsv21:${id}` }).catch(() => null),
  ]);
  return { stats: dayStats(trades, tip), trades, floor: m?.floorSats ?? null };
};

const Spark = ({ trades, up }: { trades: Trade[]; up: boolean }) => {
  const pts = sparkline(trades);
  if (!pts.length) return <div className="h-10" />;
  return (
    <svg viewBox="0 0 200 40" className="h-10 w-full" preserveAspectRatio="none" aria-hidden="true">
      <path d={sparkPath(pts, 200, 40)} fill="none" stroke={up ? GREEN : RED} strokeWidth="2" />
    </svg>
  );
};

/** Art only within the reel window (reelMemory.ts); further away the card is just its backdrop. */
const Art = ({ c, near, playing }: { c: TokenCard; near: boolean; playing: boolean }) => {
  const video = useReelVideo(playing);
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ background: BACKDROP }}>
      {!near ? null : c.icon?.startsWith('https://') ? (
        <img src={c.icon} alt="" decoding="async" className="h-36 w-36 rounded-full object-cover" />
      ) : (
        <TokenIcon icon={c.icon} sym={c.ticker} size={144} />
      )}
      {c.video && playing && (
        <>
          <video
            ref={video}
            src={c.video}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <span
            className="absolute left-3 top-14 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white"
            style={{ background: 'rgba(0,0,0,0.55)' }}
          >
            Advert made by the creator
          </span>
        </>
      )}
    </div>
  );
};

const TokenSlide = ({
  c,
  i,
  active,
  shown,
  live,
  rate,
}: {
  c: TokenCard;
  i: number;
  active: number;
  shown: boolean;
  live: Live | undefined;
  rate: number;
}) => {
  const navigate = useNavigate();
  const price = live?.stats.last ?? live?.floor ?? null;
  const ch = live?.stats.change ?? null;
  const trade = () => navigate(tradeRoute(c.id));
  const btn =
    'min-w-0 flex-1 basis-0 select-none rounded-md px-3 py-2.5 text-center text-[16px] font-extrabold uppercase tracking-[0.06em] active:opacity-70';
  return (
    <div data-i={i} className="relative w-full overflow-hidden" style={{ height: '100%', scrollSnapAlign: 'start' }}>
      <Art c={c} near={inReelWindow(i, active, shown)} playing={shown && i === active} />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[60%]"
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.94), rgba(0,0,0,0))' }}
      />
      <div className="absolute inset-x-0 bottom-0 px-4 pb-4">
        <div className="truncate text-[20px] font-extrabold text-white">{c.name}</div>
        <div className="text-[15px] font-bold" style={{ color: GOLD }}>
          ${c.ticker}
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div>
            <div className="text-[18px] font-bold text-white">
              {live ? (price === null ? '—' : unitPriceLabel(price)) : '…'}
            </div>
            {price !== null && fiatLabel(price, rate) && (
              <div className="text-[11px]" style={{ color: MUTED }}>
                {fiatLabel(price, rate)}
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-[15px] font-bold" style={{ color: ch === null ? MUTED : ch >= 0 ? GREEN : RED }}>
              {live ? changeLabel(ch) : '…'}
            </div>
            <div className="text-[11px]" style={{ color: MUTED }}>
              24h
            </div>
          </div>
        </div>
        <div className="mt-1">
          <Spark trades={live?.trades ?? []} up={(ch ?? 0) >= 0} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <FundLike tokenId={c.id} ticker={c.ticker} rate={rate} />
          <button
            onClick={trade}
            aria-label={`Buy $${c.ticker}`}
            className={btn}
            style={{ background: '#0c0c0c', border: `1px solid ${GREEN_EDGE}`, color: GREEN }}
          >
            Buy
          </button>
          <button
            onClick={trade}
            aria-label={`Sell $${c.ticker}`}
            className={btn}
            style={{ background: '#0c0c0c', border: `1px solid ${RED_EDGE}`, color: RED }}
          >
            Sell
          </button>
        </div>
        <p className="m-0 mt-2 text-center text-[11px]" style={{ color: MUTED }}>
          {RISK_LINE}
        </p>
      </div>
    </div>
  );
};

const BexReel = () => {
  const rate = useBsvUsd();
  const [sort, setSort] = useState<TokenSort>('new');
  const [board, setBoard] = useState<HotRoom[] | null>(null);
  const [launches, setLaunches] = useState<Launch[]>(() => localLaunches());
  const people = usePeopleTokens();
  const [live, setLive] = useState<Record<string, Live>>({});
  const [statsDone, setStatsDone] = useState(0);
  // Default: only tokens with an active listing or a trade in the last 30 days on 1sat.market.
  const [activeOnly, setActiveOnly] = useState(true);
  const [activity, setActivity] = useState<MarketActivity | null | 'error'>(null);

  useEffect(() => {
    let on = true;
    void marketActivity()
      .then((a) => on && setActivity(a))
      .catch(() => on && setActivity('error'));
    return () => {
      on = false;
    };
  }, []);

  // A card's own live data (a floor or its trades) also counts as activity.
  useEffect(() => {
    setActivity((a) => {
      if (!a || a === 'error') return a;
      let next = a;
      for (const [id, l] of Object.entries(live))
        next = withTokenEvidence(next, id, {
          listed: l.floor !== null,
          lastTradeHeight: l.trades.length ? l.trades[l.trades.length - 1].height : null,
        });
      return next;
    });
  }, [live]);

  useEffect(() => {
    let on = true;
    void refreshSafety();
    void Promise.all([hotBoard().catch(() => []), tokenDirectory().catch(() => [])]).then(([rooms, dir]) => {
      if (on) setBoard(mergeTokenBoard(rooms, dir).filter((r) => r.ref.kind === 'bsv21' && tokenSafe(r)));
    });
    void registryLaunches().then((reg) => {
      if (!on || !reg.length) return;
      const by = new Map(localLaunches().map((l) => [l.tokenId, l]));
      for (const l of reg) by.set(l.tokenId, l);
      setLaunches([...by.values()]);
    });
    return () => {
      on = false;
    };
  }, []);

  const allCards = useMemo(
    () =>
      mergeTokens(
        (board ?? []).map((r) => ({ id: r.ref.id, title: r.title, icon: r.icon, outputs: r.outputs })),
        launches,
        people ?? [],
      ),
    [board, launches, people],
  );
  // When 1sat.market can't be reached, show everything rather than nothing (and say so).
  const filtering = activeOnly && activity !== 'error';
  const cards = useMemo(
    () => (!filtering ? allCards : activity ? allCards.filter((c) => isActiveOnMarket(c.id, activity)) : []),
    [allCards, filtering, activity],
  );
  const waiting = board === null || (filtering && activity === null);

  // 24h stats for the first cards (once each, cached by the indexer), so change / volume sorts have data.
  const statsKey = cards
    .slice(0, STATS_CAP)
    .map((c) => c.id)
    .join(',');
  useEffect(() => {
    let on = true;
    const queue = statsKey ? statsKey.split(',') : [];
    const worker = async () => {
      for (let id = queue.shift(); id && on; id = queue.shift()) {
        const l = await loadLive(id).catch(() => null);
        if (on && l) setLive((x) => (x[id] ? x : { ...x, [id]: l }));
      }
    };
    void Promise.all([worker(), worker(), worker()]).then(() => on && setStatsDone((n) => n + 1));
    return () => {
      on = false;
    };
  }, [statsKey]);

  const stats = useMemo(() => Object.fromEntries(Object.entries(live).map(([k, v]) => [k, v.stats])), [live]);
  // Sort order is set when the sort is picked, the list grows or the up-front stats finish; not on every price tick.
  const order = useMemo(
    () => sortTokens(cards, sort, stats).map((c) => c.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cards, sort, statsDone],
  );
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const sorted = order.map((id) => byId.get(id)).filter((c): c is TokenCard => !!c);
  const { box, style, active, toTop } = useReel(sorted.length);
  const offScreen = useInPeek();
  const appVisible = useAppVisible();
  const shown = !offScreen && appVisible;
  useReelDevLog('bExchange', shown ? sorted.filter((_, i) => inReelWindow(i, active)).length : 0);

  // Only the card on screen refreshes its price.
  const activeId = sorted[active]?.id;
  useEffect(() => {
    if (!activeId) return;
    let on = true;
    const tick = () =>
      void loadLive(activeId)
        .then((l) => on && setLive((x) => ({ ...x, [activeId]: l })))
        .catch(() => undefined);
    tick();
    const t = setInterval(tick, LIVE_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [activeId]);

  return (
    <div className="relative w-full">
      <div ref={box} className="w-full overflow-y-auto" style={style}>
        {waiting && <div className="h-full w-full animate-pulse" style={{ background: BACKDROP }} />}
        {!waiting && !sorted.length && (
          <p className="pt-24 text-center text-sm" style={{ color: MUTED }}>
            {filtering ? 'No tokens active on 1sat.market right now.' : 'No tokens to show yet.'}
          </p>
        )}
        {sorted.map((c, i) => (
          <TokenSlide key={c.id} c={c} i={i} active={active} shown={shown} live={live[c.id]} rate={rate} />
        ))}
      </div>
      <div className="absolute inset-x-0 top-0 flex flex-wrap gap-2 px-3 pt-3" role="tablist" aria-label="Sort">
        {TOKEN_SORTS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={sort === s.id}
            onClick={() => {
              setSort(s.id);
              toTop();
            }}
            className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold"
            style={
              sort === s.id
                ? { background: GOLD, color: '#1a1300' }
                : {
                    background: 'rgba(0,0,0,0.45)',
                    border: '1px solid rgba(255,255,255,0.2)',
                    color: '#fff',
                    backdropFilter: 'blur(12px)',
                  }
            }
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="absolute inset-x-0 top-12 flex items-center gap-2 px-3" role="group" aria-label="Filter">
        {[
          { on: true, label: 'Active on 1sat.market' },
          { on: false, label: 'Show all' },
        ].map((f) => (
          <button
            key={f.label}
            aria-pressed={activeOnly === f.on}
            onClick={() => {
              setActiveOnly(f.on);
              toTop();
            }}
            className="shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold"
            style={
              activeOnly === f.on
                ? { background: 'rgba(255,210,77,0.18)', border: `1px solid ${GOLD}`, color: GOLD }
                : {
                    background: 'rgba(0,0,0,0.45)',
                    border: '1px solid rgba(255,255,255,0.2)',
                    color: '#fff',
                    backdropFilter: 'blur(12px)',
                  }
            }
          >
            {f.label}
          </button>
        ))}
        {activeOnly && activity === 'error' && (
          <span className="text-[11px]" style={{ color: MUTED }}>
            1sat.market unreachable, showing all
          </span>
        )}
      </div>
    </div>
  );
};

export default BexReel;
