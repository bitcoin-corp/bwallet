import { beforeEach, describe, expect, test } from 'bun:test';
import {
  badgeLabel,
  badgeText,
  badgesVersion,
  chatUnread,
  chatUnreadSplit,
  missedCallsSince,
  clearChatBadges,
  countNewSince,
  feedNew,
  markFeedViewed,
  mergeChatRooms,
  resetBadgesForTest,
  walletBadgeLabel,
  setChatRooms,
  setFeedLatest,
  subscribeBadges,
} from './tabBadges';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

beforeEach(() => {
  mem.clear();
  resetBadgesForTest();
});

describe('badge text and labels', () => {
  test('none, counts, and the 99+ cap', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-2)).toBe('');
    expect(badgeText(3)).toBe('3');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
  test('accessible labels', () => {
    expect(badgeLabel('Chat', 3)).toBe('Chat, 3 unread');
    expect(badgeLabel('Chat', 0)).toBe('Chat');
    expect(badgeLabel('Feed', 250)).toBe('Feed, 99+ unread');
    expect(walletBadgeLabel('Wallet', 2)).toBe('Wallet, 2 rooms to set up');
    expect(walletBadgeLabel('Wallet', 1)).toBe('Wallet, 1 room to set up');
    expect(walletBadgeLabel('Wallet', 0)).toBe('Wallet');
  });
});

describe('chat unread', () => {
  test('sums rooms and DMs, skipping muted rooms', () => {
    setChatRooms([
      { ticker: '$PEPE', unread: 2 },
      { ticker: 'dm-alice', unread: 5 },
      { ticker: 'LOUD', unread: 40 },
      { ticker: 'QUIET', unread: null },
    ]);
    expect(chatUnread()).toBe(47);
    expect(chatUnread((t) => t === 'LOUD')).toBe(7);
  });
  test('a chat list opening a room clears that room only', () => {
    setChatRooms([
      { ticker: 'A', unread: 2 },
      { ticker: 'B', unread: 3 },
    ]);
    mergeChatRooms([{ ticker: '$a', unread: 0 }]);
    expect(chatUnread()).toBe(3);
  });
  test('merge without a change does not notify; sign-out clears', () => {
    setChatRooms([{ ticker: 'A', unread: 1 }]);
    let calls = 0;
    const off = subscribeBadges(() => calls++);
    mergeChatRooms([{ ticker: 'A', unread: 1 }]);
    expect(calls).toBe(0);
    clearChatBadges();
    expect(calls).toBe(1);
    expect(chatUnread()).toBe(0);
    off();
  });
});

describe('feed new posts', () => {
  test('counts posts newer than the cursor', () => {
    expect(countNewSince([1, 5, 9], 5)).toBe(1);
    expect(countNewSince([], 5)).toBe(0);
  });
  test('first background check sets the cursor: no badge for history', () => {
    setFeedLatest([100, 200]);
    expect(feedNew()).toBe(0);
    setFeedLatest([100, 200, 300, 400]);
    expect(feedNew()).toBe(2);
  });
  test('viewing the Feed clears it, and only notifies when the cursor moves', () => {
    setFeedLatest([100]);
    setFeedLatest([100, 300]);
    expect(feedNew()).toBe(1);
    markFeedViewed();
    expect(feedNew()).toBe(0);
    const v = badgesVersion();
    markFeedViewed();
    expect(badgesVersion()).toBe(v);
  });
  test('a failed storage write does not make every view a new cursor (no update loop, error #185)', () => {
    setFeedLatest([100]);
    setFeedLatest([100, 300]);
    const realSet = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      markFeedViewed();
      expect(feedNew()).toBe(0);
      const v = badgesVersion();
      // useTabBadges calls this on every badge change: it must settle, not emit again.
      for (let i = 0; i < 5; i++) markFeedViewed();
      expect(badgesVersion()).toBe(v);
    } finally {
      localStorage.setItem = realSet;
    }
  });
  test('no posts and no storage: the first view sets a cursor once', () => {
    const realSet = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('blocked');
    };
    try {
      markFeedViewed();
      const v = badgesVersion();
      markFeedViewed();
      expect(badgesVersion()).toBe(v);
    } finally {
      localStorage.setItem = realSet;
    }
  });
});

describe('Chat filter badges', () => {
  test('splits unread into DMs and rooms, muted left out', () => {
    setChatRooms([
      { ticker: 'DM1', name: '$me ↔ $alice', unread: 2 },
      { ticker: 'DM2', name: '$me ↔ $bob', unread: 1 },
      { ticker: '$LOUNGE', name: 'Lounge', unread: 4 },
      { ticker: 'VEX', unread: 3 },
    ]);
    expect(chatUnreadSplit()).toEqual({ dms: 3, rooms: 7 });
    expect(chatUnreadSplit((t) => t === 'DM2' || t === 'VEX')).toEqual({ dms: 2, rooms: 4 });
    mergeChatRooms([{ ticker: 'DM3', name: '$me ↔ $carol', unread: 5 }]);
    expect(chatUnreadSplit().dms).toBe(8);
  });
  test('missed calls: incoming, unanswered, after the cursor', () => {
    const at = (s: string) => `2026-10-16T0${s}:00:00Z`;
    const calls = [
      { id: 'a', direction: 'incoming', status: 'missed', answered_at: null, created_at: at('2') },
      { id: 'b', direction: 'incoming', status: 'ended', answered_at: at('3'), created_at: at('3') },
      { id: 'c', direction: 'outgoing', status: 'missed', answered_at: null, created_at: at('4') },
      { id: 'd', direction: 'incoming', status: 'ringing', answered_at: null, created_at: at('5') },
      { id: 'e', direction: 'incoming', status: 'cancelled', answered_at: null, created_at: at('1') },
    ];
    expect(missedCallsSince(calls, Date.parse(at('0')))).toBe(2);
    expect(missedCallsSince(calls, Date.parse(at('1')))).toBe(1);
    expect(missedCallsSince(calls, Date.parse(at('0')), new Set(['a']))).toBe(1);
    expect(missedCallsSince(calls, null)).toBe(0);
  });
});
