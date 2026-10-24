/**
 * Unpairing must also close what the pairing still has on screen (b-Aware report, 23 Oct 2026). Dropping a paired
 * session revokes its grants, but a permission sheet that was already open could still be approved afterwards and
 * would write a fresh grant under the same "<host>.paired.invalid" key, which a later re-pair of that host inherits.
 *
 * Two guards, both used by background.ts:
 * - takePendingFor: when an originator's grants are revoked, its open prompts are taken out and denied.
 * - pairedGrantAllowed: at approve time a paired originator is granted only while a current session for it exists.
 */
import { normalizeOriginator } from '@1sat/wallet';
import { isPairedHost, pairedOrigin } from './originKey';

/** Same storage key and lapse rules as src/mobile/pair/sessions.ts (kept dependency-free for the background). */
export const PAIR_SESSIONS_KEY = 'bwallet.pair.sessions';
const IDLE_MS = 24 * 60 * 60 * 1000;

type StoredLike = { c?: unknown; origin?: unknown; lastUsed?: unknown; agent?: { expiresAt?: unknown } };

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
 * stored, current session whose paired key matches; no session storage (e.g. an extension service worker) means no.
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
