/**
 * Automatic check of the default basket's coins against the chain, at unlock (owner's iPhone, 19 Oct 2026: ~$51 of
 * coins spent from another device holding the same seed still showed as balance, found one failed send at a time).
 *
 * Stricter than the manual Resync coins, because nobody asked for it:
 * - Only the default basket. Tokens, locks and OrdLocks are left to Repair Sync's token-aware passes.
 * - A spender counts from the 1sat spend index (batched, 429 backoff; it can name a mempool spend, which the restore
 *   pass below undoes if that spend is dropped) only when WhatsOnChain names the same spender (mainnet; elsewhere the
 *   index alone), or else a CONFIRMED WhatsOnChain spend ("status": "confirmed" on
 *   /tx/<txid>/<vout>/spent, checked 19 Oct 2026), mainnet only. A WhatsOnChain mempool spend never clears a coin.
 * - Never the wallet's own unfinished actions: their txids are not spenders, and coins they spend are skipped.
 * - Every coin cleared is remembered (outpoint → spender); later runs re-check them, and one both lookups now call
 *   unspent is restored to spendable (a mistake can always be undone).
 * - One run at a time (shared lock with the manual Resync), at most once per gap per account, persisted so a worker
 *   restart does not reset it.
 * Any lookup that fails leaves the coin as it is.
 */
import { mapPool, withRetry } from './storageReconcile';
import { withCoinResyncLock } from './coinResyncLock';

const TXID = /^[0-9a-f]{64}$/i;
export const AUTO_SPENDS_BATCH = 100;
const POOL = 4;

export type WocAnswer = { txid: string; confirmed: boolean } | null;

export interface AutoResyncDeps {
  /** Default-basket outputs storage lists as spendable ("txid_vout"). */
  coins: string[];
  /** Coins this wallet cleared earlier (outpoint → spender txid). */
  cleared: Record<string, string>;
  /** Txids of this wallet's unfinished actions (unsigned / nosend / sending / unprocessed / failed). */
  ownPendingTxids: Set<string>;
  /** Outpoints those actions spend. */
  ownPendingInputs: Set<string>;
  /** 1sat index: spender per outpoint (null/undefined = unspent); throws when it can't tell. */
  getSpends: (batch: string[]) => Promise<(string | null | undefined)[]>;
  /** WhatsOnChain (mainnet only; omit elsewhere): null = unspent (404); throws when it can't tell. */
  woc?: (outpoint: string) => Promise<WocAnswer>;
  markSpent: (outpoint: string, spender: string) => Promise<number>;
  markUnspent: (outpoint: string) => Promise<number>;
}

export type AutoResyncReport = {
  checked: number;
  released: number;
  restored: number;
  cleared: Record<string, string>;
};

/** Pure core. Never throws for lookup failures (fail closed per coin). */
export async function autoResyncCoins(d: AutoResyncDeps): Promise<AutoResyncReport> {
  const isSpender = (t: unknown): t is string => typeof t === 'string' && TXID.test(t) && !d.ownPendingTxids.has(t);
  const coins = d.coins.filter((o) => !d.ownPendingInputs.has(o));
  const recheck = Object.keys(d.cleared).filter((o) => !d.ownPendingInputs.has(o));
  const all = [...new Set([...coins, ...recheck])];

  // 1sat index, batched; a batch that fails is unknown (undefined in the map → no verdict).
  const index = new Map<string, string | null>();
  const batches: string[][] = [];
  for (let i = 0; i < all.length; i += AUTO_SPENDS_BATCH) batches.push(all.slice(i, i + AUTO_SPENDS_BATCH));
  await mapPool(batches, POOL, async (b) => {
    try {
      const r = await withRetry(() => d.getSpends(b));
      // A short or malformed reply is unknown, never "unspent": only an explicit null counts as unspent.
      if (!Array.isArray(r) || r.length !== b.length) throw new Error('getSpends: reply does not match the batch');
      b.forEach((o, j) => {
        if (r[j] === null || typeof r[j] === 'string') index.set(o, r[j] as string | null);
      });
    } catch {
      /* unknown */
    }
  });
  const askWoc = async (o: string): Promise<WocAnswer | undefined> => {
    if (!d.woc) return undefined;
    try {
      return await withRetry(() => d.woc!(o));
    } catch {
      return undefined;
    }
  };

  const cleared = { ...d.cleared };
  let released = 0;
  let restored = 0;
  for (const o of coins) {
    if (!index.has(o)) continue;
    let by: string | null = null;
    const ix = index.get(o);
    if (isSpender(ix)) {
      // One source never clears a coin on its own (b-Aware report, 24 Oct 2026): where WhatsOnChain is available
      // (mainnet) it must name the same spender, mempool or confirmed. Unspent or unknown there: leave the coin.
      if (d.woc) {
        const w = await askWoc(o);
        if (w && w.txid.toLowerCase() === ix.toLowerCase()) by = ix;
      } else by = ix;
    } else {
      const w = await askWoc(o);
      if (w && w.confirmed && isSpender(w.txid)) by = w.txid;
    }
    if (!by) continue;
    const n = await d.markSpent(o, by).catch(() => 0);
    if (n > 0) {
      released += n;
      cleared[o] = by;
    }
  }
  // Undo: a coin we cleared that both lookups now call unspent goes back to spendable.
  for (const o of recheck) {
    if (!index.has(o) || index.get(o) !== null) continue;
    if (d.woc) {
      const w = await askWoc(o);
      if (w !== null) continue; // spent, or unknown
    }
    const n = await d.markUnspent(o).catch(() => 0);
    if (n > 0) restored += n;
    delete cleared[o];
  }
  return { checked: coins.length, released, restored, cleared };
}

export const AUTO_RESYNC_KEY = 'bwxAutoCoinResync';
export const AUTO_RESYNC_GAP_MS = 30 * 60 * 1000;

export type AutoResyncState = Record<string, { at?: number; cleared?: Record<string, string> }>;

/** Pure: is a run due for this account (never run, or the last one is older than the gap)? */
export const shouldAutoResync = (lastAt: number | undefined, now: number, gap = AUTO_RESYNC_GAP_MS): boolean =>
  lastAt === undefined || now - lastAt >= gap;

export interface KV {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

/**
 * Run autoResyncCoins for one account if due, under the shared lock, with the throttle and the cleared list
 * persisted in `kv` (chrome.storage.local). Returns null when not due or not ready.
 */
export async function runAutoResyncIfDue(
  identityKey: string,
  kv: KV,
  load: (cleared: Record<string, string>) => Promise<AutoResyncDeps | null>,
  now = Date.now(),
): Promise<AutoResyncReport | null> {
  const read = async () => ((await kv.get(AUTO_RESYNC_KEY))[AUTO_RESYNC_KEY] as AutoResyncState | undefined) ?? {};
  const state = await read();
  if (!shouldAutoResync(state[identityKey]?.at, now)) return null;
  return withCoinResyncLock(async () => {
    const deps = await load(state[identityKey]?.cleared ?? {});
    // Not ready (no services/storage yet): don't start the wait, the next unlock tries again.
    if (!deps) return null;
    // Written before the run, so a crash mid-run still waits the gap.
    await kv.set({ [AUTO_RESYNC_KEY]: { ...(await read()), [identityKey]: { ...state[identityKey], at: now } } });
    const report = await autoResyncCoins(deps);
    const latest = await read();
    await kv.set({
      [AUTO_RESYNC_KEY]: { ...latest, [identityKey]: { ...latest[identityKey], at: now, cleared: report.cleared } },
    });
    return report;
  });
}

/** How long after unlock the automatic check waits, so the first balance read and address sync go first. */
export const AUTO_RESYNC_DELAY_MS = 45_000;
/** Outputs read per storage-lock hold; the lock is released between pages so the balance can read in between. */
export const AUTO_RESYNC_PAGE = 500;

type Row = { txid?: string; vout: number; spendable: boolean; spentBy?: number | null };
/** The few reads the check needs from the active store (a WalletStorageProvider reader). */
export interface AutoResyncReader {
  findUsers: (a: { partial: { identityKey: string } }) => Promise<{ userId: number }[]>;
  findOutputBaskets: (a: { partial: { userId: number; name: string } }) => Promise<{ basketId: number }[]>;
  findOutputs: (a: {
    partial: { userId: number; basketId: number };
    noScript: true;
    paged: { limit: number; offset: number };
  }) => Promise<Row[]>;
  findTransactions: (a: {
    partial: { userId: number };
    status: string[];
    noRawTx: true;
  }) => Promise<{ transactionId: number; txid?: string }[]>;
}

export type AutoResyncRead = {
  userId: number;
  coins: string[];
  ownPendingTxids: Set<string>;
  ownPendingInputs: Set<string>;
};

/**
 * Read the default basket's coins for the check, cheaply: reader locks only (never the storage-provider lock that
 * also blocks writers and sync), no locking scripts, one pass over the basket in pages with the lock released between
 * pages. Null when the device's own store is not active (remote-active web/native before the switch) or the
 * account/basket is not there yet.
 */
export async function readAutoResyncCoins(
  storage: {
    runAsReader: <T>(f: (r: AutoResyncReader) => Promise<T>) => Promise<T>;
    isActiveStorageProvider: () => boolean;
  },
  identityKey: string,
  pendingStatuses: string[],
  page = AUTO_RESYNC_PAGE,
): Promise<AutoResyncRead | null> {
  if (!storage.isActiveStorageProvider()) return null;
  const head = await storage.runAsReader(async (r) => {
    const user = (await r.findUsers({ partial: { identityKey } }))[0];
    if (!user) return null;
    const [basket] = await r.findOutputBaskets({ partial: { userId: user.userId, name: 'default' } });
    if (!basket) return null;
    const pending = await r.findTransactions({
      partial: { userId: user.userId },
      status: pendingStatuses,
      noRawTx: true,
    });
    return { userId: user.userId, basketId: basket.basketId, pending };
  });
  if (!head) return null;
  const pendingIds = new Set(head.pending.map((t) => t.transactionId));
  const ownPendingTxids = new Set(head.pending.map((t) => t.txid).filter((t): t is string => !!t));
  const coins: string[] = [];
  const ownPendingInputs = new Set<string>();
  for (let offset = 0; ; offset += page) {
    // The store may switch (or lock) between pages: stop rather than read another store.
    if (!storage.isActiveStorageProvider()) return null;
    const rows = await storage.runAsReader((r) =>
      r.findOutputs({
        partial: { userId: head.userId, basketId: head.basketId },
        noScript: true,
        paged: { limit: page, offset },
      }),
    );
    for (const o of rows) {
      if (!o.txid) continue;
      const op = `${o.txid}_${o.vout}`;
      if (o.spendable) coins.push(op);
      if (o.spentBy != null && pendingIds.has(o.spentBy)) ownPendingInputs.add(op);
    }
    if (rows.length < page) break;
  }
  return { userId: head.userId, coins, ownPendingTxids, ownPendingInputs };
}
