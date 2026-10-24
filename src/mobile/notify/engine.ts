/**
 * Notification poller. Runs while the app is open (foreground) and once more on every resume;
 * each source is optional and fails on its own. The first run of a source only records a baseline
 * (no history flood). New events go to the in-app list (bell) and, when the category is on and
 * the OS permission was granted, to a local notification.
 *
 * Sources: bmap (replies / quotes / likes / locks on your on-chain posts, mentions), Twetch
 * (replies + likes on your Twetch posts when your Twetch user id is known, @mentions in the
 * latest feed), bChat (room unread counts, @handle mentions, missed calls via the calls store),
 * 1Sat indexer (new outputs at your addresses = payments / tokens; your listings spent by
 * someone else = sales).
 *
 * iOS / Android suspend the WebView in the background, so this cannot fire while the app is
 * closed: that needs server push (see docs/NOTIFICATIONS.md).
 */
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { OneSatContext } from '@1sat/actions';
import {
  FEED_API,
  fetchByAddress,
  fetchForYou,
  fetchByBap,
  fetchReplies,
  fetchTwetchReplies,
  fetchTwetchUserPosts,
} from '../feed/feedApi';
import { lockCandidates } from '../feed/locks';
import { parseBmapFeed, parseTwetchFeed, TWETCH_API, type FeedPost } from '../feed/post';
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { isRoomMuted } from '../chat/listPrefs';
import { liveHub } from '../chat/live';
import { feedRowWantsPoll, roomFeed } from '../chat/roomFeed';
import { subscribe as subscribeCalls } from '../calls/store';
import { App } from '@capacitor/app';
import { ONESAT, search, type SearchRow } from '../market/indexer';
import { rememberedTicketIds } from '../wallet/walletTickets';
import { loadPrefs } from '../settings/prefs';
import type { WalletInterface } from '@bsv/sdk';
import { myKey, openMail, peekMail } from '../bmail/client';
import { route } from '../bmail/route';
import { loadMail, openBMail, savePending } from '../bmail/store';
import { fetchPeerBPhone } from '../calls/bphone';
import { getFriends, isFriend as isCallFriend } from '../calls/friends';
import { shortKey } from '../calls/machine';
import { moneyNow, usdToSats } from '../money/money';
import { cachedExchangeRate } from '../../utils/wallet';
import {
  allowed,
  countIncreases,
  describeIncoming,
  diffSeen,
  excerpt,
  formatSatsShort,
  isMe,
  mentionsMe,
  nativeId,
  osNoticeBody,
  type IncomingRow,
  type MeKeys,
  type NotifyItem,
} from './notify';
import { clearChatBadges, setChatRooms, setFeedLatest } from '../tabs/tabBadges';
import { loadPollState, pushItems, savePollState, setAsked, wasAsked, type PollState } from './store';
import { IS_TAURI } from '../desktop/ipc';
import { localPreviews } from '../push/logic';

export type Me = MeKeys & {
  /** Names to match mentions on (paymail, $handle, OpNS name, profile name). */
  names: string[];
  ctx: OneSatContext | null;
};

export const POLL_MS = 90_000;
const MY_POSTS = 8;

let me: Me | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let unsubCalls: (() => void) | null = null;
let unsubLive: (() => void) | null = null;
let unsubFeed: (() => void) | null = null;
/** room id → ticker, from the last bChat room list (the feed's rows carry only room_id). */
let roomTickers = new Map<string, string>();

let resumeSub: { remove: () => Promise<void> } | null = null;
let tapSub: { remove: () => Promise<void> } | null = null;

const now = () => Date.now();
/** Longer text for the Desktop Notifications page (wraps to 2 lines there); the phone list and OS notices keep body. */
const FULL = 280;
const item = (p: Omit<NotifyItem, 'read' | 'at'> & { at?: number }): NotifyItem => ({ read: false, at: now(), ...p });
const postTarget = (p: FeedPost) => ({ type: 'post' as const, txid: p.txid, twetchId: p.twetchId });

const getJson = async (url: string): Promise<unknown> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

/** Runs `fn` for a named source with its slice of the poll state; seeds silently on the first run. */
async function source(
  st: PollState,
  key: string,
  fn: (seen: (ids: string[]) => string[], counts: Record<string, number>) => Promise<Record<string, number> | void>,
) {
  const seeded = !!st.seeded[key];
  const seen = (ids: string[]) => {
    const d = diffSeen(st.seen[key] ?? [], ids, seeded);
    st.seen[key] = d.seen;
    return d.fresh;
  };
  const prev = st.counts[key] ?? {};
  const next = await fn(seen, seeded ? prev : {});
  if (next) st.counts[key] = { ...prev, ...next };
  st.seeded[key] = true;
}

// ── sources ──────────────────────────────────────────────────────────────────

async function myBmapPosts(m: Me): Promise<FeedPost[]> {
  const lists = await Promise.allSettled([
    m.bapId ? fetchByBap(m.bapId, 1, MY_POSTS) : Promise.resolve([]),
    ...m.addresses.slice(0, 1).map((a) => fetchByAddress(a, 1, MY_POSTS)),
  ]);
  const seen = new Set<string>();
  return lists
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((p) => !seen.has(p.txid) && !!seen.add(p.txid))
    .sort((a, b) => b.at - a.at)
    .slice(0, MY_POSTS);
}

async function bmapSocial(m: Me, st: PollState, out: NotifyItem[]) {
  const posts = await myBmapPosts(m);
  await source(st, 'bmap.replies', async (seen) => {
    const got = await Promise.allSettled(posts.map((p) => fetchReplies(p.txid).then((r) => ({ p, r }))));
    const replies = got.flatMap((g) =>
      g.status === 'fulfilled' ? g.value.r.map((r) => ({ post: g.value.p, r })) : [],
    );
    const others = replies.filter(({ r }) => !isMe(r.author, m));
    const fresh = new Set(seen(others.map(({ r }) => r.txid)));
    for (const { post, r } of others)
      if (fresh.has(r.txid))
        out.push(
          item({
            id: `reply:${r.txid}`,
            kind: 'reply',
            title: `${r.author.name} replied`,
            body: excerpt(r.text || 'to your post') + (post.text ? ` — on “${excerpt(post.text, 40)}”` : ''),
            full: excerpt(r.text || 'to your post', FULL),
            at: r.at || now(),
            target: postTarget(r),
          }),
        );
  });
  // Likes + locks: bmap's like index per post (a lock-like is a MAP like next to a lock output).
  await source(st, 'bmap.likes', async (seen) => {
    const got = await Promise.allSettled(
      posts.slice(0, 5).map((p) => getJson(`${FEED_API}/social/post/${p.txid}/like?limit=100`).then((b) => ({ p, b }))),
    );
    for (const g of got) {
      if (g.status !== 'fulfilled') continue;
      const { p, b } = g.value;
      const docs = ((b as { results?: unknown[] })?.results ?? []) as Record<string, unknown>[];
      const locks = new Set(lockCandidates(b));
      const ids = docs
        .map((d) => {
          const tx = (d.tx as { h?: string } | undefined)?.h ?? (d._id as string | undefined) ?? '';
          const addr = ((d.AIP as { address?: string }[] | undefined)?.[0]?.address as string | undefined) ?? '';
          return { tx, addr };
        })
        .filter((x) => x.tx && !m.addresses.includes(x.addr));
      const fresh = seen(ids.map((x) => `${p.txid}:${x.tx}`));
      const nLocks = fresh.filter((f) => locks.has(f.split(':')[1])).length;
      const nLikes = fresh.length - nLocks;
      if (nLikes)
        out.push(
          item({
            id: `like:${p.txid}:${fresh.join(',').slice(-24)}`,
            kind: 'like',
            title: nLikes === 1 ? 'New like' : `${nLikes} new likes`,
            body: `On “${excerpt(p.text || 'your post', 60)}”`,
            target: postTarget(p),
          }),
        );
      if (nLocks)
        out.push(
          item({
            id: `lock:${p.txid}:${fresh.join(',').slice(-24)}`,
            kind: 'lock',
            title: nLocks === 1 ? 'Someone locked BSV to your post' : `${nLocks} new locks on your post`,
            body: `“${excerpt(p.text || 'your post', 60)}”`,
            target: postTarget(p),
          }),
        );
    }
  });
  // Quotes: bChat quotes name the original (MAP quote) and carry its link, so a text search finds them.
  await source(st, 'bmap.quotes', async (seen) => {
    const got = await Promise.allSettled(
      posts
        .slice(0, 3)
        .map((p) =>
          getJson(`${FEED_API}/social/post/search?q=${p.txid}&limit=20`).then((b) => ({ p, q: parseBmapFeed(b) })),
        ),
    );
    for (const g of got) {
      if (g.status !== 'fulfilled') continue;
      const qs = g.value.q.filter((q) => q.quoteTxid === g.value.p.txid && !isMe(q.author, m));
      const fresh = new Set(seen(qs.map((q) => q.txid)));
      for (const q of qs)
        if (fresh.has(q.txid))
          out.push(
            item({
              id: `quote:${q.txid}`,
              kind: 'quote',
              title: `${q.author.name} quoted you`,
              body: excerpt(q.text),
              full: excerpt(q.text, FULL),
              at: q.at || now(),
              target: postTarget(q),
            }),
          );
    }
  });
}

async function bmapMentions(m: Me, st: PollState, out: NotifyItem[]) {
  const names = m.names.slice(0, 2);
  if (!names.length) return;
  await source(st, 'bmap.mentions', async (seen) => {
    const got = await Promise.allSettled(
      names.map((n) => getJson(`${FEED_API}/social/post/search?q=${encodeURIComponent(n)}&limit=30`)),
    );
    const posts = got
      .flatMap((g) => (g.status === 'fulfilled' ? parseBmapFeed(g.value) : []))
      .filter((p) => !isMe(p.author, m) && mentionsMe(p.text, m.names));
    const fresh = new Set(seen(posts.map((p) => p.txid)));
    for (const p of posts)
      if (fresh.has(p.txid))
        out.push(
          item({
            id: `mention:${p.txid}`,
            kind: 'mention',
            title: `${p.author.name} mentioned you`,
            body: excerpt(p.text),
            full: excerpt(p.text, FULL),
            at: p.at || now(),
            target: postTarget(p),
          }),
        );
  });
}

async function twetch(m: Me, st: PollState, out: NotifyItem[]) {
  const uid = m.twetchUserId;
  if (!uid) return;
  const posts = await fetchTwetchUserPosts(uid, MY_POSTS);
  // Replies: only re-read the posts whose reply count went up (Twetch has no notifications API).
  await source(st, 'twetch.posts', async (seen, prev) => {
    const counts: Record<string, number> = {};
    for (const p of posts) counts[`r:${p.twetchId}`] = p.replies;
    for (const p of posts) counts[`l:${p.twetchId}`] = p.likes;
    const up = countIncreases(prev, counts);
    const withReplies = posts.filter((p) => p.twetchId && up[`r:${p.twetchId}`]);
    const got = await Promise.allSettled(
      withReplies.map((p) => fetchTwetchReplies(p.twetchId!).then((r) => ({ p, r }))),
    );
    for (const g of got) {
      if (g.status !== 'fulfilled') continue;
      const rs = g.value.r.filter((r) => r.twetchUserId !== uid);
      const fresh = new Set(seen(rs.map((r) => r.txid)));
      for (const r of rs)
        if (fresh.has(r.txid))
          out.push(
            item({
              id: `reply:${r.txid}`,
              kind: 'reply',
              title: `${r.author.name} replied on Twetch`,
              body: excerpt(r.text || 'to your post'),
              full: excerpt(r.text || 'to your post', FULL),
              at: r.at || now(),
              target: postTarget(r),
            }),
          );
    }
    for (const p of posts) {
      const n = up[`l:${p.twetchId}`];
      if (n)
        out.push(
          item({
            id: `like:${p.txid}:${counts[`l:${p.twetchId}`]}`,
            kind: 'like',
            title: n === 1 ? 'New like on Twetch' : `${n} new likes on Twetch`,
            body: `On “${excerpt(p.text || 'your post', 60)}”`,
            target: postTarget(p),
          }),
        );
    }
    return counts;
  });
  // Mentions + quotes of you in Twetch's latest feed (@<user id> is Twetch's mention form).
  await source(st, 'twetch.latest', async (seen) => {
    const latest = parseTwetchFeed(await getJson(`${TWETCH_API}/v1/feed/latest?limit=60`));
    const mine = new Set(posts.map((p) => p.twetchId));
    const hits = latest.filter(
      (p) =>
        p.twetchUserId !== uid &&
        (new RegExp(`(^|[^\\w])@${uid}(?!\\d)`).test(p.text) ||
          mentionsMe(p.text, m.names) ||
          (p.quoteId && mine.has(p.quoteId)) ||
          (p.parentId && mine.has(p.parentId))),
    );
    const fresh = new Set(seen(hits.map((p) => p.txid)));
    for (const p of hits) {
      if (!fresh.has(p.txid)) continue;
      const kind =
        p.parentId && mine.has(p.parentId) ? 'reply' : p.quoteId && mine.has(p.quoteId) ? 'quote' : 'mention';
      out.push(
        item({
          id: `${kind}:${p.txid}`,
          kind,
          title: `${p.author.name} ${kind === 'reply' ? 'replied' : kind === 'quote' ? 'quoted you' : 'mentioned you'} on Twetch`,
          body: excerpt(p.text),
          full: excerpt(p.text, FULL),
          at: p.at || now(),
          target: postTarget(p),
        }),
      );
    }
  });
}

async function bchat(m: Me, st: PollState, out: NotifyItem[]) {
  const session = loadSession();
  if (!session) return;
  const client = new BchatClient(defaultHttp(Capacitor.isNativePlatform()), session);
  const rooms = await client.rooms();
  roomTickers = new Map(rooms.map((r) => [r.id, r.ticker]));
  // Chat tab badge (tabs/tabBadges.ts): the server's unread counts, muted rooms dropped at display.
  setChatRooms(rooms);
  // Watch the most recently active rooms on the realtime feed (capped there).
  roomFeed()?.setRooms(
    [...rooms]
      .sort((a, b) => (Date.parse(b.updated_at ?? '') || 0) - (Date.parse(a.updated_at ?? '') || 0))
      .map((r) => r.id),
  );
  const names = [...m.names, session.handle].filter(Boolean);
  await source(st, 'bchat.rooms', async (_seen, prev) => {
    const counts: Record<string, number> = {};
    for (const r of rooms) counts[r.ticker] = r.unread ?? 0;
    // Unread went up (or a read room got a new message: unread from 0) → news in that room.
    const up = countIncreases(prev, counts);
    for (const r of rooms) {
      const n = up[r.ticker];
      if (!n) continue;
      // Muted in the chat list (chat/listPrefs.ts): no notification, as in Telegram.
      if (isRoomMuted(session.handle, r.ticker)) continue;
      const last = r.last_message;
      const mention = !!last?.body && mentionsMe(last.body, names);
      out.push(
        item({
          id: `${mention ? 'mention' : 'chat'}:${r.ticker}:${last?.created_at ?? counts[r.ticker]}`,
          kind: mention ? 'mention' : 'chat',
          title: mention
            ? `${last?.author_handle ? `$${last.author_handle}` : 'Someone'} mentioned you in ${r.name || r.ticker}`
            : `${n} new message${n === 1 ? '' : 's'} in ${r.name || r.ticker}`,
          body: excerpt(last?.body ?? ''),
          full: excerpt(last?.body ?? '', FULL),
          at: Date.parse(last?.created_at ?? '') || now(),
          target: { type: 'room', ticker: r.ticker },
        }),
      );
    }
    return counts;
  });
}

/** Feed tab badge: the For you list's newest post times, at most every FEED_BADGE_MS (it is six requests). */
const FEED_BADGE_MS = 5 * 60_000;
let feedCheckedAt = 0;
async function feedBadge() {
  if (Date.now() - feedCheckedAt < FEED_BADGE_MS) return;
  feedCheckedAt = Date.now();
  const posts = await fetchForYou();
  setFeedLatest(posts.map((p) => p.at));
}

const outpointKey = (o: string) => o.replace('.', '_');

async function incoming(m: Me, st: PollState, out: NotifyItem[]) {
  const addrs = m.addresses.slice(0, 3);
  if (!addrs.length) return;
  const rows: SearchRow[] = (
    await Promise.allSettled(
      addrs.map((a) => search({ key: `own:${a}`, rev: 'true', unspent: 'true', sats: 'true', tags: '*', limit: '60' })),
    )
  ).flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const tickets = new Set(rememberedTicketIds());
  const mine = await myTxids(m);
  await source(st, 'utxo.incoming', async (seen) => {
    const ext = rows.filter((r) => !mine.has(r.outpoint.split(/[._]/)[0]));
    const fresh = new Set(seen(ext.map((r) => outpointKey(r.outpoint))));
    for (const r of ext) {
      if (!fresh.has(outpointKey(r.outpoint))) continue;
      const d = describeIncoming(r as IncomingRow, tickets);
      if (d) out.push(item({ id: `in:${outpointKey(r.outpoint)}`, ...d, target: { type: 'wallet' } }));
    }
  });
  // Sales: a listing of ours that is no longer unspent, spent by a tx this wallet did not make.
  const listings: Record<string, number> = {};
  for (const r of rows) if (r.data?.ordlock) listings[outpointKey(r.outpoint)] = Number(r.data.ordlock.price) || 0;
  const gone = Object.keys(st.listings).filter((o) => !(o in listings));
  if (st.seeded['utxo.sales']) {
    const spends = await Promise.allSettled(
      gone.slice(0, 10).map((o) =>
        getJson(`${ONESAT}/txo/${o.replace('_', '.')}/spend`).then((b) => ({
          o,
          spend: String((b as { spendTxid?: string })?.spendTxid ?? ''),
        })),
      ),
    );
    for (const s of spends) {
      if (s.status !== 'fulfilled' || !s.value.spend || mine.has(s.value.spend)) continue;
      const price = st.listings[s.value.o];
      out.push(
        item({
          id: `sale:${s.value.o}`,
          kind: 'sale',
          title: 'Your listing sold',
          body: price ? `Sold for ${formatSatsShort(price)}` : 'A buyer took your listing',
          target: { type: 'wallet' },
        }),
      );
    }
  }
  st.listings = listings;
  st.seeded['utxo.sales'] = true;
}

/** Txids this wallet created recently (its own change / listings / cancels are not news). */
async function myTxids(m: Me): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const w = m.ctx?.wallet as unknown as {
      listActions?: (a: Record<string, unknown>) => Promise<{ actions?: { txid?: string; isOutgoing?: boolean }[] }>;
    };
    const res = await w?.listActions?.({ labels: [], labelQueryMode: 'any', limit: 100 });
    for (const a of res?.actions ?? []) if (a.txid && a.isOutgoing !== false) out.add(a.txid);
  } catch {
    // unknown: everything external counts
  }
  return out;
}

// ── bMail ────────────────────────────────────────────────────────────────────
// Peeks the 'bmail' message box (never acknowledges or internalizes: the bMail screen does that) and notifies
// only for mail that routes to Inbox. Requests (unstamped, under-priced) stay quiet.
// TODO(bmail closed-app push, owner 9 Oct): the PHONE decrypts the subject (iOS Notification Service Extension /
// Android FCM data handler using the wallet's BRC-2 key); the push server only relays the sealed envelope and never
// sees plaintext. Not built yet: needs push-server work (docs/NOTIFICATIONS.md, bwalletx-push-project).

const bmailLabel = async (key: string): Promise<string> => {
  const fr = getFriends().find((x) => x.key === key)?.name;
  if (fr) return fr;
  const p = await fetchPeerBPhone((u, i) => fetch(u, i), key).catch(() => null);
  if (p?.paymail) return `$${p.paymail.split('@')[0]}`;
  return p?.name || shortKey(key);
};

async function bmail(m: Me, st: PollState, out: NotifyItem[]) {
  const wallet = m.ctx?.wallet as unknown as WalletInterface | undefined;
  if (!wallet) return;
  const me = await myKey(wallet);
  const mail = loadMail(me);
  const known = new Set(mail.received.map((r) => r.id));
  const priceSats = usdToSats(mail.priceUsd, cachedExchangeRate()) ?? 0;
  const isFriend = (k: string) => isCallFriend(k) || mail.contacts.includes(k);
  const peek = (await peekMail(wallet, me)).filter((p) => !known.has(p.env.id));
  const inbox = peek.filter(({ env, sats }) => {
    const replyCredit =
      !!env.usesReplyCredit &&
      mail.sent.some((s) => s.id === env.inReplyTo && s.to === env.from && s.replyPaidSats > 0);
    return (
      route({ id: env.id, from: env.from, at: env.at, verifiedSats: sats, replyCredit }, { isFriend, priceSats }) ===
      'inbox'
    );
  });
  savePending(
    me,
    inbox.map((p) => p.env.id),
  );
  await source(st, 'bmail.inbox', async (seen) => {
    const fresh = new Set(seen(inbox.map((p) => p.env.id)));
    const detail = loadPrefs().bmailDetail;
    for (const { env, sats } of inbox) {
      if (!fresh.has(env.id)) continue;
      if (detail === 'none') {
        out.push(
          item({ id: `bmail:${env.id}`, kind: 'bmail', title: 'New bMail', body: '', target: { type: 'bmail' } }),
        );
        continue;
      }
      const who = await bmailLabel(env.from);
      const stamp = sats > 0 ? `${moneyNow(sats)} stamp` : isFriend(env.from) ? 'Friend' : 'Reply paid';
      // Subject is decrypted here, on the phone, with the wallet's BRC-2 key; it never leaves the device.
      const subject =
        detail === 'subject'
          ? await openMail(wallet, env)
              .then((x) => x.subject)
              .catch(() => '')
          : '';
      out.push(
        item({
          id: `bmail:${env.id}`,
          kind: 'bmail',
          title: `bMail from ${who}`,
          body: [stamp, excerpt(subject, 80)].filter(Boolean).join(' · '),
          at: Math.min(env.at, now()),
          target: { type: 'bmail' },
        }),
      );
    }
  });
}

// ── calls (pushed by the calls store, not polled here) ──────────────────────

function watchCalls() {
  unsubCalls?.();
  let ringing: string | null = null;
  unsubCalls = subscribeCalls((s) => {
    const c = s.call as { phase: string; callId?: string; peer?: { label?: string } };
    if (c.phase === 'incoming' && c.callId && c.callId !== ringing) {
      ringing = c.callId;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        void deliver([
          item({
            id: `call:${c.callId}`,
            kind: 'call',
            title: 'Incoming call',
            body: c.peer?.label ?? 'Someone is calling',
            target: { type: 'calls' },
          }),
        ]);
    }
    const st = loadPollState();
    const missed = s.recent.filter(
      (r) => r.direction === 'incoming' && !r.answered_at && (r.status === 'missed' || r.status === 'cancelled'),
    );
    const d = diffSeen(
      st.seen['calls.missed'] ?? [],
      missed.map((r) => r.id),
      !!st.seeded['calls.missed'],
    );
    st.seen['calls.missed'] = d.seen;
    if (s.ready) st.seeded['calls.missed'] = true;
    savePollState(st);
    const fresh = missed.filter((r) => d.fresh.includes(r.id));
    if (fresh.length)
      void deliver(
        fresh.map((r) =>
          item({
            id: `missed:${r.id}`,
            kind: 'call',
            title: `Missed call from ${r.peer_label || shortKey(r.peer_key)}`,
            body: 'Tap to call back',
            at: Date.parse(r.created_at) || now(),
            target: { type: 'calls' },
          }),
        ),
      );
  });
}

// ── delivery ─────────────────────────────────────────────────────────────────

async function deliver(found: NotifyItem[]) {
  const on = allowed(found, loadPrefs().notify);
  const stored = pushItems(on);
  // OS notices honour "Show message previews"; the in-app list (pushItems above) keeps the full text.
  const previews = localPreviews();
  const added = stored.map((i) => ({ ...i, body: osNoticeBody(i, previews) }));
  if (added.length && IS_TAURI) {
    // Desktop (Tauri): OS notifications through the Rust side (desktop/notify.ts).
    void import('../desktop/notify')
      .then((m) => m.desktopNotify(added))
      .catch((e) => console.warn('[notify] desktop notification failed', e));
    return;
  }
  if (!added.length || !Capacitor.isNativePlatform()) return;
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') return;
    await LocalNotifications.schedule({
      notifications: added.slice(0, 5).map((i) => ({
        id: nativeId(i.id),
        title: i.title,
        body: i.body,
        extra: { notifyId: i.id, target: i.target ?? null },
        group: 'bwallet',
        // Shown now, not at a set time: never ask Android for "Alarms & reminders".
        isExactNotification: false,
      })),
    });
  } catch (e) {
    console.warn('[notify] local notification failed', e);
  }
}

let again = false;

export async function pollNow(): Promise<void> {
  const m = me;
  if (!m) return;
  // A live event during a slow poll (Twetch/bmap can take 15 s) used to be dropped until the next 90 s poll.
  if (running) {
    again = true;
    return;
  }
  running = true;
  again = false;
  try {
    const st = loadPollState();
    const out: NotifyItem[] = [];
    await Promise.allSettled([
      bmapSocial(m, st, out),
      bmapMentions(m, st, out),
      twetch(m, st, out),
      bchat(m, st, out),
      incoming(m, st, out),
      bmail(m, st, out),
      feedBadge(),
    ]);
    savePollState(st);
    await deliver(out);
  } finally {
    running = false;
    // After the caller's own reschedule (schedule() sets POLL_MS in its finally), so this one wins.
    if (again && me) setTimeout(() => me && schedule(1_500), 0);
  }
}

const schedule = (ms: number) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; // resumes on visible
    void pollNow().finally(() => me && schedule(POLL_MS));
  }, ms);
};

const onVisible = () => {
  if (document.visibilityState === 'visible' && me) schedule(1_500);
};

/** Start (or reconfigure) polling for the unlocked account. */
export function startNotify(next: Me) {
  const first = !me;
  me = next;
  if (first) {
    document.addEventListener('visibilitychange', onVisible);
    watchCalls();
    if (Capacitor.isNativePlatform())
      void App.addListener('resume', () => me && schedule(1_500))
        .then((h) => (resumeSub = h))
        .catch(() => undefined);
    if (Capacitor.isNativePlatform())
      void LocalNotifications.addListener('localNotificationActionPerformed', (a) => {
        const t = (a.notification?.extra as { target?: { type?: string } } | undefined)?.target;
        if (t?.type === 'bmail') openBMail();
      })
        .then((h) => (tapSub = h))
        .catch(() => undefined);
    schedule(5_000);
    // Live chat (chat/live.ts): a new message in an unmuted room polls now instead of in 90 s.
    const lh = liveHub();
    if (lh) {
      const release = lh.acquire();
      // System events ("$mike joined" is a member_joined event message) arrive as message.event / member.join,
      // not message.new; they used to wait for the 90 s poll (latency audit, 15 Oct 2026).
      const onRoomEvent = (ev: { room?: string }) => {
        const handle = loadSession()?.handle;
        if (!me || !ev.room || (handle && isRoomMuted(handle, ev.room))) return;
        schedule(1_500);
      };
      const offs = (['message.new', 'message.event', 'member.join'] as const).map((t) =>
        lh.on(t, undefined, onRoomEvent),
      );
      unsubLive = () => {
        offs.forEach((off) => off());
        release();
      };
    }
    // Realtime room feed (the postgres_changes feed bChatX web uses): bit-sign never sends joins to
    // the rt relay, so this is what brings "$mike joined" in seconds. Polling stays as the fallback.
    const feed = roomFeed();
    if (feed) {
      const release = feed.acquire();
      const off = feed.on(undefined, (row) => {
        const handle = loadSession()?.handle;
        const muted = (t: string) => !!handle && isRoomMuted(handle, t);
        if (me && feedRowWantsPoll(row, (id) => roomTickers.get(id), muted)) schedule(1_500);
      });
      unsubFeed = () => {
        off();
        release();
      };
    }
  }
}

export function stopNotify() {
  me = null;
  if (timer) clearTimeout(timer);
  timer = null;
  unsubCalls?.();
  unsubCalls = null;
  unsubLive?.();
  unsubLive = null;
  unsubFeed?.();
  unsubFeed = null;
  roomTickers = new Map();
  clearChatBadges();
  feedCheckedAt = 0;
  void resumeSub?.remove();
  resumeSub = null;
  void tapSub?.remove();
  tapSub = null;
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
}

/**
 * Ask for the OS notification permission once, at a moment the user has something to be notified
 * about (after their first post, after claiming a name, or when they open the bell) — never at launch.
 */
export async function askNotifyPermissionOnce(): Promise<void> {
  if (wasAsked() || (!Capacitor.isNativePlatform() && !IS_TAURI)) return;
  setAsked();
  if (IS_TAURI) {
    await import('../desktop/notify').then((m) => m.askDesktopNotifyPermission()).catch(() => undefined);
    return;
  }
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display === 'prompt' || display === 'prompt-with-rationale') await LocalNotifications.requestPermissions();
  } catch {
    // plugin unavailable
  }
}
