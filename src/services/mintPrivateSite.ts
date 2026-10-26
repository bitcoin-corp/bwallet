/**
 * `wallet.mintPrivate(...)` from an outside site (bChatX "Lock my X posts"), spec docs/ARCHIVE-PAGE-PLAN.md and
 * bit-sign PRIVATE-RECORDS.md §10. A non-standard extension method next to the BRC-100 ones: it travels like a CWI
 * call (page → content script / in-app bridge / bApp frame / pairing → background) and the originator is always the
 * one the browser (or native WebView) reports, never one the page claims.
 *
 * The core (mobile/private/privateMint.ts handleMintPrivate) validates, dedupes by requestId and mints. This module
 * adds what a site call needs around it:
 * - the one approval sheet (`ask`), which only the wallet's own UI can answer;
 * - sequence approval: a site sending a long run in chunks (one call per ~1,000 posts) shows ONE sheet for the whole
 *   run. Allow stores an approval (originator + identity key + sequence id) with a budget of totalSats × 1.10, the
 *   chunk count, the indexes used, and a 2-hour expiry. A later chunk runs without a sheet only while all of that
 *   holds; anything else shows a fresh sheet, never a silent overrun. A decline clears the approval.
 * - `{ code, message }` errors the site can read.
 */
import type { OneSatContext } from '@1sat/actions';
import {
  handleMintPrivate,
  MAX_REQUEST_ITEMS,
  MintPrivateError,
  type MintPrivateResult,
  type RequestStore,
} from '../mobile/private/privateMint';

export { MINT_PRIVATE_ACTION, isMintPrivateAction, MINT_PRIVATE_CAPS, MINT_PRIVATE_CODES } from './mintPrivateAction';

/** chrome.storage.local keys (background only). */
export const MINT_REQUESTS_PREFIX = 'bwxMintPrivateReq.';
export const MINT_SEQUENCES_KEY = 'bwxMintPrivateSeq';
export const SEQUENCE_TTL_MS = 2 * 60 * 60_000;
/** Budget headroom over the site's totalSats: the cap, never more. */
export const SEQUENCE_HEADROOM = 1.1;
const MAX_CHUNKS = 1000;
const MAX_SATS = 21e14;

export type Sequence = {
  id: string;
  index: number;
  total: number;
  totalSats: number;
  totalTxs: number;
  totalPosts?: number;
};

export type SequenceApproval = {
  originator: string;
  identityKey: string;
  id: string;
  total: number;
  remainingSats: number;
  used: number[];
  expiresAt: number;
};
export type SequenceState = Record<string, SequenceApproval>;

/** What the one sheet shows. `sequence` is the whole run (first chunk, or a fresh sheet after a lapse). */
export type MintPrivateSheet = {
  originator: string;
  posts: number;
  sats: number;
  txs: number;
  sequence?: { chunks: number; index: number; totalPosts?: number; totalSats: number; totalTxs: number };
};

const posInt = (n: unknown, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;

/** undefined = no sequence; throws BAD_REQUEST on a malformed one. */
export function parseSequence(raw: unknown): Sequence | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  const ok =
    typeof s === 'object' &&
    typeof s.id === 'string' &&
    /^[\w-]{8,100}$/.test(s.id) &&
    posInt(s.total, MAX_CHUNKS) &&
    typeof s.index === 'number' &&
    Number.isInteger(s.index) &&
    s.index >= 0 &&
    s.index < (s.total as number) &&
    posInt(s.totalSats, MAX_SATS) &&
    posInt(s.totalTxs, 1_000_000) &&
    (s.totalPosts === undefined || posInt(s.totalPosts, MAX_CHUNKS * MAX_REQUEST_ITEMS));
  if (!ok) throw new MintPrivateError('BAD_REQUEST', 'sequence needs id, index, total, totalSats and totalTxs.');
  return {
    id: s.id as string,
    index: s.index as number,
    total: s.total as number,
    totalSats: s.totalSats as number,
    totalTxs: s.totalTxs as number,
    ...(s.totalPosts !== undefined && { totalPosts: s.totalPosts as number }),
  };
}

export const sequenceKey = (originator: string, identityKey: string, id: string) =>
  `${originator}|${identityKey}|${id}`;

/** True only when this chunk may run without a sheet. */
export function sequenceCovers(
  a: SequenceApproval | undefined,
  q: { originator: string; identityKey: string; seq: Sequence; sats: number; now: number },
): boolean {
  if (!a) return false;
  return (
    a.originator === q.originator &&
    a.identityKey === q.identityKey &&
    a.id === q.seq.id &&
    q.now < a.expiresAt &&
    q.seq.total === a.total &&
    !a.used.includes(q.seq.index) &&
    a.used.length < a.total &&
    q.sats <= a.remainingSats
  );
}

/** The approval an Allow on the whole-run sheet stores, with this first chunk already spent. */
export function approveSequence(q: {
  originator: string;
  identityKey: string;
  seq: Sequence;
  sats: number;
  now: number;
}): SequenceApproval {
  return {
    originator: q.originator,
    identityKey: q.identityKey,
    id: q.seq.id,
    total: q.seq.total,
    remainingSats: Math.max(0, Math.floor(q.seq.totalSats * SEQUENCE_HEADROOM) - q.sats),
    used: [q.seq.index],
    expiresAt: q.now + SEQUENCE_TTL_MS,
  };
}

export const spendSequence = (a: SequenceApproval, index: number, sats: number): SequenceApproval => ({
  ...a,
  remainingSats: a.remainingSats - sats,
  used: [...a.used, index],
});

/** Drops expired approvals (kept small in storage). */
export const pruneSequences = (s: SequenceState, now: number): SequenceState =>
  Object.fromEntries(Object.entries(s).filter(([, a]) => a.expiresAt > now));

/** Async key-value (chrome.storage.local in the background; a Map in tests). */
export type Kv = { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> };

/**
 * The core's RequestStore is synchronous; chrome.storage is not. Preload the one key this request uses, then write
 * through. `flush` waits for every write.
 */
export async function kvRequestStore(
  kv: Kv,
  key: string,
): Promise<{ store: RequestStore; flush: () => Promise<void> }> {
  const cache = new Map<string, unknown>();
  const prior = await kv.get(MINT_REQUESTS_PREFIX + key).catch(() => undefined);
  if (prior) cache.set(key, prior);
  let writes: Promise<unknown> = Promise.resolve();
  return {
    store: {
      get: (k) => (cache.get(k) as ReturnType<RequestStore['get']>) ?? null,
      set: (k, v) => {
        cache.set(k, v);
        const copy = JSON.parse(JSON.stringify(v));
        writes = writes.then(() => kv.set(MINT_REQUESTS_PREFIX + k, copy)).catch(() => undefined);
      },
    },
    flush: () => writes.then(() => undefined),
  };
}

export type SiteReply = { success: true; data: MintPrivateResult } | { success: false; error: string; code: string };

/** One mint at a time per wallet, so two chunks of a sequence never both pass the budget check. */
let queue: Promise<unknown> = Promise.resolve();

export function runSiteMintPrivate(deps: {
  ctx: OneSatContext;
  originator: string;
  identityKey: string;
  satsPerKb: number;
  params: unknown;
  kv: Kv;
  /** Shows the wallet's own sheet; resolves true only on the user's Allow. */
  ask: (sheet: MintPrivateSheet) => Promise<boolean>;
  now?: () => number;
  mint?: typeof handleMintPrivate;
}): Promise<SiteReply> {
  const run = queue.then(() => runOne(deps));
  queue = run.catch(() => undefined);
  return run;
}

async function runOne(deps: Parameters<typeof runSiteMintPrivate>[0]): Promise<SiteReply> {
  const now = deps.now ?? Date.now;
  const mint = deps.mint ?? handleMintPrivate;
  const { originator, identityKey, kv } = deps;
  try {
    const req = (deps.params ?? {}) as { source?: unknown; requestId?: unknown; items?: unknown; sequence?: unknown };
    if (typeof req !== 'object') throw new MintPrivateError('BAD_REQUEST', 'Bad request.');
    if (!identityKey) throw new MintPrivateError('BAD_REQUEST', 'Unlock bWalletX first.');
    const seq = parseSequence(req.sequence);
    const reqKey = `${originator}|${identityKey}|${String(req.requestId)}`;
    const { store, flush } = await kvRequestStore(kv, reqKey);
    const readSeqs = async () => pruneSequences(((await kv.get(MINT_SEQUENCES_KEY)) as SequenceState) ?? {}, now());
    const writeSeq = async (key: string, a: SequenceApproval | undefined) => {
      const all = await readSeqs();
      if (a) all[key] = a;
      else delete all[key];
      await kv.set(MINT_SEQUENCES_KEY, all);
    };

    const confirm = async (s: { posts: number; sats: number; txs: number; originator: string }) => {
      if (!seq) return deps.ask({ originator, posts: s.posts, sats: s.sats, txs: s.txs });
      const key = sequenceKey(originator, identityKey, seq.id);
      const q = { originator, identityKey, seq, sats: s.sats, now: now() };
      const prior = (await readSeqs())[key];
      if (sequenceCovers(prior, q)) {
        await writeSeq(key, spendSequence(prior!, seq.index, s.sats));
        return true;
      }
      const ok = await deps.ask({
        originator,
        posts: s.posts,
        sats: s.sats,
        txs: s.txs,
        sequence: {
          chunks: seq.total,
          index: seq.index,
          ...(seq.totalPosts !== undefined && { totalPosts: seq.totalPosts }),
          totalSats: Math.max(seq.totalSats, s.sats),
          totalTxs: Math.max(seq.totalTxs, s.txs),
        },
      });
      await writeSeq(key, ok ? approveSequence({ ...q, now: now() }) : undefined);
      return ok;
    };

    const data = await mint(deps.ctx, req, {
      originator,
      identityKey,
      satsPerKb: deps.satsPerKb,
      confirm,
      store,
    });
    await flush();
    return { success: true, data };
  } catch (e) {
    if (e instanceof MintPrivateError) return { success: false, error: e.message, code: e.code };
    return { success: false, error: e instanceof Error ? e.message : String(e), code: 'ERROR' };
  }
}
