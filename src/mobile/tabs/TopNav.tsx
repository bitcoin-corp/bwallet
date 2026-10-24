import { routeFor } from './tabs';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInPeek } from '../phone/pageEl';
import { useBackClose } from '../backStack';
import { useAccountNames } from '../names/accountNames';
import { AccountRow } from '../account/AccountSwitcher';
import { AgentsSheet, SwitchAccountSheet } from '../account/AccountSheets';
import { useMenuAccounts, useSignOut } from '../account/useMenuAccounts';
import { getRecent, inlineAccounts, orderAccounts } from '../account/accountMenu';
import { useAccountSwitch } from '../account/accountSwitch';
import { AccountStrip } from '../account/AccountStrip';
import { useKyc } from '../kyc/useKyc';
import { kycValid } from '../kyc/kyc';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BadgeCheck,
  Bot,
  ChevronRight,
  Lock,
  LogOut,
  Phone,
  Play,
  Plus,
  ScanLine,
  Settings,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { agentMenuTarget, showAgentInMenu } from './agentEntry';
import { phoneLayoutOn, usePhoneLayout } from '../phone/flag';
import { BappAppButton } from '../phone/BappBar';
import { topBarBappForPath } from '../phone/bappBarModel';
import { startAgentCreate } from '../agents/agentCreate';
import { AGENT_TOOLS_TITLE, AgentToolsSheet } from '../agents/AgentToolsSheet';
import { AirdropsNavButton } from '../airdrops/AirdropsNavButton';
import { isBWalletX } from '../storeBuild';
import { IS_EXTENSION } from '../extension';
import { initPairing, setAgentPairDeps } from '../pair/sessions';
import { onPairLink, takePairLink } from '../pair/links';
import { useSpaceInviteLinks } from '../spaces/inviteLinks';
import { useSubscribeLinks } from '../pots/subscribeLink';
import { AuthRequestHost } from '../auth/AuthSheet';

const PairSheet = lazy(() => import('../pair/PairSheet'));
const ScanSheet = lazy(() => import('../scan/ScanSheet'));
import { useTheme } from '../../hooks/useTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { CALLS_ROUTE } from '../calls/route';
import { DrawerHandle } from '../names/DrawerHandle';
import { HandleFlow } from '../names/HandleFlow';

const BavatarMintSheet = lazy(() => import('../bavatar/BavatarMintSheet'));
import { useLocation, useNavigate } from 'react-router-dom';
import { MenuAvatarButton } from './MenuAvatarButton';
import { WIDE_ON, WW_OPEN, type WwOpen } from '../wide/flag';
import { isWebApp } from '../webApp';
import { lockShortcutLabel, useLockShortcut } from '../lockShortcut';
import { touchScreen } from '../phone/pullHint';

/**
 * Mobile swap for src/components/TopNav.tsx (vite.config.mobile.ts).
 * A hamburger at top-left opens a left drawer with the current account (name, handle,
 * verified), every account, Add / Import account and Settings. The centred b opens the
 * b agent (/m/ask-b).
 * Switching reuses upstream TopNav's sequence verbatim.
 */
// Logo (owner, 4 Oct 2026): no x in any logo. Both editions now share bWalletX's look, gold b on black (store
// parity, 10 Oct 2026: the yellow store bar looked unfinished beside bWalletX). X_MARK still gates the agent tools.
const X_MARK = isBWalletX();
const BAR_BG: string | undefined = undefined;
const ICON = '#F2F2F0';
const ACCENT = 'var(--bw-accent)';
const RING = '1px solid #2A2A2C';
const PAIR_LABEL = IS_EXTENSION ? 'Connect the CLI / an AI assistant' : 'Scan to connect a website';

/** Padlock with a coin: Lock BSV (time-locks), not "lock the app". */
export const LockCoin = ({ color, accent }: { color: string; accent: string }) => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3" y="11" width="13" height="10" rx="2" stroke={color} strokeWidth="2" />
    <path d="M6 11V7.5a3.5 3.5 0 0 1 7 0V11" stroke={color} strokeWidth="2" strokeLinecap="round" />
    <circle cx="17.5" cy="16.5" r="5.5" fill={accent} stroke="#010101" strokeWidth="1" />
    <path
      d="M17.5 13.6v5.8M16 14.9h2.2a1 1 0 0 1 0 1.6h-1.4a1 1 0 0 0 0 1.6H19"
      stroke="#010101"
      strokeWidth="1.1"
      strokeLinecap="round"
    />
  </svg>
);

export const TopNav = () => {
  // A neighbour page shown during a page drag: the real bar is already on screen.
  if (useInPeek()) return null;
  return <TopNavBar />;
};

const TopNavBar = () => {
  const { theme } = useTheme();
  const { chromeStorageService, apiContext, lockWallet } = useServiceContext();
  const phone = usePhoneLayout();
  const { handleSelect } = useBottomMenu();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const onMedia = pathname.startsWith('/m/media');
  const onLock = pathname.startsWith('/m/lock');
  const [drawer, setDrawer] = useState(false);
  const [handleOpen, setHandleOpen] = useState(false);
  // bPhone Calls opens in the content area (/m/calls, owner 9 Oct 2026, as bMail); tapping the button again leaves.
  const onCalls = pathname.startsWith(CALLS_ROUTE);
  /** In a bApp (phone layout): its icon sits after the bPhone button and opens the app's sections. bPhone stays put. */
  const bapp = phone ? topBarBappForPath(pathname) : null;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [mintOpen, setMintOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  // Phone: ☰ "Scan to connect a website" opens the one Scan sheet (pay codes, people, pairing).
  // Extension keeps the paste-first pairing screen (a desktop can't scan its own screen).
  const [scanOpen, setScanOpen] = useState(false);
  const openScan = () => (IS_EXTENSION ? setPairOpen(true) : setScanOpen(true));
  const [sheet, setSheet] = useState<'accounts' | 'agents' | null>(null);
  const [confirmOut, setConfirmOut] = useState(false);
  const signOut = useSignOut();
  // ⌘L / Ctrl+L locks the web app, as in the wide layout (whose shell has its own listener).
  const webKeys = !WIDE_ON && isWebApp();
  useLockShortcut(webKeys, lockWallet);
  const lockHint = webKeys && !touchScreen() ? lockShortcutLabel() : '';
  const [pairLink, setPairLink] = useState<string | null>(null);
  // A pairing QR scanned with the phone's camera opened the app (pair/links.ts): go straight to confirm.
  // Phone layout: PhoneShell owns pair links, pairing and the CLI wallet context, once (phone/useAppServices.ts).
  // Space invite links (spaces/inviteLinks.ts); PhoneShell owns them in the phone layout.
  useSpaceInviteLinks(!phoneLayoutOn());
  useSubscribeLinks(!phoneLayoutOn());
  useEffect(() => {
    if (phoneLayoutOn()) return;
    const show = () => {
      const url = takePairLink();
      if (url) {
        setPairLink(url);
        setPairOpen(true);
      }
    };
    show();
    return onPairLink(show);
  }, []);
  // Reconnect paired sites / CLIs. In the extension the sessions live in this page (side panel), since the
  // wallet keys and context only exist here; the background worker only hands over pair links (links.ts).
  useEffect(() => {
    if (!phoneLayoutOn()) initPairing();
  }, []);
  // Wide web layout: the sidebar / top bar open this bar's drawer and sheets (wide/WideShell.tsx).
  useEffect(() => {
    if (!WIDE_ON) return;
    const on = (e: Event) => {
      const w = (e as CustomEvent<WwOpen>).detail;
      if (w === 'drawer') setDrawer((d) => !d);
      else if (w === 'scan') openScan();
      else if (w === 'pair') setPairOpen(true);
      else if (w === 'tools') setToolsOpen(true);
      else if (w === 'add-agent') {
        startAgentCreate();
        go('create-account');
      } else setSheet(w);
    };
    window.addEventListener(WW_OPEN, on);
    return () => window.removeEventListener(WW_OPEN, on);
    // Registered once; go only navigates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Same as upstream TopNav.handleSwitchAccount (shared with the account strip and Settings).
  const { switchingTo, switchAccount: handleSwitchAccount } = useAccountSwitch(() => setDrawer(false));

  useBackClose(drawer && !switchingTo, () => setDrawer(false));
  // Wide dropdown: Escape closes it.
  useEffect(() => {
    if (!WIDE_ON || !drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !switchingTo) setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, switchingTo]);
  const accountObj = chromeStorageService.getCurrentAccountObject();
  const current = accountObj.account?.addresses.identityAddress;
  // Paired bWalletX CLI / MCP calls run on the open account with this wallet context (pair/agentPairing.ts).
  useEffect(() => {
    if (phoneLayoutOn()) return;
    setAgentPairDeps({
      ctx: apiContext,
      currentId: current,
      feeRate: () => chromeStorageService.getCustomFeeRate(),
      accountCount: chromeStorageService.getAllAccounts().length,
    });
  }, [apiContext, current, chromeStorageService]);
  // Display name = BAP profile name (else account name); payable handle = OpNS name / paymail. Synced from chain.
  const names = useAccountNames(
    current,
    accountObj.account?.name ?? '',
    accountObj.account?.settings?.socialProfile?.displayName ?? '',
  );
  const { people, agents } = useMenuAccounts();
  // Recent order is read when the drawer opens (switching reloads the app anyway).
  const recent = useMemo(getRecent, [drawer]);
  // Owner, 9 Oct 2026: every account in one scrolling column (current, recent, then A–Z), agents below them.
  const listed = inlineAccounts(people, current, recent, Infinity).shown;
  const listedAgents = orderAccounts(agents, { recent }).recent.concat(orderAccounts(agents, { recent }).rest);
  useEffect(() => {
    if (!drawer) setConfirmOut(false);
  }, [drawer]);
  const { kyc } = useKyc();
  const verified = kycValid(kyc, Date.now());

  const go = (query?: string) => {
    setDrawer(false);
    handleSelect('settings', query);
    // Selecting the already-selected Settings changes nothing, so route explicitly (e.g. from Media).
    const route = routeFor('settings');
    if (route) navigate(route);
  };

  const action = (icon: React.ReactNode, label: string, onClick: () => void, more = false) => (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left active:bg-white/5"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2b2f36]">{icon}</span>
      <span className="min-w-0 flex-1 text-sm font-semibold text-white">{label}</span>
      {more && <ChevronRight size={16} color="#98A2B3" />}
    </button>
  );

  const signOutBlock = () =>
    confirmOut ? (
      <div className="flex flex-col gap-2 px-1">
        <span className="text-xs" style={{ color: '#D0D5DD' }}>
          Sign this account out of chat and lock the wallet?
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setConfirmOut(false)}
            className="flex-1 rounded-xl py-2.5 text-sm font-semibold text-white border-0"
            style={{ background: '#2b2f36' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmOut(false);
              setDrawer(false);
              void signOut(current);
            }}
            className="flex-1 rounded-xl py-2.5 text-sm font-bold border-0"
            style={{ background: '#F04438', color: '#fff' }}
          >
            Sign out
          </button>
        </div>
      </div>
    ) : (
      <button
        type="button"
        onClick={() => setConfirmOut(true)}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left border-0 bg-transparent hover:bg-white/5"
      >
        <LogOut size={16} color="#F97066" />
        <span className="text-sm font-semibold" style={{ color: '#F97066' }}>
          Sign out
        </span>
      </button>
    );

  const wideMenu = () => {
    const chip = document.querySelector('.ww-account')?.getBoundingClientRect();
    const top = chip ? chip.bottom + 6 : 72;
    const left = chip ? chip.left : 16;
    return (
      <div className="fixed inset-0 z-[1000]" onMouseDown={() => !switchingTo && setDrawer(false)}>
        <div
          role="dialog"
          aria-label="Accounts"
          className="ww-acctmenu fixed flex flex-col rounded-2xl border border-white/10 shadow-2xl"
          style={{
            top,
            left,
            width: 320,
            maxHeight: `min(560px, calc(100vh - ${top + 16}px))`,
            background: '#101114',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2" role="listbox" aria-label="Accounts">
            {listed.map((a) => (
              <AccountRow
                key={a.id}
                account={a.account}
                current={current}
                switchingTo={switchingTo}
                onSwitch={(id) => void handleSwitchAccount(id)}
                verified={verified}
              />
            ))}
            {listedAgents.length > 0 && (
              <div
                className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: '#667085' }}
              >
                Agents
              </div>
            )}
            {listedAgents.map((a) => (
              <AccountRow
                key={a.id}
                account={a.account}
                current={current}
                switchingTo={switchingTo}
                onSwitch={(id) => void handleSwitchAccount(id)}
                verified={verified}
              />
            ))}
          </div>
          <div className="shrink-0 border-t border-white/5 px-2 py-2">
            {action(<Plus size={16} color="#fff" />, 'Add account', () => go('restore-account'))}
            {X_MARK &&
              action(<Bot size={16} color="#fff" />, 'Add agent account', () => {
                startAgentCreate();
                go('create-account');
              })}
          </div>
          <div className="shrink-0 border-t border-white/5 px-2 py-2">{signOutBlock()}</div>
        </div>
      </div>
    );
  };

  return (
    <>
      {!WIDE_ON && <>{!phone && <AccountStrip />}</>}
      {WIDE_ON ? null : phone ? (
        // Portalled to <body> so a page drag (phone/pager.tsx) never moves the bar.
        createPortal(
          // Phone layout (test switch, owner round 3): one row, evenly spaced, icons only:
          // Accounts · Calls · Airdrops · Media · Lock. No account strip above it.
          <div
            className="bw-topnav grid items-center justify-items-center fixed top-0 w-full z-10 px-2 h-14 overflow-hidden"
            style={{
              backgroundColor: BAR_BG ?? theme.color.global.walletBackground,
              top: 'var(--wallet-inset-top)',
              // One row always: five slots, six when a bApp's own button is in (bMail…). A fixed 5-column grid
              // wrapped the sixth (Lock BSV) onto a second row over the page's back button (18 Oct 2026).
              gridTemplateColumns: `repeat(${bapp ? 6 : 5}, minmax(0, 1fr))`,
            }}
          >
            <MenuAvatarButton
              identityAddress={current}
              ring={RING}
              onOpen={() => setDrawer(true)}
              onLongPress={() => setSheet('accounts')}
            />
            <button
              type="button"
              aria-label="Calls"
              aria-pressed={onCalls}
              onClick={() => (onCalls ? navigate(-1) : navigate(CALLS_ROUTE))}
              className="w-9 h-9 rounded-full flex items-center justify-center cursor-pointer"
              style={{
                border: onCalls ? `1px solid ${ACCENT}` : RING,
                background: onCalls ? `color-mix(in srgb, ${ACCENT} 20%, transparent)` : 'transparent',
              }}
            >
              <Phone size={16} color={ACCENT} />
            </button>
            {bapp && <BappAppButton def={bapp} onGo={(route) => navigate(route, { replace: true })} />}
            {/* Owner, 8 Oct 2026: the airdrops inbox takes the b's slot (the agent stays on the dock b and pull-down). */}
            <AirdropsNavButton color={ACCENT} ring={RING} />
            <button
              type="button"
              aria-label="Media"
              onClick={() => (onMedia ? navigate(-1) : navigate('/m/media'))}
              aria-pressed={onMedia}
              className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
              style={{ border: RING }}
            >
              <Play size={16} color={ACCENT} fill={ACCENT} />
            </button>
            {/* Owner, 7 Oct 2026: this is Lock BSV (time-locks, /m/lock). Locking the app moved to the Accounts menu. */}
            <button
              type="button"
              aria-label="Lock BSV"
              onClick={() => (onLock ? navigate(-1) : navigate('/m/lock'))}
              aria-pressed={onLock}
              className="relative w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
              style={{ border: RING }}
            >
              {/* Owner, 15 Oct 2026: a clear padlock like its neighbours (the coin badge read as a smudge on light
                  themes); the coin is now a small corner dot that leaves the shape alone. */}
              <Lock size={16} color={ACCENT} strokeWidth={2.25} />
              <span
                aria-hidden
                className="absolute rounded-full"
                style={{
                  top: 3,
                  right: 3,
                  width: 7,
                  height: 7,
                  background: ACCENT,
                  boxShadow: '0 0 0 1.5px var(--bw-pack-bg, #010101)',
                }}
              />
            </button>
          </div>,
          document.body,
        )
      ) : (
        // Five equal slots: Accounts · Calls · Airdrops · Media · Settings.
        <div
          className="bw-topnav grid grid-cols-5 items-center fixed top-0 w-full z-10 px-2 h-14 justify-items-center"
          style={{ backgroundColor: BAR_BG ?? theme.color.global.walletBackground, top: 'var(--wallet-inset-top)' }}
        >
          <MenuAvatarButton
            identityAddress={current}
            ring={RING}
            onOpen={() => setDrawer(true)}
            onLongPress={() => setSheet('accounts')}
          />
          <button
            type="button"
            aria-label="Calls"
            aria-pressed={onCalls}
            onClick={() => (onCalls ? navigate(-1) : navigate(CALLS_ROUTE))}
            className="w-9 h-9 rounded-full flex items-center justify-center cursor-pointer"
            style={{
              border: onCalls ? `1px solid ${ACCENT}` : RING,
              background: onCalls ? `color-mix(in srgb, ${ACCENT} 20%, transparent)` : 'transparent',
            }}
          >
            <Phone size={16} color={ACCENT} />
          </button>
          {/* Owner, 8 Oct 2026: the airdrops inbox takes the b's slot. */}
          <AirdropsNavButton color={ACCENT} ring={RING} />
          <button
            type="button"
            aria-label="Media"
            onClick={() => (onMedia ? navigate(-1) : navigate('/m/media'))}
            aria-pressed={onMedia}
            className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
            style={{ border: RING }}
          >
            <Play size={16} color={ACCENT} fill={ACCENT} />
          </button>
          <button
            type="button"
            aria-label="Settings"
            onClick={() => go()}
            className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
            style={{ border: RING }}
          >
            <Settings size={16} color={ICON} />
          </button>
        </div>
      )}

      {/* Wide web layout (D7): a dropdown anchored under the sidebar account chip, not the phone drawer. Settings,
          Connect CLI & MCP and Ask b live in the sidebar, so only accounts, add and sign out are here. */}
      {WIDE_ON && drawer && createPortal(wideMenu(), document.body)}
      <AnimatePresence>
        {drawer && !WIDE_ON && (
          <motion.div
            className="bw-drawer-scrim fixed inset-0 z-[300] bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !switchingTo && setDrawer(false)}
          >
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 420, damping: 40 }}
              className="absolute left-0 top-0 w-[82%] max-w-[340px] flex flex-col bg-[#101114] border-r border-white/5"
              // Owner, 9 Oct 2026: Settings and Sign out were hidden behind the bottom dock. The panel ends above the
              // dock (its height + the safe-area inset), the account list scrolls and the bottom group stays visible.
              style={{
                paddingTop: 'env(safe-area-inset-top)',
                bottom: 'calc(var(--dock-h, 3.75rem) + env(safe-area-inset-bottom, 0px))',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 h-14">
                <span className="text-base font-bold text-white">Accounts</span>
                <button aria-label="Close" onClick={() => setDrawer(false)} className="p-2">
                  <X size={18} color="#98A2B3" />
                </button>
              </div>
              <DrawerHandle
                identityAddress={current}
                paymail={names.paymail}
                handle={names.handle}
                names={names.names}
                shown={names.payable}
                onNavigate={() => setDrawer(false)}
                onGetName={() => {
                  setDrawer(false);
                  setHandleOpen(true);
                }}
              />
              <div className="min-h-0 flex-1 overflow-y-auto px-2" role="listbox" aria-label="Accounts">
                {listed.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a.account}
                    current={current}
                    switchingTo={switchingTo}
                    onSwitch={(id) => void handleSwitchAccount(id)}
                    verified={verified}
                  />
                ))}
                {listedAgents.length > 0 && (
                  <div
                    className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: '#667085' }}
                  >
                    Agents
                  </div>
                )}
                {listedAgents.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a.account}
                    current={current}
                    switchingTo={switchingTo}
                    onSwitch={(id) => void handleSwitchAccount(id)}
                    verified={verified}
                  />
                ))}
              </div>
              <div className="shrink-0 border-t border-white/5 px-2 pt-2 pb-2">
                {/* Owner, 9 Oct 2026: Add account, Add agent account, Connect CLI & MCP, then Settings. */}
                {action(<Plus size={16} color="#fff" />, 'Add account', () => go('restore-account'))}
                {/* bAvatar mint (owner, 11 Oct 2026): this account's art, $name and signup number as a 1-sat ordinal. */}
                {action(<BadgeCheck size={16} color="#fff" />, 'Mint my bAvatar', () => {
                  setDrawer(false);
                  setMintOpen(true);
                })}
                {X_MARK &&
                  action(<Bot size={16} color="#fff" />, 'Add agent account', () => {
                    startAgentCreate();
                    go('create-account');
                  })}
                {X_MARK &&
                  action(<Terminal size={16} color="#fff" />, 'Connect CLI & MCP', () => {
                    setDrawer(false);
                    setToolsOpen(true);
                  })}
                {/* The classic layout reaches the b agent here (the phone layout has the dock b). */}
                {showAgentInMenu(phone) &&
                  action(<Sparkles size={16} color="#fff" />, 'Ask b', () => {
                    setDrawer(false);
                    const to = agentMenuTarget(pathname);
                    if (to === -1) navigate(-1);
                    else navigate(to);
                  })}
                {/* Store builds have no agent tools: pairing stays a menu row, as before. */}
                {!X_MARK &&
                  action(<ScanLine size={16} color="#fff" />, PAIR_LABEL, () => {
                    setDrawer(false);
                    openScan();
                  })}
                {/* Settings is the most important item in this section (owner, 8 Oct 2026). */}
                <button
                  type="button"
                  onClick={() => go()}
                  className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left border-0 active:bg-white/10"
                  style={{ background: 'var(--bw-surface)' }}
                >
                  <span
                    className="flex h-8 w-8 items-center justify-center rounded-full"
                    style={{ background: 'var(--bw-accent)' }}
                  >
                    <Settings size={16} color="#010101" />
                  </span>
                  <span className="text-[15px] font-bold text-white">Settings</span>
                </button>
              </div>
              <div className="mt-2 border-t border-white/5 px-2 py-2">
                {confirmOut ? (
                  <div className="flex flex-col gap-2 px-1">
                    <span className="text-xs" style={{ color: '#D0D5DD' }}>
                      Sign this account out of chat and lock the wallet?
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmOut(false)}
                        className="flex-1 rounded-xl py-2.5 text-sm font-semibold text-white border-0"
                        style={{ background: '#2b2f36' }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmOut(false);
                          setDrawer(false);
                          void signOut(current);
                        }}
                        className="flex-1 rounded-xl py-2.5 text-sm font-bold border-0"
                        style={{ background: '#F04438', color: '#fff' }}
                      >
                        Sign out
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmOut(true)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left border-0 bg-transparent active:bg-white/5"
                    >
                      <LogOut size={16} color="#F97066" />
                      <span className="text-sm font-semibold" style={{ color: '#F97066' }}>
                        Sign out
                      </span>
                    </button>
                    {/* A small labelled button, not a bare padlock (the release check of 19 Oct 2026 missed the icon)
                        and not the old full-width row (removed 8 Oct 2026). */}
                    <button
                      type="button"
                      aria-label="Lock wallet"
                      title={`Lock wallet${lockHint ? ` (${lockHint})` : ''}`}
                      onClick={() => {
                        setDrawer(false);
                        void lockWallet();
                      }}
                      className="flex h-10 shrink-0 items-center gap-2 rounded-full border-0 px-3.5"
                      style={{ background: '#2b2f36' }}
                    >
                      <Lock size={16} color="#fff" />
                      <span className="text-sm font-semibold text-white">Lock</span>
                      {lockHint && (
                        <kbd className="text-[11px] font-sans" style={{ color: '#98A2B3' }}>
                          {lockHint}
                        </kbd>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {sheet === 'accounts' && (
        <SwitchAccountSheet
          onClose={() => setSheet(null)}
          current={current}
          switchingTo={switchingTo}
          onSwitch={(id) => void handleSwitchAccount(id)}
          verified={verified}
          onAdd={() => {
            setSheet(null);
            go('restore-account');
          }}
          onImport={() => {
            setSheet(null);
            go('restore-account');
          }}
        />
      )}
      {sheet === 'agents' && (
        <AgentsSheet
          onClose={() => setSheet(null)}
          current={current}
          switchingTo={switchingTo}
          onSwitch={(id) => void handleSwitchAccount(id)}
          verified={verified}
          toolsLabel={AGENT_TOOLS_TITLE}
          // 5.1.86: the top-bar b is now Airdrops, so the classic layout reaches the b agent here
          // (the phone layout has the dock b hold and pull-down). Same toggle as the old b.
          onAgent={
            showAgentInMenu(phone)
              ? {
                  label: 'Ask b',
                  go: () => {
                    setSheet(null);
                    setDrawer(false);
                    const to = agentMenuTarget(pathname);
                    if (to === -1) navigate(-1);
                    else navigate(to);
                  },
                }
              : undefined
          }
          // bWalletX only: agent accounts and the tools that drive them (owner, 6 Oct 2026).
          onAddAgent={
            X_MARK
              ? () => {
                  setSheet(null);
                  startAgentCreate();
                  go('create-account');
                }
              : undefined
          }
          onTools={
            X_MARK
              ? () => {
                  setSheet(null);
                  setDrawer(false);
                  setToolsOpen(true);
                }
              : undefined
          }
        />
      )}
      {mintOpen && (
        <Suspense fallback={null}>
          <BavatarMintSheet onClose={() => setMintOpen(false)} />
        </Suspense>
      )}
      {toolsOpen && (
        <AgentToolsSheet
          onClose={() => setToolsOpen(false)}
          pairLabel={PAIR_LABEL}
          onPair={() => {
            setToolsOpen(false);
            openScan();
          }}
        />
      )}
      {!phoneLayoutOn() && <AuthRequestHost />}
      {pairOpen && (
        <Suspense fallback={null}>
          <PairSheet
            initial={pairLink ?? undefined}
            onClose={() => {
              setPairOpen(false);
              setPairLink(null);
            }}
          />
        </Suspense>
      )}
      {scanOpen && (
        <Suspense fallback={null}>
          <ScanSheet onClose={() => setScanOpen(false)} />
        </Suspense>
      )}
      {handleOpen && <HandleFlow onClose={() => setHandleOpen(false)} />}
    </>
  );
};
