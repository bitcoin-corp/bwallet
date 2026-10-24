/**
 * Airdropped NFTs, seen safely: the thumbnail (tap = viewer), the viewer itself and the sender's name.
 * Only <img>, <video> and <audio> elements, plus plain text as React text: no iframes, no inscription markup,
 * no clickable links (nftView.ts).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileQuestion, FileText, Image as ImageIcon, Music, Video, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { cachedMeta, resolveMeta } from '../media/resolveMeta';
import { VideoPoster } from '../media/VideoPoster';
import { loadVideoBlobUrl, useVideoPoster } from '../media/videoCover';
import { accountNamesFor } from '../names/accountNames';
import { lookupPaymail } from '../names/paymail';
import { OpnsNameCard } from '../names/OpnsNameCard';
import { isOpnsType } from '../names/opnsName';
import type { AirdropItem } from './inbox';
import { clipText, contentOutpoint, kindLabel, nftUrls, viewKind, type ViewKind } from './nftView';
import { deviceSender, senderLabel, type DeviceAccount } from './sender';

const MUTED = '#98A2B3';

// ─── Sender name ─────────────────────────────────────────────────────────────

const paymailByKey = new Map<string, Promise<string | undefined>>();
const lookupOnce = (key: string) => {
  let p = paymailByKey.get(key);
  if (!p) {
    p = lookupPaymail(fetch, key).catch(() => undefined);
    paymailByKey.set(key, p);
  }
  return p;
};

/** The sender as "$name" when known (an account on this device, else the paymail of their key), else a short address. */
// eslint-disable-next-line react-refresh/only-export-components
export const useSenderName = (item: AirdropItem, enabled = true) => {
  const { chromeStorageService } = useServiceContext();
  const [remote, setRemote] = useState<string | null>(null);
  let local: string | null = null;
  if (enabled) {
    const accounts: DeviceAccount[] = (chromeStorageService.getAllAccounts?.() ?? []).map((a) => ({
      identityAddress: a.addresses.identityAddress,
      addresses: [a.addresses.identityAddress, a.addresses.ordAddress, a.addresses.bsvAddress].filter(Boolean),
      pubKeys: [a.pubKeys?.identityPubKey, a.pubKeys?.ordPubKey, a.pubKeys?.bsvPubKey].filter((k): k is string => !!k),
    }));
    const id = deviceSender(item, accounts);
    if (id) local = accountNamesFor(id).payable || null;
  }
  useEffect(() => {
    if (!enabled || local || !item.senderKey) return;
    let live = true;
    void lookupOnce(item.senderKey).then((p) => live && setRemote(p ?? null));
    return () => {
      live = false;
    };
  }, [enabled, local, item.senderKey]);
  const name = local || remote;
  const handle = name ? name.split('@')[0].replace(/^\$/, '') : null;
  return { handle, label: senderLabel(name, item) };
};

// ─── Content type ────────────────────────────────────────────────────────────

const typeCache = new Map<string, Promise<string | undefined>>();
const contentType = (item: AirdropItem): Promise<string | undefined> => {
  const op = contentOutpoint(item);
  const hit = cachedMeta(op)?.type ?? cachedMeta(item.asset.id)?.type;
  if (hit) return Promise.resolve(hit);
  let p = typeCache.get(op);
  if (!p) {
    p = (async () => {
      await resolveMeta([op, item.asset.id]);
      const t = cachedMeta(op)?.type ?? cachedMeta(item.asset.id)?.type;
      if (t) return t;
      const url = nftUrls(item).content;
      if (!url) return undefined;
      try {
        const r = await fetch(url, { method: 'HEAD' });
        return r.headers.get('content-type') ?? undefined;
      } catch {
        return undefined;
      }
    })();
    typeCache.set(op, p);
  }
  return p;
};

const useViewKind = (item: AirdropItem) => {
  const [t, setT] = useState<{ kind: ViewKind; type?: string } | null>(() => {
    const c = cachedMeta(contentOutpoint(item))?.type ?? cachedMeta(item.asset.id)?.type;
    return c ? { kind: viewKind(c), type: c } : null;
  });
  useEffect(() => {
    if (t) return;
    let live = true;
    void contentType(item).then((type) => live && setT({ kind: viewKind(type), type }));
    return () => {
      live = false;
    };
  }, [item, t]);
  return t;
};

const KindIcon = ({ kind, size = 16 }: { kind: ViewKind | undefined; size?: number }) => {
  if (kind === 'video') return <Video size={size} />;
  if (kind === 'audio') return <Music size={size} />;
  if (kind === 'image') return <ImageIcon size={size} />;
  if (kind === 'text') return <FileText size={size} />;
  return <FileQuestion size={size} />;
};

/** The NFT's inscribed name, once the indexer lookup has run. */
const nftTitle = (item: AirdropItem) =>
  cachedMeta(contentOutpoint(item))?.name ?? cachedMeta(item.asset.id)?.name ?? undefined;

/**
 * Video source for the viewer: the file downloaded into a blob: URL (the content hosts don't serve byte ranges, which
 * iOS needs to stream), falling back to the remote URL if the download fails or is too large.
 */
const useVideoSrc = (item: AirdropItem, type: string | undefined, enabled: boolean) => {
  const remote = nftUrls(item).content;
  const op = contentOutpoint(item);
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !type) return;
    const ac = new AbortController();
    let made: string | null = null;
    void loadVideoBlobUrl(op, type, ac.signal).then((u) => {
      if (ac.signal.aborted) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      made = u;
      setSrc(u ?? remote);
    });
    return () => {
      ac.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [op, type, enabled, remote]);
  return src;
};

// ─── Thumbnail ───────────────────────────────────────────────────────────────

/** The NFT's thumbnail; tapping it opens the viewer. A failed thumbnail shows its type icon and "Open", never a blank. */
export const NftThumb = ({ item, onOpen, size = 48 }: { item: AirdropItem; onOpen: () => void; size?: number }) => {
  const [bad, setBad] = useState(false);
  const { thumb } = nftUrls(item);
  const v = useViewKind(item);
  const box = { width: size, height: size };
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      aria-label={`Open ${v ? kindLabel(v.kind).toLowerCase() : 'NFT'}`}
      className="rounded-lg bg-[#2b2f36] shrink-0 overflow-hidden flex flex-col items-center justify-center text-[10px] leading-tight"
      style={{ ...box, color: MUTED }}
    >
      {v && isOpnsType(v.type) ? (
        <OpnsNameCard url={nftUrls(item).content} compact />
      ) : v?.kind === 'video' ? (
        <VideoPoster outpoint={contentOutpoint(item)} title={nftTitle(item)} compact={size < 72} />
      ) : thumb && !bad ? (
        <img src={thumb} alt="" loading="lazy" onError={() => setBad(true)} className="w-full h-full object-cover" />
      ) : (
        <>
          <KindIcon kind={v?.kind} />
          Open
        </>
      )}
    </button>
  );
};

// ─── Viewer ──────────────────────────────────────────────────────────────────

const TextBody = ({ url }: { url: string }) => {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => live && setText(clipText(t)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [url]);
  if (failed) return <p className="text-sm text-[#F97066] m-0">Couldn&apos;t load the text. Check your connection.</p>;
  return (
    <pre className="w-full max-h-full overflow-auto whitespace-pre-wrap break-words text-[13px] text-white bg-[var(--bw-surface)] rounded-xl p-3 m-0">
      {text ?? 'Loading…'}
    </pre>
  );
};

/** Full-screen viewer for one airdropped NFT: from whom, and what it is. */
export const NftViewer = ({ item, onClose }: { item: AirdropItem; onClose: () => void }) => {
  useBackClose(true, onClose);
  const who = useSenderName(item);
  const v = useViewKind(item);
  const { content } = nftUrls(item);
  const [failed, setFailed] = useState(false);
  const isName = !!v && isOpnsType(v.type);
  const kind = isName ? undefined : v?.kind;
  const poster = useVideoPoster(kind === 'video' ? contentOutpoint(item) : null);
  const videoSrc = useVideoSrc(item, v?.type, kind === 'video');
  return createPortal(
    <div
      className="fixed inset-0 z-[260] flex flex-col bg-black"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="min-w-0 flex flex-col">
          <span className="text-sm font-semibold text-white overflow-hidden text-ellipsis whitespace-nowrap">
            {isName ? 'Name' : v ? kindLabel(v.kind) : 'NFT'} from {who.label}
          </span>
          <span className="text-[10px]" style={{ color: '#667085' }}>
            {new Date(item.time).toLocaleString()}
          </span>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="p-2">
          <X size={20} color="#fff" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center px-3">
        {!v && (
          <p className="text-sm m-0" style={{ color: MUTED }}>
            Loading…
          </p>
        )}
        {isName && <OpnsNameCard url={content} from={who.label} />}
        {content && !failed && kind === 'video' && videoSrc === undefined && (
          <div className="w-48 h-48 rounded-xl overflow-hidden">
            <VideoPoster outpoint={contentOutpoint(item)} title={nftTitle(item)} />
          </div>
        )}
        {content && !failed && kind === 'video' && videoSrc && (
          <video
            src={videoSrc}
            poster={poster ?? undefined}
            controls
            autoPlay
            playsInline
            onError={() => setFailed(true)}
            className="max-w-full max-h-full"
          />
        )}
        {content && !failed && kind === 'audio' && (
          <audio src={content} controls autoPlay onError={() => setFailed(true)} className="w-full" />
        )}
        {content && !failed && kind === 'image' && (
          <img src={content} alt="" onError={() => setFailed(true)} className="max-w-full max-h-full object-contain" />
        )}
        {content && !failed && kind === 'text' && <TextBody url={content} />}
        {v && !isName && (kind === 'other' || failed || !content) && (
          <div className="flex flex-col items-center gap-2 text-center px-6" style={{ color: MUTED }}>
            <KindIcon kind={kind} size={32} />
            <p className="text-sm m-0">
              {failed || !content
                ? "Couldn't load this NFT. Check your connection and try again."
                : `This NFT is ${v.type || 'an unknown type'}. bWallet only shows images, video, audio and text, so nothing in it can run.`}
            </p>
          </div>
        )}
      </div>
      <div className="px-4 py-3 text-[10px] break-all" style={{ color: '#667085' }}>
        {v?.type ?? 'type unknown'} · {contentOutpoint(item)}
      </div>
    </div>,
    document.body,
  );
};

// ─── Wallet › NFTs: kept airdrops the wallet's list doesn't hold yet ───────────

/**
 * Kept airdropped NFTs that Wallet › NFTs (the wallet's ordinals basket) does not list yet, e.g. the transaction is
 * unconfirmed or the address sync hasn't taken it in. Shown with the reason, so a kept NFT never just vanishes.
 */
export const KeptAirdrops = ({ pending }: { pending: AirdropItem[] }) => {
  const [open, setOpen] = useState<AirdropItem | null>(null);
  if (!pending.length) return null;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-[var(--bw-surface)] px-3 py-3">
      <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: MUTED }}>
        Kept airdrops
      </span>
      <p className="text-[11px] leading-snug m-0" style={{ color: MUTED }}>
        Kept from bMail and safe at your address. The wallet hasn&apos;t indexed {pending.length === 1 ? 'it' : 'them'}{' '}
        yet (the transaction may still be unconfirmed); tap Refresh NFTs in a few minutes. Until then{' '}
        {pending.length === 1 ? 'it' : 'they'} can be viewed here but not sent.
      </p>
      <div className="flex flex-wrap gap-2">
        {pending.map((i) => (
          <NftThumb key={i.key} item={i} size={72} onOpen={() => setOpen(i)} />
        ))}
      </div>
      {open && <NftViewer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
};
