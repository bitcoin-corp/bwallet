/**
 * Names, Rooms and Tickets (owner, 24 Oct 2026: "build names rooms tickets"). Three separate things, each
 * optional, owned by the identity key, the same on every device:
 *  - Name: a $name. Getting one makes NO room and NO token.
 *  - Room: made any time, no token needed. Optional parent: studio.richardwboase is a smaller room inside
 *    richardwboase (the right-hand part is the bigger container, like DNS).
 *  - Ticket: something a room accepts at the door. Default kind: a fungible BSV-21 token, 1 used up on entry.
 *    A room may accept several tickets; a token may open several rooms. Kind 'collection' = any NFT from a
 *    1Sat collection (behind the flag, see NAMES-ROOMS-TICKETS-SERVER-SPEC.md).
 * Nothing here creates anything by itself: the guard asks before a second token or room is made.
 * Pure: the screens are in YouPage.tsx.
 */
import type { ChatRoom } from '../chat/messages';

export const ROOM_PART_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A room's written form: "studio" inside "richardwboase" → "studio.richardwboase". */
export const roomPath = (name: string, parent?: string | null): string => {
  const n = slugPart(name);
  const p = (parent || '').trim().toLowerCase().replace(/^\$/, '');
  return p ? `${n}.${p}` : n;
};

/** "My Studio!" → "my-studio": the part of a room name that can sit before a dot. */
export const slugPart = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');

/** "studio.richardwboase" → { name: "studio", parent: "richardwboase" }; one dot level at a time. */
export const parseRoomPath = (path: string): { name: string; parent: string | null } => {
  const t = path.trim().toLowerCase().replace(/^\$/, '');
  const i = t.indexOf('.');
  return i < 0 ? { name: t, parent: null } : { name: t.slice(0, i), parent: t.slice(i + 1) || null };
};

/** Why this sub-room name can't be used, or null. */
export const subRoomProblem = (name: string, parent: string | null, myRooms: readonly string[]): string | null => {
  const n = slugPart(name);
  if (!parent) return null;
  if (!ROOM_PART_RE.test(n)) return 'Use letters, numbers and dashes before the dot.';
  if (!myRooms.includes(parent.toLowerCase())) return 'You can only make rooms inside rooms you own.';
  return null;
};

// ── Tickets ──

export type TicketKind = 'token' | 'collection';
export type OnEntry = 'burn' | 'hold';

export interface Ticket {
  kind: TicketKind;
  /** token: BSV-21 id (txid_vout); collection: the 1Sat collection outpoint. */
  id: string;
  /** "$STUDIO", or a collection's name. */
  label: string;
  /** Whole tokens per entry (token kind); always 1 for a collection. */
  amount: number;
  onEntry: OnEntry;
  /** Is this token/collection mine (issued by this identity)? */
  mine: boolean;
}

export const TICKET_DEFAULTS = { amount: 1, onEntry: 'burn' as OnEntry };

export const newTicket = (t: Pick<Ticket, 'kind' | 'id' | 'label' | 'mine'> & Partial<Ticket>): Ticket => ({
  ...TICKET_DEFAULTS,
  ...t,
  amount: t.kind === 'collection' ? 1 : Math.max(1, Math.floor(t.amount ?? 1)),
});

const tLabel = (t: Ticket) => (t.kind === 'token' ? `${t.amount} ${t.label}` : `1 NFT from ${t.label}`);

/** The line under a ticket row. */
export const ticketNote = (t: Ticket): string =>
  `${t.mine ? 'Your' : "Someone else's"} ${t.kind === 'token' ? 'token' : 'collection'} · ${
    t.onEntry === 'burn' ? 'used up on entry' : 'shown at the door, kept'
  }`;

/** Add a ticket to a room's list (no duplicates; a room accepts several). */
export const addTicket = (list: readonly Ticket[], t: Ticket): Ticket[] =>
  list.some((x) => x.kind === t.kind && x.id === t.id) ? [...list] : [...list, t];

export const removeTicket = (list: readonly Ticket[], t: Pick<Ticket, 'kind' | 'id'>): Ticket[] =>
  list.filter((x) => !(x.kind === t.kind && x.id === t.id));

/** "On the door" summary. */
export const doorText = (room: string, tickets: readonly Ticket[], owner: string): string => {
  const o = owner ? ` · owner $${owner.replace(/^\$/, '')}` : '';
  if (!tickets.length) return `On the door: ${room} · free entry${o}`;
  return `On the door: ${room} · entry ${tickets.map(tLabel).join(' or ')}${o}`;
};

// ── Rooms I own ──

/** Rooms this account opened (any of its names), newest first. Lists from GET /api/bitsign/rooms. */
export const myRooms = (rooms: readonly ChatRoom[], myHandles: readonly string[]): ChatRoom[] => {
  const mine = new Set(myHandles.map((h) => h.replace(/^\$/, '').toLowerCase()).filter(Boolean));
  return rooms
    .filter((r) => !!r.created_by_handle && mine.has(r.created_by_handle.replace(/^\$/, '').toLowerCase()))
    .filter((r) => r.list_kind !== 'direct' && (r.metadata as { kind?: unknown } | null)?.kind !== 'direct')
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
};

// ── Guard: "You already have one" ──

export type GuardKind = 'token' | 'room';

export interface Existing {
  kind: GuardKind;
  /** "$RICHARDWBOASE" or "richardwboase". */
  label: string;
  holders?: number;
  /** For a token: the room(s) it opens. */
  opens?: string[];
}

/**
 * Before making a personal/ticket token or a room: if this identity already has one of that kind (found on
 * the server by its key, so another device's counts), ask first. null = go ahead, nothing to warn about.
 */
export const guardFor = (kind: GuardKind, existing: readonly Existing[]): Existing | null =>
  existing.find((e) => e.kind === kind) ?? null;

/** The guard sheet's copy, from the approved screen. */
export const guardCopy = (e: Existing): { title: string; body: string; keep: string; again: string } => {
  const people = e.holders ? `${e.holders} ${e.holders === 1 ? 'person holds' : 'people hold'} it` : 'It exists';
  if (e.kind === 'token') {
    const opens = e.opens?.length ? ` and it opens your ${e.opens.join(', ')} room` : '';
    return {
      title: `You already have a ${e.label} token`,
      body: `${people}${opens}. A second token would split your friends between two.`,
      keep: 'Use my existing token',
      again: 'Make a second one anyway',
    };
  }
  return {
    title: `You already have a ${e.label} room`,
    body: 'A second room with the same purpose would split your friends between two.',
    keep: 'Use my existing room',
    again: 'Make a second one anyway',
  };
};
