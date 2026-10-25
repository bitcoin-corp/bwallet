/**
 * Whether an approval prompt should render inside the open wallet panel (PanelPrompt.tsx) rather than in its
 * own window/overlay. Only the Chrome extension draws PanelPrompt; it is the only build with chrome.sidePanel.
 * The phone and web wallet connect the same 'extension-popup' port but show prompts as overlays above
 * everything (including a framed bApp), so they must never take the panel path.
 */
export const promptsShowInPanel = (openPanels: number, chromeApi: unknown): boolean =>
  openPanels > 0 && !!(chromeApi as { sidePanel?: unknown } | undefined)?.sidePanel;

type Prompt = { kind: string; requestID?: string };

/**
 * What to show in a wallet panel that has just connected its port (or said it is ready). The prompt the background
 * opened the panel for comes first; otherwise the oldest queued prompt. A request must never wait for a click,
 * scroll or key press in the page to appear (owner, 25 Oct 2026, extension 5.2.x after a Chrome restart).
 */
export const promptForNewPanel = (
  onConnect: Prompt | undefined,
  next: Prompt | undefined,
  kindIsUnlock = (k: string) => k === 'unlock',
): Prompt | undefined => {
  const p = onConnect ?? next;
  return p && !kindIsUnlock(p.kind) ? p : undefined;
};

type PortLike = {
  onMessage?: { addListener: (f: (m: unknown) => void) => void };
  onDisconnect?: { addListener: (f: () => void) => void };
  postMessage: (m: unknown) => void;
  disconnect: () => void;
};

/**
 * The panel's 'extension-popup' port, kept open. Chrome stops an idle service worker (and starts a fresh one after a
 * browser restart); its ports disconnect with it. A panel that never reconnected was invisible to the new worker, so
 * prompts went down the "no panel open" path and sat until some user input happened. Reconnect straight away (which
 * also wakes the worker) and announce PANEL_READY so the worker pushes anything already pending.
 */
export const keepPanelPort = (
  connect: () => PortLike,
  onMessage: (m: unknown) => void,
  retryMs = (attempt: number) => Math.min(250 * 2 ** attempt, 5000),
  schedule: (f: () => void, ms: number) => unknown = (f, ms) => setTimeout(f, ms),
): (() => void) => {
  let stopped = false;
  let port: PortLike | undefined;
  let attempt = 0;
  const open = () => {
    if (stopped) return;
    try {
      port = connect();
    } catch {
      schedule(open, retryMs(attempt++)); // extension reloading
      return;
    }
    port.onMessage?.addListener((m) => {
      attempt = 0;
      onMessage(m);
    });
    port.onDisconnect?.addListener(() => {
      port = undefined;
      if (!stopped) schedule(open, attempt === 0 ? 0 : retryMs(attempt++));
      attempt = Math.max(attempt, 1);
    });
    try {
      port.postMessage({ action: 'PANEL_READY' });
    } catch {
      /* disconnected already: onDisconnect retries */
    }
  };
  open();
  return () => {
    stopped = true;
    port?.disconnect();
  };
};

/** A browser window in fullscreen (a game) hides the wallet's prompt surfaces until the user interacts. */
export const isFullscreenWindow = (w: { state?: string } | undefined): boolean => w?.state === 'fullscreen';
