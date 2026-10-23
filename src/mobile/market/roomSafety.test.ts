import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { hotBoard, itemCollection, parseRoom, recentListings, roomMarket } from './indexer';
import { hotRoomSafe, roomListingSafe } from './roomSafety';

// An item whose only adult signal is its MAP flag: name and collection title are clean text.
const COLL = 'cd'.repeat(32) + '_0';
const FLAGGED = 'ef'.repeat(32) + '.0';
const CLEAN = 'ab'.repeat(32) + '.0';
const item = (name: string, extra: Record<string, unknown>) => ({
  contentType: 'image/png',
  map: { name, subType: 'collectionItem', subTypeData: JSON.stringify({ collectionId: COLL }), ...extra },
});
const META: Record<string, unknown> = {
  [FLAGGED]: { ...item('Sunset #1', { nsfw: 'true' }), origin: FLAGGED },
  [CLEAN]: { ...item('Sunset #2', {}), origin: CLEAN },
};
const ROWS = [FLAGGED, CLEAN].map((outpoint) => ({
  outpoint,
  score: 1,
  data: { ordlock: { price: 1000, seller: { AddressString: '1D9saMvDKdbRkqSG7euSwjhThz7XiiwNyt' } } },
}));

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/txo/search')) return Response.json(ROWS);
    const m = url.match(/\/ordfs\/metadata\/([0-9a-f]{64}\.\d+):-2$/);
    if (m && META[m[1]]) return Response.json(META[m[1]]);
    if (url.includes(`/ordfs/metadata/${COLL.replace('_', '.')}`))
      return Response.json({ contentType: 'image/png', map: { name: 'Sunsets', rating: 'nsfw' } });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('Market room safety uses MAP metadata', () => {
  test('itemCollection carries the MAP', async () => {
    const info = await itemCollection(FLAGGED.replace('.', '_'));
    expect(info?.map?.nsfw).toBe('true');
  });

  test('live listings carry the MAP into the collection room, and the flagged item is blocked', async () => {
    const live = await recentListings('active');
    const flagged = live.find((l) => l.outpoint === FLAGGED.replace('.', '_'));
    expect(flagged?.map?.nsfw).toBe('true');
    const ref = parseRoom('coll', COLL)!;
    const market = await roomMarket(ref);
    const f = market.listings.find((l) => l.outpoint === FLAGGED.replace('.', '_'))!;
    const c = market.listings.find((l) => l.outpoint === CLEAN.replace('.', '_'))!;
    expect(f.map?.nsfw).toBe('true');
    expect(roomListingSafe(f, { id: COLL, title: 'Sunsets' })).toBe(false);
    expect(roomListingSafe(c, { id: COLL, title: 'Sunsets' })).toBe(true);
  });

  test('a trending collection room whose MAP is adult-rated is blocked', async () => {
    const rooms = await hotBoard();
    const room = rooms.find((r) => r.ref.kind === 'coll' && r.ref.id === parseRoom('coll', COLL)!.id);
    expect(room?.map?.rating).toBe('nsfw');
    expect(hotRoomSafe(room!)).toBe(false);
    expect(hotRoomSafe({ ...room!, map: { name: 'Sunsets' } })).toBe(true);
  });
});
