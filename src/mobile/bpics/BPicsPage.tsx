import { useWithoutHidden } from '../albums/useAlbums';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  EyeOff,
  Flag,
  Globe,
  ImagePlus,
  Lock,
  Search,
  Share2,
  UploadCloud,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { SendConfirmation } from '../../components/SendConfirmation';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';
import { useBackClose } from '../backStack';
import { mintMedia } from '../mint/mintMedia';
import {
  BLOCKED_MESSAGE,
  blockedText,
  estimateCost,
  formatBytes,
  notifyMinted,
  validateForm,
  wocTxUrl,
} from '../mint/mint';
import { money, moneyWithSats } from '../money/money';
import { contentUrls } from '../market/indexer';
import { cachedIssuer, verifyIssuer, type IssuerInfo } from '../issuer/issuerVerify';
import { bavatarDataUri } from '../names/avatar';
import { ReportSheet } from '../ugc/UgcSheets';
import { isBlocked, onUgcChange } from '../ugc/ugc';
import { useWalletMedia } from '../media/useWalletMedia';
import { prepareCardImage, saveCardImage } from '../wallet/cardFrontArt';
import { shareLink } from '../chat/shareLink';
import {
  base64Bytes,
  buildPicMap,
  feedUrl,
  hideMinter,
  hidePic,
  isSafeImageType,
  loadHidden,
  PAGE_SIZE,
  parseFeed,
  PIC_MAX_EDGE,
  PIC_QUALITY,
  saveHidden,
  SHARE_DEFAULT,
  splitDataUri,
  visibleFeed,
  withRepeatGuard,
  type Pic,
} from './bpics';
import { ALLOWED_COLLECTIONS, fetchCollectionPage, COLLECTION_PAGE, ordfsUrl, type ChainPic } from './collections';
import { MARKET_ENABLED } from '../storeBuild';

/**
 * bPics (Apps › bPics, /m/bpics; Desktop /bpics): a photo app for picture ordinals.
 * Library = pictures people chose to share, newest first. My pics = pictures this wallet holds.
 * Masonry grid, lightbox with details, drag-and-drop mint with the price shown before confirming.
 * Only pictures are shown, always through <img>. Both editions: nothing here sells, funds or likes.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#14161A';
const BORDER = '#3a2f0c';
const MUTED = '#98A2B3';
const GOLD_BG = 'linear-gradient(135deg, #2a2207, #0b0b0b)';
const GOLD_BTN = 'linear-gradient(135deg, #FFE27A, #E0A800)';

type Tab = 'chain' | 'library' | 'mine';

/** One picture as the grid and the lightbox see it, from either tab. */
type Item = {
  key: string;
  origin: string;
  urls: string[];
  name: string;
  description: string;
  contentType: string;
  /** Block height; 0 = not yet mined (Pending). Undefined = unknown (wallet items). */
  height?: number;
  owner?: string;
  who?: string;
  avatar?: string;
  shared?: boolean;
  pending?: boolean;
  pic?: Pic;
  walletUrl?: string;
  /** On-chain collection items: collection name, item number, listing price (sats; 0 = not listed). */
  collection?: string;
  number?: string;
  price?: number;
};

const txidOf = (origin: string) => origin.slice(0, 64);

// ── Shared bits ──

const shimmerCss = `@keyframes bpicsShimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}`;
const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, #1a1505 0%, #3a2d08 40%, #1a1505 80%)',
  backgroundSize: '200% 100%',
  animation: 'bpicsShimmer 1.6s linear infinite',
};

/** Gold-on-black skeleton tiles with varied heights, shown while a page loads. */
const Skeletons = ({ n = 8 }: { n?: number }) => (
  <>
    {Array.from({ length: n }, (_, i) => (
      <div
        key={i}
        className="mb-3 rounded-2xl break-inside-avoid"
        style={{ ...shimmer, height: [220, 300, 180, 260, 340, 200][i % 6] }}
      />
    ))}
  </>
);

/** An <img> that steps through the content hosts; gold shimmer until it loads; gold art if all fail. */
const PicImg = ({
  urls,
  alt,
  fit = 'grid',
  onSize,
}: {
  urls: string[];
  alt: string;
  fit?: 'grid' | 'full';
  onSize?: (w: number, h: number) => void;
}) => {
  const [i, setI] = useState(0);
  const [loaded, setLoaded] = useState(false);
  if (i >= urls.length)
    return (
      <div
        className="w-full flex flex-col items-center justify-center gap-2"
        style={{ background: GOLD_BG, aspectRatio: fit === 'grid' ? '1' : undefined, minHeight: 200 }}
      >
        <ImagePlus size={28} color={GOLD} />
        <span className="text-xs" style={{ color: MUTED }}>
          Picture not available yet
        </span>
      </div>
    );
  return (
    <div className="relative w-full" style={!loaded && fit === 'grid' ? { minHeight: 180 } : undefined}>
      {!loaded && <div className="absolute inset-0" style={shimmer} />}
      <img
        src={urls[i]}
        alt={alt}
        loading={fit === 'grid' ? 'lazy' : 'eager'}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={(e) => {
          setLoaded(true);
          onSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
        }}
        onError={() => setI((n) => n + 1)}
        className={fit === 'grid' ? 'w-full h-auto block' : 'max-w-full max-h-full object-contain block mx-auto'}
        style={{ opacity: loaded ? 1 : 0, transition: 'opacity .25s' }}
      />
    </div>
  );
};

const Badge = ({ children, tone = 'dark' }: { children: ReactNode; tone?: 'dark' | 'gold' }) => (
  <span
    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
    style={
      tone === 'gold'
        ? { background: GOLD, color: '#1a1400' }
        : { background: 'rgba(0,0,0,0.65)', color: '#eee', backdropFilter: 'blur(4px)' }
    }
  >
    {children}
  </span>
);

/** Empty state with gold art. */
const Empty = ({ title, text, action }: { title: string; text: string; action?: ReactNode }) => (
  <div className="flex flex-col items-center text-center py-16 px-4 gap-3">
    <div
      className="w-24 h-24 rounded-3xl flex items-center justify-center"
      style={{
        background: GOLD_BG,
        border: `1px solid ${BORDER}`,
        boxShadow: '0 0 40px rgb(var(--bw-accent-hi-rgb) / 0.12)',
      }}
    >
      <ImagePlus size={40} color={GOLD} />
    </div>
    <p className="font-bold text-lg" style={{ color: GOLD }}>
      {title}
    </p>
    <p className="text-sm max-w-sm" style={{ color: MUTED }}>
      {text}
    </p>
    {action}
  </div>
);

const GoldButton = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold border-0 cursor-pointer"
    style={{ background: GOLD_BTN, color: '#1a1400' }}
  >
    {children}
  </button>
);

/** Calls `onMore` when the sentinel scrolls into view (infinite scroll). */
const Sentinel = ({ onMore, active }: { onMore: () => void; active: boolean }) => {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onMore);
  cb.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || !active || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && cb.current(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [active]);
  return <div ref={ref} className="h-1" />;
};

const Grid = ({ items, onOpen }: { items: Item[]; onOpen: (i: number) => void }) => (
  <>
    {items.map((it, idx) => (
      <button
        key={it.key}
        type="button"
        onClick={() => onOpen(idx)}
        className="group relative block w-full mb-3 rounded-2xl overflow-hidden border cursor-pointer p-0 text-left break-inside-avoid"
        style={{ borderColor: BORDER, background: '#0b0b0b' }}
      >
        <PicImg urls={it.urls} alt={it.name} />
        <div className="absolute top-2 left-2 flex gap-1">
          {(it.pending || it.height === 0) && <Badge tone="gold">Pending</Badge>}
          {it.shared === false && (
            <Badge>
              <Lock size={10} /> Private
            </Badge>
          )}
        </div>
        <div
          className="absolute inset-x-0 bottom-0 px-3 pt-8 pb-2 flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85), transparent)' }}
        >
          {it.avatar ? (
            <img src={it.avatar} alt="" width={18} height={18} className="rounded-full shrink-0" />
          ) : it.who ? (
            <span className="w-[18px] h-[18px] rounded-full shrink-0" style={{ background: GOLD }} />
          ) : null}
          <span className="text-xs font-semibold text-white truncate">{it.name}</span>
          {it.who && (
            <span className="text-[11px] truncate ml-auto" style={{ color: '#ccc' }}>
              {it.who}
            </span>
          )}
        </div>
      </button>
    ))}
  </>
);

const Masonry = ({ children }: { children: ReactNode }) => (
  <div className="columns-2 sm:columns-3 lg:columns-4 2xl:columns-5 gap-3">{children}</div>
);

const matches = (it: Item, q: string) =>
  !q || [it.name, it.description, it.who ?? '', it.owner ?? ''].some((s) => s.toLowerCase().includes(q));

const minterKeys = (p: Pic, info: IssuerInfo | null | undefined) => ({
  keys: [info?.status === 'verified' ? info.identityKey : undefined, p.owner].filter((k): k is string => !!k),
  handle: info?.status === 'verified' ? (info.handle ?? null) : null,
});

/** Pictures minted in this session that the wallet list hasn't returned yet. */
type JustMinted = { txid: string; uri: string; title: string; share: boolean };

// ── Page ──

const BPicsPage = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('chain');
  const [minting, setMinting] = useState(false);
  const [query, setQuery] = useState('');
  const [justMinted, setJustMinted] = useState<JustMinted[]>([]);
  const q = query.trim().toLowerCase();
  return (
    <div className="min-h-full text-white" style={{ background: '#0b0b0b' }}>
      <style>{shimmerCss}</style>
      <div
        className="sticky top-0 z-10 px-4 pt-3 pb-3 border-b"
        style={{ background: 'rgba(11,11,11,0.92)', backdropFilter: 'blur(10px)', borderColor: '#1f1a0a' }}
      >
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="bg-transparent border-0 cursor-pointer p-1 -ml-1"
          >
            <ArrowLeft size={20} color="#ddd" />
          </button>
          <span className="font-bold text-xl tracking-tight" style={{ color: GOLD }}>
            bPics
          </span>
          <div
            className="flex rounded-full p-1 border"
            style={{ borderColor: BORDER, background: '#111' }}
            role="tablist"
          >
            {(['chain', 'library', 'mine'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className="px-3.5 py-1.5 rounded-full text-sm font-semibold cursor-pointer border-0"
                style={
                  tab === t ? { background: GOLD, color: '#1a1400' } : { background: 'transparent', color: '#ccc' }
                }
              >
                {t === 'chain' ? 'On chain' : t === 'library' ? 'Shared' : 'My pics'}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 w-full sm:w-auto order-last sm:order-none">
            <label
              className="flex items-center gap-2 rounded-full px-3 py-2 border flex-1 sm:w-64"
              style={{ borderColor: BORDER, background: '#111' }}
            >
              <Search size={15} color={MUTED} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  tab === 'mine'
                    ? 'Search my pics'
                    : tab === 'chain'
                      ? 'Search names or numbers'
                      : 'Search titles or $handles'
                }
                className="bg-transparent border-0 outline-none text-sm text-white w-full"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  className="bg-transparent border-0 cursor-pointer p-0"
                >
                  <X size={14} color={MUTED} />
                </button>
              )}
            </label>
          </div>
          <GoldButton onClick={() => setMinting(true)}>
            <ImagePlus size={16} /> Mint a picture
          </GoldButton>
        </div>
      </div>
      <div className="max-w-[1600px] mx-auto px-4 pt-4 bw-dock-pad">
        {tab === 'chain' ? (
          <OnChain q={q} />
        ) : tab === 'library' ? (
          <Library q={q} onMint={() => setMinting(true)} />
        ) : (
          <Mine q={q} justMinted={justMinted} onMint={() => setMinting(true)} />
        )}
      </div>
      {minting && (
        <MintPicSheet
          onClose={() => setMinting(false)}
          onMinted={(m) => {
            setJustMinted((l) => [m, ...l]);
            setTab('mine');
          }}
        />
      )}
    </div>
  );
};
export default BPicsPage;

// ── On chain (allowlisted collections only; see collections.ts) ──

const toItem = (p: ChainPic, collection: string): Item => ({
  key: p.origin,
  origin: p.origin,
  urls: contentUrls(p.origin),
  name: p.name,
  description: '',
  contentType: p.contentType,
  height: p.height || undefined,
  owner: p.owner,
  who: p.owner ? `${p.owner.slice(0, 6)}…` : undefined,
  collection,
  number: p.number,
  price: p.price,
});

const OnChain = ({ q }: { q: string }) => (
  <>
    <p className="text-sm mb-4" style={{ color: MUTED }}>
      Picture collections already public on Bitcoin, chosen by bWalletX. Only checked collections appear here.
    </p>
    {ALLOWED_COLLECTIONS.map((c) => (
      <CollectionSection key={c.id} id={c.id} name={c.name} artist={c.artist} description={c.description} q={q} />
    ))}
  </>
);

const CollectionSection = ({
  id,
  name,
  artist,
  description,
  q,
}: {
  id: string;
  name: string;
  artist: string;
  description: string;
  q: string;
}) => {
  const [pics, setPics] = useState<ChainPic[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const busy = useRef(false);
  const load = useCallback(
    async (from: number) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      setError('');
      try {
        const page = await fetchCollectionPage(id, from);
        setPics((prev) => {
          const all = from === 0 ? page.pics : [...prev, ...page.pics];
          const seen = new Set<string>();
          return all.filter((p) => !seen.has(p.origin) && !!seen.add(p.origin));
        });
        setOffset(from + page.rawCount);
        setMore(page.rawCount === COLLECTION_PAGE);
      } catch {
        setError(`Couldn't load ${name}. Check your connection and try again.`);
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [id, name],
  );
  useEffect(() => void load(0), [load]);
  const items = pics
    .map((p) => toItem(p, name))
    .filter((it) => matches(it, q) || (!!it.number && it.number.includes(q)));
  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-2 flex-wrap mb-1">
        <h2 className="font-bold text-lg m-0" style={{ color: GOLD }}>
          {name}
        </h2>
        <span className="text-sm" style={{ color: '#ccc' }}>
          by {artist}
        </span>
        <a
          href={ordfsUrl(id)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs inline-flex items-center gap-1 no-underline ml-auto"
          style={{ color: GOLD }}
        >
          Collection on chain <ExternalLink size={11} />
        </a>
      </div>
      {description && (
        <p className="text-sm mt-0 mb-3" style={{ color: MUTED }}>
          {description}
        </p>
      )}
      {items.length > 0 || loading ? (
        <Masonry>
          <Grid items={items} onOpen={setOpen} />
          {loading && <Skeletons n={pics.length ? 4 : 8} />}
        </Masonry>
      ) : (
        !error && (
          <Empty
            title="Nothing to show"
            text={q ? `Nothing in ${name} matches “${q}”.` : `No pictures from ${name} right now.`}
          />
        )
      )}
      {error && (
        <div className="flex flex-col items-center gap-2 mt-4">
          <p className="text-sm" style={{ color: '#ff6b6b' }}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load(pics.length ? offset : 0)}
            className="px-4 py-2 rounded-full text-sm font-semibold border bg-transparent cursor-pointer"
            style={{ borderColor: BORDER, color: GOLD }}
          >
            Try again
          </button>
        </div>
      )}
      <Sentinel active={more && !loading && !error && pics.length > 0} onMore={() => void load(offset)} />
      {open !== null && items[open] && (
        <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </section>
  );
};

// ── Library ──

const Library = ({ q, onMint }: { q: string; onMint: () => void }) => {
  const [pics, setPics] = useState<Pic[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(loadHidden);
  const [issuers, setIssuers] = useState<Record<string, IssuerInfo>>({});
  const [, setTick] = useState(0);
  const [reporting, setReporting] = useState<Pic | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => onUgcChange(() => setTick((n) => n + 1)), []);

  const busy = useRef(false);
  const load = useCallback(async (from: number) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      const r = await fetch(feedUrl(from), { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(String(r.status));
      const raw = (await r.json()) as unknown[];
      const page = parseFeed(raw);
      setPics((prev) => (from === 0 ? page : [...prev, ...page]));
      setOffset(from + (Array.isArray(raw) ? raw.length : 0));
      setMore(Array.isArray(raw) && raw.length === PAGE_SIZE);
    } catch {
      setError("Couldn't load bPics. Check your connection and try again.");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(0), [load]);

  // Who minted each picture: the issuer signature in its mint tx, checked on this device (issuer/issuerVerify).
  useEffect(() => {
    let live = true;
    for (const p of pics) {
      if (issuers[p.origin]) continue;
      const hit = cachedIssuer(p.origin);
      if (hit) {
        setIssuers((m) => ({ ...m, [p.origin]: hit }));
        continue;
      }
      void verifyIssuer(p.origin).then((i) => live && setIssuers((m) => ({ ...m, [p.origin]: i })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pics]);

  const shown = visibleFeed(pics, hidden, (p) => minterKeys(p, issuers[p.origin]), isBlocked);
  const items: Item[] = shown
    .map((p): Item => {
      const info = issuers[p.origin];
      const m = minterKeys(p, info);
      return {
        key: p.origin,
        origin: p.origin,
        urls: contentUrls(p.origin),
        name: p.name,
        description: p.description,
        contentType: p.contentType,
        height: p.height,
        owner: p.owner,
        who: m.handle ? `$${m.handle.replace(/^\$/, '')}` : `${p.owner.slice(0, 6)}…`,
        avatar: (info?.status === 'verified' && bavatarDataUri(info.identityKey)) || undefined,
        shared: true,
        pic: p,
      };
    })
    .filter((it) => matches(it, q));

  const update = (h: typeof hidden) => {
    saveHidden(h);
    setHidden(h);
  };

  return (
    <>
      <p className="text-sm mb-4" style={{ color: MUTED }}>
        Pictures people chose to share in bPics, newest first.
      </p>
      {items.length > 0 || loading ? (
        <Masonry>
          <Grid items={items} onOpen={setOpen} />
          {loading && <Skeletons n={pics.length ? 4 : 10} />}
        </Masonry>
      ) : (
        !error &&
        (q ? (
          <Empty title="Nothing found" text={`No shared pictures match “${q}”.`} />
        ) : (
          <Empty
            title="No shared pictures yet"
            text="Mint a picture and tick Share in bPics to be the first in the library."
            action={<GoldButton onClick={onMint}>Mint a picture</GoldButton>}
          />
        ))
      )}
      {error && (
        <div className="flex flex-col items-center gap-2 mt-6">
          <p className="text-sm" style={{ color: '#ff6b6b' }}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load(pics.length ? offset : 0)}
            className="px-4 py-2 rounded-full text-sm font-semibold border bg-transparent cursor-pointer"
            style={{ borderColor: BORDER, color: GOLD }}
          >
            Try again
          </button>
        </div>
      )}
      <Sentinel active={more && !loading && !error && pics.length > 0} onMore={() => void load(offset)} />
      {open !== null && items[open] && (
        <Lightbox
          items={items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          extra={(it) =>
            it.pic && (
              <ActionButton
                icon={<Flag size={15} />}
                label="Report or hide"
                onClick={() => {
                  setReporting(it.pic ?? null);
                  setOpen(null);
                }}
              />
            )
          }
        />
      )}
      {reporting && (
        <ReportSheet
          title={`Report "${reporting.name}"`}
          report={{ kind: 'feed_post', target: reporting.origin, content: `bPics picture ${reporting.origin}` }}
          onClose={() => setReporting(null)}
          onSent={() => update(hidePic(hidden, reporting.origin))}
          extra={
            <div className="flex flex-col gap-2">
              <SheetButton
                icon={<EyeOff size={14} />}
                label="Hide this picture"
                onClick={() => {
                  update(hidePic(hidden, reporting.origin));
                  setReporting(null);
                }}
              />
              <SheetButton
                icon={<EyeOff size={14} />}
                label="Hide everything from this minter"
                onClick={() => {
                  const m = minterKeys(reporting, issuers[reporting.origin]);
                  update(hideMinter(hidePic(hidden, reporting.origin), [...m.keys, m.handle]));
                  setReporting(null);
                }}
              />
            </div>
          }
        />
      )}
    </>
  );
};

const SheetButton = ({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white border-0 cursor-pointer"
    style={{ background: '#2b2f36' }}
  >
    {icon}
    {label}
  </button>
);

// ── My pics ──

const Mine = ({ q, justMinted, onMint }: { q: string; justMinted: JustMinted[]; onMint: () => void }) => {
  const { chromeStorageService } = useServiceContext();
  const { items: shownRaw, loading, error, hasMore, loadMore } = useWalletMedia();
  const media = useWithoutHidden(shownRaw);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const identityPubKey = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey;

  const held = media.filter((i) => isSafeImageType(i.type));
  const heldTx = new Set(held.map((i) => txidOf(i.origin)));
  const minted = new Map(justMinted.map((m) => [m.txid, m]));
  const items: Item[] = [
    ...justMinted
      .filter((m) => !heldTx.has(m.txid))
      .map(
        (m): Item => ({
          key: `pending-${m.txid}`,
          origin: `${m.txid}_0`,
          urls: [m.uri],
          name: m.title,
          description: '',
          contentType: 'image/jpeg',
          pending: true,
          shared: m.share,
        }),
      ),
    ...held.map(
      (p): Item => ({
        key: p.output.outpoint,
        origin: p.origin,
        urls: [p.url],
        name: p.name,
        description: '',
        contentType: p.type ?? '',
        shared: minted.get(txidOf(p.origin))?.share,
        walletUrl: p.url,
      }),
    ),
  ].filter((it) => matches(it, q));

  const applyToCard = async (url: string) => {
    setNote('');
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const uri = await prepareCardImage(new File([blob], 'pic', { type: blob.type || 'image/jpeg' }));
      setNote(saveCardImage(identityPubKey, uri) ? 'Done. Your card shows this picture.' : 'No room on this device.');
    } catch {
      setNote('That picture couldn’t be used on your card.');
    }
  };

  return (
    <>
      <p className="text-sm mb-4" style={{ color: MUTED }}>
        Pictures in this wallet. New mints show Pending until the network confirms them.
      </p>
      {note && (
        <p className="text-sm mb-3" style={{ color: GOLD }}>
          {note}
        </p>
      )}
      {items.length > 0 || loading ? (
        <Masonry>
          <Grid items={items} onOpen={setOpen} />
          {loading && <Skeletons n={held.length ? 4 : 8} />}
        </Masonry>
      ) : (
        !error &&
        (q ? (
          <Empty title="Nothing found" text={`None of your pictures match “${q}”.`} />
        ) : (
          <Empty
            title="Your pictures live here"
            text="Mint a photo to keep it in your wallet. You choose whether it's shared in the library."
            action={<GoldButton onClick={onMint}>Mint a picture</GoldButton>}
          />
        ))
      )}
      {error && (
        <p className="text-sm mt-4" style={{ color: '#ff6b6b' }}>
          {error}
        </p>
      )}
      <Sentinel active={hasMore && !loading && !error && held.length > 0} onMore={() => void loadMore()} />
      {open !== null && items[open] && (
        <Lightbox
          items={items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          extra={(it) =>
            it.walletUrl && (
              <ActionButton
                icon={<ImagePlus size={15} />}
                label="Use on my card"
                onClick={() => {
                  void applyToCard(it.walletUrl!);
                  setOpen(null);
                }}
              />
            )
          }
        />
      )}
    </>
  );
};

// ── Lightbox ──

const blockTimes = new Map<number, number>();
/** Block time (unix seconds) for a height, from WhatsOnChain; cached. */
const fetchBlockTime = async (height: number): Promise<number | null> => {
  if (blockTimes.has(height)) return blockTimes.get(height)!;
  try {
    const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/block/height/${height}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { time?: number };
    if (typeof j.time !== 'number') return null;
    blockTimes.set(height, j.time);
    return j.time;
  } catch {
    return null;
  }
};

const ActionButton = ({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold border bg-transparent cursor-pointer"
    style={{ borderColor: BORDER, color: GOLD }}
  >
    {icon}
    {label}
  </button>
);

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex justify-between gap-3 py-2 border-b text-sm" style={{ borderColor: '#221d0c' }}>
    <span style={{ color: MUTED }}>{label}</span>
    <span className="text-right min-w-0 break-all">{children}</span>
  </div>
);

const Lightbox = ({
  items,
  index,
  onIndex,
  onClose,
  extra,
}: {
  items: Item[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  extra?: (it: Item) => ReactNode;
}) => {
  useBackClose(true, onClose);
  const it = items[index];
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [minted, setMinted] = useState<string>('');
  const [note, setNote] = useState('');
  const prev = useCallback(() => index > 0 && onIndex(index - 1), [index, onIndex]);
  const next = useCallback(() => index < items.length - 1 && onIndex(index + 1), [index, items.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next]);

  useEffect(() => {
    setSize(null);
    setNote('');
    setMinted('');
    if (!it?.height) return;
    let live = true;
    void fetchBlockTime(it.height).then((t) => {
      if (live && t)
        setMinted(new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
    });
    return () => {
      live = false;
    };
  }, [it?.key, it?.height]);

  const urls = useMemo(() => it?.urls ?? [], [it]);
  if (!it) return null;
  const pending = it.pending || it.height === 0;
  const txid = txidOf(it.origin);
  const publicUrl = contentUrls(it.origin)[0] ?? '';

  const share = async () => {
    const r = await shareLink({ title: it.name, text: it.name, url: publicUrl });
    setNote(r === 'copied' ? 'Link copied.' : r === 'failed' ? 'Couldn’t share that link.' : '');
  };
  const download = async () => {
    try {
      const r = await fetch(urls[0]);
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${it.name.replace(/[^\w\- ]+/g, '').trim() || 'picture'}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch {
      setNote('Download failed. Try again in a moment.');
    }
  };

  const navBtn =
    'absolute top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center border-0 cursor-pointer';
  return (
    <div className="fixed inset-0 z-[160] flex flex-col md:flex-row" style={{ background: 'rgba(0,0,0,0.94)' }}>
      <div className="relative flex-1 min-h-0 flex items-center justify-center p-4 md:p-10" onClick={onClose}>
        <div className="max-w-full max-h-full flex items-center" onClick={(e) => e.stopPropagation()}>
          <PicImg key={it.key} urls={urls} alt={it.name} fit="full" onSize={(w, h) => setSize({ w, h })} />
        </div>
        {index > 0 && (
          <button
            type="button"
            aria-label="Previous"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            className={`${navBtn} left-3`}
            style={{ background: 'rgb(var(--bw-accent-hi-rgb) / 0.15)' }}
          >
            <ChevronLeft size={24} color={GOLD} />
          </button>
        )}
        {index < items.length - 1 && (
          <button
            type="button"
            aria-label="Next"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            className={`${navBtn} right-3`}
            style={{ background: 'rgb(var(--bw-accent-hi-rgb) / 0.15)' }}
          >
            <ChevronRight size={24} color={GOLD} />
          </button>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute top-3 left-3 w-10 h-10 rounded-full flex items-center justify-center border-0 cursor-pointer md:hidden"
          style={{ background: 'rgba(0,0,0,0.6)' }}
        >
          <X size={20} color="#fff" />
        </button>
      </div>
      <aside
        className="w-full md:w-[360px] shrink-0 overflow-y-auto p-5 flex flex-col gap-3 max-h-[45vh] md:max-h-none"
        style={{ background: PANEL, borderLeft: `1px solid ${BORDER}` }}
      >
        <div className="flex items-start gap-2">
          <h2 className="font-bold text-lg leading-snug flex-1 break-words" style={{ color: GOLD }}>
            {it.name}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="bg-transparent border-0 cursor-pointer p-1 hidden md:block"
          >
            <X size={20} color="#aaa" />
          </button>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {pending && <Badge tone="gold">Pending</Badge>}
          {it.shared === true && (
            <Badge>
              <Globe size={11} /> Shared in bPics
            </Badge>
          )}
          {it.shared === false && (
            <Badge>
              <Lock size={11} /> Private
            </Badge>
          )}
        </div>
        {it.description && (
          <p className="text-sm whitespace-pre-wrap" style={{ color: '#ccc' }}>
            {it.description}
          </p>
        )}
        <div>
          <Row label="Minted">
            {pending ? 'Pending' : minted || (it.height ? `Block ${it.height.toLocaleString()}` : '—')}
          </Row>
          {it.who && (
            <Row label="Owner">
              <span className="inline-flex items-center gap-1.5">
                {it.avatar && <img src={it.avatar} alt="" width={16} height={16} className="rounded-full" />}
                {it.who}
              </span>
            </Row>
          )}
          {size && (
            <Row label="Size">
              {size.w} × {size.h}
            </Row>
          )}
          {it.collection && <Row label="Collection">{it.collection}</Row>}
          {it.number && <Row label="Item">#{it.number}</Row>}
          {MARKET_ENABLED && !!it.price && <Row label="Listed at">{moneyWithSats(it.price, cachedExchangeRate())}</Row>}
          {it.contentType && <Row label="Type">{it.contentType.replace('image/', '').toUpperCase()}</Row>}
          <Row label="Transaction">
            <a
              href={wocTxUrl(txid)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 no-underline"
              style={{ color: GOLD }}
            >
              {txid.slice(0, 8)}…{txid.slice(-6)} <ExternalLink size={12} />
            </a>
          </Row>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {!it.pending && publicUrl && (
            <ActionButton icon={<Share2 size={15} />} label="Share" onClick={() => void share()} />
          )}
          <ActionButton icon={<Download size={15} />} label="Download" onClick={() => void download()} />
          {extra?.(it)}
        </div>
        {it.collection && (
          <a
            href={ordfsUrl(it.origin)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm no-underline"
            style={{ color: GOLD }}
          >
            View on chain <ExternalLink size={12} />
          </a>
        )}
        {note && (
          <p className="text-sm" style={{ color: GOLD }}>
            {note}
          </p>
        )}
        <p className="text-xs mt-auto" style={{ color: MUTED }}>
          {index + 1} of {items.length} · ← → to browse, Esc to close
        </p>
      </aside>
    </div>
  );
};

// ── Mint a picture ──

type Picked = { uri: string; base64: string; contentType: string; bytes: number };

const MintPicSheet = ({ onClose, onMinted }: { onClose: () => void; onMinted: (m: JustMinted) => void }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  useBackClose(true, onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pic, setPic] = useState<Picked | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [share, setShare] = useState(SHARE_DEFAULT);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [rate, setRate] = useState(cachedExchangeRate());
  useEffect(() => {
    if (!rate) void fetchExchangeRate('main').then(setRate, () => undefined);
  }, [rate]);

  const cost = pic ? estimateCost(pic.bytes, chromeStorageService.getCustomFeeRate(), rate) : null;

  const pick = async (file: File | undefined) => {
    setError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Choose a picture (JPEG, PNG, WebP, GIF or HEIC).');
    setPreparing(true);
    try {
      const uri = await prepareCardImage(file, PIC_MAX_EDGE, PIC_QUALITY);
      const { base64, contentType } = splitDataUri(uri);
      setPic({ uri, base64, contentType, bytes: base64Bytes(base64) });
      if (!title) setTitle(file.name.replace(/\.\w+$/, '').slice(0, 100));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That picture couldn’t be opened.');
    } finally {
      setPreparing(false);
    }
  };

  const review = () => {
    if (!pic) return setError('Choose a picture.');
    const err = validateForm({ title, description, collection: { kind: 'none' } });
    setError(err ?? '');
    if (!err) setConfirming(true);
  };

  const mint = async () => {
    if (!pic || !cost) return;
    if (blockedText({ title, description, collection: { kind: 'none' } })) {
      setConfirming(false);
      return setError(BLOCKED_MESSAGE);
    }
    setBusy(true);
    setConfirming(false);
    try {
      const res = await mintMedia(withRepeatGuard(apiContext), {
        base64Content: pic.base64,
        contentType: pic.contentType,
        title,
        description,
        collection: { kind: 'none' },
        feeSats: cost.feeSats,
        map: buildPicMap({ title, description, share }),
      });
      setDone(res.txid);
      onMinted({ txid: res.txid, uri: pic.uri, title: title.trim(), share });
      notifyMinted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mint failed');
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full rounded-xl px-3 py-2.5 text-sm outline-none border bg-transparent';
  return (
    <>
      <div
        className="fixed inset-0 z-[150] flex items-end sm:items-center justify-center sm:p-6"
        style={{ background: 'rgba(0,0,0,0.7)' }}
        onClick={() => !busy && onClose()}
      >
        <div
          className="w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl p-5 overflow-y-auto flex flex-col gap-4 text-sm border"
          onClick={(e) => e.stopPropagation()}
          style={{
            background: PANEL,
            borderColor: BORDER,
            color: '#fff',
            maxHeight: 'calc(100dvh - env(safe-area-inset-top) - 24px)',
            paddingBottom: 'calc(20px + env(safe-area-inset-bottom))',
          }}
        >
          <div className="flex items-center justify-between">
            <span className="font-bold text-xl" style={{ color: GOLD }}>
              {done ? 'Minted' : busy ? 'Minting…' : 'Mint a picture'}
            </span>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="bg-transparent border-0 cursor-pointer"
              aria-label="Close"
            >
              <X size={20} color="#aaa" />
            </button>
          </div>
          {done ? (
            <div className="flex flex-col items-center text-center gap-3 py-2">
              {pic && (
                <img src={pic.uri} alt="" className="max-h-64 rounded-xl border" style={{ borderColor: BORDER }} />
              )}
              <Badge tone="gold">Pending</Badge>
              <p>
                “{title.trim()}” is sent to the network. It shows Pending until it's confirmed in a block.{' '}
                {share ? 'It will appear in the public library shortly.' : 'It stays private in your wallet.'}
              </p>
              <a
                href={wocTxUrl(done)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs no-underline"
                style={{ color: GOLD }}
              >
                View transaction <ExternalLink size={12} />
              </a>
              <button
                type="button"
                onClick={onClose}
                className="h-11 w-full rounded-xl font-bold border-0 cursor-pointer"
                style={{ background: GOLD_BTN, color: '#1a1400' }}
              >
                See it in My pics
              </button>
            </div>
          ) : busy ? (
            <div className="flex flex-col items-center gap-4 py-8">
              {pic && <img src={pic.uri} alt="" className="max-h-48 rounded-xl opacity-70" />}
              <div className="w-full max-w-xs h-1.5 rounded-full overflow-hidden" style={{ background: '#2a2207' }}>
                <div className="h-full w-full" style={shimmer} />
              </div>
              <p style={{ color: MUTED }}>Inscribing your picture. Keep this window open.</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Photos only: no capture attribute, so the picker opens the library, not the camera. */}
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void pick(e.target.files?.[0])}
              />
              <div
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void pick(e.dataTransfer.files?.[0]);
                }}
                className="relative rounded-2xl border-2 border-dashed overflow-hidden flex flex-col items-center justify-center text-center cursor-pointer min-h-[220px]"
                style={{
                  borderColor: dragging ? '#FFE27A' : GOLD,
                  background: dragging ? 'rgb(var(--bw-accent-hi-rgb) / 0.08)' : GOLD_BG,
                }}
              >
                {preparing ? (
                  <div className="absolute inset-0" style={shimmer} />
                ) : pic ? (
                  <>
                    <img src={pic.uri} alt="" className="w-full h-full max-h-80 object-contain bg-black" />
                    <span className="absolute bottom-2 right-2">
                      <Badge>Change picture</Badge>
                    </span>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-2 p-6">
                    <UploadCloud size={36} color={GOLD} />
                    <span className="font-semibold" style={{ color: GOLD }}>
                      Drop a picture here
                    </span>
                    <span className="text-xs" style={{ color: MUTED }}>
                      or click to choose from your photos
                    </span>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-3">
                <input
                  className={input}
                  style={{ borderColor: BORDER, color: '#fff' }}
                  placeholder="Title (required)"
                  value={title}
                  maxLength={100}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <textarea
                  className={input}
                  style={{ borderColor: BORDER, color: '#fff' }}
                  placeholder="Description"
                  rows={3}
                  value={description}
                  maxLength={1000}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <label
                  className="flex items-start gap-3 cursor-pointer rounded-xl border p-3"
                  style={{ borderColor: share ? GOLD : BORDER }}
                >
                  <input
                    type="checkbox"
                    checked={share}
                    onChange={(e) => setShare(e.target.checked)}
                    className="mt-0.5"
                    style={{ accentColor: GOLD }}
                  />
                  <span>
                    <span className="inline-flex items-center gap-1.5 font-semibold">
                      {share ? <Globe size={14} color={GOLD} /> : <Lock size={14} color={MUTED} />} Share in bPics
                    </span>
                    <span className="block text-xs mt-0.5" style={{ color: MUTED }}>
                      {share
                        ? 'Anyone can see it in the public library.'
                        : 'Private: it stays in your wallet, not listed in the library.'}
                    </span>
                  </span>
                </label>
                <div className="rounded-xl p-3 border" style={{ borderColor: BORDER, background: '#0f0f0f' }}>
                  {cost && pic ? (
                    <>
                      <div className="flex justify-between text-xs" style={{ color: MUTED }}>
                        <span>JPEG · {formatBytes(pic.bytes)}</span>
                        <span>Network fee {money(cost.networkSats, rate)}</span>
                      </div>
                      {cost.feeSats > 0 && (
                        <div className="flex justify-between text-xs mt-1" style={{ color: MUTED }}>
                          <span>bWallet mint fee (1%)</span>
                          <span>{money(cost.feeSats, rate)}</span>
                        </div>
                      )}
                      <div className="flex justify-between font-bold mt-2">
                        <span>Total</span>
                        <span style={{ color: GOLD }}>≈ {moneyWithSats(cost.totalSats, rate)}</span>
                      </div>
                    </>
                  ) : (
                    <span className="text-xs" style={{ color: MUTED }}>
                      Choose a picture to see the price.
                    </span>
                  )}
                </div>
                <p className="text-xs" style={{ color: MUTED }}>
                  Don't mint anything you don't own or that's illegal. Inscriptions are permanent.
                </p>
                {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
                <button
                  type="button"
                  onClick={review}
                  disabled={preparing}
                  className="h-11 rounded-xl font-bold border-0 cursor-pointer"
                  style={{ background: GOLD_BTN, color: '#1a1400', opacity: pic ? 1 : 0.6 }}
                >
                  Review mint
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <SendConfirmation
        show={confirming}
        theme={theme}
        lineItems={[
          { address: `Mint "${title.trim()}"`, amount: pic ? formatBytes(pic.bytes) : '' },
          ...(cost ? [{ address: 'Network fee (est.)', amount: money(cost.networkSats, rate) }] : []),
          ...(cost && cost.feeSats > 0
            ? [{ address: 'bWallet mint fee (1%)', amount: money(cost.feeSats, rate) }]
            : []),
        ]}
        total={cost ? moneyWithSats(cost.totalSats, rate) : undefined}
        isProcessing={busy}
        onConfirm={() => void mint()}
        onCancel={() => !busy && setConfirming(false)}
      />
    </>
  );
};
