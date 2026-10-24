import { publishBalance } from './balanceStore';
import { RefreshGlyph, UpToDateAnnouncer } from '../../components/RefreshGlyph';
import * as qr from 'qrcode';
import { isLightPattern } from './cardPatternsLight';
import { cardArtQrSvg, cardPaymail, svgDataUri } from './cardBackQr';
import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Check, Copy, Loader2, PenLine, RefreshCw, RotateCcw, ScanLine, SlidersHorizontal } from 'lucide-react';
import { myPayUri } from '../scan/payUri';
import { isBWalletX } from '../storeBuild';
import {
  artStyle,
  autoBrightness,
  cardFrontArtUri,
  clampLook,
  defaultPlacement,
  loadCardArtLook,
  CARD_IMG_EVENT,
  loadCardImage,
  measureArtLuma,
  saveCardArtLook,
  saveCardImage,
  type CardArtLook,
} from './cardFrontArt';
import { CardDesigner } from './CardDesigner';
import { ThemeSheet } from '../theme/ThemeSheet';
import { onThemeSheetRequest, takeThemeOffer } from '../theme/themeNav';
import type { AccentId } from '../theme/accents';
import { switchToAccountAccent } from '../theme/accent';
import { useAccentId } from '../theme/useAccent';
import { accentById } from '../theme/accents';
import { cardFollowsTheme, editionArtOn, setCardCustomised, useCardCustomised } from './cardLook';
import { CARD_DESIGN_EVENT, loadCardDesign, saveCardDesign, type CardDesign } from './cardDesign';
import { loadCardArt, type CardArtModule } from './cardArtLoader';
import { patternUri } from './cardPatterns';

// Edition colour (owner, 10 Oct 2026): bWallet's card is yellow with black text, like its app icon; bWalletX keeps
// the black card that turns gold with the balance. One card, two palettes (.bw-wcard.is-yellow in mobile.css).
const YELLOW_CARD = !isBWalletX();

const ScanSheet = lazy(() => import('../scan/ScanSheet'));
const PictureSheet = lazy(() => import('./PictureSheet'));
import { usePictureReturn } from './pictureReturn';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { formatUSD } from '../../utils/format';
import { useDisplayCurrency } from '../../hooks/useDisplayCurrency';
import { useKyc } from '../kyc/useKyc';
import { kycValid } from '../kyc/kyc';
import { AccountAvatar } from '../names/AccountAvatar';
import { useAvatar } from '../names/useAvatar';
import { HandleFlow } from '../names/HandleFlow';
import { useAccountNames } from '../names/accountNames';
import { identityRowText } from '../names/identityText';
import type { BalanceView } from './balanceLoad';
import { useBackedUp } from '../backup/useBackedUp';
import { ghostColorOf, onAgentsChange } from '../agents/agentAccounts';
import { PixelGhost } from '../agents/PixelGhost';
import { requestBackupThen } from '../backup/backupState';
import { useCardSignature } from '../signature/useCardSignature';
import { cardGoldLevel } from './cardGold';
import { keyFingerprint } from './identityLine';

/** The card back's ID KEY: longer than the shared fingerprint (owner, 15 Oct 2026). */
const stripeKey = (key: string) =>
  keyFingerprint(key) ? `${key.trim().toLowerCase().slice(0, 10)}…${key.trim().toLowerCase().slice(-8)}` : key;
import { useBchatFollow } from './useBchatFollow';
import { useChatIdentity } from './useChatIdentity';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { asMenuItem } from '../tabs/tabs';
import { requestIdentityMap } from '../settings/signIns';
import { LiveTicker } from './live/LiveTicker';
import { noteBalance, useLive } from './live/liveBus';
import { displayedSats, refreshDelay } from './live/liveLogic';
import { useCountUp } from './live/useCountUp';
import { BALANCE_CARDS_ENABLED } from '../storeBuild';
import { AddressBookPull } from './AddressBook';
import { cardSats, memberSince, cardBsv } from './walletCardText';
import { useCardUnit } from './cardValue';
import { CardUnitSwitch } from './CardUnitSwitch';
/** Balance cards: a lazy chunk, absent from store builds (storeBuild.ts). */
const BalanceCarousel = BALANCE_CARDS_ENABLED
  ? lazy(() => import('./BalanceCarousel').then((m) => ({ default: m.BalanceCarousel })))
  : null;

export type WalletCardProps = {
  /** Total in US dollars (BSV at the current rate, plus MNEE when enabled). */
  usd: number;
  /** BSV balance in satoshis. */
  sats: number;
  /** From balanceView(): spinner while loading, unknown when no balance is known yet. */
  view: BalanceView;
  syncing: boolean;
  failed: boolean;
  /** Quiet line under a cached amount while fresh loads fail (staleBalanceHint): "Last updated 14:05 · may be out of date". */
  stale?: string | null;
  onRetry: () => void;
  receiveAddress: string;
  /** Manual refresh (icon on the card); also run quietly every minute and when the wallet comes back into view. */
  onRefresh?: (manual: boolean) => void;
  refreshing?: boolean;
  /** A manual refresh just found nothing new: the refresh icon shows a tick and the sats line says "Up to date". */
  upToDate?: boolean;
  /** Balance hidden (privacy): the card shows a neutral gold so its colour does not reveal the balance. */
  balanceHidden?: boolean;
  /** USD per BSV, so an optimistic spend moves the dollar figure too (live/). 0 or absent: dollars follow the fetch. */
  rate?: number;
};

const SIG_HINT_KEY = 'bwallet.cardSigHintSeen';
const sigHintSeen = () => {
  try {
    return localStorage.getItem(SIG_HINT_KEY) === '1';
  } catch {
    return true;
  }
};
const markSigHintSeen = () => {
  try {
    localStorage.setItem(SIG_HINT_KEY, '1');
  } catch {
    /* private mode: the hint just shows again next time */
  }
};

/**
 * Wallet home balance as a premium membership card (not a payment card: no card number, chip, date
 * or network logo). Front: b mark, dollars first with sats below, the $handle where a cardholder name
 * would go. Tap to flip: receive QR, and a signature strip with the identity key fingerprint.
 * Replaces WalletIdentity + the "Total balance" header. Styles in src/mobile/mobile.css (.bw-wcard*).
 */
const WalletCardInner = ({
  usd,
  sats,
  view,
  syncing,
  failed,
  stale,
  onRetry,
  receiveAddress,
  onRefresh,
  refreshing = false,
  upToDate = false,
  balanceHidden = false,
  rate = 0,
}: WalletCardProps) => {
  // Live balance (owner, 8 Oct 2026: "see my balance ticking down as I pay … or ticking up as I'm paid").
  // Spends the wallet just signed come off at once; the next fetch reconciles (live/liveBus.ts).
  const fx = useDisplayCurrency();
  const live = useLive();
  const sessionsOpen = Object.keys(live.sessions).length;
  const known = view === 'amount';
  useEffect(() => {
    if (known) noteBalance(sats);
  }, [sats, known]);
  const pendingSats = sats - displayedSats(sats, live.pending);
  const shownSats = known ? sats - pendingSats : sats;
  const count = useCountUp(shownSats, known);
  const animSats = known ? count.value : sats;
  const animUsd = rate > 0 ? usd + ((animSats - sats) * rate) / 100_000_000 : usd;

  // Quiet refresh: every 5 s while something is happening (a spend, a live session, just opened), else every
  // 20 s; never while hidden (balances otherwise only loaded once: owner, 4 Oct 2026). Battery/rate: the fast
  // lane lasts two minutes after the last activity, and each refresh is skipped while one is in flight.
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const activityRef = useRef(live.lastActivityAt);
  activityRef.current = live.lastActivityAt;
  const sessionsRef = useRef(sessionsOpen);
  sessionsRef.current = sessionsOpen;
  useEffect(() => {
    if (!onRefresh) return;
    let timer: number | null = null;
    const visible = () => document.visibilityState === 'visible';
    const plan = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      const d = refreshDelay({
        visible: visible(),
        lastActivityAt: activityRef.current,
        now: Date.now(),
        liveSessions: sessionsRef.current,
      });
      if (d !== null)
        timer = window.setTimeout(() => {
          refreshRef.current?.(false);
          plan();
        }, d);
    };
    // Focus and visibilitychange both fire on return: one silent refresh a minute at most (the timer covers the rest).
    let lastQuiet = 0;
    const quiet = () => {
      if (visible() && Date.now() - lastQuiet >= 60_000) {
        lastQuiet = Date.now();
        refreshRef.current?.(false);
      }
      plan();
    };
    plan();
    document.addEventListener('visibilitychange', quiet);
    window.addEventListener('focus', quiet);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', quiet);
      window.removeEventListener('focus', quiet);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!onRefresh]);
  // After a spend, fetch once shortly after so the card settles on the real number (fee included).
  useEffect(() => {
    if (!live.pending.length) return;
    const t = window.setTimeout(() => refreshRef.current?.(false), 1_500);
    return () => window.clearTimeout(t);
  }, [live.pending.length]);
  const { chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [flipped, setFlipped] = useState(false);
  // Shared with every balance card (cardValue.ts): flipping it here flips them all.
  const unit = useCardUnit();
  const [handleOpen, setHandleOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  // Tap the avatar: "Your picture" (X / Google photo, an NFT, or the bAvatar). Back from X / Google lands here.
  const [pictureOpen, setPictureOpen] = useState(false);
  usePictureReturn((message) => addSnackbar(message, 'success'));
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses.identityAddress;
  const names = useAccountNames(id, account?.name ?? '', account?.settings?.socialProfile?.displayName ?? '', false);
  const avatar = useAvatar(id);
  // Agent accounts wear a ghost in their colour (agents/PixelGhost); re-read when agent settings change.
  const [ghost, setGhost] = useState(() => ghostColorOf(id));
  useEffect(() => {
    setGhost(ghostColorOf(id));
    return onAgentsChange(() => setGhost(ghostColorOf(id)));
  }, [id]);
  const { kyc } = useKyc();
  const verified = kycValid(kyc, Date.now());
  const t = identityRowText(names.displayName, names.paymail, names.handle);
  // No account creation time is stored today; memberSince() returns '' and the line is omitted.
  const since = memberSince((account as { createdAt?: number } | undefined)?.createdAt);

  // The front's art: the account's bAvatar (bWalletX only; bWallet keeps its yellow card). Cached per key.
  const accentId = useAccentId();
  const bavatarArt = useMemo(
    () => cardFrontArtUri(account?.pubKeys?.identityPubKey, YELLOW_CARD),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the art is tinted to the current accent
    [account?.pubKeys?.identityPubKey, accentId],
  );
  // How the art sits: the account's own adjustment, else bright art dimmed and its core moved top-right.
  const artKey = account?.pubKeys?.identityPubKey ?? '';
  // App accent (Theme → App colours) follows the open account; the boot key already painted the last one.
  useEffect(() => {
    if (artKey) switchToAccountAccent(artKey);
  }, [artKey]);
  // The account's own picture, when it chose one in the card designer (owner, 12 Oct 2026); bWalletX only.
  const [cardImage, setCardImage] = useState<string | null>(() => (bavatarArt ? loadCardImage(artKey) : null));
  useEffect(() => {
    const read = () => setCardImage(bavatarArt ? loadCardImage(artKey) : null);
    read();
    window.addEventListener(CARD_IMG_EVENT, read);
    return () => window.removeEventListener(CARD_IMG_EVENT, read);
  }, [artKey, bavatarArt]);
  // Patterns / Art / Collections / Subscribe (cardDesign.ts): what the front shows when there is no own picture.
  const [design, setDesign] = useState<CardDesign | null>(() => (bavatarArt ? loadCardDesign(artKey) : null));
  useEffect(() => {
    const read = () => setDesign(bavatarArt ? loadCardDesign(artKey) : null);
    read();
    window.addEventListener(CARD_DESIGN_EVENT, read);
    return () => window.removeEventListener(CARD_DESIGN_EVENT, read);
  }, [artKey, bavatarArt]);
  const [artMod, setArtMod] = useState<CardArtModule | null>(null);
  useEffect(() => {
    if (design && design.kind !== 'pattern' && !artMod) void loadCardArt().then(setArtMod);
  }, [design, artMod]);
  const designArt = useMemo(() => {
    if (!design) return null;
    if (design.kind === 'pattern') {
      const colour = design.follow ? accentById(accentId).accent : accentById(design.colour).accent;
      return { src: patternUri(design.id, colour), attribution: '' };
    }
    const r = artMod?.resolveArt(design);
    return r ? { src: r.src, attribution: r.line } : null;
  }, [design, artMod, accentId]);
  // Theme-follow (owner, 15 Oct 2026, cardLook.ts): an uncustomised card wears the active pack (White → white,
  // Blue → blue …), drawing the pack's card pattern in its hue instead of the default bAvatar art. A card the user
  // customised (own picture, chosen design, saved look/colour) keeps its look whatever the theme.
  const pack = accentById(accentId);
  const flagged = useCardCustomised(`bsv:${artKey}`);
  const savedLookNow = loadCardArtLook(artKey);
  const customised = flagged || !!cardImage || !!design || !!savedLookNow;
  // Light packs (owner, 16 Oct 2026) never show dark card art: only an own picture or a chosen Art design (e.g. the
  // Great Wave, which washes out well) is kept; a dark pattern or a saved look alone gives way to the white card.
  const light = pack.scheme === 'light';
  const ownArt = !!cardImage || (!!design && design.kind !== 'pattern');
  const lightPick = design?.kind === 'pattern' && isLightPattern(design.id) ? design.id : null;
  // A bought edition (NPGX …) puts its own art on the card even over a saved look or chosen pattern (cardLook.ts).
  const edition = !!bavatarArt && editionArtOn(pack, ownArt);
  const themed =
    edition ||
    (!!bavatarArt && (light ? !ownArt && cardFollowsTheme(pack, false) : cardFollowsTheme(pack, customised)));
  const themeArt = themed
    ? patternUri(lightPick ?? pack.pattern, pack.accent, artKey, pack.paper ? pack.surface : undefined)
    : null;
  const frontArt = light
    ? (bavatarArt && ownArt && (cardImage || designArt?.src)) || themeArt || bavatarArt
    : edition
      ? themeArt
      : (bavatarArt && (cardImage || designArt?.src)) || themeArt || bavatarArt;
  const artAttribution = !cardImage && designArt?.attribution ? designArt.attribution : '';
  const setImage = (uri: string | null) => {
    if (!saveCardImage(artKey, uri)) return false;
    setCardImage(uri);
    saveCardDesign(artKey, null);
    setCardCustomised(`bsv:${artKey}`, !!uri);
    return true;
  };
  const pickDesign = (d: CardDesign | null) => {
    if (cardImage) {
      saveCardImage(artKey, null);
      setCardImage(null);
    }
    saveCardDesign(artKey, d);
    setCardCustomised(`bsv:${artKey}`, !!d);
  };
  const [luma, setLuma] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    setLuma(null);
    if (frontArt) void measureArtLuma(frontArt).then((l) => live && setLuma(l));
    return () => {
      live = false;
    };
  }, [frontArt]);
  const [savedLook, setSavedLook] = useState<CardArtLook | null>(() => loadCardArtLook(artKey));
  useEffect(() => setSavedLook(loadCardArtLook(artKey)), [artKey]);
  const defaultLook = useMemo<CardArtLook>(
    () => ({ brightness: autoBrightness(luma), ...defaultPlacement(artKey) }),
    [luma, artKey],
  );
  // Edition art is drawn as the artist made it: a saved hue/saturation (meant for the bAvatar) is not applied to it.
  const look = savedLook
    ? edition
      ? { brightness: savedLook.brightness, x: savedLook.x, y: savedLook.y }
      : savedLook
    : defaultLook;
  const [adjusting, setAdjusting] = useState(false);
  // An install link's pack (bwalletx://theme/<pack>): the sheet opens on App colours and offers it.
  const [themeOffer, setThemeOffer] = useState<AccentId | null>(null);
  // Settings › Appearance › Theme opens this same sheet (theme/themeNav.ts).
  useEffect(
    () =>
      onThemeSheetRequest(() => {
        setThemeOffer(takeThemeOffer());
        setAdjusting(true);
      }),
    [],
  );
  const setLook = (l: CardArtLook | null) => {
    const v = l && clampLook(l);
    setSavedLook(v);
    saveCardArtLook(artKey, v);
    setCardCustomised(`bsv:${artKey}`, !!v || !!cardImage || !!design);
  };

  // The back's QR: the account's bAvatar art QR (its paymail), else the plain receive QR below.
  const artQr = useMemo(
    () => (flipped ? svgDataUri(cardArtQrSvg(account?.pubKeys?.identityPubKey, names.paymail, 512)) : ''),
    [flipped, account?.pubKeys?.identityPubKey, names.paymail],
  );

  useEffect(() => {
    if (!flipped || !receiveAddress || artQr) return;
    // BIP21 so other wallets (and another bWallet's Scan) read it as a payment code.
    qr.toDataURL(
      myPayUri(receiveAddress),
      { margin: 1, width: 240, color: { dark: '#000000', light: '#ffffff' } },
      (err, url) => {
        if (!err) setQrUrl(url);
      },
    );
  }, [flipped, receiveAddress, artQr]);

  const copy = (text: string) => (e: MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => addSnackbar('Copied', 'success'))
      .catch(() => undefined);
  };
  const [turning, setTurning] = useState(false);
  // Swap faces at the midpoint of the 2D turn (CSS .is-turning).
  const backedUp = useBackedUp();
  const [hintSeen, setHintSeen] = useState(sigHintSeen);
  const turn = () => {
    if (turning) return;
    if (!hintSeen) {
      markSigHintSeen();
      setHintSeen(true);
    }
    setTurning(true);
    setTimeout(() => setFlipped((f) => !f), 220);
    setTimeout(() => setTurning(false), 440);
  };
  // The back is the receive QR: not backed up → the Backup step first (src/mobile/backup).
  const flip = () => (flipped ? turn() : requestBackupThen(chromeStorageService, turn));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  };
  const sig = useCardSignature(id);
  // `$handle · 02cbe7…6ed8` under the name: which chat identity this account is using (identityLine.ts).
  const chat = useChatIdentity(id);
  // bChatX follows this wallet account (owner, 10 Oct 2026): the card shows $handle + fingerprint only;
  // mismatches are fixed quietly here and choice/privacy live in Settings › bChatX (bchatFollow.ts).
  useBchatFollow(id, chat, names.paymail);
  const fingerprint = keyFingerprint(chat.identityKey);
  // The back always carries this account's identity key, signed in to bChatX or not (owner, 12 Oct 2026: it was
  // missing whenever there was no bChatX session yet).
  const backKey = chat.identityKey || account?.pubKeys?.identityPubKey || '';
  // Long-press the identity line: Settings › Identity map. Tap still copies the key.
  const selectTab = useContext(BottomMenuContext)?.handleSelect;
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const clearPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const openIdMap = () => {
    longPressed.current = true;
    selectTab?.(asMenuItem('settings'));
    requestIdentityMap();
  };
  const idLinePress = {
    onTouchStart: () => {
      clearPress();
      longPressed.current = false;
      pressTimer.current = window.setTimeout(openIdMap, 550);
    },
    onTouchEnd: clearPress,
    onTouchMove: clearPress,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearPress();
      openIdMap();
    },
  };
  useEffect(() => clearPress, []);
  // More golden as the BSV balance grows (cardGold.ts); drives --gold in mobile.css.
  const gold = cardGoldLevel(sats / 100_000_000, {
    hidden: balanceHidden,
    known: view !== 'unknown' && view !== 'spinner',
  });

  return (
    <div className="bw-wcard-wrap">
      <div
        className={`bw-wcard${YELLOW_CARD ? ' is-yellow' : ''}${turning ? ' is-turning' : ''}`}
        style={{ ['--gold' as string]: YELLOW_CARD ? '0' : gold.toFixed(3) }}
        role="button"
        tabIndex={0}
        aria-label={flipped ? 'Show card front' : 'Show receive QR and identity'}
        onClick={flip}
        onKeyDown={onKey}
      >
        {/* ── Front ── */}
        <div
          className={`bw-wcard-face bw-wcard-front${frontArt ? ' has-art' : ''}${themed ? ' is-themed' : ''}`}
          aria-hidden={flipped}
        >
          {frontArt && (
            <>
              <img
                className="bw-wcard-art"
                src={frontArt}
                alt=""
                decoding="async"
                draggable={false}
                style={artStyle(look)}
              />
              <span className="bw-wcard-art-shade" aria-hidden="true" />
            </>
          )}
          {ghost && (
            <span className="bw-wcard-ghost">
              <PixelGhost color={ghost} size={34} title="Agent account" />
            </span>
          )}
          <div className="bw-wcard-head">
            <div className="bw-wcard-top">
              <div className="bw-wcard-holder">
                {ghost ? (
                  <AccountAvatar src={avatar} size={31} id={id} />
                ) : (
                  <button
                    type="button"
                    className="bw-wcard-avatarbtn"
                    aria-label="Change your picture"
                    tabIndex={flipped ? -1 : 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPictureOpen(true);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <AccountAvatar src={avatar} size={31} id={id} />
                  </button>
                )}
                {t.tag ? (
                  <>
                    {/* Copy sits LEFT of the paymail (owner rule); the front shows the FULL bWalletX paymail
                        (owner, 13 Oct 2026) so it never reads as a universal BSV handle. */}
                    <button
                      type="button"
                      onClick={copy(t.copy)}
                      aria-label={`Copy ${t.copy}`}
                      className="bw-wcard-icon"
                    >
                      <Copy size={15} color="var(--bw-wcard-muted, #98A2B3)" />
                    </button>
                    <span className={`bw-wcard-handle${t.front.includes('@') ? ' is-paymail' : ''}`} title={t.front}>
                      {t.front}
                    </span>
                    {verified && (
                      <span
                        aria-label="Verified identity"
                        title="Verified identity"
                        style={{ color: 'var(--bw-wcard-ok, #2ecc71)' }}
                      >
                        <Check size={13} strokeWidth={3} />
                      </span>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    className="bw-wcard-getname"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHandleOpen(true);
                    }}
                  >
                    Get your $name
                  </button>
                )}
              </div>
              <div className="bw-wcard-tr">
                {/* Scan to pay (owner, 9 Oct 2026): 44px target, gold-ring icon like the top bar. */}
                <button
                  type="button"
                  aria-label="Scan to pay"
                  title="Scan to pay"
                  className="bw-wcard-scan"
                  onClick={(e) => {
                    e.stopPropagation();
                    setScanOpen(true);
                  }}
                >
                  <span>
                    <ScanLine size={16} />
                  </span>
                </button>
              </div>
            </div>
            {fingerprint && (
              <div className="bw-wcard-idline">
                {/* Fingerprint only: not selectable, not copyable (the full key is on the back). */}
                <span
                  className="bw-wcard-idtext bw-wcard-fingerprint"
                  {...idLinePress}
                  aria-label={`Identity key fingerprint ${fingerprint}. Long-press for the identity map`}
                >
                  {fingerprint}
                </span>
              </div>
            )}
          </div>
          <div className="bw-wcard-centre">
            {view === 'spinner' ? (
              <Loader2 size={28} className="animate-spin" color="var(--bw-wcard-muted, #8e8e89)" />
            ) : view === 'unknown' ? (
              <span
                className="bw-wcard-usd"
                title="Balance unavailable"
                style={{ color: 'var(--bw-wcard-muted, #8e8e89)' }}
              >
                —
              </span>
            ) : (
              <>
                <span
                  key={`flash-${count.flashKey}`}
                  className={`bw-wcard-usd${unit === 'bsv' ? ' is-bsv' : ''}${count.dir && count.flashKey ? ` bw-live-flash-${count.dir}` : ''}`}
                  title={syncing ? 'Syncing…' : 'Balance'}
                  style={(() => {
                    // Same size as the $ balance; long amounts shrink to stay on one line.
                    const len = (unit === 'usd' ? formatUSD(animUsd) : cardBsv(animSats)).length;
                    return len > 11
                      ? { fontSize: `clamp(18px, ${Math.min(10, 120 / len).toFixed(2)}vw, 42px)` }
                      : undefined;
                  })()}
                >
                  {unit === 'usd' ? formatUSD(animUsd) : cardBsv(animSats)}
                  {syncing && (
                    <Loader2 size={16} className="animate-spin bw-wcard-sync" color="var(--bw-wcard-muted, #8e8e89)" />
                  )}
                  {onRefresh && !syncing && (
                    <button
                      type="button"
                      aria-label={upToDate ? 'Balance is up to date' : 'Refresh balance'}
                      title={upToDate ? 'Up to date' : 'Refresh balance'}
                      disabled={refreshing}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRefresh(true);
                      }}
                      className={`bw-wcard-sync bg-transparent border-0 p-1 cursor-pointer${upToDate ? ' is-uptodate' : ''}`}
                      style={{ color: 'var(--bw-wcard-muted, #8e8e89)', lineHeight: 0 }}
                    >
                      <RefreshGlyph refreshing={refreshing} done={upToDate} />
                    </button>
                  )}
                </span>
                <span className={`bw-wcard-sats${upToDate ? ' is-uptodate' : ''}`}>
                  {upToDate ? 'Up to date' : unit === 'usd' ? cardSats(animSats) : formatUSD(animUsd)}
                </span>
                <UpToDateAnnouncer done={upToDate} label="Balance is up to date" />
                <LiveTicker hidden={balanceHidden} />
              </>
            )}
            {!hintSeen && !sig.svgPath && (
              <span className="bw-wcard-sighint">
                <PenLine size={11} aria-hidden="true" />
                Flip the card to add your signature
              </span>
            )}
            {stale && !failed && (
              <span className="bw-wcard-stale" role="status">
                {stale}
              </span>
            )}
            {failed && (
              <button
                type="button"
                className="bw-wcard-retry"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry();
                }}
              >
                <RefreshCw size={12} aria-hidden="true" />
                Still syncing. Tap to retry.
              </button>
            )}
          </div>
          <div className="bw-wcard-bottom">
            <div className="bw-wcard-bl">
              <div className="bw-wcard-addrline">
                <div className="bw-wcard-addrslot">
                  {receiveAddress && !backedUp && (
                    <div className="bw-wcard-addrrow">
                      <span className="bw-wcard-addr">Back up to show your address</span>
                    </div>
                  )}
                  {receiveAddress && backedUp && (
                    <div className="bw-wcard-addrrow">
                      {/* Copy sits LEFT of the address (owner, 11 Oct 2026), well away from the $/BSV switch. */}
                      <button
                        type="button"
                        onClick={copy(receiveAddress)}
                        aria-label="Copy BSV address"
                        className="bw-wcard-icon bw-wcard-copyicon"
                      >
                        <Copy size={14} color="var(--bw-wcard-muted, #98A2B3)" aria-hidden="true" />
                      </button>
                      <span className="bw-wcard-addr" aria-label="Your BSV address">
                        {receiveAddress}
                      </span>
                    </div>
                  )}
                </div>
                {/* $/BSV switch: same row as the address, right (owner, 9 Oct 2026). */}
                <CardUnitSwitch fx={fx} />
              </div>
              {since && (
                <div className="bw-wcard-since">
                  <span>MEMBER SINCE</span>
                  <b>{since}</b>
                </div>
              )}
            </div>
          </div>
          {/* A plain pen, right-centre (owner, 10 Oct 2026): flips to the back, where the signature lives. */}
          <button
            type="button"
            className="bw-wcard-penflip"
            aria-label="Show the back of the card"
            title="Show the back of the card"
            tabIndex={flipped ? -1 : 0}
            onClick={(e) => {
              e.stopPropagation();
              flip();
            }}
          >
            <PenLine size={20} aria-hidden="true" />
          </button>
        </div>

        {/* ── Back ── */}
        <div className={`bw-wcard-face bw-wcard-back${themed ? ' is-themed' : ''}`} aria-hidden={!flipped}>
          {/* Magnetic strip: the identity key lives here (owner, 10 Oct 2026), with a small copy icon on its left. */}
          <div className="bw-wcard-stripe">
            {backKey && (
              <div className="bw-wcard-stripe-key">
                {/* Copy sits LEFT of the key (owner, 13 Oct 2026): the customise-front button is on the right. */}
                <button
                  type="button"
                  className="bw-wcard-stripe-copy"
                  onClick={copy(backKey)}
                  aria-label="Copy identity key"
                  title="Copy identity key"
                  tabIndex={flipped ? 0 : -1}
                >
                  <Copy size={13} aria-hidden="true" />
                </button>
                <span className="bw-wcard-stripe-text">
                  <span className="bw-wcard-stripe-label">ID KEY:</span>
                  <span className="bw-wcard-stripe-hex" title={backKey}>
                    {stripeKey(backKey)}
                  </span>
                </span>
              </div>
            )}
            {/* Theme (owner, 14 Oct 2026): App colours + Design your card. Shown on every card, store builds too. */}
            <button
              type="button"
              className="bw-wcard-design"
              aria-label="Theme"
              title="Theme"
              tabIndex={flipped ? 0 : -1}
              onClick={(e) => {
                e.stopPropagation();
                setAdjusting(true);
              }}
            >
              <SlidersHorizontal size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="bw-wcard-backbody">
            <div className={`bw-wcard-qr${artQr ? ' is-art' : ''}`}>
              {artQr ? (
                <img src={artQr} alt={`QR code for ${cardPaymail(names.paymail)}`} />
              ) : qrUrl ? (
                <img src={qrUrl} alt="Receive QR code" />
              ) : (
                <div className="bw-wcard-qr-empty" />
              )}
            </div>
            <div className="bw-wcard-backinfo">
              <span className="bw-wcard-sig-cap">AUTHORISED SIGNATURE{sig.svgPath ? '' : ' · tap to sign'}</span>
              <div
                className={`bw-wcard-sig${sig.svgPath ? ' has-drawn' : ''}`}
                role="img"
                aria-label={
                  sig.svgPath ? 'Your drawn signature. Tap Edit to change it.' : 'Signature strip. Tap to sign.'
                }
                {...sig.pressHandlers}
                onClick={(e) => {
                  e.stopPropagation();
                  sig.open();
                }}
              >
                {sig.svgPath ? (
                  <svg
                    className="bw-wcard-sig-drawn"
                    viewBox={sig.viewBox}
                    preserveAspectRatio="xMinYMid meet"
                    aria-hidden="true"
                  >
                    <path d={sig.svgPath} fill="#1b2a5a" />
                  </svg>
                ) : (
                  <span className="bw-wcard-sig-empty">Sign here</span>
                )}
                <button
                  type="button"
                  className="bw-wcard-sig-pen"
                  aria-label={sig.svgPath ? 'Change signature' : 'Draw signature'}
                  title={sig.svgPath ? 'Change signature' : 'Draw signature'}
                  onClick={(e) => {
                    e.stopPropagation();
                    sig.open();
                  }}
                >
                  <PenLine size={13} color="#5a6380" aria-hidden="true" />
                  <span>{sig.svgPath ? 'Edit' : 'Sign'}</span>
                </button>
              </div>
            </div>
          </div>
          {artAttribution && (
            <p className="bw-wcard-attrib">
              {artAttribution}
              {design?.kind === 'sub' && design.active && (
                <button
                  type="button"
                  className="bw-wcard-attrib-stop"
                  tabIndex={flipped ? 0 : -1}
                  onClick={(e) => {
                    e.stopPropagation();
                    pickDesign({ ...design, active: false });
                  }}
                >
                  Stop
                </button>
              )}
            </p>
          )}
          {/* Swivel, same spot as the front's pen (owner, 12 Oct 2026: pen on the front, swivel on the back): flips back to the front. On Android the
              back's copy targets used to swallow every tap, so this is the reliable way home. */}
          <button
            type="button"
            className="bw-wcard-penflip bw-wcard-penflip-back"
            aria-label="Show the front of the card"
            title="Show the front of the card"
            tabIndex={flipped ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation();
              flip();
            }}
          >
            <RotateCcw size={20} aria-hidden="true" />
          </button>
        </div>
      </div>
      {/* History moved to the wallet's top row (wallet/BuyBsv.tsx BsvPriceBar, owner round 6). */}
      {handleOpen && <HandleFlow onClose={() => setHandleOpen(false)} />}
      {adjusting && (
        <ThemeSheet
          account={artKey}
          onClose={() => setAdjusting(false)}
          offer={themeOffer}
          initialTab={themeOffer ? 'colours' : undefined}
          card={
            frontArt
              ? (tabs) => (
                  <CardDesigner
                    title="Theme"
                    tabs={tabs}
                    art={frontArt}
                    look={look}
                    isDefault={!savedLook && !cardImage && !design}
                    handle={t.tag || cardPaymail(names.paymail)}
                    balance={unit === 'usd' ? formatUSD(animUsd) : cardBsv(animSats)}
                    sub={unit === 'usd' ? cardSats(animSats) : formatUSD(animUsd)}
                    onChange={setLook}
                    onReset={() => {
                      setLook(null);
                      setImage(null);
                    }}
                    onClose={() => setAdjusting(false)}
                    customImage={!!cardImage || !!design}
                    onImage={setImage}
                    design={design}
                    onDesign={pickDesign}
                    accentId={accentId}
                    libraryKey={artKey}
                    currentImage={cardImage}
                  />
                )
              : undefined
          }
        />
      )}
      {sig.ui}
      {scanOpen && (
        <Suspense fallback={null}>
          <ScanSheet receiveAddress={receiveAddress} onClose={() => setScanOpen(false)} />
        </Suspense>
      )}
      {pictureOpen && (
        <Suspense fallback={null}>
          <PictureSheet onClose={() => setPictureOpen(false)} />
        </Suspense>
      )}
    </div>
  );
};

/** If the card ever throws while rendering, show a plain fallback card (balance + retry) instead of nothing. */
class WalletCardBoundary extends Component<
  { children: ReactNode; usd: number; sats: number; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[WalletCard] render failed', error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const { usd, sats, onRetry } = this.props;
    return (
      <div className="bw-wcard-wrap">
        <div className="bw-wcard" role="group" aria-label="Wallet balance">
          <div className="bw-wcard-face bw-wcard-front">
            <div className="bw-wcard-centre">
              <span className="bw-wcard-usd">{Number.isFinite(usd) ? `$${usd.toFixed(2)}` : '—'}</span>
              <span className="bw-wcard-sats">
                {Number.isFinite(sats) ? `${Math.round(sats).toLocaleString('en-US')} sats` : ''}
              </span>
              <button
                type="button"
                className="bw-wcard-retry"
                onClick={() => {
                  this.setState({ failed: false });
                  onRetry();
                }}
              >
                Tap to reload the card
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

const RealWalletCard = (p: WalletCardProps) => {
  // The connected game's room shows a short balance card (chat/SiteRoomViews.tsx) from this.
  useEffect(() => publishBalance('bsv', p.sats, 'sats'), [p.sats]);
  return (
    <WalletCardBoundary usd={p.usd} sats={p.sats} onRetry={p.onRetry}>
      <WalletCardInner {...p} />
    </WalletCardBoundary>
  );
};

// Balance cards (bWalletX only, never in store builds): the real card becomes the first slide of a multi-balance carousel.
export const WalletCard = (p: WalletCardProps) =>
  BalanceCarousel ? (
    <Suspense fallback={<RealWalletCard {...p} />}>
      <BalanceCarousel bsvCard={<RealWalletCard {...p} />} />
    </Suspense>
  ) : (
    <AddressBookPull>
      <RealWalletCard {...p} />
    </AddressBookPull>
  );
