/**
 * Hide and albums for anything in the wallet (owner, 24 Oct 2026: "just like how Photos allows us to hide photos").
 *
 * One model for every kind of item: an item is a key `<kind>:<id>` (nftKey / tokenKey / listingKey below), so
 * NFTs, BSV-21 tokens and Exchange rows share the same albums and the same Hidden set.
 *  - Hidden: display-only. A hidden item leaves the normal lists, counts and pickers and shows only in the
 *    "Hidden" album. Nothing is moved, sent or burned; the item stays in this wallet on chain.
 *  - Albums: user-named folders. An item can sit in any number of them; albums can be renamed, reordered and
 *    deleted (deleting an album never touches the items in it).
 * Pure rules here (unit-tested in albums.test.ts); storage is per identity (albumsStore.ts), the hook and sheets are
 * in useAlbums.ts / AlbumSheets.tsx.
 */

export type ItemKind = 'nft' | 'token' | 'listing';
export type ItemKey = `${ItemKind}:${string}`;

/** NFTs by origin (stable across sends and relistings), outpoint form `txid_vout`. */
export const nftKey = (origin: string): ItemKey => `nft:${origin.replace('.', '_')}`;
/** BSV-21 tokens by token id. */
export const tokenKey = (id: string): ItemKey => `token:${id}`;
/** Exchange rows by the token (or listing) id the row is for. */
export const listingKey = (id: string): ItemKey => `listing:${id}`;

export type Album = { id: string; name: string; items: ItemKey[] };
export type AlbumState = { v: 1; albums: Album[]; hidden: ItemKey[]; updated: number };

export const emptyAlbums = (): AlbumState => ({ v: 1, albums: [], hidden: [], updated: 0 });

export const MAX_ALBUM_NAME = 40;
/** Trimmed, single-spaced, at most 40 characters; '' when there is nothing left. */
export const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, MAX_ALBUM_NAME);

const newId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
};

const touch = (s: AlbumState, patch: Partial<AlbumState>): AlbumState => ({ ...s, ...patch, updated: Date.now() });
const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

/** New album at the end of the list. Returns the state unchanged (and id '') when the name is empty. */
export const createAlbum = (s: AlbumState, name: string, items: readonly ItemKey[] = [], id = newId()) => {
  const n = cleanName(name);
  if (!n) return { state: s, id: '' };
  return { state: touch(s, { albums: [...s.albums, { id, name: n, items: uniq(items) }] }), id };
};

export const renameAlbum = (s: AlbumState, id: string, name: string): AlbumState => {
  const n = cleanName(name);
  if (!n || !s.albums.some((a) => a.id === id)) return s;
  return touch(s, { albums: s.albums.map((a) => (a.id === id ? { ...a, name: n } : a)) });
};

/** Removes the album only; its items stay in the wallet (and in any other album). */
export const deleteAlbum = (s: AlbumState, id: string): AlbumState =>
  s.albums.some((a) => a.id === id) ? touch(s, { albums: s.albums.filter((a) => a.id !== id) }) : s;

/** Move an album to position `to` (clamped). */
export const moveAlbum = (s: AlbumState, id: string, to: number): AlbumState => {
  const from = s.albums.findIndex((a) => a.id === id);
  if (from < 0) return s;
  const list = [...s.albums];
  const [a] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, a);
  return touch(s, { albums: list });
};

const editItems = (s: AlbumState, id: string, f: (items: ItemKey[]) => ItemKey[]): AlbumState =>
  s.albums.some((a) => a.id === id)
    ? touch(s, { albums: s.albums.map((a) => (a.id === id ? { ...a, items: f(a.items) } : a)) })
    : s;

export const addToAlbum = (s: AlbumState, id: string, keys: readonly ItemKey[]) =>
  editItems(s, id, (items) => uniq([...items, ...keys]));

export const removeFromAlbum = (s: AlbumState, id: string, keys: readonly ItemKey[]) => {
  const drop = new Set(keys);
  return editItems(s, id, (items) => items.filter((k) => !drop.has(k)));
};

/** The add-to-album sheet: tick = every key goes in, untick = every key comes out. */
export const setInAlbum = (s: AlbumState, id: string, keys: readonly ItemKey[], on: boolean) =>
  on ? addToAlbum(s, id, keys) : removeFromAlbum(s, id, keys);

/** 'all' when every key is in the album, 'some' when a few are, 'none' otherwise. */
export const membership = (s: AlbumState, id: string, keys: readonly ItemKey[]): 'all' | 'some' | 'none' => {
  const a = s.albums.find((x) => x.id === id);
  if (!a || !keys.length) return 'none';
  const n = keys.filter((k) => a.items.includes(k)).length;
  return n === keys.length ? 'all' : n ? 'some' : 'none';
};

export const albumsOf = (s: AlbumState, key: ItemKey) => s.albums.filter((a) => a.items.includes(key));

export const isHidden = (s: AlbumState, key: ItemKey) => s.hidden.includes(key);

/** Hide or unhide. Display only: never moves, sends or burns anything. */
export const setHidden = (s: AlbumState, keys: readonly ItemKey[], on: boolean): AlbumState => {
  const now = on ? uniq([...s.hidden, ...keys]) : s.hidden.filter((k) => !keys.includes(k));
  return now.length === s.hidden.length && now.every((k, i) => k === s.hidden[i]) ? s : touch(s, { hidden: now });
};

/** What a list shows: everything not hidden, one album (not hidden), or only the hidden items. */
export type AlbumView = { kind: 'all' } | { kind: 'album'; id: string } | { kind: 'hidden' };
export const ALL_VIEW: AlbumView = { kind: 'all' };
export const HIDDEN_VIEW: AlbumView = { kind: 'hidden' };

export const inView = (s: AlbumState, key: ItemKey, view: AlbumView): boolean => {
  const hidden = s.hidden.includes(key);
  if (view.kind === 'hidden') return hidden;
  if (hidden) return false;
  if (view.kind === 'all') return true;
  return !!s.albums.find((a) => a.id === view.id)?.items.includes(key);
};

export const filterView = <T>(items: readonly T[], keyOf: (t: T) => ItemKey, s: AlbumState, view: AlbumView): T[] =>
  items.filter((t) => inView(s, keyOf(t), view));

/** Counts for the album row, over the items this list actually holds (hidden items count only under Hidden). */
export const viewCounts = <T>(items: readonly T[], keyOf: (t: T) => ItemKey, s: AlbumState) => {
  const keys = items.map(keyOf);
  const hidden = new Set(s.hidden);
  const shown = keys.filter((k) => !hidden.has(k));
  const albums: Record<string, number> = {};
  for (const a of s.albums) {
    const inA = new Set(a.items);
    albums[a.id] = shown.filter((k) => inA.has(k)).length;
  }
  return { all: shown.length, hidden: keys.length - shown.length, albums };
};

/** A view that points at a deleted album falls back to All. */
export const liveView = (s: AlbumState, view: AlbumView): AlbumView =>
  view.kind === 'album' && !s.albums.some((a) => a.id === view.id) ? ALL_VIEW : view;

const KEY_RE = /^(nft|token|listing):.+$/;
const isKey = (x: unknown): x is ItemKey => typeof x === 'string' && KEY_RE.test(x) && x.length < 200;

/** Parse stored or synced JSON; anything malformed is dropped rather than trusted. */
export const parseAlbums = (raw: unknown): AlbumState => {
  if (!raw || typeof raw !== 'object') return emptyAlbums();
  const r = raw as Partial<AlbumState>;
  const albums: Album[] = [];
  const seen = new Set<string>();
  for (const a of Array.isArray(r.albums) ? r.albums : []) {
    if (!a || typeof a !== 'object') continue;
    const id = typeof a.id === 'string' ? a.id.slice(0, 64) : '';
    const name = typeof a.name === 'string' ? cleanName(a.name) : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    albums.push({ id, name, items: uniq((Array.isArray(a.items) ? a.items : []).filter(isKey)) });
  }
  const hidden = uniq((Array.isArray(r.hidden) ? r.hidden : []).filter(isKey));
  const updated = typeof r.updated === 'number' && Number.isFinite(r.updated) ? r.updated : 0;
  return { v: 1, albums, hidden, updated };
};
