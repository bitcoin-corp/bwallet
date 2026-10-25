import { TipButton } from '../tip/TipButton';
import bGlyph from '../brand/bwallet-glyph.svg';
import { B_OUTLINE_D, B_OUTLINE_VIEWBOX } from '../brand/bOutline';
import { mergeChatRooms } from './tabBadges';
import { claimIssuerAdmin } from '../chat/autoClaim';
import { WIDE_ON } from '../wide/flag';
import { RoomDetails } from '../wide/RoomDetails';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { claimDepsFor } from '../chat/claimDeps';
import { IssuerBadge } from '../issuer/IssuerBadge';
import { HISTORY_HIDDEN_NOTE, showHistoryNote } from '../chat/history';
import { logInWalletApp } from '../wallet/connectionLog';
import {
  type CSSProperties,
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBackClose } from '../backStack';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowUp,
  Coins,
  Info,
  Lock,
  Plus,
  ShieldCheck,
  MessageCircle,
  Search,
  Settings,
  ShoppingCart,
  Trophy,
  UserPlus,
  Copy,
  Share2,
  WifiOff,
  X,
  Loader2,
  Store,
} from 'lucide-react';
import { type Bsv21Balance } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import { SendBsv21View } from '../../components/SendBsv21View';
import { NameInput } from '../names/NameInput';
import { useTheme } from '../../hooks/useTheme';
import { InviteLinksPanel } from '../chat/InviteLinksPanel';
import { copyLink, shareLink } from '../chat/shareLink';
import { DEFAULT_EXPIRY, parsePage, parseSpaceInvite } from '../spaces/invite';
import { hasInvitePrefill, onXInvite, takeXInvite, type XInviteLink } from '../chat/xInvites';
import { InvitesApi } from '../chat/invitesApi';
import { BuyTokenButton } from '../chat/OpenTokenRoomButton';
import { LinkedTokenChip } from '../chat/LinkedTokenChip';
import { TopNav } from '../../components/TopNav';
import { useInPeek } from '../phone/pageEl';
import { readListCache, writeListCache } from '../ui/listCache';
import { afterPaint } from '../ui/afterPaint';
import { stableOrder } from '../chat/listOrder';
import { SkeletonRows } from '../chat/SkeletonRows';
import {
  ArchivedGroup,
  ChatSwipeRow,
  MutedMark,
  RowBadge,
  type ChatRowInfo,
  type RowCommands,
} from '../chat/ChatRowActions';
import {
  arrange,
  isMarked,
  isMuted,
  isPinned,
  roomKeyOf,
  setMarked,
  setPinned as setPrefPinned,
  settle,
  useListPrefs,
} from '../chat/listPrefs';
import { UndoToastHost } from '../swipe/undo';
import { fetchRooms, onRooms, roomsCacheKey, sharedChatClient } from '../chat/sharedRooms';
import { peekThread, readThread, warmThreadCache, writeThread } from '../chat/threadCache';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import { BchatClient, ChatApiError, loadSession, needsHandle, saveSession, SESSION_EVENT } from '../chat/api';
import { HandleFlow } from '../names/HandleFlow';
import { avatarFor, B_AVATAR, pendingBQuestions, rememberAvatar, useAvatars } from '../chat/avatars';
import { ChatAvatar as Avatar } from '../chat/ChatAvatar';
import { roomHeaderBackground, roomOwnerOrigin, useRoomLook } from '../chat/roomLook';
import { gateIconUrl, lockedForMe, lockedLine, roomTokenGate } from '../chat/roomGate';
import { roomSetupState, shouldOfferRoomSetup } from '../chat/roomSetupPrompt';
import type { ReplyRef } from '../chat/api';
import {
  applyMention,
  isPrivateB,
  isReactionEvent,
  isShared,
  mentionQuery,
  mentionSuggestions,
  optimisticReaction,
  reactionsByMessage,
  replyOf,
  replyRefFor,
  typingLabel,
} from '../chat/social';
import { messageGestures } from '../chat/messageGestures';
import { haptic } from '../swipe/haptics';
import {
  MentionPicker,
  MessageText,
  ReactionBar,
  ReactionChips,
  ReplyPreview,
  ReplyQuote,
  TypingRow,
} from '../chat/BubbleExtras';
import { BDraftCard, BDraftSheet } from '../chat/BDraftCard';
import { CommissionCard, CommissionComposer } from '../chat/CommissionCard';
import { commissionCardNo, parseCommissionCommand } from '../chat/commissions';
import { AiLabel, BusinessSheet, OrderCard } from '../chat/BusinessAgentViews';
import { isBusinessAgentMessage, orderCardInfo, orderStatuses, useBusinessPresence } from '../chat/businessAgent';
import { bDraftInfo, canAskBDraft } from '../chat/bDraft';
import { AttachButton, MessageVideo, RoomMediaBubble } from '../chat/RoomMedia';
import { mediaPayload } from '../chat/roomMediaInfo';
import { walletSigner } from '../chat/signer';
import { proveHoldings, walletHoldings } from '../chat/holdings';
import { onTokenNav, requestChatRoom, requestMarketToken, takeChatRoom } from '../chat/nav';
import { onRoomTicker, takeDmDraft, takeRoomTicker } from '../chat/segmentNav';
import { RoomBell } from '../push/RoomBell';
import {
  APP_NAME,
  BSPACES_ENABLED,
  XINVITES_ENABLED,
  roomSpacesAllowed,
  MARKET_ENABLED,
  STORE_BUILD,
  STORE_ROOM_NOTE,
  marketLabel,
  tokenRoomsEnabled,
} from '../storeBuild';
import { LiveBanner } from '../spaces/LiveBanner';
import { LoungeCard } from '../chat/LoungeCard';
import { HELP_DESK_NAME, isLounge, LOUNGE_TICKER } from '../chat/loungeInfo';
import { setHelpDeskUnpinned, useHelpDeskPinned } from '../chat/helpDeskPin';
import { roomSpaceOpen } from '../spaces/model';
import { RoomFilterChips, SpacesRoomList } from '../spaces/SpacesFilter';
import { loadRoomFilter, saveRoomFilter, type RoomFilter } from '../spaces/roomFilterPref';
import { bappForTicker, isBappRoom, type Bapp } from '../chat/bappRooms';
import { BappRoomCards } from '../chat/BappRoomCards';
import { SiteRoomBalance } from '../chat/SiteRoomViews';
import { useLocation } from 'react-router-dom';
import { guardedSendBsv21 } from '../../services/tokenSpendGuard';

/** Store build: token rooms are listed but never opened, joined or bought into (storeBuild.ts). */
const ROOMS = tokenRoomsEnabled();
// New Space picks any of your rooms and can open paid entry: bWalletX only, a lazy chunk behind the inlined
// flag so a store build never contains it (the store starts a free Space from an open room's banner).
// Room X invites (host Invites sheet + the claim screen): bWalletX only, lazy chunks behind the inlined flag.
const XInvitesSheet = XINVITES_ENABLED
  ? lazy(() => import('../chat/XInvitesSheet').then((m) => ({ default: m.XInvitesSheet })))
  : null;
const XInviteClaim = XINVITES_ENABLED
  ? lazy(() => import('../chat/XInviteClaim').then((m) => ({ default: m.XInviteClaim })))
  : null;
const NewSpaceSheet = BSPACES_ENABLED
  ? lazy(() => import('../spaces/NewSpaceSheet').then((m) => ({ default: m.NewSpaceSheet })))
  : null;
import {
  amountLabel,
  buildTokenRoomList,
  holdingFromLookup,
  holdingsFromRooms,
  holdLine,
  parseGateRefusal,
  parseInvitee,
  parseLookup,
  parseTokenKey,
  personalOfRoom,
  type GateRefusal,
  type Holding,
  type TokenGate,
  type TokenRoomEntry,
  type TokenRoomLookup,
} from '../chat/tokenRooms';
import {
  costLine,
  loadPrefs,
  mustPay,
  needsConfirm,
  payForMessage,
  recordSpent,
  releasePayment,
  savePrefs,
  spentThisSession,
  totalRaw,
  type SpendCharge,
} from '../chat/roomSpend';
import { formatRaw, toRawAmount } from '../chat/tokenRooms';
import { addToInviteList, inviteLine, inviteState, loadInviteList } from '../chat/invites';
import { knownPersonal, rememberPersonal, tickerLabel } from '../names/personalToken';
import { retryPersonalRoom } from '../names/claimPersonal';
import { indexingMessage, indexingRetryDelay, isNotYetIndexed, isOwnTokenKey } from '../chat/roomIndexing';
import { listOwnTokens } from '../tokens/indexFund';
import { ownTokens, recheckPendingIndexing } from '../tokens/pendingIndexing';
import { setupLabel, useRoomSetup } from '../tokens/useRoomSetup';
import type { OwnToken } from '../tokens/indexFund';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getErrorMessage } from '../../utils/tools';
import { asMenuItem, TAB_TAP } from './tabs';
import { ChatTabs, SegmentRow, SegmentTitle } from '../feed/ChatSegments';
import { useChatDisplayName } from '../feed/chatDisplayName';
import {
  avatarHue,
  latestCursor,
  listTimeLabel,
  isBotMessage,
  isEphemeral,
  mergeMessages,
  settleEphemeral,
  normHandle,
  oldestCursor,
  previewText,
  roomActivity,
  dmPeer,
  roomTitle,
  threadItems,
  timeLabel,
  visibleMessages,
  type ChatMessage,
  type ChatRoom,
} from '../chat/messages';
import {
  claimCheck,
  loadSeen,
  markSeen,
  parseBounties,
  parseSpec,
  rewardLabel,
  saveSeen,
  showPay,
  sortBounties,
  transferLabel,
  unseenForMe,
  type Bounty,
  type PayoutSpec,
} from '../chat/bounties';
import { PullToRefresh } from '../ui/PullToRefresh';
import { DmsPage, type DmConversationProps } from '../chat/DmsPage';
import { UserSafetyButton } from '../ugc/UserSafety';
import { setBlocked, syncBlocks } from '../ugc/blocks';
import { blockedHandles, onUgcChange } from '../ugc/ugc';
import {
  browseList,
  byActivity,
  isOpenRoom,
  isStaff,
  openInfo,
  parsePublicRooms,
  withoutBlocked,
  type PublicRoom,
} from '../chat/openRooms';
import { MessageMenu, NewRoomSheet, OpenRoomSheet } from '../chat/OpenRoomSheets';
import { useRoomCard } from '../chat/roomCard';
import { RoomSettingsSheet } from '../chat/RoomSettingsSheet';
import { celebrateSend } from '../../components/sent/sent';
import { ErrorActions } from '../errors/ErrorActions';
import { LIST_TYPES, THREAD_TYPES, useLive, useLiveHealth, useLiveTyping } from '../chat/live';
import { useRoomFeed } from '../chat/roomFeed';

/**
 * Chat › Chatrooms: open rooms (no token, every build) + token rooms (docs/TOKEN-ROOMS.md); 1:1 DMs + contacts live in the DMs
 * segment (chat/DmsPage.tsx, owner reversal of the earlier no-DMs rule). The list is one room per
 * BSV-21 token / 1Sat collection this wallet holds at or above the room minimum — buy a token
 * and its room appears; sell it and the room goes.
 * Rooms list → conversation → back, all inside this tab; the conversation covers the bottom bar.
 * Talks to bitcoinchat.online's API with a session the wallet gets by signing
 * bChat's wallet-login challenge (../chat/api.ts). Live updates by polling
 * (4s in an open conversation, 30s on the list) until realtime lands in v2.
 */
const GOLD = 'var(--bw-accent-hi)';
const BG = '#010101';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const LIST_POLL_MS = 30_000;
const THREAD_POLL_MS = 4_000;
/** While the live stream is healthy (chat/live.ts) the polls are only a safety net. */
const THREAD_LIVE_MS = 60_000;
const LIST_LIVE_MS = 300_000;
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

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

/** Runs `fn` every `ms` while the page is visible. */
const usePoll = (fn: () => void, ms: number, enabled: boolean) => {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => document.visibilityState === 'visible' && ref.current();
    const id = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [ms, enabled]);
};

/** A room's own picture (metadata.icon, https only), e.g. the bWallet Help Desk's (owner, 6 Oct 2026). */
const roomIcon = (room: ChatRoom): string | null => {
  const icon = (room.metadata as { icon?: unknown } | null | undefined)?.icon;
  if (typeof icon === 'string' && /^https:\/\//.test(icon)) return icon;
  // A token-gated room shows its token's on-chain icon, never the generic gold avatar (owner, 25 Oct 2026).
  return gateIconUrl(roomTokenGate(room.metadata));
};
/** Official rooms (metadata.open.official) show how to ask $b. */
const isOfficialRoom = (room: ChatRoom) =>
  Boolean((room.metadata as { open?: { official?: boolean } } | null | undefined)?.open?.official);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────────── Conversation ─────────────────────────────

const Conversation = ({
  client,
  room,
  me,
  online,
  onBack,
  onAuthLost,
  entry,
  onLocked,
  onInvite,
  onXInvites = null,
  onBans,
  onBounties,
  onMarket,
  peer = null,
  openRoom = null,
  hidden,
  onMessageMenu = null,
  bell = true,
  autoJoinSpace = false,
}: {
  client: BchatClient;
  room: ChatRoom;
  me: string;
  online: boolean;
  onBack: () => void;
  onAuthLost: () => void;
  entry: TokenRoomEntry | null;
  /** The server refused: you no longer hold enough (or never did). */
  onLocked: (refusal: GateRefusal) => void;
  onInvite: (() => void) | null;
  /** Room host (bit-sign says can manage): the X Invites sheet. Null hides the button. */
  onXInvites?: (() => void) | null;
  /** Room admin: the ban list. */
  onBans: (() => void) | null;
  /** Token rooms: Buy / sell this token (its Market page). */
  onMarket?: (() => void) | null;
  /** Null hides the Bounties button (1:1 DMs). */
  onBounties: (() => void) | null;
  /** A 1:1's other person: shows Report / Block (Apple 1.2). */
  peer?: string | null;
  /** Open rooms (no token): the info button, and read-only once closed. */
  openRoom?: { closed: boolean; visibility: 'public' | 'invite'; onInfo: () => void } | null;
  /** Message ids removed by a moderator in this session. */
  hidden?: ReadonlySet<string>;
  /** Long-press a message: report / block / delete. */
  onMessageMenu?: ((m: ChatMessage) => void) | null;
  /** Push bell (All / Mentions / Off). Off for DMs, which always notify. */
  bell?: boolean;
  /** Opened from the Lounge card's Join: go straight into the room's always-open Space. */
  autoJoinSpace?: boolean;
}) => {
  const bountyBadge = useBountyBadge(client, room.ticker, me);
  // Business agent (bit-sign lib/business-agent.ts): the shop button for its customers and the host's setup.
  const hasBusiness = useBusinessPresence(
    client,
    room.ticker,
    String((room as { created_by_handle?: unknown }).created_by_handle ?? '') === me,
  );
  const [bizOpen, setBizOpen] = useState(false);
  const title = entryTitle(entry, room) ?? roomTitle(room, me);
  useBackClose(true, onBack);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Admin-only events (event_payload.audience === 'admins') are for the room admin / issuer only.
  const viewerIsAdmin = !!onBans || String((room as { created_by_handle?: unknown }).created_by_handle ?? '') === me;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  // Set when bit-sign floored this reader's history (since_join room; chat/history.ts).
  const [hiddenBefore, setHiddenBefore] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // A DM opened with a prefilled reply (Airdrops › Reply, segmentNav.requestDm).
  const [draft, setDraft] = useState(() => takeDmDraft(peer));
  // Facebook / WhatsApp parity (chat/social.ts): reply quote, reaction bar, typing, mentions.
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [acting, setActing] = useState<ChatMessage | null>(null);
  /** Hold (or swipe right) on a message: quote it and open the keyboard, no extra Reply tap. */
  const startReply = (m: ChatMessage) => {
    setReplyTo(replyRefFor(m));
    setActing(null);
    requestAnimationFrame(() => composer.current?.focus());
  };
  /** Inline edit of one of your own messages: the bubble becomes a text box (Save / Cancel). */
  const [editing, setEditing] = useState<{ id: string; text: string; busy?: boolean } | null>(null);
  const [commissionDraft, setCommissionDraft] = useState<{ assignee: string | null; draft: string } | null>(null);
  const [polledTyping, setTyping] = useState<string[]>([]);
  // Live (chat/live.ts): typing arrives over the stream and the typing GET poll stops.
  const liveOn = useLiveHealth() === 'live';
  const liveTyping = useLiveTyping(room.ticker, me, liveOn);
  const typing = liveOn ? liveTyping : polledTyping;
  const lastTypingPing = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prependAnchor = useRef<number | null>(null);
  const localSeq = useRef(0);

  // Priced token rooms (chat/roomSpend.ts): what a message costs me, asked of bit-sign on open.
  // Store builds never open token rooms (ROOMS), so this never runs there.
  const { apiContext } = useServiceContext();
  // Token room issuer: prove the issuer key in the background (once per room per session).
  useEffect(() => {
    if (!entry || !me) return;
    void claimIssuerAdmin(room.ticker, me, claimDepsFor(client, apiContext));
  }, [entry, me, room.ticker, client, apiContext]);
  const [charge, setCharge] = useState<SpendCharge | null>(null);
  const [confirmSend, setConfirmSend] = useState<{ text: string; existing?: ChatMessage } | null>(null);
  /** A payment already made for an optimistic message: a retry reuses it (bit-sign is idempotent per txid). */
  const paidFor = useRef(new Map<string, { beef: string; rule: string; txid: string }>());
  const entryKey = entry?.key ?? null;
  const loadCharge = useCallback(() => {
    if (!ROOMS || !entryKey) return;
    void client
      .tokenRoom(entryKey)
      .then(parseLookup)
      .then((l) => setCharge(l?.spendCharge ?? null))
      .catch(() => {});
  }, [client, entryKey]);
  useEffect(loadCharge, [loadCharge]);
  const chargeDec = (c: SpendCharge) => (c.charges.every((x) => x.unit === 'sats') ? 0 : (entry?.gate.dec ?? 0));

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ChatApiError && e.status === 401) return onAuthLost();
      const refusal = e instanceof ChatApiError && e.status === 403 ? parseGateRefusal(e.data) : null;
      if (refusal) return onLocked(refusal);
      setError(errText(e));
    },
    [onAuthLost, onLocked],
  );

  // Instant open (chat/threadCache.ts): show the cached tail at once, then fetch only what is newer.
  // latestPage only when nothing is cached for this room and identity.
  useEffect(() => {
    let live = true;
    const show = (cached: ChatMessage[]) => {
      setMessages(mergeMessages([], visibleMessages(cached, viewerIsAdmin)));
      setHasMore(true);
      setLoading(false);
      const cursor = latestCursor(cached);
      if (!cursor) return;
      client
        .since(room.ticker, cursor)
        .then((fresh) => {
          if (!live) return;
          writeThread(me, room.ticker, fresh);
          const shown = visibleMessages(fresh, viewerIsAdmin);
          if (shown.length) setMessages((cur) => mergeMessages(cur, shown, { dropOrphanEdits: true }));
          setError('');
          void client.markRead(room.ticker).catch(() => {});
        })
        .catch((e) => live && fail(e));
    };
    const fetchLatest = () => {
      setLoading(true);
      client
        .latestPage(room.ticker)
        .then((p) => {
          if (!live) return;
          writeThread(me, room.ticker, p.messages);
          setMessages(mergeMessages([], visibleMessages(p.messages, viewerIsAdmin)));
          setHasMore(p.hasMore);
          setHiddenBefore(p.hiddenBefore ?? null);
          setError('');
          void client.markRead(room.ticker).catch(() => {});
        })
        .catch((e) => live && fail(e))
        .finally(() => live && setLoading(false));
    };
    const peek = peekThread(me, room.ticker);
    if (peek) show(peek);
    else
      void readThread(me, room.ticker).then((cached) => {
        if (!live) return;
        if (cached) show(cached);
        else fetchLatest();
      });
    return () => {
      live = false;
    };
  }, [client, room.ticker, fail, viewerIsAdmin, me]);

  const poll = useCallback(() => {
    const cursor = latestCursor(messages);
    if (!cursor || !online) return;
    client
      .since(room.ticker, cursor)
      .then((fresh) => {
        if (fresh.length) writeThread(me, room.ticker, fresh);
        const shown = visibleMessages(fresh, viewerIsAdmin);
        if (!shown.length) return;
        setMessages((cur) => mergeMessages(cur, shown, { dropOrphanEdits: true }));
        void client.markRead(room.ticker).catch(() => {});
      })
      .catch(() => {});
    if (!liveOn) void client.whoIsTyping(room.ticker).then(setTyping);
  }, [client, room.ticker, messages, online, viewerIsAdmin, me, liveOn]);
  // Hidden (phone pager peek / display:none): no polling; the list catches up when shown.
  const offScreen = useInPeek();
  // A message event for this room re-reads it through `since`; the poll drops to 60 s while live.
  const threadMs = useLive(poll, THREAD_POLL_MS, {
    liveMs: THREAD_LIVE_MS,
    types: THREAD_TYPES,
    room: room.ticker,
    enabled: !loading && !offScreen,
  });
  usePoll(poll, threadMs, !loading && !offScreen);
  // Realtime inserts for this room (chat/roomFeed.ts): messages and join/leave events re-read now.
  useRoomFeed(room.id, poll, !loading && !offScreen);
  // "I'm typing": at most every 3 s while the draft changes (bit-sign keeps it 6 s).
  const pingTyping = (text: string) => {
    if (!text.trim() || /^\/b(\s|$)/i.test(text.trim()) || Date.now() - lastTypingPing.current < 3_000) return;
    lastTypingPing.current = Date.now();
    void client.typing(room.ticker).catch(() => {});
  };
  // The server appends a new version and returns it; merging replaces the old bubble in place
  // (its supersedes_id), marked "edited". Same text → nothing to do.
  const saveEdit = () => {
    if (!editing || editing.busy) return;
    const text = editing.text.trim();
    const original = messages.find((x) => x.id === editing.id);
    if (!text || !original || text === (original.body || '').trim()) {
      setEditing(null);
      return;
    }
    setEditing({ ...editing, busy: true });
    client
      .editMessage(room.ticker, editing.id, text)
      .then((saved) => {
        // Dated as the original (it is placed there anyway): the edit's own created_at is
        // "now" and would move the `since` cursor past messages the poll has not fetched yet.
        setMessages((cur) => mergeMessages(cur, [{ ...saved, created_at: original.created_at }]));
        setEditing(null);
      })
      .catch((e) => {
        setEditing((cur) => (cur ? { ...cur, busy: false } : cur));
        fail(e);
      });
  };
  const react = (m: ChatMessage, emoji: string) => {
    const mineNow = (reactions.get(m.id) ?? []).some((r) => r.emoji === emoji && r.handles.includes(normHandle(me)));
    setMessages((cur) => cur.concat(optimisticReaction(m.id, emoji, me, mineNow)));
    client.react(room.ticker, m.id, emoji).catch((e) => {
      setMessages((cur) =>
        cur.filter(
          (x) =>
            !(x.pending && x.event_type === 'reaction' && (x.event_payload as { target?: string })?.target === m.id),
        ),
      );
      fail(e);
    });
  };
  const shareB = (m: ChatMessage) => {
    client
      .shareBAnswer(room.ticker, m.id)
      .then((saved) =>
        setMessages((cur) =>
          mergeMessages(
            cur.map((x) => (x.id === m.id ? { ...x, event_payload: { ...(x.event_payload ?? {}), shared: true } } : x)),
            saved ? [saved] : [],
          ),
        ),
      )
      .catch(fail);
  };

  const loadOlder = useCallback(() => {
    const before = oldestCursor(messages);
    if (!before || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    prependAnchor.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
    client
      .page(room.ticker, { before })
      .then((p) => {
        setMessages((cur) => mergeMessages(cur, visibleMessages(p.messages, viewerIsAdmin)));
        setHasMore(p.hasMore);
      })
      .catch(fail)
      .finally(() => setLoadingOlder(false));
  }, [client, room.ticker, messages, hasMore, loadingOlder, fail, viewerIsAdmin]);

  // Keep position when older messages are prepended; otherwise follow the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prependAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, typing.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120) loadOlder();
  };

  const send = (text: string, existing?: ChatMessage) => {
    const body = text.trim();
    if (!body) return;
    // /commission opens the composer (chat/CommissionCard.tsx); it is never posted as a message.
    const commission = existing ? null : parseCommissionCommand(body);
    if (commission) {
      setCommissionDraft(commission);
      setDraft('');
      return;
    }
    const prior = existing?.localId ? paidFor.current.get(existing.localId) : undefined;
    if (
      !prior &&
      mustPay(charge) &&
      entryKey &&
      needsConfirm(charge, loadPrefs(entryKey), spentThisSession(entryKey))
    ) {
      setConfirmSend({ text: body, existing });
      return;
    }
    post(body, existing, prior ? null : mustPay(charge) ? charge : null);
  };

  const post = (body: string, existing: ChatMessage | undefined, pay: SpendCharge | null) => {
    const localId = existing?.localId ?? `l${Date.now()}-${++localSeq.current}`;
    const quoting = existing ? replyOf(existing) : replyTo;
    const optimistic: ChatMessage = {
      id: `local:${localId}`,
      localId,
      author_handle: me,
      kind: 'text',
      body,
      created_at: new Date().toISOString(),
      pending: true,
      ...(quoting ? { event_payload: { reply_to: quoting } } : {}),
    };
    stickToBottom.current = true;
    setMessages((cur) => cur.filter((m) => m.localId !== localId).concat(optimistic));
    if (!existing) {
      setDraft('');
      setReplyTo(null);
    }
    const go = async () => {
      let spend = paidFor.current.get(localId);
      if (!spend && pay && entryKey) {
        const p = await payForMessage(apiContext, { ticker: room.ticker, handle: me, text: body, charge: pay });
        spend = { beef: p.beef, rule: pay.rule, txid: p.txid };
        paidFor.current.set(localId, spend);
      }
      const saved = await client.send(room.ticker, body, spend && { beef: spend.beef, rule: spend.rule }, quoting);
      // Spent only now: bit-sign broadcast it and stored the message.
      if (spend && pay && entryKey) recordSpent(entryKey, totalRaw(pay));
      return saved;
    };
    go()
      .then((saved) => {
        paidFor.current.delete(localId);
        if (saved) writeThread(me, room.ticker, [saved]);
        // A private bot reply (lounge-bot) settles in place of the never-stored command.
        // Any other unstored reply (/b help, Lounge commands) never matches the optimistic copy: drop it.
        setMessages((cur) => {
          if (saved && isEphemeral(saved)) return settleEphemeral(cur, localId, saved);
          const rest =
            saved && normHandle(saved.author_handle ?? '') !== normHandle(me)
              ? cur.filter((m) => m.localId !== localId)
              : cur;
          return saved ? mergeMessages(rest, [saved]) : rest;
        });
      })
      .catch((e) => {
        setMessages((cur) => cur.map((m) => (m.localId === localId ? { ...m, failed: true } : m)));
        // Priced room: needs payment (402) or the price changed (409). Say so; refresh the price.
        if (e instanceof ChatApiError && (e.status === 402 || e.status === 409)) {
          // Refused before broadcast: nothing was spent. Release the signed tx; the next send re-signs.
          const signed = paidFor.current.get(localId);
          paidFor.current.delete(localId);
          if (signed) void releasePayment(apiContext, signed.txid);
          setError(e.message);
          loadCharge();
        } else if (!(e instanceof ChatApiError) && pay) setError(errText(e));
        if (e instanceof ChatApiError && e.status === 401) onAuthLost();
        const refusal = e instanceof ChatApiError && e.status === 403 ? parseGateRefusal(e.data) : null;
        if (refusal) onLocked(refusal);
      });
  };

  // Blocked people's messages are hidden here (ugc/ugc.ts, synced with bit-sign's
  // bchat_user_blocks); re-filter when the block list changes.
  const [blockTick, setBlockTick] = useState(0);
  useEffect(() => onUgcChange(() => setBlockTick((n) => n + 1)), []);
  const items = useMemo(() => {
    const shown = withoutBlocked(messages, new Set(blockedHandles())).filter((m) => !isReactionEvent(m));
    return threadItems(hidden?.size ? shown.filter((m) => !hidden.has(m.id)) : shown, me);
  }, [messages, me, hidden, blockTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const reactions = useMemo(() => reactionsByMessage(messages), [messages]);
  const orderStatus = useMemo(() => orderStatuses(messages), [messages]);
  const direct = false;
  const members = room.party_count ?? entry?.members ?? 0;
  // Bubble avatars (chat/avatars.ts) and "$b is thinking…" under /b questions not yet answered.
  useAvatars(client, [peer, ...messages.map((m) => m.author_handle)]);
  const waitingForB = pendingBQuestions(messages);
  const mq = mentionQuery(draft);
  const mentions = mq === null ? [] : mentionSuggestions(messages, mq, me);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [drafting, setDrafting] = useState(false);
  const draftable = canAskBDraft(room, !!entry) && !isOfficialRoom(room);
  // A connected game's theme dresses its room (chat/roomLook.ts). Never the Help Desk, official rooms or store builds.
  const look = useRoomLook(room.ticker, !STORE_BUILD && !isLounge(room.ticker) && !isOfficialRoom(room), room.metadata);
  const askB = () => {
    setDraft((d) => (/^\/b(\s|$)/i.test(d) ? d : `/b ${d}`));
    requestAnimationFrame(() => composer.current?.focus());
  };

  // Phone layout: Chat stays mounted off to the side (phone/pager.tsx); the open room hides with it (offScreen).
  // Sits between TopNav (3.5rem) and the tab bar (3.75rem) so both stay usable; sheets (z-[150]) still clear it.
  return createPortal(
    <div
      className="fixed z-[110] flex flex-col"
      style={{
        display: offScreen ? 'none' : undefined,
        // Wide web layout (wide/wide.css) sets these so the room opens beside the room list.
        left: 'var(--ww-conv-left, 0px)',
        right: 'var(--ww-conv-right, 0px)',
        top: 'calc(var(--wallet-inset-top, 0px) + var(--ww-conv-top, 3.5rem))',
        bottom: 'calc(env(safe-area-inset-bottom) + var(--dock-h, 3.75rem) + var(--ww-conv-bottom, 0px))',
        // A room with its own look wears it over the user's app theme (owner, 25 Oct 2026: the $TERRORNODE room
        // came out green from the phone's frog theme). The accent variable is set for the whole room, so every
        // GOLD in it (buttons, links, badges) is the room's. A light look keeps the dark room so messages still read.
        background: look?.mode === 'dark' ? look.bg : BG,
        ...(look ? ({ '--bw-accent-hi': look.accentHi, '--bw-accent': look.accent } as CSSProperties) : {}),
      }}
    >
      {/* The connected game's room: a short balance card on top (chat/SiteRoomViews.tsx; only for that room).
          Store builds never (like SiteRoomChip in App.tsx). */}
      {!STORE_BUILD && <SiteRoomBalance ticker={room.ticker} />}
      <div
        // Two rows (owner, 17 Oct 2026): back, picture, name and details on the first; the room's buttons on the
        // second. On one row the buttons squeezed the name and details into a one-word column.
        className="bw-room-head flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-2 shrink-0"
        data-room-look={look ? look.host : undefined}
        style={
          look
            ? ({
                paddingTop: 8,
                minHeight: look.artData ? 96 : undefined,
                background: roomHeaderBackground(look),
                borderBottom: `2px solid ${look.accent}`,
                // The header's buttons use the accent (GOLD reads this variable).
                '--bw-accent-hi': look.accentHi,
              } as CSSProperties)
            : {
                paddingTop: 8,
                background: 'linear-gradient(180deg, #16140c 0%, #0b0b0b 100%)',
                borderBottom: `1px solid ${LINE}`,
              }
        }
      >
        <button onClick={onBack} className="p-2 rounded-full active:opacity-60" aria-label="Back">
          <ArrowLeft size={22} color={GOLD} />
        </button>
        <Avatar
          title={title}
          size={38}
          roomKey={entry?.key}
          src={roomIcon(room)}
          fallback={look?.logoData}
          issuer={peer}
          place="full"
        />
        <div className="flex-1 min-w-0">
          <div
            className={`text-[15px] font-semibold ${look ? '' : 'text-white'} ${ELLIPSIS}`}
            style={look ? { color: look.text } : undefined}
          >
            {title}
          </div>
          {look && (
            <div className={`text-[11px] ${ELLIPSIS}`} style={{ color: look.text, opacity: 0.85 }}>
              {look.name} look · from {look.host}
            </div>
          )}
          <div className="text-[11px]" style={{ color: look ? look.text : MUTED, opacity: look ? 0.85 : undefined }}>
            {!online
              ? 'waiting for network…'
              : entry
                ? `${entry.gate.key.startsWith('coll:') ? entry.gate.symbol : `$${entry.gate.symbol}`} · ${members} holder${members === 1 ? '' : 's'} · you hold ${amountLabel(entry.holding.amountRaw, entry.gate)}`
                : openRoom
                  ? `${members} member${members === 1 ? '' : 's'} · ${openRoom.visibility === 'public' ? 'Public' : 'Invite only'}${openRoom.closed ? ' · Closed' : ''}`
                  : `${members} member${members === 1 ? '' : 's'} · $${room.ticker}`}
          </div>
          {entry && entry.key.startsWith('bsv21:') && <IssuerBadge tokenId={entry.holding.id} compact />}
          <LinkedTokenChip metadata={room.metadata} color={look?.text} />
        </div>
        <div className="flex basis-full items-center justify-end gap-1">
          {peer && <UserSafetyButton client={client} handle={peer} onBlocked={onBack} />}
          {bell && <RoomBell ticker={room.ticker} />}
          {openRoom && (
            <button onClick={openRoom.onInfo} className="p-2 rounded-full active:opacity-60" aria-label="Room info">
              <Info size={20} color={GOLD} />
            </button>
          )}
          {onMarket && (
            <button
              onClick={onMarket}
              className="p-2 rounded-full active:opacity-60"
              aria-label="Buy or sell this token"
            >
              <ShoppingCart size={19} color={GOLD} />
            </button>
          )}
          {onBans && (
            <button onClick={onBans} className="p-2 rounded-full active:opacity-60" aria-label="Room settings">
              {/* Gold for the room's issuer (known once set-up was offered), so they can find their controls. */}
              <Settings
                size={18}
                color={['done', 'later'].includes(roomSetupState(room.ticker) ?? '') ? GOLD : MUTED}
              />
            </button>
          )}
          {hasBusiness && (
            <button
              onClick={() => setBizOpen(true)}
              className="p-2 rounded-full active:opacity-60"
              aria-label="Business agent and orders"
            >
              <Store size={19} color={GOLD} />
            </button>
          )}
          {onBounties && (
            <button onClick={onBounties} className="relative p-2 rounded-full active:opacity-60" aria-label="Bounties">
              <Trophy size={20} color={GOLD} />
              {bountyBadge > 0 && (
                <span
                  className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
                  style={{ background: '#F97066', color: '#fff' }}
                >
                  {bountyBadge}
                </span>
              )}
            </button>
          )}
          {room.created_by_handle && room.created_by_handle !== me && (
            <TipButton
              compact
              to={{ name: `$${room.created_by_handle}`, paymail: `$${room.created_by_handle}` }}
              context={{ kind: 'room', room: room.ticker }}
            />
          )}
          {onXInvites && (
            <button
              onClick={onXInvites}
              className="px-2.5 py-1 rounded-full text-xs font-semibold active:opacity-60"
              style={{ border: `1px solid ${GOLD}`, color: GOLD }}
            >
              Invites
            </button>
          )}
          {onInvite && (
            <button onClick={onInvite} className="p-2 rounded-full active:opacity-60" aria-label="Invite">
              <UserPlus size={20} color={GOLD} />
            </button>
          )}
        </div>
      </div>

      {/* Spaces: Live now / Join, or Start for the issuer or admin. bWalletX: any room; store: open rooms (free Spaces). */}
      {/* In the wide layout the Space banner sits in the room details column instead. */}
      {!WIDE_ON && (BSPACES_ENABLED || roomSpacesAllowed(room)) && (
        <LiveBanner
          client={client}
          ctx={apiContext}
          ticker={room.ticker}
          roomName={title}
          me={me}
          createdBy={room.created_by_handle}
          gated={!!entry}
          spaceOpen={roomSpaceOpen(room)}
          autoOpen={autoJoinSpace}
        />
      )}
      {WIDE_ON && (
        <RoomDetails
          title={title}
          kind={
            peer
              ? 'Direct message'
              : entry
                ? 'Token room'
                : openRoom
                  ? `${openRoom.visibility === 'public' ? 'Public' : 'Invite-only'} room${openRoom.closed ? ' · closed' : ''}`
                  : `Room · $${room.ticker}`
          }
          members={members}
          voices={[
            ...new Set(
              messages
                .map((m) => m.author_handle)
                .filter((h): h is string => !!h)
                .reverse(),
            ),
          ].slice(0, 24)}
          gate={
            entry
              ? {
                  symbol: entry.gate.key.startsWith('coll:') ? entry.gate.symbol : `$${entry.gate.symbol}`,
                  min: amountLabel(entry.gate.minRaw, entry.gate),
                  hold: amountLabel(entry.holding.amountRaw, entry.gate),
                }
              : null
          }
          space={
            BSPACES_ENABLED || roomSpacesAllowed(room) ? (
              <LiveBanner
                client={client}
                ctx={apiContext}
                ticker={room.ticker}
                roomName={title}
                me={me}
                createdBy={room.created_by_handle}
                gated={!!entry}
                spaceOpen={roomSpaceOpen(room)}
                autoOpen={autoJoinSpace}
              />
            ) : null
          }
          actions={null}
        />
      )}
      <div
        ref={scroller}
        onScroll={onScroll}
        className="bw-room-list flex-1 overflow-y-auto px-3 py-2"
        style={{ background: 'radial-gradient(120% 60% at 50% 0%, #15130b 0%, #050505 60%)' }}
      >
        {loadingOlder && (
          <div className="text-center text-[11px] py-2" style={{ color: MUTED }}>
            Loading earlier messages…
          </div>
        )}
        {showHistoryNote(hiddenBefore) && hasMore !== true && (
          <div className="text-center text-[11px] py-2" style={{ color: MUTED }}>
            {HISTORY_HIDDEN_NOTE}
          </div>
        )}
        {hasMore === false && messages.length > 0 && (
          <div className="text-center text-[11px] py-2" style={{ color: MUTED }}>
            Beginning of conversation
          </div>
        )}
        {loading && (
          <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
            Loading…
          </div>
        )}
        {!loading && error && (
          <div className="text-center text-xs pt-10 text-[#F97066]">
            {error}
            <div>
              <button onClick={onBack} className="mt-3 underline" style={{ color: GOLD }}>
                Back to chats
              </button>
            </div>
          </div>
        )}
        {!loading && !error && messages.length === 0 && (
          <div className="text-center text-xs pt-16" style={{ color: MUTED }}>
            No messages yet. Start the first scene.
          </div>
        )}
        {items.map((it) =>
          it.type === 'day' ? (
            <div key={it.key} className="flex justify-center my-3">
              <span className="text-[11px] px-3 py-1 rounded-full" style={{ background: '#1a1a1a', color: '#c9c3ad' }}>
                {it.label}
              </span>
            </div>
          ) : isBotMessage(it.message) ? (
            <div key={it.key} className="flex justify-start my-2">
              <div
                className="text-[13px] px-3 py-2 rounded-2xl max-w-[85%]"
                style={{ background: '#0c2433', color: '#e6f4ff', border: '1px solid #1d4d6b' }}
              >
                <div className="flex items-center gap-1.5 text-[11px] mb-1" style={{ color: '#8fcdf5' }}>
                  <span className="font-semibold">{String(it.message.event_payload?.name || 'Help Desk bot')}</span>
                  <span className="text-[9px] font-bold px-1 rounded" style={{ background: '#1f6d9c', color: '#fff' }}>
                    BOT
                  </span>
                  {isEphemeral(it.message) && <span>· hidden from others in the room</span>}
                </div>
                <div className="whitespace-pre-line break-words">{it.message.body}</div>
              </div>
            </div>
          ) : orderCardInfo(it.message) ? (
            <OrderCard
              key={it.key}
              info={orderCardInfo(it.message)!}
              status={orderStatus.get(orderCardInfo(it.message)!.orderId) ?? 'proposed'}
              client={client}
              ticker={room.ticker}
              me={me}
              onChanged={poll}
            />
          ) : commissionCardNo(it.message) && me ? (
            <CommissionCard
              key={it.key}
              no={commissionCardNo(it.message)!}
              ticker={room.ticker}
              me={me}
              client={client}
              ctx={apiContext}
              onChanged={poll}
            />
          ) : bDraftInfo(it.message) ? (
            <BDraftCard
              key={it.key}
              message={it.message}
              client={client}
              ticker={room.ticker}
              me={me}
              onChanged={poll}
            />
          ) : it.message.kind === 'event' ? (
            <div key={it.key} className="flex justify-center my-2">
              <span
                className="text-[11px] px-3 py-1 rounded-xl text-center max-w-[85%]"
                style={{ background: '#141414', color: MUTED }}
              >
                {it.message.body || 'Room update'}
              </span>
            </div>
          ) : (
            <Fragment key={it.key}>
              <div
                className={`flex items-end gap-2 ${it.mine ? 'justify-end' : 'justify-start'} ${it.firstOfGroup ? 'mt-2' : 'mt-[3px]'}`}
              >
                {/* Avatars on other people's messages, on the first of a run; a spacer keeps the run aligned. */}
                {!it.mine &&
                  (it.firstOfGroup ? (
                    <Avatar
                      title={it.message.author_handle || '?'}
                      size={28}
                      src={avatarFor(it.message.author_handle)}
                      // The room's agent wears the game's logo when it has no picture of its own (chat/roomLook.ts).
                      fallback={look && isBusinessAgentMessage(it.message) ? look.logoData : undefined}
                    />
                  ) : (
                    <div className="shrink-0" style={{ width: 28 }} />
                  ))}
                <div
                  {...(!it.message.pending && !isEphemeral(it.message) && editing?.id !== it.message.id
                    ? messageGestures({
                        onTap: () => setActing(it.message),
                        onHold: isPrivateB(it.message) ? null : () => startReply(it.message),
                        onSwipeLeft: onMessageMenu && !isPrivateB(it.message) ? () => onMessageMenu(it.message) : null,
                        onSwipeRight: isPrivateB(it.message) ? null : () => startReply(it.message),
                        label: `Message from ${it.mine ? 'you' : `$${it.message.author_handle || 'someone'}`}. Tap for reactions, hold to reply, swipe left to report or block`,
                      })
                    : {})}
                  className={`bw-chat-bubble${it.mine ? ' is-mine' : ''} max-w-[80%] px-3 py-[7px] text-[15px] leading-snug select-none`}
                  style={{
                    borderRadius: 18,
                    borderBottomRightRadius: it.mine ? 6 : 18,
                    borderBottomLeftRadius: it.mine ? 18 : 6,
                    background: it.mine ? 'linear-gradient(160deg, var(--bw-accent-hi) 0%, #E9B21A 100%)' : PANEL,
                    color: it.mine ? '#1a1300' : '#f2f2f2',
                    border: it.mine ? 'none' : `1px solid ${LINE}`,
                    opacity: it.message.pending && !it.message.failed ? 0.75 : 1,
                  }}
                >
                  {!it.mine && !direct && it.firstOfGroup && it.message.author_handle && (
                    <div
                      className="text-[12px] font-semibold mb-[2px] flex items-center gap-1.5"
                      style={{ color: `hsl(${avatarHue(it.message.author_handle)} 70% 72%)` }}
                    >
                      ${it.message.author_handle}
                      {normHandle(it.message.author_handle) !== 'b' && (
                        <TipButton
                          compact
                          to={{ name: `$${it.message.author_handle}`, paymail: `$${it.message.author_handle}` }}
                          context={{ kind: 'room', room: room.ticker, message: it.message.id }}
                        />
                      )}
                    </div>
                  )}
                  {isBusinessAgentMessage(it.message) && (
                    <div className="mb-[3px]">
                      <AiLabel look={look} />
                    </div>
                  )}
                  {replyOf(it.message) && <ReplyQuote reply={replyOf(it.message)!} mine={it.mine} />}
                  {(it.message.event_payload as { shared_by?: string } | null)?.shared_by && (
                    <div className="text-[11px] mb-[2px]" style={{ color: it.mine ? '#5c4800' : MUTED }}>
                      Shared by ${(it.message.event_payload as { shared_by?: string }).shared_by}
                    </div>
                  )}
                  {editing?.id === it.message.id ? (
                    <div className="flex flex-col gap-2 min-w-[220px]">
                      <textarea
                        autoFocus
                        value={editing.text}
                        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            saveEdit();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditing(null);
                          }
                        }}
                        maxLength={4000}
                        rows={Math.min(6, Math.max(2, editing.text.split('\n').length))}
                        aria-label="Edit message"
                        className="w-full resize-none rounded-xl px-3 py-2 text-[15px] outline-none"
                        style={{ background: 'rgba(0,0,0,0.18)', color: 'inherit' }}
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          className="rounded-full px-3 py-1 text-[13px] font-semibold"
                          style={{ background: 'rgba(0,0,0,0.15)' }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={saveEdit}
                          disabled={!editing.text.trim() || editing.busy}
                          className="rounded-full px-3 py-1 text-[13px] font-semibold disabled:opacity-50"
                          style={{ background: '#1a1300', color: GOLD }}
                        >
                          {editing.busy ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : mediaPayload(it.message) ? (
                    <>
                      <RoomMediaBubble client={client} ticker={room.ticker} message={it.message} />
                      {it.message.body && mediaPayload(it.message)?.filename !== it.message.body && (
                        <MessageText body={it.message.body} mine={it.mine} me={me} />
                      )}
                    </>
                  ) : (
                    <>
                      <MessageText body={it.message.body || ''} mine={it.mine} me={me} />
                      <MessageVideo body={it.message.body} />
                    </>
                  )}
                  {isPrivateB(it.message) && (
                    <div
                      className="text-[11px] mt-1 flex items-center gap-2"
                      style={{ color: it.mine ? '#5c4800' : MUTED }}
                    >
                      <Lock size={11} /> Only you can see this
                      {normHandle(it.message.author_handle ?? '') === 'b' &&
                        !isEphemeral(it.message) &&
                        !isShared(it.message) && (
                          <button
                            type="button"
                            onClick={() => shareB(it.message)}
                            className="font-semibold underline"
                            style={{ color: GOLD }}
                          >
                            Share to room
                          </button>
                        )}
                      {isShared(it.message) && <span>· shared</span>}
                    </div>
                  )}
                  <span
                    className="text-[10px] ml-2 float-right mt-[6px]"
                    style={{ color: it.mine ? '#5c4800' : MUTED }}
                  >
                    {it.message.edited ? (
                      <span
                        title={
                          it.message.edited_at ? `Edited ${new Date(it.message.edited_at).toLocaleString()}` : 'Edited'
                        }
                      >
                        edited ·{' '}
                      </span>
                    ) : (
                      ''
                    )}
                    {it.message.failed ? (
                      <button
                        className="underline text-[#b42318]"
                        onClick={() => send(it.message.body || '', it.message)}
                      >
                        failed · retry
                      </button>
                    ) : it.message.pending ? (
                      'sending…'
                    ) : (
                      timeLabel(it.message.created_at)
                    )}
                  </span>
                </div>
              </div>
              {reactions.has(it.message.id) && (
                <ReactionChips
                  list={reactions.get(it.message.id)!}
                  me={me}
                  mine={it.mine}
                  onToggle={(e) => react(it.message, e)}
                />
              )}
              {waitingForB.has(it.message.id) && (
                <div className="flex items-end gap-2 justify-start mt-2" aria-live="polite">
                  <Avatar title="b" size={28} src={B_AVATAR} />
                  <div
                    className="px-3 py-[7px] text-[14px] italic"
                    style={{
                      borderRadius: 18,
                      borderBottomLeftRadius: 6,
                      background: PANEL,
                      color: MUTED,
                      border: `1px solid ${LINE}`,
                    }}
                  >
                    $b is thinking…
                  </div>
                </div>
              )}
            </Fragment>
          ),
        )}
      </div>

      {drafting && (
        <BDraftSheet client={client} ticker={room.ticker} onClose={() => setDrafting(false)} onPosted={poll} />
      )}
      {commissionDraft && (
        <CommissionComposer
          ticker={room.ticker}
          client={client}
          initial={commissionDraft}
          onClose={() => setCommissionDraft(null)}
          onPosted={poll}
        />
      )}
      {bizOpen && <BusinessSheet client={client} ticker={room.ticker} me={me} onClose={() => setBizOpen(false)} />}
      {openRoom?.closed ? (
        <div
          className="px-4 pt-3 text-center text-xs shrink-0"
          style={{
            paddingBottom: 12,
            background: '#0b0b0b',
            color: MUTED,
            borderTop: `1px solid ${LINE}`,
          }}
        >
          This room is closed. You can read it, but no one can post.
        </div>
      ) : (
        <>
          {isOfficialRoom(room) && (
            <div
              className="px-4 pt-2 text-[12px] shrink-0"
              style={{ background: '#0b0b0b', color: MUTED, borderTop: `1px solid ${LINE}` }}
            >
              {/* Two lines (owner, 6 Oct 2026). */}
              <div>
                Questions? Tap the gold <b style={{ color: GOLD }}>b</b> and ask $b, the {APP_NAME} assistant.
              </div>
              <div>Just /b shows what it can do.</div>
            </div>
          )}
          <TypingRow label={typingLabel(typing)} />
          {replyTo && <ReplyPreview reply={replyTo} onCancel={() => setReplyTo(null)} />}
          {mentions.length > 0 && (
            <MentionPicker
              handles={mentions}
              avatar={(h) => <Avatar title={h} size={22} src={avatarFor(h)} />}
              onPick={(h) => {
                setDraft((d) => applyMention(d, h));
                requestAnimationFrame(() => composer.current?.focus());
              }}
            />
          )}
          {mustPay(charge) && (
            <div className="px-4 pt-1 text-[11px] shrink-0" style={{ color: MUTED, background: '#0b0b0b' }}>
              {costLine(charge, entry?.gate.symbol ?? '', chargeDec(charge))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
            className="flex items-end gap-2 px-3 pt-2 shrink-0"
            style={{
              paddingBottom: 8,
              background: '#0b0b0b',
              borderTop: `1px solid ${LINE}`,
            }}
          >
            {/* Photos and videos (free; hidden in rooms that charge per message). */}
            {!mustPay(charge) && (
              <AttachButton client={client} ticker={room.ticker} onUploaded={poll} disabled={!online} />
            )}
            <button
              type="button"
              onClick={askB}
              aria-label={`Ask $b, the ${APP_NAME} assistant`}
              title="Ask b"
              className="h-10 w-10 rounded-full flex items-center justify-center shrink-0"
              style={{
                background: '#1a1608',
                color: GOLD,
                border: `1px solid color-mix(in srgb, ${GOLD} 33%, transparent)`,
              }}
            >
              {/* The gold b mark (owner, 18 Oct 2026: was the text "/b"); the white/edition themes swap in the outline b. */}
              <img src={bGlyph} alt="" width={22} height={22} draggable={false} className="bw-dock-b-gold" />
              <svg
                className="bw-dock-b-outline"
                width={22}
                height={22}
                viewBox={B_OUTLINE_VIEWBOX}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d={B_OUTLINE_D} vectorEffect="non-scaling-stroke" />
              </svg>
            </button>
            {draftable && (
              <button
                type="button"
                onClick={() => setDrafting(true)}
                disabled={!online}
                aria-label="Ask b to draft an agreement or summarise terms"
                title="Ask b to draft"
                className="h-10 px-3 rounded-full flex items-center justify-center shrink-0 text-[13px]"
                style={{ background: '#111', color: GOLD, border: `1px solid ${LINE}` }}
              >
                Draft
              </button>
            )}
            <textarea
              ref={composer}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                pingTyping(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isNative) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              rows={1}
              maxLength={4000}
              placeholder={online ? 'Message' : 'Offline'}
              className="flex-1 resize-none rounded-2xl px-4 py-[9px] text-[15px] text-white outline-none max-h-32"
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label="Send"
              className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
              style={{ background: GOLD }}
            >
              <ArrowUp size={20} color="#1a1300" strokeWidth={2.6} />
            </button>
          </form>
        </>
      )}
      {acting && (
        <ReactionBar
          preview={acting.body || ''}
          onReact={
            isPrivateB(acting) || isEphemeral(acting)
              ? null
              : (e) => {
                  react(acting, e);
                  setActing(null);
                }
          }
          onReply={isPrivateB(acting) ? null : () => startReply(acting)}
          onCopy={
            acting.body
              ? () => {
                  const text = acting.body || '';
                  setActing(null);
                  void copyLink(text).then((r) => r === 'copied' && haptic('light'));
                }
              : null
          }
          onShare={
            isPrivateB(acting) &&
            normHandle(acting.author_handle ?? '') === 'b' &&
            !isEphemeral(acting) &&
            !isShared(acting)
              ? () => {
                  shareB(acting);
                  setActing(null);
                }
              : null
          }
          onEdit={
            normHandle(acting.author_handle ?? '') === normHandle(me) &&
            acting.kind === 'text' &&
            !acting.pending &&
            !acting.failed &&
            !isPrivateB(acting) &&
            !isEphemeral(acting)
              ? () => {
                  setEditing({ id: acting.id, text: acting.body || '' });
                  setActing(null);
                }
              : null
          }
          onMore={
            onMessageMenu && !isPrivateB(acting)
              ? () => {
                  const m = acting;
                  setActing(null);
                  onMessageMenu(m);
                }
              : null
          }
          onClose={() => setActing(null)}
        />
      )}
      {confirmSend && mustPay(charge) && entryKey && (
        <PayToPostSheet
          roomKey={entryKey}
          charge={charge}
          symbol={entry?.gate.symbol ?? ''}
          dec={chargeDec(charge)}
          onCancel={() => setConfirmSend(null)}
          onPay={() => {
            const c = confirmSend;
            setConfirmSend(null);
            post(c.text, c.existing, charge);
          }}
        />
      )}
    </div>,
    document.body,
  );
};

// ───────────────────────────── Sheets ─────────────────────────────

/** "This message costs 5 $X, burned" — with a per-room "don't ask again under N" and a session cap. */
const PayToPostSheet = ({
  roomKey,
  charge,
  symbol,
  dec,
  onPay,
  onCancel,
}: {
  roomKey: string;
  charge: SpendCharge;
  symbol: string;
  dec: number;
  onPay: () => void;
  onCancel: () => void;
}) => {
  const prefs = loadPrefs(roomKey);
  const unit = dec === 0 && charge.charges.every((x) => x.unit === 'sats') ? 'sats' : `$${symbol}`;
  const [auto, setAuto] = useState(!!prefs.autoUnderRaw);
  const [under, setUnder] = useState(formatRaw(prefs.autoUnderRaw || totalRaw(charge).toString(), dec));
  const [cap, setCap] = useState(prefs.sessionCapRaw ? formatRaw(prefs.sessionCapRaw, dec) : '');
  const [err, setErr] = useState('');
  const pay = () => {
    if (auto) {
      const u = toRawAmount(under, dec);
      const c = cap.trim() ? toRawAmount(cap, dec) : '';
      if (!u || c === null) return setErr('Enter positive amounts');
      savePrefs(roomKey, { autoUnderRaw: u, sessionCapRaw: c });
    } else savePrefs(roomKey, { autoUnderRaw: '', sessionCapRaw: '' });
    onPay();
  };
  const spent = spentThisSession(roomKey);
  return (
    <Sheet title="Pay to post" onClose={onCancel}>
      <p className="text-sm text-white mb-2">{costLine(charge, symbol, dec)}.</p>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        The payment and your message go in one transaction. Spent here this session: {formatRaw(spent.toString(), dec)}{' '}
        {unit}.
      </p>
      <label className="flex items-center gap-2 text-xs mb-2" style={{ color: MUTED }}>
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        Don't ask again in this room for messages up to
      </label>
      {auto && (
        <div className="flex flex-col gap-2 mb-3">
          <input
            value={under}
            onChange={(e) => setUnder(e.target.value)}
            inputMode="decimal"
            aria-label={`Up to (${unit})`}
            className="rounded-xl px-3 py-2 text-sm text-white outline-none"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          />
          <input
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            inputMode="decimal"
            placeholder={`Ask again after spending this much this session (${unit}, optional)`}
            className="rounded-xl px-3 py-2 text-sm text-white outline-none"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          />
        </div>
      )}
      {err && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs mb-2" style={{ color: '#f87171' }}>
            {err}
          </p>
          <ErrorActions message={String(err)} />
        </div>
      )}
      <div className="flex gap-2 pb-4">
        <button onClick={onCancel} className="flex-1 rounded-2xl py-3 text-white" style={{ background: PANEL }}>
          Cancel
        </button>
        <button
          onClick={pay}
          className="flex-1 rounded-2xl py-3 font-bold"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          Pay and send
        </button>
      </div>
    </Sheet>
  );
};

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => {
  useBackClose(true, onClose);
  // Portal to body + z above BottomMenu (z-[100]): sheets must also clear the room view (z-[110]).
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-4"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-semibold">{title}</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

/** A room you can't enter: "Hold 1 $FILM to join" + Buy in Market. */
const LockedRoom = ({
  gate,
  heldRaw,
  members,
  onBuy,
  onClose,
}: {
  gate: TokenGate;
  heldRaw: string | null;
  members: number | null;
  onBuy: () => void;
  onClose: () => void;
}) => (
  <Sheet title={gate.key.startsWith('coll:') ? gate.symbol : `$${gate.symbol} room`} onClose={onClose}>
    <div className="flex flex-col items-center text-center gap-2 pb-2">
      <div
        className="h-14 w-14 rounded-2xl flex items-center justify-center"
        style={{ background: '#1a1408', border: '1px solid #3a2f0c' }}
      >
        <Lock size={24} color={GOLD} />
      </div>
      <p className="text-base font-bold text-white">{holdLine(gate)}</p>
      <p className="text-xs" style={{ color: MUTED }}>
        {members !== null ? `${members} holder${members === 1 ? '' : 's'} in this room. ` : ''}
        {heldRaw && heldRaw !== '0'
          ? `You hold ${amountLabel(heldRaw, gate)}.`
          : 'Holding the token is your membership.'}
      </p>
      {MARKET_ENABLED && ROOMS && (
        <button
          onClick={onBuy}
          className="mt-2 w-full rounded-2xl py-3 font-bold flex items-center justify-center gap-2"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          <ShoppingCart size={16} /> Buy in Market
        </button>
      )}
    </div>
  </Sheet>
);

/**
 * Invite to a token room (owner, 8 Oct 2026). Two ways, both behind token rooms (tokenRoomsEnabled):
 *
 * 1. A link. "Copy room page" is the permanent /r/<ticker> page (entry rule, real price, "Buy 1 $X
 *    and enter"); the invite panel makes an ephemeral /i/<code> with expiry and max uses, and lists
 *    yours with their uses and Revoke. Opening either without the token shows the room's existing
 *    get-entry screen; with it, the room.
 * 2. Send the entry token. The recipient box is the Send screen's own NameInput ($handle, paymail,
 *    OpNS or address, with the same address-poisoning warning); Next opens the wallet's existing
 *    BSV-21 send view (SendBsv21View) already filled, whose confirm screen does the send. After a
 *    send, it offers to share the room link with them too.
 */
const InviteSheet = ({
  client,
  ticker,
  roomName,
  entry,
  onClose,
}: {
  client: BchatClient;
  ticker: string;
  roomName: string;
  entry: TokenRoomEntry;
  onClose: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const { theme } = useTheme();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState(() => formatRaw(entry.gate.minRaw, entry.gate.dec));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [short, setShort] = useState(false);
  const [sending, setSending] = useState<{
    token: { isConfirmed: boolean; info: Bsv21Balance };
    amountInput: string;
  } | null>(null);
  const [sentTo, setSentTo] = useState('');
  const [note, setNote] = useState('');
  const symbol = entry.gate.symbol;

  const roomPage = async () => {
    const page = parsePage(await client.roomPage(ticker).catch(() => null));
    return page?.url || '';
  };
  const copyRoomPage = async () => {
    const url = await roomPage();
    if (!url) return setNote('The room page isn’t available yet.');
    setNote((await copyLink(url)) === 'copied' ? 'Room link copied.' : url);
  };
  const shareRoom = async () => {
    // An invite link if the server has them on, else the permanent room page.
    const inv = parseSpaceInvite(
      await client.createRoomInvite(ticker, { expires_in: DEFAULT_EXPIRY }).catch(() => null),
    );
    const url = inv?.url || (await roomPage());
    if (!url) return setNote('The room link isn’t available yet.');
    const r = await shareLink({ title: roomName, text: `Join ${roomName}`, url });
    if (r === 'copied') setNote('Room link copied.');
    if (r === 'failed') setNote(url);
  };
  const createInvite = useCallback(
    (opts: { expires_in: string; max_uses?: number }) => client.createRoomInvite(ticker, opts),
    [client, ticker],
  );
  const listInvites = useCallback(() => client.roomInvites(ticker), [client, ticker]);
  const revokeInvite = useCallback((code: string) => client.revokeRoomInvite(ticker, code), [client, ticker]);

  const next = async () => {
    setError('');
    setShort(false);
    if (!to) return setError('Enter a $handle, paymail or address, and confirm the name.');
    const raw = toRawAmount(amount, entry.gate.dec);
    if (!raw || raw === '0') return setError('Enter an amount.');
    setBusy('Checking balance…');
    try {
      const balances = await heldBsv21Balances(apiContext);
      const id = (entry.holding.id || '').toLowerCase().replace('.', '_');
      const info = balances.find((b) => (b.id || '').toLowerCase().replace('.', '_') === id);
      const held = info ? info.all.confirmed : 0n;
      if (!info || held < BigInt(raw)) return setShort(true);
      setSending({ token: { isConfirmed: true, info }, amountInput: amount });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  if (sending) {
    return createPortal(
      <div className="fixed inset-0 z-[160] flex" style={{ background: theme.color.global.walletBackground }}>
        <SendBsv21View
          token={sending.token}
          prefill={{ address: to, amountInput: sending.amountInput }}
          onBack={(sentAtomic) => {
            setSending(null);
            if (sentAtomic && sentAtomic > 0n) setSentTo(to);
          }}
        />
      </div>,
      document.body,
    );
  }

  return (
    <Sheet title="Invite to this room" onClose={onClose}>
      <div className="max-h-[75vh] overflow-y-auto pb-2">
        {sentTo ? (
          <div className="rounded-2xl p-4 mb-4" style={{ background: PANEL, border: `1px solid ${GOLD}` }}>
            <p className="text-sm text-white font-semibold">Sent. Share the room link with them too?</p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => void shareRoom()}
                className="flex-1 rounded-2xl py-2.5 font-bold flex items-center justify-center gap-2"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                <Share2 size={15} /> Share link
              </button>
              <button
                onClick={() => setSentTo('')}
                className="flex-1 rounded-2xl py-2.5 font-bold text-white"
                style={{ background: PANEL, border: `1px solid ${LINE}` }}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}

        <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: MUTED }}>
          Room link
        </div>
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          Anyone with the link can see the room and buy {amountLabel(entry.gate.minRaw, entry.gate)} to enter.
        </p>
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => void copyRoomPage()}
            className="flex-1 rounded-2xl py-2.5 font-semibold flex items-center justify-center gap-2"
            style={{ border: `1px solid ${GOLD}`, color: GOLD }}
          >
            <Copy size={15} /> Copy link
          </button>
          <button
            onClick={() => void shareRoom()}
            className="flex-1 rounded-2xl py-2.5 font-semibold flex items-center justify-center gap-2"
            style={{ border: `1px solid ${GOLD}`, color: GOLD }}
          >
            <Share2 size={15} /> Share
          </button>
        </div>
        <InviteLinksPanel
          create={createInvite}
          list={listInvites}
          revoke={revokeInvite}
          title={roomName}
          onNote={setNote}
        />

        <div className="text-[11px] font-semibold uppercase tracking-wide mt-6 mb-2" style={{ color: MUTED }}>
          Send token to
        </div>
        <NameInput
          theme={theme}
          asset="token"
          value={to}
          onChange={setTo}
          placeholder={`$name (${APP_NAME}), paymail or address`}
        />
        <div
          className="mt-2 flex items-center gap-2 rounded-2xl px-3"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        >
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal"
            className="flex-1 bg-transparent py-3 text-white outline-none"
            aria-label="Amount"
          />
          <span className="text-sm font-semibold" style={{ color: GOLD }}>
            ${symbol}
          </span>
        </div>
        {short ? (
          <div className="mt-3">
            <p className="text-sm text-[#F97066]">You don’t hold enough ${symbol}.</p>
            <div className="mt-2 flex gap-2">
              <BuyTokenButton kind={entry.holding.kind === 'coll' ? 'coll' : 'bsv21'} id={entry.holding.id} />
            </div>
          </div>
        ) : null}
        <button
          onClick={() => void next()}
          disabled={!!busy || !to}
          className="w-full mt-3 rounded-2xl py-3 font-bold disabled:opacity-50"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          {busy || 'Next'}
        </button>
        {error && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-[#F97066] mt-2">{error}</p>
            <ErrorActions message={String(error)} />
          </div>
        )}
        {note && (
          <button
            onClick={() => setNote('')}
            className="mt-3 w-full text-left text-xs break-all"
            style={{ color: MUTED }}
          >
            {note}
          </button>
        )}
      </div>
    </Sheet>
  );
};

/**
 * Room admin: ban a $handle or an address. Membership = holds the token AND not banned; the
 * server enforces it on every read/post, so a banned holder is out on their next request.
 */
const BansSheet = ({ client, ticker, onClose }: { client: BchatClient; ticker: string; onClose: () => void }) => {
  const [bans, setBans] = useState<{ handle: string | null; address: string | null }[] | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    client
      .bans(ticker)
      .then(setBans)
      .catch((e) => setError(errText(e)));
  }, [client, ticker]);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setInput('');
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const who = parseInvitee(input);
  return (
    <Sheet title="Banned from this room" onClose={onClose}>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        A banned handle or address can't read or post here, even holding the token.
      </p>
      <div
        className="flex items-center gap-2 rounded-2xl px-3"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`$name (${APP_NAME}) or address`}
          autoCapitalize="none"
          autoCorrect="off"
          className="flex-1 bg-transparent py-3 text-white outline-none"
        />
      </div>
      <button
        onClick={() => who && act(() => client.ban(ticker, 'address' in who ? who.address : `$${who.handle}`))}
        disabled={busy || !who}
        className="w-full mt-3 rounded-2xl py-3 font-bold disabled:opacity-50"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        Ban
      </button>
      <ul className="mt-3 flex flex-col gap-2">
        {bans?.length === 0 && (
          <li className="text-xs" style={{ color: MUTED }}>
            Nobody is banned.
          </li>
        )}
        {bans?.map((b) => {
          const target = b.handle ? `$${b.handle}` : (b.address ?? '');
          return (
            <li key={target} className="flex items-center justify-between text-sm text-white">
              <span className={ELLIPSIS}>{target}</span>
              <button
                onClick={() => act(() => client.unban(ticker, target))}
                disabled={busy}
                className="text-xs underline"
                style={{ color: GOLD }}
              >
                Unban
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[#F97066] mt-2">{error}</p>
          <ErrorActions message={String(error)} />
        </div>
      )}
    </Sheet>
  );
};

// ───────────────────────────── Bounties ─────────────────────────────

/** Count of my bounties that turned merged / paid since I last opened the Bounties sheet. */
const useBountyBadge = (client: BchatClient, ticker: string, me: string) => {
  const [count, setCount] = useState(0);
  const check = useCallback(() => {
    client
      .bounties(ticker)
      .then((d) => setCount(unseenForMe(ticker, parseBounties(d), me, loadSeen()).length))
      .catch(() => undefined);
  }, [client, ticker, me]);
  useEffect(() => {
    check();
    window.addEventListener('bwallet:bounties-seen', check);
    return () => window.removeEventListener('bwallet:bounties-seen', check);
  }, [check]);
  usePoll(check, LIST_POLL_MS, true);
  return count;
};

const STATUS_COLOR: Record<string, string> = {
  open: '#32D583',
  claimed: 'var(--bw-accent-hi)',
  merged: '#53B1FD',
  paid: '#8a8f98',
};

/**
 * Bounties sheet: open / claimed / merged / paid, with reward. Claim = paste the PR URL. Pay
 * (room admin / treasury holder) = fetch the server's transfer spec, confirm here, and the wallet
 * sends it with its normal approval; the txid is posted back and the bounty becomes paid.
 */
const BountiesSheet = ({
  client,
  room,
  entry,
  me,
  onClose,
}: {
  client: BchatClient;
  room: ChatRoom;
  entry: TokenRoomEntry | null;
  me: string;
  onClose: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [bounties, setBounties] = useState<Bounty[] | null>(null);
  const [error, setError] = useState('');
  const [claiming, setClaiming] = useState<Bounty | null>(null);
  const [prUrl, setPrUrl] = useState('');
  const [agent, setAgent] = useState('');
  const [paying, setPaying] = useState<PayoutSpec | null>(null);
  const [busy, setBusy] = useState('');
  const token = entry && entry.key.startsWith('bsv21:') ? { symbol: entry.gate.symbol, dec: entry.gate.dec } : null;
  const isAdmin = String((room as { created_by_handle?: unknown }).created_by_handle ?? '') === me;

  const load = useCallback(async () => {
    try {
      const list = sortBounties(parseBounties(await client.bounties(room.ticker)));
      setBounties(list);
      saveSeen(markSeen(room.ticker, list, loadSeen()));
      window.dispatchEvent(new Event('bwallet:bounties-seen'));
    } catch (e) {
      setError(errText(e));
      setBounties([]);
    }
  }, [client, room.ticker]);
  useEffect(() => {
    load();
  }, [load]);

  const claim = async () => {
    if (!claiming) return;
    const why = claimCheck(claiming, me, prUrl);
    if (why) return setError(why);
    setBusy('Claiming…');
    setError('');
    try {
      await client.claimBounty(room.ticker, claiming.bounty_no, prUrl, agent);
      addSnackbar(`Claimed #${claiming.bounty_no}`, 'success');
      setClaiming(null);
      setPrUrl('');
      setAgent('');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const startPay = async (b: Bounty) => {
    setBusy('Preparing…');
    setError('');
    try {
      const spec = parseSpec(await client.bountyPayoutSpec(room.ticker, b.bounty_no));
      if (!spec) throw new Error('The server returned no payable transfer');
      setPaying(spec);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const pay = async () => {
    if (!paying) return;
    setBusy('Sending…');
    setError('');
    let confirmed = false;
    let lastTxid = '';
    try {
      for (const t of paying.transfers) {
        const res =
          t.type === 'bsv21'
            ? await guardedSendBsv21.execute(apiContext, {
                tokenId: t.tokenId,
                recipients: [{ amount: BigInt(t.amountRaw), destination: { address: t.address } }],
              })
            : await sendBsv.execute(apiContext, { requests: [{ address: t.address, satoshis: t.sats }] });
        if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
        lastTxid = res.txid;
        // Record the FIRST broadcast at once, so a failure on a later leg can never lead to paying twice.
        if (!confirmed) {
          await client.confirmBountyPayout(room.ticker, paying.bountyNo, res.txid);
          confirmed = true;
        }
      }
      const shown = celebrateSend(lastTxid, {
        amount: { kind: 'token', display: paying.transfers.map(transferLabel).join(' + '), ticker: '' },
        recipients: [`$${paying.claimant}`],
        title: 'Paid!',
      });
      if (!shown) addSnackbar(`Paid #${paying.bountyNo} to $${paying.claimant}`, 'success');
      setPaying(null);
      await load();
    } catch (e) {
      setError(confirmed ? `Recorded as paid, but a later transfer failed: ${errText(e)}` : errText(e));
      if (confirmed) await load();
    } finally {
      setBusy('');
    }
  };

  if (paying) {
    return (
      <Sheet title={`Pay bounty #${paying.bountyNo}`} onClose={onClose}>
        <div className="rounded-2xl p-4 text-sm" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
          {paying.transfers.map((t, i) => (
            <div key={i} className="flex justify-between mt-1">
              <span style={{ color: MUTED }}>Send</span>
              <span className="text-white font-semibold">{transferLabel(t)}</span>
            </div>
          ))}
          <div className="flex justify-between mt-2">
            <span style={{ color: MUTED }}>To</span>
            <span className="text-white font-semibold">${paying.claimant}</span>
          </div>
          <div className="text-[11px] mt-2 break-all" style={{ color: MUTED }}>
            {paying.transfers[0].address}
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => setPaying(null)}
            disabled={!!busy}
            className="flex-1 rounded-2xl py-3 font-bold text-white"
            style={{ background: PANEL }}
          >
            Back
          </button>
          <button
            onClick={pay}
            disabled={!!busy}
            className="flex-1 rounded-2xl py-3 font-bold disabled:opacity-50"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy || 'Pay'}
          </button>
        </div>
        {error && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-[#F97066] mt-2">{error}</p>
            <ErrorActions message={String(error)} />
          </div>
        )}
      </Sheet>
    );
  }

  if (claiming) {
    return (
      <Sheet title={`Claim #${claiming.bounty_no}`} onClose={onClose}>
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          {claiming.title} — {rewardLabel(claiming, token)}. Paid to your proven receive address when the PR merges.
        </p>
        <input
          autoFocus
          value={prUrl}
          onChange={(e) => setPrUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/pull/123"
          autoCapitalize="none"
          autoCorrect="off"
          className="w-full rounded-2xl px-3 py-3 bg-transparent text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        />
        <input
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          placeholder="Agent (optional, e.g. claude)"
          autoCapitalize="none"
          className="w-full mt-2 rounded-2xl px-3 py-3 bg-transparent text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => setClaiming(null)}
            disabled={!!busy}
            className="flex-1 rounded-2xl py-3 font-bold text-white"
            style={{ background: PANEL }}
          >
            Back
          </button>
          <button
            onClick={claim}
            disabled={!!busy || !prUrl.trim()}
            className="flex-1 rounded-2xl py-3 font-bold disabled:opacity-50"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy || 'Claim'}
          </button>
        </div>
        {error && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-[#F97066] mt-2">{error}</p>
            <ErrorActions message={String(error)} />
          </div>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet title="Bounties" onClose={onClose}>
      <div className="max-h-[60vh] overflow-y-auto flex flex-col gap-2">
        {bounties === null && (
          <p className="text-xs" style={{ color: MUTED }}>
            Loading…
          </p>
        )}
        {bounties?.length === 0 && !error && (
          <p className="text-xs" style={{ color: MUTED }}>
            No bounties in this room yet.
          </p>
        )}
        {bounties?.map((b) => (
          <div key={b.bounty_no} className="rounded-2xl p-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase" style={{ color: STATUS_COLOR[b.status] ?? MUTED }}>
                {b.status}
              </span>
              <span className={`flex-1 text-sm text-white ${ELLIPSIS}`}>
                #{b.bounty_no} {b.title}
              </span>
            </div>
            <div className="text-xs mt-1" style={{ color: GOLD }}>
              {rewardLabel(b, token)}
            </div>
            {b.claimed_by && (
              <div className="text-[11px] mt-1" style={{ color: MUTED }}>
                ${b.claimed_by}
                {b.agent_label ? ` via ${b.agent_label}` : ''}
                {b.github_pr_url ? ` · ${b.github_pr_url.replace('https://github.com/', '')}` : ''}
              </div>
            )}
            {b.status === 'open' && b.created_by !== me && (
              <button
                onClick={() => {
                  setError('');
                  setClaiming(b);
                }}
                className="mt-2 w-full rounded-xl py-2 text-sm font-bold"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                Claim with PR
              </button>
            )}
            {showPay(b, me, isAdmin) && (
              <button
                onClick={() => startPay(b)}
                disabled={!!busy}
                className="mt-2 w-full rounded-xl py-2 text-sm font-bold disabled:opacity-50"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                {busy || 'Pay'}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[#F97066] mt-2">{error}</p>
          <ErrorActions message={String(error)} />
        </div>
      )}
    </Sheet>
  );
};

/** "$BOASE ✓" for a verified personal token, else the room name / "$SYM". */
const entryTitle = (entry: TokenRoomEntry | null, room: ChatRoom | null): string | null => {
  if (room && isLounge(room.ticker)) return HELP_DESK_NAME;
  if (!entry) return room?.name || null;
  if (entry.key.startsWith('coll:')) return room?.name || entry.gate.symbol;
  const label = tickerLabel(entry.gate.symbol, entry.holding.id, knownPersonal());
  return label.endsWith('✓') ? label : room?.name || label;
};

// ───────────────────────────── Token rooms list ─────────────────────────────

const LOOKUP_TTL_MS = 5 * 60_000;

const ListLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="px-4 pt-4 pb-1 text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
    {children}
  </div>
);

/** A joined open room (no token) in "Your rooms". */
const OpenRoomRow = ({
  room,
  me,
  onOpen,
  commands,
}: {
  room: ChatRoom;
  me: string;
  onOpen: () => void;
  commands: RowCommands;
}) => {
  const info = openInfo(room);
  const unread = room.unread ?? 0;
  const title = isLounge(room.ticker) ? HELP_DESK_NAME : room.name || `$${room.ticker}`;
  const key = roomKeyOf(room.ticker);
  const muted = isMuted(commands.prefs, key);
  // A connected game's room shows the game's logo when it has no picture of its own (chat/roomLook.ts).
  const look = useRoomLook(room.ticker, !STORE_BUILD && !isLounge(room.ticker) && !info?.official, room.metadata);
  return (
    <li>
      <ChatSwipeRow
        row={{ key, ticker: room.ticker, title, at: roomActivity(room), unread }}
        commands={commands}
        canLeave={!info?.official && !isLounge(room.ticker)}
      >
        <button
          onClick={onOpen}
          className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]"
          style={{ background: BG }}
        >
          <Avatar title={title} src={roomIcon(room)} fallback={look?.logoData} />
          <div className="flex-1 min-w-0 pb-[10px] -mb-[10px]" style={{ borderBottom: `1px solid ${LINE}` }}>
            <div className="flex items-baseline gap-2">
              <span className={`flex-1 flex items-center gap-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>
                <span className={ELLIPSIS}>{title}</span>
                {info?.official && <ShieldCheck size={14} color={GOLD} className="shrink-0" />}
                {info?.visibility === 'invite' && <Lock size={12} color={MUTED} className="shrink-0" />}
                <MutedMark muted={muted} />
              </span>
              <span className="text-[11px] shrink-0" style={{ color: unread && !muted ? GOLD : MUTED }}>
                {listTimeLabel(room.last_message?.created_at ?? room.updated_at)}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-[2px] min-h-5">
              <span className={`flex-1 text-[13px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                {info?.closed ? 'Closed' : previewText(room, me)}
              </span>
              <RowBadge
                unread={unread}
                marked={isMarked(commands.prefs, key)}
                muted={muted}
                pinned={isPinned(commands.prefs, key)}
              />
            </div>
          </div>
        </button>
      </ChatSwipeRow>
    </li>
  );
};

/**
 * One of the user's own tokens whose room isn't set up yet (incl. the personal $NAME token): shown in
 * "Your rooms" as not open, with the shared paid setup (tokens/useRoomSetup). Hidden once open or
 * paid, and while the indexer doesn't answer. Not rendered in a store build (ROOMS).
 */
const SetupRoomRow = ({ token, onDone }: { token: OwnToken; onDone: () => void }) => {
  const s = useRoomSetup(token.tokenId, token.ticker, { onDone });
  if (!s.total || (!s.needs && !s.msg)) return null;
  const title = `$${token.ticker}`;
  return (
    <li className="flex items-center gap-3 px-4 py-[10px]">
      <Avatar title={title} roomKey={`bsv21:${token.tokenId}`} />
      <div className="flex-1 min-w-0">
        <div className={`flex items-center gap-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>
          <span className={ELLIPSIS}>{title}</span>
          <Lock size={12} color={MUTED} className="shrink-0" />
        </div>
        <div className="text-[13px] line-clamp-2" style={{ color: MUTED }}>
          {s.msg || 'Not open yet. Setting up lists it in other wallets and the Market and opens this room.'}
        </div>
        {s.needs && s.freeNote && (
          <div className="text-[12px] font-semibold" style={{ color: GOLD }}>
            {s.freeNote}
          </div>
        )}
      </div>
      {s.needs && (
        <button
          onClick={s.start}
          disabled={s.busy}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold disabled:opacity-40"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          {setupLabel(s.total.totalSats, s.rate, 'Set up your room')}
        </button>
      )}
      {s.sheet}
    </li>
  );
};

/**
 * Chat › Chatrooms: "Your rooms" (joined open + token rooms), "Public rooms" (open rooms anyone
 * can join, docs/TOKEN-ROOMS.md › Open rooms), "+ New room", and Token rooms (full build only).
 * `header` is the Chat tab's Chatrooms | DMs | Calls switch.
 */
const RoomsPage = ({ header }: { header: React.ReactNode }) => {
  const myName = useChatDisplayName();
  const { apiContext } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const online = useOnline();
  const client = useMemo(() => sharedChatClient(), []);
  const [handle, setHandle] = useState<string | null>(client.handle);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState('');

  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [lookups, setLookups] = useState<Record<string, TokenRoomLookup>>({});
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  // Chat filters (bWalletX only): Rooms | Spaces | bApps, remembered per device (spaces/SpacesFilter.tsx).
  const [roomFilter, setRoomFilterState] = useState<RoomFilter>(loadRoomFilter);
  const setRoomFilter = (f: RoomFilter) => {
    setRoomFilterState(f);
    saveRoomFilter(f);
  };
  // /chat/bapps (Desktop, web, phone deep link) opens straight on the bApps filter.
  const chatLocation = useLocation();
  const bappsRoute = /\/chat\/bapps\/?$/.test(chatLocation.pathname);
  // /chat/bapps?room=BRADIO (the Desktop sidebar's bApp entries): open that bApp's room once it's known to be mine.
  const bappRoomParam = bappsRoute ? (new URLSearchParams(chatLocation.search).get('room') ?? '') : '';
  useEffect(() => {
    if (bappsRoute && BSPACES_ENABLED) setRoomFilterState('bapps');
  }, [bappsRoute]);
  const [open, setOpen] = useState<{ room: ChatRoom; entry: TokenRoomEntry | null; joinSpace?: boolean } | null>(null);
  const [locked, setLocked] = useState<{ gate: TokenGate; heldRaw: string | null; members: number | null } | null>(
    null,
  );
  const [inviting, setInviting] = useState(false);
  // Room X invites: shown only once bit-sign answers that this user manages the open room.
  const [xManage, setXManage] = useState<string | null>(null);
  const [xInvites, setXInvites] = useState(false);
  const [xClaim, setXClaim] = useState<XInviteLink | null>(() => (XINVITES_ENABLED ? takeXInvite() : null));
  useEffect(() => (XINVITES_ENABLED ? onXInvite(() => setXClaim(takeXInvite())) : undefined), []);
  const xTicker = XINVITES_ENABLED && handle && open?.entry?.key.startsWith('bsv21:') ? open.room.ticker : null;
  useEffect(() => {
    setXManage(null);
    if (!xTicker) return;
    let live = true;
    // GET the host list: 200 = this user manages the room; 403 / 404 (not deployed yet) = hide the entry.
    void new InvitesApi((m, p, b, a) => client.request(m, p, b, a))
      .list(xTicker)
      .then((r) => {
        if (!live || r === null) return;
        setXManage(xTicker);
        // Friends › "Invite the rest" queued handles for this room: open Invites on its confirm.
        if (hasInvitePrefill()) setXInvites(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, xTicker]);
  const [banning, setBanning] = useState(false);
  // Token room settings / rules: only the token's issuer can change them (RoomSettingsSheet).
  const [roomSettings, setRoomSettings] = useState(false);
  const [showBounties, setShowBounties] = useState(false);
  const [opening, setOpening] = useState('');
  // A just-minted token the indexer hasn't reached yet: a neutral wait that retries (chat/roomIndexing.ts).
  const [indexing, setIndexing] = useState<{ entry: TokenRoomEntry; since: number; tries: number } | null>(null);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  // Open rooms (no token): every build, store build included.
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [newRoom, setNewRoom] = useState(false);
  const [newSpace, setNewSpace] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [msgMenu, setMsgMenu] = useState<ChatMessage | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const openTicker = open && isOpenRoom(open.room) ? open.room.ticker : null;
  const { card, reload: reloadCard } = useRoomCard(client, openTicker);
  const { chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  // Cache first (owner round 6): the last room list shows at once; the live list replaces it quietly.
  const [rooms, setRooms] = useState<ChatRoom[] | null>(() => readListCache<ChatRoom>(roomsCacheKey(identityAddress)));
  /**
   * The open room's full server metadata. A room opened right after joining or starting it is a stub with no
   * metadata.site / metadata.look, so its look never showed (owner, 25 Oct 2026: $TERRORNODE plain on a new account).
   * Take the list's row for it, else ask the server once.
   */
  const [fetchedMeta, setFetchedMeta] = useState<{ ticker: string; metadata: Record<string, unknown> } | null>(null);
  const stubTicker =
    open && !(open.room.metadata as { site?: unknown } | null | undefined)?.site ? open.room.ticker : null;
  const listedMeta = stubTicker
    ? ((rooms ?? []).find((r) => r.ticker.toUpperCase() === stubTicker.toUpperCase())?.metadata ?? null)
    : null;
  const listedHasSite = !!(listedMeta as { site?: unknown } | null)?.site;
  useEffect(() => {
    if (!stubTicker || listedHasSite || STORE_BUILD) return;
    let live = true;
    void client.roomMetadata(stubTicker).then((m) => {
      if (live && m) setFetchedMeta({ ticker: stubTicker, metadata: m });
    });
    return () => {
      live = false;
    };
  }, [client, stubTicker, listedHasSite]);
  const openRoomView: ChatRoom | null = !open
    ? null
    : !stubTicker
      ? open.room
      : listedHasSite
        ? { ...open.room, metadata: { ...(open.room.metadata ?? {}), ...(listedMeta ?? {}) } }
        : fetchedMeta && fetchedMeta.ticker === stubTicker
          ? { ...open.room, metadata: { ...(open.room.metadata ?? {}), ...fetchedMeta.metadata } }
          : open.room;
  // Either segment's rooms() fetch updates this list too (chat/sharedRooms.ts).
  useEffect(() => onRooms(setRooms), []);
  // Chat tab badge: this list's unread counts (a room opened or marked read clears at once).
  useEffect(() => {
    if (rooms) mergeChatRooms(rooms);
  }, [rooms]);
  // My X / Google picture (names/socialAvatar.ts) goes to bit-sign once, so other people's bubbles show it
  // instead of my initial; bit-sign keeps a photo chosen there. Remembered per handle + picture.
  const socialAvatar = chromeStorageService.getCurrentAccountObject().account?.settings?.socialProfile?.avatar ?? '';
  useEffect(() => {
    if (!handle || !/^https:\/\//.test(socialAvatar)) return;
    rememberAvatar(handle, socialAvatar);
    const key = `bwallet.chatAvatarPublished.${handle}`;
    try {
      if (localStorage.getItem(key) === socialAvatar) return;
    } catch {
      /* no storage */
    }
    // Not needed for the first paint (chat snappy): after it.
    return afterPaint(() =>
      client
        .publishAvatar(socialAvatar)
        .then(() => {
          try {
            localStorage.setItem(key, socialAvatar);
          } catch {
            /* no storage */
          }
        })
        .catch(() => undefined),
    );
  }, [client, handle, socialAvatar]);
  useEffect(warmThreadCache, []);
  const autoTried = useRef(false);
  const proved = useRef<Set<string>>(new Set());
  const lookedAt = useRef<Map<string, number>>(new Map());

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setAuthError('');
    try {
      const s = await client.signIn(walletSigner(apiContext));
      logInWalletApp('bitcoinchat.online', 'signIn');
      saveSession(s);
      setHandle(s.handle);
    } catch (e) {
      // A wallet bChat hasn't seen and no handle chosen yet: open Choose your handle right here.
      const need = needsHandle(e);
      if (need) setHandleClaim(need);
      else setAuthError(errText(e));
    } finally {
      setSigningIn(false);
    }
  }, [client, apiContext]);
  const [handleClaim, setHandleClaim] = useState<{ claimToken: string; address: string } | null>(null);
  // After the handle is chosen, finish the sign-in with bit-sign's claim token (falls back to a fresh
  // sign-in, which now finds the chosen name, if the token has expired).
  const finishClaim = useCallback(
    async (paymail: string) => {
      if (!handleClaim) return;
      const name = paymail.split('@')[0];
      const s = await client
        .claimHandle(handleClaim.claimToken, name, handleClaim.address)
        .catch(() => client.signIn(walletSigner(apiContext)));
      saveSession(s);
      setHandle(s.handle);
      setHandleClaim(null);
    },
    [client, apiContext, handleClaim],
  );

  // Tapping the Chat tab inside a room goes back to the room list.
  useEffect(() => {
    const onTap = (e: Event) => {
      if ((e as CustomEvent).detail === 'chat') setOpen(null);
    };
    window.addEventListener(TAB_TAP, onTap);
    return () => window.removeEventListener(TAB_TAP, onTap);
  }, []);

  const authLost = useCallback(() => {
    client.signOut();
    saveSession(null);
    setHandle(null);
    setOpen(null);
    setRooms(null);
  }, [client]);

  // Settings › Sign out of chat clears the stored session while this tab stays mounted: drop the
  // in-memory one too, or chat keeps using the old token and never signs in again.
  useEffect(() => {
    const onSession = () => {
      if (client.current && !loadSession()) {
        client.signOut();
        setHandle(null);
        setOpen(null);
        setRooms(null);
        autoTried.current = false;
      }
    };
    window.addEventListener(SESSION_EVENT, onSession);
    return () => window.removeEventListener(SESSION_EVENT, onSession);
  }, [client]);

  useEffect(() => {
    const saved = client.current;
    if (!saved) return;
    walletSigner(apiContext)
      .address()
      .then((a) => a !== saved.address && authLost())
      .catch(() => {});
  }, [client, apiContext, authLost]);

  useEffect(() => {
    if (handle || autoTried.current || !online) return;
    autoTried.current = true;
    void signIn();
  }, [handle, online, signIn]);

  /** Prove this wallet's token keys to bChat (once per key per visit; signatures only). */
  const prove = useCallback(
    async (key?: string) => {
      const tag = key ?? '*';
      if (proved.current.has(tag)) return;
      proved.current.add(tag);
      await proveHoldings(apiContext, client, key).catch(() => proved.current.delete(tag));
    },
    [apiContext, client],
  );

  // Once signed in: link the wallet's keys so bChat can see what it holds.
  useEffect(() => {
    if (handle) void prove();
  }, [handle, prove]);

  // Invite lists (local, per handle) and a personal room still waiting for the indexer.
  useEffect(() => {
    if (!handle) return;
    setIgnored(loadInviteList(handle, 'ignored'));
    setAccepted(loadInviteList(handle, 'accepted'));
    return afterPaint(() => {
      void syncBlocks(client);
      if (identityAddress) void retryPersonalRoom(apiContext, identityAddress, client).then((t) => t && refresh());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, identityAddress]);

  /** `force` skips the shared rooms() reuse window (leaving a room, Try again). */
  const refresh = useCallback(
    (force?: unknown) => {
      if (!handle || !online) return;
      void walletHoldings(apiContext)
        .then((h) => {
          setHoldings(h);
          writeListCache(`chat:holdings:${identityAddress}`, h, 200);
        })
        .catch(() => setHoldings([]));
      client
        .openRooms()
        .then((d) => setPublicRooms(parsePublicRooms(d)))
        .catch(() => {});
      fetchRooms(client, identityAddress, force === true ? 0 : undefined)
        .then(() => setListError(''))
        .catch((e) => {
          if (e instanceof ChatApiError && e.status === 401) return authLost();
          setListError(errText(e));
        });
    },
    [client, apiContext, handle, online, authLost, identityAddress],
  );

  useEffect(refresh, [refresh]);
  const listHidden = useInPeek();
  // Any room change re-reads the list (fetchRooms is shared and coalesced); 5 min poll while live.
  // Only the rooms list on a live event (not holdings / open rooms, which the poll still covers).
  const listMs = useLive(
    () => {
      if (handle && online) void fetchRooms(client, identityAddress, 0).catch(() => undefined);
    },
    LIST_POLL_MS,
    {
      liveMs: LIST_LIVE_MS,
      types: LIST_TYPES,
      enabled: !!handle && !open && !listHidden,
    },
  );
  usePoll(refresh, listMs, !!handle && !open && !listHidden);

  // Rooms you hold the token for but are not in yet: ask bChat whether they exist.
  useEffect(() => {
    if (!handle || !holdings || !rooms) return;
    const mine = new Set(
      buildTokenRoomList(holdings, rooms)
        .filter((e) => e.status === 'member')
        .map((e) => e.key),
    );
    const now = Date.now();
    const todo = holdings
      .map((h) => `${h.kind}:${h.id}`)
      .filter((k) => !mine.has(k) && now - (lookedAt.current.get(k) ?? 0) > LOOKUP_TTL_MS)
      .slice(0, 20);
    if (!todo.length) return;
    return afterPaint(() => {
      todo.forEach((k) => lookedAt.current.set(k, now));
      void Promise.all(
        todo.map((k) =>
          client
            .tokenRoom(k)
            .then((d) => parseLookup(d))
            .catch(() => null),
        ),
      ).then((found) => {
        const ok = found.filter((l): l is TokenRoomLookup => !!l);
        ok.forEach(
          (l) => l.personal?.tokenId && rememberPersonal({ name: l.personal.name, tokenId: l.personal.tokenId }),
        );
        const add = Object.fromEntries(ok.map((l) => [l.key, l]));
        if (Object.keys(add).length) setLookups((cur) => ({ ...cur, ...add }));
      });
    });
  }, [client, handle, holdings, rooms]);

  // Cold open: token rows render from the cached holdings, or from the cached rooms themselves,
  // before the wallet's holdings arrive (no rows popping in later).
  const cachedHoldings = useMemo(() => readListCache<Holding>(`chat:holdings:${identityAddress}`), [identityAddress]);
  const listHoldings = useMemo(
    () => holdings ?? cachedHoldings ?? (rooms ? holdingsFromRooms(rooms) : null),
    [holdings, cachedHoldings, rooms],
  );
  const entries = useMemo(
    () => (listHoldings && rooms ? buildTokenRoomList(listHoldings, rooms, lookups) : null),
    [listHoldings, rooms, lookups],
  );
  const personalOf = useCallback(
    (e: TokenRoomEntry) => (e.room ? personalOfRoom(e.room) : null) ?? lookups[e.key]?.personal ?? null,
    [lookups],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    return (entries ?? [])
      .map((e) => ({ e, invite: inviteState(e, personalOf(e), handle || '', { ignored, accepted }) }))
      .filter(({ invite }) => invite !== 'hidden')
      .filter(
        ({ e }) => !q || e.gate.symbol.toLowerCase().includes(q) || (e.room?.name ?? '').toLowerCase().includes(q),
      );
  }, [entries, query, personalOf, handle, ignored, accepted]);

  const ignoreInvite = (key: string) => handle && setIgnored(addToInviteList(handle, 'ignored', key));
  const acceptInvite = (e: TokenRoomEntry) => {
    if (handle) setAccepted(addToInviteList(handle, 'accepted', e.key));
    void openEntry(e);
  };

  const q = query.trim().toLowerCase().replace(/^\$/, '');
  // Open rooms that also carry a token gate (chat/roomGate.ts): bit-sign's count of what I hold, per gate key.
  // A room I don't qualify for leaves "Your rooms" and shows only as a locked card under Public rooms.
  const [gateHeld, setGateHeld] = useState<Record<string, string | null>>({});
  // bit-sign's issuer answer per gate key: the creator / claimed issuer always gets in (chat/roomGate.ts).
  const [gateLook, setGateLook] = useState<Record<string, TokenRoomLookup | null>>({});
  useEffect(() => {
    const keys = [
      ...new Set((rooms ?? []).map((r) => roomTokenGate(r.metadata)?.key).filter((k): k is string => !!k)),
    ].filter((k) => !(k in gateHeld));
    if (!handle || !keys.length) return;
    let live = true;
    void Promise.all(
      keys.map(async (k) => [k, parseLookup(await client.tokenRoom(k).catch(() => null))] as const),
    ).then((r) => {
      if (!live) return;
      setGateLook((cur) => ({ ...cur, ...Object.fromEntries(r) }));
      setGateHeld((cur) => ({ ...cur, ...Object.fromEntries(r.map(([k, l]) => [k, l?.heldRaw ?? null])) }));
    });
    return () => {
      live = false;
    };
  }, [rooms, handle, client]); // eslint-disable-line react-hooks/exhaustive-deps
  const gateLacking = useCallback(
    (r: ChatRoom) => {
      const k = roomTokenGate(r.metadata)?.key;
      return !!k && !!lockedForMe(r, handle, gateHeld[k], gateLook[k]);
    },
    [gateHeld, gateLook, handle],
  );
  const myOpen = useMemo(
    () =>
      (rooms ?? [])
        .filter(isOpenRoom)
        .filter((r) => !gateLacking(r))
        .filter((r) => !q || `${r.name ?? ''} ${r.ticker}`.toLowerCase().includes(q)),
    [rooms, q, gateLacking],
  );
  const lockedOpen = useMemo(
    () =>
      (rooms ?? [])
        .filter(isOpenRoom)
        .filter(gateLacking)
        .filter((r) => !q || `${r.name ?? ''} ${r.ticker}`.toLowerCase().includes(q)),
    [rooms, q, gateLacking],
  );
  const browse = useMemo(
    () => browseList(publicRooms, new Set((rooms ?? []).map((r) => r.ticker.toUpperCase())), query),
    [publicRooms, rooms, query],
  );
  const tokenMine = shown.filter(({ e }) => e.status === 'member');
  const tokenOther = shown.filter(({ e }) => e.status !== 'member');
  // Telegram-style list (chat/listPrefs.ts): pinned first, then newest activity; archived in one group.
  const [prefs, updatePrefs] = useListPrefs(handle);
  const helpDeskPinned = useHelpDeskPinned();
  // Pinning the unpinned Help Desk row brings back its card (and drops the ordinary pin).
  useEffect(() => {
    const k = roomKeyOf(LOUNGE_TICKER);
    if (helpDeskPinned || !isPinned(prefs, k)) return;
    updatePrefs((p) => setPrefPinned(p, k, false));
    setHelpDeskUnpinned(false);
  }, [helpDeskPinned, prefs, updatePrefs]);
  const arranged = useMemo(() => {
    const roomOf = (x: { kind: 'open'; room: ChatRoom } | { kind: 'token'; item: (typeof shown)[number] }) =>
      x.kind === 'open' ? x.room : x.item.e.room;
    const list: ({ kind: 'open'; room: ChatRoom } | { kind: 'token'; item: (typeof shown)[number] })[] = [
      ...[...myOpen].sort(byActivity).map((room) => ({ kind: 'open' as const, room })),
      ...(ROOMS ? tokenMine.map((item) => ({ kind: 'token' as const, item })) : []),
    ];
    // The bWallet Help Desk is the yellow card above this list (LoungeCard) while pinned, so it isn't a row
    // here. Unpinned on this device, it's an ordinary row (helpDeskPin.ts).
    return arrange(
      helpDeskPinned ? list.filter((x) => !(x.kind === 'open' && isLounge(x.room.ticker))) : list,
      prefs,
      (x) => roomKeyOf(roomOf(x)?.ticker ?? (x.kind === 'token' ? x.item.e.key : '')),
      (x) => {
        const r = roomOf(x);
        return r ? roomActivity(r) : 0;
      },
    );
  }, [myOpen, tokenMine, prefs, helpDeskPinned]);
  // Rooms hides bApp rooms; bApps shows only them. The store build has no chips, so nothing is filtered there.
  const bappsView = BSPACES_ENABLED && roomFilter === 'bapps';
  const keepTicker = (t: string | null | undefined) => !BSPACES_ENABLED || isBappRoom(t) === bappsView;
  const keepYour = (y: (typeof arranged.main)[number]) =>
    keepTicker(y.kind === 'open' ? y.room.ticker : (y.item.e.room?.ticker ?? y.item.e.gate.symbol));
  const yours = arranged.main.filter(keepYour);
  const archivedShown = arranged.archived.filter(keepYour);
  const browseShown = browse.filter((r) => keepTicker(r.ticker));
  const tokenOtherShown = tokenOther.filter(({ e }) => keepTicker(e.room?.ticker ?? e.gate.symbol));
  // A new message brings an archived (not muted) or deleted chat back: record that.
  useEffect(() => {
    if (arranged.unarchive.length || arranged.unhide.length) updatePrefs((p) => settle(p, arranged));
  }, [arranged, updatePrefs]);
  // Opening a chat clears a hand-set "unread" mark.
  const openTickerKey = open ? roomKeyOf(open.room.ticker) : null;
  useEffect(() => {
    if (openTickerKey) updatePrefs((p) => (isMarked(p, openTickerKey) ? setMarked(p, openTickerKey, false) : p));
  }, [openTickerKey, updatePrefs]);
  const rowCommands: RowCommands = {
    prefs,
    update: updatePrefs,
    markRead: (key) => {
      const r = (rooms ?? []).find((x) => roomKeyOf(x.ticker) === key);
      if (!r) return;
      setRooms((cur) => cur?.map((x) => (x.ticker === r.ticker ? { ...x, unread: 0 } : x)) ?? cur);
      void client.markRead(r.ticker).catch(() => {});
    },
    leave: async (key) => {
      const r = (rooms ?? []).find((x) => roomKeyOf(x.ticker) === key);
      if (!r) return;
      await client.openRoomAction(r.ticker, 'leave');
      refresh(true);
    },
  };
  const wrapRow = (row: ChatRowInfo | null, face: React.ReactNode) =>
    row ? (
      <ChatSwipeRow row={row} commands={rowCommands}>
        {face}
      </ChatSwipeRow>
    ) : (
      face
    );
  const renderYour = (y: (typeof yours)[number]) =>
    y.kind === 'open' ? (
      <OpenRoomRow
        key={y.room.ticker}
        room={y.room}
        me={handle ?? ''}
        onOpen={() => openOpenRoom(y.room)}
        commands={rowCommands}
      />
    ) : (
      renderTokenRow(y.item)
    );

  // Keep the order stable while the list is being scrolled; apply the fresh order once it stops.
  const [scrolling, setScrolling] = useState(false);
  const scrollIdle = useRef<number | null>(null);
  const onListScroll = () => {
    if (!scrolling) setScrolling(true);
    if (scrollIdle.current) window.clearTimeout(scrollIdle.current);
    scrollIdle.current = window.setTimeout(() => setScrolling(false), 250);
  };
  const shownKeys = useRef<string[]>([]);
  const yourKey = (x: (typeof yours)[number]) => (x.kind === 'open' ? `o:${x.room.ticker}` : `t:${x.item.e.key}`);
  const yoursShown = scrolling ? stableOrder(shownKeys.current, yours, yourKey) : yours;
  shownKeys.current = yoursShown.map(yourKey);

  const openOpenRoom = (room: ChatRoom, joinSpace = false) => {
    // A token-gated room I don't qualify for never opens: show its lock with the real terms instead.
    const k = roomTokenGate(room.metadata)?.key ?? '';
    const gate = lockedForMe(room, handle, gateHeld[k], gateLook[k]);
    if (gate) {
      setLocked({ gate, heldRaw: gateHeld[gate.key] ?? null, members: room.party_count ?? null });
      return;
    }
    setRooms((cur) => cur?.map((r) => (r.ticker === room.ticker ? { ...r, unread: 0 } : r)) ?? cur);
    setHidden(new Set());
    setOpen({ room, entry: null, joinSpace });
  };
  /** The pinned Help Desk card: open (or first join) the Help Desk, optionally straight into its Space. */
  const openLounge = async (joinSpace: boolean) => {
    const mine = (rooms ?? []).find((r) => isLounge(r.ticker));
    if (mine) return openOpenRoom(mine, joinSpace);
    try {
      await client.joinOpenRoom({ ticker: LOUNGE_TICKER });
      openOpenRoom(
        stubRoom(LOUNGE_TICKER, HELP_DESK_NAME, {
          metadata: { kind: 'open', open: { visibility: 'public', official: true } },
        }),
        joinSpace,
      );
      refresh();
    } catch (e) {
      if (e instanceof ChatApiError && e.status === 401) return authLost();
      setListError(errText(e));
    }
  };
  const stubRoom = (ticker: string, name: string, extra: Partial<ChatRoom> = {}): ChatRoom => ({
    id: ticker,
    ticker,
    name,
    party_count: 1,
    metadata: { kind: 'open', open: {} },
    ...extra,
  });
  const joinPublic = async (r: PublicRoom) => {
    setOpening(r.ticker);
    try {
      await client.joinOpenRoom({ ticker: r.ticker });
      openOpenRoom(
        stubRoom(r.ticker, r.name, {
          party_count: r.memberCount + 1,
          metadata: { kind: 'open', open: { visibility: 'public', description: r.description, official: r.official } },
        }),
      );
      refresh();
    } catch (e) {
      if (e instanceof ChatApiError && e.status === 401) return authLost();
      setListError(errText(e));
    } finally {
      setOpening('');
    }
  };
  // bApp room cards (chat/BappRoomCards.tsx): open a room I'm in, or walk into a free one.
  const openBapp = (b: Bapp) => {
    const mine = (rooms ?? []).find((r) => r.ticker.toUpperCase() === b.ticker);
    openOpenRoom(mine ?? stubRoom(b.ticker, b.name, { metadata: { kind: 'open', open: { official: true } } }));
    if (!mine) refresh();
  };
  const joinFreeBapp = async (b: Bapp) => {
    await client.joinOpenRoom({ ticker: b.ticker });
    openBapp(b);
  };
  const bappMembers = useMemo(() => new Set((rooms ?? []).map((r) => r.ticker.toUpperCase())), [rooms]);
  const bappRoomOpened = useRef('');
  useEffect(() => {
    if (!bappRoomParam) bappRoomOpened.current = '';
    if (!BSPACES_ENABLED || !bappRoomParam || bappRoomOpened.current === bappRoomParam || rooms === null) return;
    const b = bappForTicker(bappRoomParam);
    // Not a member: stay on the list, where the room's card offers its ticket.
    if (!b || !bappMembers.has(b.ticker)) return;
    bappRoomOpened.current = bappRoomParam;
    openBapp(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openBapp is recreated each render; run on param/rooms only
  }, [bappRoomParam, rooms, bappMembers]);
  const bappsWide = typeof window !== 'undefined' && window.matchMedia?.('(min-width: 900px)').matches;
  const blockUser = (target: string) => void setBlocked(client, target, true);

  // "Set up your room": offered once when the issuer opens their own token room (chat/roomSetupPrompt.ts).
  const [roomSetupOffer, setRoomSetupOffer] = useState(false);
  const openRoomKey = open?.entry && !openTicker ? open.room.ticker : null;
  useEffect(() => {
    setRoomSetupOffer(!!openRoomKey && ROOMS && shouldOfferRoomSetup(openRoomKey, true));
  }, [openRoomKey]);
  const closeRoomSettings = useCallback(() => {
    setRoomSettings(false);
    setRoomSetupOffer(false);
  }, []);
  // List tickets for sale: the token's market page and its own Sell flow (no money code here).
  const sellTickets = (key: string) => {
    const ref = parseTokenKey(key);
    if (!ref) return;
    closeRoomSettings();
    requestMarketToken(ref);
    handleSelect(asMenuItem('market'));
  };

  const buy = (key: string) => {
    const ref = parseTokenKey(key);
    setLocked(null);
    if (!ref || !MARKET_ENABLED) return;
    requestMarketToken(ref);
    handleSelect(asMenuItem('market'));
  };

  const openEntry = useCallback(
    async (entry: TokenRoomEntry) => {
      if (!ROOMS) return setListError(STORE_ROOM_NOTE);
      setOpening(entry.key);
      try {
        await prove(entry.key);
        let room = entry.room;
        if (!room) {
          const ticker = await client.startTokenRoom(entry.key);
          room = { id: ticker, ticker, name: null, party_count: 1 };
        }
        setRooms((cur) => cur?.map((r) => (r.ticker === room!.ticker ? { ...r, unread: 0 } : r)) ?? cur);
        setIndexing(null);
        setOpen({ room, entry });
      } catch (e) {
        if (e instanceof ChatApiError && e.status === 401) return authLost();
        if (isNotYetIndexed(e, { ownToken: isOwnTokenKey(entry.key, listOwnTokens()) })) {
          // Not an error: the indexer hasn't caught up with this token yet. Wait and retry.
          proved.current.delete(entry.key);
          setListError('');
          setIndexing((cur) =>
            cur && cur.entry.key === entry.key
              ? { ...cur, tries: cur.tries + 1 }
              : { entry, since: Date.now(), tries: 1 },
          );
          return;
        }
        setIndexing(null);
        const refusal = e instanceof ChatApiError ? parseGateRefusal(e.data) : null;
        if (refusal)
          setLocked({ gate: refusal.gate, heldRaw: refusal.heldRaw, members: refusal.room?.members ?? null });
        else setListError(errText(e));
      } finally {
        setOpening('');
      }
    },
    [client, prove, authLost],
  );

  // Still indexing: retry every 5s for ~3 minutes, then every 30s while this screen is open.
  useEffect(() => {
    if (!indexing) return;
    const t = window.setTimeout(() => void openEntry(indexing.entry), indexingRetryDelay(Date.now() - indexing.since));
    return () => window.clearTimeout(t);
  }, [indexing, openEntry]);

  // "Open room" from a Wallet / Market token page.
  useEffect(() => {
    if (!handle) return;
    const take = async () => {
      const key = takeChatRoom();
      if (!key) return;
      const held = (holdings ?? (await walletHoldings(apiContext).catch(() => []))).filter(
        (h) => `${h.kind}:${h.id}` === key,
      );
      await prove(key);
      const look = parseLookup(await client.tokenRoom(key).catch(() => null));
      // MNEE isn't in the 1Sat index: when the wallet sees nothing, trust bit-sign's own check.
      const fromServer = held.length ? null : holdingFromLookup(look);
      const list = buildTokenRoomList(fromServer ? [fromServer] : held, rooms ?? [], look ? { [key]: look } : {});
      if (list[0]) return void openEntry(list[0]);
      // Not held (or below the minimum): show the lock with the room's real terms.
      const gate = look?.gate ?? { key, symbol: held[0]?.symbol ?? 'TOKEN', dec: held[0]?.dec ?? 0, minRaw: '1' };
      setLocked({ gate, heldRaw: look?.heldRaw ?? held[0]?.amountRaw ?? null, members: look?.room?.members ?? null });
    };
    void take();
    return onTokenNav(() => void take());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  // A tapped push notification (src/mobile/push): open the room by ticker once the lists have loaded.
  const [pushTicker, setPushTicker] = useState<string | null>(null);
  useEffect(() => {
    if (!handle) return;
    const take = () => {
      const t = takeRoomTicker(false);
      if (t) setPushTicker(t);
    };
    take();
    return onRoomTicker(take);
  }, [handle]);
  useEffect(() => {
    if (!pushTicker || !rooms) return;
    const room = rooms.find((r) => r.ticker.toUpperCase() === pushTicker);
    if (!room) return setPushTicker(null);
    if (isOpenRoom(room)) {
      setPushTicker(null);
      return openOpenRoom(room);
    }
    const e = entries?.find((x) => x.room?.ticker.toUpperCase() === pushTicker);
    if (e) {
      setPushTicker(null);
      void openEntry(e);
    } else if (entries) {
      setPushTicker(null);
      setOpen({ room, entry: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushTicker, rooms, entries]);

  /** One token room row (unchanged from the token-only list). */
  const renderTokenRow = ({ e, invite }: (typeof shown)[number]) => {
    const title = entryTitle(e, e.room) ?? `$${e.gate.symbol}`;
    const personal = personalOf(e);
    if (invite === 'invite' && personal && ROOMS) {
      return (
        <li key={e.key} className="flex items-center gap-3 px-4 py-[10px]">
          <Avatar title={e.gate.symbol} roomKey={e.key} />
          <div className="flex-1 min-w-0">
            <div className={`text-[15px] font-semibold text-white ${ELLIPSIS}`}>{inviteLine(personal)}</div>
            <div className={`text-[12px] ${ELLIPSIS}`} style={{ color: MUTED }}>
              {title} · {e.members ?? 0} holder{e.members === 1 ? '' : 's'}
            </div>
          </div>
          <button
            onClick={() => acceptInvite(e)}
            disabled={!!opening}
            className="rounded-xl px-3 py-1 text-xs font-bold"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            Join
          </button>
          <button
            onClick={() => ignoreInvite(e.key)}
            className="rounded-xl px-3 py-1 text-xs font-bold text-white"
            style={{ background: PANEL }}
          >
            Ignore
          </button>
        </li>
      );
    }
    const unread = e.status === 'member' ? (e.room?.unread ?? 0) : 0;
    const rowKey = e.status === 'member' && e.room ? roomKeyOf(e.room.ticker) : null;
    const muted = !!rowKey && isMuted(prefs, rowKey);
    const sub = !ROOMS
      ? STORE_ROOM_NOTE
      : e.status === 'start'
        ? "Tap to open the holders' room"
        : e.status === 'join'
          ? `${e.members ?? 0} holder${e.members === 1 ? '' : 's'} · tap to join`
          : e.room
            ? previewText(e.room, handle || '')
            : '';
    return (
      <li key={e.key}>
        {wrapRow(
          rowKey && e.room ? { key: rowKey, ticker: e.room.ticker, title, at: roomActivity(e.room), unread } : null,
          <button
            onClick={() => void openEntry(e)}
            disabled={!!opening || !ROOMS}
            className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]"
            style={{ background: BG }}
          >
            <Avatar title={e.gate.symbol} roomKey={e.key} />
            <div className="flex-1 min-w-0 pb-[10px] -mb-[10px]" style={{ borderBottom: `1px solid ${LINE}` }}>
              <div className="flex items-baseline gap-2">
                <span className={`flex-1 flex items-center gap-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>
                  <span className={ELLIPSIS}>{title}</span>
                  <MutedMark muted={muted} />
                </span>
                <span className="text-[11px] shrink-0" style={{ color: unread && !muted ? GOLD : MUTED }}>
                  {opening === e.key
                    ? 'opening…'
                    : e.room
                      ? listTimeLabel(e.room.last_message?.created_at ?? e.room.updated_at)
                      : ''}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-[2px]">
                <span
                  className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[10px] font-bold"
                  style={{ background: '#2a2208', color: GOLD, border: '1px solid #3a2f0c' }}
                >
                  <Coins size={10} /> {amountLabel(e.holding.amountRaw, e.gate)}
                </span>
                <span className={`flex-1 text-[13px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                  {sub}
                </span>
                <RowBadge
                  unread={unread}
                  marked={!!rowKey && isMarked(prefs, rowKey)}
                  muted={muted}
                  pinned={!!rowKey && isPinned(prefs, rowKey)}
                />
              </div>
            </div>
          </button>,
        )}
      </li>
    );
  };

  return (
    <div
      className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36"
      style={{ height: '100%', background: BG }}
      onScroll={onListScroll}
    >
      <PullToRefresh onRefresh={refresh} disabled={!handle} />
      <TopNav />
      <div className="w-full pt-16 flex flex-col">
        <SegmentRow>{header}</SegmentRow>
        <SegmentTitle title="Chatrooms">
          {handle && (
            <span className="mr-1 flex flex-col items-end leading-tight">
              <span className="text-[12px] font-semibold text-white">{myName || `$${handle}`}</span>
              {myName && (
                <span className="text-[10px]" style={{ color: MUTED }}>
                  ${handle}
                </span>
              )}
            </span>
          )}
        </SegmentTitle>

        {!online && (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
            style={{ background: '#1a1408', color: '#e6c76a' }}
          >
            <WifiOff size={14} /> You're offline. Chatrooms will refresh when you reconnect.
          </div>
        )}

        {handle && (rooms?.length ?? 0) + publicRooms.length > 4 && (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <Search size={15} color={MUTED} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chatrooms"
              className="flex-1 bg-transparent py-2 text-sm text-white outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear">
                <X size={14} color={MUTED} />
              </button>
            )}
          </div>
        )}

        {!handle && (
          <div className="px-6 pt-16 flex flex-col items-center text-center gap-3">
            <div
              className="h-16 w-16 rounded-2xl flex items-center justify-center"
              style={{ background: 'linear-gradient(145deg,#2a2208,#0d0b04)', border: '1px solid #3a2f0c' }}
            >
              <MessageCircle size={28} color={GOLD} />
            </div>
            <h2 className="text-lg font-bold text-white">Chatrooms</h2>
            <p className="text-xs" style={{ color: MUTED }}>
              {ROOMS
                ? 'Join public rooms, start your own, and chat with the holders of every token you own.'
                : 'Join public rooms or start your own.'}{' '}
              Signs in to bChat with this wallet's identity key — no password.
            </p>
            <button
              onClick={signIn}
              disabled={signingIn || !online}
              className="mt-2 rounded-2xl px-6 py-3 text-sm font-bold disabled:opacity-50"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              {signingIn ? 'Signing in…' : 'Sign in with wallet'}
            </button>
            {authError && <p className="text-xs text-[#F97066]">{authError}</p>}
            {handleClaim && <HandleFlow onClose={() => setHandleClaim(null)} onClaimed={finishClaim} />}
          </div>
        )}

        {handle && (
          <div className="px-4 pb-1 flex gap-2">
            <button
              onClick={() => setNewRoom(true)}
              className="flex-1 rounded-2xl px-4 py-2 text-sm font-bold inline-flex items-center justify-center gap-1"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              <Plus size={16} strokeWidth={2.6} /> New Room
            </button>
            {BSPACES_ENABLED && (
              <button
                onClick={() => setNewSpace(true)}
                className="flex-1 rounded-2xl px-4 py-2 text-sm font-bold inline-flex items-center justify-center gap-1"
                style={{ border: `1px solid ${GOLD}`, color: GOLD }}
              >
                <Plus size={16} strokeWidth={2.6} /> New Space
              </button>
            )}
          </div>
        )}
        {handle && rooms === null && !listError && <SkeletonRows label="Loading chatrooms" />}
        {handle && indexing && (
          <div
            className="mx-4 mt-3 mb-1 flex items-center gap-3 rounded-xl px-3 py-3 text-xs"
            style={{ background: PANEL, border: `1px solid ${LINE}`, color: MUTED }}
          >
            <Loader2 size={16} className="animate-spin shrink-0" color={GOLD} />
            <span className="flex-1">{indexingMessage(Date.now() - indexing.since)}</span>
            <button onClick={() => setIndexing(null)} aria-label="Stop waiting">
              <X size={14} color={MUTED} />
            </button>
          </div>
        )}
        {handle && listError && (
          <div className="text-center text-xs pt-4 px-6 text-[#F97066]">
            {listError}
            <div>
              <button onClick={refresh} className="mt-2 underline" style={{ color: GOLD }}>
                Try again
              </button>
            </div>
          </div>
        )}

        {/* The Help Desk card stays pinned above the filters, whichever is picked. */}
        {handle && rooms && (
          <>
            {helpDeskPinned && (
              <LoungeCard
                client={client}
                room={(rooms ?? []).find((r) => isLounge(r.ticker)) ?? null}
                me={handle}
                preview={(() => {
                  const r = (rooms ?? []).find((x) => isLounge(x.ticker));
                  return r ? previewText(r, handle) : '';
                })()}
                onOpen={() => void openLounge(false)}
                onJoin={() => void openLounge(true)}
                onUnpin={() => setHelpDeskUnpinned(true)}
              />
            )}
          </>
        )}
        {BSPACES_ENABLED && ROOMS && handle && rooms && <RoomFilterChips value={roomFilter} onChange={setRoomFilter} />}
        {BSPACES_ENABLED && ROOMS && handle && rooms && roomFilter === 'spaces' && (
          <SpacesRoomList
            client={client}
            me={handle}
            items={tokenMine.flatMap(({ e }) =>
              e.room
                ? [{ key: e.key, ticker: e.room.ticker, title: entryTitle(e, e.room) ?? `$${e.gate.symbol}` }]
                : [],
            )}
            onOpen={(key) => {
              const hit = tokenMine.find(({ e }) => e.key === key);
              if (hit) void openEntry(hit.e);
            }}
          />
        )}

        {handle && rooms && (!BSPACES_ENABLED || roomFilter !== 'spaces') && (
          <>
            <ListLabel>{bappsView ? 'Your bApp rooms' : 'Your rooms'}</ListLabel>
            {yours.length === 0 && archivedShown.length === 0 && (
              <p className="px-4 pb-2 text-xs" style={{ color: MUTED }}>
                {bappsView
                  ? 'No bApp rooms yet. Every bApp’s room is below.'
                  : 'You haven’t joined any rooms yet. Pick a public room below or start your own.'}
              </p>
            )}
            <ul className="w-full">
              {ROOMS &&
                !bappsView &&
                ownTokens(identityAddress).map((t) => (
                  <SetupRoomRow
                    key={t.tokenId}
                    token={t}
                    onDone={() => {
                      void recheckPendingIndexing(apiContext, identityAddress);
                      // The indexer lists it within about a second; then the room opens like any other.
                      setTimeout(() => {
                        if (identityAddress)
                          void retryPersonalRoom(apiContext, identityAddress, client).then((r) => r && refresh());
                        refresh();
                      }, 5000);
                    }}
                  />
                ))}
              <ArchivedGroup
                identity={handle}
                count={archivedShown.length}
                unread={archivedShown.reduce(
                  (n, y) => n + ((y.kind === 'open' ? y.room.unread : y.item.e.room?.unread) ?? 0),
                  0,
                )}
              >
                {archivedShown.map(renderYour)}
              </ArchivedGroup>
              {yoursShown.map(renderYour)}
            </ul>

            {bappsView && (
              <>
                <ListLabel>Every bApp room</ListLabel>
                <BappRoomCards
                  me={handle ?? null}
                  memberTickers={bappMembers}
                  onOpen={openBapp}
                  onJoinFree={joinFreeBapp}
                  wide={bappsWide}
                />
              </>
            )}
            {!bappsView && <ListLabel>Public rooms</ListLabel>}
            {!bappsView && browseShown.length === 0 && lockedOpen.length === 0 && (
              <p className="px-4 pb-2 text-xs" style={{ color: MUTED }}>
                {query
                  ? 'No public rooms match.'
                  : bappsView
                    ? 'You’re in every bApp room open to the public.'
                    : 'No other public rooms right now. Start one.'}
              </p>
            )}
            {!bappsView && lockedOpen.length > 0 && (
              <ul className="w-full">
                {lockedOpen.map((r) => {
                  const g = roomTokenGate(r.metadata);
                  return (
                    <li key={`locked:${r.ticker}`}>
                      <button
                        onClick={() => openOpenRoom(r)}
                        className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]"
                        data-locked-room={r.ticker}
                      >
                        <Avatar title={r.name || `$${r.ticker}`} src={roomIcon(r)} />
                        <div className="flex-1 min-w-0">
                          <div className={`flex items-center gap-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>
                            <span className={ELLIPSIS}>{r.name || `$${r.ticker}`}</span>
                            <Lock size={12} color={MUTED} className="shrink-0" />
                          </div>
                          <div className={`text-[12px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                            {g ? lockedLine(g, !!roomOwnerOrigin(r.metadata)) : ''}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <ul className="w-full">
              {(bappsView ? [] : browseShown).map((r) => (
                <li key={r.ticker} className="flex items-center gap-3 px-4 py-[10px]">
                  <Avatar title={r.name} />
                  <div className="flex-1 min-w-0">
                    <div className={`flex items-center gap-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>
                      <span className={ELLIPSIS}>{r.name}</span>
                      {r.official && <ShieldCheck size={14} color={GOLD} className="shrink-0" />}
                    </div>
                    <div className={`text-[12px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                      {r.memberCount} member{r.memberCount === 1 ? '' : 's'}
                      {r.description ? ` · ${r.description}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => void joinPublic(r)}
                    disabled={!!opening}
                    className="rounded-xl px-3 py-1 text-xs font-bold disabled:opacity-50"
                    style={{ background: GOLD, color: '#1a1300' }}
                  >
                    {opening === r.ticker ? '…' : 'Join'}
                  </button>
                </li>
              ))}
            </ul>

            {/* Token rooms: full build only. The store build hides the section entirely (storeBuild.ts). */}
            {ROOMS && !bappsView && (
              <>
                <ListLabel>Token rooms</ListLabel>
                {entries === null && <SkeletonRows count={3} label="Loading token rooms" />}
                {entries && entries.length === 0 && (
                  <div className="px-8 pt-4 pb-6 text-center">
                    <p className="text-sm text-white font-semibold">No token rooms yet</p>
                    <p className="text-xs mt-1" style={{ color: MUTED }}>
                      Buy a token in Market to join its chatroom.
                    </p>
                    {MARKET_ENABLED && (
                      <button
                        onClick={() => handleSelect(asMenuItem('market'))}
                        className="mt-4 rounded-2xl px-5 py-2 text-sm font-bold inline-flex items-center gap-2"
                        style={{ background: GOLD, color: '#1a1300' }}
                      >
                        <ShoppingCart size={15} /> {marketLabel()}
                      </button>
                    )}
                  </div>
                )}
                {entries && entries.length > 0 && tokenOtherShown.length === 0 && (
                  <p className="px-4 pb-2 text-xs" style={{ color: MUTED }}>
                    You’re in every token room you hold. They’re under Your rooms.
                  </p>
                )}
                <ul className="w-full">{tokenOtherShown.map(renderTokenRow)}</ul>
              </>
            )}
          </>
        )}
      </div>

      {locked && (
        <LockedRoom
          gate={locked.gate}
          heldRaw={locked.heldRaw}
          members={locked.members}
          onBuy={() => buy(locked.gate.key)}
          onClose={() => setLocked(null)}
        />
      )}
      {open && handle && (
        <Conversation
          client={client}
          room={openRoomView ?? open.room}
          entry={open.entry}
          autoJoinSpace={!!open.joinSpace}
          me={handle}
          online={online}
          onAuthLost={authLost}
          onInvite={open.entry && open.entry.key.startsWith('bsv21:') ? () => setInviting(true) : null}
          onXInvites={xManage && xManage === open.room.ticker ? () => setXInvites(true) : null}
          onBans={!openTicker && open.entry ? () => setRoomSettings(true) : null}
          onMarket={MARKET_ENABLED && open.entry?.key.startsWith('bsv21:') ? () => buy(open.entry!.key) : null}
          onBounties={openTicker ? null : () => setShowBounties(true)}
          openRoom={
            openTicker
              ? {
                  closed: card?.closed ?? openInfo(open.room)?.closed ?? false,
                  visibility: card?.visibility ?? openInfo(open.room)?.visibility ?? 'public',
                  onInfo: () => setShowInfo(true),
                }
              : null
          }
          hidden={hidden}
          onMessageMenu={setMsgMenu}
          onLocked={(r) => {
            setOpen(null);
            setLocked({ gate: r.gate, heldRaw: r.heldRaw, members: r.room?.members ?? null });
            refresh();
          }}
          onBack={() => {
            setOpen(null);
            refresh(true);
          }}
        />
      )}
      {NewSpaceSheet && newSpace && handle && (
        <Suspense fallback={null}>
          <NewSpaceSheet
            client={client}
            me={handle}
            rooms={rooms ?? []}
            onClose={() => setNewSpace(false)}
            onNewRoom={() => {
              setNewSpace(false);
              setNewRoom(true);
            }}
          />
        </Suspense>
      )}
      {newRoom && handle && (
        <NewRoomSheet
          client={client}
          onClose={() => setNewRoom(false)}
          onDone={(r) => {
            setNewRoom(false);
            // The creator is the room's admin: say so, or the room's "Start a Space" bar stays hidden.
            openOpenRoom(stubRoom(r.ticker, r.name, { created_by_handle: handle }));
            refresh();
          }}
        />
      )}
      {showInfo && open && card && handle && (
        <OpenRoomSheet
          client={client}
          card={card}
          me={handle}
          onClose={() => setShowInfo(false)}
          onChanged={reloadCard}
          onLeft={() => {
            setShowInfo(false);
            setOpen(null);
            refresh();
          }}
        />
      )}
      {msgMenu && open && handle && (
        <MessageMenu
          client={client}
          ticker={open.room.ticker}
          message={msgMenu}
          me={handle}
          canDelete={!!openTicker && isStaff(card) && !card?.closed}
          onDeleted={() => setHidden((cur) => new Set(cur).add(msgMenu.id))}
          onBlock={blockUser}
          onClose={() => setMsgMenu(null)}
        />
      )}
      {(roomSettings || roomSetupOffer) && open?.entry && (
        <RoomSettingsSheet
          client={client}
          ctx={apiContext}
          me={handle ?? ''}
          ticker={open.room.ticker}
          entry={open.entry}
          setup={!roomSettings && roomSetupOffer}
          onSell={MARKET_ENABLED ? () => sellTickets(open.entry!.key) : null}
          onBans={() => {
            setRoomSettings(false);
            setRoomSetupOffer(false);
            setBanning(true);
          }}
          onClose={closeRoomSettings}
        />
      )}
      {banning && open && <BansSheet client={client} ticker={open.room.ticker} onClose={() => setBanning(false)} />}
      {showBounties && open && handle && (
        <BountiesSheet
          client={client}
          room={open.room}
          entry={open.entry}
          me={handle}
          onClose={() => setShowBounties(false)}
        />
      )}
      {XInvitesSheet && xInvites && open?.entry && xManage === open.room.ticker && (
        <Suspense fallback={null}>
          <XInvitesSheet
            client={client}
            ctx={apiContext}
            ticker={open.room.ticker}
            roomName={roomTitle(open.room, handle ?? '')}
            gate={open.entry.gate}
            onClose={() => setXInvites(false)}
          />
        </Suspense>
      )}
      {XInviteClaim && xClaim && (
        <Suspense fallback={null}>
          <XInviteClaim
            client={client}
            ctx={apiContext}
            link={xClaim}
            identityAddress={identityAddress ?? ''}
            onClose={() => setXClaim(null)}
            onOpenRoom={(ticker) => {
              setXClaim(null);
              refresh();
              void client
                .roomPage(ticker)
                .then(parsePage)
                .then((p) => {
                  const key = p?.kind === 'room' ? p.gate?.key : null;
                  if (key) requestChatRoom(key);
                })
                .catch(() => undefined);
            }}
          />
        </Suspense>
      )}
      {inviting && open?.entry && (
        <InviteSheet
          client={client}
          ticker={open.room.ticker}
          roomName={roomTitle(open.room, handle ?? '')}
          entry={open.entry}
          onClose={() => setInviting(false)}
        />
      )}
    </div>
  );
};

/** A 1:1 conversation for the DMs segment: the same view, without token-room extras. */
const DmConversation = (p: DmConversationProps) => (
  <Conversation
    {...p}
    entry={null}
    onLocked={() => p.onBack()}
    onInvite={null}
    onBans={null}
    onBounties={null}
    bell={false}
    peer={dmPeer(p.room, p.me)}
  />
);

const ChatPage = () => (
  <>
    <ChatTabs
      rooms={(header) => <RoomsPage header={header} />}
      dms={(header) => <DmsPage header={header} Conversation={DmConversation} />}
    />
    <UndoToastHost />
  </>
);

export default ChatPage;
/** For the dev-only sample-data preview (screenshots); not used by the app. */
export { Conversation as ChatConversation };
