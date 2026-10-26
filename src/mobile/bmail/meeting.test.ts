import { describe, expect, test } from 'bun:test';
import {
  bchatxRoomTicker,
  canJoinMeeting,
  findMeetingLink,
  MEETING_EARLY_MS,
  meetingPhase,
  parseComposeLink,
  parseComposeQuery,
} from './meeting';
import { BODY_MAX, SUBJECT_MAX } from './envelope';
import { meetingRoute, routeFromData, routeFromQuery, routeToQuery } from '../push/logic';
import { iconBadgeText, resetIconBadge, setIconBadge } from '../tabs/iconBadge';
import { isAppUrl } from '../desktop/links';

const START = Date.parse('2026-10-27T15:00:00Z');
const MIN = 60_000;

describe('meetingPhase', () => {
  test('before, live, over', () => {
    expect(meetingPhase(START, 30, START - 1)).toBe('before');
    expect(meetingPhase(START, 30, START)).toBe('live');
    expect(meetingPhase(START, 30, START + 29 * MIN)).toBe('live');
    expect(meetingPhase(START, 30, START + 30 * MIN)).toBe('over');
  });
  test('no duration counts as an hour; bad start is null', () => {
    expect(meetingPhase(START, undefined, START + 59 * MIN)).toBe('live');
    expect(meetingPhase(START, 0, START + 61 * MIN)).toBe('over');
    expect(meetingPhase(NaN, 30, START)).toBeNull();
  });
  test('join opens 10 minutes early', () => {
    expect(canJoinMeeting(START, START - MEETING_EARLY_MS - 1)).toBe(false);
    expect(canJoinMeeting(START, START - MEETING_EARLY_MS)).toBe(true);
    expect(canJoinMeeting(undefined, 0)).toBe(true);
  });
});

describe('meeting_invite push route', () => {
  const data = {
    kind: 'meeting_invite',
    ticker: 'BOARD',
    startsAt: '2026-10-27T15:00:00Z',
    durationMin: 30,
    url: 'https://www.bchatx.com/room/BOARD',
  };
  test('not started → bMail', () => {
    expect(routeFromData(data, START - 5 * MIN)).toEqual({ segment: 'mail', ticker: 'BOARD' });
  });
  test('live → room, plus the canonical bChatX page', () => {
    expect(routeFromData(data, START + MIN)).toEqual({
      segment: 'rooms',
      ticker: 'BOARD',
      openUrl: 'https://www.bchatx.com/room/BOARD',
    });
  });
  test('over → bMail; FCM string durations work', () => {
    expect(routeFromData({ ...data, durationMin: '30' }, START + 31 * MIN)).toEqual({
      segment: 'mail',
      ticker: 'BOARD',
    });
  });
  test('a foreign url is never opened', () => {
    const r = meetingRoute({ ...data, url: 'https://evil.example/room/BOARD' }, START + MIN);
    expect(r).toEqual({ segment: 'rooms', ticker: 'BOARD', openUrl: 'https://www.bchatx.com/room/BOARD' });
  });
  test('ticker from url; nothing usable → null', () => {
    expect(meetingRoute({ url: 'https://bchatx.com/chat?room=abc' }, 0)).toEqual({ segment: 'mail', ticker: 'ABC' });
    expect(meetingRoute({ url: 'javascript:alert(1)' }, 0)).toBeNull();
  });
  test('mail query round trip', () => {
    expect(routeToQuery({ segment: 'mail', ticker: 'BOARD' })).toBe('push=mail:BOARD');
    expect(routeFromQuery('?push=mail:BOARD')).toEqual({ segment: 'mail', ticker: 'BOARD' });
    expect(routeFromQuery('?push=mail:%3Cx%3E')).toBeNull();
  });
});

describe('bChatX links in a bMail', () => {
  test('room and chat?room forms, https bchatx only', () => {
    expect(bchatxRoomTicker('https://www.bchatx.com/room/Board')).toBe('BOARD');
    expect(bchatxRoomTicker('https://www.bchatx.com/chat?room=$board')).toBe('BOARD');
    expect(bchatxRoomTicker('http://www.bchatx.com/room/BOARD')).toBeNull();
    expect(bchatxRoomTicker('https://bchatx.com.evil.io/room/BOARD')).toBeNull();
  });
  test('finds the link and the startsAt / duration markers', () => {
    const body =
      'Board meeting.\nJoin: https://www.bchatx.com/room/BOARD.\nstartsAt=2026-10-27T15:00:00Z durationMin=45';
    expect(findMeetingLink(body)).toEqual({
      ticker: 'BOARD',
      url: 'https://www.bchatx.com/room/BOARD',
      startsAt: START,
      durationMin: 45,
    });
    expect(findMeetingLink('Starts at: 2026-10-27T16:00:00+01:00 https://bchatx.com/chat?room=x')?.startsAt).toBe(
      START,
    );
    expect(findMeetingLink('see https://example.com/room/BOARD')).toBeNull();
  });
});

describe('compose link', () => {
  test('bwalletx://mail/compose fills the fields', () => {
    expect(parseComposeLink('bwalletx://mail/compose?to=%24alice&subject=Board%20meeting&body=Join%20at%203')).toEqual({
      to: '$alice',
      subject: 'Board meeting',
      body: 'Join at 3',
    });
  });
  test('web form, paymail recipient', () => {
    expect(parseComposeLink('https://web.bwalletx.com/?mail=compose&to=bob@bwalletx.com&subject=Hi')).toEqual({
      to: 'bob@bwalletx.com',
      subject: 'Hi',
    });
    expect(parseComposeQuery('?mail=compose&body=x')).toEqual({ body: 'x' });
    expect(parseComposeQuery('?mail=other&body=x')).toBeNull();
  });
  test('length caps, bad recipients dropped, other links ignored', () => {
    const long = parseComposeLink(
      `bwalletx://mail/compose?to=not%20a%20name&subject=${'s'.repeat(500)}&body=${'b'.repeat(20_000)}`,
    )!;
    expect(long.to).toBeUndefined();
    expect(long.subject!.length).toBe(SUBJECT_MAX);
    expect(long.body!.length).toBe(BODY_MAX);
    expect(parseComposeLink('bwalletx://space/abc')).toBeNull();
    expect(parseComposeLink('https://evil.example/?mail=compose&to=$a')).toBeNull();
  });
  test('Desktop lets the compose link through', () => {
    expect(isAppUrl('bwalletx://mail/compose?to=%24alice')).toBe(true);
  });
});

describe('extension icon badge', () => {
  test('text', () => {
    expect(iconBadgeText(0)).toBe('');
    expect(iconBadgeText(3)).toBe('3');
    expect(iconBadgeText(250)).toBe('99+');
  });
  test('writes only on change, clears at 0', () => {
    resetIconBadge();
    const calls: string[] = [];
    const api = { setBadgeText: ({ text }: { text: string }) => void calls.push(text) };
    setIconBadge(2, api);
    setIconBadge(2, api);
    setIconBadge(0, api);
    expect(calls).toEqual(['2', '']);
  });
});
