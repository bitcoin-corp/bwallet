import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AuthRequestHost } from '../auth/AuthSheet';
import { BrowseLinkHost } from '../browse/BrowseLinkHost';
import { useReducedMotion } from 'framer-motion';
import { useLocation, useNavigate } from 'react-router-dom';
import { BottomMenuContext, type MenuItems } from '../../contexts/BottomMenuContext';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getBappFrameState, openBapp } from '../bappFrame/bappFrame';
import { usePendingIndexing } from '../tokens/pendingIndexing';
import { indexingEnabled } from '../storeBuild';
import { TAB_TAP } from '../tabs/tabs';
import { onTabRetap } from '../tabs/tabRetap';
import { badgeText, walletBadgeLabel } from '../tabs/tabBadges';
import { useTabBadges } from '../tabs/useTabBadges';
import { setWalletKind } from '../wallet/walletKind';
import { AddToDockSheet } from './AddToDockSheet';
import { Dock } from './Dock';
import { addToDock, dockKey, type DockItem } from './dockModel';
import { useDock } from './dockStore';
import { APPS_PAGED, usePhoneLayout } from './flag';
import { PHONE_ADD_TO_DOCK, PHONE_APPS_TOP, PHONE_GO, PHONE_TOAST } from './events';
import { placeFirstFree, renameScreen, screenTitle } from './appScreens';
import {
  nextPullHint,
  PULL_HINT_DELAY_MS,
  PULL_HINT_KEY,
  PULL_HINT_TEXT,
  pullHintApplies,
  touchScreen,
} from './pullHint';
import { getAppScreens, setAppScreens, useAppScreens } from './appScreensStore';
import {
  bCloseReached,
  bCloseStartOk,
  lockAxis,
  PAGE_SNAP_MS,
  pageRelease,
  PULL_THRESHOLD,
  PULL_TOP_ZONE,
  pullProgress,
  pullReached,
  rubberBand,
} from './gesture';
import bGlyph from '../brand/bwallet-glyph.svg';
import { getPageEl, hasLanded, prewarmPages, setLanded } from './pageEl';
import { PageDots } from './PageDots';
import { backGoesHome, setPhoneBack } from './phoneBack';
import {
  appIndexForPath,
  coldStartRedirect,
  appScreenRoute,
  pageForPath,
  screenById,
  STRIP,
  type Screen,
} from './screens';
import { SendReceiveSheet } from './SendReceiveSheet';
import { useAppServices } from './useAppServices';
import { requestWalletAction, type WalletAction } from './walletAction';

const PairSheet = lazy(() => import('../pair/PairSheet'));

const LABELS: Record<string, string> = Object.fromEntries(STRIP.map((s) => [s.id, s.label]));

/** A touch that starts in one of these is never a page swipe. */
const NO_SWIPE =
  '[data-phone-dock],[data-no-strip-swipe],input,textarea,select,[contenteditable="true"],[role="slider"],[role="dialog"]';
const inSideScroller = (el: Element | null): boolean => {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const o = getComputedStyle(n).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
  }
  return false;
};

/**
 * An open sheet or dialog on screen (not in a page kept off screen, phone/pager.tsx): no page swipe. The back
 * stack can't say this any more, since a kept page may hold its own open sheet while hidden.
 */
const sheetOnScreen = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"],[aria-modal="true"]')].some(
    (el) => !el.closest('.bw-page-off') && el.getClientRects().length > 0,
  );

/** First strip page this session: a cold start lands on HOME, not the wallet (plan §6). */

/**
 * The phone layout (docs/PHONE-LAYOUT-PLAN.md), mounted ONCE inside the router (vite.config.mobile.ts App.tsx
 * patch). Renders nothing while the test switch is off. When on:
 *  - the URL stays the source of truth; swipes, dots and dock taps use replace-navigation, so they don't fill
 *    the back stack (opening inner screens still pushes, as before);
 *  - only the current screen is mounted (each is its own route), so there is never more than current ±1;
 *  - pairing listeners run here, once (useAppServices), not in every TopNav;
 *  - Android Back on a strip page other than HOME goes HOME (phoneBack.ts, main.ts).
 */
export const PhoneShell = () => {
  const on = usePhoneLayout();
  return on ? <Shell /> : null;
};

const Shell = () => {
  const navigate = useNavigate();
  // The wallet dock stays on every page, bApps included (owner, 16 Oct 2026: a bApp bar in its place left bMail
  // with four greyed slots, so the dock looked dead). The bApp's sections open from its icon in the top bar.
  const { pathname } = useLocation();
  const menu = useContext(BottomMenuContext);
  const { apiContext, chromeStorageService } = useServiceContext();
  const { pairLink, clearPairLink } = useAppServices();
  const [dock, setDock] = useDock();
  const [sendReceive, setSendReceive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const screens = useAppScreens().screens;
  const count = screens.length;
  /** The app screen on show (swipeable), or the page (Wallet, Exchange, Feed, Chat…), or neither. */
  const curIdx = appIndexForPath(pathname, count);
  const current = curIdx === null ? pageForPath(pathname) : null;
  const reduce = useReducedMotion();
  const visible = !!menu?.isVisible;

  const pending = usePendingIndexing(
    apiContext,
    chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress,
  ).length;

  /** Go to app screen i (replace). */
  const goScreen = (i: number) => {
    const route = appScreenRoute(Math.max(0, Math.min(i, count - 1)));
    if (pathname !== route) navigate(route, { replace: true });
    menu?.clearSelection();
  };
  /** Go to a page (replace), keeping the old bottom-bar selection in step for upstream callers. Home, Apps and
   *  Games are app screens 1, 2 and 3 now (Option B). */
  const go = (s: Screen) => {
    if (s.id === 'home' || s.id === 'apps' || s.id === 'games')
      return goScreen(s.id === 'home' ? 0 : s.id === 'apps' ? 1 : 2);
    const legacy = s.legacyIds[0];
    if (s.id === 'wallet') setWalletKind('tokens');
    if (pageForPath(pathname)?.id === s.id) {
      // Already here: reset the screen's inner pages, like re-tapping a tab did.
      if (legacy) window.dispatchEvent(new CustomEvent(TAB_TAP, { detail: legacy }));
      if (pathname !== s.route) navigate(s.route, { replace: true });
      // …and back to the top, or a refresh when already there (tabs/tabRetap.ts).
      else onTabRetap();
      return;
    }
    navigate(s.route, { replace: true });
    if (legacy) menu?.handleSelect(legacy as MenuItems);
    else menu?.clearSelection();
  };
  const goRef = useRef(go);
  goRef.current = go;
  const goScreenRef = useRef(goScreen);
  goScreenRef.current = goScreen;
  const goHome = () => {
    // Round 8: on the Apps page already, the dock b scrolls it back to the top.
    if (!APPS_PAGED && curIdx !== null) window.dispatchEvent(new Event(PHONE_APPS_TOP));
    goScreen(0);
  };

  // A cold start lands on the Wallet (LANDING), where unlock already put it.
  useEffect(() => {
    if (hasLanded() || (!current && curIdx === null)) return;
    setLanded();
    try {
      sessionStorage.removeItem('bwallet:apps-page');
    } catch {
      /* storage unavailable */
    }
    if (coldStartRedirect(current?.id ?? null) === 'home') goHome();
    // Prefetch Wallet, Feed and Chat once the start has settled (idle): mounted hidden, so they open with their data.
    const warm = () => prewarmPages(['wallet', 'feed', 'chat']);
    const t = window.setTimeout(() => {
      const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback;
      if (ric) ric(warm, { timeout: 4000 });
      else warm();
    }, 2500);
    void t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, curIdx]);

  // Android Back: off HOME → HOME.
  useEffect(() => {
    setPhoneBack(() => {
      if (!backGoesHome(current ? current.id : curIdx ? 'screen' : null)) return false;
      goHome();
      return true;
    });
    return () => setPhoneBack(null);
  });

  // iOS-style paging (plan §14.3): the page follows the finger with the neighbour sliding in beside it, then
  // snaps. Transforms only, set straight on the elements (no React render per move). Never from the dock, a
  // sideways scroller, a text field or an open sheet / bApp, so inner swipers keep working; the axis locks after
  // 10px, so vertical scrolling inside pages is untouched.
  const [dotTarget, setDotTarget] = useState<number | null>(null);
  const settling = useRef(false);
  /** Move the whole track (phone/pager.tsx) by tx px; while it is off rest, the neighbours show. */
  const place = (tx: number, ms: number, dragging: boolean) => {
    const el = getPageEl();
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none';
    el.style.transform = tx ? `translate3d(${tx}px,0,0)` : '';
    if (dragging) el.dataset.dragging = '1';
    else delete el.dataset.dragging;
  };
  /** Snap to `target` (a neighbour on `side`) or back (null). */
  const settle = (target: number | null, side: -1 | 1, tx: number) => {
    const w = getPageEl()?.clientWidth ?? window.innerWidth;
    const ms = reduce ? 0 : Math.round(PAGE_SNAP_MS * Math.min(1, Math.max(0.4, (w - Math.abs(tx)) / w + 0.2)));
    settling.current = true;
    place(target !== null ? -side * w : 0, ms, true);
    window.setTimeout(() => {
      if (target !== null) {
        goScreenRef.current(target); // the route changes; the layout effect below puts the track back at rest
      } else {
        place(0, 0, false);
        settling.current = false;
      }
      setDotTarget(null);
    }, ms + 16);
  };
  // After the route changes the new page is the track's centre: reset before the browser paints.
  useLayoutEffect(() => {
    place(0, 0, false);
    settling.current = false;
  }, [pathname]);
  /** Go to app screen `to`: a neighbour slides in (dots); further away, or reduced motion, just goes. */
  const slideTo = (to: number) => {
    const from = curIdx;
    if (reduce || from === null || settling.current || !getPageEl() || Math.abs(to - from) !== 1) return goScreen(to);
    const side: -1 | 1 = to > from ? 1 : -1;
    place(0, 0, true);
    requestAnimationFrame(() => settle(to, side, 0));
  };
  const slideRef = useRef(slideTo);
  slideRef.current = slideTo;

  // The pull-to-agent cue: a small b that grows and fills as the finger pulls (transforms and opacity only).
  const pullCue = useRef<HTMLDivElement | null>(null);
  const showPull = (pull: number) => {
    const el = pullCue.current;
    if (!el) return;
    const r = pullProgress(pull);
    el.style.opacity = pull > 0 ? String(Math.min(1, 0.25 + r)) : '0';
    el.style.transition = pull > 0 || reduce ? 'none' : 'opacity 200ms ease-out, transform 260ms ease-out';
    el.style.transform = reduce
      ? 'translate3d(-50%,0,0)'
      : `translate3d(-50%,${Math.min(pull, PULL_THRESHOLD * 1.4) * 0.5}px,0) scale(${0.6 + 0.4 * r})`;
    el.dataset.ready = r >= 1 ? '1' : '';
  };

  useEffect(() => {
    type Drag = {
      x: number;
      y: number;
      axis: 'x' | 'y' | null;
      lx: number;
      lt: number;
      vx: number;
      tx: number;
      side: -1 | 1;
      w: number;
      /** Pull down from the top of an app screen = the b agent (owner round 6). */
      pullOk: boolean;
      pull: number;
    };
    let frame = 0;
    let lastDot: number | null = null;
    let d: Drag | null = null;
    const here = () => appIndexForPath(pathname, count);
    const exists = (i: number) => i >= 0 && i < count;
    const down = (e: TouchEvent) => {
      d = null;
      if (settling.current || e.touches.length !== 1 || here() === null) return;
      const t = e.target as Element | null;
      if (!t || t.closest?.(NO_SWIPE) || inSideScroller(t)) return;
      if (sheetOnScreen() || getBappFrameState().session) return;
      const p = e.touches[0];
      // Width read once per drag: no layout reads while the finger moves.
      const w = getPageEl()?.clientWidth ?? window.innerWidth;
      // Pull-to-agent only from a screen scrolled to the very top, and never from the status-bar / top-bar zone.
      const scroller = document.querySelector(`[data-phone-screen="${APPS_PAGED ? here() : 0}"] section`);
      const pullOk = p.clientY > PULL_TOP_ZONE && (!scroller || scroller.scrollTop <= 0);
      d = {
        x: p.clientX,
        y: p.clientY,
        axis: null,
        lx: p.clientX,
        lt: performance.now(),
        vx: 0,
        tx: 0,
        side: 1,
        w,
        pullOk,
        pull: 0,
      };
    };
    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      const h = here();
      if (!d || !p || h === null) return;
      const dx = p.clientX - d.x;
      if (!d.axis) {
        d.axis = lockAxis(dx, p.clientY - d.y);
        if (!d.axis) return;
      }
      if (d.axis === 'y') {
        const dy = p.clientY - d.y;
        if (!d.pullOk || (dy <= 0 && d.pull === 0)) return void (d = null);
        e.preventDefault(); // at the top, pulling down: the agent cue moves, not the page
        d.pull = Math.max(0, dy);
        const pull = d.pull;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => showPull(pull));
        return;
      }
      if (!APPS_PAGED) return void (d = null); // round 8: no sideways paging (kept behind the flag)
      e.preventDefault(); // horizontal: the page moves, not the scroller
      const now = performance.now();
      if (now > d.lt) d.vx = 0.8 * ((p.clientX - d.lx) / (now - d.lt)) + 0.2 * d.vx;
      d.lx = p.clientX;
      d.lt = now;
      const w = d.w;
      const side: -1 | 1 = dx < 0 ? 1 : -1;
      const n = exists(h + side) ? h + side : null;
      d.side = side;
      d.tx = n !== null && !reduce ? dx : rubberBand(dx, w);
      // One transform write per frame, straight on the track (no React render per move).
      const tx = d.tx;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => place(tx, 0, true));
      const dot = n !== null && Math.abs(dx) > w / 2 ? n : null;
      if (dot !== lastDot) setDotTarget((lastDot = dot));
    };
    const up = () => {
      const s = d;
      d = null;
      const h = here();
      cancelAnimationFrame(frame);
      lastDot = null;
      if (s?.axis === 'y') {
        const go = pullReached(s.pull);
        showPull(0);
        if (go) {
          try {
            localStorage.setItem(PULL_HINT_KEY, 'done'); // they found it: no more hints (pullHint.ts)
          } catch {
            /* no storage */
          }
          navigate('/m/ask-b');
          // Focus the composer once it is there (iOS may only show the keyboard on a tap).
          window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-agent-input]')?.focus(), 350);
        }
        return;
      }
      if (!s || s.axis !== 'x' || h === null) return;
      const w = s.w;
      const dir = pageRelease(s.tx, s.vx, w, exists(h - 1), exists(h + 1));
      const target = dir ? h + dir : null;
      if (reduce && target !== null) {
        place(0, 0, false);
        return goScreenRef.current(target);
      }
      settle(target, s.side, s.tx);
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', up, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, reduce, count]);

  // Swipe up on the b screen = close it, back to the screen it was opened from (owner, 15 Oct 2026): the mirror
  // of the pull-down above, same distance. Never takes a scroll from b's chat (gesture.ts bCloseStartOk).
  const goHomeRef = useRef(goHome);
  goHomeRef.current = goHome;
  useEffect(() => {
    if (!pathname.startsWith('/m/ask-b')) return;
    let d: { x: number; y: number; axis: 'x' | 'y' | null; dy: number } | null = null;
    const down = (e: TouchEvent) => {
      d = null;
      if (e.touches.length !== 1 || sheetOnScreen()) return;
      const t = e.target as Element | null;
      if (!t) return;
      const p = e.touches[0];
      const sc = t.closest?.('.askb-pagepad, .askb-bubbles') as HTMLElement | null;
      const ok = bCloseStartOk({
        y: p.clientY,
        viewportH: window.innerHeight,
        scroll: sc ? { top: sc.scrollTop, height: sc.scrollHeight, client: sc.clientHeight } : null,
        onField: !!t.closest?.(NO_SWIPE),
      });
      if (ok) d = { x: p.clientX, y: p.clientY, axis: null, dy: 0 };
    };
    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      if (!d || !p) return;
      const dy = p.clientY - d.y;
      if (!d.axis) {
        d.axis = lockAxis(p.clientX - d.x, dy);
        if (!d.axis) return;
        if (d.axis !== 'y' || dy > 0) return void (d = null); // sideways or down: not ours
      }
      d.dy = dy;
    };
    const up = () => {
      const s = d;
      d = null;
      if (!s || s.axis !== 'y' || !bCloseReached(s.dy)) return;
      // No animation: the route change is the motion, so reduced motion needs nothing extra.
      const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
      if (idx > 0) navigate(-1);
      else goHomeRef.current();
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    const cancel = () => void (d = null);
    document.addEventListener('touchcancel', cancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Others (an app's details "Add to Dock") reach the shell by event.
  useEffect(() => {
    const add = (e: Event) => {
      const r = addToDock(dock, (e as CustomEvent<DockItem>).detail);
      if (r.ok) setDock(r.items);
      setToast(
        r.ok
          ? 'Added to the dock'
          : r.reason === 'full'
            ? 'The dock is full (4). Remove one first.'
            : r.reason === 'already'
              ? 'Already in the dock'
              : 'Not available',
      );
    };
    const say = (e: Event) => setToast((e as CustomEvent<string>).detail);
    // A Home screen tile (Wallet, Exchange, Feed…) opens its page.
    const goTo = (e: Event) => {
      const sc = screenById((e as CustomEvent<string>).detail);
      if (sc) goRef.current(sc);
    };
    window.addEventListener(PHONE_GO, goTo);
    window.addEventListener(PHONE_ADD_TO_DOCK, add);
    window.addEventListener(PHONE_TOAST, say);
    return () => {
      window.removeEventListener(PHONE_ADD_TO_DOCK, add);
      window.removeEventListener(PHONE_TOAST, say);
      window.removeEventListener(PHONE_GO, goTo);
    };
  }, [dock, setDock]);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast === PULL_HINT_TEXT ? 3200 : 1800);
    return () => window.clearTimeout(t);
  }, [toast]);

  // First few opens: say that pulling down asks b, and let the cue peek out once (pullHint.ts). Waits for an app
  // screen (not onboarding) and only once per open.
  const onAppScreen = curIdx !== null;
  const hintRan = useRef(false);
  useEffect(() => {
    if (hintRan.current || !pullHintApplies(onAppScreen, touchScreen())) return;
    hintRan.current = true;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(PULL_HINT_KEY);
    } catch {
      return;
    }
    const h = nextPullHint(stored);
    if (!h.show) return;
    try {
      localStorage.setItem(PULL_HINT_KEY, h.next);
    } catch {
      return;
    }
    const t1 = window.setTimeout(() => {
      setToast(PULL_HINT_TEXT);
      showPull(PULL_THRESHOLD);
    }, PULL_HINT_DELAY_MS);
    const t2 = window.setTimeout(() => showPull(0), PULL_HINT_DELAY_MS + 1100);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAppScreen]);

  const walletAction = (a: WalletAction) => {
    setSendReceive(false);
    const w = screenById('wallet');
    if (w) go(w);
    requestWalletAction(a);
  };

  const open = (item: DockItem) => {
    if (item.kind === 'screen') {
      const s = screenById(item.id);
      if (s) go(s);
    } else if (item.kind === 'action') setSendReceive(true);
    else {
      if (curIdx === null) goHome();
      openBapp(item.name, item.url).catch(() => setToast('Could not open the app'));
    }
  };

  // Chat and Feed unread (tabs/tabBadges.ts). Wallet keeps only its rooms-to-set-up count: new tokens show in bMail.
  const unread = useTabBadges();
  const badges = useMemo(
    () => ({
      'screen:wallet': pending && indexingEnabled() ? String(pending) : undefined,
      'screen:chat': badgeText(unread.chat) || undefined,
      'screen:feed': badgeText(unread.feed) || undefined,
    }),
    [pending, unread.chat, unread.feed],
  );

  return (
    <>
      {visible && (
        <Dock
          items={dock}
          labels={LABELS}
          activeKey={current ? dockKey({ kind: 'screen', id: current.id }) : null}
          badges={badges}
          badgeLabels={{
            'screen:wallet':
              pending && indexingEnabled() ? walletBadgeLabel(LABELS.wallet ?? 'Wallet', pending) : undefined,
          }}
          onOpen={open}
          onHome={goHome}
          onAgent={() => navigate('/m/ask-b')}
          onChange={(next) => {
            // An app leaving the dock goes to the first free slot on the app screens (never lost). Page tiles
            // (Wallet…) are placed by the app-screens store itself (appScreensStore.ts reconcile).
            let placed = getAppScreens();
            for (const i of dock)
              if (i.kind === 'app' && !next.some((n) => n.kind === 'app' && n.url === i.url))
                placed = placeFirstFree(placed, i.url);
            if (placed !== getAppScreens()) setAppScreens(placed);
            setDock(next);
          }}
          onAdd={() => setAdding(true)}
          pageKey={pathname}
          dots={
            APPS_PAGED && curIdx !== null ? (
              <PageDots
                titles={screens.map((x, i) => screenTitle(x, i))}
                current={dotTarget ?? curIdx}
                onGo={(i) => slideRef.current(i)}
                onRename={(i) => {
                  const name = window.prompt('Name this screen', screenTitle(screens[i], i));
                  if (name !== null) setAppScreens(renameScreen(getAppScreens(), i, name));
                }}
              />
            ) : null
          }
        />
      )}
      <div
        ref={pullCue}
        aria-hidden
        className="bw-pull-cue fixed left-1/2 z-[95] pointer-events-none flex items-center justify-center rounded-full"
        style={{ top: 'calc(var(--wallet-inset-top, 0px) + 4rem)', width: 44, height: 44, opacity: 0 }}
      >
        <img src={bGlyph} alt="" width={24} height={24} draggable={false} />
      </div>
      {toast && (
        <div
          role="status"
          className="absolute left-1/2 -translate-x-1/2 z-[160] rounded-full px-4 py-2 text-[13px] font-semibold text-white"
          style={{ bottom: 'calc(var(--dock-h) + 2.5rem)', background: 'rgba(43,47,54,0.95)' }}
        >
          {toast}
        </div>
      )}
      {sendReceive && <SendReceiveSheet onPick={walletAction} onClose={() => setSendReceive(false)} />}
      {adding && (
        <AddToDockSheet
          items={dock}
          strip={STRIP}
          labels={LABELS}
          onAdd={(i) => {
            const r = addToDock(dock, i);
            if (r.ok) setDock(r.items);
            else setToast(r.reason === 'full' ? 'Dock is full' : 'Not available');
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {pairLink && (
        <Suspense fallback={null}>
          <PairSheet initial={pairLink} onClose={clearPairLink} />
        </Suspense>
      )}
      <AuthRequestHost />
      <BrowseLinkHost />
    </>
  );
};

export default PhoneShell;
