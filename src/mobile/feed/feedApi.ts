import { applyBapAip, BSOCIAL_BASKET, executeTrackedAction, LOCK_BASKET, type OneSatContext } from '@1sat/actions';
import { P1SAT_PROTOCOL } from '@1sat/types';
import { decodeLockTx, lockCandidates, lockOutputs, type PostLock } from './locks';
import { FEED_APP } from './sources';
import type { AuthorDeps } from './authorFeed';
import { FWETCH_API, parseFwetchFeed, parseFwetchItem, verifyFwetchTx } from './fwetch';
import {
  parseOverlayAny,
  parsePeckBody,
  parsePeckFeed,
  parseTreechatOverlayFeed,
  PECK_OVERLAY,
  PECK_READ_APPS,
  TREECHAT_OVERLAY_APP,
} from './peck';
import { fetchOpenFeed, isOpenFeedSource, OPEN_FEED_SOURCES } from './openFeed';
import { buildTreechatTree, treechatThreadIdFromRawTx } from './treechat';
import { cutoff, readCache, writeCache, type LeaderboardData, type Timeframe } from './leaderboard';
import { PublicKey, Transaction, Utils, type Script } from '@bsv/sdk';
import {
  ancestorChain,
  groupThread,
  isTxid,
  mergePosts,
  parseBmapFeed,
  parseBmapPost,
  parseLikes,
  parseTwetchFeed,
  parseTwetchPost,
  threadRoot,
  TWETCH_API,
  type FeedPost,
  type ParentRef,
} from './post';

/**
 * Feed read source: the bmap API (BitcoinSchema/bmap-api, the indexer behind 1satsocial /
 * bSocial). b.map.sv no longer resolves; the maintained deployment is on Railway. To move it,
 * add a vite define for __FEED_API__ (read defensively below, so none is required).
 */
declare const __FEED_API__: string | undefined;
export const FEED_API =
  (typeof __FEED_API__ === 'string' && __FEED_API__.trim()) || 'https://bmap-api-production.up.railway.app';

/**
 * bWalletX's own indexer (bitcoin-corp/bwalletx-indexer): bChat posts (MAP app=bChat and the
 * legacy ids) in the bmap response shape, since bmap stopped indexing in April 2026.
 */
declare const __BCHAT_FEED_API__: string | undefined;
export const BCHAT_FEED_API =
  (typeof __BCHAT_FEED_API__ === 'string' && __BCHAT_FEED_API__.trim()) || 'https://push.bwalletx.com/feed';

/** Recent bChat posts from bWalletX's own indexer. */
export async function fetchBchatRecent(page = 1, limit = 30): Promise<FeedPost[]> {
  const res = await fetch(`${BCHAT_FEED_API}/social/feed?page=${page}&limit=${limit}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`bChat feed error (${res.status})`);
  return parseBmapFeed(await res.json());
}

const get = async (path: string): Promise<unknown> => {
  const res = await fetch(`${FEED_API}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Feed server error (${res.status})`);
  return res.json();
};

/** "For you": the most recent posts network-wide. */
export const fetchRecent = async (page = 1, limit = 30): Promise<FeedPost[]> =>
  parseBmapFeed(await get(`/social/feed?page=${page}&limit=${limit}`));

export const fetchByBap = async (bapId: string, page = 1, limit = 30) =>
  parseBmapFeed(await get(`/social/post/bap/${encodeURIComponent(bapId)}?page=${page}&limit=${limit}`));

export const fetchByAddress = async (address: string, page = 1, limit = 30) =>
  parseBmapFeed(await get(`/social/post/address/${encodeURIComponent(address)}?page=${page}&limit=${limit}`));

export const fetchReplies = async (txid: string) => parseBmapFeed(await get(`/social/post/${txid}/reply?limit=100`));

export const fetchLikes = async (txid: string, mine: string[] = []) =>
  parseLikes(await get(`/social/post/${txid}/like`), mine);

/**
 * Recent public Twetch posts from Twetch's own read API (bmap stopped indexing Twetch around
 * block 843k). One plain GET per refresh, no auth, no spoofed headers: Twetch's terms allow
 * legitimate automation that does not burden the service.
 */
export const fetchTwetch = async (limit = 60): Promise<FeedPost[]> => {
  const res = await fetch(`${TWETCH_API}/v1/feed/latest?limit=${limit}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Twetch error (${res.status})`);
  return parseTwetchFeed(await res.json(), twetchAddress);
};

/** Recent Peck (peck.to) posts from its public overlay — current to the chain tip. */
export const fetchPeck = async (limit = 40, offset = 0): Promise<FeedPost[]> =>
  parsePeckFeed(await peckGet(`/v1/feed?app=${encodeURIComponent(PECK_READ_APPS[0])}&limit=${limit}&offset=${offset}`));

const peckGet = async (path: string): Promise<unknown> => {
  const res = await fetch(`${PECK_OVERLAY}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Peck error (${res.status})`);
  return parsePeckBody(await res.text());
};

/** One Peck or Treechat post by txid from the overlay (bmap stopped indexing in April 2026). */
export const fetchPeckPost = async (txid: string): Promise<FeedPost | null> =>
  !isTxid(txid) ? null : parseOverlayAny(((await peckGet(`/v1/post/${txid}`)) as { data?: unknown })?.data);

/**
 * Recent Treechat posts from the overlay (bmap, the old source, stopped at block ~944922), with
 * thread ids filled in for the app.treechat.com link.
 */
export const fetchTreechat = async (limit = 40, offset = 0): Promise<FeedPost[]> =>
  withTreechatThreadIds(
    parseTreechatOverlayFeed(await peckGet(`/v1/feed?app=${TREECHAT_OVERLAY_APP}&limit=${limit}&offset=${offset}`)),
  );

const treechatOverlayReplies = async (txid: string): Promise<FeedPost[]> =>
  !isTxid(txid)
    ? []
    : parseTreechatOverlayFeed({ data: ((await peckGet(`/v1/thread/${txid}`)) as { replies?: unknown })?.replies });

// Treechat thread ids (MAP treechat_thread_id): the overlay omits them, so read the raw tx
// (treechat.ts checks it hashes to the txid). A mined tx never changes; misses are retried.
const treechatThreadIds = new Map<string, string | null>();

async function fetchThreadIds(txids: string[]): Promise<void> {
  const todo = [...new Set(txids)].filter((t) => isTxid(t) && !treechatThreadIds.has(t)).slice(0, 60);
  if (!todo.length) return;
  if (treechatThreadIds.size > 20_000) treechatThreadIds.clear();
  const found = new Map<string, string>();
  for (let i = 0; i < todo.length; i += 20) {
    try {
      const res = await fetch(`${WOC}/txs/hex`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txids: todo.slice(i, i + 20) }),
        signal: AbortSignal.timeout(8_000),
      });
      const rows: unknown = res.ok ? await res.json() : [];
      for (const r of Array.isArray(rows) ? rows : []) {
        const { txid, hex } = (r ?? {}) as { txid?: unknown; hex?: unknown };
        if (typeof txid === 'string' && typeof hex === 'string') found.set(txid.toLowerCase(), hex);
      }
    } catch {
      /* singles below */
    }
  }
  // Unconfirmed txs are not in the bulk endpoint: a few, one at a time.
  await Promise.all(
    todo
      .filter((t) => !found.has(t))
      .slice(0, 6)
      .map(async (t) => {
        try {
          const res = await fetch(`${WOC}/tx/${t}/hex`, { signal: AbortSignal.timeout(6_000) });
          const hex = res.ok ? (await res.text()).trim() : '';
          if (hex) found.set(t, hex);
        } catch {
          /* next read */
        }
      }),
  );
  for (const [t, hex] of found) treechatThreadIds.set(t, treechatThreadIdFromRawTx(hex, t));
}

/** Fill `threadId` on Treechat posts that lack it. Best effort: a failure leaves it null. */
export async function withTreechatThreadIds(posts: FeedPost[]): Promise<FeedPost[]> {
  const need = posts.filter((p) => p.source === 'treechat' && !p.threadId).map((p) => p.txid);
  if (!need.length) return posts;
  await fetchThreadIds(need).catch(() => undefined);
  return posts.map((p) => {
    const id = p.source === 'treechat' && !p.threadId ? treechatThreadIds.get(p.txid) : null;
    return id ? { ...p, threadId: id } : p;
  });
}

// ── Fwetch (fwetch.lol): read from its API; tips only to signatures we verified ourselves ──
const fwetchVerified = new Map<string, string | null>();

const fwetchGet = async (path: string): Promise<unknown> => {
  const res = await fetch(`${FWETCH_API}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Fwetch error (${res.status})`);
  return res.json();
};

/** txid → author address, from the post's own pub/sig in its raw tx (never the API's signer_addr). */
async function fwetchVerify(items: unknown[]): Promise<Map<string, string>> {
  const ids = items
    .map((i) => (i && typeof i === 'object' ? (i as Record<string, unknown>) : {}))
    .filter((i) => Number(i.anon) !== 1 && !i.hidden && typeof i.txid === 'string' && isTxid(i.txid))
    .map((i) => (i.txid as string).toLowerCase());
  // Fwetch's rawtx endpoint 404s under parallel load: a few at a time, WhatsOnChain as fallback,
  // within a time budget. Trust is the same either way: the bytes must hash to the txid.
  const todo = [...new Set(ids)].filter((t) => !fwetchVerified.has(t));
  const one = async (txid: string) => {
    const hex = await fwetchRawTx(txid);
    if (hex === null) return; // unverified this time: shown, not payable
    if (fwetchVerified.size > 2_000) fwetchVerified.clear();
    fwetchVerified.set(txid, await verifyFwetchTx(hex, txid));
  };
  const deadline = Date.now() + 8_000;
  for (let i = 0; i < todo.length && Date.now() < deadline; i += 4) await Promise.all(todo.slice(i, i + 4).map(one));
  const out = new Map<string, string>();
  for (const t of ids) {
    const a = fwetchVerified.get(t);
    if (a) out.set(t, a);
  }
  return out;
}

async function fwetchRawTx(txid: string): Promise<string | null> {
  try {
    const r = (await fwetchGet(`/api/rawtx/${txid}`)) as { hex?: unknown };
    if (typeof r?.hex === 'string') return r.hex;
  } catch {
    /* fall back */
  }
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`, {
      signal: AbortSignal.timeout(8_000),
    });
    const hex = res.ok ? (await res.text()).trim() : '';
    return /^[0-9a-f]+$/i.test(hex) ? hex : null;
  } catch {
    return null;
  }
}

const listOf = (b: unknown, k: string): unknown[] => {
  const v = b && typeof b === 'object' ? (b as Record<string, unknown>)[k] : null;
  return Array.isArray(v) ? v : [];
};

/** Recent Fwetch posts (scope:'local' included; Fwetch-hidden posts dropped). */
export const fetchFwetch = async (limit = 40, offset = 0): Promise<FeedPost[]> => {
  const items = listOf(
    await fwetchGet(`/api/feed?app=fwetch&board=all&sort=new&limit=${limit}&offset=${offset}`),
    'posts',
  );
  return parseFwetchFeed({ posts: items }, await fwetchVerify(items));
};

async function fetchFwetchThread(txid: string): Promise<{ post: FeedPost | null; replies: FeedPost[] }> {
  const b = await fwetchGet(`/api/post/${txid}`);
  const post = (b as { post?: unknown })?.post;
  const replies = listOf(b, 'replies');
  const v = await fwetchVerify([post, ...replies]);
  return { post: parseFwetchItem(post, v), replies: parseFwetchFeed({ posts: replies }, v) };
}

/** One Fwetch post by txid. */
export const fetchFwetchPost = async (txid: string): Promise<FeedPost | null> =>
  !isTxid(txid) ? null : (await fetchFwetchThread(txid)).post;

function twetchAddress(pk: string): string {
  return PublicKey.fromString(pk).toAddress();
}

const twetchGet = async (path: string): Promise<unknown> => {
  const res = await fetch(`${TWETCH_API}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Twetch error (${res.status})`);
  return res.json();
};

/** One Twetch post by its numeric id (Twetch's detail API is not keyed by txid). Cached per session. */
const twetchPostCache = new Map<number, Promise<FeedPost | null>>();
export const fetchTwetchPost = (id: number): Promise<FeedPost | null> => {
  let p = twetchPostCache.get(id);
  if (!p) {
    p = twetchGet(`/v1/posts/${id}`).then((b) => parseTwetchPost(b, twetchAddress));
    p.catch(() => twetchPostCache.delete(id));
    twetchPostCache.set(id, p);
  }
  return p;
};

/** Direct replies to a Twetch post, oldest first. */
export const fetchTwetchReplies = async (id: number, limit = 50): Promise<FeedPost[]> =>
  parseTwetchFeed(await twetchGet(`/v1/posts/${id}/replies?limit=${limit}`), twetchAddress).sort((a, b) => a.at - b.at);

/** A Twetch user's own posts, newest first. */
export const fetchTwetchUserPosts = async (userId: string, limit = 20): Promise<FeedPost[]> =>
  parseTwetchFeed(await twetchGet(`/v1/users/${encodeURIComponent(userId)}/posts?limit=${limit}`), twetchAddress);

/** Live readers for an author's profile feed (authorFeed.ts). */
export const authorDeps: AuthorDeps = {
  getJson: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Couldn't load posts (${res.status})`);
    const text = await res.text();
    return url.startsWith(PECK_OVERLAY) ? parsePeckBody(text) : JSON.parse(text);
  },
  twetchAddressOf: twetchAddress,
  bchatApi: BCHAT_FEED_API,
  bmapApi: FEED_API,
  fwetchPage: (limit, offset) => fetchFwetch(limit, offset),
  treechatEnrich: (posts) => withTreechatThreadIds(posts),
  openFeed: (source) => fetchOpenFeed(source),
};

/** One on-chain post by txid from bmap, or null when unindexed. */
export const fetchBmapPost = async (txid: string): Promise<FeedPost | null> => {
  const b = await get(`/social/post/${txid}`);
  return parseBmapPost((b as { post?: unknown })?.post);
};

const fetchParent = (ref: ParentRef): Promise<FeedPost | null> =>
  ref.twetchId
    ? fetchTwetchPost(ref.twetchId)
    : ref.txid
      ? fetchBmapPost(ref.txid)
          .catch(() => null)
          .then((p) => p ?? (isTxid(ref.txid) ? fetchPeckPost(ref.txid!).catch(() => null) : null))
          .then((p) => p ?? (isTxid(ref.txid) ? fetchFwetchPost(ref.txid!).catch(() => null) : null))
      : Promise.resolve(null);

/**
 * The canonical chain above a post: what it replies to (or quotes / branches), up to the root,
 * root first. Twetch via its post-detail API, everything else via bmap's MAP context tx.
 */
export const fetchAncestors = (post: FeedPost): Promise<FeedPost[]> => ancestorChain(post, fetchParent);

/**
 * For you: network-wide recent posts plus bChat's own indexer and a slice of Twetch (deduped by
 * txid, newest first). Twetch or the bChat indexer failing never blanks the feed.
 */
export async function fetchForYou(): Promise<FeedPost[]> {
  const [recent, bchat, twetch, peck, fwetch, treechat, ...open] = await Promise.allSettled([
    fetchRecent(),
    fetchBchatRecent(),
    fetchTwetch(),
    fetchPeck(),
    fetchFwetch(),
    fetchTreechat(),
    // CoinGeek, Hodlocker, RelayX: only through bChatX's Open Feed (openFeed.ts).
    ...OPEN_FEED_SOURCES.map((s) => fetchOpenFeed(s)),
  ]);
  const extra = (r: PromiseSettledResult<FeedPost[]>) => (r.status === 'fulfilled' ? r.value : []);
  const tc = extra(treechat);
  const ob = open.flatMap(extra);
  if (recent.status === 'rejected') {
    if (bchat.status === 'fulfilled' && bchat.value.length)
      return mergePosts(bchat.value, extra(twetch), extra(peck), extra(fwetch), tc, ob);
    if (tc.length) return mergePosts(tc, extra(twetch), extra(peck), extra(fwetch), ob);
    throw recent.reason;
  }
  // bmap's Treechat posts are months old (it stopped at block ~944922): the overlay replaces
  // them while it answers.
  const bmap = tc.length ? recent.value.filter((p) => p.source !== 'treechat') : recent.value;
  return mergePosts(bmap, extra(bchat), extra(twetch), extra(peck), extra(fwetch), tc, ob);
}

/**
 * A whole thread. Treechat: the conversation tree from the overlay (treechat.ts — parent_txid
 * chains walked up to the root and down through /v1/thread), with bmap's old threads (every
 * reply pointed MAP tx at the root, plus a text search for the thread id) merged in; oldest
 * first. Others: the post's direct replies. Each source is optional; whatever loads is shown.
 */
export async function fetchThread(post: FeedPost): Promise<FeedPost[]> {
  if (post.source === 'twetch' && post.twetchId) return [post, ...(await fetchTwetchReplies(post.twetchId))];
  // CoinGeek articles are not on chain: no replies to read.
  if (isOpenFeedSource(post.source) && !isTxid(post.txid)) return [post];
  if (post.source === 'treechat' && isTxid(post.txid)) {
    const tree = await buildTreechatTree(post, {
      post: async (t) => (await fetchPeckPost(t).catch(() => null)) ?? fetchBmapPost(t).catch(() => null),
      replies: treechatOverlayReplies,
      extra: async (t) => {
        const jobs: Promise<FeedPost[]>[] = [fetchReplies(t)];
        if (post.threadId && t === post.txid)
          jobs.push(get(`/social/post/search?q=${encodeURIComponent(post.threadId)}&limit=100`).then(parseBmapFeed));
        const got = await Promise.allSettled(jobs);
        const all = got.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
        return post.threadId && t === post.txid ? groupThread(post, all) : all;
      },
    });
    return (await withTreechatThreadIds(tree.posts)).sort((a, b) => a.at - b.at);
  }
  if (post.source === 'peck' && isTxid(post.txid)) {
    const replies = await peckGet(`/v1/thread/${post.txid}`)
      .then((b) => parsePeckFeed({ data: (b as { replies?: unknown })?.replies }))
      .catch(() => [] as FeedPost[]);
    return [post, ...replies.sort((a, b) => a.at - b.at)];
  }
  if (post.source === 'fwetch' && isTxid(post.txid)) {
    const { replies } = await fetchFwetchThread(post.txid).catch(() => ({ replies: [] as FeedPost[] }));
    return [post, ...replies.sort((a, b) => a.at - b.at)];
  }
  const root = threadRoot(post);
  const jobs: Promise<FeedPost[]>[] = [fetchReplies(root)];
  if (root !== post.txid)
    jobs.push(
      get(`/social/post/${root}`).then((b) => {
        const p = parseBmapPost((b as { post?: unknown })?.post);
        return p ? [p] : [];
      }),
    );
  if (post.threadId)
    jobs.push(get(`/social/post/search?q=${encodeURIComponent(post.threadId)}&limit=100`).then(parseBmapFeed));
  const got = await Promise.allSettled(jobs);
  return groupThread(
    post,
    got.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
  );
}

/** Posts by a set of authors (bapId when known, else address), merged newest-first. */
export async function fetchFollowing(follows: { bapId: string | null; address: string }[]): Promise<FeedPost[]> {
  const lists = await Promise.allSettled(
    follows.slice(0, 40).map((f) => (f.bapId ? fetchByBap(f.bapId, 1, 20) : fetchByAddress(f.address, 1, 20))),
  );
  const seen = new Set<string>();
  return lists
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((p) => !seen.has(p.txid) && !!seen.add(p.txid))
    .sort((a, b) => b.at - a.at);
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * Sign `script` with the account's BAP identity key (AIP), then create + broadcast a 0-sat
 * OP_RETURN output through the wallet (normal approval rules apply). Hands the raw tx to the
 * indexer so the post shows up without waiting for a block.
 */
/** The wallet has no posting identity yet (no published BAP ID to sign with). */
export class NoPostingIdentityError extends Error {
  constructor() {
    super('Set up your posting profile first.');
    this.name = 'NoPostingIdentityError';
  }
}

export const isNoIdentityError = (e: unknown) => /No BAP identity/i.test(e instanceof Error ? e.message : String(e));

/**
 * Who sets up a missing posting identity inline. The feed screen registers one that shows the
 * one-tap setup sheet and resolves true once it is published (false when the person cancels).
 */
let identitySetup: (() => Promise<boolean>) | null = null;
export const setIdentitySetupHandler = (fn: (() => Promise<boolean>) | null) => {
  identitySetup = fn;
};

/** Sign with the identity key; with none yet, ask the registered handler to set one up, then sign. */
export async function signWithIdentity(
  sign: () => Promise<Script>,
  setup: (() => Promise<boolean>) | null = identitySetup,
): Promise<Script | null> {
  try {
    return await sign();
  } catch (e) {
    if (!isNoIdentityError(e)) throw e;
    if (!setup) throw new NoPostingIdentityError();
    if (!(await setup())) return null;
    return sign();
  }
}

/** Thrown by publish() when the person declined to set up their identity: nothing was posted. */
export class PostCancelledError extends Error {
  constructor() {
    super('Not posted.');
    this.name = 'PostCancelledError';
  }
}

export async function publish(
  ctx: OneSatContext,
  script: Script,
  description: string,
  tags: string[],
  /**
   * A tip / paid like's payment to the post's author (tip.ts planPayment): the output right after
   * the OP_RETURN, in the same transaction (BCHAT-PROTOCOL-v2 §5).
   */
  payment?: {
    address: string;
    satoshis: number;
    lockingScript: Script;
    /** Optional client fee (spec §6.1): its own output right after the author's. */
    fee?: { address: string; satoshis: number; lockingScript: Script };
    /** Optional home app share (spec §6.2): its own output after the fee (if any). */
    home?: { address: string; satoshis: number; lockingScript: Script; app?: string };
  },
  /** Wallet action labels (local only), e.g. 'bchat reveal'. */
  labels?: string[],
): Promise<string> {
  const signed = await signWithIdentity(() => applyBapAip(ctx, script));
  if (!signed) throw new PostCancelledError();
  const res = await executeTrackedAction(ctx.wallet, {
    description,
    ...(labels?.length && { labels }),
    outputs: [
      { lockingScript: signed.toHex(), satoshis: 0, outputDescription: description, basket: BSOCIAL_BASKET, tags },
      ...(payment
        ? [
            {
              lockingScript: payment.lockingScript.toHex(),
              satoshis: payment.satoshis,
              // ≤ 50 bytes (BRC-100); shown on the spending approval.
              outputDescription: `Pay author ${payment.address}`,
            },
          ]
        : []),
      ...(payment?.fee
        ? [
            {
              lockingScript: payment.fee.lockingScript.toHex(),
              satoshis: payment.fee.satoshis,
              outputDescription: `App fee ${payment.fee.address}`,
            },
          ]
        : []),
      ...(payment?.home
        ? [
            {
              lockingScript: payment.home.lockingScript.toHex(),
              satoshis: payment.home.satoshis,
              // ≤ 50 bytes (BRC-100); shown on the spending approval.
              outputDescription: `Home app ${payment.home.address}`,
            },
          ]
        : []),
    ],
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  });
  if (!res.txid) throw new Error('The wallet did not return a transaction id.');
  if (res.tx) void ingest(res.tx);
  return res.txid;
}

async function ingest(tx: number[]) {
  try {
    let rawTx: string;
    try {
      rawTx = Transaction.fromAtomicBEEF(tx).toHex();
    } catch {
      rawTx = Utils.toHex(tx);
    }
    const body = JSON.stringify({ rawTx });
    await Promise.allSettled(
      [FEED_API, BCHAT_FEED_API].map((base) =>
        fetch(`${base}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        }),
      ),
    );
  } catch {
    // best effort: the indexer also picks it up from the chain
  }
}

// ── social locks ─────────────────────────────────────────────────────────────

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
/** Lock txs are immutable: cache decoded results (null = not a lock) for the session. */
const lockTxCache = new Map<string, Promise<PostLock | null>>();

const fetchLockTx = (lockTxid: string, postTxid: string) => {
  let p = lockTxCache.get(lockTxid);
  if (!p) {
    p = fetch(`${WOC}/tx/${lockTxid}/hex`, { signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`tx ${r.status}`))))
      .then((hex) => decodeLockTx(hex.trim(), postTxid));
    p.catch(() => lockTxCache.delete(lockTxid));
    lockTxCache.set(lockTxid, p);
  }
  return p;
};

/**
 * Locks backing a post. No live indexer serves Hodlocker-style lock totals any more (hodlocker.com
 * and its LooLock API are gone), so: bmap's like index for the post (lock-likes are MAP likes),
 * keep those with a non-address output, and decode each tx's lock output (WhatsOnChain raw tx).
 */
export async function fetchPostLocks(postTxid: string): Promise<PostLock[]> {
  const ids = lockCandidates(await get(`/social/post/${postTxid}/like?limit=100`));
  const got = await Promise.allSettled(ids.slice(0, 40).map((id) => fetchLockTx(id, postTxid)));
  return got.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}

/**
 * Lock `satoshis` until block `until` against `postTxid`: the same lock output, basket, tags and
 * key as @1sat/actions lockBsv (so the Wallet's Locks row lists it and unlockBsv spends it), plus a
 * MAP like for the post, AIP-signed when the account has a BAP identity.
 */
export async function lockToPost(
  ctx: OneSatContext,
  o: { postTxid: string; satoshis: number; until: number },
): Promise<PostLock> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID: 'lock',
    counterparty: 'self',
    forSelf: true,
  });
  const address = PublicKey.fromString(publicKey).toAddress();
  const { lock, map, until } = lockOutputs({ ...o, address, app: FEED_APP });
  let mapScript = map;
  try {
    mapScript = await applyBapAip(ctx, map);
  } catch {
    // no BAP identity: an unsigned MAP like still counts for lock indexers
  }
  const res = await executeTrackedAction(
    ctx.wallet,
    {
      description: 'Lock BSV to a post',
      outputs: [
        {
          lockingScript: lock.toHex(),
          satoshis: o.satoshis,
          outputDescription: `Lock ${o.satoshis} sats until block ${until}`,
          basket: LOCK_BASKET,
          tags: [`until:${until}`],
          customInstructions: JSON.stringify({ protocolID: P1SAT_PROTOCOL, keyID: 'lock' }),
        },
        {
          lockingScript: mapScript.toHex(),
          satoshis: 0,
          outputDescription: 'Feed lock',
          basket: BSOCIAL_BASKET,
          tags: [`app:${FEED_APP}`, 'type:lock', `tx:${o.postTxid}`],
        },
      ],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
    },
    undefined,
    undefined,
    undefined,
    { spends: [], permissionScheme: 'lock' },
  );
  if (!res.txid) throw new Error('The wallet did not return a transaction id.');
  if (res.tx) void ingest(res.tx);
  return { lockTxid: res.txid, postTxid: o.postTxid, satoshis: o.satoshis, until, address };
}

// ── most-locked leaderboard ──────────────────────────────────────────────────

/** Request caps: at most this many feed pages and this many posts' lock lookups per refresh. */
export const LEADERBOARD_PAGES = 4;
export const LEADERBOARD_PAGE_SIZE = 50;
export const LEADERBOARD_MAX_POSTS = 120;

/**
 * Posts + their locks for a leaderboard timeframe. bmap's recent feed is paged back until a page
 * reaches past the timeframe's start (or the page cap), then each in-window post's locks are read
 * (3 at a time; lock txs are cached). Results cached in memory + localStorage for 10 minutes.
 */
export async function fetchLeaderboard(tf: Timeframe, force = false): Promise<LeaderboardData> {
  if (!force) {
    const hit = readCache(tf);
    if (hit) return hit;
  }
  const since = cutoff(tf);
  const posts: FeedPost[] = [];
  let complete = false;
  for (let page = 1; page <= LEADERBOARD_PAGES; page++) {
    const got = await fetchRecent(page, LEADERBOARD_PAGE_SIZE);
    posts.push(...got);
    if (got.length < LEADERBOARD_PAGE_SIZE) complete = true;
    if (since > 0 && got.some((p) => p.at && p.at < since)) complete = true;
    if (complete) break;
  }
  const oldest = posts.reduce((m, p) => (p.at && p.at < m ? p.at : m), Date.now());
  const todo = [...new Set(posts.filter((p) => p.at >= since).map((p) => p.txid))].slice(0, LEADERBOARD_MAX_POSTS);
  const locks: Record<string, PostLock[]> = {};
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const txid = todo[i++];
      try {
        const ls = await fetchPostLocks(txid);
        if (ls.length) locks[txid] = ls;
      } catch {
        // one post failing never blanks the board
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const data: LeaderboardData = { posts, locks, oldest, complete, at: Date.now() };
  writeCache(tf, data);
  return data;
}
