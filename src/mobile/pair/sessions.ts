/**
 * bWallet side of phone pairing (tokenblaster.lol docs/wallet-connect.md §4).
 *
 * A desktop site shows a QR; bWallet scans it, joins the relay channel, checks the relay's
 * verifiedOrigin against the QR, shows the origin and a 4-digit code, and on Connect relays the
 * site's BRC-100 calls into the same approval path the in-app browser uses (handleSiteCall), with
 * originator fixed to the verified origin for the life of the session.
 */
import { PrivateKey } from '@bsv/sdk';
import {
  Sealer,
  deriveSession,
  isSealed,
  parsePairUrl,
  relaySocketUrl,
  isAllowedRelay,
  type HelloFrame,
  type PairLink,
  type PairMessage,
  type RelayFrame,
} from '../../pair/protocol';
import { inOrder } from '../../pair/in-order';
import { handleSiteCall } from '../dappBrowser';
import { pairedOrigin } from '../../services/originKey';
import { appNameFor } from '../storeBuild';
import type { OneSatContext } from '@1sat/actions';
import { fetchExchangeRate } from '../../utils/wallet';
import { AgentCallError, CLI_ORIGIN, handleAgentCall, type AgentGrant } from './agentPairing';
import { ReplyBook } from './replies';

/** What paired-CLI calls need from the app; TopNav keeps it current (wallet context + open account). */
let agentDeps: {
  ctx: OneSatContext | undefined;
  currentId: string | undefined;
  feeRate?: () => number;
  /** How many accounts the wallet holds; decides whether pre-binding sessions are adopted (see bindToAccount). */
  accountCount?: number;
} = {
  ctx: undefined,
  currentId: undefined,
};
export const setAgentPairDeps = (d: typeof agentDeps) => {
  const changed = d.currentId !== agentDeps.currentId;
  agentDeps = d;
  // Sessions are revived only for the account that made them, so the reconnect waits for the open account.
  if (changed && started && d.currentId) reconnectAll();
};
let rateCache = { at: 0, rate: 0 };
const bsvUsd = async () => {
  if (Date.now() - rateCache.at > 60_000 || !rateCache.rate)
    rateCache = { at: Date.now(), rate: await fetchExchangeRate('main').catch(() => rateCache.rate) };
  return rateCache.rate;
};

const KEY = 'bwallet.pair.sessions';
const REVOKE_QUEUE = 'bwallet.pair.revokeQueue';
const SWEEP_FLAG = 'bwallet.pair.sweptBareHostGrants.v1';

/**
 * Disconnect must withdraw what the pairing was given (b-Aware report, 23 Oct 2026): the paired key
 * "<host>.paired.invalid" depends on the host alone, so grants and the monthly allowance left under it were
 * inherited by the next pairing that reported the same host. Revocation goes through the same background action
 * as History › Connections › Revoke all (revokeAllForOriginator: every grant type, spending included, and the
 * permission cache). Originators that could not be revoked yet are queued and retried, never dropped.
 */
type Revoke = (originator: string) => Promise<boolean>;
const defaultRevoke: Revoke = async (originator) => {
  const c = (globalThis as { chrome?: { runtime?: { sendMessage?: (m: unknown) => Promise<unknown> } } }).chrome;
  if (!c?.runtime?.sendMessage) return false;
  const r = (await c.runtime
    .sendMessage({ action: 'PERMISSIONS_REVOKE_ALL', originator, allAccounts: true })
    .catch(() => null)) as {
    success?: boolean;
  } | null;
  return !!r?.success;
};
let revoke: Revoke = defaultRevoke;
/** Tests only. */
export const setPairRevoker = (fn: Revoke) => {
  revoke = fn;
};
const readQueue = (): string[] => {
  try {
    const q = JSON.parse(localStorage.getItem(REVOKE_QUEUE) || '[]');
    return Array.isArray(q) ? q.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const writeQueue = (q: string[]) => {
  try {
    if (q.length) localStorage.setItem(REVOKE_QUEUE, JSON.stringify([...new Set(q)]));
    else localStorage.removeItem(REVOKE_QUEUE);
  } catch {
    /* storage unavailable */
  }
};
/** Revoke every queued originator plus `more`; keep whatever failed for the next try. */
export async function flushRevocations(more: string[] = []): Promise<void> {
  const pending = [...new Set([...readQueue(), ...more])];
  if (!pending.length) return;
  writeQueue(pending);
  const left: string[] = [];
  for (const o of pending) if (!(await revoke(o).catch(() => false))) left.push(o);
  writeQueue(left);
}
const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).host || null;
  } catch {
    return null;
  }
};
/**
 * Before 5.2.38 (commit 9f57eb29) a paired session's grants were written under the site's bare host. Sweep those
 * once for every stored session, so the paired session and the in-app browser stop sharing a key.
 */
const sweepBareHostGrants = () => {
  try {
    if (localStorage.getItem(SWEEP_FLAG)) return;
    const hosts = load()
      .map((s) => hostOf(s.origin))
      .filter((h): h is string => !!h);
    localStorage.setItem(SWEEP_FLAG, '1');
    if (hosts.length) void flushRevocations(hosts);
  } catch {
    /* storage unavailable: try again next start */
  }
};
const IDLE_MS = 24 * 60 * 60 * 1000;

export type StoredSession = {
  c: string;
  r: string;
  origin: string;
  sitePub: string;
  phoneKey: string; // pairing key only (hex); not a wallet key
  sent: number;
  lastSeen: number;
  createdAt: number;
  lastUsed: number;
  /** Set for a bWalletX CLI / MCP pairing (origin CLI_ORIGIN): the agent account, scopes and expiry. */
  agent?: AgentGrant;
  /** Identity address of the account that paired. Missing on sessions stored before 23 Oct 2026. */
  account?: string;
};

/** What the UI shows while a scan is being confirmed. A CLI pairing passes its grant to confirm. */
export type PendingPair = {
  origin: string;
  code: string;
  cli: boolean;
  confirm: (agent?: AgentGrant) => void;
  cancel: () => void;
};

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());
export const subscribePairs = (l: Listener) => (listeners.add(l), () => void listeners.delete(l));

// Loopback relay: dev builds and bun tests only (Vite never defines NODE_ENV on import.meta.env in a build).
const ALLOW_LOCAL_RELAY =
  import.meta.env.DEV === true || (import.meta.env as Record<string, unknown>).NODE_ENV === 'test';

/**
 * Pairings stored before the relay was pinned (audit H1) may point at any relay. Drop them for good; the user pairs
 * again through relay.bwallet.space.
 */
export const dropUntrustedRelays = (all: StoredSession[], allowLocal = ALLOW_LOCAL_RELAY) =>
  all.filter((s) => isAllowedRelay(s.r, allowLocal));

const isCurrent = (s: StoredSession, now = Date.now()) =>
  s.agent ? now < s.agent.expiresAt : now - s.lastUsed < IDLE_MS;

/**
 * A session that lapses (24 h idle, agent grant expired, unpinned relay) is dropped like a Disconnect: its socket
 * closes and the paired key's grants are queued for revocation (b-Aware report, 23 Oct 2026), unless another
 * current session still uses the same paired key. The queue is written before anything else so a revoke is
 * never lost.
 */
const dropLapsed = (dropped: StoredSession[], kept: StoredSession[]) => {
  const inUse = new Set(kept.map((s) => pairedOrigin(s.origin)));
  const origins = [...new Set(dropped.map((s) => pairedOrigin(s.origin)))].filter((o) => !inUse.has(o));
  if (origins.length) writeQueue([...readQueue(), ...origins]);
  for (const s of dropped) {
    replies.forget(s.c);
    const l = live.get(s.c);
    if (!l) continue;
    if (l.retry) clearTimeout(l.retry);
    live.delete(s.c);
    l.ws.close();
  }
  if (origins.length) void flushRevocations();
};

/**
 * A pairing belongs to the account that made it (b-Aware report, 23 Oct 2026): a different wallet restored on the
 * same device must not inherit live site channels. Once the open account is known, sessions of any other account are
 * dropped like a lapse. Sessions stored before the binding have no account: they are adopted only when the wallet
 * holds exactly one account (it must be the one that paired them); otherwise dropped, and the user pairs again.
 */
export const bindToAccount = (
  all: StoredSession[],
  current: string | undefined,
  accountCount: number | undefined,
): StoredSession[] => {
  if (!current) return all;
  return all.flatMap((s) => {
    if (s.account === current) return [s];
    if (!s.account && accountCount === 1) return [{ ...s, account: current }];
    return [];
  });
};

const load = (): StoredSession[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as StoredSession[];
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    const trusted = new Set(dropUntrustedRelays(raw));
    const current = raw.filter((s) => trusted.has(s) && isCurrent(s, now));
    const kept = bindToAccount(current, agentDeps.currentId, agentDeps.accountCount);
    const adopted = kept.some((s, i) => s !== current[i]);
    if (kept.length !== raw.length || adopted) {
      localStorage.setItem(KEY, JSON.stringify(kept));
      const keptChannels = new Set(kept.map((s) => s.c));
      dropLapsed(
        raw.filter((s) => !keptChannels.has(s.c)),
        kept,
      );
    }
    return kept;
  } catch {
    return [];
  }
};
const save = (all: StoredSession[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: sessions last until the app closes */
  }
  emit();
};
export const pairedSites = () => load();

type Live = { ws: WebSocket; sealer: Sealer; stored: StoredSession; retry?: ReturnType<typeof setTimeout> };
const live = new Map<string, Live>();

const update = (c: string, patch: Partial<StoredSession>) =>
  save(load().map((s) => (s.c === c ? { ...s, ...patch } : s)));

/** Answered / in-flight / unsent replies per channel (memory only). See replies.ts. */
const replies = new ReplyBook();
/** Per-channel send chain: frames are sealed and sent one at a time so counters reach the site in order. */
const sendChains = new Map<string, Promise<void>>();

/** Seal and send on the channel's current socket; a reply that can't go now waits for reconnect. */
function send(c: string, msg: PairMessage, via?: Live): Promise<void> {
  const next = (sendChains.get(c) ?? Promise.resolve()).then(async () => {
    const l = live.get(c) ?? via; // via: a socket being closed (forget) still says goodbye
    if (!l || l.ws.readyState !== WebSocket.OPEN) {
      if (msg.t === 'res' && load().some((s) => s.c === c)) replies.hold(c, msg);
      return;
    }
    const frame = await l.sealer.seal(msg);
    if (l.ws.readyState !== WebSocket.OPEN) {
      if (msg.t === 'res') replies.hold(c, msg); // resealed with a fresh counter when it goes
      return;
    }
    l.ws.send(JSON.stringify(frame));
    update(c, { ...l.sealer.counters });
  });
  const tail = next.catch(() => {});
  sendChains.set(c, tail);
  return tail;
}

async function reply(l: Live, msg: PairMessage) {
  // Record a call's answer before sending it, so a repeat of the request is answered, never re-run.
  if (msg.t === 'res') replies.finish(l.stored.c, msg.id, msg);
  await send(l.stored.c, msg, l);
}

/** Send what was held while the socket was closed. */
function flush(c: string) {
  for (const msg of replies.drain(c)) void send(c, msg);
}

async function onAgentRequest(l: Live, grant: AgentGrant, id: string, action: string, params: unknown) {
  try {
    if (!agentDeps.ctx) throw new AgentCallError('LOCKED', `${appNameFor()} is locked. Unlock it on your phone.`);
    const result = await handleAgentCall(grant, action, params, {
      ctx: agentDeps.ctx,
      currentId: agentDeps.currentId,
      bsvUsd,
      feeRate: agentDeps.feeRate,
      saveGrant: (g) => {
        l.stored = { ...l.stored, agent: g };
        update(l.stored.c, { agent: g });
      },
    });
    await reply(l, { t: 'res', id, result });
  } catch (e) {
    const code = e instanceof AgentCallError ? e.code : 'ERROR';
    await reply(l, { t: 'res', id, error: { code, message: e instanceof Error ? e.message : String(e) } });
  }
}

async function onRequest(l: Live, id: string, action: string, params: unknown) {
  const seen = replies.begin(l.stored.c, id);
  if (seen === 'busy') return; // still running: the first run replies
  if (seen !== 'run') return send(l.stored.c, seen.replay); // answered before: re-send, never re-run
  if (l.stored.agent) return onAgentRequest(l, l.stored.agent, id, action, params);
  try {
    // The relay's origin is a claim, not proof (audit H1): run under the paired key, never the site's own grants.
    const as = pairedOrigin(l.stored.origin);
    const r = (await handleSiteCall(as, as + '/', action, params, true)) as {
      success?: boolean;
      data?: unknown;
      error?: string;
    };
    if (r?.success) await reply(l, { t: 'res', id, result: r.data });
    else await reply(l, { t: 'res', id, error: { code: 'REJECTED', message: r?.error || 'Request refused' } });
  } catch (e) {
    await reply(l, { t: 'res', id, error: { code: 'ERROR', message: e instanceof Error ? e.message : String(e) } });
  }
}

/** Wire a confirmed session's socket: requests in, replies out, reconnect when it drops. */
function attach(l: Live) {
  const { ws, sealer, stored } = l;
  live.set(stored.c, l);
  // In order: two sealed frames back to back must not race through sealer.open.
  ws.onmessage = inOrder(async (ev: MessageEvent) => {
    const f = JSON.parse(String(ev.data)) as RelayFrame | unknown;
    if ((f as RelayFrame).t === 'relay') {
      const v = (f as RelayFrame).verifiedOrigin;
      if (v && v !== stored.origin) forget(stored.c, false); // the channel changed hands: refuse
      return;
    }
    if (!isSealed(f)) return;
    const msg = await sealer.open(f);
    if (!msg) return;
    update(stored.c, { ...sealer.counters, lastUsed: Date.now() });
    if (msg.t === 'req') void onRequest(l, msg.id, msg.action, msg.params);
    else if (msg.t === 'ping') void reply(l, { t: 'ping' });
    else if (msg.t === 'close') forget(stored.c, false);
  });
  ws.onerror = null;
  if (ws.readyState === WebSocket.OPEN) flush(stored.c);
  else ws.onopen = () => flush(stored.c);
  ws.onclose = () => {
    if (live.get(stored.c) !== l) return;
    live.delete(stored.c);
    // Still paired: try again (the relay holds frames for 60 s while we're away).
    if (load().some((s) => s.c === stored.c) && document.visibilityState === 'visible')
      l.retry = setTimeout(() => connect(stored.c), 3000);
  };
}

/** Channels whose key is being derived for a reconnect (the socket isn't in `live` until that finishes). */
const connecting = new Set<string>();

/** Reopen the relay socket for a stored session. */
function connect(c: string) {
  const old = live.get(c);
  if (old && old.ws.readyState <= WebSocket.OPEN) return;
  // initPairing and the foreground listener (or two quick visibility changes) can both ask while the key is still
  // being derived; without this each opened its own socket and the later one silently replaced the earlier in `live`.
  if (connecting.has(c)) return;
  const stored = load().find((s) => s.c === c);
  if (!stored) return;
  connecting.add(c);
  void (async () => {
    try {
      const { key } = await deriveSession(PrivateKey.fromHex(stored.phoneKey), stored.sitePub, stored.c);
      if (!load().some((s) => s.c === c)) return; // forgotten meanwhile
      const sealer = new Sealer(key, 'wallet');
      sealer.restore({ sent: stored.sent, lastSeen: stored.lastSeen });
      if (!isAllowedRelay(stored.r, ALLOW_LOCAL_RELAY)) return; // never reconnect to an unpinned relay (audit H1)
      attach({ ws: new WebSocket(relaySocketUrl(stored.r, stored.c, 'wallet')), sealer, stored });
    } finally {
      connecting.delete(c);
    }
  })();
}

/** Disconnect a site: tell it, forget the key, and withdraw every grant and allowance the pairing was given. */
export function forget(c: string, notify = true) {
  const stored = load().find((s) => s.c === c);
  const l = live.get(c);
  if (l) {
    if (l.retry) clearTimeout(l.retry);
    live.delete(c);
    const done = () => l.ws.close();
    if (notify) void reply(l, { t: 'close', reason: 'user unpaired' }).finally(done);
    else done();
  }
  replies.forget(c);
  save(load().filter((s) => s.c !== c));
  if (stored) void flushRevocations([pairedOrigin(stored.origin)]);
}

/**
 * Start pairing from a scanned QR. Resolves with what the confirm screen needs; the session is
 * stored only when the user taps Connect.
 */
export function beginPairing(scanned: string): Promise<PendingPair> {
  let link: PairLink;
  try {
    link = parsePairUrl(scanned, undefined, { allowLocalRelay: ALLOW_LOCAL_RELAY });
  } catch (e) {
    return Promise.reject(e);
  }
  const P = PrivateKey.fromRandom();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relaySocketUrl(link.r, link.c, 'wallet'));
    let settled = false;
    const fail = (m: string) => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(m));
    };
    const timer = setTimeout(() => fail('The site did not answer. Make sure its QR code is still showing.'), 15_000);
    ws.onerror = () => fail('Could not reach the pairing service. Check your connection and try again.');
    ws.onclose = (ev) =>
      !settled && fail(ev.code === 1006 ? 'This code has expired or was already used.' : 'Pairing closed.');
    ws.onmessage = inOrder(async (ev: MessageEvent) => {
      const f = JSON.parse(String(ev.data)) as RelayFrame;
      if (f.t !== 'relay' || !f.verifiedOrigin || settled) return;
      clearTimeout(timer);
      // §4.4: the relay's view of the origin must match the QR. This only catches honest mistakes: a non-browser
      // client can set any Origin header, so the session never gets the site's saved grants (see onRequest).
      if (f.verifiedOrigin !== link.o)
        return fail(`This code was shown by ${f.verifiedOrigin}, not ${link.o}. Don't connect.`);
      const hello: HelloFrame = {
        t: 'hello',
        k: P.toPublicKey().toString(),
        info: { name: appNameFor(), rdns: 'space.bwallet.mobile' },
      };
      ws.send(JSON.stringify(hello));
      const { key, code } = await deriveSession(P, link.k, link.c);
      // A new pairing starts with nothing: withdraw whatever an earlier, lapsed pairing for this host left under the
      // paired key, unless this channel is being resumed or another current session for the host still uses it.
      if (!load().some((s) => s.c === link.c || s.origin === f.verifiedOrigin))
        await flushRevocations([pairedOrigin(f.verifiedOrigin)]);
      if (settled) return;
      settled = true;
      ws.onclose = null;
      ws.onerror = null;
      resolve({
        origin: f.verifiedOrigin,
        code,
        cli: f.verifiedOrigin === CLI_ORIGIN,
        confirm: (agent?: AgentGrant) => {
          if (f.verifiedOrigin === CLI_ORIGIN && !agent) return ws.close(); // a CLI must be bound to an agent account
          const stored: StoredSession = {
            c: link.c,
            r: link.r,
            origin: f.verifiedOrigin!,
            sitePub: link.k,
            phoneKey: P.toHex(),
            sent: 0,
            lastSeen: 0,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            ...(agent && { agent }),
            ...(agentDeps.currentId && { account: agentDeps.currentId }),
          };
          save([...load().filter((s) => s.c !== link.c), stored]);
          const l: Live = { ws, sealer: new Sealer(key, 'wallet'), stored };
          attach(l);
          void reply(l, { t: 'ready' });
        },
        cancel: () => ws.close(),
      });
    });
  });
}

let started = false;
/** Only the open account's sessions; nothing until the open account is known. */
const reconnectAll = () => {
  if (!agentDeps.currentId) return;
  for (const s of load()) connect(s.c);
};
/** Reconnect every paired site; again whenever the app comes back to the foreground. */
export function initPairing() {
  if (started) return;
  started = true;
  sweepBareHostGrants();
  void flushRevocations();
  reconnectAll();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectAll();
  });
}

/**
 * Removing the wallet from the device: close every live pairing socket and forget all sessions, so nothing
 * reconnects on the next launch (the caller then clears localStorage).
 */
export function closeAllPairings() {
  for (const [c, l] of live) {
    if (l.retry) clearTimeout(l.retry);
    live.delete(c);
    replies.forget(c);
    l.ws.close();
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  emit();
}
