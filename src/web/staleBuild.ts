/**
 * Picks up a newer web build without ever reloading under the user (owner, 12 Oct 2026: desktop.bwalletx.com/media
 * "awkwardly refreshes when the browser window is opened").
 *
 * A tab keeps the build it first loaded (an SPA never refetches index.html), so tabs opened before a deploy showed an
 * older layout next to newer ones (owner, 9 Oct 2026). The first fix reloaded the page as soon as the tab came back
 * into view and a newer main-*.js was live. Desktop deploys many times a day, so that reload hit almost every return
 * to the tab: the page flashed, the scroll and the open view were lost and the stream player stopped.
 *
 * Now focus only *checks* (at most once a minute). A newer build is applied on the next in-app navigation, which
 * already changes the whole view, and never while audio or video is playing or the wallet is unlocked: the unlock
 * key is held in memory only (src/mobile/hub.ts), so a load would lock the wallet. The pill still offers the update.
 *
 * A home-screen web app (iOS standalone) can sit on one view for days and resumes without a navigation, so it never
 * reached that load (owner, 19 Oct 2026: chat "wouldn't connect" on an old build). So a found build is also offered
 * as a small "New version · tap to update" pill, and a resume (`pageshow`) checks too. Tapping reloads; nothing
 * reloads by itself.
 *
 * `installStaleBuildCheck` is inlined into the page as a classic script (vite.config.web.ts), so it must stay
 * self-contained: no imports, no closures over module scope.
 */
export type StaleEnv = {
  doc: Pick<Document, 'querySelector' | 'querySelectorAll' | 'addEventListener' | 'visibilityState'>;
  win: Pick<Window, 'addEventListener'> & { history: Pick<History, 'pushState'>; location: Pick<Location, 'assign'> };
  fetchText: (url: string) => Promise<string>;
  now: () => number;
  /** Offer the newer build: a quiet "tap to update" pill. Called once, when the check first finds one. */
  offer?: () => void;
  /** True while the wallet is unlocked; a navigation then never swaps in the new build by itself. */
  unlocked?: () => boolean;
};

export function installStaleBuildCheck(env?: StaleEnv): { check: () => Promise<void>; stale: () => boolean } | null {
  const e: StaleEnv = env || {
    doc: document,
    win: window,
    fetchText: (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')),
    now: () => Date.now(),
    unlocked: () => (window as unknown as { __bwxUnlocked?: boolean }).__bwxUnlocked === true,
    offer: () => {
      if (document.getElementById('bwx-update')) return;
      const b = document.createElement('button');
      b.id = 'bwx-update';
      b.type = 'button';
      b.textContent = 'New version \u00b7 Tap to update';
      b.setAttribute(
        'style',
        'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom));' +
          'z-index:2147483000;padding:8px 14px;border-radius:999px;border:1px solid rgba(212,175,55,.6);' +
          'background:#0b0b0b;color:#d4af37;font:600 13px/1.2 system-ui,-apple-system,sans-serif;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:pointer',
      );
      b.addEventListener('click', () => location.reload());
      document.body.appendChild(b);
    },
  };
  const GAP_MS = 60_000;
  const m = e.doc.querySelector('script[type=module][src*="main-"]');
  if (!m) return null;
  const mine = (m.getAttribute('src') || '').split('/').pop();
  let busy = false;
  let last = 0;
  let stale = false;
  const check = async () => {
    if (stale || busy || e.doc.visibilityState !== 'visible' || e.now() - last < GAP_MS) return;
    busy = true;
    last = e.now();
    try {
      const x = /assets\/(main-[^"']+\.js)/.exec(await e.fetchText('/'));
      if (x && x[1] !== mine) {
        stale = true;
        if (e.offer) e.offer();
      }
    } catch {
      /* offline: try again on the next focus */
    } finally {
      busy = false;
    }
  };
  const playing = () =>
    Array.prototype.some.call(e.doc.querySelectorAll('audio,video'), (el: HTMLMediaElement) => !el.paused && !el.ended);
  const push = e.win.history.pushState;
  e.win.history.pushState = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
    // A newer build is out: load it as this navigation's page instead of swapping the view in place.
    if (stale && url != null && !playing() && !(e.unlocked && e.unlocked())) {
      e.win.location.assign(String(url));
      return;
    }
    return push.call(this, data, unused, url);
  } as History['pushState'];
  e.doc.addEventListener('visibilitychange', () => void check());
  e.win.addEventListener('focus', () => void check());
  // iOS home-screen apps come back from the background via pageshow, often without focus.
  e.win.addEventListener('pageshow', () => void check());
  return { check, stale: () => stale };
}
