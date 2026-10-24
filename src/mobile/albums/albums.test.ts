import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ALL_VIEW,
  HIDDEN_VIEW,
  addToAlbum,
  albumsOf,
  cleanName,
  createAlbum,
  deleteAlbum,
  emptyAlbums,
  filterView,
  isHidden,
  liveView,
  membership,
  moveAlbum,
  nftKey,
  parseAlbums,
  removeFromAlbum,
  renameAlbum,
  setHidden,
  setInAlbum,
  tokenKey,
  viewCounts,
  type AlbumState,
  type ItemKey,
} from './albums';
import { loadAlbums, onAlbums, saveAlbums, updateAlbums } from './albumsStore';

const a = nftKey('aa.0');
const b = nftKey('bb_1');
const t = tokenKey('cc_0');

const make = (s: AlbumState, name: string, items: ItemKey[] = [], id?: string) => createAlbum(s, name, items, id);

describe('keys', () => {
  test('nft keys normalise the outpoint form', () => {
    expect(nftKey('aa.0')).toBe('nft:aa_0');
    expect(nftKey('aa_0')).toBe('nft:aa_0');
    expect(tokenKey('x_1')).toBe('token:x_1');
  });
});

describe('hide / unhide', () => {
  test('hidden items leave All and appear only in Hidden', () => {
    const s = setHidden(emptyAlbums(), [a], true);
    expect(isHidden(s, a)).toBe(true);
    expect(filterView([a, b], (k) => k, s, ALL_VIEW)).toEqual([b]);
    expect(filterView([a, b], (k) => k, s, HIDDEN_VIEW)).toEqual([a]);
    const back = setHidden(s, [a], false);
    expect(isHidden(back, a)).toBe(false);
    expect(filterView([a, b], (k) => k, back, ALL_VIEW)).toEqual([a, b]);
  });
  test('hiding twice is a no-op and keeps the same state object', () => {
    const s = setHidden(emptyAlbums(), [a], true);
    expect(setHidden(s, [a], true)).toBe(s);
  });
  test('a hidden item stays out of its albums too (like Photos)', () => {
    const { state, id } = make(emptyAlbums(), 'Faves', [a, b]);
    const s = setHidden(state, [a], true);
    expect(filterView([a, b], (k) => k, s, { kind: 'album', id })).toEqual([b]);
    expect(viewCounts([a, b, t], (k) => k, s)).toEqual({ all: 2, hidden: 1, albums: { [id]: 1 } });
  });
});

describe('album CRUD', () => {
  test('create trims the name; empty names make nothing', () => {
    const r = make(emptyAlbums(), '  Pixel   foxes  ');
    expect(r.state.albums[0].name).toBe('Pixel foxes');
    const none = make(r.state, '   ');
    expect(none.id).toBe('');
    expect(none.state).toBe(r.state);
    expect(cleanName('x'.repeat(80))).toHaveLength(40);
  });
  test('rename, reorder, delete', () => {
    let s = make(emptyAlbums(), 'One', [], '1').state;
    s = make(s, 'Two', [], '2').state;
    s = make(s, 'Three', [], '3').state;
    s = renameAlbum(s, '2', 'Deux');
    expect(s.albums.map((x) => x.name)).toEqual(['One', 'Deux', 'Three']);
    expect(renameAlbum(s, '2', '  ')).toBe(s);
    s = moveAlbum(s, '3', 0);
    expect(s.albums.map((x) => x.id)).toEqual(['3', '1', '2']);
    s = moveAlbum(s, '3', 99);
    expect(s.albums.map((x) => x.id)).toEqual(['1', '2', '3']);
    s = deleteAlbum(s, '1');
    expect(s.albums.map((x) => x.id)).toEqual(['2', '3']);
  });
  test('deleting an album never deletes or hides its items', () => {
    let s = make(emptyAlbums(), 'A', [a], '1').state;
    s = make(s, 'B', [a], '2').state;
    s = deleteAlbum(s, '1');
    expect(filterView([a], (k) => k, s, ALL_VIEW)).toEqual([a]);
    expect(albumsOf(s, a).map((x) => x.id)).toEqual(['2']);
  });
  test('a view on a deleted album falls back to All', () => {
    const s = deleteAlbum(make(emptyAlbums(), 'A', [], '1').state, '1');
    expect(liveView(s, { kind: 'album', id: '1' })).toBe(ALL_VIEW);
  });
});

describe('membership', () => {
  test('an item can be in several albums, once each', () => {
    let s = make(emptyAlbums(), 'A', [], '1').state;
    s = make(s, 'B', [], '2').state;
    s = addToAlbum(s, '1', [a, a, t]);
    s = addToAlbum(s, '2', [a]);
    expect(s.albums[0].items).toEqual([a, t]);
    expect(albumsOf(s, a).map((x) => x.id)).toEqual(['1', '2']);
    s = removeFromAlbum(s, '1', [a]);
    expect(albumsOf(s, a).map((x) => x.id)).toEqual(['2']);
  });
  test('tick state for a selection: all / some / none, and tick toggles all of them', () => {
    let s = make(emptyAlbums(), 'A', [a], '1').state;
    expect(membership(s, '1', [a])).toBe('all');
    expect(membership(s, '1', [a, b])).toBe('some');
    expect(membership(s, '1', [b])).toBe('none');
    s = setInAlbum(s, '1', [a, b], true);
    expect(membership(s, '1', [a, b])).toBe('all');
    s = setInAlbum(s, '1', [a, b], false);
    expect(membership(s, '1', [a, b])).toBe('none');
  });
});

describe('parse', () => {
  test('drops malformed albums, keys and duplicates', () => {
    const s = parseAlbums({
      albums: [
        { id: '1', name: 'Ok', items: [a, 'evil', 5, a] },
        { id: '1', name: 'Dup', items: [] },
        { id: '', name: 'No id' },
        { id: '3', name: '   ' },
        null,
      ],
      hidden: [b, 'x:y', b],
      updated: 'soon',
    });
    expect(s).toEqual({ v: 1, albums: [{ id: '1', name: 'Ok', items: [a] }], hidden: [b], updated: 0 });
    expect(parseAlbums('nope')).toEqual(emptyAlbums());
  });
});

describe('storage (per identity)', () => {
  const g = globalThis as { localStorage?: unknown };
  const before = g.localStorage;
  afterAll(() => {
    g.localStorage = before;
  });
  beforeEach(() => {
    const m = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  });
  test('round-trips and keeps identities apart', () => {
    let calls = 0;
    const off = onAlbums(() => calls++);
    updateAlbums('idA', (s) => setHidden(make(s, 'Mine', [a], '1').state, [b], true));
    expect(loadAlbums('idA').albums[0].items).toEqual([a]);
    expect(loadAlbums('idA').hidden).toEqual([b]);
    expect(loadAlbums('idB')).toEqual(emptyAlbums());
    expect(loadAlbums(null)).toEqual(emptyAlbums());
    expect(calls).toBe(1);
    off();
    saveAlbums('idA', emptyAlbums());
    expect(calls).toBe(1);
  });
  test('corrupt storage reads as empty', () => {
    localStorage.setItem('bwx:albums:idA', '{not json');
    expect(loadAlbums('idA')).toEqual(emptyAlbums());
  });
});
