import { useWithoutHidden } from '../albums/useAlbums';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { invertOnLightClass } from './invertOnLight';
import { useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Home, LayoutGrid, Pause, Play, Users } from 'lucide-react';
import { useBackClose } from '../backStack';
import { Blurred } from '../market/NftCard';
import { MediaViewer } from './MediaViewer';
import { getState, pauseAudio, playQueue, subscribe, toggle, type Track } from './player';
import { YourPodcasts } from '../bradio/YourPodcasts';
import { FEATURED_TRACKS, featuredQueue, HEADLINE_ALBUM, type FeaturedTrack } from './featured/featured';
import { VEXVOID_STILLS } from './featured/stills';
import { StillsBanner } from './featured/StillsBanner';
import { albumBlocks } from './albumLayout';
import { playMusic, useWalletMedia, type MediaItem } from './useWalletMedia';
import { useReleases } from './releases/useReleases';
import type { Release } from './releases/releases';
import { PAY_STREAM_ENABLED, RELEASES_ENABLED } from '../storeBuild';
import { TopNav } from '../../components/TopNav';
import { PullToRefresh } from '../ui/PullToRefresh';
import { ErrorActions } from '../errors/ErrorActions';

/**
 * /m/media — a music store front in bWalletX black and gold: a banner of featured square covers,
 * shelves of square covers, a song list and a release page. Only real content: the free featured
 * tracks (featured.ts), releases published with bwallet-media MAP tags (releases.ts) and the wallet's
 * own music / video inscriptions. No purchase path exists for this media yet, so every button is
 * Free / Listen / Play (owned) — no prices. Square covers everywhere; items without a cover get
 * generated gold square art, never a grey box.
 */
// bWalletX only: absent from a store build (PAY_STREAM_ENABLED).
const StreamAlbum = PAY_STREAM_ENABLED ? lazy(() => import('./stream/StreamAlbum')) : null;
const FeaturedTracks = PAY_STREAM_ENABLED ? lazy(() => import('./stream/FeaturedTracks')) : null;

/** Page layout: Cards (banner + shelves), List (tracks only), Hybrid (banner with tracks + track list). */
type View = 'cards' | 'list' | 'hybrid';
const VIEWS: { id: View; label: string }[] = [
  { id: 'cards', label: 'Cards' },
  { id: 'list', label: 'List' },
  { id: 'hybrid', label: 'Hybrid' },
];
const VIEW_KEY = 'bwx.media.view';

/** Store history: Back / Forward ride the router (history.state.idx), so the browser buttons agree. */
const MEDIA_HOME = '/m/media';
const albumPath = (id: string) => `${MEDIA_HOME}/album/${encodeURIComponent(id)}`;
let maxIdx = 0;
const historyIdx = (): number => {
  const st = typeof window !== 'undefined' ? (window.history.state as { idx?: number } | null) : null;
  return typeof st?.idx === 'number' ? st.idx : 0;
};
const readView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'cards' || v === 'list' || v === 'hybrid' ? v : 'hybrid';
  } catch {
    return 'hybrid';
  }
};

const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#111216';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
const RADIUS = 6;

/** One playable thing on the page, whatever its source. */
type Entry = {
  id: string;
  title: string;
  artist: string;
  cover?: string;
  free: boolean;
  kind: 'music' | 'video';
  aiMade?: boolean;
  sub?: string;
  featured?: FeaturedTrack;
  item?: MediaItem;
  release?: Release;
};

type Filter = 'all' | 'music' | 'video';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'music', label: 'Music' },
  { id: 'video', label: 'Video' },
];

const fmt = (s?: number) =>
  s && isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '';

const usePlayer = () => {
  const [s, setS] = useState(getState);
  useEffect(() => subscribe(setS), []);
  return s;
};

/** Track lengths from the audio metadata (featured mp3s are small local assets). */
const useDurations = (tracks: readonly FeaturedTrack[]) => {
  const [d, setD] = useState<Record<string, number>>({});
  useEffect(() => {
    const els = tracks.map((t) => {
      const a = new Audio();
      a.preload = 'metadata';
      a.onloadedmetadata = () => setD((p) => ({ ...p, [t.id]: a.duration }));
      a.src = t.url;
      return a;
    });
    return () => els.forEach((a) => a.removeAttribute('src'));
  }, [tracks]);
  return d;
};

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Gold-by-default square art for items with no cover of their own. */
const GoldArt = ({ seed, title }: { seed: string; title: string }) => {
  const h = hash(seed);
  const glyph = (title.trim()[0] || 'b').toUpperCase();
  return (
    <div
      className="w-full h-full flex items-center justify-center"
      style={{
        background: `radial-gradient(circle at ${20 + (h % 60)}% ${20 + ((h >> 3) % 60)}%, var(--bw-accent-hi) 0%, #D9A520 28%, #5a420a 62%, #0b0b0b 100%)`,
      }}
    >
      <span className="font-black" style={{ color: '#0b0b0b', fontSize: '42cqw', lineHeight: 1, opacity: 0.85 }}>
        {glyph}
      </span>
    </div>
  );
};

/** A crisp 1:1 cover: real art when there is one, gold art otherwise. */
const Cover = ({ e, size }: { e: Entry; size?: number }) => (
  <div
    className="relative overflow-hidden shrink-0 aspect-square"
    style={{
      width: size ?? '100%',
      borderRadius: RADIUS,
      background: '#000',
      containerType: 'inline-size',
      boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
    }}
  >
    <Blurred forceBlur={!!e.item?.flagged}>
      {e.cover ? (
        <img
          src={e.cover}
          alt=""
          className={`w-full h-full object-cover${invertOnLightClass(e.artist)}`}
          loading="lazy"
        />
      ) : e.kind === 'video' && e.item ? (
        <video
          src={`${e.item.url}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          className="w-full h-full object-cover"
        />
      ) : (
        <GoldArt seed={e.id} title={e.title} />
      )}
    </Blurred>
    {e.aiMade && (
      <span
        className="absolute left-1.5 top-1.5 px-1.5 py-0.5 text-[9px] font-bold uppercase"
        style={{ background: 'rgba(0,0,0,0.7)', color: GOLD, borderRadius: 3 }}
      >
        AI-made
      </span>
    )}
  </div>
);

/** A release's tracks as rows: one Entry per track, sharing the release cover. */
const releaseTracks = (r: Release): Entry[] =>
  r.tracks.map((t, i) => ({
    id: `${r.origin}#${i}`,
    title: t.title,
    artist: r.artist,
    cover: r.coverUrl,
    free: true,
    kind: t.kind,
    aiMade: r.ai,
    release: r,
  }));

const releaseQueue = (r: Release): Track[] =>
  r.tracks
    .map((t, i) => ({ id: `${r.origin}#${i}`, title: `${t.title} · ${r.artist}`, url: t.url, artwork: r.coverUrl }))
    .filter((_, i) => r.tracks[i].kind === 'music');

const MediaPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const { albumId } = useParams();
  const browsing = location.pathname.endsWith('/media/browse');
  /** Album page opened from a track row: the manifest index to start playing. */
  const autoplay = (location.state as { autoplay?: number } | null)?.autoplay;
  const setRelease = (e: Entry | null) => (e ? navigate(albumPath(e.id)) : navigate(MEDIA_HOME));
  const idx = historyIdx();
  if (navType === 'PUSH' || idx > maxIdx) maxIdx = idx;
  const canForward = idx < maxIdx;
  const [view, setViewRaw] = useState<View>(readView);
  const setView = (v: View) => {
    setViewRaw(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* not remembered: fine */
    }
  };
  const close = () => navigate(-1);
  useBackClose(true, close);
  const { items: shownRaw, hasMore, loading, error, loadMore, reload } = useWalletMedia();
  const items = useWithoutHidden(shownRaw);
  const releases = useReleases();
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<MediaItem | null>(null);
  const [slide, setSlide] = useState(0);
  const player = usePlayer();
  const nowPlaying = player.queue[player.index];
  const durations = useDurations(FEATURED_TRACKS);

  const music = useMemo(() => items.filter((i) => i.kind === 'music'), [items]);
  const videos = useMemo(() => items.filter((i) => i.kind === 'video'), [items]);

  // bWalletX: one product, the album, led by its free headline track. Store builds (no paid streaming) keep the single.
  const free: Entry[] = useMemo(
    () =>
      StreamAlbum
        ? [
            {
              id: HEADLINE_ALBUM.id,
              title: HEADLINE_ALBUM.title,
              artist: HEADLINE_ALBUM.artist,
              cover: HEADLINE_ALBUM.cover,
              free: true,
              kind: 'music' as const,
              sub: 'Album · headline track free',
              featured: HEADLINE_ALBUM.headline,
            },
          ]
        : FEATURED_TRACKS.map((t) => ({
            id: t.id,
            title: t.title,
            artist: t.artist,
            cover: t.artwork,
            free: true,
            kind: 'music' as const,
            sub: t.label,
            featured: t,
          })),
    [],
  );
  const published: Entry[] = useMemo(
    () =>
      releases.map((r) => ({
        id: r.origin,
        title: r.title,
        artist: r.artist,
        cover: r.coverUrl,
        free: true,
        kind: r.tracks.some((t) => t.kind === 'music') ? ('music' as const) : ('video' as const),
        aiMade: r.ai,
        sub: [r.genre, r.tracks.length > 1 ? `${r.tracks.length} tracks` : 'Single'].filter(Boolean).join(' · '),
        release: r,
      })),
    [releases],
  );
  const own = (i: MediaItem): Entry => ({
    id: i.output.outpoint,
    title: i.name,
    artist: 'In your wallet',
    free: false,
    kind: i.kind === 'video' ? 'video' : 'music',
    item: i,
  });
  const myMusic = useMemo(() => music.map(own), [music]);
  const myVideo = useMemo(() => videos.map(own), [videos]);

  // The album / release page comes from the URL (/m/media/album/<id>), so it is shareable and Back works.
  const release: Entry | null = albumId
    ? ([...free, ...published, ...myMusic, ...myVideo].find((e) => e.id === albumId) ?? null)
    : null;

  // Escape, and a swipe from the left edge on phone width, go back (Android Back: useBackClose above).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (document.querySelector('[role="dialog"], .fixed.inset-0')) return;
      navigate(-1);
    };
    let sx = -1;
    let sy = 0;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      sx = window.innerWidth < 768 && t.clientX < 24 ? t.clientX : -1;
      sy = t.clientY;
    };
    const onEnd = (e: TouchEvent) => {
      if (sx < 0) return;
      const t = e.changedTouches[0];
      if (t.clientX - sx > 80 && Math.abs(t.clientY - sy) < 60) navigate(-1);
      sx = -1;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [navigate]);

  const play = (e: Entry) => {
    if (nowPlaying?.id === e.id || (e.featured && nowPlaying?.id === e.featured.id)) return toggle();
    if (e.featured) return playQueue(featuredQueue(e.featured), 0);
    if (e.release) {
      const q = releaseQueue(e.release);
      const at = Math.max(
        0,
        q.findIndex((t) => t.id === e.id),
      );
      if (q.length) return playQueue(q, at);
      return;
    }
    if (!e.item) return;
    if (e.item.kind === 'music') return playMusic(music, e.item);
    pauseAudio();
    setOpen(e.item);
  };
  const isPlaying = (e: Entry) =>
    player.playing &&
    !!nowPlaying &&
    (nowPlaying.id === e.id ||
      (!!e.featured && nowPlaying.id === e.featured.id) ||
      (!!e.release && e.id === e.release.origin && nowPlaying.id.startsWith(`${e.id}#`)));

  // Banner: free releases first, then published releases, then the wallet's own music; square covers only.
  const banner = useMemo(() => [...free, ...published, ...myMusic].slice(0, 5), [free, published, myMusic]);
  useEffect(() => {
    if (banner.length < 2) return;
    const t = setInterval(() => setSlide((s) => (s + 1) % banner.length), 7000);
    return () => clearInterval(t);
  }, [banner.length]);
  const hero = banner[slide % Math.max(banner.length, 1)];

  const PlayBtn = ({ e, big }: { e: Entry; big?: boolean }) => (
    <button
      aria-label={isPlaying(e) ? 'Pause' : 'Play'}
      onClick={(ev) => {
        ev.stopPropagation();
        play(e);
      }}
      className={`${big ? 'w-12 h-12' : 'w-9 h-9'} rounded-full flex items-center justify-center shrink-0`}
      style={{ background: GOLD }}
    >
      {isPlaying(e) ? (
        <Pause size={big ? 20 : 14} color="#1a1300" />
      ) : (
        <Play size={big ? 20 : 14} color="#1a1300" fill="#1a1300" />
      )}
    </button>
  );

  /** Right-hand button on a song row: Free for free tracks, Play for what the wallet already holds. */
  const PriceBtn = ({ e }: { e: Entry }) => (
    <button
      onClick={(ev) => {
        ev.stopPropagation();
        play(e);
      }}
      className="px-3 py-1 text-[11px] font-bold uppercase tracking-wide shrink-0"
      style={{ border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 4 }}
    >
      {e.free ? 'Free' : 'Play'}
    </button>
  );

  const openEntry = (e: Entry) => (e.kind === 'music' || e.release ? setRelease(e) : play(e));

  const shelf = (title: string, list: Entry[]) =>
    list.length > 0 && (
      <section className="flex flex-col gap-3" key={title}>
        <h2 className="flex items-baseline justify-between">
          <span className="text-base font-bold text-white">{title}</span>
          <span className="text-[11px]" style={{ color: MUTED }}>
            {list.length} {list.length === 1 ? 'item' : 'items'}
          </span>
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {list.map((e) => (
            <button key={e.id} onClick={() => openEntry(e)} className="min-w-0 text-left group">
              <div className="relative">
                <Cover e={e} />
                <span className="absolute right-2 bottom-2 opacity-90 md:opacity-0 md:group-hover:opacity-100 transition">
                  <PlayBtn e={e} />
                </span>
              </div>
              <div className={`mt-2 text-[13px] font-semibold text-white ${ELLIPSIS}`}>{e.title}</div>
              <div className={`text-[12px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                {e.artist}
              </div>
            </button>
          ))}
        </div>
      </section>
    );

  const songRow = (e: Entry, n: number) => {
    const active = nowPlaying?.id === e.id;
    return (
      <div
        key={e.id}
        role="button"
        tabIndex={0}
        onClick={() => play(e)}
        onKeyDown={(k) => k.key === 'Enter' && play(e)}
        className="flex items-center gap-3 py-2 px-2 cursor-pointer"
        style={{
          borderBottom: `1px solid ${LINE}`,
          background: active ? 'rgb(var(--bw-accent-hi-rgb) / 0.06)' : undefined,
        }}
      >
        <span className="w-6 text-sm font-bold text-right shrink-0" style={{ color: active ? GOLD : MUTED }}>
          {n + 1}
        </span>
        <Cover e={{ ...e, aiMade: false }} size={44} />
        <span className="flex-1 min-w-0">
          <span className={`block text-sm font-semibold ${ELLIPSIS}`} style={{ color: active ? GOLD : '#fff' }}>
            {e.title}
          </span>
          <span className={`block text-xs ${ELLIPSIS}`} style={{ color: MUTED }}>
            {e.artist}
          </span>
        </span>
        <span className="text-xs tabular-nums w-10 text-right shrink-0" style={{ color: MUTED }}>
          {fmt(e.featured ? durations[e.id] : active ? player.duration : undefined)}
        </span>
        <PriceBtn e={e} />
      </div>
    );
  };

  const isAlbum = (e: Entry) => e.id === HEADLINE_ALBUM.id;
  const albums = free.filter(isAlbum);
  /** While there is one album, its tracks list replaces the one-tile Albums shelf (List and Hybrid). */
  const blocks = albumBlocks({
    view,
    heroIsAlbum: filter !== 'video' && !!hero && isAlbum(hero),
    oneAlbum: albums.length === 1,
  });
  const albumTracks = FeaturedTracks && blocks.fullList ? albums[0] : null;
  const openAlbumAt = (e: Entry, index: number) => navigate(albumPath(e.id), { state: { autoplay: index } });
  const songs = [
    ...free.filter((e) => !isAlbum(e)),
    ...published.flatMap((p) => (p.release ? releaseTracks(p.release) : [])),
    ...myMusic,
  ].filter((e) => e.kind === 'music');
  const showMusic = filter !== 'video';
  const showVideo = filter !== 'music';

  const tracksOf = (r: Entry): Entry[] => (r.release && r.id === r.release.origin ? releaseTracks(r.release) : [r]);

  const releasePage =
    release && StreamAlbum && isAlbum(release) ? (
      <Suspense fallback={null}>
        <StreamAlbum
          autoplay={autoplay}
          headline={{
            playing: isPlaying(release),
            duration: durations[HEADLINE_ALBUM.headline.id],
            onPlay: () => play(release),
          }}
        />
      </Suspense>
    ) : (
      release && (
        <div className="flex flex-col md:flex-row gap-6 md:gap-8">
          <div className="w-full md:w-[320px] shrink-0">
            <Cover e={release} />
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
                {release.item ? 'In your wallet' : `${release.sub ?? 'Single'} · Free`}
              </div>
              <h1 className="text-2xl md:text-3xl font-black text-white mt-1">{release.title}</h1>
              <div className="text-sm mt-1" style={{ color: MUTED }}>
                {release.artist}
                {release.aiMade ? ' · AI-made' : ''}
              </div>
              {release.release?.description && (
                <p className="text-sm mt-3 whitespace-pre-line" style={{ color: '#d0d5dd' }}>
                  {release.release.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => play(tracksOf(release)[0])}
                className="px-5 py-2 text-sm font-bold flex items-center gap-2"
                style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
              >
                {isPlaying(release) ? <Pause size={16} /> : <Play size={16} fill="#1a1300" />}
                {isPlaying(release) ? 'Pause' : release.item ? 'Play' : 'Listen free'}
              </button>
            </div>
            <div className="flex flex-col mt-2" style={{ borderTop: `1px solid ${LINE}` }}>
              {tracksOf(release).map(songRow)}
            </div>
          </div>
        </div>
      )
    );

  return (
    <div className="w-full h-full flex flex-col overflow-y-auto pb-44" style={{ background: 'var(--bw-bg)' }}>
      <PullToRefresh onRefresh={reload} />
      <TopNav />
      {/* Room for the top bar as its own block: Desktop hides the header below, and its margin went with it. */}
      <div className="h-14 shrink-0" aria-hidden />
      <div
        className="sticky top-14 z-10 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-1.5"
        style={{ background: 'var(--bw-bg)', borderBottom: `1px solid ${LINE}` }}
      >
        <nav className="flex flex-wrap items-center shrink-0" aria-label="Store navigation">
          <button aria-label="Back" title="Back" onClick={close} className="p-1.5">
            <ChevronLeft size={20} color="#fff" />
          </button>
          <button
            aria-label="Forward"
            title="Forward"
            onClick={() => navigate(1)}
            disabled={!canForward}
            className="p-1.5"
            style={{ opacity: canForward ? 1 : 0.3 }}
          >
            <ChevronRight size={20} color="#fff" />
          </button>
          <button aria-label="Media home" title="Media home" onClick={() => navigate(MEDIA_HOME)} className="p-1.5">
            <Home size={17} color={!release && !browsing ? GOLD : '#fff'} />
          </button>
          <button
            onClick={() => navigate(`${MEDIA_HOME}/browse`)}
            className="ml-1 px-2 py-1 text-[11px] font-bold flex items-center gap-1"
            style={{ border: `1px solid ${browsing ? GOLD : LINE}`, color: browsing ? GOLD : MUTED, borderRadius: 4 }}
          >
            <LayoutGrid size={12} /> Browse
          </button>
          {PAY_STREAM_ENABLED && (
            <button
              onClick={() => navigate(`${MEDIA_HOME}/artists`)}
              className="ml-1 px-2 py-1 text-[11px] font-bold flex items-center gap-1"
              style={{ border: `1px solid ${LINE}`, color: MUTED, borderRadius: 4 }}
            >
              <Users size={12} /> Artists
            </button>
          )}
        </nav>
        <h1 className={`text-sm md:text-base font-bold text-white min-w-0 ${ELLIPSIS}`}>
          <button onClick={() => navigate(MEDIA_HOME)} className={release || browsing ? 'text-[#98A2B3]' : ''}>
            Media
          </button>
          {browsing && <span> › Browse</span>}
          {release && (
            <>
              <span style={{ color: MUTED }}> › {isAlbum(release) || release.release ? 'Albums' : 'Music'} › </span>
              {release.title}
            </>
          )}
        </h1>
        {!release && !browsing && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5 pr-2">
            <div className="flex items-center mr-2" role="group" aria-label="View">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  aria-pressed={view === v.id}
                  className="px-2 py-1 text-[11px] font-bold"
                  style={{
                    background: view === v.id ? PANEL : 'transparent',
                    color: view === v.id ? GOLD : MUTED,
                    border: `1px solid ${view === v.id ? GOLD : LINE}`,
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className="px-3 py-1 text-xs font-bold"
                style={{
                  borderRadius: 4,
                  background: filter === f.id ? GOLD : PANEL,
                  color: filter === f.id ? '#1a1300' : MUTED,
                  border: `1px solid ${filter === f.id ? GOLD : LINE}`,
                }}
              >
                {f.label}
              </button>
            ))}
            {RELEASES_ENABLED && (
              <button
                onClick={() => navigate('/m/media/new')}
                className="ml-2 px-3 py-1 text-xs font-bold"
                style={{ borderRadius: 4, border: `1px solid ${GOLD}`, color: GOLD }}
              >
                Add a release
              </button>
            )}
          </div>
        )}
      </div>
      <div className="w-full max-w-[1100px] mx-auto px-4 pt-5 flex flex-col gap-8">
        {albumId && !release ? (
          <p className="text-sm py-6 text-center" style={{ color: MUTED }}>
            {loading ? 'Loading…' : 'This album is not in the store.'}
          </p>
        ) : release ? (
          releasePage
        ) : browsing ? (
          <BrowseView
            artist={new URLSearchParams(location.search).get('artist')}
            entries={[...free, ...published].filter((e) => e.kind === 'music' || e.release)}
            isAlbum={isAlbum}
            renderTracks={(e) =>
              isAlbum(e) && FeaturedTracks ? (
                <Suspense fallback={null}>
                  <FeaturedTracks
                    headlinePlaying={isPlaying(e)}
                    headlineDuration={durations[HEADLINE_ALBUM.headline.id]}
                    onHeadline={() => play(e)}
                    onTrack={(i) => openAlbumAt(e, i)}
                    onAll={() => openEntry(e)}
                  />
                </Suspense>
              ) : (
                <div className="flex flex-col" style={{ borderTop: `1px solid ${LINE}` }}>
                  {tracksOf(e).map(songRow)}
                </div>
              )
            }
            onOpen={openEntry}
          />
        ) : (
          <>
            {showMusic && <YourPodcasts />}
            {showMusic && hero && view !== 'list' && (
              <section
                className="relative overflow-hidden flex flex-col lg:flex-row lg:items-center gap-5 lg:gap-8 p-4 md:p-6"
                style={{
                  borderRadius: RADIUS,
                  border: `1px solid ${LINE}`,
                  background: 'linear-gradient(120deg, #1c1606 0%, #0a0a0a 55%, #000 100%)',
                }}
              >
                {isAlbum(hero) && <StillsBanner stills={VEXVOID_STILLS} className="absolute inset-0" />}
                <div className="relative flex items-center gap-5 md:gap-8 flex-1 min-w-0">
                  <button onClick={() => openEntry(hero)} className="relative w-[132px] md:w-[220px] shrink-0">
                    <Cover e={hero} />
                  </button>
                  <div className="relative flex-1 min-w-0 flex flex-col gap-2">
                    <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
                      {isAlbum(hero)
                        ? 'Album · Headline track free'
                        : `Featured${hero.free ? ' · Free to listen' : ''}`}
                    </div>
                    <div className="text-xl md:text-4xl font-black text-white leading-tight">{hero.title}</div>
                    <div className="text-sm" style={{ color: MUTED }}>
                      {hero.artist}
                      {hero.sub ? ` · ${hero.sub}` : ''}
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                      <PlayBtn e={hero.release ? releaseTracks(hero.release)[0] : hero} big />
                      <button
                        onClick={() => openEntry(hero)}
                        className="text-xs font-bold underline-offset-4 hover:underline"
                        style={{ color: GOLD }}
                      >
                        {isAlbum(hero) ? 'View album' : 'View release'}
                      </button>
                    </div>
                  </div>
                </div>
                {blocks.inHero && FeaturedTracks && (
                  <div
                    className="relative w-full lg:w-[44%] shrink-0 p-3"
                    style={{ background: 'rgba(0,0,0,0.55)', borderRadius: 4 }}
                  >
                    <Suspense fallback={null}>
                      <FeaturedTracks
                        compact
                        headlinePlaying={isPlaying(hero)}
                        headlineDuration={durations[HEADLINE_ALBUM.headline.id]}
                        onHeadline={() => play(hero)}
                        onTrack={(i) => openAlbumAt(hero, i)}
                        onAll={() => openEntry(hero)}
                      />
                    </Suspense>
                  </div>
                )}
                {banner.length > 1 && (
                  <div className="absolute right-3 bottom-3 flex gap-1">
                    <button
                      aria-label="Previous"
                      onClick={() => setSlide((s) => (s - 1 + banner.length) % banner.length)}
                    >
                      <ChevronLeft size={18} color={MUTED} />
                    </button>
                    <button aria-label="Next" onClick={() => setSlide((s) => (s + 1) % banner.length)}>
                      <ChevronRight size={18} color={MUTED} />
                    </button>
                  </div>
                )}
              </section>
            )}
            {showMusic && albumTracks && FeaturedTracks && (
              <Suspense fallback={null}>
                <FeaturedTracks
                  headlinePlaying={isPlaying(albumTracks)}
                  headlineDuration={durations[HEADLINE_ALBUM.headline.id]}
                  onHeadline={() => play(albumTracks)}
                  onTrack={(i) => openAlbumAt(albumTracks, i)}
                  onAll={() => openEntry(albumTracks)}
                />
              </Suspense>
            )}
            {showMusic &&
              (!StreamAlbum || (view === 'cards' ? true : albums.length >= 2)) &&
              shelf(StreamAlbum ? 'Albums' : 'Free this week', free)}
            {shelf(
              'New releases',
              published.filter((p) => (p.kind === 'music' ? showMusic : showVideo)),
            )}
            {showMusic && shelf('Your music', myMusic)}
            {showVideo && shelf('Your videos', myVideo)}
            {showMusic && songs.length > 0 && (
              <section className="flex flex-col gap-2">
                <h2 className="text-base font-bold text-white">Songs</h2>
                <div className="flex flex-col" style={{ borderTop: `1px solid ${LINE}` }}>
                  {songs.map(songRow)}
                </div>
              </section>
            )}
            {error && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-[#F97066]">{error}</p>
                <ErrorActions message={String(error)} />
              </div>
            )}
            {!loading && items.length === 0 && (
              <p className="text-sm text-center py-4" style={{ color: MUTED }}>
                No music or video of your own yet. Mint some from the Wallet tab.
              </p>
            )}
            {hasMore && (
              <button
                onClick={() => void loadMore()}
                disabled={loading}
                className="py-2.5 text-xs font-semibold"
                style={{ background: PANEL, color: MUTED, borderRadius: RADIUS }}
              >
                {loading ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
      {open && <MediaViewer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
};

/**
 * Browse: the iTunes column browser. Genre | Artist | Album; each pick narrows the next column, and the
 * picked album's tracks show below. Built from what the store has (the album, published releases).
 */
function BrowseView(p: {
  /** Opened from an artist link (/media/artist/<artist>): start on that artist. */
  artist?: string | null;
  entries: Entry[];
  isAlbum: (e: Entry) => boolean;
  renderTracks: (e: Entry) => React.ReactNode;
  onOpen: (e: Entry) => void;
}) {
  const genreOf = (e: Entry) => (e.release?.genre?.trim() || (e.kind === 'video' ? 'Video' : 'Music')) as string;
  const all = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));
  const genres = all(p.entries.map(genreOf));
  const [genre, setGenre] = useState<string | null>(() =>
    p.artist ? (p.entries.map((e) => (e.artist === p.artist ? genreOf(e) : null)).find(Boolean) ?? null) : null,
  );
  const [artist, setArtist] = useState<string | null>(p.artist ?? null);
  const [album, setAlbum] = useState<string | null>(null);
  const g = genre ?? genres[0] ?? null;
  const inGenre = p.entries.filter((e) => genreOf(e) === g);
  const artists = all(inGenre.map((e) => e.artist));
  const a = artist && artists.includes(artist) ? artist : (artists[0] ?? null);
  const albums = inGenre.filter((e) => e.artist === a);
  const picked = albums.find((e) => e.id === album) ?? albums[0] ?? null;
  const col = (title: string, items: { id: string; label: string }[], sel: string | null, on: (id: string) => void) => (
    <div className="flex-1 min-w-0 flex flex-col" style={{ borderRight: `1px solid ${LINE}` }}>
      <div
        className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest"
        style={{ color: MUTED, borderBottom: `1px solid ${LINE}`, background: PANEL }}
      >
        {title}
      </div>
      <div className="flex flex-col max-h-[220px] overflow-y-auto">
        {items.map((it) => (
          <button
            key={it.id}
            onClick={() => on(it.id)}
            className={`px-2 py-1.5 text-left text-[13px] ${ELLIPSIS}`}
            style={{
              background: sel === it.id ? 'rgb(var(--bw-accent-hi-rgb) / 0.14)' : 'transparent',
              color: sel === it.id ? GOLD : '#fff',
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <section className="flex flex-col gap-4">
      <div className="flex" style={{ border: `1px solid ${LINE}`, borderRadius: RADIUS, overflow: 'hidden' }}>
        {col(
          'Genre',
          genres.map((x) => ({ id: x, label: x })),
          g,
          (x) => {
            setGenre(x);
            setArtist(null);
            setAlbum(null);
          },
        )}
        {col(
          'Artist',
          artists.map((x) => ({ id: x, label: x })),
          a,
          (x) => {
            setArtist(x);
            setAlbum(null);
          },
        )}
        {col(
          'Album',
          albums.map((e) => ({ id: e.id, label: e.title })),
          picked?.id ?? null,
          setAlbum,
        )}
      </div>
      {picked && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-base font-bold text-white">
              {picked.title}
              <span className="font-normal text-sm" style={{ color: MUTED }}>
                {' '}
                · {picked.artist}
              </span>
            </h2>
            <button onClick={() => p.onOpen(picked)} className="text-xs font-bold" style={{ color: GOLD }}>
              {p.isAlbum(picked) ? 'View album' : 'View release'}
            </button>
          </div>
          {p.renderTracks(picked)}
        </div>
      )}
      {!p.entries.length && (
        <p className="text-sm" style={{ color: MUTED }}>
          Nothing in the store yet.
        </p>
      )}
    </section>
  );
}

export default MediaPage;
