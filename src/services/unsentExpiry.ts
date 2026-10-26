/**
 * Deadlines for unbroadcast (noSend) payments, so the user's coins are never held forever (BRC-177, owner 26 Oct
 * 2026).
 *
 * A noSend transaction is signed and handed to someone else to broadcast (bit-sign for room messages, our server for
 * theme orders and names, a bMail recipient, a site's own chain). Until it is broadcast its inputs are reserved: the
 * wallet won't spend them, and its change only exists if the network gets the transaction. If nobody ever broadcasts
 * it, that money is stuck.
 *
 * BRC-177 bounds this with a deadline per action (label `p nosend expiry seconds|timestamp|blockheight <n>` or
 * `never`) and, at the deadline, a reclaim. Its full form prefunds a dedicated anchor output and pre-signs a reclaim
 * spending it; the toolbox we run does not do that (it refuses change outputs as explicit inputs), so this is the
 * closest safe equivalent, run from the wallet's own list of nosend actions:
 *
 *  1. Every nosend action gets a deadline: its BRC-177 label if it has a valid one, else DEFAULT_TTL_S (24 h) from
 *     the first time this wallet saw it. `never` is never reclaimed. Deadlines are persisted and never restart.
 *  2. At the deadline, nothing is released unless the chain says, conclusively, that the original was not
 *     broadcast. The rules of services/unsentGuard.ts are kept and tightened:
 *       - the transaction is seen anywhere (WhatsOnChain or 1Sat) → hand it to the wallet's send path (sendWith), as
 *         settleWhenSeen does; never release;
 *       - any input is spent on chain (by the original or by anything else), its parent is unknown, or any answer is
 *         unclear → keep it, try again on the next run;
 *       - only when every input is cleanly unspent (WhatsOnChain's spent lookup, confirmed or mempool) AND the
 *         transaction is a clean 404 everywhere on every retry for ~30 s (chainSaysUnknown) AND the inputs are
 *         re-checked unspent right before, is the action aborted, which returns its inputs to the wallet.
 *     Inputs that came from another of our own expired noSend transactions count only when that one is released in
 *     the same run; children are released before their parents.
 *  3. A released transaction can still be broadcast by whoever holds it, as long as the wallet has not spent its
 *     inputs yet (BRC-177 calls this the race at expiry). So each release is watched for WATCH_S (14 days): if the
 *     original shows up on chain, the wallet's own recovery (recoverByTxid: proof attached, outputs set spendable)
 *     is run for it, so its change is not lost.
 *
 * It builds, signs and broadcasts nothing itself. Every decision is logged as a [bwx-expiry] line.
 */
import { chainSaysUnknown, defaultLookups, type ChainLookup, type Sighting } from './unsentGuard';

/** Default deadline for a nosend action without a BRC-177 label: our servers broadcast in seconds; 24 h is ample. */
export const DEFAULT_TTL_S = 24 * 60 * 60;
/** How long a released transaction is watched in case its holder broadcasts it after all. */
export const WATCH_S = 14 * 24 * 60 * 60;
/** Runs at most this often unless forced. */
export const MIN_INTERVAL_MS = 10 * 60_000;

const TXID = /^[0-9a-f]{64}$/i;

// ── BRC-177 labels ──

export type ExpiryPolicy =
  | { mode: 'seconds'; value: number }
  | { mode: 'timestamp'; value: number }
  | { mode: 'blockheight'; value: number }
  | { mode: 'never' }
  | { mode: 'default' };

const LABEL = /^p nosend expiry (seconds|timestamp|blockheight) (0|[1-9][0-9]*)$/;

/**
 * The action's BRC-177 policy. No expiry label = 'default'. A malformed, duplicate or out-of-range label also gives
 * 'default' (with `invalid` set): BRC-177 says to reject those before funding, which is past by now, and a default
 * deadline is safer than none.
 */
export function policyFromLabels(labels: readonly string[] | undefined): ExpiryPolicy & { invalid?: string } {
  const mine = (labels ?? []).filter((l) => l.startsWith('p nosend expiry'));
  if (!mine.length) return { mode: 'default' };
  if (mine.length > 1) return { mode: 'default', invalid: 'duplicate expiry labels' };
  const l = mine[0];
  if (l === 'p nosend expiry never') return { mode: 'never' };
  const m = LABEL.exec(l);
  if (!m) return { mode: 'default', invalid: `malformed label "${l}"` };
  const value = Number(m[2]);
  if (!Number.isSafeInteger(value)) return { mode: 'default', invalid: 'value out of range' };
  const mode = m[1] as 'seconds' | 'timestamp' | 'blockheight';
  if (mode === 'seconds' && value === 0) return { mode: 'default', invalid: 'duration must be > 0' };
  return { mode, value };
}

/** Has the deadline passed? `firstSeenS` is when this wallet first saw the action (the activation it can prove). */
export function isExpired(
  p: ExpiryPolicy,
  firstSeenS: number,
  nowS: number,
  height: number | undefined,
  defaultTtlS = DEFAULT_TTL_S,
): boolean {
  switch (p.mode) {
    case 'never':
      return false;
    case 'seconds':
      return nowS >= firstSeenS + p.value;
    case 'timestamp':
      return nowS >= p.value;
    case 'blockheight':
      return height !== undefined && height >= p.value;
    default:
      return nowS >= firstSeenS + defaultTtlS;
  }
}

// ── chain reads ──

export type SpendState = { state: 'unspent' } | { state: 'spent'; by: string } | { state: 'unclear' };
/** Who spent an outpoint ("txid.vout"), confirmed or mempool. */
export type SpentLookup = (outpoint: string) => Promise<SpendState>;

type F = (url: string, init?: RequestInit) => Promise<Response>;

/** WhatsOnChain /tx/<txid>/<vout>/spent: 404 unspent, 200 {txid} spent (mempool or mined), anything else unclear. */
export const wocSpent =
  (f: F = (u, i) => fetch(u, i)): SpentLookup =>
  async (outpoint) => {
    const [txid, vout] = splitOutpoint(outpoint) ?? [];
    if (!txid) return { state: 'unclear' };
    try {
      const r = await f(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/${vout}/spent`);
      if (r.status === 404) return { state: 'unspent' };
      if (!r.ok) return { state: 'unclear' };
      const j = (await r.json()) as { txid?: unknown };
      return typeof j.txid === 'string' && TXID.test(j.txid)
        ? { state: 'spent', by: j.txid.toLowerCase() }
        : { state: 'unclear' };
    } catch {
      return { state: 'unclear' };
    }
  };

/** "txid.vout" or "txid_vout" → [txid, vout]; undefined when malformed. */
export function splitOutpoint(o: string): [string, number] | undefined {
  const m = /^([0-9a-f]{64})[._](\d{1,6})$/i.exec(o);
  return m ? [m[1].toLowerCase(), Number(m[2])] : undefined;
}

// ── state ──

export type ExpiryState = {
  /** txid → unix seconds this wallet first saw it as nosend. Never reset while the action stays nosend. */
  first: Record<string, number>;
  /** txid → unix seconds it was released (aborted) here; watched for WATCH_S. */
  released: Record<string, number>;
};
export type ExpiryKV = { load: () => Promise<ExpiryState | null>; save: (s: ExpiryState) => Promise<void> };

export const emptyState = (): ExpiryState => ({ first: {}, released: {} });

// ── the run ──

export type NoSendAction = { txid: string; labels?: string[]; inputs?: { sourceOutpoint: string }[] };

export type ExpiryDeps = {
  /** The wallet's nosend actions, with labels and inputs (toolbox listNoSendActions). */
  listNoSend: () => Promise<NoSendAction[]>;
  /** abortAction for one txid: returns its inputs to the wallet. */
  abort: (txid: string) => Promise<unknown>;
  /** The network has it: move it to sent through the wallet's send path (createAction sendWith). */
  sendWith?: (txid: string) => Promise<unknown>;
  /** The wallet's recovery for a txid the chain has (recoverByTxid). */
  recoverLate?: (txid: string) => Promise<unknown>;
  kv: ExpiryKV;
  lookups?: ChainLookup[];
  spent?: SpentLookup;
  height?: () => Promise<number | undefined>;
  nowS?: () => number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  defaultTtlS?: number;
  log?: (m: string) => void;
};

export type KeepReason =
  | 'not-due'
  | 'never'
  | 'no-inputs'
  | 'input-spent-elsewhere'
  | 'input-unclear'
  | 'parent-unknown'
  | 'chain-has-it-or-unclear'
  | 'changed-at-recheck'
  | 'abort-failed';

export type ExpiryReport = {
  checked: number;
  settled: string[];
  released: string[];
  kept: { txid: string; reason: KeepReason }[];
  lateSeen: string[];
  skipped?: 'rate-limited' | 'busy';
};

let lastRunAt = 0;
let running: Promise<ExpiryReport> | undefined;
/** Test hook. */
export function resetExpiryLimit() {
  lastRunAt = 0;
  running = undefined;
}

export async function runUnsentExpiry(deps: ExpiryDeps, opts: { force?: boolean } = {}): Promise<ExpiryReport> {
  const now = Date.now();
  const empty = (skipped: 'rate-limited' | 'busy'): ExpiryReport => ({
    checked: 0,
    settled: [],
    released: [],
    kept: [],
    lateSeen: [],
    skipped,
  });
  if (running) return empty('busy');
  if (!opts.force && lastRunAt && now - lastRunAt < MIN_INTERVAL_MS) return empty('rate-limited');
  lastRunAt = now;
  running = expireOnce(deps);
  try {
    return await running;
  } finally {
    running = undefined;
  }
}

const anySeen = async (txid: string, lookups: ChainLookup[]) => {
  for (const look of lookups) if ((await look(txid).catch((): Sighting => 'unclear')) === 'seen') return true;
  return false;
};

/** One pass (exported for tests; use runUnsentExpiry). Never throws. */
export async function expireOnce(deps: ExpiryDeps): Promise<ExpiryReport> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const lookups = deps.lookups ?? defaultLookups();
  const spent = deps.spent ?? wocSpent();
  const nowS = (deps.nowS ?? (() => Math.floor(Date.now() / 1000)))();
  const report: ExpiryReport = { checked: 0, settled: [], released: [], kept: [], lateSeen: [] };
  const keep = (txid: string, reason: KeepReason) => {
    report.kept.push({ txid, reason });
    if (reason !== 'not-due' && reason !== 'never') log(`[bwx-expiry] ${txid}: kept (${reason})`);
  };

  let state: ExpiryState;
  try {
    state = (await deps.kv.load()) ?? emptyState();
  } catch {
    state = emptyState();
  }
  state.first ??= {};
  state.released ??= {};

  let actions: NoSendAction[] = [];
  try {
    actions = (await deps.listNoSend())
      .filter((a) => TXID.test(a.txid))
      .map((a) => ({ ...a, txid: a.txid.toLowerCase() }));
  } catch (e) {
    log(`[bwx-expiry] could not list nosend actions (${e instanceof Error ? e.message : String(e)})`);
  }
  const listed = new Set(actions.map((a) => a.txid));
  for (const a of actions) state.first[a.txid] ??= nowS;
  // A txid no longer nosend was sent, aborted or failed elsewhere: forget its first-seen time.
  for (const t of Object.keys(state.first)) if (!listed.has(t)) delete state.first[t];

  let height: number | undefined;
  const needsHeight = actions.some((a) => policyFromLabels(a.labels).mode === 'blockheight');
  if (needsHeight && deps.height) height = await deps.height().catch(() => undefined);

  // 1. Which are due, and what the chain says about each due one.
  type Due = { a: NoSendAction; ownParents: Set<string> };
  const due: Due[] = [];
  for (const a of actions) {
    report.checked++;
    const p = policyFromLabels(a.labels);
    if (p.mode === 'never') {
      keep(a.txid, 'never');
      continue;
    }
    if (!isExpired(p, state.first[a.txid], nowS, height, deps.defaultTtlS)) {
      keep(a.txid, 'not-due');
      continue;
    }
    if ((p as { invalid?: string }).invalid)
      log(`[bwx-expiry] ${a.txid}: ${(p as { invalid?: string }).invalid}; using the default deadline`);
    if (await anySeen(a.txid, lookups)) {
      await settle(a.txid);
      continue;
    }
    const ins = (a.inputs ?? []).map((i) => i.sourceOutpoint);
    if (!ins.length || ins.some((o) => !splitOutpoint(o))) {
      keep(a.txid, 'no-inputs');
      continue;
    }
    const verdict = await checkInputs(a.txid, ins, listed);
    if (verdict === 'seen') {
      await settle(a.txid);
      continue;
    }
    if (typeof verdict === 'string') {
      keep(a.txid, verdict);
      continue;
    }
    due.push({ a, ownParents: verdict.ownParents });
  }

  // 2. Inputs from our own nosend parents count only when that parent is released in this run too.
  let changed = true;
  let candidates = due;
  while (changed) {
    const ids = new Set(candidates.map((d) => d.a.txid));
    const next = candidates.filter((d) => [...d.ownParents].every((p) => ids.has(p)));
    changed = next.length !== candidates.length;
    for (const d of candidates) if (!next.includes(d)) keep(d.a.txid, 'parent-unknown');
    candidates = next;
  }

  // 3. The full ~30 s "missing everywhere" check, then a last look at the inputs, then release (children first).
  const cleared: Due[] = [];
  for (const d of candidates) {
    if (!(await chainSaysUnknown(d.a.txid, { lookups, delaysMs: deps.delaysMs, sleep: deps.sleep }))) {
      keep(d.a.txid, 'chain-has-it-or-unclear');
      continue;
    }
    cleared.push(d);
  }
  const clearedIds = new Set(cleared.map((d) => d.a.txid));
  const ordered = orderChildrenFirst(cleared);
  const blocked = new Set<string>();
  for (const d of ordered) {
    const t = d.a.txid;
    // A child that stayed held keeps its parents held too.
    if (blocked.has(t)) {
      keep(t, 'parent-unknown');
      continue;
    }
    const ins = (d.a.inputs ?? []).map((i) => i.sourceOutpoint);
    const again = await checkInputs(t, ins, listed);
    if (again === 'seen') {
      await settle(t);
      for (const p of d.ownParents) blocked.add(p);
      continue;
    }
    if (typeof again === 'string' || [...again.ownParents].some((p) => !clearedIds.has(p))) {
      keep(t, 'changed-at-recheck');
      for (const p of d.ownParents) blocked.add(p);
      continue;
    }
    try {
      await deps.abort(t);
      state.released[t] = nowS;
      delete state.first[t];
      report.released.push(t);
      log(
        `[bwx-expiry] ${t}: deadline passed, inputs unspent on chain and no copy anywhere after retries; released (aborted)`,
      );
    } catch (e) {
      keep(t, 'abort-failed');
      for (const p of d.ownParents) blocked.add(p);
      log(`[bwx-expiry] ${t}: abort refused by the wallet (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // 4. Watch earlier releases: if the original turns up after all, recover its outputs.
  for (const [t, at] of Object.entries(state.released)) {
    if (report.released.includes(t)) continue;
    if (nowS - at > WATCH_S) {
      delete state.released[t];
      continue;
    }
    if (!(await anySeen(t, lookups))) continue;
    report.lateSeen.push(t);
    log(`[bwx-expiry] ${t}: released earlier, but the network has it now; running recovery`);
    try {
      if (deps.recoverLate) {
        await deps.recoverLate(t);
        delete state.released[t];
      }
    } catch (e) {
      log(`[bwx-expiry] ${t}: recovery failed, will retry (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  try {
    await deps.kv.save(state);
  } catch {
    /* next run sees them again as new: deadlines only move later, never earlier */
  }
  return report;

  async function settle(txid: string) {
    report.settled.push(txid);
    if (!deps.sendWith) return log(`[bwx-expiry] ${txid}: on chain; left for the wallet's review (no send path)`);
    try {
      await deps.sendWith(txid);
      log(`[bwx-expiry] ${txid}: on chain; handed to the wallet's send path`);
    } catch (e) {
      log(`[bwx-expiry] ${txid}: on chain but the send path failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /**
   * 'seen' when an input is spent by this very txid; a KeepReason to keep; else the set of our own nosend parents
   * (whose outputs the chain can't know yet). Every other input must be cleanly unspent with a parent the chain has.
   */
  async function checkInputs(
    txid: string,
    ins: string[],
    own: Set<string>,
  ): Promise<'seen' | KeepReason | { ownParents: Set<string> }> {
    const ownParents = new Set<string>();
    for (const o of ins) {
      const [parent] = splitOutpoint(o)!;
      if (own.has(parent) && parent !== txid) {
        ownParents.add(parent);
        continue;
      }
      const s = await spent(o).catch((): SpendState => ({ state: 'unclear' }));
      if (s.state === 'spent') return s.by === txid ? 'seen' : 'input-spent-elsewhere';
      if (s.state !== 'unspent') return 'input-unclear';
      // A 404 from the spent lookup also comes back for an outpoint the chain has never heard of.
      if (!(await anySeen(parent, lookups))) return 'parent-unknown';
    }
    return { ownParents };
  }
}

/** Children (spending another cleared one's output) before their parents. */
function orderChildrenFirst<T extends { a: { txid: string }; ownParents: Set<string> }>(xs: T[]): T[] {
  const out: T[] = [];
  const done = new Set<string>();
  const byId = new Map(xs.map((x) => [x.a.txid, x]));
  const childrenOf = (id: string) => xs.filter((x) => x.ownParents.has(id));
  const visit = (x: T, path: Set<string>) => {
    if (done.has(x.a.txid) || path.has(x.a.txid)) return;
    path.add(x.a.txid);
    for (const c of childrenOf(x.a.txid)) visit(c, path);
    done.add(x.a.txid);
    out.push(x);
  };
  for (const x of xs) visit(x, new Set());
  return out.filter((x) => byId.has(x.a.txid));
}

/**
 * State in chrome.storage.local (the mobile and web builds shim it), else localStorage; one key per identity, so
 * accounts never share deadlines.
 */
export function storageKV(identityKey: string): ExpiryKV {
  const key = `bwx.unsentExpiry.v1.${identityKey.slice(0, 16)}`;
  const local = (globalThis as { chrome?: { storage?: { local?: ChromeLocal } } }).chrome?.storage?.local;
  return {
    load: async () => {
      if (local) return ((await local.get(key))[key] as ExpiryState | undefined) ?? null;
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? (JSON.parse(raw) as ExpiryState) : null;
    },
    save: async (s) => {
      if (local) await local.set({ [key]: s });
      else globalThis.localStorage?.setItem(key, JSON.stringify(s));
    },
  };
}
type ChromeLocal = {
  get: (k: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
};
