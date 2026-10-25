/**
 * Unpairing must also close what the pairing still has on screen (b-Aware report, 23 Oct 2026). Dropping a paired
 * session revokes its grants, but a permission sheet that was already open could still be approved afterwards and
 * would write a fresh grant under the same "<host>.paired.invalid" key, which a later re-pair of that host inherits.
 *
 * Two guards, both used by background.ts:
 * - takePendingFor: when an originator's grants are revoked, its open prompts are taken out and denied.
 * - pairedGrantAllowed: at approve time a paired originator is granted only while a current session for it exists.
 *
 * Where the sessions are read (owner's phone, 25 Oct 2026): the sessions live in the page's localStorage, but on the
 * phone the background runs in a Web Worker, which has no localStorage. The guard read "no sessions" there and turned
 * every Allow for a paired site into a denial ("Permission denied." on the site). The page now mirrors the fields the
 * guard needs (channel, origin, lastUsed, agent expiry; never a key) into chrome.storage.local under
 * PAIR_MIRROR_KEY, and the background keeps that copy here (setPairMirror). The rules are unchanged: a grant still
 * needs a current session whose own per-channel key matches, so a forged second pairing gets nothing.
 */
import { normalizeOriginator } from '@1sat/wallet';
import { isPairedHost, pairedOrigin } from './originKey';

/** Same storage key and lapse rules as src/mobile/pair/sessions.ts (kept dependency-free for the background). */
export const PAIR_SESSIONS_KEY = 'bwallet.pair.sessions';
const IDLE_MS = 24 * 60 * 60 * 1000;

/** chrome.storage.local key of the page's session mirror (written by src/mobile/pair/sessions.ts). */
export const PAIR_MIRROR_KEY = 'bwallet.pair.mirror';

type StoredLike = { c?: unknown; origin?: unknown; lastUsed?: unknown; agent?: { expiresAt?: unknown } };
export type PairMirrorEntry = { c: string; origin: string; lastUsed: number; agent?: { expiresAt: number } };

/** Only what the guard needs; the pairing key and the relay claim stay in the page. */
export const toPairMirror = (sessions: StoredLike[]): PairMirrorEntry[] =>
  sessions.flatMap((s) =>
    typeof s.c === 'string' && typeof s.origin === 'string' && typeof s.lastUsed === 'number'
      ? [
          {
            c: s.c,
            origin: s.origin,
            lastUsed: s.lastUsed,
            ...(s.agent && typeof s.agent.expiresAt === 'number' && { agent: { expiresAt: s.agent.expiresAt } }),
          },
        ]
      : [],
  );

/** The background's copy of the mirror; null until chrome.storage.local has been read. */
let mirror: StoredLike[] | null = null;
/** background.ts: the mirror as read from chrome.storage.local (on start and on every change). */
export const setPairMirror = (v: unknown) => {
  mirror = Array.isArray(v) ? toPairMirror(v as StoredLike[]) : [];
};

const norm = (o: string): string => {
  try {
    return normalizeOriginator(o);
  } catch {
    return o;
  }
};

const hostOf = (originator: string): string => {
  try {
    return new URL(originator.includes('://') ? originator : `https://${originator}`).hostname;
  } catch {
    return originator;
  }
};

/** Whether an originator is a phone-paired permission key ("<host>.paired.invalid"). */
export const isPairedOriginator = (originator: string | undefined): boolean =>
  !!originator && isPairedHost(hostOf(originator));

const readSessions = (): StoredLike[] => {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    // No localStorage (the phone's background worker, an extension service worker): the page's mirror.
    if (!ls?.getItem) return mirror ?? [];
    const raw = JSON.parse(ls?.getItem(PAIR_SESSIONS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? (raw as StoredLike[]) : [];
  } catch {
    return [];
  }
};

const isCurrent = (s: StoredLike, now: number): boolean => {
  if (s.agent) return typeof s.agent.expiresAt === 'number' && now < s.agent.expiresAt;
  return typeof s.lastUsed === 'number' && now - s.lastUsed < IDLE_MS;
};

/**
 * A grant may be written for `originator` now. Non-paired originators are not affected. A paired originator needs a
 * stored, current session whose paired key matches. Without localStorage the page's mirror is used; no mirror means no.
 */
export const pairedGrantAllowed = (
  originator: string | undefined,
  sessions: StoredLike[] = readSessions(),
  now = Date.now(),
): boolean => {
  if (!isPairedOriginator(originator)) return true;
  const want = norm(originator as string);
  return sessions.some((s) => {
    if (typeof s.origin !== 'string' || typeof s.c !== 'string' || !isCurrent(s, now)) return false;
    try {
      // The session's own channel: another pairing claiming the same host has a different key (originKey.ts).
      return norm(pairedOrigin(s.origin, s.c)) === want;
    } catch {
      return false;
    }
  });
};

/** Remove and return every pending entry whose request came from `originator` (compared normalized). */
export const takePendingFor = <T extends { request: { originator?: string } }>(
  map: Map<string, T>,
  originator: string,
): [string, T][] => {
  const want = norm(originator);
  const taken: [string, T][] = [];
  for (const [id, entry] of map) {
    const o = entry.request.originator;
    if (o && norm(o) === want) taken.push([id, entry]);
  }
  for (const [id] of taken) map.delete(id);
  return taken;
};
