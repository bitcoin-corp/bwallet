import { beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_PREFS, initialFeed, loadPrefs, parsePrefs, savePrefs } from './prefs';
import { MAX_PER_MINUTE, WINDOW_MS, createOneClickGuard, decideOneClick } from './oneClick';
import {
  addBlock,
  addMute,
  blockKeys,
  isBlocked,
  isBookmarked,
  loadBlocks,
  loadBookmarks,
  loadMutes,
  MAX_BOOKMARKS,
  mutedAccounts,
  removeBlock,
  removeMute,
  toggleBookmark,
  visiblePosts,
} from '../feed/store';
import { SafetyFilter, normalizeBlocklist } from '../market/safety';
import type { FeedPost } from '../feed/post';
import { stubGlobals } from '../../testing/stubGlobals';

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const g = globalThis as unknown as { localStorage: MemStorage; window: EventTarget };
stubGlobals({ localStorage: new MemStorage(), window: new EventTarget() });
beforeEach(() => {
  g.localStorage = new MemStorage();
});

const post = (txid: string, address: string, bapId: string | null = null): FeedPost => ({
  txid,
  text: `post ${txid}`,
  images: [],
  media: [],
  links: [],
  app: 'bWallet',
  source: 'bwallet' as FeedPost['source'],
  threadId: null,
  replyTo: null,
  author: { address, bapId, name: `name-${address}`, avatar: null },
  at: 0,
  likes: 0,
  replies: 0,
});

describe('prefs', () => {
  test('defaults when empty or garbage', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('nope')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ defaultFeed: 'x', autoplay: 'yes', oneClickLimit: 5, quickTip: -3 })).toEqual(DEFAULT_PREFS);
  });
  test('save merges and persists', () => {
    savePrefs({ autoplay: true });
    savePrefs({ oneClick: true, oneClickLimit: 10_000 });
    expect(loadPrefs()).toEqual({ ...DEFAULT_PREFS, autoplay: true, oneClick: true, oneClickLimit: 10_000 });
  });
  test('rejects limits outside the allowed set', () => {
    savePrefs({ oneClickLimit: 999_999 as never });
    expect(loadPrefs().oneClickLimit).toBe(DEFAULT_PREFS.oneClickLimit);
  });

  test('notification toggles and Twetch id validate field by field', () => {
    const p = parsePrefs({ notify: { social: false, chat: 'no', bogus: false }, twetchUserId: ' 13 ' });
    expect(p.notify).toEqual({ ...DEFAULT_PREFS.notify, social: false });
    expect(p.twetchUserId).toBe('13');
    expect(parsePrefs({ twetchUserId: 'abc' }).twetchUserId).toBe('');
  });
  test('default feed mapping', () => {
    expect(initialFeed('foryou', true)).toEqual({ tab: 'foryou', sort: 'locked' });
    expect(initialFeed('latest', true)).toEqual({ tab: 'foryou', sort: 'latest' });
    expect(initialFeed('following', true)).toEqual({ tab: 'following', sort: 'latest' });
    expect(initialFeed('following', false)).toEqual({ tab: 'foryou', sort: 'latest' });
  });
});

describe('one-click guard', () => {
  const on = { oneClick: true, oneClickLimit: 1_000 as const };
  test('off, bad amounts and over-limit never pass', () => {
    expect(decideOneClick(10, { ...on, oneClick: false }, [], 0)).toEqual({ ok: false, reason: 'off' });
    expect(decideOneClick(0, on, [], 0).ok).toBe(false);
    expect(decideOneClick(1.5, on, [], 0).ok).toBe(false);
    expect(decideOneClick(NaN, on, [], 0).ok).toBe(false);
    expect(decideOneClick(1_001, on, [], 0)).toEqual({ ok: false, reason: 'over-limit' });
    expect(decideOneClick(1_000, on, [], 0)).toEqual({ ok: true });
  });
  test('rate limit per rolling minute', () => {
    let prefs = on;
    const guard = createOneClickGuard(() => prefs);
    for (let i = 0; i < MAX_PER_MINUTE; i++) expect(guard.take(10, 1_000 + i).ok).toBe(true);
    expect(guard.take(10, 2_000)).toEqual({ ok: false, reason: 'rate' });
    expect(guard.peek(10, 1_000 + WINDOW_MS + MAX_PER_MINUTE).ok).toBe(true);
    expect(guard.take(10, 1_000 + WINDOW_MS + MAX_PER_MINUTE).ok).toBe(true);
    prefs = { ...on, oneClick: false };
    expect(guard.take(10, 10 * WINDOW_MS).ok).toBe(false);
  });
  test('peek does not record; denied takes do not record', () => {
    const guard = createOneClickGuard(() => on);
    for (let i = 0; i < 20; i++) guard.peek(10, i);
    for (let i = 0; i < 20; i++) guard.take(5_000, i);
    expect(guard.take(10, 30).ok).toBe(true);
  });
  test('per-minute total capped at MAX_PER_MINUTE × limit', () => {
    const hist = [
      { at: 0, sats: 1_000 },
      { at: 1, sats: 1_000 },
      { at: 2, sats: 1_000 },
      { at: 3, sats: 1_000 },
    ];
    expect(decideOneClick(1_000, on, hist, 10).ok).toBe(true);
    expect(decideOneClick(1_000, on, [...hist, { at: 4, sats: 999 }], 10).ok).toBe(false);
  });
});

describe('bookmarks', () => {
  test('toggle saves and removes, newest first, persisted', () => {
    let b = toggleBookmark([], post('a', 'x'));
    b = toggleBookmark(b, post('b', 'y'));
    expect(b.map((p) => p.txid)).toEqual(['b', 'a']);
    expect(isBookmarked(loadBookmarks(), 'a')).toBe(true);
    b = toggleBookmark(b, post('a', 'x'));
    expect(loadBookmarks().map((p) => p.txid)).toEqual(['b']);
  });
  test('capped', () => {
    let b: FeedPost[] = [];
    for (let i = 0; i < MAX_BOOKMARKS + 5; i++) b = toggleBookmark(b, post(String(i), 'x'));
    expect(b.length).toBe(MAX_BOOKMARKS);
    expect(b[0].txid).toBe(String(MAX_BOOKMARKS + 4));
  });
});

describe('mutes and blocks', () => {
  test('unmute removes every key of an account', () => {
    addMute([], 'addr1', 'bap1');
    const groups = mutedAccounts(loadMutes(), { addr1: 'Alice', bap1: 'Alice' });
    expect(groups).toEqual([{ name: 'Alice', keys: ['addr1', 'bap1'] }]);
    removeMute(loadMutes(), ...groups[0].keys);
    expect(loadMutes()).toEqual([]);
  });
  test('block by address or bap id; unblock', () => {
    addBlock([], { address: 'a1', bapId: 'b1', name: 'Bob' });
    addBlock(loadBlocks(), { address: 'a1', bapId: 'b1', name: 'Bob' });
    expect(loadBlocks().length).toBe(1);
    expect(isBlocked(loadBlocks(), { address: 'other', bapId: 'b1' })).toBe(true);
    expect(blockKeys(loadBlocks())).toEqual(['a1', 'b1']);
    removeBlock(loadBlocks(), { address: 'a1', bapId: null });
    expect(loadBlocks()).toEqual([]);
  });
  test('blocked authors are hidden from posts and replies', () => {
    const posts = [post('1', 'a1'), post('2', 'a2', 'b1'), post('3', 'a3')];
    const keys = blockKeys(addBlock([], { address: 'zz', bapId: 'b1', name: 'B' }));
    const shown = visiblePosts(posts, ['a1', ...keys], new SafetyFilter(normalizeBlocklist({})));
    expect(shown.map((p) => p.txid)).toEqual(['3']);
  });
});
