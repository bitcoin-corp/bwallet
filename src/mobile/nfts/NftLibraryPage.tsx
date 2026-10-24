/**
 * Wallet › NFTs library (Desktop /wallet/nfts, deep link /wallet/nfts/<outpoint>). Design: docs/NFT-LIBRARY.md.
 * Loads every NFT the wallet holds (useWalletMedia pages), draws a windowed grid so 5,000 items stay smooth, and
 * opens a detail panel with only the actions that work today. Inscribed HTML only ever runs in a sandboxed iframe
 * without scripts or same-origin; audio never plays until pressed.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAlbums } from '../albums/useAlbums';
import { AddToAlbumSheet, AlbumBar, HIDE_NOTE } from '../albums/AlbumSheets';
import {
  ALL_VIEW,
  filterView,
  isHidden,
  liveView,
  nftKey,
  removeFromAlbum,
  setHidden,
  viewCounts,
  type AlbumView,
  type ItemKey,
} from '../albums/albums';
import { useNavigate, useParams } from 'react-router-dom';
import { cancelOrdinalListing } from '@1sat/actions';
import { readAssetIdTag } from '@1sat/types';
import {
  Box,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  ExternalLink,
  EyeOff,
  Eye,
  FolderPlus,
  FileText,
  Music,
  Play,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getErrorMessage } from '../../utils/tools';
import { useWalletMedia, playMusic, type MediaItem } from '../media/useWalletMedia';
import { VideoPoster } from '../media/VideoPoster';
import { NftDetail } from '../media/NftDetail';
import { NftHeader, NftHero, PendingCard } from '../media/NftHero';
import { ordinalsUrl } from '../media/nftActions';
import { itemInfo } from '../market/indexer';
import {
  EMPTY_FILTER,
  NFT_TYPES,
  collectionLabel,
  filterAndSort,
  formatBytes,
  groupByCollection,
  toLibraryItem,
  mapModelUrl,
  typeCounts,
  visibleRows,
  type LibraryFilter,
  type LibraryItem,
  type NftType,
  type SortKey,
} from './nftLibrary';
import { WalletTabs } from './WalletTabs';
import { TopNav } from '../../components/TopNav';
import { WIDE_ON } from '../wide/flag';
import { BavatarKeep } from './BavatarKeep';
import { isBavatarItem } from '../names/pictureSource';
import { useRelayxAccount } from '../sweep/useRelayxAccount';
import { loadSavedRelayx } from '../sweep/relayxSaved';
import { CardArt, RelayxRecoverScreen } from '../sweep/RelayxRecoverScreen';
import type { Found } from '../../sweep/relayxRecover';

const ModelViewer = lazy(() => import('../three3d/ModelViewer'));

const GOLD = 'var(--bw-accent)';
const ROUTE = '/m/nfts';
const MIN_TILE = 170;
const GAP = 12;
const CAPTION = 52;

/** Album key for a library row (albums.ts). */
const keyOf = (i: LibraryItem) => nftKey(i.origin);

/** unbroadcast.ts PENDING_ON_CHAIN, via useWalletMedia. */
const isPending = (m: MediaItem) => !!m.pending;

/* ---------- Previews ---------- */

const GoldCard = ({ icon, label, title }: { icon: ReactNode; label: string; title?: string }) => (
  <div
    className="w-full h-full flex flex-col items-center justify-center gap-1 px-3 text-center"
    style={{ background: 'radial-gradient(circle at 30% 20%, #3a2c05 0%, #17191E 70%)' }}
  >
    {icon}
    <span className="text-[10px] font-bold tracking-wide" style={{ color: GOLD }}>
      {label}
    </span>
    {title && <span className="text-[11px] font-semibold text-white line-clamp-2 break-words">{title}</span>}
  </div>
);

/** First few hundred characters of a text inscription (only fetched for tiles on screen). */
const TextCard = ({ url, title }: { url: string; title: string }) => {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetch(url, { signal: ac.signal })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => setText(t.slice(0, 400)))
      .catch(() => setText(''));
    return () => ac.abort();
  }, [url]);
  if (!text) return <GoldCard icon={<FileText size={26} color={GOLD} />} label="Text" title={title} />;
  return (
    <div className="w-full h-full p-3 overflow-hidden bg-[#111216] text-[11px] leading-snug text-[#D0D5DD] whitespace-pre-wrap break-words">
      {text}
    </div>
  );
};

/** Inscribed HTML: sandbox="" = no scripts, no same-origin, no forms, no top navigation. */
const HtmlFrame = ({ url, title, interactive }: { url: string; title: string; interactive?: boolean }) => (
  <iframe
    src={url}
    title={title}
    sandbox=""
    referrerPolicy="no-referrer"
    loading="lazy"
    className="w-full h-full bg-white border-0"
    style={{ pointerEvents: interactive ? 'auto' : 'none' }}
  />
);

const Preview = ({ m, type, large }: { m: MediaItem; type: NftType; large?: boolean }) => {
  const [bad, setBad] = useState(false);
  if (type === 'image' && !bad)
    return (
      <img
        src={m.url}
        alt={m.name}
        loading="lazy"
        decoding="async"
        onError={() => setBad(true)}
        className={large ? 'max-w-full max-h-full object-contain' : 'w-full h-full object-cover'}
        style={{ imageRendering: 'pixelated' }}
      />
    );
  if (type === 'video')
    return large ? (
      <video src={m.url} controls playsInline preload="metadata" className="max-w-full max-h-full" />
    ) : (
      <VideoPoster outpoint={m.origin.replace('.', '_')} title={m.name} />
    );
  if (type === 'audio')
    return large ? (
      <div className="w-full h-full flex flex-col items-center justify-center gap-4">
        <GoldCard icon={<Music size={40} color={GOLD} />} label="Audio" title={m.name} />
        {/* preload="none": nothing downloads or plays until Play is pressed. */}
        <audio src={m.url} controls preload="none" className="w-[90%] absolute bottom-4" />
      </div>
    ) : (
      <GoldCard icon={<Music size={26} color={GOLD} />} label="Audio" title={m.name} />
    );
  if (type === 'model')
    return large ? (
      <Suspense fallback={<GoldCard icon={<Box size={40} color={GOLD} />} label="3D" title={m.name} />}>
        <ModelViewer src={m.url} contentType={m.type ?? ''} />
      </Suspense>
    ) : (
      <GoldCard icon={<Box size={26} color={GOLD} />} label="3D" title={m.name} />
    );
  if (type === 'html') return <HtmlFrame url={m.url} title={m.name} interactive={large} />;
  if (type === 'text') return <TextCard url={m.url} title={m.name} />;
  return <GoldCard icon={<Sparkles size={26} color={GOLD} />} label={bad ? 'Image' : 'NFT'} title={m.name} />;
};

/* ---------- Tile ---------- */

const Tile = ({
  m,
  it,
  size,
  onOpen,
  onPlay,
  picked,
  onLongPress,
}: {
  m: MediaItem;
  it: LibraryItem;
  size: number;
  onOpen: () => void;
  onPlay: () => void;
  /** Set while selecting: true = in the selection. */
  picked?: boolean;
  /** Long-press (or right-click): start selecting with this item. */
  onLongPress: () => void;
}) => {
  const press = useLongPress(onLongPress);
  return (
    <div style={{ width: size }} className="flex flex-col">
      <button
        {...press}
        onClick={() => {
          if (press.consumed()) return;
          onOpen();
        }}
        aria-label={picked === undefined ? `Open ${it.name}` : `${picked ? 'Deselect' : 'Select'} ${it.name}`}
        aria-pressed={picked}
        className="relative overflow-hidden rounded-xl bg-[var(--bw-surface)] border border-white/5 hover:border-[color:var(--bw-accent)]/60 transition-colors"
        style={{ width: size, height: size }}
      >
        <div className={`absolute inset-0 ${m.flagged ? 'blur-xl' : ''}`}>
          <Preview m={m} type={it.type} />
        </div>
        {picked !== undefined && (
          <span className="absolute top-2 left-2 z-[1] rounded-full bg-black/60" aria-hidden>
            {picked ? <CheckCircle2 size={22} color="var(--bw-accent)" /> : <Circle size={22} color="#fff" />}
          </span>
        )}
        {picked === undefined && (it.type === 'video' || it.type === 'audio') && (
          <span
            role="button"
            aria-label={it.type === 'audio' ? `Play ${it.name}` : `Open ${it.name}`}
            onClick={(e) => {
              if (it.type !== 'audio') return;
              e.stopPropagation();
              onPlay();
            }}
            className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full"
            style={{ background: GOLD }}
          >
            <Play size={14} color="#010101" fill="#010101" />
          </span>
        )}
        {it.pending && (
          <span className="absolute top-2 left-2 rounded-md bg-black/80 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--bw-accent)]">
            Pending
          </span>
        )}
        {it.listed && (
          <span className="absolute top-2 right-2 rounded-md bg-black/80 px-2 py-0.5 text-[10px] font-semibold text-[#A1FF8B]">
            Listed
          </span>
        )}
      </button>
      <div className="pt-1.5 min-w-0">
        <div className="text-xs font-semibold text-white truncate">{it.name}</div>
        <div className="text-[10px] text-[#98A2B3] truncate">
          {it.collection ? collectionLabel(it.collection) : (it.contentType ?? 'Unknown type')}
        </div>
      </div>
    </div>
  );
};

/** Press-and-hold (500 ms) or right-click; the click that ends a long press is swallowed. */
const useLongPress = (fire: () => void) => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: () => {
      fired.current = false;
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        fire();
      }, 500);
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: { preventDefault: () => void }) => {
      e.preventDefault();
      clear();
      fired.current = true;
      fire();
    },
    consumed: () => {
      const f = fired.current;
      fired.current = false;
      return f;
    },
  };
};

/* ---------- Run (RelayX) ---------- */

/** All · 1Sat · Run: which NFTs the grid shows. Run = the account's saved RelayX search (RelayxRecoverScreen). */
type Source = 'all' | '1sat' | 'run';
const SOURCE_KEY = 'bw.nfts.source';
const readSource = (): Source => {
  try {
    const v = localStorage.getItem(SOURCE_KEY);
    return v === '1sat' || v === 'run' ? v : 'all';
  } catch {
    return 'all';
  }
};

const RunTile = ({ f, onOpen }: { f: Found; onOpen: () => void }) => (
  <button
    onClick={onOpen}
    aria-label={`Open ${f.title}`}
    className="relative flex flex-col min-w-0 overflow-hidden rounded-xl bg-[var(--bw-surface)] border border-white/5 hover:border-[color:var(--bw-accent)]/60 transition-colors text-left"
  >
    {f.art ? (
      <CardArt url={f.art} className="aspect-[2/3] w-full" />
    ) : (
      <div className="aspect-[2/3] w-full">
        <GoldCard icon={<Sparkles size={26} color={GOLD} />} label="Run" title={f.title} />
      </div>
    )}
    <span className="absolute top-2 left-2 rounded-md bg-black/80 px-2 py-0.5 text-[10px] font-semibold text-[#8FB3FF]">
      Run
    </span>
    <span className="px-2 pt-1.5 text-xs font-semibold text-white truncate">{f.title}</span>
    <span className="px-2 pb-1.5 text-[10px] text-[#98A2B3] truncate">{f.collection}</span>
  </button>
);

/** The saved RelayX search as tiles; nothing saved yet = a short note and a button to search. */
const RunSection = ({
  nfts,
  heading,
  onOpen,
  onSearch,
}: {
  nfts: readonly Found[] | null;
  heading: boolean;
  onOpen: (f: Found) => void;
  onSearch: () => void;
}) => (
  <section className="pb-6">
    <div className="flex items-center gap-2 pb-3">
      {heading && <span className="text-sm font-semibold text-white">Run NFTs</span>}
      {nfts && (
        <button className="ml-auto text-xs underline text-[#98A2B3]" onClick={onSearch}>
          Refresh
        </button>
      )}
    </div>
    {nfts ? (
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(140px, 45%), 1fr))' }}>
        {nfts.map((f) => (
          <RunTile key={f.origin} f={f} onOpen={() => onOpen(f)} />
        ))}
      </div>
    ) : (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="max-w-xs text-sm text-[#98A2B3]">
          This account came from RelayX. Search its old addresses to see the Run NFTs it holds.
        </p>
        <button
          onClick={onSearch}
          className="rounded-xl px-5 py-2.5 text-sm font-semibold text-[#010101]"
          style={{ background: GOLD }}
        >
          Find Run NFTs
        </button>
      </div>
    )}
  </section>
);

/* ---------- Detail panel ---------- */

type Facts = { mintDate?: string; size?: string; description?: string; model?: string };

const useFacts = (m: MediaItem | undefined): Facts => {
  const [facts, setFacts] = useState<Facts>({});
  useEffect(() => {
    setFacts({});
    if (!m) return;
    let live = true;
    const txid = m.origin.split(/[._]/)[0];
    void fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { blocktime?: number } | null) => {
        if (live && j?.blocktime) setFacts((f) => ({ ...f, mintDate: new Date(j.blocktime! * 1000).toLocaleString() }));
      })
      .catch(() => undefined);
    void fetch(m.url, { method: 'HEAD' })
      .then((r) => {
        const n = Number(r.headers.get('content-length'));
        if (live && n) setFacts((f) => ({ ...f, size: formatBytes(n) }));
      })
      .catch(() => undefined);
    void itemInfo(m.origin.replace('.', '_')).then((info) => {
      const d = info?.map?.description;
      if (live && typeof d === 'string' && d) setFacts((f) => ({ ...f, description: d }));
      const model = mapModelUrl(info?.map?.model);
      if (live && model) setFacts((f) => ({ ...f, model }));
    });
    return () => {
      live = false;
    };
  }, [m]);
  return facts;
};

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex gap-3 py-1.5 border-b border-white/5 text-xs">
    <span className="w-28 shrink-0 text-[#98A2B3]">{label}</span>
    <span className="flex-1 min-w-0 text-white break-all">{children}</span>
  </div>
);

const DetailPanel = ({
  m,
  it,
  all,
  onClose,
  onChanged,
}: {
  m: MediaItem;
  it: LibraryItem;
  all: MediaItem[];
  onClose: () => void;
  onChanged: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const facts = useFacts(m);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [picture, setPicture] = useState(false);
  const [albums, updateAlbums] = useAlbums();
  const [filing, setFiling] = useState(false);
  const key = nftKey(it.origin);
  const hidden = isHidden(albums, key);
  const txid = it.outpoint.split('_')[0];
  const originTx = it.origin.split('_')[0];
  const shareLink = `${window.location.origin}/wallet/nfts/${it.outpoint}`;
  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg(done);
    } catch {
      setMsg(text);
    }
  };
  const download = async () => {
    setBusy(true);
    try {
      const r = await fetch(m.url);
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const a = document.createElement('a');
      const ext = (it.contentType ?? '').split('/')[1]?.split(/[;+]/)[0] || 'bin';
      a.href = URL.createObjectURL(blob);
      a.download = `${it.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || it.outpoint}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch {
      setMsg('Couldn’t download the file. Try Open on chain.');
    } finally {
      setBusy(false);
    }
  };
  const cancelListing = async () => {
    const id = readAssetIdTag(m.output.tags);
    if (!id) return setMsg('This listing is missing a tracking id. Try Refresh.');
    setBusy(true);
    try {
      const res = await cancelOrdinalListing.execute(apiContext, { id });
      if (!res.txid || res.error) setMsg(getErrorMessage(res.error));
      else {
        setMsg('Listing cancelled. The NFT is back in your wallet.');
        onChanged();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Not cancelled.');
    } finally {
      setBusy(false);
    }
  };
  const btn =
    'flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed';
  const off = it.pending || busy;
  return (
    <aside
      className="flex flex-col h-full overflow-y-auto bg-[#0b0c0f] border-l border-white/10"
      aria-label={`${it.name} details`}
    >
      <div className="relative">
        {facts.model && !picture ? (
          <div className="relative w-full aspect-square bg-black">
            <Suspense fallback={<GoldCard icon={<Box size={40} color={GOLD} />} label="3D" title={m.name} />}>
              <ModelViewer src={facts.model} contentType="model/gltf-binary" />
            </Suspense>
          </div>
        ) : (
          <NftHero m={m} pending={!!it.pending} />
        )}
        {facts.model && (
          <button
            onClick={() => setPicture((v) => !v)}
            className="absolute top-3 left-3 z-10 h-9 px-3 flex items-center gap-1.5 rounded-full bg-black/60 backdrop-blur text-xs font-semibold text-white hover:bg-black/80"
          >
            <Box size={14} color={GOLD} />
            {picture ? 'View in 3D' : 'Picture'}
          </button>
        )}
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 h-9 w-9 flex items-center justify-center rounded-full bg-black/60 backdrop-blur hover:bg-black/80"
        >
          <X size={18} color="#fff" />
        </button>
      </div>
      <div className="px-4 py-4 flex flex-col gap-4">
        <NftHeader
          name={it.name}
          collection={it.collection ? collectionLabel(it.collection) : undefined}
          contentType={it.contentType}
          size={facts.size}
          status={it.pending ? 'pending' : it.listed ? 'listed' : 'onchain'}
          origin={it.origin}
          chainLink={ordinalsUrl(it.origin) || undefined}
        />
        {it.pending && <PendingCard />}
        <div className="rounded-2xl bg-[#111216] border border-white/5 px-3 py-1">
          {facts.description && <Row label="Description">{facts.description}</Row>}
          <Row label="Outpoint">{it.outpoint}</Row>
          <Row label="Minted">{facts.mintDate ?? (it.pending ? 'Not yet' : '…')}</Row>
          <Row label="Held in">
            {it.listed
              ? 'This wallet, in a sale listing (OrdLock v2)'
              : it.legacyListing
                ? 'This wallet, in a withdrawn OrdLock v1 listing'
                : 'This wallet'}
          </Row>
          <Row label="File">
            {it.contentType ?? 'Unknown type'}
            {facts.size ? ` · ${facts.size}` : ''}
          </Row>
          {it.listed && <Row label="Listed for">{it.price ? `${it.price.toLocaleString()} sats` : 'Listed'}</Row>}
          <Row label="History">
            <a href={`https://whatsonchain.com/tx/${originTx}`} target="_blank" rel="noreferrer" className="underline">
              Mint on WhatsOnChain
            </a>
            {' · '}
            <a href={ordinalsUrl(it.origin)} target="_blank" rel="noreferrer" className="underline">
              1satordinals.com
            </a>
          </Row>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            disabled={off || it.listed || it.legacyListing}
            title={it.listed ? 'Cancel the listing first' : undefined}
            onClick={() => setSending(true)}
            className={`${btn} text-[#010101]`}
            style={{ background: GOLD }}
          >
            <Send size={15} /> Send
          </button>
          {it.listed && (
            <button
              disabled={off}
              onClick={() => void cancelListing()}
              className={`${btn} bg-[var(--bw-surface)] text-white`}
            >
              Cancel listing
            </button>
          )}
          <button disabled={off} onClick={() => void download()} className={`${btn} bg-[var(--bw-surface)] text-white`}>
            <Download size={15} /> Download
          </button>
          <a
            href={`https://whatsonchain.com/tx/${txid}`}
            target="_blank"
            rel="noreferrer"
            aria-disabled={it.pending}
            onClick={(e) => it.pending && e.preventDefault()}
            className={`${btn} bg-[var(--bw-surface)] text-white ${it.pending ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <ExternalLink size={15} /> Open on chain
          </a>
          <button
            onClick={() => void copy(shareLink, 'Link copied')}
            className={`${btn} bg-[var(--bw-surface)] text-white`}
          >
            <Copy size={15} /> Copy link
          </button>
          <button onClick={() => setFiling(true)} className={`${btn} bg-[var(--bw-surface)] text-white`}>
            <FolderPlus size={15} /> Add to album
          </button>
          <button
            onClick={() => {
              updateAlbums((s) => setHidden(s, [key], !hidden));
              setMsg(hidden ? 'Unhidden. It’s back in your NFTs.' : 'Hidden. Find it in the Hidden album.');
            }}
            className={`${btn} bg-[var(--bw-surface)] text-white`}
          >
            {hidden ? <Eye size={15} /> : <EyeOff size={15} />} {hidden ? 'Unhide' : 'Hide'}
          </button>
        </div>
        <p className="text-[11px] text-[#98A2B3] m-0">{HIDE_NOTE}</p>
        {it.legacyListing && (
          <p className="text-[11px] text-[color:var(--bw-accent)]">
            This NFT sits in an old OrdLock v1 listing. 1Sat withdrew that contract, so it isn’t for sale and can’t be
            sent from here.
          </p>
        )}
        {it.pending && (
          <p className="text-[11px] text-[#e6d08a]">Send, Download and Open on chain are off until it lands.</p>
        )}
        {msg && <p className="text-xs text-[#98A2B3] break-all">{msg}</p>}
      </div>
      {filing && (
        <AddToAlbumSheet
          state={albums}
          update={updateAlbums}
          keys={[key]}
          title={`Add “${it.name}” to album`}
          onClose={() => setFiling(false)}
        />
      )}
      {sending && (
        <NftDetail
          item={m}
          all={all}
          onClose={() => setSending(false)}
          onSent={() => {
            setSending(false);
            onChanged();
          }}
        />
      )}
    </aside>
  );
};

/* ---------- Empty state ---------- */

const Empty = ({ onMint }: { onMint: () => void }) => (
  <div className="flex flex-col items-center justify-center text-center gap-4 py-20 px-6">
    <div
      className="h-40 w-40 rounded-3xl flex items-center justify-center"
      style={{
        background:
          'conic-gradient(from 210deg, var(--bw-accent), #7a5a00, var(--bw-accent-hi), #3a2c05, var(--bw-accent))',
        boxShadow: '0 0 60px rgb(var(--bw-accent-rgb) / 0.25)',
      }}
    >
      <div className="h-32 w-32 rounded-2xl bg-[#0b0c0f] flex items-center justify-center">
        <Sparkles size={44} color={GOLD} />
      </div>
    </div>
    <div className="text-lg font-semibold text-white">No NFTs here yet</div>
    <p className="max-w-sm text-sm text-[#98A2B3]">
      Pictures, music, video and pages you mint or receive show up here, each with its own page.
    </p>
    <button
      onClick={onMint}
      className="rounded-xl px-5 py-2.5 text-sm font-semibold text-[#010101]"
      style={{ background: GOLD }}
    >
      Mint a picture in bPics
    </button>
  </div>
);

/* ---------- Page ---------- */

const NftLibraryPage = () => {
  const navigate = useNavigate();
  const { outpoint: openParam } = useParams();
  const { items: media, hasMore, loading, error, loadMore, refresh } = useWalletMedia();
  const [filter, setFilter] = useState<LibraryFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<SortKey>('newest');
  const [note, setNote] = useState('');
  const xpub = useRelayxAccount();
  const [pickedSource, setPickedSource] = useState<Source>(readSource);
  // Without a RelayX xpub there is no Run list, so Run falls back to All (which is then just 1Sat).
  const source: Source = !xpub && pickedSource === 'run' ? 'all' : pickedSource;
  const pickSource = (s: Source) => {
    setPickedSource(s);
    try {
      localStorage.setItem(SOURCE_KEY, s);
    } catch {
      // Blocked storage: the choice just isn't remembered.
    }
  };
  // RelayxRecoverScreen open (focus = a saved NFT's origin); closing it re-reads the saved search.
  const [relayx, setRelayx] = useState<{ focus?: string } | null>(null);
  const [runVersion, setRunVersion] = useState(0);
  const runAll = useMemo(
    () => (xpub ? (loadSavedRelayx(xpub)?.result.nfts ?? null) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the search screen closes
    [xpub, runVersion],
  );

  // Load the whole collection (50 per page) so filters, search and counts cover everything.
  useEffect(() => {
    if (hasMore && !loading && !error) void loadMore();
  }, [hasMore, loading, error, loadMore]);

  const lib = useMemo(
    () =>
      media.map((m, i) =>
        toLibraryItem({ output: m.output, name: m.name, type: m.type, origin: m.origin, pending: isPending(m) }, i),
      ),
    [media],
  );
  const byOutpoint = useMemo(() => new Map(media.map((m) => [m.output.outpoint.replace('.', '_'), m])), [media]);
  // Albums and Hidden (albums.ts): the album row picks which items the filters below work on.
  const [albums, updateAlbums] = useAlbums();
  const [pickedView, setView] = useState<AlbumView>(ALL_VIEW);
  const view = liveView(albums, pickedView);
  const inView = useMemo(() => filterView(lib, keyOf, albums, view), [lib, albums, view]);
  const albumCounts = useMemo(() => viewCounts(lib, keyOf, albums), [lib, albums]);
  // Selecting (Select button or long-press a tile): outpoints picked.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [filing, setFiling] = useState<ItemKey[] | null>(null);
  const togglePick = (op: string) =>
    setPicked((p) => {
      const n = new Set(p ?? []);
      if (n.has(op)) n.delete(op);
      else n.add(op);
      return n;
    });
  const pickedKeys = (): ItemKey[] => (picked ? lib.filter((i) => picked.has(i.outpoint)).map(keyOf) : []);
  const shown = useMemo(() => filterAndSort(inView, filter, sort), [inView, filter, sort]);
  const runShown = useMemo(() => {
    const q = filter.query.trim().toLowerCase();
    return runAll && q
      ? runAll.filter((f) => `${f.title} ${f.collection} ${f.origin}`.toLowerCase().includes(q))
      : runAll;
  }, [runAll, filter.query]);
  const showOneSat = source !== 'run';
  const showRun = !!xpub && source !== '1sat';
  const groups = useMemo(() => groupByCollection(inView), [inView]);
  const counts = useMemo(() => typeCounts(inView), [inView]);
  const listedCount = inView.filter((i) => i.listed).length;
  const pendingCount = inView.filter((i) => i.pending).length;

  const openKey = (openParam ?? '').replace('.', '_');
  const openItem = lib.find((i) => i.outpoint === openKey);
  const openMedia = openItem ? byOutpoint.get(openItem.outpoint) : undefined;

  // Windowed grid.
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 900, h: 700, top: 0 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setBox((b) => ({ ...b, w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const inner = Math.max(200, box.w - 32);
  const cols = Math.max(1, Math.floor((inner + GAP) / (MIN_TILE + GAP)));
  const size = Math.floor((inner - GAP * (cols - 1)) / cols);
  const rowH = size + CAPTION + GAP;
  const rows = Math.ceil(shown.length / cols);
  const { first, last } = visibleRows(box.top, box.h, rowH, rows);

  const set = (p: Partial<LibraryFilter>) => setFilter((f) => ({ ...f, ...p }));
  const toggleType = (t: NftType) =>
    set({ types: filter.types.includes(t) ? filter.types.filter((x) => x !== t) : [...filter.types, t] });
  const chip = (on: boolean) =>
    `rounded-full px-3 py-1 text-xs font-semibold border transition-colors ${
      on
        ? 'border-[color:var(--bw-accent)] bg-[color:var(--bw-accent)]/15 text-[color:var(--bw-accent)]'
        : 'border-white/10 text-[#D0D5DD] hover:border-white/30'
    }`;
  const filtered = filter !== EMPTY_FILTER;

  const doRefresh = async () => {
    try {
      const r = await refresh();
      setNote(r.added ? `${r.added} new` : 'Up to date');
    } catch {
      /* error line shows */
    }
  };

  // The account's minted bAvatar, if this wallet holds it (BavatarKeep shows it either way).
  const bavatarOp = lib.find((i) => isBavatarItem(i.name))?.outpoint;
  const audioMedia = useMemo(() => media.filter((m) => m.kind === 'music'), [media]);

  return (
    // Phone: the app's top bar sits above the page (each phone page mounts it); Desktop has its own shell bar.
    <div
      className="flex h-full min-h-0 text-white bg-[#08090b]"
      style={WIDE_ON ? undefined : { paddingTop: 'calc(56px + var(--wallet-inset-top, 0px))' }}
    >
      {!WIDE_ON && <TopNav />}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <WalletTabs active="nfts" />
        <div className="px-4 pt-3 pb-2 flex flex-col gap-2 border-b border-white/5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 flex-1 min-w-[220px] rounded-xl bg-[var(--bw-surface)] px-3 py-2">
              <Search size={15} color="#98A2B3" />
              <input
                value={filter.query}
                onChange={(e) => set({ query: e.target.value })}
                placeholder="Search name, collection or outpoint"
                aria-label="Search NFTs"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-[#667085]"
              />
            </label>
            <select
              value={filter.collection}
              onChange={(e) => set({ collection: e.target.value })}
              aria-label="Collection"
              className="rounded-xl bg-[var(--bw-surface)] px-3 py-2 text-sm"
            >
              <option value="">All collections ({inView.length})</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {collectionLabel(g.id)} ({g.count})
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort"
              className="rounded-xl bg-[var(--bw-surface)] px-3 py-2 text-sm"
            >
              <option value="newest">Newest</option>
              <option value="name">Name</option>
              <option value="collection">Collection</option>
            </select>
            <button
              onClick={() => void doRefresh()}
              aria-label="Refresh"
              className="flex items-center gap-1.5 rounded-xl bg-[var(--bw-surface)] px-3 py-2 text-sm"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
            {showOneSat && lib.length > 0 && (
              <button
                onClick={() => setPicked((p) => (p ? null : new Set()))}
                aria-pressed={!!picked}
                className="rounded-xl bg-[var(--bw-surface)] px-3 py-2 text-sm"
              >
                {picked ? 'Done' : 'Select'}
              </button>
            )}
          </div>
          {showOneSat && (
            <AlbumBar state={albums} update={updateAlbums} view={view} onView={setView} counts={albumCounts} />
          )}
          {view.kind === 'hidden' && <p className="text-[11px] text-[#98A2B3] m-0">{HIDE_NOTE}</p>}
          {picked && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--bw-surface)] px-3 py-2">
              <span className="text-xs font-semibold mr-auto">
                {picked.size ? `${picked.size} selected` : 'Tap NFTs to select'}
              </span>
              <button
                disabled={!picked.size}
                onClick={() => setFiling(pickedKeys())}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-[#010101] disabled:opacity-40"
                style={{ background: GOLD }}
              >
                <FolderPlus size={13} /> Add to album
              </button>
              {view.kind === 'album' && (
                <button
                  disabled={!picked.size}
                  onClick={() => {
                    const keys = pickedKeys();
                    updateAlbums((s) => removeFromAlbum(s, view.id, keys));
                    setPicked(null);
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-white/15 disabled:opacity-40"
                >
                  Remove from album
                </button>
              )}
              <button
                disabled={!picked.size}
                onClick={() => {
                  const keys = pickedKeys();
                  updateAlbums((s) => setHidden(s, keys, view.kind !== 'hidden'));
                  setPicked(null);
                }}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border border-white/15 disabled:opacity-40"
              >
                {view.kind === 'hidden' ? <Eye size={13} /> : <EyeOff size={13} />}
                {view.kind === 'hidden' ? 'Unhide' : 'Hide'}
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <div role="group" aria-label="Source" className="flex rounded-full bg-[var(--bw-surface)] p-0.5 mr-1">
              {(['all', '1sat', 'run'] as const)
                .filter((s) => s !== 'run' || xpub)
                .map((s) => (
                  <button
                    key={s}
                    aria-pressed={source === s}
                    onClick={() => pickSource(s)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                      source === s ? 'bg-[color:var(--bw-accent)] text-[#010101]' : 'text-[#D0D5DD]'
                    }`}
                  >
                    {s === 'all' ? 'All' : s === '1sat' ? '1Sat' : 'Run'}
                  </button>
                ))}
            </div>
            {showOneSat &&
              NFT_TYPES.filter((t) => counts[t.id]).map((t) => (
                <button key={t.id} className={chip(filter.types.includes(t.id))} onClick={() => toggleType(t.id)}>
                  {t.label} {counts[t.id]}
                </button>
              ))}
            {listedCount > 0 && (
              <button className={chip(filter.listedOnly)} onClick={() => set({ listedOnly: !filter.listedOnly })}>
                Listed for sale {listedCount}
              </button>
            )}
            {pendingCount > 0 && (
              <button className={chip(filter.pendingOnly)} onClick={() => set({ pendingOnly: !filter.pendingOnly })}>
                Pending {pendingCount}
              </button>
            )}
            {filtered && (
              <button className="text-xs text-[#98A2B3] underline px-2" onClick={() => setFilter(EMPTY_FILTER)}>
                Clear
              </button>
            )}
            <span className="ml-auto text-xs text-[#98A2B3]">
              {shown.length === inView.length ? `${inView.length}` : `${shown.length} of ${inView.length}`} NFT
              {inView.length === 1 ? '' : 's'}
              {hasMore ? ' · loading more…' : ''}
              {note ? ` · ${note}` : ''}
            </span>
          </div>
          {error && <div className="text-xs text-[#F97066]">{error}</div>}
          <BavatarKeep mintedOutpoint={bavatarOp} onOpen={(op) => navigate(`${ROUTE}/${op}`)} />
        </div>

        <div
          ref={scroller}
          className="flex-1 min-h-0 overflow-y-auto px-4 pt-4"
          onScroll={(e) => setBox((b) => ({ ...b, top: (e.target as HTMLDivElement).scrollTop }))}
        >
          {!showOneSat ? null : !lib.length && !hasMore && !loading && !error ? (
            showRun ? null : (
              <Empty onMint={() => navigate('/m/bpics')} />
            )
          ) : !shown.length && lib.length ? (
            <div className="py-16 text-center text-sm text-[#98A2B3]">
              {inView.length
                ? 'Nothing matches these filters.'
                : view.kind === 'hidden'
                  ? 'Nothing hidden. Open an NFT and tap Hide to keep it out of your lists.'
                  : view.kind === 'album'
                    ? 'Nothing in this album yet. Tap Select, pick NFTs and tap Add to album.'
                    : 'Every NFT here is hidden. Open the Hidden album to see them.'}
            </div>
          ) : (
            <div style={{ height: rows * rowH, position: 'relative' }}>
              {Array.from({ length: Math.max(0, last - first) }, (_, r) => {
                const row = first + r;
                return (
                  <div key={row} className="absolute left-0 flex" style={{ top: row * rowH, gap: GAP }}>
                    {shown.slice(row * cols, row * cols + cols).map((it) => {
                      const m = byOutpoint.get(it.outpoint);
                      return m ? (
                        <Tile
                          key={it.outpoint}
                          m={m}
                          it={it}
                          size={size}
                          onOpen={() => (picked ? togglePick(it.outpoint) : navigate(`${ROUTE}/${it.outpoint}`))}
                          onPlay={() => playMusic(audioMedia, m)}
                          picked={picked ? picked.has(it.outpoint) : undefined}
                          onLongPress={() => setPicked((p) => new Set([...(p ?? []), it.outpoint]))}
                        />
                      ) : null;
                    })}
                  </div>
                );
              })}
            </div>
          )}
          {showRun && (
            <RunSection
              nfts={runShown}
              heading={showOneSat}
              onOpen={(f) => setRelayx({ focus: f.origin })}
              onSearch={() => setRelayx({})}
            />
          )}
        </div>
      </div>
      {filing && (
        <AddToAlbumSheet
          state={albums}
          update={updateAlbums}
          keys={filing}
          onClose={() => {
            setFiling(null);
            setPicked(null);
          }}
        />
      )}
      {relayx && xpub && (
        <RelayxRecoverScreen
          xpub={xpub}
          focus={relayx.focus}
          onBack={() => {
            setRelayx(null);
            setRunVersion((v) => v + 1);
          }}
        />
      )}

      {openParam && (
        // Phone: full screen over the list (a side column pushed the page sideways). Wide: side column.
        <div className="fixed inset-0 z-40 pt-[env(safe-area-inset-top)] bg-[#0b0c0f] md:static md:z-auto md:pt-0 md:bg-transparent md:w-[400px] md:max-w-[45%] md:shrink-0 min-h-0">
          {openItem && openMedia ? (
            <DetailPanel
              key={openItem.outpoint}
              m={openMedia}
              it={openItem}
              all={media}
              onClose={() => navigate(ROUTE)}
              onChanged={() => void doRefresh()}
            />
          ) : (
            <aside className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center bg-[#0b0c0f] border-l border-white/10">
              <div className="text-sm text-[#98A2B3]">
                {hasMore || loading ? 'Finding this NFT…' : 'This NFT isn’t in this wallet.'}
              </div>
              <button className="text-xs underline text-[#98A2B3]" onClick={() => navigate(ROUTE)}>
                Back to all NFTs
              </button>
            </aside>
          )}
        </div>
      )}
    </div>
  );
};

export default NftLibraryPage;
