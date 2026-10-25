import { describe, expect, test } from 'bun:test';
import { authorProfileUrl, authorRef, fetchAuthorPage, type AuthorDeps } from './authorFeed';
import { fetchOpenFeed, openFeedUrl, parseOpenFeed, parseOpenPost } from './openFeed';
import { mergePosts } from './post';
import { postActions, SOURCE_REGISTRY, sourceOf, sourceUrl } from './sources';
import { planPayment } from './tip';

const TX = 'cd'.repeat(32);

// Shapes from the live GET https://www.bchatx.com/api/feed/open (25 Oct 2026).
const COINGEEK = {
  txid: 'coingeek:625714',
  url: 'https://www.bitcoinchat.onlinehttps://coingeek.com/?p=625714',
  text: 'CoinDCX belatedly admits latest heist\n\nCoinDCX admits a $16M loss.',
  mediaCount: 1,
  author: { name: 'CoinGeek', handle: 'coingeek' },
  source: 'coingeek',
  sourceLabel: 'coingeek',
  sourceUrl: 'https://coingeek.com/?p=625714',
  at: 1792753200000,
  replyTo: null,
  likes: 0,
  replies: 0,
  language: null,
};
const HODL = {
  txid: TX,
  text: 'post night',
  mediaCount: 0,
  author: { name: '19bb7…w6aU', handle: null },
  source: 'hodlocker',
  sourceUrl: null,
  at: 1773541550000,
  replyTo: null,
  likes: 5,
  replies: 0,
  language: 'strong',
};

describe('bChatX Open Feed sources', () => {
  test('url asks for one source, limit clamped to 1..50', () => {
    expect(openFeedUrl('coingeek')).toBe('https://www.bchatx.com/api/feed/open?source=coingeek&limit=50');
    expect(openFeedUrl('relayx', 500)).toBe('https://www.bchatx.com/api/feed/open?source=relayx&limit=50');
    expect(openFeedUrl('hodlocker', 0)).toBe('https://www.bchatx.com/api/feed/open?source=hodlocker&limit=1');
  });

  test('a CoinGeek article: source, unpayable author, article link, read-only actions', () => {
    const p = parseOpenPost(COINGEEK, 'coingeek')!;
    expect(p.source).toBe('coingeek');
    expect(sourceOf(p.app)).toBe('coingeek');
    expect(p.author.address).toBe('coingeek:coingeek');
    expect(p.author.name).toBe('CoinGeek');
    expect(p.text).toContain('CoinDCX');
    expect(sourceUrl(p)).toBe('https://coingeek.com/?p=625714');
    expect(postActions(p)).toEqual({ row: ['open'], more: ['copyLink', 'report', 'mute'] });
    expect(() => planPayment('tip', p, 1000)).toThrow();
  });

  test('Hodlocker / RelayX posts keep the basic card; no original link (sites are gone)', () => {
    const p = parseOpenPost(HODL, 'hodlocker')!;
    expect(p.txid).toBe(TX);
    expect(p.likes).toBe(5);
    expect(p.language).toBe('strong');
    expect(p.author.address).toBe('hodlocker:19bb7…w6aU');
    expect(sourceUrl(p)).toBeNull();
    expect(postActions(p).row).toEqual(['reply', 'like', 'tip', 'lock']);
    expect(postActions(p).more).toEqual(['report', 'mute']);
    expect(() => planPayment('tip', p, 1000)).toThrow();
    expect(SOURCE_REGISTRY.relayx.label).toBe('RelayX');
  });

  test('only the asked-for source is kept: no duplicates of sources read directly', () => {
    const body = {
      posts: [
        COINGEEK,
        COINGEEK,
        { ...COINGEEK, txid: TX, source: 'twetch' },
        { ...COINGEEK, txid: 'coingeek:2', replyTo: 'coingeek:1' },
        { ...COINGEEK, txid: 'coingeek:3', text: '' },
        { ...COINGEEK, txid: '' },
      ],
    };
    expect(parseOpenFeed(body, 'coingeek').map((p) => p.txid)).toEqual(['coingeek:625714']);
    expect(parseOpenFeed(null, 'coingeek')).toEqual([]);
    expect(parseOpenFeed({ posts: 'x' }, 'relayx')).toEqual([]);
    expect(parseOpenPost(HODL, 'relayx')).toBeNull();
    // A txid already read elsewhere merges to one post.
    const direct = { ...parseOpenPost(HODL, 'hodlocker')!, source: 'twetch' as const };
    expect(mergePosts([direct], parseOpenFeed({ posts: [HODL] }, 'hodlocker'))).toHaveLength(1);
  });

  test('fetch goes through the given client and throws on failure', async () => {
    const seen: string[] = [];
    const posts = await fetchOpenFeed('coingeek', 50, async (u) => (seen.push(u), { posts: [COINGEEK] }));
    expect(posts).toHaveLength(1);
    expect(seen[0]).toContain('source=coingeek');
    await expect(
      fetchOpenFeed('coingeek', 50, async () => {
        throw new Error('down');
      }),
    ).rejects.toThrow();
  });

  test("author pages: CoinGeek's bChatX profile; posts filtered from the source's feed", async () => {
    const cg = parseOpenPost(COINGEEK, 'coingeek')!;
    const r = authorRef(cg.author);
    expect(r).toEqual({ source: 'coingeek', id: 'coingeek', bapId: null });
    expect(authorProfileUrl(r)).toBe('https://www.bchatx.com/u/coingeek');
    expect(authorRef({ address: 'relayx:1AAhB…DpCe', bapId: null })).toEqual({
      source: 'relayx',
      id: '1AAhB…DpCe',
      bapId: null,
    });
    expect(authorProfileUrl({ source: 'hodlocker', id: 'x', bapId: null })).toBeNull();
    const other = parseOpenPost({ ...HODL, txid: 'ef'.repeat(32), author: { name: 'someone' } }, 'hodlocker')!;
    const d: AuthorDeps = {
      getJson: async () => ({}),
      bchatApi: '',
      bmapApi: '',
      fwetchPage: async () => [],
      openFeed: async (s) => (s === 'hodlocker' ? [parseOpenPost(HODL, 'hodlocker')!, other] : []),
    };
    const page = await fetchAuthorPage(authorRef(parseOpenPost(HODL, 'hodlocker')!.author), null, d);
    expect(page.posts.map((p) => p.txid)).toEqual([TX]);
    expect(page.next).toBeNull();
  });
});
