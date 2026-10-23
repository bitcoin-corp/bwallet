import type { HotRoom, Listing } from './indexer';
import { safety, type SafetyFilter } from './safety';

/**
 * Safety checks for Market rooms. Both carry the inscription's MAP fields so the metadata check (nsfw / adult /
 * rating flags) runs here too, not only the text and id checks (b-Aware report, 23 Oct 2026).
 */

/** A trending room (token or collection): its id, title, subtitle and, for a collection, its MAP. */
export const hotRoomSafe = (r: HotRoom, s: SafetyFilter = safety()): boolean =>
  !s.check({
    ids: [r.ref.id],
    collectionId: r.ref.kind === 'coll' ? r.ref.id : null,
    texts: [r.title, r.subtitle],
    map: r.map,
  }).blocked;

/** One listing inside a collection room: the item's ids, label, the room's title, and the item's MAP. */
export const roomListingSafe = (
  l: Pick<Listing, 'outpoint' | 'origin' | 'label' | 'map'>,
  room: { id: string; title: string },
  s: SafetyFilter = safety(),
): boolean =>
  !s.check({ ids: [l.outpoint, l.origin], collectionId: room.id, texts: [l.label, room.title], map: l.map }).blocked;
