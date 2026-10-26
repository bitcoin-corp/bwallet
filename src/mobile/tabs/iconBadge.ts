/**
 * Extension toolbar icon badge = the bMail badge (owner, 26 Oct 2026): the same number as the in-app bMail badge
 * (useBMailBadge: unread Inbox mail plus new airdrops), cleared at 0. Set by the open side panel; the background
 * worker does not count mail, so the number is as of the last time the panel was open.
 * Native app-icon badges: no Capacitor badge plugin is a dependency yet (follow-up).
 */
import { IS_EXTENSION } from '../extension';

/** '' clears the badge; above 99 shows "99+". */
export const iconBadgeText = (n: number): string =>
  !Number.isFinite(n) || n <= 0 ? '' : n > 99 ? '99+' : String(Math.floor(n));

type ActionApi = {
  setBadgeText(d: { text: string }): Promise<void> | void;
  setBadgeBackgroundColor?(d: { color: string }): Promise<void> | void;
};

let last: string | null = null;
export const setIconBadge = (
  n: number,
  action: ActionApi | undefined = IS_EXTENSION
    ? (globalThis as { chrome?: { action?: ActionApi } }).chrome?.action
    : undefined,
) => {
  if (!action) return;
  const text = iconBadgeText(n);
  if (text === last) return;
  last = text;
  try {
    void Promise.resolve(action.setBadgeText({ text })).catch(() => undefined);
    if (text) void Promise.resolve(action.setBadgeBackgroundColor?.({ color: '#F04438' })).catch(() => undefined);
  } catch {
    /* no action API (not the extension) */
  }
};

/** Test hook: forget the last value written. */
export const resetIconBadge = () => {
  last = null;
};
