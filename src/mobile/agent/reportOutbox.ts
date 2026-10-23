/**
 * The report outbox (owner, 17 Oct 2026: "never just vanish"). A report to b that can't be sent right now
 * (offline, not signed in to bChatX, bit-sign down) is kept on this device and sent later: on app resume,
 * when the network comes back, after sign-in, and on a backoff timer. "Your reports" lists it as Waiting to send.
 *
 * Per-device UI state in localStorage, one list per wallet account, small cap. Holds no keys: every report is
 * run through redactSecrets (errorReport.ts) here, so typed Ask b messages are covered too.
 */
import { redactSecrets } from '../errors/errorReport';
import { reportToB, type ReportResult } from './paid';
import { isNetworkError, OFFLINE_TEXT } from '../../utils/offline';

export type OutboxReason = 'offline' | 'signin' | 'error';

export type QueuedReport = {
  id: string;
  /** Wallet identity address it was written in, or DEVICE when no account was open (boot errors). */
  account: string;
  text: string;
  at: number;
  tries: number;
  /** Not retried automatically before this time (backoff). */
  nextAt: number;
  reason: OutboxReason;
};

type Call = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>;
type Store = Pick<Storage, 'getItem' | 'setItem'>;

const KEY = 'bwallet.agent.reportOutbox';
/** Reports written before any account was open: sent by whichever account is open next. */
export const DEVICE = '*';
/** Per account. The oldest is dropped past this (a crash loop must not fill storage). */
export const OUTBOX_CAP = 20;
const MAX_TEXT = 4000;
export const OUTBOX_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** 30 s, 1 min, 2 min … capped at 1 hour. */
export const backoffMs = (tries: number) => Math.min(30_000 * 2 ** Math.max(0, tries - 1), 60 * 60_000);

const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const parseItem = (v: unknown, now: number): QueuedReport | null => {
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!r || typeof r.id !== 'string' || typeof r.account !== 'string' || !r.account) return null;
  if (typeof r.text !== 'string' || !r.text || typeof r.at !== 'number' || now - r.at > OUTBOX_MAX_AGE_MS) return null;
  const reason: OutboxReason = r.reason === 'offline' || r.reason === 'signin' ? r.reason : 'error';
  return {
    id: r.id,
    account: r.account,
    // Scrubbed again on read: items queued by older builds (weaker redaction) are cleaned before display or send.
    text: redactSecrets(r.text).slice(0, MAX_TEXT),
    at: r.at,
    tries: typeof r.tries === 'number' ? r.tries : 0,
    nextAt: typeof r.nextAt === 'number' ? r.nextAt : 0,
    reason,
  };
};

export const readOutbox = (store: Store | null = defaultStore(), now = Date.now()): QueuedReport[] => {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.flatMap((v) => parseItem(v, now) ?? []) : [];
  } catch {
    return [];
  }
};

const listeners = new Set<() => void>();
/** Called whenever the outbox changes (Your reports and the error card re-read it). */
export const onOutboxChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

const writeOutbox = (items: QueuedReport[], store: Store | null) => {
  try {
    store?.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage full / private mode: nothing more we can keep */
  }
  listeners.forEach((fn) => fn());
};

/** Reports waiting to send for this account (plus any written before an account was open), oldest first. */
export const queuedFor = (account: string | null | undefined, store = defaultStore(), now = Date.now()) =>
  readOutbox(store, now).filter((r) => r.account === DEVICE || r.account === account);

/** Keep a report that couldn't be sent. Returns the queued item. */
export const enqueueReport = (
  account: string | null | undefined,
  text: string,
  reason: OutboxReason,
  store = defaultStore(),
  now = Date.now(),
): QueuedReport => {
  const item: QueuedReport = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    account: account || DEVICE,
    text: redactSecrets(text).slice(0, MAX_TEXT),
    at: now,
    tries: 1,
    nextAt: now + backoffMs(1),
    reason,
  };
  const all = [...readOutbox(store, now), item];
  // Cap per account: drop that account's oldest.
  const mine = all.filter((r) => r.account === item.account);
  const drop = new Set(mine.slice(0, Math.max(0, mine.length - OUTBOX_CAP)).map((r) => r.id));
  writeOutbox(
    all.filter((r) => !drop.has(r.id)),
    store,
  );
  return item;
};

/** Why a send failed, in the terms the user can act on. */
export const failureReason = (
  e: unknown,
  online = typeof navigator === 'undefined' || navigator.onLine !== false,
): OutboxReason => {
  if (!online) return 'offline';
  const status = e && typeof e === 'object' ? (e as { status?: unknown }).status : undefined;
  if (status === 401 || status === 403) return 'signin';
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (/sign.?in|session|locked/i.test(msg)) return 'signin';
  // No connection: fetch failures on each engine, aborts/timeouts, net::ERR_* (utils/offline). Android can report
  // an unvalidated link as online, so the error itself decides (owner's phone, 19 Oct 2026).
  if (e instanceof TypeError || isNetworkError(e)) return 'offline';
  return 'error';
};

/** Dev-only log of why a report was queued: the reason and the error's message, never the report or keys. */
export const logQueued = (reason: OutboxReason, e: unknown) => {
  let dev = false;
  try {
    dev = !!import.meta.env?.DEV;
  } catch {
    dev = false;
  }
  if (!dev) return;
  const msg = e instanceof Error ? e.message : String(e ?? '');
  console.warn(`[report outbox] queued (${reason}): ${msg.slice(0, 200)}`);
};

export const outboxText = (reason: OutboxReason) =>
  reason === 'signin'
    ? 'Saved. Sign in to send it to b.'
    : reason === 'offline'
      ? `${OFFLINE_TEXT}. Saved on this device; we'll send it to b when you reconnect.`
      : "Saved. We'll send it to b shortly.";

let flushing: Promise<{ sent: number; left: number }> | null = null;

/**
 * Send what's due for this account. `force` ignores the backoff (Retry button, coming back online, sign-in).
 * A failed send stays queued with a longer wait; nothing is ever removed without a reply from bit-sign.
 */
export const flushOutbox = (
  account: string | null | undefined,
  call: Call,
  { force = false, store = defaultStore(), now = () => Date.now(), send = reportToB } = {} as {
    force?: boolean;
    store?: Store | null;
    now?: () => number;
    send?: (call: Call, text: string) => Promise<ReportResult>;
  },
) => {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    for (const item of queuedFor(account, store, now())) {
      if (!force && item.nextAt > now()) continue;
      try {
        await send(call, item.text);
        sent++;
        writeOutbox(
          readOutbox(store, now()).filter((r) => r.id !== item.id),
          store,
        );
      } catch (e) {
        const reason = failureReason(e);
        logQueued(reason, e);
        writeOutbox(
          readOutbox(store, now()).map((r) =>
            r.id === item.id ? { ...r, tries: r.tries + 1, nextAt: now() + backoffMs(r.tries + 1), reason } : r,
          ),
          store,
        );
        // Offline or signed out: the rest would fail the same way.
        if (reason !== 'error') break;
      }
    }
    return { sent, left: queuedFor(account, store, now()).length };
  })().finally(() => {
    flushing = null;
  });
  return flushing;
};
