import { lazy, Suspense, useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  History,
  Ban,
  Bell,
  BellRing,
  Bookmark,
  Coins,
  Download,
  Heart,
  FileText,
  Globe,
  Mail,
  Newspaper,
  PlayCircle,
  Sparkles,
  Trash2,
  Zap,
  LockKeyhole,
  BadgeCheck,
  Bot,
  ScanLine,
  EyeOff,
  PiggyBank,
  ShieldCheck,
  LogOut,
  Network,
  AtSign,
} from 'lucide-react';
import { openDappBrowser } from '../dappBrowser';
import { ChangePassword } from './ChangePassword';
import { SEEDLESS_ENABLED } from '../passkey/prf';
import { PasskeySettings } from '../passkey/PasskeySettings';
import { ConnectSocial } from './ConnectSocial';
import { HandleFlow } from '../names/HandleFlow';
import { onSocialChange, takeSocialReturn } from '../social/socialLogin';
import { LinkedBadges } from '../social/LinkAccounts';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { asMenuItem } from '../tabs/tabs';
import { socialCloseTarget } from '../names/handlePrompt';
import { BchatClient, defaultHttp, saveSession, type SignInItem } from '../chat/api';
import { isNative } from '../native';
import { IDMAP_OPEN_EVENT, SIGNINS_OPEN_EVENT, signInRow, takeIdentityMapRequest, takeSignInsRequest } from './signIns';
import { AgentsScreen } from '../agents/AgentsScreen';
import { WalletNames } from './WalletNames';
import { DisplayNameField } from './DisplayNameField';
import { IdentityMap } from './IdentityMap';
import {
  B_AGENT_DESC,
  MY_TOKENS_DESC,
  MY_TOKENS_NOTE,
  isBWalletX,
  languageSettingsEnabled,
  potsEnabled,
  socialLoginEnabled,
  LINK_ACCOUNTS_ENABLED,
  SUBSCRIPTIONS_DESC,
  SUBSCRIPTIONS_ENABLED,
} from '../storeBuild';
import { onSubscribeRequest, peekSubscribeRequest } from '../pots/subscribeLink';
import { CATEGORIES, CATEGORY_LABELS } from '../notify/notify';
import { askNotifyPermissionOnce } from '../notify/engine';
import { useBackClose } from '../backStack';
import { INDEX_AUTOPAY_USD, ONE_CLICK_LIMITS, PAID_LIKE_OPTIONS, type DefaultFeed } from './prefs';
import { MAX_PER_MINUTE } from './oneClick';
import { usePrefs } from './usePrefs';
import { AgentSettings } from './AgentSettings';
import { AddOnsSection, BWebSettings } from '../bweb/BWebSettings';
import { PushSettings } from '../push/PushSettings';
import { onPushState, pushEnabled, setPushEnabled } from '../push/register';
import { loadSession } from '../chat/api';
import { TesterSettings } from '../testers/TesterSettings';
import { PhoneLayoutToggle } from '../phone/PhoneLayoutToggle';
import { testersEnabled } from '../testers/checkin';
import { PairedSitesList } from '../pair/PairedSitesList';
import { IS_EXTENSION } from '../extension';

/** bit-sign's branded Verify-your-identity page (Veriff). Shows only verified / not and the date. */
const KYC_URL = 'https://bit-sign.online/kyc';

const PairSheet = lazy(() => import('../pair/PairSheet'));
const PotsScreen = lazy(() => import('../pots/PotsScreen'));
import { TermsScreen } from '../ugc/UgcSheets';
import { SECURITY_URL, SUPPORT_EMAIL } from '../ugc/ugc';
import { DeleteAccountScreen } from '../account/DeleteAccountScreen';
import { HdSweepScreen } from '../sweep/HdSweepScreen';
import { OriginsScreen } from '../origins/OriginsScreen';
import { hasRate, money, useBsvUsd } from '../money/money';
import {
  loadBlocks,
  loadBookmarks,
  loadMuteNames,
  loadMutes,
  mutedAccounts,
  removeBlock,
  removeMute,
  type HiddenAccount,
} from '../feed/store';
import type { FeedPost } from '../feed/post';
import { FILTER_NOTE, isSlur, safeName } from '../feed/language';
import { bookmarkClient, syncBookmarks, toggleSyncedBookmark } from '../feed/bookmarkSync';
import { useServiceContext } from '../../hooks/useServiceContext';
import { ownTokens, recheckPendingIndexing } from '../tokens/pendingIndexing';
import { setupLabel, useRoomSetup } from '../tokens/useRoomSetup';
import type { OwnToken } from '../tokens/indexFund';
import {
  registerSettingsEntries,
  SETTINGS_SCREEN_EVENT,
  takeSettingsScreen,
  type SettingsEntry,
} from '../../utils/settingsSearch';

const FEED_SETTINGS_SEARCH: SettingsEntry[] = [
  {
    id: 'feed-password',
    label: 'Change password',
    description: 'The one password for every account here',
    keywords: ['password', 'passphrase', 'pin', 'change password', 'new password'],
    target: { kind: 'screen', screen: 'password' },
  },
  {
    id: 'feed-notifications',
    label: 'Notifications',
    description: 'What the app tells you about',
    keywords: ['notifications', 'alerts', 'push', 'sounds', 'bmail'],
    target: { kind: 'screen', screen: 'notifications' },
  },
  {
    id: 'feed-feed',
    label: 'Feed',
    description: 'Default feed, autoplay, filters',
    keywords: ['feed', 'autoplay', 'video', 'language', 'filter', 'posts'],
    target: { kind: 'screen', screen: 'feed' },
  },
  {
    id: 'feed-payments',
    label: 'Payments',
    description: 'One-click pay and paid likes',
    keywords: ['pay', 'payment', 'one click', 'limit', 'like', 'tip'],
    target: { kind: 'screen', screen: 'payments' },
  },
  {
    id: 'feed-bagent',
    label: 'Ask b',
    description: 'b, the assistant in your wallet',
    keywords: ['b', 'agent', 'assistant', 'ai', 'ask b'],
    target: { kind: 'screen', screen: 'bagent' },
  },
  {
    id: 'feed-bweb',
    label: 'bWeb',
    description: 'The in-app browser',
    keywords: ['browser', 'web', 'bweb', 'sites'],
    target: { kind: 'screen', screen: 'bweb' },
  },
  {
    id: 'feed-indexing',
    label: 'Token indexing',
    description: 'One-tap indexing fee',
    keywords: ['index', 'indexing', 'token', 'fee'],
    target: { kind: 'screen', screen: 'indexing' },
  },
  {
    id: 'feed-bookmarks',
    label: 'Bookmarks',
    description: 'Saved posts',
    keywords: ['bookmarks', 'saved', 'favourites'],
    target: { kind: 'screen', screen: 'bookmarks' },
  },
  {
    id: 'feed-hidden',
    label: 'Blocked & muted',
    description: 'People and posts you hid',
    keywords: ['block', 'blocked', 'mute', 'muted', 'hide', 'hidden'],
    target: { kind: 'screen', screen: 'hidden' },
  },
  {
    id: 'feed-idmap',
    label: 'Identity map',
    description: 'Your keys, names and links',
    keywords: ['identity', 'keys', 'map', 'addresses'],
    target: { kind: 'screen', screen: 'idmap' },
  },
  {
    id: 'feed-signins',
    label: 'Recent sign-ins',
    description: 'Where this account signed in',
    keywords: ['sign in', 'login', 'sessions', 'devices'],
    target: { kind: 'screen', screen: 'signins' },
  },
  {
    id: 'feed-tokens',
    label: 'My tokens',
    description: 'Tokens you launched',
    keywords: ['tokens', 'my tokens', 'coins'],
    target: { kind: 'screen', screen: 'tokens' },
  },
  {
    id: 'feed-sweep',
    label: 'Sweep into this account',
    description: 'Move funds in from another phrase or key',
    keywords: ['sweep', 'import', 'move funds', 'transfer'],
    target: { kind: 'screen', screen: 'sweep' },
  },
  {
    id: 'feed-delete',
    label: 'Delete account data',
    description: 'Remove what this account stored',
    keywords: ['delete', 'erase', 'remove', 'data', 'gdpr'],
    target: { kind: 'screen', screen: 'delete' },
  },
  {
    id: 'feed-terms',
    label: 'Terms of use',
    description: 'The rules for using the app',
    keywords: ['terms', 'legal', 'policy'],
    target: { kind: 'screen', screen: 'terms' },
  },
];
// Settings' search bar finds these rows too (utils/settingsSearch.ts); this module loads only where they exist.
registerSettingsEntries(FEED_SETTINGS_SEARCH);

/**
 * Settings → Feed / Payments / Privacy (mobile). Rendered inside upstream Settings' main page via the
 * vite.config.mobile.ts text patch, reusing its Section / SettingRow / Divider so it looks native.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

type RowProps = {
  icon: ReactNode;
  label: string;
  description?: string;
  right?: ReactNode;
  onClick?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  danger?: boolean;
};
type Props = {
  Section: ComponentType<{ title: string; children: ReactNode }>;
  Row: ComponentType<RowProps>;
  Divider: ComponentType;
  /**
   * Settings is split into "This account" (keys, names, tokens: differ per account) and "All accounts (wallet)"
   * (device / app preferences). 'notify' is the Notifications row at the top of "All accounts". Unset renders all.
   */
  part?: 'account' | 'wallet' | 'notify';
};

const FEEDS: { id: DefaultFeed; label: string }[] = [
  { id: 'foryou', label: 'For you' },
  { id: 'latest', label: 'Latest' },
  { id: 'following', label: 'Following' },
];

const Pills = <T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) => (
  <div
    className="grid grid-flow-col auto-cols-fr gap-1.5 w-full"
    role="radiogroup"
    aria-label={label}
    onClick={(e) => e.stopPropagation()}
  >
    {options.map((o) => (
      <button
        key={String(o.id)}
        role="radio"
        aria-checked={o.id === value}
        onClick={() => onChange(o.id)}
        className="rounded-full px-1 py-1.5 text-[11px] font-bold whitespace-nowrap text-center"
        style={
          o.id === value
            ? { background: GOLD, color: '#1a1300' }
            : { background: PANEL, color: MUTED, border: `1px solid ${LINE}` }
        }
      >
        {o.label}
      </button>
    ))}
  </div>
);

const Toggle = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button
    role="switch"
    aria-checked={on}
    aria-label={label}
    onClick={(e) => {
      e.stopPropagation();
      onChange(!on);
    }}
    className="relative h-6 w-11 rounded-full transition-colors"
    style={{ background: on ? GOLD : LINE }}
  >
    <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" style={{ left: on ? 22 : 2 }} />
  </button>
);

const Screen = ({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) => {
  useBackClose(true, onBack);
  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <button onClick={onBack} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">{title}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 bw-dock-pad">{children}</div>
    </div>,
    document.body,
  );
};

const Heading = ({ children }: { children: ReactNode }) => (
  <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-widest" style={{ color: MUTED }}>
    {children}
  </p>
);

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-xs" style={{ color: MUTED }}>
    {children}
  </p>
);

const ListRow = ({
  title,
  sub,
  action,
  onAction,
}: {
  title: string;
  sub?: string;
  action?: string;
  onAction?: () => void;
}) => (
  <div
    className="mb-2 flex items-center gap-3 rounded-xl px-3 py-3"
    style={{ background: PANEL, border: `1px solid ${LINE}` }}
  >
    <div className="min-w-0 flex-1 overflow-hidden">
      <p className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-white">{title}</p>
      {sub && (
        <p className="mt-0.5 line-clamp-2 text-xs" style={{ color: MUTED }}>
          {sub}
        </p>
      )}
    </div>
    {action && onAction && (
      <button
        onClick={onAction}
        className="shrink-0 rounded-full px-3 py-1 text-xs font-bold"
        style={{ border: `1px solid ${GOLD}`, color: GOLD }}
      >
        {action}
      </button>
    )}
  </div>
);

const BookmarksScreen = ({ onBack }: { onBack: () => void }) => {
  const [items, setItems] = useState<FeedPost[]>(loadBookmarks);
  useEffect(() => {
    void syncBookmarks(bookmarkClient()).then(setItems);
  }, []);
  return (
    <Screen title="Bookmarks" onBack={onBack}>
      {items.length ? (
        <>
          {items.map((p) => (
            <ListRow
              key={p.txid}
              title={safeName(p.author.name)}
              sub={
                isSlur(p.text) ? 'Post hidden: offensive language' : p.text || `${p.media?.length ?? 0} attachment(s)`
              }
              action="Remove"
              onAction={() => {
                setItems((b) => toggleSyncedBookmark(b, p));
                void syncBookmarks(bookmarkClient()).then(setItems);
              }}
            />
          ))}
          <Note>To read, like or reply, open Bookmarks from the bookmark button on the Feed.</Note>
        </>
      ) : (
        <Note>Nothing saved yet. Tap the bookmark on a post to save it.</Note>
      )}
    </Screen>
  );
};

/** Settings › Chat › Recent sign-ins: the last 10 sign-ins to this account's chat handle. No IPs. */
const SignInsScreen = ({ onBack }: { onBack: () => void }) => {
  const session = loadSession();
  const [items, setItems] = useState<SignInItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!session) return;
    new BchatClient(defaultHttp(isNative), session)
      .signIns()
      .then(setItems)
      .catch(() => setError('Couldn’t load sign-ins. Try again later.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);
  return (
    <Screen title="Recent sign-ins" onBack={onBack}>
      {!session ? (
        <Note>Not signed in to chat. Open Chat to sign in.</Note>
      ) : (
        <>
          <Heading>${session.handle}</Heading>
          {error && <Note>{error}</Note>}
          {!error && items === null && <Note>Loading…</Note>}
          {items?.length === 0 && <Note>No sign-ins recorded yet.</Note>}
          {items?.map((s, i) => {
            const r = signInRow(s);
            return <ListRow key={`${s.at}-${i}`} title={r.title} sub={r.when} />;
          })}
          <Note>Not you? Sign out of chat on every device, then check your account’s linked logins.</Note>
        </>
      )}
    </Screen>
  );
};

const HiddenScreen = ({ onBack }: { onBack: () => void }) => {
  const [mutes, setMutes] = useState<string[]>(loadMutes);
  const [blocks, setBlocks] = useState<HiddenAccount[]>(loadBlocks);
  const muted = mutedAccounts(mutes, loadMuteNames());
  return (
    <Screen title="Blocked & muted" onBack={onBack}>
      <Heading>Blocked</Heading>
      {blocks.length ? (
        blocks.map((b) => (
          <ListRow
            key={b.address}
            title={b.name}
            sub="Posts and replies hidden everywhere, including their profile"
            action="Unblock"
            onAction={() => setBlocks((x) => removeBlock(x, b))}
          />
        ))
      ) : (
        <Note>Nobody blocked.</Note>
      )}
      <Heading>Muted</Heading>
      {muted.length ? (
        muted.map((m) => (
          <ListRow
            key={m.keys.join()}
            title={m.name}
            sub="Hidden in the feed and threads"
            action="Unmute"
            onAction={() => setMutes((x) => removeMute(x, ...m.keys))}
          />
        ))
      ) : (
        <Note>Nobody muted.</Note>
      )}
    </Screen>
  );
};

/** One own token: "Room open" or "Not set up" + the shared setup flow (useRoomSetup). */
const MyTokenRow = ({ token, onDone }: { token: OwnToken; onDone: () => void }) => {
  const s = useRoomSetup(token.tokenId, token.ticker, { onDone });
  const state =
    s.status === undefined
      ? 'Checking…'
      : s.status === null
        ? 'The indexer didn’t answer. Try again later.'
        : s.open
          ? 'Room open'
          : s.waiting
            ? 'Setting up… (usually under a minute)'
            : 'Not set up';
  return (
    <div className="mb-2 rounded-xl px-3 py-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-white">
            ${token.ticker}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: s.open ? GOLD : MUTED }}>
            {state}
          </p>
          {s.needs && s.freeNote && (
            <p className="mt-0.5 text-xs" style={{ color: GOLD }}>
              {s.freeNote}
            </p>
          )}
        </div>
        {s.needs && s.total && (
          <button
            onClick={s.start}
            disabled={s.busy}
            className="shrink-0 rounded-full px-3 py-1 text-xs font-bold disabled:opacity-40"
            style={{ border: `1px solid ${GOLD}`, color: GOLD }}
          >
            {setupLabel(s.total.totalSats, s.rate)}
          </button>
        )}
      </div>
      {s.msg && (
        <p className="mt-2 text-xs" style={{ color: MUTED }}>
          {s.msg}
        </p>
      )}
      {s.sheet}
    </div>
  );
};

/** Settings › My tokens: every own token (incl. ones whose Wallet card got "Not now"). */
const MyTokensScreen = ({ onBack }: { onBack: () => void }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  const tokens = ownTokens(identityAddress);
  return (
    <Screen title="My tokens" onBack={onBack}>
      {tokens.length ? (
        <>
          {tokens.map((t) => (
            <MyTokenRow
              key={t.tokenId}
              token={t}
              onDone={() => void recheckPendingIndexing(apiContext, identityAddress)}
            />
          ))}
          <Note>{MY_TOKENS_NOTE}</Note>
        </>
      ) : (
        <Note>Tokens you mint in bWallet show here.</Note>
      )}
    </Screen>
  );
};

/**
 * Settings main page: one Notifications row. The switch is push on/off for this device (the same master switch
 * as the Notifications page); tapping the row opens that page (categories, previews, quiet hours).
 */
const NotificationsRow = ({
  Row,
  Toggle: T,
  onOpen,
}: {
  Row: ComponentType<RowProps>;
  Toggle: typeof Toggle;
  onOpen: () => void;
}) => {
  const [on, setOn] = useState(pushEnabled());
  const [busy, setBusy] = useState(false);
  useEffect(() => onPushState(() => setOn(pushEnabled())), []);
  const flip = async (v: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await setPushEnabled(v, loadSession());
      // Blocked by the phone / browser: the Notifications page says why and how to fix it.
      if (v && !ok) onOpen();
    } catch {
      onOpen();
    } finally {
      setOn(pushEnabled());
      setBusy(false);
    }
  };
  return (
    <Row
      icon={<BellRing size={16} />}
      label="Notifications"
      description="Rooms, DMs and payments; previews, quiet hours"
      right={<T label="Notifications" on={on} onChange={(v) => void flip(v)} />}
      onClick={onOpen}
      isFirst
      isLast
    />
  );
};

export const FeedSettings = ({ Section, Row, Divider, part }: Props) => {
  const acct = !part || part === 'account';
  const wal = !part || part === 'wallet';
  const notif = !part || part === 'notify';
  const [prefs, setPrefs] = usePrefs();
  const [screen, setScreen] = useState<
    | 'bookmarks'
    | 'passkey'
    | 'hidden'
    | 'terms'
    | 'delete'
    | 'sweep'
    | 'origins'
    | 'tokens'
    | 'paired'
    | 'scan'
    | 'password'
    | 'social'
    | 'agents'
    | 'pots'
    | 'notifications'
    | 'feed'
    | 'payments'
    | 'indexing'
    | 'bagent'
    | 'bweb'
    | 'websites'
    | 'idmap'
    | 'signins'
    | null
  >(null);
  // A Settings search result opens one of these screens. Only the "wallet" instance takes it, so it opens once.
  useEffect(() => {
    if (!wal) return;
    const open = () => {
      const want = takeSettingsScreen();
      if (want) setScreen(want as typeof screen);
    };
    open();
    window.addEventListener(SETTINGS_SCREEN_EVENT, open);
    return () => window.removeEventListener(SETTINGS_SCREEN_EVENT, open);
  }, [wal]);
  // The "New sign-in to bChat" push opens Recent sign-ins (settings/signIns.ts).
  useEffect(() => {
    if (!acct) return;
    if (takeSignInsRequest()) setScreen('signins');
    const open = () => takeSignInsRequest() && setScreen('signins');
    window.addEventListener(SIGNINS_OPEN_EVENT, open);
    return () => window.removeEventListener(SIGNINS_OPEN_EVENT, open);
  }, [acct]);
  // Back from X / Google for this account: reopen Connect so the profile attaches on this trip (socialLogin.ts).
  const { chromeStorageService: socialStore } = useServiceContext();
  // Opened by the app (back from X / Google after unlock), not by a tap here: closing it goes to the Wallet,
  // not the Settings page the return passed through (owner, 11 Oct 2026).
  const [socialFromReturn, setSocialFromReturn] = useState(false);
  const selectTab = useContext(BottomMenuContext)?.handleSelect;
  const closeSocial = () => {
    const target = socialCloseTarget(socialFromReturn);
    setSocialFromReturn(false);
    setScreen(null);
    if (target === 'wallet') selectTab?.(asMenuItem('bsv'));
  };
  const socialOwner = socialStore.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  useEffect(() => {
    if (!acct || !socialOwner) return;
    const open = () => {
      if (!takeSocialReturn(socialOwner)) return;
      setSocialFromReturn(true);
      setScreen('social');
    };
    open();
    return onSocialChange(open);
  }, [acct, socialOwner]);
  // Long-press on the wallet card's identity line opens the Identity map (settings/signIns.ts).
  useEffect(() => {
    if (takeIdentityMapRequest()) setScreen('idmap');
    const open = () => takeIdentityMapRequest() && setScreen('idmap');
    window.addEventListener(IDMAP_OPEN_EVENT, open);
    return () => window.removeEventListener(IDMAP_OPEN_EVENT, open);
  }, []);
  // A subscribe link from one of our services (pots/subscribeLink.ts) opens Subscriptions. bWalletX only.
  useEffect(() => {
    if (!SUBSCRIPTIONS_ENABLED || !wal) return;
    const open = () => peekSubscribeRequest() && setScreen('pots');
    open();
    return onSubscribeRequest(open);
  }, [wal]);
  const rate = useBsvUsd();
  // bWalletX extension: take window.CWI over another wallet (src/brand/cwi.ts, content.ts). Reloads apply it.
  const [takeCwi, setTakeCwiState] = useState(true);
  useEffect(() => {
    if (IS_EXTENSION)
      chrome.storage?.local.get('bwalletxTakeCwi', (r) => setTakeCwiState(r?.bwalletxTakeCwi !== false));
  }, []);
  const setTakeCwi = (v: boolean) => {
    setTakeCwiState(v);
    void chrome.storage?.local.set({ bwalletxTakeCwi: v });
  };
  // Limits are stored and enforced in sats; shown in USD at the live rate (sats when the rate is unknown).
  const limits = ONE_CLICK_LIMITS.map((v) => ({ id: v, label: money(v, rate) }));
  const [chatSignedOut, setChatSignedOut] = useState(false);
  const [handleOpen, setHandleOpen] = useState(false);
  const paidLikes = PAID_LIKE_OPTIONS.map((v) => ({ id: v as number, label: money(v, rate) }));
  return (
    <>
      {acct && socialLoginEnabled() && (
        <Section title="Identity">
          <DisplayNameField />
          {LINK_ACCOUNTS_ENABLED && <LinkedBadges owner={socialOwner} />}
          <WalletNames />
          <Row
            icon={<Network size={16} />}
            label="Identity map"
            description="Your identity key, the keys derived from it, and the names that point at them"
            onClick={() => setScreen('idmap')}
            isFirst
          />
          <Divider />
          <Row
            icon={<AtSign size={16} />}
            label="Change handle"
            description="Choose the name people pay and find you by; your old name keeps receiving"
            onClick={() => setHandleOpen(true)}
          />
          <Divider />
          {LINK_ACCOUNTS_ENABLED && (
            <>
              <Row
                icon={<BadgeCheck size={16} />}
                label="Link your accounts"
                description="X, Google, GitHub, LinkedIn and HandCash: verified badges on your profile, signed by your wallet"
                onClick={() => setScreen('social')}
              />
              <Divider />
            </>
          )}
          <Row
            icon={<ShieldCheck size={16} />}
            label="Verify your identity"
            description="A two-minute ID check. Shows a Verified identity badge on contracts you sign and unlocks higher limits"
            onClick={() => void openDappBrowser(KYC_URL)}
            isLast
          />
        </Section>
      )}
      {acct && (
        <Section title="Chat">
          <Row
            icon={<LogOut size={16} />}
            label="Sign out of chat"
            description={
              chatSignedOut
                ? 'Signed out. Chat signs this account in again when you open it.'
                : 'This account only: chat signs in fresh next time'
            }
            onClick={() => {
              saveSession(null);
              setChatSignedOut(true);
            }}
            isFirst
          />
          <Divider />
          <Row
            icon={<History size={16} />}
            label="Recent sign-ins"
            description="When and where this chat handle signed in"
            onClick={() => setScreen('signins')}
            isLast
          />
        </Section>
      )}
      {acct && (
        <Section title="Tokens">
          <Row
            icon={<Coins size={16} />}
            label="My tokens"
            description={MY_TOKENS_DESC}
            onClick={() => setScreen('tokens')}
            isFirst
            isLast
          />
        </Section>
      )}
      {acct && (
        <Section title="Account data">
          <Row
            icon={<Download size={16} />}
            label="Sweep into this account"
            description="Move coins, NFTs and tokens from bWalletX, Yours, SimplyCash or any wallet: paste its phrase or private key"
            onClick={() => setScreen('sweep')}
            isFirst
          />
          <Divider />
          <Row
            icon={<History size={16} />}
            label="Where this account came from"
            description="What is still at older wallets this recovery phrase was used with: Yours, RelayX, Twetch, Money Button"
            onClick={() => setScreen('origins')}
          />
          <Divider />
          <Row
            icon={<Trash2 size={16} />}
            label="Delete account data"
            description="Delete this account's paymail, $handle, bChat profile and messages"
            onClick={() => setScreen('delete')}
            isLast
            danger
          />
        </Section>
      )}
      {notif && (
        <Section title="Notifications">
          <NotificationsRow Toggle={Toggle} Row={Row} onOpen={() => setScreen('notifications')} />
        </Section>
      )}
      {wal && (
        <>
          <Section title="General">
            <Row
              icon={<Newspaper size={16} />}
              label="Feed"
              description="Default feed, autoplay, backgrounds, language"
              onClick={() => setScreen('feed')}
              isFirst
            />
            <Divider />
            <Row
              icon={<Zap size={16} />}
              label="Payments"
              description="One-click pay and paid likes"
              onClick={() => setScreen('payments')}
            />
            {potsEnabled() && (
              <>
                <Divider />
                <Row
                  icon={<PiggyBank size={16} />}
                  label="Subscriptions"
                  description={SUBSCRIPTIONS_DESC}
                  onClick={() => setScreen('pots')}
                />
              </>
            )}
            {isBWalletX() && (
              <>
                <Divider />
                <Row
                  icon={<Bot size={16} />}
                  label="Agent accounts"
                  description="Accounts your AI agents can use, with their own budget"
                  onClick={() => setScreen('agents')}
                />
              </>
            )}
            <Divider />
            <Row
              icon={<Sparkles size={16} />}
              label="Ask b"
              description={B_AGENT_DESC}
              onClick={() => setScreen('bagent')}
            />
            <Divider />
            <Row
              icon={<Globe size={16} />}
              label="bWeb"
              description="Your dock, your Feed's bApps, what b can see, add-ons"
              onClick={() => setScreen('bweb')}
            />
            <Divider />
            <Row
              icon={<Coins size={16} />}
              label="Token indexing"
              description="One-tap fee for your own tokens"
              onClick={() => setScreen('indexing')}
            />
            {IS_EXTENSION && (
              <>
                <Divider />
                <Row
                  icon={<Globe size={16} />}
                  label="Websites"
                  description="Which wallet sites connect to"
                  onClick={() => setScreen('websites')}
                />
              </>
            )}
            <Divider />
            <Row
              icon={<LockKeyhole size={16} />}
              label="Change password"
              description="One password unlocks every account"
              onClick={() => setScreen('password')}
              isLast={!SEEDLESS_ENABLED}
            />
            {SEEDLESS_ENABLED && (
              <>
                <Divider />
                <Row
                  icon={<LockKeyhole size={16} />}
                  label="Passkey"
                  description="Unlock with Face ID / fingerprint; seal your 12 words"
                  onClick={() => setScreen('passkey')}
                  isLast
                />
              </>
            )}
          </Section>
          <Section title="Appearance">
            <PhoneLayoutToggle />
          </Section>
          {testersEnabled() && (
            <Section title="Testing">
              <TesterSettings />
            </Section>
          )}
          <Section title="Privacy">
            <Row
              icon={<Bookmark size={16} />}
              label="Bookmarks"
              description="Posts you saved on this device"
              onClick={() => setScreen('bookmarks')}
              isFirst
            />
            <Divider />
            <Row
              icon={<Ban size={16} />}
              label="Blocked & muted"
              description="Unblock or unmute accounts"
              onClick={() => setScreen('hidden')}
              isLast
            />
          </Section>
          {
            <Section title="Connections">
              {/* One tap to the camera (owner, 6 Oct 2026: couldn't find how to link the CLI to an agent account). */}
              <Row
                icon={<ScanLine size={16} />}
                label={IS_EXTENSION ? 'Connect the CLI / an AI assistant' : 'Scan to connect'}
                description={
                  IS_EXTENSION
                    ? 'Pair the bWalletX CLI or an AI assistant (MCP): paste the link from bwalletx login'
                    : 'Pair the bWalletX CLI, an AI assistant (MCP) or a website: scan its QR code'
                }
                onClick={() => setScreen('scan')}
                isFirst
              />
              <Divider />
              <Row
                icon={<Globe size={16} />}
                label="Paired computers & websites"
                description="What's connected to this account, and what each may do"
                onClick={() => setScreen('paired')}
                isLast
              />
            </Section>
          }
          <Section title="Help & safety">
            <Row
              icon={<FileText size={16} />}
              label="Terms of use"
              isFirst
              description="Zero tolerance for objectionable content and abusive users"
              onClick={() => setScreen('terms')}
            />
            <Divider />
            <Row
              icon={<Mail size={16} />}
              label="Contact and reports"
              description={SUPPORT_EMAIL}
              onClick={() => (window.location.href = `mailto:${SUPPORT_EMAIL}`)}
            />
            <Divider />
            <Row
              icon={<ShieldCheck size={16} />}
              label="Report a security issue"
              description="b-Aware: responsible disclosure, rewards paid in BSV"
              onClick={() => window.open(SECURITY_URL, '_blank', 'noopener')}
              isLast
            />
          </Section>
        </>
      )}
      {screen === 'feed' && (
        <Screen title="Feed" onBack={() => setScreen(null)}>
          <Section title="Feed">
            <Row icon={<Newspaper size={16} />} label="Default feed" description="What the Feed opens to" isFirst />
            <div className="px-4 pb-3 pl-12">
              <Pills
                label="Default feed"
                options={FEEDS}
                value={prefs.defaultFeed}
                onChange={(v) => setPrefs({ defaultFeed: v })}
              />
            </div>
            <Divider />
            <Row
              icon={<PlayCircle size={16} />}
              label="Video autoplay"
              description={prefs.autoplay ? 'Videos play muted as you scroll' : 'Videos wait for a tap'}
              right={<Toggle label="Video autoplay" on={prefs.autoplay} onChange={(v) => setPrefs({ autoplay: v })} />}
            />
            <Divider />
            <Row
              icon={<Sparkles size={16} />}
              label="Animated backgrounds"
              description={
                prefs.animatedBackgrounds
                  ? 'Gold motion behind Wallet, Apps and Feed'
                  : 'Still images behind Wallet, Apps and Feed'
              }
              right={
                <Toggle
                  label="Animated backgrounds"
                  on={prefs.animatedBackgrounds}
                  onChange={(v) => setPrefs({ animatedBackgrounds: v })}
                />
              }
              isLast={!languageSettingsEnabled()}
            />
            {languageSettingsEnabled() && (
              <>
                <Divider />
                <Row
                  icon={<EyeOff size={16} />}
                  label="Filter strong language"
                  description={
                    prefs.filterStrong ? 'Swearing is blurred until you tap Show anyway' : 'Swearing is shown as posted'
                  }
                  right={
                    <Toggle
                      label="Filter strong language"
                      on={prefs.filterStrong}
                      onChange={(v) => setPrefs({ filterStrong: v })}
                    />
                  }
                  isLast
                />
              </>
            )}
          </Section>
          <div className="px-4 -mt-2 mb-3">
            <Note>
              {languageSettingsEnabled()
                ? 'Posts with slurs are blurred: tap Show anyway to read one. '
                : 'Posts with slurs are hidden and strong language is blurred in this edition. '}
              {FILTER_NOTE}
            </Note>
          </div>
        </Screen>
      )}
      {screen === 'payments' && (
        <Screen title="Payments" onBack={() => setScreen(null)}>
          <Section title="Payments">
            <Row
              icon={<Zap size={16} />}
              label="One-click pay"
              description={
                prefs.oneClick
                  ? `Tips and locks up to ${money(prefs.oneClickLimit, rate)}${hasRate(rate) ? ` (${prefs.oneClickLimit.toLocaleString()} sats)` : ''} skip the confirm (max ${MAX_PER_MINUTE} a minute)`
                  : 'Always confirm tips and locks'
              }
              right={<Toggle label="One-click pay" on={prefs.oneClick} onChange={(v) => setPrefs({ oneClick: v })} />}
              isFirst
            />
            {prefs.oneClick && (
              <>
                <Divider />
                <Row
                  icon={<Zap size={16} />}
                  label="Limit per action"
                  description={
                    hasRate(rate)
                      ? 'Anything above this asks first (USD at today’s BSV price)'
                      : 'Anything above this asks first (sats; USD price unavailable)'
                  }
                  isLast
                />
                <div className="px-4 pb-3 pl-12">
                  <Pills
                    label="One-click limit"
                    options={limits}
                    value={prefs.oneClickLimit}
                    onChange={(v) => setPrefs({ oneClickLimit: v })}
                  />
                </div>
              </>
            )}
            <Divider />
            <Row
              icon={<Heart size={16} />}
              label="Paid like"
              description={`Like + ${money(prefs.paidLikeSats, rate)}${hasRate(rate) ? ` (${prefs.paidLikeSats.toLocaleString()} sats)` : ''} to the author, from a post's Tip sheet`}
              isLast
            />
            <div className="px-4 pb-3 pl-12">
              <Pills
                label="Paid like amount"
                options={paidLikes}
                value={prefs.paidLikeSats}
                onChange={(v) => setPrefs({ paidLikeSats: v })}
              />
            </div>
          </Section>
        </Screen>
      )}
      {screen === 'indexing' && (
        <Screen title="Token indexing" onBack={() => setScreen(null)}>
          <Section title="Token indexing">
            <Row
              icon={<Zap size={16} />}
              label="One-tap indexing fee"
              isFirst
              description={
                prefs.indexAutoPayUsd
                  ? `Your own tokens' indexing fee pays on one tap when under $${prefs.indexAutoPayUsd.toFixed(2)}`
                  : "Always confirm your tokens' indexing fee"
              }
              isLast
            />
            <div className="px-4 pb-3 pl-12">
              <Pills
                label="One-tap indexing limit"
                options={INDEX_AUTOPAY_USD.map((v) => ({ id: v, label: v ? `$${v.toFixed(2)}` : 'Off' }))}
                value={prefs.indexAutoPayUsd}
                onChange={(v) => setPrefs({ indexAutoPayUsd: v })}
              />
            </div>
          </Section>
        </Screen>
      )}
      {screen === 'bagent' && (
        <Screen title="Ask b" onBack={() => setScreen(null)}>
          <AgentSettings Section={Section} Row={Row} Divider={Divider} />
          <AddOnsSection Section={Section} Row={Row} Divider={Divider} Toggle={Toggle} />
        </Screen>
      )}
      {screen === 'bweb' && (
        <Screen title="bWeb" onBack={() => setScreen(null)}>
          <BWebSettings
            Section={Section}
            Row={Row}
            Divider={Divider}
            Toggle={Toggle}
            onIdentities={() => setScreen('idmap')}
          />
        </Screen>
      )}
      {screen === 'websites' && (
        <Screen title="Websites" onBack={() => setScreen(null)}>
          <Section title="Websites">
            <Row
              icon={<Globe size={16} />}
              label="Be the wallet websites connect to"
              description={
                takeCwi
                  ? 'Sites without a wallet picker connect to bWalletX, even with Yours installed'
                  : 'Another wallet (e.g. Yours) answers sites without a picker'
              }
              right={<Toggle label="Be the wallet websites connect to" on={takeCwi} onChange={setTakeCwi} />}
              isFirst
              isLast
            />
          </Section>
        </Screen>
      )}
      {screen === 'notifications' && (
        <Screen title="Notifications" onBack={() => setScreen(null)}>
          <PushSettings Toggle={Toggle} />
          <Section title="In the app">
            {CATEGORIES.map((c) => (
              <div key={c}>
                {c !== CATEGORIES[0] && <Divider />}
                <Row
                  icon={<Bell size={16} />}
                  label={CATEGORY_LABELS[c].label}
                  description={CATEGORY_LABELS[c].description}
                  isFirst={c === CATEGORIES[0]}
                  right={
                    <Toggle
                      label={CATEGORY_LABELS[c].label}
                      on={prefs.notify[c]}
                      onChange={(v) => {
                        setPrefs({ notify: { ...prefs.notify, [c]: v } });
                        if (v) void askNotifyPermissionOnce();
                      }}
                    />
                  }
                />
              </div>
            ))}
            <Divider />
            <Row
              icon={<Bell size={16} />}
              label="bMail notification detail"
              description="What a new bMail notification shows. The subject is opened on this phone only."
              right={
                <select
                  aria-label="bMail notification detail"
                  value={prefs.bmailDetail}
                  onChange={(e) => setPrefs({ bmailDetail: e.target.value as 'subject' | 'sender' | 'none' })}
                  className="rounded-lg px-2 py-1 text-xs text-white outline-none"
                  style={{ background: PANEL, border: `1px solid ${LINE}` }}
                >
                  <option value="subject">Sender and subject</option>
                  <option value="sender">Sender only</option>
                  <option value="none">Just "New bMail"</option>
                </select>
              }
            />
            <Divider />
            <Row
              icon={<Bell size={16} />}
              label="Your Twetch user number"
              description="From twetch.com/u/<number>: lets replies and likes on your Twetch posts reach you"
              right={
                <input
                  inputMode="numeric"
                  aria-label="Twetch user number"
                  placeholder="e.g. 13"
                  defaultValue={prefs.twetchUserId}
                  onBlur={(e) => setPrefs({ twetchUserId: e.target.value.replace(/\D/g, '') })}
                  className="w-20 rounded-lg px-2 py-1 text-sm text-white text-right outline-none"
                  style={{ background: PANEL, border: `1px solid ${LINE}` }}
                />
              }
              isLast
            />
          </Section>
        </Screen>
      )}
      {screen === 'terms' && <TermsScreen onBack={() => setScreen(null)} />}
      {screen === 'delete' && <DeleteAccountScreen onBack={() => setScreen(null)} />}
      {screen === 'sweep' && <HdSweepScreen onBack={() => setScreen(null)} />}
      {screen === 'origins' && <OriginsScreen onBack={() => setScreen(null)} />}
      {screen === 'bookmarks' && <BookmarksScreen onBack={() => setScreen(null)} />}
      {screen === 'hidden' && <HiddenScreen onBack={() => setScreen(null)} />}
      {screen === 'signins' && <SignInsScreen onBack={() => setScreen(null)} />}
      {screen === 'tokens' && <MyTokensScreen onBack={() => setScreen(null)} />}
      {screen === 'password' && <ChangePassword onClose={() => setScreen(null)} />}
      {SEEDLESS_ENABLED && screen === 'passkey' && <PasskeySettings onClose={() => setScreen(null)} />}
      {LINK_ACCOUNTS_ENABLED && screen === 'social' && <ConnectSocial onClose={closeSocial} />}
      {handleOpen && <HandleFlow title="Change handle" onClose={() => setHandleOpen(false)} />}
      {screen === 'idmap' && <IdentityMap onClose={() => setScreen(null)} />}
      {screen === 'agents' && <AgentsScreen onClose={() => setScreen(null)} />}
      {screen === 'paired' && (
        <Screen title="Paired websites" onBack={() => setScreen(null)}>
          <PairedSitesList onScan={() => setScreen('scan')} />
        </Screen>
      )}
      {screen === 'pots' && (
        <Suspense fallback={null}>
          <PotsScreen onClose={() => setScreen(null)} />
        </Suspense>
      )}
      {screen === 'scan' && (
        <Suspense fallback={null}>
          <PairSheet allowCli onClose={() => setScreen('paired')} />
        </Suspense>
      )}
    </>
  );
};
