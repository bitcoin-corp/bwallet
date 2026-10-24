import { describe, expect, test } from 'bun:test';
import {
  addTicket,
  doorText,
  guardCopy,
  guardFor,
  myRooms,
  newTicket,
  parseRoomPath,
  removeTicket,
  roomPath,
  slugPart,
  subRoomProblem,
  ticketNote,
} from './nrt';
import type { ChatRoom } from '../chat/messages';

describe('room paths', () => {
  test('right-hand part is the bigger container', () => {
    expect(roomPath('Studio', 'richardwboase')).toBe('studio.richardwboase');
    expect(roomPath('studio')).toBe('studio');
    expect(parseRoomPath('studio.richardwboase')).toEqual({ name: 'studio', parent: 'richardwboase' });
    expect(parseRoomPath('$lounge')).toEqual({ name: 'lounge', parent: null });
  });
  test('slug', () => {
    expect(slugPart('  My Studio! ')).toBe('my-studio');
    expect(slugPart('$Abc')).toBe('abc');
  });
  test('sub-room only inside my rooms', () => {
    expect(subRoomProblem('studio', null, [])).toBeNull();
    expect(subRoomProblem('studio', 'richardwboase', ['richardwboase'])).toBeNull();
    expect(subRoomProblem('studio', 'npg', ['richardwboase'])).toMatch(/rooms you own/);
    expect(subRoomProblem('!!', 'richardwboase', ['richardwboase'])).toMatch(/letters/);
  });
});

describe('tickets', () => {
  const studio = newTicket({ kind: 'token', id: 'a_0', label: '$STUDIO', mine: true });
  const npg = newTicket({ kind: 'token', id: 'b_0', label: '$NPG', mine: false });
  test('defaults: 1, burned on entry', () => {
    expect(studio.amount).toBe(1);
    expect(studio.onEntry).toBe('burn');
    expect(ticketNote(studio)).toBe('Your token · used up on entry');
    expect(ticketNote(npg)).toBe("Someone else's token · used up on entry");
  });
  test('a room accepts several, no duplicates', () => {
    let l = addTicket([], studio);
    l = addTicket(l, npg);
    l = addTicket(l, studio);
    expect(l.length).toBe(2);
    expect(removeTicket(l, studio).map((t) => t.id)).toEqual(['b_0']);
  });
  test('collection tickets are always 1', () => {
    const c = newTicket({ kind: 'collection', id: 'c_0', label: 'Foxes', mine: false, amount: 5 });
    expect(c.amount).toBe(1);
    expect(ticketNote({ ...c, onEntry: 'hold' })).toBe("Someone else's collection · shown at the door, kept");
  });
  test('door text', () => {
    expect(doorText('studio.richardwboase', [studio, npg], 'richardwboase')).toBe(
      'On the door: studio.richardwboase · entry 1 $STUDIO or 1 $NPG · owner $richardwboase',
    );
    expect(doorText('lounge', [], '')).toBe('On the door: lounge · free entry');
  });
});

describe('my rooms', () => {
  const r = (ticker: string, by: string | null, at = '', kind?: string): ChatRoom =>
    ({
      id: ticker,
      ticker,
      name: ticker,
      created_by_handle: by,
      created_at: at,
      metadata: kind ? { kind } : null,
    }) as ChatRoom;
  test('only rooms my names opened, no DMs, newest first', () => {
    const out = myRooms(
      [
        r('a', 'richardwboase', '2026-01-01'),
        r('b', 'other'),
        r('c', '$B0asey', '2026-02-01'),
        r('d', 'b0asey', '', 'direct'),
      ],
      ['richardwboase', 'b0asey'],
    );
    expect(out.map((x) => x.ticker)).toEqual(['c', 'a']);
  });
});

describe('guard', () => {
  test('nothing exists → go ahead', () => {
    expect(guardFor('token', [])).toBeNull();
    expect(guardFor('token', [{ kind: 'room', label: 'x' }])).toBeNull();
  });
  test('existing token → approved copy', () => {
    const e = guardFor('token', [{ kind: 'token', label: '$richardwboase', holders: 12, opens: ['richardwboase'] }]);
    expect(e).not.toBeNull();
    const c = guardCopy(e!);
    expect(c.title).toBe('You already have a $richardwboase token');
    expect(c.body).toBe(
      '12 people hold it and it opens your richardwboase room. A second token would split your friends between two.',
    );
    expect(c.keep).toBe('Use my existing token');
    expect(c.again).toBe('Make a second one anyway');
  });
});

describe('flag', () => {
  test('Names, Rooms and Tickets server parts are off by default', async () => {
    const { NRT_ENABLED } = await import('../storeBuild');
    expect(NRT_ENABLED).toBe(false);
  });
});
