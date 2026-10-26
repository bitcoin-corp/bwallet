import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useBackClose } from '../backStack';
import { createPortal } from 'react-dom';
import { listOrdinals } from '@1sat/actions';
import { mintMedia } from './mintMedia';
import { MAX_PRIVATE_BYTES, mintPrivateMedia, privateMediaBytes } from '../private/privateMint';
import { mediaKindFor, mintIsPrivate } from '../private/records';
import { PrivacyChoice } from '../private/PrivacyChoice';
import {
  AppWindow,
  BookOpen,
  Bot,
  Box,
  Clapperboard,
  Coins,
  ExternalLink,
  FileSignature,
  FileText,
  Gift,
  Megaphone,
  Globe,
  Image as ImageIcon,
  LineChart,
  Link as LinkIcon,
  Music,
  Sparkles,
  Ticket,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { setAgentDraft } from '../agent/handoff';
import { openAgentCreate } from '../agents/agentCreate';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { routeFor } from '../tabs/tabs';
import { GREETING_CARDS_ENABLED, isBWalletX } from '../storeBuild';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { getOutputName } from '../../utils/format';
import { TicketMint } from '../tickets/TicketMint';
import { TokenMint } from '../tokens/TokenMint';
import { DomainMint } from '../domains/DomainMint';
import { mintChoicesFor } from '../storeBuild';

/** Greeting cards (bWalletX only): lazy chunks, absent from a store build. */
const CardMaker = GREETING_CARDS_ENABLED ? lazy(() => import('../cards/CardMaker')) : null;
const CardSend = GREETING_CARDS_ENABLED ? lazy(() => import('../cards/CardSend')) : null;

/** Store build: media (NFT) only (storeBuild.ts). */
const CHOICES = new Set(mintChoicesFor());
import {
  ACCEPT,
  BLOCKED_MESSAGE,
  blockedText,
  buildMap,
  checkSize,
  DOWNSCALE_SUGGEST_BYTES,
  estimateCost,
  fileToBase64,
  formatBytes,
  isMintableType,
  notifyMinted,
  validateForm,
  wocTxUrl,
  type Collection,
  shouldSelectTitleOnFocus,
  titleFromFileName,
} from './mint';
import { money, moneyWithSats } from '../money/money';
import { captureVideoFrame } from '../wallet/cardVideoFrame';
import {
  detectModel,
  fileFitsKind,
  fmtBsv,
  kindMap,
  maxBytesFor,
  MINT_KINDS,
  mintTxBytes,
  planEditions,
  slowLandWarning,
  validateKindFields,
  type MintKind,
} from './mintKinds';
import { MINT_SOURCES, mintSource, type MintSourceId } from './mintSources';
import { FaFacebook, FaInstagram, FaLinkedin, FaSoundcloud, FaTiktok, FaXTwitter, FaYoutube } from 'react-icons/fa6';

const SOURCE_ICONS: Record<MintSourceId, typeof FaYoutube> = {
  youtube: FaYoutube,
  x: FaXTwitter,
  instagram: FaInstagram,
  tiktok: FaTiktok,
  facebook: FaFacebook,
  linkedin: FaLinkedin,
  soundcloud: FaSoundcloud,
};

/** Cover / poster picture: a small JPEG so the companion inscription stays cheap. */
const POSTER_EDGE = 512;
const dataUriToFile = async (uri: string, name: string) => {
  const b = await (await fetch(uri)).blob();
  return new File([b], name, { type: b.type || 'image/jpeg' });
};
const coverFrom = async (file: File): Promise<File> => {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, POSTER_EDGE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.82));
  if (!blob) throw new Error('Could not read this picture');
  return new File([blob], 'cover.jpg', { type: 'image/jpeg' });
};

/**
 * "Mint" — gold button beside Receive / Send on the Wallet tab (build-time insert into
 * BsvWallet.tsx, vite.config.mobile.ts). Opens a sheet: Mint a chatroom (a ticket:
 * src/mobile/tickets/TicketMint.tsx), Mint a token (src/mobile/tokens/TokenMint.tsx; every token
 * has a room) or Mint media (NFT).
 *
 * Inscribes through upstream's @1sat/actions with the wallet's own apiContext:
 *   inscribe (no collection) · mintCollection + mintCollectionItem (new collection) ·
 *   mintCollectionItem (existing collection). Nothing is broadcast until the user confirms
 *   the wallet's standard SendConfirmation sheet.
 *
 * List-for-sale is NOT offered: upstream has OrdLock listing creation disabled
 * (ORDLOCK_LISTING_DISABLED in src/utils/cancelOrdLockListings.ts). Re-add once it returns.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const BORDER = '#3a2f0c';

type Step = 'choose' | 'ticket' | 'token' | 'domain' | 'media' | 'done' | 'card' | 'ad';
/** `type` is the content type to inscribe (3D: from magic bytes, not the browser's guess). */
type Picked = { file: File; url: string; type: string };

const downscale = async (file: File, maxEdge = 2048, quality = 0.85): Promise<File> => {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not shrink this image');
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
};

export const MintButton = ({ exchangeRate = 0 }: { exchangeRate?: number }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Gold pill, the same as Receive / Send (mobile.css .bw-pill-gold; owner round 6). */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="order-3 flex flex-1 items-center justify-center gap-2 py-3 font-semibold text-sm outline-none cursor-pointer bw-pill bw-pill-gold"
      >
        <Sparkles size={16} strokeWidth={2.5} />
        Mint
      </button>
      {open && createPortal(<MintSheet exchangeRate={exchangeRate} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
};

/**
 * The Mint sheet. `start` = a MINT_TILES id (bMint hub, bmint/BmintPage.tsx): opens straight at that type's step,
 * the same as tapping its tile here. Agent tiles are not startable (the hub routes those itself).
 */
export const MintSheet = ({
  exchangeRate,
  onClose,
  start,
  file,
  domain,
}: {
  exchangeRate: number;
  onClose: () => void;
  start?: string;
  /** start='domain' only: the domain the deep link carried (/m/mint/domain?d=…). */
  domain?: string;
  /** A file already chosen (bMint's drop zone): the media step opens with it picked, through the same checks. */
  file?: File | null;
}) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const startTile = start ? MINT_TILES.find((t) => t.id === start && t.when() && (t.media || t.step)) : undefined;
  const [step, setStep] = useState<Step>(startTile ? (startTile.media ? 'media' : startTile.step!) : 'choose');
  const navigate = useNavigate();
  const selectTab = useContext(BottomMenuContext)?.handleSelect;
  // An agent account: close this sheet, then Settings › Add account with the Agent switch on.
  const openElsewhere = () => {
    onClose();
    openAgentCreate(selectTab, navigate, routeFor('settings'));
  };
  // The bMint hub links /m/bmint/mint/agent-account: hand straight over.
  useEffect(() => {
    if (start && MINT_TILES.some((t) => t.id === start && t.when() && t.opens)) openElsewhere();
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // What the media step accepts and calls itself, set by the tile that opened it.
  const [media, setMedia] = useState<{ accept: string; label: string }>(
    startTile?.media ?? {
      accept: ACCEPT,
      label: 'photo, video or audio',
    },
  );
  const [picked, setPicked] = useState<Picked | null>(null);
  const [kindSel, setKindSel] = useState<MintKind | null>(startTile?.kind ?? null);
  const [source, setSource] = useState<MintSourceId | null>(null);
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [track, setTrack] = useState('');
  const [editions, setEditions] = useState('1');
  const [price, setPrice] = useState('');
  const [poster, setPoster] = useState<{ file: File; url: string } | null>(null);
  const [posterNote, setPosterNote] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState('');
  const [title, setTitle] = useState('');
  const titleTouched = useRef(false);
  const [description, setDescription] = useState('');
  const [collKind, setCollKind] = useState<Collection['kind']>('none');
  const [newColl, setNewColl] = useState('');
  const [existingId, setExistingId] = useState('');
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [formError, setFormError] = useState('');
  // Private by default (owner, 25 Oct 2026): encrypted to this wallet; "Make public now" per mint.
  const [makePublic, setMakePublic] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [txid, setTxid] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Set when a greeting card was handed to this mint ("Who's it for?" as a $name, or ''): Done offers Send it.
  const [cardTo, setCardTo] = useState<string | null>(null);

  useEffect(() => () => void (picked && URL.revokeObjectURL(picked.url)), [picked]);

  // The wallet's own collections (parents it holds), for "Add to existing collection".
  useEffect(() => {
    if (step !== 'media') return;
    listOrdinals
      .execute(apiContext, { tags: ['subType:collection'], limit: 100, offset: 0 })
      .then(({ outputs }) =>
        setCollections(
          outputs.map((o) => ({ id: o.outpoint.replace('.', '_'), name: getOutputName(o, 'Collection') })),
        ),
      )
      .catch(() => setCollections([]));
  }, [step, apiContext]);

  const collection: Collection = useMemo(() => {
    if (collKind === 'new') return { kind: 'new', name: newColl };
    if (collKind === 'existing') {
      const c = collections.find((x) => x.id === existingId);
      return c ? { kind: 'existing', id: c.id, name: c.name } : { kind: 'none' };
    }
    return { kind: 'none' };
  }, [collKind, newColl, existingId, collections]);

  const satsPerKb = chromeStorageService.getCustomFeeRate();
  const privKind = picked ? mediaKindFor(picked.type, kindSel) : mediaKindFor('', kindSel);
  const isPrivate = mintIsPrivate(makePublic, picked ? picked.type : null, kindSel);
  const maxBytes = isPrivate ? Math.min(MAX_PRIVATE_BYTES, maxBytesFor(kindSel)) : maxBytesFor(kindSel);
  const editionCount = !isPrivate && collection.kind === 'none' ? Math.max(1, Math.floor(Number(editions)) || 1) : 1;
  const plan = planEditions(editionCount, picked?.file.size ?? 0);
  const usePoster = !isPrivate && !!poster && collection.kind === 'none';
  const txBytes = picked
    ? isPrivate
      ? privateMediaBytes(picked.file.size)
      : mintTxBytes(picked.file.size, plan, usePoster ? poster!.file.size : 0)
    : 0;
  const cost = picked
    ? estimateCost(txBytes, satsPerKb, exchangeRate, { newCollection: !isPrivate && collection.kind === 'new' })
    : null;
  const kindFields = {
    artist,
    album,
    track,
    editions: editionCount,
    priceSats: price.trim() ? Number(price) : undefined,
  };
  const setPosterFile = (f: File | null) => {
    setPoster((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return f ? { file: f, url: URL.createObjectURL(f) } : null;
    });
  };

  const openTile = (t: MintTile) => {
    if (t.media) {
      setMedia(t.media);
      setKindSel(t.kind ?? null);
      setStep('media');
    } else if (t.step) setStep(t.step);
    else if (t.opens) openElsewhere();
    else if (t.agent) {
      setAgentDraft(t.agent);
      onClose();
      navigate('/m/ask-b');
    }
  };
  // A platform's "Pick the file" opens the same media tile as tapping it (its type); platforms whose type has no
  // visible tile are not shown.
  const tileForKind = (kind: MintKind) => MINT_TILES.find((t) => t.when() && t.media && t.kind === kind);
  const sources = MINT_SOURCES.filter((s) => tileForKind(s.kind));

  const pick = async (file: File | undefined) => {
    setFileError('');
    setPosterNote('');
    if (!file) return;
    if (kindSel && !fileFitsKind(kindSel, file.type, file.name))
      return setFileError(`Pick ${MINT_KINDS.find((k) => k.id === kindSel)!.hint}.`);
    let type = file.type;
    if (kindSel === '3d') {
      const head = new Uint8Array(
        await file.slice(0, file.name.toLowerCase().endsWith('.gltf') ? file.size : 64).arrayBuffer(),
      );
      const isJson = head[0] === 0x7b || /\.gltf$/i.test(file.name);
      const check = detectModel(isJson ? new Uint8Array(await file.arrayBuffer()) : head);
      if (!check.ok) return setFileError(check.message);
      type = check.contentType;
    } else if (!isMintableType(type))
      return setFileError('Pick a photo, video, audio file, PDF, ebook, text or HTML page.');
    const size = checkSize(file.size, maxBytes);
    if (!size.ok && !type.startsWith('image/')) return setFileError(size.message);
    if (!size.ok) setFileError(size.message);
    const url = URL.createObjectURL(file);
    setPicked({ file, url, type });
    setPosterFile(null);
    if (!title) {
      setTitle(titleFromFileName(file.name));
      titleTouched.current = false;
    }
    // 3D: render a still on this device for the cover (gold card if it can't be drawn; USDZ has no renderer here).
    if (kindSel === '3d' && type !== 'model/vnd.usdz+zip') {
      setPosterNote('Drawing a cover picture…');
      import('../three3d/snapshot')
        .then(({ snapshot }) => snapshot(url, {}, `mint:${file.name}:${file.size}:${file.lastModified}`))
        .then((u) => dataUriToFile(u, 'cover.png'))
        .then((f) => {
          setPosterFile(f);
          setPosterNote('');
        })
        .catch(() => setPosterNote('No cover picture: it shows as a gold card.'));
    }
  };

  // bMint's drop zone hands the file over: pick it once, exactly as if it was chosen here.
  useEffect(() => {
    if (file && step === 'media') void pick(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  // Greeting card → the Picture mint, with the card picked and its title filled in.
  const mintCard = async (f: File, cardTitle: string, to: string) => {
    setKindSel('picture');
    setMedia({ accept: 'image/*', label: 'an image' });
    setStep('media');
    setCardTo(to);
    await pick(f);
    setTitle(cardTitle);
    titleTouched.current = true;
  };

  const takeFrame = async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      setPosterFile(await dataUriToFile(captureVideoFrame(el, POSTER_EDGE), 'cover.jpg'));
      setPosterNote('');
    } catch (e) {
      setPosterNote(e instanceof Error ? e.message : 'Could not use this frame');
    }
  };

  const pickCover = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPosterFile(await coverFrom(f));
      setPosterNote('');
    } catch (e) {
      setPosterNote(e instanceof Error ? e.message : 'Could not read this picture');
    }
  };

  const shrink = async () => {
    if (!picked) return;
    try {
      const small = await downscale(picked.file);
      const size = checkSize(small.size);
      setFileError(size.ok ? '' : size.message);
      setPicked({ file: small, url: URL.createObjectURL(small), type: small.type });
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'Could not shrink this image');
    }
  };

  const review = () => {
    if (!picked) return setFormError('Pick a file to mint.');
    const size = checkSize(picked.file.size, maxBytes);
    if (!size.ok) return setFormError(size.message);
    if (!isPrivate && collKind === 'existing' && collection.kind !== 'existing')
      return setFormError('Choose a collection.');
    const err = isPrivate
      ? validateForm({ title, description, collection: { kind: 'none' } })
      : (validateForm({ title, description, collection }) ??
        (kindSel ? validateKindFields(kindSel, kindFields) : null));
    setFormError(err ?? '');
    if (!err) setConfirming(true);
  };

  const mint = async () => {
    if (!picked || !cost) return;
    // Re-check at the moment of broadcast (texts may have been edited).
    if (blockedText({ title, description, collection })) {
      setConfirming(false);
      return setFormError(BLOCKED_MESSAGE);
    }
    setBusy(true);
    try {
      if (isPrivate && privKind) {
        // Encrypted on this device with the wallet's own keys; only ciphertext goes on chain.
        const res = await mintPrivateMedia(apiContext, {
          file: Array.from(new Uint8Array(await picked.file.arrayBuffer())),
          mime: picked.type,
          name: picked.file.name,
          kind: privKind,
          feeSats: cost.feeSats,
        });
        setTxid(res.txid);
        setConfirming(false);
        setStep('done');
        notifyMinted();
        return;
      }
      const none = collection.kind === 'none';
      const posterVout = usePoster ? plan.outputs : undefined;
      const res = await mintMedia(apiContext, {
        base64Content: fileToBase64(await picked.file.arrayBuffer()),
        contentType: picked.type,
        title,
        description,
        collection,
        feeSats: cost.feeSats,
        ...(none &&
          kindSel && {
            map: { ...buildMap({ title, description, collection }), ...kindMap(kindSel, kindFields, plan, posterVout) },
            copies: plan.outputs,
          }),
        ...(usePoster && {
          poster: {
            base64Content: fileToBase64(await poster!.file.arrayBuffer()),
            contentType: poster!.file.type,
            map: {
              app: 'bWallet',
              type: 'ord',
              name: `${title.trim()} (cover)`.slice(0, 100),
              subType: 'poster',
              posterOf: '_0',
            },
          },
        }),
      });
      setTxid(res.txid);
      setConfirming(false);
      setStep('done');
      notifyMinted();
    } catch (e) {
      setConfirming(false);
      setFormError(e instanceof Error ? e.message : 'Mint failed');
    } finally {
      setBusy(false);
    }
  };

  const kind = kindSel === '3d' ? 'model' : picked?.type.split('/')[0];
  const input = 'w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent';
  const inputStyle = { borderColor: BORDER, color: '#fff' };

  return (
    // z above the bottom tab bar (BottomMenu z-[100]) so the sheet's lower options aren't hidden.
    <div className="fixed inset-0 z-[150] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div
        className="w-full max-w-md rounded-t-2xl p-4 overflow-y-auto"
        style={{
          background: PANEL,
          color: '#fff',
          maxHeight: 'calc(100dvh - env(safe-area-inset-top) - 24px)',
          paddingBottom: 'calc(16px + env(safe-area-inset-bottom))',
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="font-bold text-lg" style={{ color: GOLD }}>
            {step === 'ticket'
              ? 'Mint tickets'
              : step === 'token'
                ? 'Mint a token'
                : step === 'domain'
                  ? 'Tokenise a domain'
                  : step === 'card'
                    ? 'Greeting card'
                    : step === 'ad' && GREETING_CARDS_ENABLED
                      ? 'Order a bAd'
                      : step === 'choose'
                        ? 'Mint'
                        : step === 'done'
                          ? 'Minted'
                          : 'Mint'}
          </span>
          <button type="button" onClick={onClose} className="bg-transparent border-0 cursor-pointer" aria-label="Close">
            <X size={20} color="#aaa" />
          </button>
        </div>

        {step === 'choose' && (
          <div className="flex flex-col gap-2">
            <p className="text-xs m-0 mb-1" style={{ color: '#999' }}>
              What do you want to make? Everything you mint is yours on chain: sell it, send it, or let people collect
              it.
            </p>
            {sources.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-bold" style={{ color: '#ccc' }}>
                  Mint what you already post
                </span>
                <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Mint what you already post">
                  {sources.map((s) => {
                    const Icon = SOURCE_ICONS[s.id];
                    const on = source === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={on}
                        aria-label={`How to mint from ${s.label}`}
                        onClick={() => setSource(on ? null : s.id)}
                        className="flex shrink-0 flex-col items-center gap-1 rounded-xl border px-3 py-2 cursor-pointer bg-transparent"
                        style={{ borderColor: on ? GOLD : BORDER, color: on ? GOLD : '#ccc' }}
                      >
                        <Icon size={20} aria-hidden="true" />
                        <span className="text-[11px]">{s.label}</span>
                      </button>
                    );
                  })}
                </div>
                {source &&
                  (() => {
                    const s = mintSource(source)!;
                    return (
                      <div
                        className="flex flex-col gap-2 rounded-xl border p-3"
                        style={{ borderColor: BORDER }}
                        aria-live="polite"
                      >
                        {s.steps.map((line) => (
                          <p key={line} className="text-xs m-0" style={{ color: '#ccc' }}>
                            {line}
                          </p>
                        ))}
                        <p className="text-xs m-0" style={{ color: '#999' }}>
                          Only mint what you made or own. Menus change now and then.
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            const t = tileForKind(s.kind);
                            if (t) openTile(t);
                          }}
                          className="self-start rounded-lg px-3 py-2 text-xs font-bold border-0 cursor-pointer"
                          style={{ background: GOLD, color: '#1a1400' }}
                        >
                          Pick the file
                        </button>
                      </div>
                    );
                  })()}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {MINT_TILES.filter((t) => t.when()).map((t) => (
                <Tile key={t.id} icon={t.icon} title={t.title} sub={t.sub} onClick={() => openTile(t)} />
              ))}
            </div>
          </div>
        )}

        {step === 'card' && CardMaker && (
          <Suspense fallback={null}>
            <CardMaker onBack={() => setStep('choose')} onMint={(f, t, to) => void mintCard(f, t, to)} />
          </Suspense>
        )}
        {step === 'ad' && CardMaker && (
          <Suspense fallback={null}>
            <CardMaker
              initialKind="ad"
              onBack={() => setStep('choose')}
              onMint={(f, t, to) => void mintCard(f, t, to)}
            />
          </Suspense>
        )}

        {step === 'ticket' && CHOICES.has('ticket') && (
          <TicketMint exchangeRate={exchangeRate} onBack={() => setStep('choose')} onClose={onClose} />
        )}

        {step === 'token' && CHOICES.has('token') && (
          <TokenMint exchangeRate={exchangeRate} onBack={() => setStep('choose')} onClose={onClose} />
        )}

        {step === 'domain' && CHOICES.has('token') && (
          <DomainMint
            exchangeRate={exchangeRate}
            onBack={() => setStep('choose')}
            onClose={onClose}
            initialDomain={domain}
          />
        )}

        {step === 'media' && (
          <div className="flex flex-col gap-3 text-sm">
            {kindSel && (
              <div
                className="grid grid-cols-4 gap-1 rounded-xl p-1 border"
                style={{ borderColor: BORDER }}
                role="tablist"
              >
                {MINT_KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    role="tab"
                    aria-selected={kindSel === k.id}
                    onClick={() => {
                      if (k.id === kindSel) return;
                      setKindSel(k.id);
                      setMedia({ accept: k.accept, label: k.hint });
                      setPicked(null);
                      setPosterFile(null);
                      setFileError('');
                    }}
                    className="rounded-lg py-2 text-xs font-bold border-0 cursor-pointer"
                    style={
                      kindSel === k.id
                        ? { background: GOLD, color: '#1a1400' }
                        : { background: 'transparent', color: '#ccc' }
                    }
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            )}
            <PrivacyChoice isPublic={makePublic} onChange={setMakePublic} available={!picked || privKind !== null} />
            <input
              ref={inputRef}
              type="file"
              accept={media.accept}
              className="hidden"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-xl border border-dashed py-4 cursor-pointer bg-transparent"
              style={{ borderColor: GOLD, color: GOLD }}
            >
              {picked ? 'Choose a different file' : `Choose ${media.label}`}
            </button>
            <p className="text-xs" style={{ color: '#999' }}>
              {isPrivate
                ? 'Only you can see it: it is encrypted on this device before it goes on chain. You can reveal it later.'
                : "Public: anyone can see it on chain, for good. Don't mint anything you don't own or that's illegal."}
            </p>
            {picked && (
              <div className="rounded-xl overflow-hidden border" style={{ borderColor: BORDER }}>
                {kind === 'image' && (
                  <img src={picked.url} alt="" className="w-full max-h-64 object-contain bg-black" />
                )}
                {kind === 'video' && (
                  <video ref={videoRef} src={picked.url} controls playsInline className="w-full max-h-64 bg-black" />
                )}
                {kind === 'model' && (
                  <div className="flex items-center gap-2 px-3 py-4 text-sm" style={{ color: '#ddd' }}>
                    {poster ? (
                      <img src={poster.url} alt="" className="w-16 h-16 object-contain rounded-lg bg-black" />
                    ) : (
                      <Box size={20} color={GOLD} />
                    )}{' '}
                    {picked.file.name}
                  </div>
                )}
                {kind === 'audio' && <audio src={picked.url} controls className="w-full" />}
                {(kind === 'application' || kind === 'text') && (
                  <div className="flex items-center gap-2 px-3 py-4 text-sm" style={{ color: '#ddd' }}>
                    <FileText size={20} color={GOLD} /> {picked.file.name}
                  </div>
                )}
                <div className="px-3 py-2 text-xs" style={{ color: '#bbb' }}>
                  {picked.type} · {formatBytes(picked.file.size)}
                  {kind === 'image' && picked.file.size > DOWNSCALE_SUGGEST_BYTES && (
                    <button
                      type="button"
                      onClick={shrink}
                      className="ml-2 bg-transparent border-0 cursor-pointer underline"
                      style={{ color: GOLD }}
                    >
                      Shrink photo (cheaper)
                    </button>
                  )}
                </div>
              </div>
            )}
            {fileError && <p style={{ color: '#ff6b6b' }}>{fileError}</p>}
            {picked && slowLandWarning(txBytes) && (
              <p className="text-xs m-0" style={{ color: '#FFB020' }}>
                {slowLandWarning(txBytes)}
              </p>
            )}

            {picked && !isPrivate && (kindSel === 'music' || kindSel === 'video') && (
              <div className="flex items-center gap-2">
                {poster ? (
                  <img src={poster.url} alt="Cover" className="w-14 h-14 object-cover rounded-lg" />
                ) : (
                  <div
                    className="w-14 h-14 rounded-lg flex items-center justify-center"
                    style={{ background: 'radial-gradient(circle at 30% 20%, #4a3806 0%, #1a1405 60%, #0b0c0f 100%)' }}
                  >
                    {kindSel === 'music' ? <Music size={20} color={GOLD} /> : <Clapperboard size={20} color={GOLD} />}
                  </div>
                )}
                {kindSel === 'music' ? (
                  <>
                    <input
                      ref={coverRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => void pickCover(e.target.files?.[0])}
                    />
                    <button
                      type="button"
                      onClick={() => coverRef.current?.click()}
                      className="bg-transparent border rounded-xl px-3 py-2 cursor-pointer text-xs"
                      style={{ borderColor: BORDER, color: GOLD }}
                    >
                      {poster ? 'Change cover art' : 'Add cover art (or keep gold)'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void takeFrame()}
                    className="bg-transparent border rounded-xl px-3 py-2 cursor-pointer text-xs"
                    style={{ borderColor: BORDER, color: GOLD }}
                  >
                    Use the current frame as the cover
                  </button>
                )}
                {poster && (
                  <button
                    type="button"
                    onClick={() => setPosterFile(null)}
                    className="bg-transparent border-0 cursor-pointer text-xs underline"
                    style={{ color: '#999' }}
                  >
                    Remove
                  </button>
                )}
              </div>
            )}
            {posterNote && (
              <p className="text-xs m-0" style={{ color: '#999' }}>
                {posterNote}
              </p>
            )}

            <input
              className={input}
              style={inputStyle}
              placeholder="Title (required)"
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={(e) => {
                // The file name is only a suggestion: select it on first focus so typing replaces it.
                if (shouldSelectTitleOnFocus(titleTouched.current, title)) e.currentTarget.select();
                titleTouched.current = true;
              }}
            />
            {kindSel === 'music' && (
              <>
                <input
                  className={input}
                  style={inputStyle}
                  placeholder="Artist"
                  value={artist}
                  maxLength={100}
                  onChange={(e) => setArtist(e.target.value)}
                />
                <div className="flex gap-2">
                  <input
                    className={input}
                    style={inputStyle}
                    placeholder="Album"
                    value={album}
                    maxLength={100}
                    onChange={(e) => setAlbum(e.target.value)}
                  />
                  <input
                    className={input}
                    style={{ ...inputStyle, maxWidth: 96 }}
                    placeholder="Track #"
                    inputMode="numeric"
                    value={track}
                    maxLength={3}
                    onChange={(e) => setTrack(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
              </>
            )}
            {kindSel && !isPrivate && collKind === 'none' && (
              <div className="flex gap-2 items-center">
                <label className="flex items-center gap-2 text-xs flex-1" style={{ color: '#bbb' }}>
                  Editions
                  <input
                    className={input}
                    style={{ ...inputStyle, maxWidth: 88 }}
                    inputMode="numeric"
                    aria-label="Editions"
                    value={editions}
                    maxLength={4}
                    onChange={(e) => setEditions(e.target.value.replace(/\D/g, ''))}
                  />
                </label>
                {kindSel === 'music' && (
                  <input
                    className={input}
                    style={{ ...inputStyle, maxWidth: 170 }}
                    placeholder="Original price (sats)"
                    inputMode="numeric"
                    value={price}
                    onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))}
                  />
                )}
              </div>
            )}
            {kindSel && !isPrivate && editionCount > 1 && (
              <p className="text-xs m-0" style={{ color: '#999' }}>
                {plan.mode === 'inline'
                  ? `1 of ${editionCount}: ${editionCount} copies in one transaction, each its own NFT.`
                  : `1 of ${editionCount}: one numbered master inscription (copies of a big file would multiply the fee).`}
              </p>
            )}
            <textarea
              className={input}
              style={inputStyle}
              placeholder="Description"
              rows={3}
              value={description}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
            />
            {!isPrivate && (
              <select
                className={input}
                style={{ ...inputStyle, background: PANEL }}
                value={collKind}
                onChange={(e) => setCollKind(e.target.value as Collection['kind'])}
              >
                <option value="none">No collection</option>
                <option value="new">New collection…</option>
                {collections.length > 0 && <option value="existing">Add to my collection…</option>}
              </select>
            )}
            {!isPrivate && collKind === 'new' && (
              <input
                className={input}
                style={inputStyle}
                placeholder="Collection name"
                value={newColl}
                maxLength={100}
                onChange={(e) => setNewColl(e.target.value)}
              />
            )}
            {!isPrivate && collKind === 'existing' && (
              <select
                className={input}
                style={{ ...inputStyle, background: PANEL }}
                value={existingId}
                onChange={(e) => setExistingId(e.target.value)}
              >
                <option value="">Choose a collection</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {cost && (
              <p className="text-xs" style={{ color: '#bbb' }}>
                Estimated network fee: {money(cost.networkSats, exchangeRate)} ({fmtBsv(cost.networkSats)})
                {cost.txCount > 1 ? ' (2 transactions: collection + item)' : ''}
                {cost.feeSats > 0 && <> · bWallet mint fee (1%): {money(cost.feeSats, exchangeRate)}</>} · Total ≈{' '}
                {moneyWithSats(cost.totalSats, exchangeRate)}
              </p>
            )}
            {formError && <p style={{ color: '#ff6b6b' }}>{formError}</p>}
            <button
              type="button"
              onClick={review}
              className="h-11 rounded-xl font-bold border-0 cursor-pointer"
              style={{ background: `linear-gradient(135deg, #FFE27A, #E0A800)`, color: '#1a1400' }}
            >
              {isPrivate ? 'Review private mint' : 'Review public mint'}
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col gap-3 text-sm">
            {isPrivate ? (
              <p>
                "{title.trim()}" is minted privately: only you can see it. It is in bMint › Your vault › Private, where
                you can reveal it later.
              </p>
            ) : (
              <p>
                "{title.trim()}" was inscribed publicly. It will appear in Media{kindSel === 'music' ? ' › Music' : ''}{' '}
                shortly
                {txBytes > 10 * 1024 * 1024 ? ' (Pending until it lands, which can take a few minutes)' : ''}.
              </p>
            )}
            <a
              href={wocTxUrl(txid)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 break-all"
              style={{ color: GOLD }}
            >
              {txid} <ExternalLink size={12} />
            </a>
            {cardTo !== null && CardSend && (
              <Suspense fallback={null}>
                <CardSend txid={txid} title={title.trim()} to={cardTo} />
              </Suspense>
            )}
            <button
              type="button"
              onClick={onClose}
              className="h-11 rounded-xl font-bold border cursor-pointer bg-transparent"
              style={{ borderColor: BORDER, color: GOLD }}
            >
              Done
            </button>
          </div>
        )}
      </div>

      <SendConfirmation
        show={confirming}
        theme={theme}
        lineItems={[
          {
            address: isPrivate
              ? `Mint "${title.trim()}" privately (only you can see it)`
              : `Inscribe "${title.trim()}" publicly`,
            amount: picked ? formatBytes(txBytes) : '',
          },
          ...(cost
            ? [
                {
                  address: 'Network fee (est.)',
                  amount: `${money(cost.networkSats, exchangeRate)} · ${fmtBsv(cost.networkSats)}`,
                },
              ]
            : []),
          ...(cost && cost.feeSats > 0
            ? [{ address: 'bWallet mint fee (1%)', amount: `${money(cost.feeSats, exchangeRate)}` }]
            : []),
        ]}
        total={cost ? moneyWithSats(cost.totalSats, exchangeRate) : undefined}
        isProcessing={busy}
        onConfirm={() => void mint()}
        onCancel={() => !busy && setConfirming(false)}
      />
    </div>
  );
};

type MintTile = {
  id: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  when: () => boolean;
  media?: { accept: string; label: string };
  /** Picture / Music / Video / 3D: the media step shows that type's fields (mintKinds.ts). */
  kind?: MintKind;
  step?: Step;
  agent?: string;
  /** Opens a flow outside this sheet: 'agent-account' = Account menu › Add agent account (agents/agentCreate.ts). */
  opens?: 'agent-account';
};

/**
 * Mint › what to make (owner, 6 Oct 2026): "tokens and NFTs" doesn't sell it; show the things people actually make.
 * Media-like ones open the file mint with the right picker; contracts, strategies and apps open b with the request typed.
 */
const MINT_TILES: MintTile[] = [
  // In the store bundle not even as data (GREETING_CARDS_ENABLED inlines to false).
  ...(GREETING_CARDS_ENABLED
    ? [
        {
          id: 'card',
          icon: <Gift size={18} />,
          title: 'Greeting card or AI picture',
          sub: 'Describe it, we make it, you mint it',
          when: () => GREETING_CARDS_ENABLED,
          step: 'card' as Step,
        },
        {
          id: 'ad',
          icon: <Megaphone size={18} />,
          title: 'Order a bAd',
          sub: 'Describe your business, b makes the ad',
          when: () => GREETING_CARDS_ENABLED,
          step: 'ad' as Step,
        },
      ]
    : []),
  {
    id: 'art',
    icon: <ImageIcon size={18} />,
    title: 'Art & photos',
    sub: 'One of a kind, or a numbered collection',
    when: () => true,
    media: { accept: 'image/*', label: 'an image' },
    kind: 'picture',
  },
  {
    id: 'music',
    icon: <Music size={18} />,
    title: 'Music',
    sub: 'Tracks fans own and play in their wallet',
    when: () => true,
    media: { accept: 'audio/*', label: 'an audio file' },
    kind: 'music',
  },
  {
    id: 'video',
    icon: <Clapperboard size={18} />,
    title: 'Videos & films',
    sub: 'Clips, shorts or a whole film',
    when: () => true,
    media: { accept: 'video/*', label: 'a video' },
    kind: 'video',
  },
  {
    id: '3d',
    icon: <Box size={18} />,
    title: '3D models',
    sub: 'GLB, glTF or USDZ; spin it in the wallet',
    when: () => true,
    media: { accept: MINT_KINDS[3].accept, label: MINT_KINDS[3].hint },
    kind: '3d',
  },
  {
    id: 'books',
    icon: <BookOpen size={18} />,
    title: 'Books & PDFs',
    sub: 'Ebooks, zines, guides, reports',
    when: () => true,
    media: {
      accept: 'application/pdf,application/epub+zip,text/plain,text/markdown',
      label: 'a PDF, ebook or text file',
    },
  },
  {
    id: 'website',
    icon: <Globe size={18} />,
    title: 'A website',
    sub: 'A one-page site, on chain for good',
    when: () => true,
    media: { accept: 'text/html', label: 'an HTML page' },
  },
  {
    id: 'tickets',
    icon: <Ticket size={18} />,
    title: 'Tickets & passes',
    sub: 'Entry to your chatroom, event or site',
    when: () => CHOICES.has('ticket'),
    step: 'ticket',
  },
  {
    id: 'coin',
    icon: <Coins size={18} />,
    title: 'A token or memecoin',
    sub: 'Your own token, fixed supply',
    when: () => CHOICES.has('token'),
    step: 'token',
  },
  {
    id: 'domain',
    icon: <LinkIcon size={18} />,
    title: 'A domain',
    sub: 'Prove you own it, then tokenise it',
    when: () => CHOICES.has('token'),
    step: 'domain',
  },
  {
    id: 'contract',
    icon: <FileSignature size={18} />,
    title: 'Contracts',
    sub: 'Agreements both sides sign; b drafts it',
    when: () => isBWalletX(),
    agent:
      'Help me create a contract to mint. Ask me who it is between, what each side agrees to, the price and the dates.',
  },
  {
    id: 'strategy',
    icon: <LineChart size={18} />,
    title: 'Trading strategies',
    sub: 'Package a strategy others can buy; b helps',
    when: () => isBWalletX(),
    agent:
      'Help me create a strategy to mint and sell. Ask me what it should do, which tokens, the budget, when it stops and the price.',
  },
  {
    id: 'agent-account',
    icon: <Bot size={18} />,
    title: 'An agent account',
    sub: 'A wallet account your agent trades from, at machine speed',
    when: () => isBWalletX(),
    opens: 'agent-account',
  },
  {
    id: 'app',
    icon: <AppWindow size={18} />,
    title: 'An app',
    sub: 'List your bApp with its own token',
    when: () => isBWalletX(),
    agent:
      'Help me list my app as a bApp with its own token. Ask me for the app name, its website and what the token should do.',
  },
];

/** The Mint sheet's types as the current edition shows them (store gating applied), for the bMint hub. */
// eslint-disable-next-line react-refresh/only-export-components -- the hub reads the same list the sheet shows
export const mintTilesShown = () =>
  MINT_TILES.filter((t) => t.when()).map(({ id, icon, title, sub, agent }) => ({ id, icon, title, sub, agent }));

const Tile = ({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex flex-col items-start gap-1 p-3 rounded-xl border text-left cursor-pointer bg-transparent"
    style={{ borderColor: BORDER, color: '#fff' }}
  >
    <span style={{ color: GOLD }}>{icon}</span>
    <span className="font-bold text-sm leading-tight">{title}</span>
    <span className="text-[11px] leading-snug" style={{ color: '#999' }}>
      {sub}
    </span>
  </button>
);
