/**
 * Forward one page CWI call (window.CWI → content.ts) to the background, and ALWAYS answer the page.
 *
 * The page's promise (src/cwi.ts transport) waits for one event named after the call's messageId and has no
 * timeout. When the extension is reloaded or updated while a tab stays open, this content script is cut off:
 * chrome.runtime.sendMessage throws "Extension context invalidated" synchronously (or chrome.runtime.id is gone)
 * and the response callback never runs. Before this, that throw escaped the event listener and the site's
 * getPublicKey / createAction waited for ever ("Reconnect" never came back until the page was reloaded,
 * TokenBlaster gallery, 24 Oct 2026). Now the page gets a plain error it can act on.
 */
export const RELOAD_PAGE_ERROR = 'bWalletX was updated or restarted: reload this page to reconnect';

export interface ForwardRuntime {
  id?: string;
  lastError?: { message?: string } | null;
  sendMessage: (message: unknown, callback: (response: unknown) => void) => unknown;
}

export const forwardCwiCall = (
  runtime: ForwardRuntime | undefined,
  message: unknown,
  answer: (detail: unknown) => void,
): void => {
  let answered = false;
  const once = (detail: unknown) => {
    if (answered) return;
    answered = true;
    answer(detail);
  };
  try {
    if (!runtime?.id) throw new Error(RELOAD_PAGE_ERROR);
    runtime.sendMessage(message, (response) => {
      const lastError = runtime.lastError;
      once(
        lastError
          ? { success: false, error: lastError.message || 'Message channel closed' }
          : (response ?? { success: false, error: 'No response from service worker' }),
      );
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    once({ success: false, error: /context invalidated/i.test(msg) ? RELOAD_PAGE_ERROR : msg });
  }
};
