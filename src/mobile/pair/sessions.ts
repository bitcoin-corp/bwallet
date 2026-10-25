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
  newClaim,
  isAllowedRelay,
  verifyPairProof,
  type HelloFrame,
  type PairLink,
  type PairMessage,
  type RelayFrame,
} from '../../pair/protocol';
import { inOrder } from '../../pair/in-order';
import { handleSiteCall } from '../dappBrowser';
import { legacyPairedOrigin, pairedOrigin } from '../../services/originKey';
import { appNameFor } from '../storeBuild';
import type { OneSatContext } from '@1sat/actions';
import { fetchExchangeRate } from '../../utils/wallet';
import { AgentCallError, CLI_ORIGIN, handleAgentCall, type AgentGrant } from './agentPairing';
import { ReplyBook } from './replies';
import { USER_DENIED_CODE, USER_DENIED_MESSAGE, isUserDenied } from '../../services/userDenied';
import { PAIR_MIRROR_KEY, toPairMirror } from '../../services/pairedPromptGuard';

/**
 * The pairing itself has ended (24 h idle, agent grant expired, disconnected, or bound to another account), so the
 * site must show its QR again. Distinct from ERR_PERMISSION_DENIED, which only ever means the user said no.
 * Sent as a call's error `{ code: 'REPAIR_NEEDED', message }` and as the reason of the phone's close frame.
 */
export const CLI_ONLY_FROM_SETTINGS =
  'To pair the bWalletX CLI, open Agents › Pair the CLI (or Settings › Paired websites) and scan from there. Only do this if you just ran `bwalletx login` on your own computer.';
export const REPAIR_NEEDED_CODE = 'REPAIR_NEEDED';
export const REPAIR_NEEDED_MESSAGE = 'This pairing has ended. Scan the QR code on the site again to reconnect.';

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
const SWEEP_HOST_KEY_FLAG = 'bwallet.pair.sweptHostPairedKeys.v1';
/** A session's permission key: its host plus its own channel (originKey.ts pairedOrigin). */
const keyOf = (s: { origin: string; c: string }) => pairedOrigin(s.origin, s.c);

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
/**
 * Before 24 Oct 2026 the paired key was "<host>.paired.invalid", shared by every pairing claiming that host. Revoke
 * those once; current sessions keep working under their per-channel key and ask again.
 */
const sweepHostPairedKeys = () => {
  try {
    if (localStorage.getItem(SWEEP_HOST_KEY_FLAG)) return;
    const keys = load().flatMap((s) => {
      try {
        return [legacyPairedOrigin(s.origin)];
      } catch {
        return [];
      }
    });
    localStorage.setItem(SWEEP_HOST_KEY_FLAG, '1');
    if (keys.length) void flushRevocations(keys);
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
  /** Relay role claim (protocol.ts newClaim): only this wallet can rejoin the channel. Missing on older sessions. */
  claim?: string;
  /** The site proved its origin (protocol.ts verifyPairProof). Unset: the host is only claimed. */
  proven?: boolean;
};

/** What the UI shows while a scan is being confirmed. A CLI pairing passes its grant to confirm. */
export type PendingPair = {
  origin: string;
  code: string;
  cli: boolean;
  /** The site proved its origin with its well-known pairing key; else the UI says "claims to be". */
  proven: boolean;
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
  const inUse = new Set(kept.map(keyOf));
  const origins = [...new Set(dropped.map(keyOf))].filter((o) => !inUse.has(o));
  if (origins.length) writeQueue([...readQueue(), ...origins]);
  for (const s of dropped) {
    replies.forget(s.c);
    const l = live.get(s.c);
    if (!l) continue;
    if (l.retry) clearTimeout(l.retry);
    live.delete(s.c);
    // Tell the site the pairing ended (it shows its QR again) rather than going silent.
    void send(s.c, { t: 'close', reason: REPAIR_NEEDED_CODE }, l).finally(() => l.ws.close());
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

/**
 * Mirror the guard's fields into chrome.storage.local for the background worker (services/pairedPromptGuard.ts).
 * lastUsed is rounded down to the minute so a busy channel doesn't write on every frame.
 */
let lastMirror = '';
const mirrorSessions = (all: StoredSession[]) => {
  const c = (globalThis as { chrome?: { storage?: { local?: { set?: (v: unknown) => Promise<unknown> } } } }).chrome;
  if (!c?.storage?.local?.set) return;
  const value = toPairMirror(all.map((s) => ({ ...s, lastUsed: s.lastUsed - (s.lastUsed % 60_000) })));
  const json = JSON.stringify(value);
  if (json === lastMirror) return;
  lastMirror = json;
  void c.storage.local.set({ [PAIR_MIRROR_KEY]: value })?.catch?.(() => {
    lastMirror = '';
  });
};

/** The stored session for a channel, read without dropping anything (load() has side effects). */
const peek = (c: string): StoredSession | undefined => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as StoredSession[];
    return Array.isArray(raw) ? raw.find((s) => s.c === c) : undefined;
  } catch {
    return undefined;
  }
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
      mirrorSessions(kept);
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
  mirrorSessions(all);
  emit();
};
export const pairedSites = () => load();

type Live = {
  ws: WebSocket;
  sealer: Sealer;
  stored: StoredSession;
  retry?: ReturnType<typeof setTimeout>;
  /** Reopened for a stored session (connect), not a fresh pairing. */
  resumed?: boolean;
};
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
    const as = keyOf(l.stored); // this pairing's own key: never shared with another channel claiming the host
    const r = (await handleSiteCall(as, as + '/', action, params, true)) as {
      success?: boolean;
      data?: unknown;
      error?: string;
      code?: string;
    };
    if (r?.success) await reply(l, { t: 'res', id, result: r.data });
    // Refused because the pairing ended meanwhile (the background grants nothing to a pairing without a current
    // session): REPAIR_NEEDED, so the site re-pairs instead of reading it as the user's No.
    else if (!load().some((s) => s.c === l.stored.c))
      await reply(l, { t: 'res', id, error: { code: REPAIR_NEEDED_CODE, message: REPAIR_NEEDED_MESSAGE } });
    // The user declined on the phone: the standard code (services/userDenied.ts), not the generic REJECTED.
    else if (r?.code === USER_DENIED_CODE || isUserDenied(r?.error))
      await reply(l, { t: 'res', id, error: { code: USER_DENIED_CODE, message: USER_DENIED_MESSAGE } });
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
    // The pairing lapsed while its socket stayed open: answer the call with REPAIR_NEEDED (never run it), then let
    // load() drop the session, which revokes its grants and sends the close frame.
    const own = peek(stored.c);
    if (!own || !isCurrent(own)) {
      if (msg.t === 'req')
        await send(
          stored.c,
          { t: 'res', id: msg.id, error: { code: REPAIR_NEEDED_CODE, message: REPAIR_NEEDED_MESSAGE } },
          l,
        );
      load();
      return;
    }
    update(stored.c, { ...sealer.counters, lastUsed: Date.now() });
    if (msg.t === 'req') void onRequest(l, msg.id, msg.action, msg.params);
    else if (msg.t === 'ping') void reply(l, { t: 'ping' });
    else if (msg.t === 'close') forget(stored.c, false);
  });
  ws.onerror = null;
  // A rejoin (not the first attach, which sends its own ready) says `ready` again, so the site resends anything that
  // got no answer while the phone was away.
  const opened = () => {
    flush(stored.c);
    if (l.resumed) void reply(l, { t: 'ready' });
  };
  if (ws.readyState === WebSocket.OPEN) opened();
  else ws.onopen = opened;
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
      // Sessions stored before claims existed get one now; the relay binds it on this connect.
      const claim = stored.claim ?? newClaim();
      if (!stored.claim) update(c, { claim });
      attach({
        ws: new WebSocket(relaySocketUrl(stored.r, stored.c, 'wallet', undefined, claim)),
        sealer,
        stored: { ...stored, claim },
        resumed: true,
      });
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
  if (stored) void flushRevocations([keyOf(stored)]);
}

/**
 * Start pairing from a scanned QR. Resolves with what the confirm screen needs; the session is
 * stored only when the user taps Connect.
 */
export function beginPairing(scanned: string, opts: { allowCli?: boolean } = {}): Promise<PendingPair> {
  let link: PairLink;
  try {
    link = parsePairUrl(scanned, undefined, { allowLocalRelay: ALLOW_LOCAL_RELAY });
  } catch (e) {
    return Promise.reject(e);
  }
  // b-Aware 25 Oct 2026: the CLI origin is only a claim (any program can send that Origin header to the relay), so
  // a link that says "CLI" proves nothing. A CLI pairing is accepted only from the screens where the owner chose to
  // pair the CLI themselves (Agents, Settings), never from the general scanner or a link that opened the app.
  if (link.o === CLI_ORIGIN && !opts.allowCli) return Promise.reject(new Error(CLI_ONLY_FROM_SETTINGS));
  const P = PrivateKey.fromRandom();
  const claim = newClaim();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relaySocketUrl(link.r, link.c, 'wallet', undefined, claim));
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
      // The relay's origin is only a header; the host is shown plainly only when the site proves it (B3).
      const proven = !!link.s && f.verifiedOrigin !== CLI_ORIGIN && (await verifyPairProof(link));
      // A new pairing starts with nothing. Its key names its own channel, so it never shares another pairing's grants
      // (b-Aware 24 Oct 2026); still withdraw anything left under that key unless this channel is being resumed.
      if (!load().some((s) => s.c === link.c)) await flushRevocations([pairedOrigin(f.verifiedOrigin, link.c)]);
      if (settled) return;
      settled = true;
      ws.onclose = null;
      ws.onerror = null;
      resolve({
        origin: f.verifiedOrigin,
        code,
        cli: f.verifiedOrigin === CLI_ORIGIN && !!opts.allowCli,
        proven,
        confirm: (agent?: AgentGrant) => {
          if (f.verifiedOrigin === CLI_ORIGIN && (!agent || !opts.allowCli)) return ws.close(); // a CLI must be bound to an agent account
          if (agent && f.verifiedOrigin !== CLI_ORIGIN) return ws.close(); // only a CLI pairing carries an agent grant
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
            claim,
            ...(proven && { proven: true }),
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

/**
 * After the phone sleeps, iOS can hand back a socket that still says OPEN but is dead, so connect() kept it and the
 * site's calls went nowhere (owner, 25 Oct 2026). Back from more than WAKE_MS in the background: replace every live
 * socket with a fresh one. Same session, same key and counters, same grants; nothing is re-approved.
 */
export const WAKE_MS = 5_000;
let hiddenAt: number | undefined;
const replaceAfterWake = () => {
  for (const [c, l] of [...live]) {
    if (l.retry) clearTimeout(l.retry);
    live.delete(c);
    l.ws.onclose = null;
    l.ws.onmessage = null;
    try {
      l.ws.close();
    } catch {
      /* already gone */
    }
  }
  reconnectAll();
};
/** The foreground/background handler initPairing installs (exported for tests). */
export const onPairVisibility = () => {
  if (document.visibilityState !== 'visible') {
    hiddenAt = Date.now();
    return;
  }
  const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
  hiddenAt = undefined;
  if (away > WAKE_MS) replaceAfterWake();
  else reconnectAll();
};
/** Reconnect every paired site; again whenever the app comes back to the foreground. */
export function initPairing() {
  if (started) return;
  started = true;
  sweepBareHostGrants();
  sweepHostPairedKeys();
  void flushRevocations();
  reconnectAll();
  mirrorSessions(load()); // pairings saved before the mirror existed reach the background too
  document.addEventListener('visibilitychange', onPairVisibility);
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
  mirrorSessions([]);
  emit();
}
