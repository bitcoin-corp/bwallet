import { describe, expect, test } from 'bun:test';
import {
  addItems,
  allowed,
  countIncreases,
  describeIncoming,
  diffSeen,
  isMe,
  markAllRead,
  mentionNames,
  mentionsMe,
  nativeId,
  unreadCount,
  type NotifyItem,
} from './notify';

const it = (id: string, at: number, kind: NotifyItem['kind'] = 'reply'): NotifyItem => ({
  id,
  kind,
  title: id,
  body: '',
  at,
  read: false,
});

describe('notification list', () => {
  test('dedupes, sorts newest first, caps, reports only new', () => {
    const a = addItems([], [it('a', 1), it('b', 3), it('a', 1)]);
    expect(a.list.map((i) => i.id)).toEqual(['b', 'a']);
    expect(a.added).toHaveLength(2);
    const b = addItems(a.list, [it('b', 3), it('c', 2)], 2);
    expect(b.list.map((i) => i.id)).toEqual(['b', 'c']);
    expect(b.added.map((i) => i.id)).toEqual(['c']);
  });
  test('unread / read all', () => {
    const l = [it('a', 1), { ...it('b', 2), read: true }];
    expect(unreadCount(l)).toBe(1);
    expect(unreadCount(markAllRead(l))).toBe(0);
    const read = markAllRead(l);
    expect(markAllRead(read)).toBe(read);
  });
  test('category filter', () => {
    const l = [it('a', 1, 'reply'), it('b', 1, 'payment'), it('c', 1, 'sale')];
    const on = { social: true, mentions: true, chat: true, calls: true, payments: false, sales: true };
    expect(allowed(l, on).map((i) => i.id)).toEqual(['a', 'c']);
  });
});

describe('diffs', () => {
  test('first run seeds silently, later runs report fresh ids', () => {
    const first = diffSeen([], ['x', 'y'], false);
    expect(first).toEqual({ fresh: [], seen: ['x', 'y'] });
    const next = diffSeen(first.seen, ['y', 'z', 'z'], true);
    expect(next).toEqual({ fresh: ['z'], seen: ['x', 'y', 'z'] });
    expect(diffSeen(['a', 'b', 'c'], ['d'], true, 2).seen).toEqual(['c', 'd']);
  });
  test('count increases ignore new keys and decreases', () => {
    expect(countIncreases({ a: 1, b: 5 }, { a: 3, b: 4, c: 9 })).toEqual({ a: 2 });
  });
});

describe('who is me', () => {
  const me = { addresses: ['1Me'], bapId: 'BAPME', twetchUserId: '13' };
  test('address, BAP id or Twetch id', () => {
    expect(isMe({ address: '1Me', bapId: null }, me)).toBe(true);
    expect(isMe({ address: '1X', bapId: 'BAPME' }, me)).toBe(true);
    expect(isMe({ address: 'twetch:13', bapId: null }, me)).toBe(true);
    expect(isMe({ address: '1X', bapId: null }, me, '13')).toBe(true);
    expect(isMe({ address: '1X', bapId: null }, me, '14')).toBe(false);
  });
  test('mentions', () => {
    const names = mentionNames(['$Richard', 'richard@bwallet.app', 'ab', null]);
    expect(names).toEqual(['richard', 'richard@bwallet.app']);
    expect(mentionsMe('gm @richard!', names)).toBe(true);
    expect(mentionsMe('thanks $Richard', names)).toBe(true);
    expect(mentionsMe('pay richard@bwallet.app.', names)).toBe(true);
    expect(mentionsMe('@richardson hi', names)).toBe(false);
    expect(mentionsMe('richard without a sigil', names)).toBe(false);
    expect(mentionsMe('richard@bwallet.application', names)).toBe(false);
  });
});

describe('incoming outputs', () => {
  test('payments, tokens, tickets; own listings ignored', () => {
    expect(describeIncoming({ outpoint: 'a.0', satoshis: 150_000_000 })).toMatchObject({
      kind: 'payment',
      body: 'You received 1.5 BSV',
    });
    expect(describeIncoming({ outpoint: 'a.0', satoshis: 2000 })?.body).toBe('You received 2,000 sats');
    expect(
      describeIncoming({ outpoint: 'a.0', satoshis: 1, data: { bsv21: { id: 't_0', amt: '5', sym: 'FOO' } } }),
    ).toMatchObject({ kind: 'token', title: 'Tokens received', body: '5 $FOO' });
    expect(
      describeIncoming({ outpoint: 'a.0', satoshis: 1, data: { bsv21: { id: 't_0', amt: '1' } } }, new Set(['t_0'])),
    ).toMatchObject({ title: 'Ticket received' });
    expect(describeIncoming({ outpoint: 'a.0', satoshis: 1, data: { ordlock: {} } })).toBeNull();
    expect(describeIncoming({ outpoint: 'a.0', satoshis: 0 })).toBeNull();
  });
  test('native ids are stable positive ints', () => {
    expect(nativeId('reply:abc')).toBe(nativeId('reply:abc'));
    expect(nativeId('x')).toBeGreaterThan(0);
  });
});

describe('OS notices honour "Show message previews"', () => {
  test('off hides message and post text; payments and calls keep their body', async () => {
    const { osNoticeBody } = await import('./notify');
    expect(osNoticeBody({ kind: 'chat', body: 'my secret DM' }, false)).toBe('New message');
    expect(osNoticeBody({ kind: 'mention', body: '@me secret' }, false)).toBe('You were mentioned');
    expect(osNoticeBody({ kind: 'bmail', body: 'subject line' }, false)).toBe('New mail');
    expect(osNoticeBody({ kind: 'payment', body: 'You received 1k sats' }, false)).toBe('You received 1k sats');
    expect(osNoticeBody({ kind: 'chat', body: 'my secret DM' }, true)).toBe('my secret DM');
  });
});
