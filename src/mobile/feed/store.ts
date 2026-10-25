import { safety, type SafetyFilter } from '../market/safety';
import { mediaSafety } from './media';
import type { PostLock } from './locks';
import type { FeedPost } from './post';
import type { Source } from './sources';

/**
 * Feed per-device state: who you follow (mirrored on-chain by follow txs), who you muted,
 * what you liked (so the heart stays lit before the indexer catches up). localStorage only.
 */
const LS = {
  follows: 'bwallet.feed.follows',
  mutes: 'bwallet.feed.mutes',
  liked: 'bwallet.feed.liked',
  locks: 'bwallet.feed.locks',
  blocks: 'bwallet.feed.blocks',
  bookmarks: 'bwallet.feed.bookmarks',
  favourites: 'bwallet.feed.favourites',
};

export type Follow = { bapId: string | null; address: string; name: string };

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? 'null') as T | null;
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // storage unavailable
  }
};

export const loadFollows = (): Follow[] =>
  read<Follow[]>(LS.follows, []).filter((f) => f && typeof f.address === 'string');
export const isFollowing = (follows: Follow[], a: { address: string; bapId: string | null }) =>
  follows.some((f) => f.address === a.address || (!!a.bapId && f.bapId === a.bapId));
export const toggleFollow = (follows: Follow[], f: Follow): Follow[] => {
  const next = isFollowing(follows, f)
    ? follows.filter((x) => !(x.address === f.address || (!!f.bapId && x.bapId === f.bapId)))
    : [...follows, f];
  write(LS.follows, next);
  return next;
};

export const loadMutes = (): string[] => read<string[]>(LS.mutes, []).filter((x) => typeof x === 'string');
export const addMute = (mutes: string[], ...keys: (string | null)[]): string[] => {
  const next = [...new Set([...mutes, ...keys.filter((k): k is string => !!k)])];
  write(LS.mutes, next);
  return next;
};

export const removeMute = (mutes: string[], ...keys: (string | null)[]): string[] => {
  const drop = new Set(keys.filter((k): k is string => !!k));
  const next = mutes.filter((k) => !drop.has(k));
  write(LS.mutes, next);
  return next;
};

/** Muted / blocked accounts, kept with a display name so Settings can list them. */
export type HiddenAccount = { address: string; bapId: string | null; name: string };
const validAccount = (a: HiddenAccount) => !!a && typeof a.address === 'string';

/**
 * Blocked accounts: hidden everywhere (feed, threads, their profile). Mutes (above) are plain keys and only
 * quiet the feed and threads; a muted author's profile still shows their posts.
 */
export const loadBlocks = (): HiddenAccount[] => read<HiddenAccount[]>(LS.blocks, []).filter(validAccount);
const sameAccount = (a: HiddenAccount, b: { address: string; bapId: string | null }) =>
  a.address === b.address || (!!b.bapId && a.bapId === b.bapId);
export const isBlocked = (blocks: HiddenAccount[], a: { address: string; bapId: string | null }) =>
  blocks.some((b) => sameAccount(b, a));
export const addBlock = (blocks: HiddenAccount[], a: HiddenAccount): HiddenAccount[] => {
  const next = isBlocked(blocks, a) ? blocks : [...blocks, { address: a.address, bapId: a.bapId, name: a.name }];
  write(LS.blocks, next);
  return next;
};
export const removeBlock = (blocks: HiddenAccount[], a: { address: string; bapId: string | null }) => {
  const next = blocks.filter((b) => !sameAccount(b, a));
  write(LS.blocks, next);
  return next;
};
/** Keys for visiblePosts(): every address / BAP id that is blocked. */
export const blockKeys = (blocks: HiddenAccount[]): string[] =>
  blocks.flatMap((b) => (b.bapId ? [b.address, b.bapId] : [b.address]));

/** Mute names (mutes are stored as bare keys; names are kept separately for the Settings list). */
const MUTE_NAMES = 'bwallet.feed.muteNames';
export const loadMuteNames = (): Record<string, string> => read<Record<string, string>>(MUTE_NAMES, {});
export const rememberMuteName = (name: string, ...keys: (string | null)[]) => {
  const names = loadMuteNames();
  for (const k of keys) if (k) names[k] = name;
  write(MUTE_NAMES, names);
};
/** Groups mute keys into accounts for display: a key whose name matches another key's is folded into it. */
export const mutedAccounts = (mutes: string[], names: Record<string, string>): { name: string; keys: string[] }[] => {
  const byName = new Map<string, string[]>();
  for (const k of mutes) {
    const n = names[k] ?? k;
    byName.set(n, [...(byName.get(n) ?? []), k]);
  }
  return [...byName].map(([name, keys]) => ({ name, keys }));
};

/** Saved posts (snapshots, newest first) so they show offline and after the indexer drops them. */
export const MAX_BOOKMARKS = 500;
export const loadBookmarks = (): FeedPost[] =>
  read<FeedPost[]>(LS.bookmarks, []).filter((p) => p && typeof p.txid === 'string' && !!p.author);
export const saveBookmarks = (posts: FeedPost[]): FeedPost[] => {
  const next = posts.slice(0, MAX_BOOKMARKS);
  write(LS.bookmarks, next);
  return next;
};
export const isBookmarked = (bookmarks: FeedPost[], txid: string) => bookmarks.some((p) => p.txid === txid);
export const toggleBookmark = (bookmarks: FeedPost[], p: FeedPost): FeedPost[] => {
  const next = isBookmarked(bookmarks, p.txid)
    ? bookmarks.filter((x) => x.txid !== p.txid)
    : [p, ...bookmarks].slice(0, MAX_BOOKMARKS);
  write(LS.bookmarks, next);
  return next;
};

export const loadLiked = (): string[] => read<string[]>(LS.liked, []).filter((x) => typeof x === 'string');
export const addLiked = (liked: string[], txid: string): string[] => {
  const next = [...new Set([...liked, txid])].slice(-2000);
  write(LS.liked, next);
  return next;
};

/** Locks this device made, so a post's total includes them before the indexer catches up. */
export const loadMyLocks = (): PostLock[] =>
  read<PostLock[]>(LS.locks, []).filter((l) => l && typeof l.lockTxid === 'string' && typeof l.postTxid === 'string');
export const addMyLock = (locks: PostLock[], l: PostLock): PostLock[] => {
  const next = [...locks.filter((x) => x.lockTxid !== l.lockTxid), l].slice(-500);
  write(LS.locks, next);
  return next;
};

/** Market safety filter (bundled + remote blocklist + reported, incl. media refs) plus this device's mutes. */
export function visiblePosts(posts: FeedPost[], mutes: string[], s: SafetyFilter = safety()): FeedPost[] {
  const muted = new Set(mutes);
  return posts.filter((p) => {
    if (muted.has(p.author.address) || (p.author.bapId && muted.has(p.author.bapId))) return false;
    // Media refs (outpoints / txids) and media + link URLs go through the same blocklist.
    const m = mediaSafety(p.media ?? [], p.links ?? []);
    return !s.check({ ids: [p.txid, ...m.ids], texts: [p.text, p.author.name, ...m.texts] }).blocked;
  });
}

/**
 * Favourites (owner, 25 Oct 2026): sources and people the user picked. The Favourites filter shows
 * only posts from these. Per device, like mutes and bookmarks.
 */
export type Favourite =
  | { kind: 'source'; id: Source }
  | { kind: 'author'; address: string; bapId: string | null; name: string };

const validFavourite = (f: unknown): f is Favourite => {
  const x = f as Favourite | null;
  if (!x || typeof x !== 'object') return false;
  if (x.kind === 'source') return typeof x.id === 'string';
  return x.kind === 'author' && typeof x.address === 'string' && !!x.address;
};
const sameFavourite = (a: Favourite, b: Favourite) =>
  a.kind === 'source'
    ? b.kind === 'source' && a.id === b.id
    : b.kind === 'author' && (a.address === b.address || (!!a.bapId && a.bapId === b.bapId));

export const loadFavourites = (): Favourite[] => {
  const v = read<unknown>(LS.favourites, []);
  return Array.isArray(v) ? v.filter(validFavourite) : [];
};
export const isFavourite = (favs: Favourite[], f: Favourite) => favs.some((x) => sameFavourite(x, f));
export const toggleFavourite = (favs: Favourite[], f: Favourite): Favourite[] => {
  const next = isFavourite(favs, f) ? favs.filter((x) => !sameFavourite(x, f)) : [...favs, f];
  write(LS.favourites, next);
  return next;
};
/** Posts from a favourite source or a favourite author; nothing when the list is empty. */
export const filterFavourites = (posts: FeedPost[], favs: Favourite[]): FeedPost[] =>
  posts.filter((p) =>
    favs.some((f) =>
      f.kind === 'source'
        ? p.source === f.id
        : p.author.address === f.address || (!!f.bapId && p.author.bapId === f.bapId),
    ),
  );
