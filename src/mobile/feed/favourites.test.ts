import { beforeEach, describe, expect, test } from 'bun:test';
import { filterFavourites, isFavourite, loadFavourites, toggleFavourite, type Favourite } from './store';
import type { FeedPost } from './post';

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const post = (txid: string, source: FeedPost['source'], address: string, bapId: string | null = null) =>
  ({ txid, source, author: { address, bapId, name: address } }) as unknown as FeedPost;

const posts = [
  post('a', 'twetch', '1Alice'),
  post('b', 'treechat', '1Bob', 'BAPbob'),
  post('c', 'coingeek', '1Cg'),
  post('d', 'twetch', '1Carol'),
];

describe('favourites', () => {
  beforeEach(() => mem.clear());

  test('empty list shows nothing', () => {
    expect(loadFavourites()).toEqual([]);
    expect(filterFavourites(posts, [])).toEqual([]);
  });

  test('source favourite keeps that source only', () => {
    const favs = toggleFavourite([], { kind: 'source', id: 'twetch' });
    expect(filterFavourites(posts, favs).map((p) => p.txid)).toEqual(['a', 'd']);
  });

  test('author favourite matches by address or bapId', () => {
    const byBap: Favourite = { kind: 'author', address: '1Other', bapId: 'BAPbob', name: 'Bob' };
    expect(filterFavourites(posts, [byBap]).map((p) => p.txid)).toEqual(['b']);
    const byAddr: Favourite = { kind: 'author', address: '1Carol', bapId: null, name: 'Carol' };
    expect(filterFavourites(posts, [byAddr, { kind: 'source', id: 'coingeek' }]).map((p) => p.txid)).toEqual([
      'c',
      'd',
    ]);
  });

  test('toggle adds, persists and removes', () => {
    const f: Favourite = { kind: 'source', id: 'peck' };
    const on = toggleFavourite([], f);
    expect(isFavourite(on, f)).toBe(true);
    expect(loadFavourites()).toEqual([f]);
    expect(toggleFavourite(on, f)).toEqual([]);
    expect(loadFavourites()).toEqual([]);
  });

  test('corrupt storage reads as empty', () => {
    mem.set('bwallet.feed.favourites', '{not json');
    expect(loadFavourites()).toEqual([]);
    mem.set('bwallet.feed.favourites', JSON.stringify([{ kind: 'author' }, { kind: 'source', id: 'bchat' }]));
    expect(loadFavourites()).toEqual([{ kind: 'source', id: 'bchat' }]);
  });
});
