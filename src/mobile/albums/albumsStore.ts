/**
 * Where albums and hidden flags live (v1): this device's localStorage, keyed by the account's identity address, so
 * each identity has its own and switching accounts never mixes them. Private: nothing here leaves the device.
 *
 * Next step (docs in the PR, "Sync plan"): follow the identity across devices by storing the same JSON encrypted
 * with wallet.encrypt (reserved wallet-internal protocol, counterparty 'self'), so only the user's keys can read it.
 * Never synced in clear.
 */
import { emptyAlbums, parseAlbums, type AlbumState } from './albums';

const KEY = 'bwx:albums:';

export const loadAlbums = (account: string | null | undefined): AlbumState => {
  if (!account) return emptyAlbums();
  try {
    return parseAlbums(JSON.parse(localStorage.getItem(KEY + account) ?? 'null'));
  } catch {
    return emptyAlbums();
  }
};

const subs = new Set<() => void>();

export const saveAlbums = (account: string | null | undefined, s: AlbumState) => {
  if (!account) return;
  try {
    localStorage.setItem(KEY + account, JSON.stringify(s));
  } catch {
    /* storage full or unavailable: lasts this session only */
  }
  subs.forEach((f) => f());
};

/** Apply one change to the stored state (read fresh, so two lists never overwrite each other). */
export const updateAlbums = (account: string | null | undefined, fn: (s: AlbumState) => AlbumState) =>
  saveAlbums(account, fn(loadAlbums(account)));

export const onAlbums = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
