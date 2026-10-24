/**
 * NFT hero viewer + header + pending card, shared by the phone/extension NftDetail and the Desktop library panel.
 * Owner, 12 Oct 2026: "the iPhone is the only real frame for a picture" — media goes edge to edge in its own aspect
 * ratio with no frame; the obsidian/gold styling lives on the info and actions below. Video is playsInline, short
 * clips (<60 s) autoplay muted on a loop (tap to unmute), tap toggles minimal controls, fullscreen falls back to iOS
 * webkitEnterFullscreen. Pending NFTs play from the wallet's own signed tx (nftViewer.localInscription).
 * Inscribed HTML only runs in sandbox="" (no scripts, no same-origin).
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { OpnsNameCard } from '../names/OpnsNameCard';
import { isOpnsType } from '../names/opnsName';
import {
  Check,
  Copy,
  ExternalLink,
  FileText,
  Maximize,
  Music,
  Pause,
  Play,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { MediaItem } from './useWalletMedia';
import { cachedPoster, loadVideoPoster } from './videoCover';
import { isShortClip, localInscription, typeChip, viewerFor } from './nftViewer';

// three.js only loads when a 3D NFT opens (keeps it out of the popup's first bundle).
const ModelViewer = lazy(() => import('../three3d/ModelViewer'));

export const GOLD = 'var(--bw-accent)';
const AMBER = '#FFB020';

/** Content URL: ORDFS when on chain; for a pending NFT, a blob from the wallet's own copy (or null = not extractable). */
const useSource = (m: MediaItem, pending: boolean) => {
  const { apiContext } = useServiceContext();
  const [src, setSrc] = useState<string | null | undefined>(pending ? undefined : m.url);
  useEffect(() => {
    if (!pending) return setSrc(m.url);
    let live = true;
    let made = '';
    setSrc(undefined);
    localInscription(apiContext.wallet, m.output)
      .then((ins) => {
        if (!live) return;
        if (!ins || !ins.data.length) return setSrc(null);
        made = URL.createObjectURL(
          new Blob([ins.data as Uint8Array<ArrayBuffer>], { type: m.type || ins.contentType }),
        );
        setSrc(made);
      })
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [apiContext.wallet, m.output, m.url, m.type, pending]);
  return src;
};

const GoldArt = ({ icon, label, sub }: { icon: ReactNode; label: string; sub?: string }) => (
  <div
    className="w-full flex flex-col items-center justify-center gap-2 px-6 text-center"
    style={{
      aspectRatio: '1 / 1',
      maxHeight: '70vh',
      background: 'radial-gradient(circle at 30% 20%, #4a3806 0%, #1a1405 45%, #0b0c0f 100%)',
    }}
  >
    {icon}
    <span className="text-sm font-semibold" style={{ color: GOLD }}>
      {label}
    </span>
    {sub && <span className="text-xs text-[#e6d08a] max-w-[260px]">{sub}</span>}
  </div>
);

type FsVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

const VideoView = ({ src, poster }: { src: string; poster?: string }) => {
  const v = useRef<FsVideo>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [short, setShort] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [t, setT] = useState(0);
  const [d, setD] = useState(0);
  const toggle = () => {
    const el = v.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };
  const fullscreen = () => {
    const el = v.current;
    if (!el) return;
    if (el.requestFullscreen && document.fullscreenEnabled)
      void el.requestFullscreen().catch(() => el.webkitEnterFullscreen?.());
    else el.webkitEnterFullscreen?.();
  };
  return (
    <div className="relative w-full bg-black" onClick={() => setChrome((c) => !c)}>
      <video
        ref={v}
        src={src}
        poster={poster}
        playsInline
        // webkit-playsinline for older iOS WebViews
        {...{ 'webkit-playsinline': 'true' }}
        muted={muted}
        loop={short}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setD(el.duration);
          if (isShortClip(el.duration)) {
            setShort(true);
            el.muted = true;
            void el.play().catch(() => undefined);
          }
        }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="block w-full h-auto"
        style={{
          maxHeight: 'calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
          objectFit: 'contain',
        }}
      />
      {!playing && (
        <button
          aria-label="Play"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          className="absolute inset-0 m-auto h-16 w-16 rounded-full flex items-center justify-center bg-black/50 backdrop-blur"
        >
          <Play size={28} color="#fff" fill="#fff" />
        </button>
      )}
      {chrome && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-x-0 bottom-0 flex items-center gap-2 px-3 pb-2 pt-6"
          style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.7))' }}
        >
          <button aria-label={playing ? 'Pause' : 'Play'} onClick={toggle} className="p-1.5">
            {playing ? <Pause size={18} color="#fff" /> : <Play size={18} color="#fff" />}
          </button>
          <input
            type="range"
            aria-label="Scrub"
            min={0}
            max={d || 0}
            step={0.05}
            value={t}
            onChange={(e) => {
              if (v.current) v.current.currentTime = Number(e.target.value);
            }}
            className="flex-1 h-1"
            style={{ accentColor: GOLD }}
          />
          <button
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={() => {
              setMuted((x) => !x);
              if (v.current?.paused) void v.current.play().catch(() => undefined);
            }}
            className="p-1.5"
          >
            {muted ? <VolumeX size={18} color="#fff" /> : <Volume2 size={18} color={GOLD} />}
          </button>
          <button aria-label="Fullscreen" onClick={fullscreen} className="p-1.5">
            <Maximize size={18} color="#fff" />
          </button>
        </div>
      )}
      {short && muted && playing && (
        <span className="absolute top-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white">
          Tap for sound
        </span>
      )}
    </div>
  );
};

const BARS = Array.from({ length: 48 }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.45)));

const AudioView = ({ src, name }: { src: string; name: string }) => {
  const a = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [p, setP] = useState(0);
  return (
    <div
      className="w-full flex flex-col items-center justify-center gap-5 px-6 py-8"
      style={{ background: 'radial-gradient(circle at 30% 20%, #4a3806 0%, #1a1405 45%, #0b0c0f 100%)' }}
    >
      <Music size={44} color={GOLD} />
      <div className="text-sm font-semibold text-white text-center line-clamp-2">{name}</div>
      <div
        className="flex items-end gap-[3px] h-16 w-full max-w-[420px] cursor-pointer"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const el = a.current;
          if (el?.duration) el.currentTime = ((e.clientX - r.left) / r.width) * el.duration;
        }}
      >
        {BARS.map((h, i) => (
          <span
            key={i}
            className="flex-1 rounded-full"
            style={{
              height: `${h * 100}%`,
              background: i / BARS.length <= p ? GOLD : 'rgb(var(--bw-accent-rgb) / 0.25)',
            }}
          />
        ))}
      </div>
      <button
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => (a.current?.paused ? void a.current.play().catch(() => undefined) : a.current?.pause())}
        className="h-14 w-14 rounded-full flex items-center justify-center"
        style={{ background: GOLD }}
      >
        {playing ? <Pause size={24} color="#010101" /> : <Play size={24} color="#010101" fill="#010101" />}
      </button>
      {/* preload="none": nothing downloads or plays until Play is pressed. */}
      <audio
        ref={a}
        src={src}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) =>
          setP(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)
        }
      />
    </div>
  );
};

/**
 * The whole image, fitted to the screen, never cropped. No tap-to-zoom: a 200% zoom from the corner cut off badges
 * and bAvatars (owner, 17 Oct 2026); pinch zooms instead. Hard pixels only for small pixel art.
 */
const ImageView = ({ src, name }: { src: string; name: string }) => {
  const [bad, setBad] = useState(false);
  const [tiny, setTiny] = useState(false);
  if (bad) return <GoldArt icon={<Sparkles size={40} color={GOLD} />} label="Image" sub={name} />;
  return (
    <div className="flex w-full items-center justify-center bg-black" style={{ touchAction: 'pinch-zoom' }}>
      <img
        src={src}
        alt={name}
        onError={() => setBad(true)}
        onLoad={(e) => setTiny(e.currentTarget.naturalWidth > 0 && e.currentTarget.naturalWidth <= 256)}
        className="block h-auto max-w-full object-contain"
        style={{ imageRendering: tiny ? 'pixelated' : 'auto', maxHeight: '70vh', width: '100%' }}
      />
    </div>
  );
};

const TextView = ({ src }: { src: string }) => {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetch(src, { signal: ac.signal })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => setText(t.slice(0, 20000)))
      .catch(() => setText(''));
    return () => ac.abort();
  }, [src]);
  if (!text) return <GoldArt icon={<FileText size={40} color={GOLD} />} label="Text" />;
  return (
    <pre className="w-full max-h-[60vh] overflow-auto p-4 bg-[#0b0c0f] text-xs leading-relaxed text-[#D0D5DD] whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
};

/** The cover frame of an on-chain video (videoCover.ts), so there's no black flash before it loads. */
const usePoster = (m: MediaItem, on: boolean) => {
  const op = m.origin.replace('.', '_');
  const [p, setP] = useState<string | undefined>(() => cachedPoster(op) ?? undefined);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void loadVideoPoster(op)
      .then((u) => live && u && setP(u))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [op, on]);
  return p;
};

/** Edge-to-edge media, no frame. */
export const NftHero = ({ m, pending, poster }: { m: MediaItem; pending: boolean; poster?: string }) => {
  const src = useSource(m, pending);
  const kind = viewerFor(m.type);
  const autoPoster = usePoster(m, kind === 'video' && !pending && !poster);
  if (src === undefined)
    return <GoldArt icon={<Sparkles size={40} color={GOLD} className="animate-pulse" />} label="Opening your copy…" />;
  if (src === null)
    return (
      <GoldArt icon={<Sparkles size={40} color={GOLD} />} label="Preview appears once it’s on chain" sub={m.name} />
    );
  if (isOpnsType(m.type))
    return (
      <div className="w-full bg-[#0b0c0f]" style={{ height: '40vh' }}>
        <OpnsNameCard url={src} fallback={m.name} />
      </div>
    );
  if (kind === 'video') return <VideoView src={src} poster={poster ?? autoPoster} />;
  if (kind === 'audio') return <AudioView src={src} name={m.name} />;
  if (kind === 'image') return <ImageView src={src} name={m.name} />;
  if (kind === 'model')
    return (
      <Suspense fallback={<GoldArt icon={<Sparkles size={40} color={GOLD} className="animate-pulse" />} label="3D" />}>
        <ModelViewer src={src} contentType={m.type ?? ''} poster={poster} />
      </Suspense>
    );
  if (kind === 'html')
    return (
      <iframe
        src={src}
        title={m.name}
        sandbox=""
        referrerPolicy="no-referrer"
        className="block w-full bg-white border-0"
        style={{ height: '60vh' }}
      />
    );
  if (kind === 'text') return <TextView src={src} />;
  return <GoldArt icon={<Sparkles size={40} color={GOLD} />} label={typeChip(m.type)} sub={m.name} />;
};

export type NftStatus = 'pending' | 'listed' | 'onchain' | 'checking';

export const StatusPill = ({ status }: { status: NftStatus }) => {
  const s = {
    pending: { label: 'Pending', color: AMBER, bg: 'rgba(255,176,32,0.12)' },
    listed: { label: 'Listed', color: '#A1FF8B', bg: 'rgba(161,255,139,0.12)' },
    onchain: { label: 'On chain', color: GOLD, bg: 'rgb(var(--bw-accent-rgb) / 0.12)' },
    checking: { label: 'Checking…', color: '#e6d08a', bg: 'rgb(var(--bw-accent-rgb) / 0.08)' },
  }[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{ color: s.color, background: s.bg }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${status === 'pending' ? 'animate-pulse' : ''}`}
        style={{ background: s.color }}
      />
      {s.label}
    </span>
  );
};

const shortId = (s: string) => (s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

export const NftHeader = ({
  name,
  collection,
  contentType,
  size,
  status,
  origin,
  chainLink,
}: {
  name: string;
  collection?: string;
  contentType?: string | null;
  size?: string;
  status: NftStatus;
  origin: string;
  chainLink?: string;
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-white leading-tight break-words">{name}</h2>
          {collection && <div className="mt-0.5 text-xs text-[#e6d08a] truncate">{collection}</div>}
        </div>
        <StatusPill status={status} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-md px-2 py-0.5 text-[11px] font-bold tracking-wide"
          style={{ color: GOLD, background: 'rgb(var(--bw-accent-rgb) / 0.12)' }}
        >
          {typeChip(contentType)}
          {size ? ` · ${size}` : ''}
        </span>
        <span className="flex items-center gap-1 rounded-md bg-white/5 pl-2 pr-1 py-0.5 text-[11px] text-[#98A2B3]">
          {shortId(origin)}
          <button
            aria-label="Copy origin"
            className="p-1"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(origin)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => undefined)
            }
          >
            {copied ? <Check size={12} color={GOLD} /> : <Copy size={12} color="#98A2B3" />}
          </button>
        </span>
        {chainLink && status !== 'pending' && (
          <a
            href={chainLink}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[11px] font-semibold"
            style={{ color: GOLD }}
          >
            View on chain <ExternalLink size={11} />
          </a>
        )}
      </div>
    </div>
  );
};

export const PendingCard = () => (
  <div
    className="rounded-2xl p-4 border"
    style={{
      borderColor: 'rgba(255,176,32,0.35)',
      background: 'linear-gradient(135deg, rgba(255,176,32,0.10), rgba(11,12,15,0.6))',
    }}
  >
    <div className="text-sm font-semibold" style={{ color: AMBER }}>
      Sending to the network…
    </div>
    <div className="mt-1 text-xs text-[#e6d08a]">
      Your wallet keeps trying on its own. Send, listing and download open once it lands.
    </div>
    <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full w-1/3 rounded-full nft-pending-bar" style={{ background: AMBER }} />
    </div>
    <style>{`@keyframes nftPending{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}.nft-pending-bar{animation:nftPending 1.8s ease-in-out infinite}`}</style>
  </div>
);

/** Shared action button style. */
export const actionBtn =
  'flex items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed';
