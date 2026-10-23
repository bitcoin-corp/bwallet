/**
 * Pay-on-open (POTS-SUBSCRIPTIONS-PLAN.md v1). On app open / resume, every active standing order that is due
 * is paid from its pot: through checkAgentSpend (pot Stop, Stop all, daily cap), then one tx per order with
 * one output per period owed. Missed periods catch up to MAX_CATCH_UP at once; more asks first (declining
 * skips the older ones). Pure over its deps, so it is unit-tested without a wallet.
 *
 * Crash safety: each payment is signed, then recorded as pending (sub, periods, raw tx, txid), then broadcast,
 * then the sub is advanced and the pending record cleared. A run that finds a pending record rebroadcasts that
 * same raw tx (idempotent: one txid) and marks its periods paid; it never signs a fresh tx for them.
 */
import { appendAgentLog, checkAgentSpend } from '../agents/agentAccounts';
import { SUBSCRIPTIONS_ENABLED } from '../storeBuild';
import {
  MAX_CATCH_UP,
  advanced,
  amountPnee,
  amountSats,
  amountUsd,
  dueItems,
  formatAmount,
  clearPending,
  getPending,
  getSub,
  isPayingPot,
  listSubs,
  savePending,
  saveSub,
  servicePayee,
  type Payee,
  type PendingPayment,
  type Subscription,
} from './pots';

export type PayDeps = {
  /** Dollars per BSV now (0 = unknown: USD orders wait). */
  bsvUsd: number;
  /** Where to pay this payee (address, or a resolved paymail). */
  resolve: (p: Payee) => Promise<string>;
  /** Sign (don't broadcast) one tx from the pot. */
  sign: (
    potId: string,
    outputs: { address: string; sats: number }[],
    memo?: string,
  ) => Promise<{ rawTx: string; txid: string }>;
  /** Broadcast a signed tx. Must be idempotent: the same raw tx again is fine (already known / mined). */
  broadcast: (rawTx: string) => Promise<void>;
  /**
   * Sign (don't broadcast) one PNEE transfer from a PNEE pot: `units` PNEEs (1 unit = 1¢) per output. Absent = PNEE
   * orders wait. rawTx is what broadcastPnee takes.
   */
  signPnee?: (
    potId: string,
    outputs: { address: string; units: number }[],
    memo?: string,
  ) => Promise<{ rawTx: string; txid: string }>;
  /** Broadcast a signed PNEE transfer (and hand it to the token overlay). Idempotent like broadcast. */
  broadcastPnee?: (rawTx: string) => Promise<void>;
  /** More than MAX_CATCH_UP periods are owed: pay them all? */
  confirm?: (s: Subscription, missed: number) => Promise<boolean>;
  notify?: (title: string, body: string) => void;
  /** Service subscriptions allowed (false in a store build). */
  subsOn?: boolean;
  cap?: number;
};

export type PayOutcome =
  | { id: string; ok: true; count: number; txid: string }
  | { id: string; ok: false; reason: string };

let running: Promise<PayOutcome[]> | null = null;

/** Pay everything due. Concurrent calls share one run, so a quick resume can't pay twice. */
export const payDue = (deps: PayDeps, now = Date.now()): Promise<PayOutcome[]> =>
  (running ??= run(deps, now).finally(() => (running = null)));

/** Still payable right now, by what is in storage (not a snapshot): the user may have paused or cancelled. */
const live = (id: string): Subscription | null => {
  const cur = getSub(id);
  return cur && (cur.status === 'active' || cur.status === 'lowFunds') ? cur : null;
};

/** Patch only the fields this run owns onto a fresh read; never write a snapshot back. */
const patch = (id: string, f: (cur: Subscription) => Partial<Subscription>): Subscription | null => {
  const cur = getSub(id);
  return cur ? saveSub({ ...cur, ...f(cur) }) : null;
};

const fail = (s: Subscription, reason: string, deps: PayDeps, lowFunds = false): PayOutcome => {
  // lastError always; status only moves between active and lowFunds, never out of paused/cancelled/ended.
  patch(s.id, (cur) => ({
    lastError: reason,
    ...(lowFunds && (cur.status === 'active' || cur.status === 'lowFunds') ? { status: 'lowFunds' as const } : {}),
  }));
  deps.notify?.(`Payment to ${s.payee.name} didn’t go through`, reason);
  return { id: s.id, ok: false, reason };
};

async function run(deps: PayDeps, now: number): Promise<PayOutcome[]> {
  const cap = deps.cap ?? MAX_CATCH_UP;
  const subsOn = deps.subsOn ?? SUBSCRIPTIONS_ENABLED;
  const out: PayOutcome[] = [];
  for (const { id } of listSubs()) {
    let s = getSub(id);
    if (!s) continue;
    const pending = getPending(id);
    if (pending) {
      const r = await settlePending(s, pending, deps, now);
      out.push(r);
      if (!r.ok) continue; // still unsettled: never sign anything new for this order
    }
    // Re-read: an earlier order in this run may have taken a while, and the user may have paused or cancelled.
    s = live(id);
    if (!s) continue;
    let plan = dueItems(s, now, cap);
    if (!plan.missed) continue;
    if (s.catchUp === 'latest' && plan.missed > 1) {
      // App subscriptions never stack up: skip every missed period but the latest, then pay that one once.
      const skip = plan.missed - 1;
      s = patch(s.id, (cur) => ({ periodIndex: cur.periodIndex + skip }))!;
      appendAgentLog(s.potId, {
        at: now,
        action: 'sub-skip',
        detail: `Skipped ${skip} missed payment${skip === 1 ? '' : 's'} to ${s.payee.name}`,
        usd: 0,
      });
      plan = dueItems(s, now, 1);
    }
    if (s.payee.service && (!subsOn || !servicePayee(s.payee.service))) {
      out.push(fail(s, 'This service subscription isn’t available in this version', deps));
      continue;
    }
    if (plan.needsConfirm) {
      const all = deps.confirm ? await deps.confirm(s, plan.missed).catch(() => false) : false;
      if (!live(s.id)) continue; // paused or cancelled while we asked
      if (all) plan = dueItems(s, now, plan.missed);
      else {
        // Skip the older periods; pay only the most recent `cap`.
        const skip = plan.missed - cap;
        s = patch(s.id, (cur) => ({ periodIndex: cur.periodIndex + skip }))!;
        appendAgentLog(s.potId, {
          at: now,
          action: 'sub-skip',
          detail: `Skipped ${plan.missed - cap} missed payments to ${s.payee.name}`,
          usd: 0,
        });
        plan = dueItems(s, now, cap);
      }
    }
    const count = plan.due.length;
    const pnee = s.amount.currency === 'PNEE';
    const units = pnee ? amountPnee(s.amount) : null;
    const sats = pnee ? null : amountSats(s.amount, deps.bsvUsd);
    if (pnee && (units === null || !deps.signPnee || !deps.broadcastPnee)) {
      out.push(fail(s, 'PNEE payments can’t be sent from this device', deps));
      continue;
    }
    if (!pnee && sats === null) {
      out.push({ id: s.id, ok: false, reason: 'No price right now' }); // try again next open, no alert
      continue;
    }
    const usd = amountUsd(s.amount, deps.bsvUsd) * count;
    // Pot only, never the main balance: no fallback if the pot is gone or isn't a pot.
    if (!isPayingPot(s.potId)) {
      out.push(fail(s, 'Only a pot can pay. Pick a pot for this subscription.', deps));
      continue;
    }
    const gate = checkAgentSpend(s.potId, usd, now);
    if (!gate.ok) {
      out.push(fail(s, gate.reason, deps));
      continue;
    }
    let address: string;
    try {
      address = await deps.resolve(s.payee);
    } catch (e) {
      out.push(fail(s, e instanceof Error ? e.message : String(e), deps));
      continue;
    }
    // Last look before anything is signed: a Pause or Cancel tapped while resolving stops it here.
    const fresh = live(s.id);
    if (!fresh || fresh.periodIndex !== s.periodIndex) continue;
    let signed: { rawTx: string; txid: string };
    try {
      signed = pnee
        ? await deps.signPnee!(
            s.potId,
            Array.from({ length: count }, () => ({ address, units: units! })),
            s.memo,
          )
        : await deps.sign(
            s.potId,
            Array.from({ length: count }, () => ({ address, sats: sats! })),
            s.memo,
          );
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      out.push(fail(s, m, deps, /not enough|insufficient/i.test(m)));
      continue;
    }
    const p: PendingPayment = {
      subId: s.id,
      potId: s.potId,
      periodIndex: s.periodIndex,
      count,
      dueTimes: plan.due,
      ...signed,
      usd,
      at: now,
      ...(pnee ? { unit: 'PNEE' as const } : { sats: sats! * count }),
    };
    savePending(p); // before the broadcast: from here on these periods are only ever paid by this tx
    out.push(await settlePending(s, p, deps, now));
  }
  return out;
}

/** Broadcast a recorded payment (again, if it may already be out) and, once accepted, mark its periods paid. */
async function settlePending(s: Subscription, p: PendingPayment, deps: PayDeps, now: number): Promise<PayOutcome> {
  try {
    if (p.unit === 'PNEE') {
      if (!deps.broadcastPnee) throw new Error('PNEE payments can’t be sent from this device');
      await deps.broadcastPnee(p.rawTx);
    } else await deps.broadcast(p.rawTx);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!/already|duplicate/i.test(m)) {
      // Unknown outcome: keep the record and retry this exact tx next time.
      patch(s.id, () => ({ lastError: m }));
      deps.notify?.(`Payment to ${s.payee.name} is waiting to go through`, m);
      return { id: s.id, ok: false, reason: m };
    }
  }
  // Already advanced past these periods (crash after saveSub, before clearPending)? Then only clear.
  const cur = getSub(s.id) ?? s;
  if (cur.periodIndex === p.periodIndex) {
    const next = advanced(cur, p.count);
    // The user may have paused or cancelled while this was paying: keep that.
    saveSub({
      ...next,
      status: cur.status === 'paused' || cur.status === 'cancelled' ? cur.status : next.status,
      lastReceipt: { at: now, txid: p.txid, usd: p.usd, sats: p.sats ?? 0 },
    });
    appendAgentLog(s.potId, {
      at: now,
      action: 'sub-pay',
      detail: `Paid ${s.payee.name} ${formatAmount(s.amount)}${p.count > 1 ? ` × ${p.count}` : ''}`,
      usd: p.usd,
      txid: p.txid,
    });
  }
  clearPending(s.id);
  return { id: s.id, ok: true, count: p.count, txid: p.txid };
}
