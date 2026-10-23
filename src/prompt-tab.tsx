import { Buffer } from 'buffer';
import process from 'process';
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type {
  CounterpartyPermissionRequest,
  GroupedPermissionRequest,
  PermissionRequest,
} from '@bsv/wallet-toolbox-client';
import { UnlockWallet } from './components/UnlockWallet';
import { PageLoader } from './components/PageLoader';
import { BottomMenuProvider } from './contexts/providers/BottomMenuProvider';
import { ServiceProvider } from './contexts/providers/ServiceProvider';
import { SnackbarProvider } from './contexts/providers/SnackbarProvider';
import { ThemeProvider } from './contexts/providers/ThemeProvider';
import { useServiceContext } from './hooks/useServiceContext';
import { useTheme } from './hooks/useTheme';
import { CounterpartyPermissionRequestPage } from './pages/requests/CounterpartyPermissionRequest';
import { GroupedPermissionRequestPage } from './pages/requests/GroupedPermissionRequest';
import { OneSatPermissionRequestPage } from './pages/requests/OneSatPermissionRequest';
import { PermissionRequestPage } from './pages/requests/PermissionRequest';
import { UsbCheckRequestPage } from './pages/requests/UsbCheckRequest';
import { BundleSheet, type BundlePayload } from './pages/requests/BundleSheet';
import type { OneSatPromptStorageEntry } from './services/oneSatPrompt';
import { sendMessageAsync } from './utils/chromeHelpers';
import type { PromptKind, StreamGrantPrompt, UsbCheckRequest } from './promptProtocol';
import { StreamGrantRequestPage } from './pages/requests/StreamGrantRequest';
import { SiteThemeFrame } from './mobile/theme/SiteThemeFrame';
import './index.css';

global.Buffer = Buffer;
global.process = process;
window.Buffer = Buffer;

type PromptScreen =
  | { kind: 'loading' }
  | { kind: 'expired' }
  | { kind: 'waiting' }
  | { kind: 'unlock' }
  | { kind: 'permission'; requestID: string; payload: PermissionRequest & { requestID: string } }
  | { kind: 'bundle'; requestID: string; payload: BundlePayload }
  | { kind: 'groupedPermission'; requestID: string; payload: GroupedPermissionRequest }
  | { kind: 'counterpartyPermission'; requestID: string; payload: CounterpartyPermissionRequest }
  | { kind: 'oneSatPermission'; requestID: string; payload: OneSatPromptStorageEntry }
  | { kind: 'usbCheck'; requestID: string; payload: UsbCheckRequest }
  | { kind: 'streamGrant'; requestID: string; payload: StreamGrantPrompt };

/** The site a request screen is for (from the request the background checked), for the frame's origin strip. */
const screenOriginator = (s: PromptScreen): string | undefined =>
  'payload' in s ? (s.payload as { originator?: string }).originator || undefined : undefined;

const WAITING_CLOSE_MS = 10000;
const EXPIRED_CLOSE_MS = 2000;

// In-page sheet (docs/ONE-SHEET-PERMISSIONS.md §3d): prompt.html framed over a site by our content script.
const INPAGE_TOKEN = new URLSearchParams(window.location.search).get('inpage');
// Framed by some other page (not our side panel, not our content script's sheet): show nothing.
const FOREIGN_FRAME =
  window.location.protocol === 'chrome-extension:' &&
  window.top !== window &&
  !INPAGE_TOKEN &&
  !!window.location.ancestorOrigins?.length &&
  window.location.ancestorOrigins[0] !== window.location.origin;

/**
 * Arms the in-page sheet: the background must vouch for the token, and the sheet must be fully visible
 * (IntersectionObserver v2) for half a second before anything in it can be clicked. A site can cover or fade
 * the frame, but then the buttons stay off.
 */
const useInPageArmed = (enabled: boolean, target: React.RefObject<HTMLDivElement | null>) => {
  const [tokenOk, setTokenOk] = useState<boolean | undefined>(enabled ? undefined : true);
  const [visible, setVisible] = useState(!enabled);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    sendMessageAsync<{ success: boolean }>({ action: 'INPAGE_SHEET_CHECK', token: INPAGE_TOKEN })
      .then((r) => setTokenOk(!!r?.success))
      .catch(() => setTokenOk(false));
  }, [enabled]);
  useEffect(() => {
    if (!enabled || tokenOk !== true || !target.current) return;
    let timer: number | undefined;
    // `target` is a small marker at the top of the sheet, not the whole sheet: a full-height box
    // sized with calc(100vh - 41px) can round to 99.9% visible and never reach a 1.0 threshold,
    // which left the buttons dead (owner, 11 Oct 2026, bChatX /welcome). The clickjacking guard
    // stays: Chrome's isVisible (IntersectionObserver v2) must still say nothing covers the frame.
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean };
        window.clearTimeout(timer);
        if (e.isVisible && e.intersectionRatio >= 0.99) timer = window.setTimeout(() => setVisible(true), 500);
        else setVisible(false);
      },
      { threshold: [0, 0.99, 1.0], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
    );
    io.observe(target.current);
    return () => {
      window.clearTimeout(timer);
      io.disconnect();
    };
  }, [enabled, target, tokenOk]);
  // Still not armed after 1.5s: offer the wallet's own popup window (see MOVE_PROMPT_TO_WINDOW).
  useEffect(() => {
    if (!enabled || visible) {
      setStuck(false);
      return;
    }
    const t = window.setTimeout(() => setStuck(true), 1500);
    return () => window.clearTimeout(t);
  }, [enabled, visible]);
  return { tokenOk, armed: tokenOk === true && visible, stuck: tokenOk === true && !visible && stuck };
};

const PromptApp = () => {
  const { theme } = useTheme();
  const { isLocked, isReady } = useServiceContext();
  const sheetRef = useRef<HTMLDivElement>(null);
  const armMarkerRef = useRef<HTMLDivElement>(null);
  const inPage = useInPageArmed(!!INPAGE_TOKEN, armMarkerRef);
  // b-Aware report (23 Oct 2026): a foreign page could frame prompt.html?inpage=<anything> and mount the prompt
  // flow (GET_NEXT_PROMPT / GET_PROMPT_PAYLOAD / CLOSE_PROMPT_WINDOW) while the token check was still pending.
  // Nothing talks to the background about prompts until the background has vouched for the in-page token.
  const allowed = !FOREIGN_FRAME && inPage.tokenOk === true;
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  const [screen, setScreen] = useState<PromptScreen>({ kind: 'loading' });
  const waitingTimer = useRef<number | undefined>(undefined);
  const advanceRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const clearWaitingTimer = () => {
    if (waitingTimer.current !== undefined) {
      window.clearTimeout(waitingTimer.current);
      waitingTimer.current = undefined;
    }
  };

  const screenRef = useRef<PromptScreen>(screen);
  screenRef.current = screen;

  const loadPrompt = useCallback(async (kind: PromptKind, requestID: string) => {
    clearWaitingTimer();
    // A request joined the sheet that is already showing: refresh it in place so the user's ticks stay.
    const cur = screenRef.current;
    if (kind === 'bundle' && cur.kind === 'bundle' && cur.requestID === requestID) {
      try {
        const res = await sendMessageAsync<{ success: boolean; data?: BundlePayload }>({
          action: 'GET_PROMPT_PAYLOAD',
          kind,
          requestID,
        });
        if (res?.success && res.data) setScreen({ kind: 'bundle', requestID, payload: res.data });
      } catch {
        /* keep showing what we have */
      }
      return;
    }
    setScreen({ kind: 'loading' });
    let res: { success: boolean; data?: unknown } | undefined;
    try {
      res = await sendMessageAsync<{ success: boolean; data?: unknown }>({
        action: 'GET_PROMPT_PAYLOAD',
        kind,
        requestID,
      });
    } catch {
      res = undefined;
    }
    if (res?.success && res.data) {
      // USB unlock is checked by the Approve button itself (confirmUsbForApproval),
      // so the request renders immediately.
      setScreen({ kind, requestID, payload: res.data } as PromptScreen);
    } else {
      setScreen({ kind: 'expired' });
      window.setTimeout(() => void advanceRef.current?.(), EXPIRED_CLOSE_MS);
    }
  }, []);

  /**
   * Ask the background to close this window. It closes only if nothing is
   * pending at that instant; otherwise it returns the prompt to render next.
   * The window never calls window.close() itself while the background is
   * reachable, because the background treats an unexplained close as the
   * user dismissing every pending prompt.
   */
  const requestClose = useCallback(async () => {
    clearWaitingTimer();
    let res: { success: boolean; data?: { prompt?: { kind: PromptKind; requestID?: string } } } | undefined;
    try {
      res = await sendMessageAsync<{ success: boolean; data?: { prompt?: { kind: PromptKind; requestID?: string } } }>({
        action: 'CLOSE_PROMPT_WINDOW',
      });
    } catch {
      res = undefined;
    }
    if (res === undefined) {
      // Background unreachable (e.g. service worker gone): nothing to deny.
      window.close();
      return;
    }
    const next = res.data?.prompt;
    if (!next) return; // background is closing us
    if (next.kind === 'unlock') setScreen({ kind: 'unlock' });
    else if (next.requestID) await loadPrompt(next.kind, next.requestID);
  }, [loadPrompt]);

  const advance = useCallback(async () => {
    clearWaitingTimer();
    let res:
      | { success: boolean; data?: { prompt?: { kind: PromptKind; requestID: string }; busy?: boolean } }
      | undefined;
    try {
      res = await sendMessageAsync<{
        success: boolean;
        data?: { prompt?: { kind: PromptKind; requestID: string }; busy?: boolean };
      }>({
        action: 'GET_NEXT_PROMPT',
      });
    } catch {
      res = undefined;
    }
    if (res?.data?.prompt) {
      await loadPrompt(res.data.prompt.kind, res.data.prompt.requestID);
      return;
    }
    if (res?.data?.busy) {
      setScreen({ kind: 'waiting' });
      waitingTimer.current = window.setTimeout(() => void requestClose(), WAITING_CLOSE_MS);
      return;
    }
    await requestClose();
  }, [loadPrompt, requestClose]);

  advanceRef.current = advance;

  useEffect(() => {
    if (!isReady || !allowed) return;
    const params = new URLSearchParams(window.location.search);
    const kind = params.get('kind') as PromptKind | null;
    const requestID = params.get('requestID');
    if (kind === 'unlock') {
      if (isLocked) setScreen({ kind: 'unlock' });
      else void advance();
      return;
    }
    if (kind && requestID) {
      void loadPrompt(kind, requestID);
      return;
    }
    void advance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, allowed]);

  useEffect(() => {
    const listener = (message: { action?: string; kind?: PromptKind; requestID?: string }) => {
      if (message?.action !== 'SHOW_PROMPT' || !message.kind || !allowedRef.current) return;
      if (message.kind === 'unlock') {
        clearWaitingTimer();
        setScreen({ kind: 'unlock' });
        return;
      }
      if (message.requestID) void loadPrompt(message.kind, message.requestID);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [loadPrompt]);

  const walletBg = theme.color.global.walletBackground;

  // Still waiting for the background to vouch for the in-page token: render nothing yet.
  if (!FOREIGN_FRAME && INPAGE_TOKEN && inPage.tokenOk === undefined) return null;
  if (!allowed) {
    return (
      <p className="text-xs p-4" style={{ color: '#98A2B3' }}>
        Open bWalletX to answer this request.
      </p>
    );
  }

  return (
    <MemoryRouter>
      {INPAGE_TOKEN && (
        <div
          className="flex items-center justify-between px-3 py-2"
          style={{ background: walletBg, borderBottom: '1px solid #ffffff14' }}
        >
          <span className="text-sm font-bold" style={{ color: theme.color.global.contrast }}>
            bWalletX
          </span>
          {inPage.stuck && (
            <button
              type="button"
              className="text-xs font-bold border-0 rounded-full px-3 py-1"
              style={{ background: '#F5C542', color: '#0b0a08' }}
              onClick={() => chrome.runtime.sendMessage({ action: 'MOVE_PROMPT_TO_WINDOW' }).catch(() => undefined)}
            >
              Open in bWalletX
            </button>
          )}
          <button
            type="button"
            aria-label="Deny and close"
            className="text-sm border-0 bg-transparent p-1"
            style={{ color: theme.color.global.gray }}
            onClick={() => chrome.runtime.sendMessage({ action: 'DISMISS_PROMPT_PANEL' }).catch(() => undefined)}
          >
            ✕
          </button>
        </div>
      )}
      <div
        ref={sheetRef}
        className="flex items-center justify-center relative p-0"
        style={{
          width: INPAGE_TOKEN ? '100%' : 'var(--wallet-width)',
          height: INPAGE_TOKEN ? 'calc(100vh - 41px)' : 'var(--wallet-height)',
          backgroundColor: walletBg,
          pointerEvents: inPage.armed ? undefined : 'none',
        }}
      >
        {INPAGE_TOKEN && (
          <div
            ref={armMarkerRef}
            aria-hidden
            style={{ position: 'absolute', top: 0, left: 0, width: 24, height: 24, pointerEvents: 'none' }}
          />
        )}
        {(!isReady || screen.kind === 'loading') && <PageLoader message="Loading..." theme={theme} />}
        {screen.kind === 'waiting' && <PageLoader message="Waiting for request..." theme={theme} />}
        {screen.kind === 'expired' && (
          <p className="text-xs" style={{ color: theme.color.global.gray }}>
            This request expired or was already handled.
          </p>
        )}
        {screen.kind === 'unlock' && <UnlockWallet onUnlock={() => void advance()} />}
        {/* Wallet strip (true origin) + the connected site's theme banner (docs/SITE-THEME.md); the sheet is untouched. */}
        <SiteThemeFrame originator={screenOriginator(screen)}>
          {screen.kind === 'permission' && (
            <PermissionRequestPage key={screen.requestID} request={screen.payload} onResponse={() => void advance()} />
          )}
          {screen.kind === 'bundle' && (
            <BundleSheet key={screen.requestID} request={screen.payload} onResponse={() => void advance()} />
          )}
          {screen.kind === 'groupedPermission' && (
            <GroupedPermissionRequestPage
              key={screen.requestID}
              request={screen.payload}
              onResponse={() => void advance()}
            />
          )}
          {screen.kind === 'counterpartyPermission' && (
            <CounterpartyPermissionRequestPage
              key={screen.requestID}
              request={screen.payload}
              onResponse={() => void advance()}
            />
          )}
          {screen.kind === 'oneSatPermission' && (
            <OneSatPermissionRequestPage
              key={screen.requestID}
              request={screen.payload}
              onResponse={() => void advance()}
            />
          )}
          {screen.kind === 'streamGrant' && (
            <StreamGrantRequestPage key={screen.requestID} request={screen.payload} onResponse={() => void advance()} />
          )}
          {screen.kind === 'usbCheck' && (
            <UsbCheckRequestPage key={screen.requestID} request={screen.payload} onResponse={() => void advance()} />
          )}
        </SiteThemeFrame>
      </div>
    </MemoryRouter>
  );
};

const root = document.getElementById('root');
if (!root) throw new Error('Root element');
ReactDOM.createRoot(root).render(
  <ServiceProvider>
    <ThemeProvider>
      <BottomMenuProvider>
        <SnackbarProvider>
          <PromptApp />
        </SnackbarProvider>
      </BottomMenuProvider>
    </ThemeProvider>
  </ServiceProvider>,
);
