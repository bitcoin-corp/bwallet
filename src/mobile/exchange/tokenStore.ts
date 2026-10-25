/**
 * Per-token Store (Exchange › TokenBlaster / Memepool → "Store"): the token's wallet themes and merch.
 *
 * Sources, all optional and all untrusted:
 *  - TokenBlaster: each /api/launch/coins row may carry `theme` (the same v2 schema as /.well-known/bwalletx-theme.json,
 *    images same-origin on tokenblaster.lol), `room` (a ticker) and `merch_url`. Checked with parseConnectTheme.
 *  - Memepool: no theme or merch field in their API yet (openapi v1, 25 Oct 2026), so its Store shows the checklist.
 *
 * Nothing here pays or signs. Pure helpers.
 */
import { parseConnectTheme, type ConnectTheme } from '../theme/connectSiteTheme';

export const TOKENBLASTER_ORIGIN = 'https://www.tokenblaster.lol';

export type TokenStoreInfo = {
  theme: ConnectTheme | null;
  /** https link to the token's merch shop, or null. */
  merchUrl: string | null;
  /** Optional ticker the site names for its room (shown only; rooms are keyed by token id). */
  room: string | null;
};

export const EMPTY_STORE: TokenStoreInfo = { theme: null, merchUrl: null, room: null };

/** An https URL without credentials, or null. */
export const safeHttpsUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw || raw.length > 512 || /[\s\\]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
};

const ROOM_RE = /^\$?[A-Za-z0-9]{1,20}$/;

/** Reads the optional store fields of one listing row. Anything malformed is dropped, never shown. */
export const parseTokenStore = (row: unknown, origin: string): TokenStoreInfo => {
  if (!row || typeof row !== 'object') return EMPTY_STORE;
  const r = row as Record<string, unknown>;
  const parsed = r.theme !== undefined && r.theme !== null ? parseConnectTheme(r.theme, origin) : null;
  const room = typeof r.room === 'string' && ROOM_RE.test(r.room) ? r.room.replace(/^\$/, '').toUpperCase() : null;
  return { theme: parsed?.theme ?? null, merchUrl: safeHttpsUrl(r.merch_url), room };
};

export type StoreItem = { label: string; live: boolean };

/** The page's live/coming checklist (owner rule: pages show status). */
export const storeChecklist = (info: TokenStoreInfo, roomsOn: boolean): StoreItem[] => [
  { label: 'Token room in Chat', live: roomsOn },
  { label: 'Wallet theme from the token’s site', live: !!info.theme },
  { label: 'Merch shop link', live: !!info.merchUrl },
  { label: 'Buy themes and merch inside bWalletX', live: false },
];
