import { describe, expect, test } from 'bun:test';
import { bytesToSealed, decodeEnvelope, encodeEnvelope, newMessageId, sealedToBytes, type Envelope } from './envelope';
import { quote, rank, route, split, type MailMeta } from './route';
import { parseProfile } from '../calls/rateCard';
import { EXAMPLE_SWIPE } from './examples';

const K = (c: string) => `02${c.repeat(64)}`;
const env = (o: Partial<Envelope> = {}): Envelope => ({
  t: 'bmail',
  v: 1,
  id: 'ab'.repeat(16),
  from: K('a'),
  to: K('b'),
  at: 1000,
  sealed: 'c2VhbGVk',
  ...o,
});
const postage = {
  txid: 'f'.repeat(64),
  sats: 500,
  outputIndex: 0,
  beef: '0100',
  derivationPrefix: 'p',
  derivationSuffix: 's',
};

describe('envelope', () => {
  test('round-trips, including postage and reply-paid', () => {
    const e = env({ postage, replyPaidSats: 200, inReplyTo: 'cd'.repeat(16), usesReplyCredit: true });
    expect(decodeEnvelope(encodeEnvelope(e))).toEqual(e);
    expect(decodeEnvelope(JSON.parse(encodeEnvelope(e)))).toEqual(e);
  });
  test('rejects junk and bad fields', () => {
    expect(decodeEnvelope('not json')).toBeNull();
    expect(decodeEnvelope({ ...env(), t: 'x' })).toBeNull();
    expect(decodeEnvelope({ ...env(), from: 'nope' })).toBeNull();
    expect(decodeEnvelope({ ...env(), at: -1 })).toBeNull();
  });
  test('drops malformed postage and reply-paid above postage', () => {
    expect(decodeEnvelope({ ...env(), postage: { ...postage, txid: 'x' } })?.postage).toBeUndefined();
    expect(decodeEnvelope({ ...env(), postage: { ...postage, sats: 0 } })?.postage).toBeUndefined();
    expect(decodeEnvelope({ ...env(), postage, replyPaidSats: 900 })?.replyPaidSats).toBeUndefined();
    expect(decodeEnvelope({ ...env(), usesReplyCredit: true })?.usesReplyCredit).toBeUndefined();
  });
  test('sealed bytes round-trip and clamp', () => {
    expect(bytesToSealed(sealedToBytes({ subject: 'Hi', body: 'There ✉️' }))).toEqual({
      subject: 'Hi',
      body: 'There ✉️',
    });
    expect(bytesToSealed(sealedToBytes({ subject: 'x'.repeat(500), body: '' })).subject.length).toBe(120);
  });
  test('message ids are 32 hex chars', () => expect(newMessageId()).toMatch(/^[0-9a-f]{32}$/));
});

const m = (id: string, from: string, verifiedSats: number, at: number, replyCredit = false): MailMeta => ({
  id,
  from,
  verifiedSats,
  at,
  replyCredit,
});

describe('routing and ranking', () => {
  const friends = new Set([K('f')]);
  const isFriend = (k: string) => friends.has(k);
  test('friends free into Inbox; strangers need verified postage ≥ price', () => {
    expect(route(m('1', K('f'), 0, 1), { isFriend, priceSats: 100 })).toBe('inbox');
    expect(route(m('2', K('s'), 100, 1), { isFriend, priceSats: 100 })).toBe('inbox');
    expect(route(m('3', K('s'), 99, 1), { isFriend, priceSats: 100 })).toBe('requests');
    expect(route(m('4', K('s'), 0, 1), { isFriend, priceSats: 0 })).toBe('requests');
    expect(route(m('5', K('s'), 0, 1, true), { isFriend, priceSats: 100 })).toBe('inbox');
  });
  test('friends on top, then highest postage, ties newest; Newest toggle', () => {
    const mail = [m('a', K('s'), 100, 5), m('b', K('f'), 0, 1), m('c', K('t'), 900, 2), m('d', K('u'), 100, 9)];
    expect(rank(mail, { isFriend }).map((x) => x.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(rank(mail, { isFriend, newest: true }).map((x) => x.id)).toEqual(['d', 'a', 'c', 'b']);
    const s = split(mail, { isFriend, priceSats: 500 });
    expect(s.inbox.map((x) => x.id)).toEqual(['b', 'c']);
    expect(s.requests.map((x) => x.id)).toEqual(['d', 'a']);
  });
  test('quote: tiers are multiples of the price, reply paid added', () => {
    expect(quote(300, 'standard')).toEqual({ stamp: 300, replyPaid: 0, total: 300 });
    expect(quote(300, 'priority', 200)).toEqual({ stamp: 900, replyPaid: 200, total: 1100 });
    expect(quote(0, 'standard').stamp).toBe(1);
  });
  test('profile keeps a valid mail price only', () => {
    expect(parseProfile({ mail: { usd: 0.05 } }).mail).toEqual({ usd: 0.05 });
    expect(parseProfile({ mail: { usd: -1 } }).mail).toBeUndefined();
    expect('mail' in parseProfile({})).toBe(false);
  });
});

describe('examples', () => {
  test('no example mail on the phone build (real or removed)', async () => {
    const { examplesAllowed } = await import('./examples');
    expect(examplesAllowed(true)).toBe(false);
    expect(examplesAllowed(false)).toBe(true);
  });

  test('examples are display-only: ids can never be real message ids, inbox and requests both covered', async () => {
    const { EXAMPLES } = await import('./examples');
    for (const e of EXAMPLES) expect(/^[0-9a-f]{8,64}$/i.test(e.id)).toBe(false);
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    expect(EXAMPLES.some((e) => e.box === 'requests' && e.token?.spreading)).toBe(true);
    expect(EXAMPLES.some((e) => e.stamps.includes('reply'))).toBe(true);
  });
});

describe('bMail weighting and amounts', () => {
  test('sortMail: most paid, newest, friends', async () => {
    const { sortMail, filterMail } = await import('./route');
    const m = (id: string, at: number, verifiedSats: number, from = K('c')) => ({ id, from, at, verifiedSats });
    const list = [m('a', 3, 0, K('f')), m('b', 1, 900), m('c', 2, 300)];
    const isF = (k: string) => k === K('f');
    const r = { ...m('r', 0, 50), replyCredit: true };
    // Friends and reply-paid replies always pinned on top (newest first), then the chosen sort.
    expect(sortMail([...list, r], 'paid', isF).map((x) => x.id)).toEqual(['r', 'a', 'b', 'c']);
    expect(sortMail([...list, r], 'newest', isF).map((x) => x.id)).toEqual(['a', 'r', 'c', 'b']);
    // "Friends" is a filter: only pinned mail.
    expect(sortMail([...list, r], 'friends', isF).map((x) => x.id)).toEqual(['a', 'r']);
    expect(filterMail(list, 'paid').map((x) => x.id)).toEqual(['b', 'c']);
    expect(filterMail(list, 'tokens')).toEqual([]);
  });
  test('sortMail: a letter I pin moves to the top in every sort mode', async () => {
    const { sortMail } = await import('./route');
    const m = (id: string, at: number, verifiedSats: number, from = K('c')) => ({ id, from, at, verifiedSats });
    const isF = (k: string) => k === K('f');
    const low = { ...m('low', 0, 10), pinned: true };
    const list = [m('a', 3, 0, K('f')), m('b', 1, 900), m('c', 2, 300), low];
    // Pinned first, then friends, then the chosen sort.
    expect(sortMail(list, 'paid', isF).map((x) => x.id)).toEqual(['low', 'a', 'b', 'c']);
    expect(sortMail(list, 'newest', isF).map((x) => x.id)).toEqual(['low', 'a', 'c', 'b']);
    expect(sortMail(list, 'friends', isF).map((x) => x.id)).toEqual(['low', 'a']);
    // Unpinned it falls back into its place.
    const unpinned = list.map((x) => (x.id === 'low' ? { ...x, pinned: false } : x));
    expect(sortMail(unpinned, 'paid', isF).map((x) => x.id)).toEqual(['a', 'b', 'c', 'low']);
  });
  test('sortMail: one sender $0.04/$0.01/$0.03 after a reply, Most paid reorders', async () => {
    const { sortMail, shownSats } = await import('./route');
    // ~$0.01 = 2000 sats here. Replied-to sender is NOT a friend; a bPhone friend would be pinned but still sorted.
    const mail = [
      { id: 'four', from: K('d'), at: 3, verifiedSats: 8000 },
      { id: 'one', from: K('d'), at: 2, verifiedSats: 2000 },
      { id: 'three', from: K('d'), at: 1, verifiedSats: 6000 },
    ];
    expect(sortMail(mail, 'paid', () => false).map((x) => x.id)).toEqual(['four', 'three', 'one']);
    expect(sortMail(mail, 'paid', () => true).map((x) => x.id)).toEqual(['four', 'three', 'one']);
    expect(sortMail(mail, 'newest', () => true).map((x) => x.id)).toEqual(['four', 'one', 'three']);
    expect(mail.map(shownSats)).toEqual([8000, 2000, 6000]);
  });
  test('examples: amounts, PNEE, tokens, filters', async () => {
    const ex = await import('./examples');
    const by = (id: string) => ex.EXAMPLES.find((e) => e.id === id)!;
    expect(ex.amountOf(by('ex-intro'))).toEqual({ main: '$0.03', note: 'Priority stamp' });
    expect(ex.amountOf(by('ex-invoice')).note).toBe('+ $112.50 invoice');
    expect(ex.amountOf(by('ex-refund'))).toMatchObject({ main: '422 PNEEs', eq: '$4.22' });
    expect(ex.tokenLabel({ symbol: 'MOONZ', amount: 10_000 })).toBe('10,000 $MOONZ');
    expect(ex.filterExamples(ex.EXAMPLES, 'invoices').map((e) => e.id)).toEqual(['ex-invoice']);
    expect(ex.filterExamples(ex.EXAMPLES, 'tokens').length).toBeGreaterThan(4);
    const inbox = ex.sortExamples(
      ex.EXAMPLES.filter((e) => e.box === 'inbox'),
      'paid',
    );
    const firstStranger = inbox.findIndex((e) => !e.friend);
    expect(inbox.slice(0, firstStranger).every((e) => e.friend)).toBe(true);
    const strangers = inbox.slice(firstStranger);
    expect(strangers.every((e) => !e.friend)).toBe(true);
    expect(ex.totalCents(strangers[0])).toBeGreaterThanOrEqual(ex.totalCents(strangers[1]));
    expect(ex.sortExamples(inbox, 'friends').every((e) => e.friend)).toBe(true);
    const req = ex.sortExamples(
      ex.EXAMPLES.filter((e) => e.box === 'requests'),
      'spreading',
    );
    expect(req[0].id).toBe('ex-spreading');
  });
});

describe('swipe flags', () => {
  test('archive / delete / undo and pinned first', async () => {
    const { setFlags, restoreFlags, isLive, isArchived, pinnedFirst, emptyMail } = await import('./store');
    const mk = (id: string, extra = {}) => ({ id, from: 'k' + id, at: 1, verifiedSats: 0, ...extra }) as never;
    const s0 = { ...emptyMail(), received: [mk('a'), mk('b', { read: true })] };
    const { next, prev } = setFlags(s0, ['a'], { archived: true });
    expect(isLive(next.received[0])).toBe(false);
    expect(isArchived(next.received[0])).toBe(true);
    const back = restoreFlags(next, prev);
    expect(isLive(back.received[0])).toBe(true);
    expect(isLive(next.received[1], ['kb'])).toBe(false);
    const del = setFlags(s0, ['b'], { deleted: true }).next;
    expect(isArchived(del.received[1])).toBe(false);
    expect(pinnedFirst([{ id: 1 }, { id: 2, pinned: true }]).map((x) => x.id)).toEqual([2, 1]);
  });
});

describe('example swipe trays', () => {
  test('match real mail: Reply/Archive/Delete left, Read/Pin/Quarantine right, distinct ids', () => {
    expect(EXAMPLE_SWIPE.left.map((a) => a.label)).toEqual(['Reply', 'Archive', 'Delete']);
    expect(EXAMPLE_SWIPE.right.map((a) => a.label)).toEqual(['Read', 'Pin', 'Quarantine']);
    const ids = [...EXAMPLE_SWIPE.left, ...EXAMPLE_SWIPE.right].map((a) => a.id);
    expect(new Set(ids).size).toBe(6);
    expect(EXAMPLE_SWIPE.left.some((a) => a.id === EXAMPLE_SWIPE.fullLeft)).toBe(true);
    expect(EXAMPLE_SWIPE.right.some((a) => a.id === EXAMPLE_SWIPE.fullRight)).toBe(true);
  });
});

describe('reply-paid credit is single use (b-Aware, 24 Oct 2026)', () => {
  test('one credit pays for one reply, from the person it was sent to', async () => {
    const { replyCreditOk } = await import('./route');
    const sent = [{ id: 'aa11bb22', to: 'bob', replyPaidSats: 500 }];
    const env = { from: 'bob', inReplyTo: 'aa11bb22', usesReplyCredit: true };
    expect(replyCreditOk(env, sent, new Set())).toBe(true);
    expect(replyCreditOk(env, sent, new Set(['aa11bb22']))).toBe(false);
    expect(replyCreditOk({ ...env, from: 'eve' }, sent, new Set())).toBe(false);
    expect(replyCreditOk({ ...env, usesReplyCredit: false }, sent, new Set())).toBe(false);
    expect(replyCreditOk(env, [{ ...sent[0], replyPaidSats: 0 }], new Set())).toBe(false);
  });
});
