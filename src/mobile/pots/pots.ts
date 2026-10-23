/**
 * Pots and standing orders (docs/POTS-SUBSCRIPTIONS-PLAN.md, v1). A pot is an agent account
 * (agents/agentAccounts.ts) flagged kind 'pot': its own seed and balance, Stop/Resume, a daily cap and the
 * activity log. The pot balance is the most a standing order can ever take. A subscription is a rule stored
 * on a pot (payee, amount, period, start, max count); v1 pays on app open (payDue.ts).
 *
 * Pure helpers + localStorage in the agentAccounts style; nothing here signs.
 */
import {
  appendAgentLog,
  getAgentAccount,
  isPotAccount,
  markAgentAccount,
  setAgentDailyCap,
} from '../agents/agentAccounts';
import { PNEE_POTS_ENABLED, SUBSCRIPTIONS_ENABLED } from '../storeBuild';
import type { RemoteConfig } from '../config/remoteConfig';

export type Pot = {
  /** = AgentAccount.identityAddress: a pot IS an agent account. */
  identityAddress: string;
  name: string;
  emoji?: string;
  unit: 'BSV' | 'PNEE';
  createdAt: number;
};

export type Period = 'day' | 'week' | 'month' | 'year' | { seconds: number };
export type Currency = 'USD' | 'SAT' | 'PNEE';
export type SubStatus = 'active' | 'paused' | 'cancelled' | 'ended' | 'lowFunds';

export type Payee = {
  address?: string;
  paymail?: string;
  name: string;
  /** Requesting app (v2 Subscribe requests). */
  origin?: string;
  /** The merchant identity key that signed the request (docs/SUBSCRIBE-API.md › Signing). */
  merchantKey?: string;
  /** One of ownServicePayees() (bChat, $b agent). Absent = a person / paymail standing order. */
  service?: string;
  /**
   * The paymail's identity key when the order was set up (or first verified, for older orders). Automatic payments
   * only go to this key; a different one flags the order for review (payeeBinding.ts).
   */
  pinnedKey?: string;
};

export type Subscription = {
  id: string;
  potId: string;
  payee: Payee;
  amount: { value: number; currency: Currency };
  period: Period;
  start: number;
  maxCount: number | null;
  paidCount: number;
  /** Periods used up, paid or skipped (a pause skips the periods it covers). nextDue = dueAt(periodIndex). */
  periodIndex: number;
  nextDue: number;
  status: SubStatus;
  mode: 'onOpen' | 'presigned';
  requestId?: string;
  billing?: boolean;
  /** Service reference put in an OP_RETURN of each payment (subscribeLink.ts), e.g. bChatX Plus. */
  memo?: string;
  lastError?: string;
  /**
   * 'latest' (app subscriptions, appSubscribe.ts): missed periods never stack up. A missed payment is paid once on
   * the next open and the older periods are skipped. Absent = the standing-order catch-up (up to MAX_CATCH_UP).
   */
  catchUp?: 'latest';
  /** What the app said it is for (app subscriptions). */
  description?: string;
  /** The last payment that went through: the receipt the Subscriptions list and status call show. */
  lastReceipt?: { at: number; txid: string; usd: number; sats: number };
  /** When the user cancelled. A tombstone: once set, no write can move this order out of 'cancelled'. */
  cancelledAt?: number;
  /**
   * The payee's destination failed verification (changed key, bad binding): nothing is paid until the user
   * confirms the new destination (confirmPayeeReview).
   */
  needsReview?: { reason: string; at: number; servedKey?: string };
};

const POTS = 'bwallet.pots';
const SUBS = 'bwallet.subs';
const PENDING = 'bwallet.pots.pending';
const EVENT = 'bwallet:pots';
/** Missed payments caught up on open without asking; more needs a confirm. */
export const MAX_CATCH_UP = 3;

/**
 * Our own services a bWalletX subscription may pay (v1 allowlist). Data only behind SUBSCRIPTIONS_ENABLED, so a
 * store build has none. They pay bCorp's fee address (a build-time define); with none configured there are none.
 */
declare const __MARKET_FEE_ADDRESS__: string | undefined;
// Read when asked, not at module load, so the answer never depends on import order (tests set the define late).
const bcorpAddress = () => (typeof __MARKET_FEE_ADDRESS__ === 'string' ? __MARKET_FEE_ADDRESS__.trim() : '');
export type ServicePayee = { service: string; name: string; address: string };
export const ownServicePayees = (): readonly ServicePayee[] =>
  SUBSCRIPTIONS_ENABLED
    ? [
        { service: 'bchat', name: 'bChat', address: bcorpAddress() },
        { service: 'b-agent', name: '$b agent', address: bcorpAddress() },
        // Back bWalletX (pots/fund.ts): monthly support for development, memo bwalletx-fund:<hash160>.
        { service: 'bwalletx-fund', name: 'bWalletX development fund', address: bcorpAddress() },
      ].filter((p) => p.address)
    : [];
export const servicePayee = (service?: string) => ownServicePayees().find((p) => p.service === service) ?? null;

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const onPotsChange = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

// ── Period math ────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * The k-th due time after `start` (k = 0 is start itself). Always computed from start, never chained, so a
 * monthly order started on the 31st pays on the 31st, or the last day of shorter months (Feb 28/29, Apr 30),
 * and goes back to the 31st after. Calendar periods are in UTC, so local DST shifts never move a payment.
 */
export const dueAt = (start: number, period: Period, k: number): number => {
  if (typeof period === 'object') return start + k * Math.max(1, Math.floor(period.seconds)) * 1000;
  if (period === 'day') return start + k * DAY_MS;
  if (period === 'week') return start + k * 7 * DAY_MS;
  const d = new Date(start);
  const months = period === 'month' ? k : 12 * k;
  const total = d.getUTCMonth() + months;
  const y = d.getUTCFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysIn(y, m));
  return Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
};

const finished = (s: Pick<Subscription, 'maxCount' | 'periodIndex'>, k = s.periodIndex) =>
  s.maxCount !== null && k >= s.maxCount;

/** The next due time, or null once maxCount periods are used up. */
export const nextDue = (s: Pick<Subscription, 'start' | 'period' | 'maxCount' | 'periodIndex'>): number | null =>
  finished(s) ? null : dueAt(s.start, s.period, s.periodIndex);

export type DuePlan = {
  /** Due times to pay now, oldest first (at most `cap`). */
  due: number[];
  /** How many are due in all. */
  missed: number;
  /** More than `cap` are due: ask before paying the rest. */
  needsConfirm: boolean;
};

/** What an active subscription owes at `now`: each due time not yet paid, capped at `cap` (default 3). */
export const dueItems = (s: Subscription, now: number, cap = MAX_CATCH_UP): DuePlan => {
  if (s.status !== 'active' && s.status !== 'lowFunds') return { due: [], missed: 0, needsConfirm: false };
  const all: number[] = [];
  for (let k = s.periodIndex; !finished(s, k); k++) {
    const t = dueAt(s.start, s.period, k);
    if (t > now) break;
    all.push(t);
    if (all.length > 1000) break; // a bad record can't loop forever
  }
  return { due: all.slice(0, Math.max(0, cap)), missed: all.length, needsConfirm: all.length > cap };
};

// ── Amounts and funds ──────────────────────────────────────────────────────────────────────────────────────

/** One payment in sats at `bsvUsd` dollars per BSV. null when it can't be priced (no rate, or a PNEE order). */
export const amountSats = (amount: Subscription['amount'], bsvUsd: number): number | null => {
  if (!(amount.value > 0)) return null;
  if (amount.currency === 'SAT') return Math.round(amount.value);
  if (amount.currency === 'USD') return bsvUsd > 0 ? Math.max(1, Math.round((amount.value / bsvUsd) * 1e8)) : null;
  return null;
};

/** One payment in PNEE units (1 unit = 1¢). null unless it is a whole, positive PNEE amount. */
export const amountPnee = (amount: Subscription['amount']): number | null =>
  amount.currency === 'PNEE' && Number.isInteger(amount.value) && amount.value > 0 ? amount.value : null;

/** Dollars typed for a PNEE pot, as whole PNEE units (cents). */
export const usdToPnee = (usd: number) => Math.round(usd * 100);

/** The amount a pot's orders are kept in: PNEE pots pay PNEEs, BSV pots pay dollars (or sats) in BSV. */
export const potCurrencyOk = (unit: Pot['unit'], currency: Currency) =>
  !PNEE_POTS_ENABLED && (unit === 'PNEE' || currency === 'PNEE')
    ? false
    : unit === 'PNEE'
      ? currency === 'PNEE'
      : currency !== 'PNEE';

/** One payment in dollars (for the spend gate and log). */
export const amountUsd = (amount: Subscription['amount'], bsvUsd: number): number => {
  if (amount.currency === 'USD') return amount.value;
  if (amount.currency === 'SAT') return bsvUsd > 0 ? (amount.value / 1e8) * bsvUsd : 0;
  return amount.value / 100; // PNEE: 1 unit = 1¢
};

/**
 * How many upcoming payments `balanceSats` covers across a pot's live subscriptions, paying them in due order.
 * Stops counting at `limit`.
 */
export const potCovers = (subs: Subscription[], balanceSats: number, bsvUsd: number, limit = 99): number =>
  coversIn(subs, balanceSats, (s) => amountSats(s.amount, bsvUsd), limit);

/** potCovers for a PNEE pot: `balanceUnits` PNEEs against its PNEE orders. */
export const potCoversPnee = (subs: Subscription[], balanceUnits: number, limit = 99): number =>
  coversIn(subs, balanceUnits, (s) => amountPnee(s.amount), limit);

const coversIn = (
  subs: Subscription[],
  balanceSats: number,
  cost: (s: Subscription) => number | null,
  limit: number,
): number => {
  const live = subs
    .filter((s) => s.status === 'active' || s.status === 'lowFunds')
    .map((s) => ({ s, k: s.periodIndex, sats: cost(s) }))
    .filter((x): x is { s: Subscription; k: number; sats: number } => x.sats !== null && !finished(x.s));
  if (!live.length) return limit;
  let left = balanceSats;
  let n = 0;
  while (n < limit) {
    let pick: (typeof live)[number] | null = null;
    let at = Infinity;
    for (const x of live) {
      if (finished(x.s, x.k)) continue;
      const t = dueAt(x.s.start, x.s.period, x.k);
      if (t < at) {
        at = t;
        pick = x;
      }
    }
    if (!pick || pick.sats > left) break;
    left -= pick.sats;
    pick.k++;
    n++;
  }
  return n;
};

/** Low funds: the pot covers fewer than 2 upcoming payments. */
export const isLowFunds = (covers: number) => covers < 2;

/**
 * Default pot daily cap (plan §1: largest payment + 10%), times the catch-up allowance, so a missed-period
 * catch-up still fits while a buggy loop can't drain the pot in a day.
 */
export const defaultDailyCap = (subs: Subscription[], bsvUsd: number): number | null => {
  const amounts = subs
    .filter((s) => s.status !== 'cancelled' && s.status !== 'ended')
    .map((s) => amountUsd(s.amount, bsvUsd));
  const max = Math.max(0, ...amounts);
  return max > 0 ? Math.round(max * MAX_CATCH_UP * 110) / 100 : null;
};

// ── Billing gate (OFF) ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Creating new third-party subscriptions: `!billing.enabled || active billing sub || grace || grandfathered`.
 * Billing is off, so this is always true today. Never gates pause, cancel or withdraw.
 */
export const subscriptionsUnlocked = (
  cfg: Pick<RemoteConfig, 'billing'>,
  st: { hasActiveBillingSub: boolean; firstUseAt: number | null; walletCreatedAt: number | null },
  now = Date.now(),
): boolean => {
  const b = cfg.billing;
  if (!b.enabled) return true;
  if (st.hasActiveBillingSub) return true;
  if (b.freeBefore && now < Date.parse(b.freeBefore)) return true;
  if (st.firstUseAt !== null && now < st.firstUseAt + b.graceDays * DAY_MS) return true;
  const g = b.grandfatherCreatedBefore ? Date.parse(b.grandfatherCreatedBefore) : NaN;
  if (st.walletCreatedAt !== null && Number.isFinite(g) && st.walletCreatedAt < g) return true;
  return false;
};

// ── Store ───────────────────────────────────────────────────────────────────────────────────────────────────

export const listPots = (): Pot[] => Object.values(read<Record<string, Pot>>(POTS, {}));
export const getPot = (id?: string | null): Pot | null =>
  id ? (read<Record<string, Pot>>(POTS, {})[id] ?? null) : null;
/**
 * Owner rule (18 Oct 2026): subscriptions pay from a pot ONLY, never the main balance. A pot is in the pots registry
 * AND is an agent account of kind 'pot'; the main account is neither, so no path can sign from it.
 */
export const isPayingPot = (id?: string | null): boolean => !!getPot(id) && isPotAccount(getAgentAccount(id));
export const listSubs = (potId?: string): Subscription[] =>
  Object.values(read<Record<string, Subscription>>(SUBS, {})).filter((s) => !potId || s.potId === potId);
export const getSub = (id: string): Subscription | null => read<Record<string, Subscription>>(SUBS, {})[id] ?? null;

const savePot = (p: Pot) => write(POTS, { ...read<Record<string, Pot>>(POTS, {}), [p.identityAddress]: p });
/**
 * Write a subscription. The user's Pause and Cancel win over any stale copy: a cancelled order stays cancelled
 * (and keeps its cancelledAt), and a paused one goes back to active/lowFunds only through resumeSub
 * (`resume: true`). So a payment run that read the order before the user tapped can never undo the tap.
 */
export const saveSub = (s: Subscription, opts: { resume?: boolean } = {}) => {
  const all = read<Record<string, Subscription>>(SUBS, {});
  const stored = all[s.id];
  let w = s;
  if (stored && (stored.status === 'cancelled' || stored.cancelledAt !== undefined)) {
    w = { ...s, status: 'cancelled', cancelledAt: stored.cancelledAt ?? s.cancelledAt };
  } else if (stored?.status === 'paused' && (s.status === 'active' || s.status === 'lowFunds') && !opts.resume) {
    w = { ...s, status: 'paused' };
  }
  const next = { ...w, nextDue: nextDue(w) ?? w.nextDue };
  write(SUBS, { ...all, [s.id]: next });
  return next;
};

/**
 * A signed standing-order payment that may or may not have reached the network. Written BEFORE broadcasting,
 * so a crash between broadcast and saveSub can't lead to a second, fresh tx for the same periods: the next run
 * rebroadcasts this exact tx (idempotent: same txid) and marks these periods paid.
 */
export type PendingPayment = {
  subId: string;
  potId: string;
  /** sub.periodIndex when signed; the payment covers periodIndex .. periodIndex + count - 1. */
  periodIndex: number;
  count: number;
  dueTimes: number[];
  rawTx: string;
  txid: string;
  usd: number;
  /** Total sats paid (absent on records written before receipts). */
  sats?: number;
  at: number;
  /** 'PNEE': rawTx is a BEEF hex of a PNEE transfer, broadcast with broadcastPnee. Absent = a BSV payment. */
  unit?: 'PNEE';
};
export const getPending = (subId: string): PendingPayment | null =>
  read<Record<string, PendingPayment>>(PENDING, {})[subId] ?? null;
export const savePending = (p: PendingPayment) =>
  write(PENDING, { ...read<Record<string, PendingPayment>>(PENDING, {}), [p.subId]: p });
export const clearPending = (subId: string) => {
  const all = read<Record<string, PendingPayment>>(PENDING, {});
  delete all[subId];
  write(PENDING, all);
};

/** Turn a freshly created account into a pot (agent account kind 'pot' + the pot record). */
export const makePot = (identityAddress: string, name: string, emoji?: string, now = Date.now()): Pot => {
  if (!getAgentAccount(identityAddress)) markAgentAccount(identityAddress, [], now, { kind: 'pot' });
  const p: Pot = { identityAddress, name: name.trim().slice(0, 32) || 'Pot', emoji, unit: 'BSV', createdAt: now };
  savePot(p);
  return p;
};

/**
 * Hold BSV or PNEEs. Only while nothing live pays from the pot, so an order is never paid in a unit it wasn't set
 * up in. Returns whether it changed.
 */
export const setPotUnit = (id: string, unit: Pot['unit']): boolean => {
  if (!PNEE_POTS_ENABLED) return false;
  const p = getPot(id);
  if (!p || p.unit === unit) return false;
  if (listSubs(id).some((s) => s.status !== 'cancelled' && s.status !== 'ended')) return false;
  savePot({ ...p, unit });
  return true;
};

export const renamePot = (id: string, name: string) => {
  const p = getPot(id);
  if (p) savePot({ ...p, name: name.trim().slice(0, 32) || p.name });
};

const uuid = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
};

export type NewSub = Pick<Subscription, 'potId' | 'payee' | 'amount' | 'period' | 'start' | 'maxCount'> &
  Partial<Pick<Subscription, 'memo' | 'catchUp' | 'description' | 'requestId'>>;

/** A payment memo: only on a service subscription, `<name>:<hex>`, one short OP_RETURN push. */
export const SUB_MEMO_RE = /^[a-z][a-z0-9-]{1,23}:[0-9a-f]{8,64}$/;
export const subMemoProblem = (payee: Payee, memo: string | undefined): string | null =>
  memo === undefined || (payee.service && SUB_MEMO_RE.test(memo)) ? null : 'That subscription reference isn’t valid';

/** Problems with a new standing order, or null. Service payees only when subscriptions are enabled. */
export const subProblem = (n: NewSub, subsOn = SUBSCRIPTIONS_ENABLED): string | null => {
  if (!isPayingPot(n.potId)) return 'Pick a pot';
  if (n.payee.service) {
    if (!subsOn || !servicePayee(n.payee.service)) return 'That service isn’t available';
  } else if (!n.payee.address && !n.payee.paymail) return 'Enter who to pay';
  if (!(n.amount.value > 0) || !Number.isFinite(n.amount.value)) return 'Enter an amount';
  const pot = getPot(n.potId)!;
  if (!potCurrencyOk(pot.unit, n.amount.currency))
    return PNEE_POTS_ENABLED
      ? pot.unit === 'PNEE'
        ? 'This pot pays in PNEEs'
        : 'PNEE orders need a PNEE pot'
      : 'That amount isn’t available';
  if (n.amount.currency === 'PNEE' && amountPnee(n.amount) === null) return 'Enter a whole number of cents';
  if (n.maxCount !== null && !(Number.isInteger(n.maxCount) && n.maxCount > 0 && n.maxCount <= 1000))
    return 'Number of payments must be 1–1000';
  if (typeof n.period === 'object' && !(n.period.seconds >= 3600)) return 'The period must be at least an hour';
  if (!Number.isFinite(n.start)) return 'Pick a start date';
  return subMemoProblem(n.payee, n.memo);
};

export const addSubscription = (n: NewSub, bsvUsd: number, now = Date.now()): Subscription => {
  const problem = subProblem(n);
  if (problem) throw new Error(problem);
  const s = saveSub({
    ...n,
    id: uuid(),
    paidCount: 0,
    periodIndex: 0,
    nextDue: n.start,
    status: 'active',
    mode: 'onOpen',
  });
  const a = getAgentAccount(n.potId);
  if (a && a.dailyCapUsd === null) setAgentDailyCap(n.potId, defaultDailyCap(listSubs(n.potId), bsvUsd));
  appendAgentLog(n.potId, { at: now, action: 'sub-create', detail: `Subscription to ${n.payee.name}`, usd: 0 });
  return s;
};

/** Pause: one tap, no confirm. Payments stop until resumed. */
export const pauseSub = (id: string, now = Date.now()) => {
  const s = getSub(id);
  if (!s || (s.status !== 'active' && s.status !== 'lowFunds')) return;
  saveSub({ ...s, status: 'paused' });
  appendAgentLog(s.potId, { at: now, action: 'sub-pause', detail: `Paused ${s.payee.name}`, usd: 0 });
};

/** The period index to resume at: the first period due after `now` (periods while paused are skipped). */
export const resumeIndex = (s: Subscription, now: number) => {
  let k = s.periodIndex;
  while (!finished(s, k) && dueAt(s.start, s.period, k) <= now && k - s.periodIndex < 100_000) k++;
  return k;
};

export const resumeSub = (id: string, now = Date.now()) => {
  const s = getSub(id);
  if (!s || s.status !== 'paused') return;
  const periodIndex = resumeIndex(s, now);
  saveSub(
    { ...s, periodIndex, status: finished(s, periodIndex) ? 'ended' : 'active', lastError: undefined },
    { resume: true },
  );
  appendAgentLog(s.potId, { at: now, action: 'sub-resume', detail: `Resumed ${s.payee.name}`, usd: 0 });
};

/** The user checked and accepted the payee's current destination: pin its key and let payments go again. */
export const confirmPayeeReview = (id: string, key: string | undefined, now = Date.now()) => {
  const s = getSub(id);
  if (!s) return;
  saveSub({ ...s, payee: { ...s.payee, pinnedKey: key }, needsReview: undefined, lastError: undefined });
  appendAgentLog(s.potId, {
    at: now,
    action: 'sub-review',
    detail: `Confirmed new destination for ${s.payee.name}`,
    usd: 0,
  });
};

export const cancelSub = (id: string, now = Date.now()) => {
  const s = getSub(id);
  if (!s || s.status === 'cancelled') return;
  saveSub({ ...s, status: 'cancelled', cancelledAt: now });
  appendAgentLog(s.potId, { at: now, action: 'sub-cancel', detail: `Cancelled ${s.payee.name}`, usd: 0 });
};

/** After a payment of `count` periods: advance, and end the order once maxCount is reached. */
export const advanced = (s: Subscription, count: number): Subscription => {
  const periodIndex = s.periodIndex + count;
  const paidCount = s.paidCount + count;
  const done = s.maxCount !== null && periodIndex >= s.maxCount;
  return { ...s, periodIndex, paidCount, status: done ? 'ended' : 'active', lastError: undefined };
};

export const formatPeriod = (p: Period) =>
  typeof p === 'object'
    ? `every ${Math.round(p.seconds / 3600)}h`
    : ({ day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' } as const)[p];

export const formatAmount = (a: Subscription['amount']) =>
  a.currency === 'USD'
    ? `$${a.value.toFixed(2)}`
    : a.currency === 'SAT'
      ? `${a.value.toLocaleString()} sats`
      : PNEE_POTS_ENABLED
        ? `$${(a.value / 100).toFixed(2)} in PNEEs`
        : `$${(a.value / 100).toFixed(2)}`;

// ── Pots & Locks › Subscriptions (owner, 10 Oct 2026) ──────────────────────────────────────────────────────

const liveSub = (s: Subscription) => s.status === 'active' || s.status === 'lowFunds';

/** Pays from: move a subscription to another pot. Its schedule and approval stay the same. */
export const moveSub = (id: string, potId: string, now = Date.now()) => {
  const s = getSub(id);
  const to = getPot(potId);
  if (!s || s.potId === potId || !to || !potCurrencyOk(to.unit, s.amount.currency)) return;
  saveSub({ ...s, potId, lastError: undefined });
  appendAgentLog(potId, { at: now, action: 'sub-move', detail: `${s.payee.name} now pays from here`, usd: 0 });
};

/** Pause all: every live subscription; returns how many were paused. */
export const pauseAllSubs = (now = Date.now()) => {
  const live = listSubs().filter(liveSub);
  live.forEach((s) => pauseSub(s.id, now));
  return live.length;
};

/** Resume all paused subscriptions; returns how many. */
export const resumeAllSubs = (now = Date.now()) => {
  const paused = listSubs().filter((s) => s.status === 'paused');
  paused.forEach((s) => resumeSub(s.id, now));
  return paused.length;
};

const PER_MONTH: Record<'day' | 'week' | 'month' | 'year', number> = {
  day: 30.44,
  week: 30.44 / 7,
  month: 1,
  year: 1 / 12,
};

/** What the live subscriptions cost per month, in dollars at `bsvUsd`. */
export const monthlyUsd = (subs: Subscription[], bsvUsd: number) =>
  Math.round(
    subs.filter(liveSub).reduce((a, s) => {
      const per = typeof s.period === 'object' ? (30.44 * 86_400) / Math.max(1, s.period.seconds) : PER_MONTH[s.period];
      return a + amountUsd(s.amount, bsvUsd) * per;
    }, 0) * 100,
  ) / 100;
