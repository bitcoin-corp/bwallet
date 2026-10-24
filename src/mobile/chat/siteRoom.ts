import { useSyncExternalStore } from 'react';

/**
 * The connected game's room (owner, 24 Oct 2026). A site's theme file (or a path sub-theme, docs/SITE-THEME.md)
 * may name its chat room with `room`: the ticker of a room the wallet already lists. While that site is the active
 * tab and connected, the extension opens straight to that room, dressed in the site's look, with a short balance
 * card above it. Switching tabs follows the active game; nothing connected → the normal home screen.
 *
 * No new chat infrastructure: the room is opened through the Chat tab's own ticker hand-off (segmentNav.ts), and only
 * when the wallet's room list has it. Store builds never do this (rooms there can take a penny ticket).
 */
export type SiteRoom = { ticker: string; origin: string };

const ROOM = /^\$?[A-Za-z0-9]{1,20}$/;
/** A theme's `room` value as a ticker ("$assault" → "ASSAULT"), or null. */
export const roomTicker = (v: unknown): string | null =>
  typeof v === 'string' && ROOM.test(v.trim()) ? v.trim().replace(/^\$/, '').toUpperCase() : null;

let current: SiteRoom | null = null;
const subs = new Set<() => void>();

export const activeSiteRoom = (): SiteRoom | null => current;
export const setActiveSiteRoom = (r: SiteRoom | null): void => {
  if (r?.ticker === current?.ticker && r?.origin === current?.origin) return;
  current = r;
  subs.forEach((f) => f());
};
export const onSiteRoom = (f: () => void): (() => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export const useActiveSiteRoom = (): SiteRoom | null => useSyncExternalStore(onSiteRoom, activeSiteRoom, () => null);

/** Whether the room list has this ticker (case-insensitive). */
export const roomKnown = (rooms: ReadonlyArray<{ ticker: string }>, ticker: string): boolean =>
  rooms.some((r) => r.ticker.replace(/^\$/, '').toUpperCase() === ticker);
