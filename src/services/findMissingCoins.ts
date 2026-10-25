/**
 * Settings › Storage › Find missing coins (P0, 25 Oct 2026).
 *
 * tx 877d2505… (block 972621) left 28.66670816 BSV of the wallet's own change unspent on chain while the wallet
 * marked the action failed (an abort right after a server broadcast; services/unsentGuard.ts stops that now). A
 * restore later replaced the device's record, so the coin may survive only in the remote backup's rows.
 *
 * Scan (read only): every store this wallet reaches (the active one and its backups, local or remote) is asked
 * for its change outputs. A change output is a candidate when no store says we spent it and the active store
 * doesn't already hold it as spendable. Each candidate txid is looked up on chain: only a MINED transaction whose
 * change the chain conclusively calls UNSPENT is listed. Mempool-only ones are reported as "not confirmed yet".
 *
 * Restore (after one confirm sheet; never broadcasts, never moves coins):
 *  1. the record is in the active store: the toolbox's own repair, its proven-tx request set to 'unfail' and the
 *     Monitor's TaskUnFail run (merkle proof authenticated, outputs set spendable per a UTXO check, inputs spent);
 *  2. then recoverPaymentByTxid (services/recoverByTxid.ts) for whatever is still missing: it copies the coin in
 *     from whichever store holds its derivation (internalizeAction 'wallet payment', proven ours by the derived
 *     script) or repairs the active rows in place, then pushes to the backups;
 *  3. inputs the mined tx spent are marked spent in the active store.
 * Every step is logged as a [bwx-recover] line.
 */
import type { TxidRecoverReport } from './recoverByTxid';

const TXID = /^[0-9a-f]{64}$/i;

/** One output row a store holds (toolbox `outputs` table, read only). */
export type StoreOutput = {
  txid: string;
  vout: number;
  satoshis: number;
  change: boolean;
  spendable: boolean;
  /** Set when the store recorded one of our transactions spending it. */
  spentBy?: number | null;
  createdAt?: number;
  description?: string;
};

/** What one read of a store returned. `incomplete` says why the read is known to be partial. */
export type StoreRead = { outputs: StoreOutput[]; incomplete?: string };

export type ScanStore = {
  /** "this device", "the 1Sat backup (wallet.1sat.app)". */
  name: string;
  active: boolean;
  outputs: () => Promise<StoreOutput[] | StoreRead>;
  /**
   * The outputs of this store's failed / nosend / unsigned / unprocessed transactions, asked for explicitly (by
   * transaction status, then each transaction's outputs). A failed action keeps its output rows (the toolbox's
   * markFailedTransactionOutputsNotSpendable only flips spendable), so a coin from an aborted send lives here.
   */
  unsettledOutputs?: () => Promise<StoreOutput[] | StoreRead>;
};

export type ChainState = 'mined' | 'mempool' | 'missing' | 'unclear';

export type ScanDeps = {
  stores: () => Promise<ScanStore[]>;
  chain: (txid: string) => Promise<ChainState>;
  /** true unspent, false spent, undefined no clear answer. */
  isUnspent: (outpoint: string) => Promise<boolean | undefined>;
  /** Stop after this many candidate txids (newest first). */
  maxTxids?: number;
  log?: (m: string) => void;
};

export type MissingCoin = {
  txid: string;
  /** Sum of the change outputs the chain says are unspent. */
  sats: number;
  outputs: { vout: number; satoshis: number }[];
  createdAt?: number;
  description?: string;
  /** Stores holding a record of it. */
  stores: string[];
  /** The active store holds a row for it (the toolbox UnFail repair can run there). */
  inActive: boolean;
};

export type ScanReport = {
  found: MissingCoin[];
  /** On chain but not mined yet: try again later. */
  unconfirmed: string[];
  /** Change outputs of a mined tx that the chain says are spent: never made spendable. */
  spent: string[];
  /** Couldn't get a clear answer from the chain. */
  unclear: string[];
  /** Stores that didn't answer. */
  unreachable: string[];
  /** Stores that answered only in part (timeout, page cap, a query refused): "nothing found" is not proven. */
  incomplete: string[];
  checked: number;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function scanMissingCoins(deps: ScanDeps): Promise<ScanReport> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const report: ScanReport = {
    found: [],
    unconfirmed: [],
    spent: [],
    unclear: [],
    unreachable: [],
    incomplete: [],
    checked: 0,
  };
  const stores = await deps.stores();
  const rows: { store: ScanStore; outs: StoreOutput[] }[] = [];
  const key = (o: { txid: string; vout: number }) => `${o.txid.toLowerCase()}.${o.vout}`;
  const asRead = (r: StoreOutput[] | StoreRead): StoreRead => (Array.isArray(r) ? { outputs: r } : r);
  const partly = (store: ScanStore, why: string) => {
    if (!report.incomplete.includes(store.name)) report.incomplete.push(store.name);
    log(`[bwx-recover] ${store.name} read only in part: ${why}`);
  };
  for (const store of stores) {
    let main: StoreRead;
    try {
      main = asRead(await store.outputs());
    } catch (e) {
      main = { outputs: [] };
      if (!store.unsettledOutputs) {
        report.unreachable.push(store.name);
        log(`[bwx-recover] couldn't read ${store.name}: ${errText(e)}`);
        continue;
      }
      partly(store, `all outputs: ${errText(e)}`);
    }
    if (main.incomplete) partly(store, main.incomplete);
    const outs = main.outputs.filter((o) => !!o.txid);
    const seen = new Set(outs.map(key));
    if (store.unsettledOutputs) {
      try {
        const extra = asRead(await store.unsettledOutputs());
        if (extra.incomplete) partly(store, extra.incomplete);
        for (const o of extra.outputs)
          if (o.txid && !seen.has(key(o))) {
            seen.add(key(o));
            outs.push(o);
          }
      } catch (e) {
        partly(store, `failed/unsent transactions: ${errText(e)}`);
      }
    }
    rows.push({ store, outs });
  }
  const active = new Map<string, StoreOutput>();
  for (const r of rows) if (r.store.active) for (const o of r.outs) active.set(key(o), o);
  const spentSomewhere = new Set<string>();
  for (const r of rows) for (const o of r.outs) if (o.spentBy != null) spentSomewhere.add(key(o));

  type Cand = { outs: Map<number, StoreOutput>; stores: Set<string>; inActive: boolean };
  const byTx = new Map<string, Cand>();
  for (const r of rows)
    for (const o of r.outs) {
      if (!o.change || !TXID.test(o.txid ?? '') || o.satoshis <= 0) continue;
      const k = key(o);
      if (spentSomewhere.has(k)) continue;
      const a = active.get(k);
      if (a && a.spendable) continue;
      const txid = o.txid.toLowerCase();
      const c = byTx.get(txid) ?? { outs: new Map(), stores: new Set(), inActive: false };
      if (!c.outs.has(o.vout) || r.store.active) c.outs.set(o.vout, o);
      c.stores.add(r.store.name);
      if (r.store.active) c.inActive = true;
      byTx.set(txid, c);
    }
  // A row of the active store for the same txid (any output) also counts as "in the active store".
  for (const o of active.values()) {
    const c = byTx.get(o.txid?.toLowerCase());
    if (c) c.inActive = true;
  }
  const newest = (c: Cand) => Math.max(0, ...[...c.outs.values()].map((o) => o.createdAt ?? 0));
  const txids = [...byTx.entries()].sort((a, b) => newest(b[1]) - newest(a[1])).slice(0, deps.maxTxids ?? 100);
  log(`[bwx-recover] scan: ${rows.length} store(s) read, ${txids.length} candidate transaction(s)`);

  for (const [txid, c] of txids) {
    report.checked++;
    const state = await deps.chain(txid).catch((): ChainState => 'unclear');
    if (state === 'missing') {
      log(`[bwx-recover] ${txid}: not on chain; left as it is`);
      continue;
    }
    if (state === 'unclear') {
      report.unclear.push(txid);
      continue;
    }
    if (state === 'mempool') {
      report.unconfirmed.push(txid);
      continue;
    }
    const outputs: MissingCoin['outputs'] = [];
    for (const o of [...c.outs.values()].sort((a, b) => a.vout - b.vout)) {
      const u = await deps.isUnspent(`${txid}.${o.vout}`).catch(() => undefined);
      if (u === true) outputs.push({ vout: o.vout, satoshis: o.satoshis });
      else if (u === false) report.spent.push(`${txid}.${o.vout}`);
      else if (!report.unclear.includes(txid)) report.unclear.push(txid);
    }
    if (!outputs.length) continue;
    const first = [...c.outs.values()][0];
    const coin: MissingCoin = {
      txid,
      sats: outputs.reduce((n, o) => n + o.satoshis, 0),
      outputs,
      createdAt: newest(c) || undefined,
      description: first?.description,
      stores: [...c.stores],
      inActive: c.inActive,
    };
    report.found.push(coin);
    log(`[bwx-recover] ${txid}: mined, ${coin.sats} sats of change unspent on chain (${coin.stores.join(', ')})`);
  }
  return report;
}

export type RestoreDeps = {
  /** Queue these txids for the toolbox UnFail repair and run it (active store only). Returns how many were queued. */
  unfail?: (txids: string[]) => Promise<number>;
  /** recoverPaymentByTxid with the production wiring. */
  recoverTxid: (txid: string) => Promise<TxidRecoverReport>;
  /** Mark the active store's rows for the inputs the mined tx spent as spent. Returns how many changed. */
  markInputsSpent?: (txid: string) => Promise<number>;
  /** Read back: sats of the coin's outputs the active store now holds as spendable. */
  spendableSats: (coin: MissingCoin) => Promise<number>;
  log?: (m: string) => void;
};

export type RestoreReport = {
  restored: { txid: string; sats: number }[];
  notRestored: { txid: string; reason: string }[];
};

export async function restoreMissingCoins(coins: MissingCoin[], deps: RestoreDeps): Promise<RestoreReport> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const out: RestoreReport = { restored: [], notRestored: [] };
  const inActive = coins.filter((c) => c.inActive).map((c) => c.txid);
  if (inActive.length && deps.unfail) {
    try {
      const n = await deps.unfail(inActive);
      log(`[bwx-recover] UnFail: queued ${n} proven-tx request(s) for ${inActive.length} transaction(s)`);
    } catch (e) {
      log(`[bwx-recover] UnFail failed: ${errText(e)}`);
    }
  }
  for (const coin of coins) {
    try {
      let have = await deps.spendableSats(coin);
      if (have < coin.sats) {
        const r = await deps.recoverTxid(coin.txid);
        log(
          `[bwx-recover] ${coin.txid}: recoverByTxid ${r.result} (${r.restoredSats} sats)${r.error ? `: ${r.error}` : ''}`,
        );
        if (r.result === 'error') throw new Error(r.error ?? 'recovery failed');
        have = await deps.spendableSats(coin);
      }
      const marked = await (deps.markInputsSpent?.(coin.txid) ?? Promise.resolve(0)).catch((e) => {
        log(`[bwx-recover] ${coin.txid}: couldn't mark inputs spent: ${errText(e)}`);
        return 0;
      });
      if (marked) log(`[bwx-recover] ${coin.txid}: ${marked} input(s) marked spent`);
      if (have > 0) {
        out.restored.push({ txid: coin.txid, sats: have });
        log(`[bwx-recover] ${coin.txid}: restored, ${have} sats spendable`);
      } else out.notRestored.push({ txid: coin.txid, reason: 'still not spendable after the repair' });
    } catch (e) {
      out.notRestored.push({ txid: coin.txid, reason: errText(e) });
      log(`[bwx-recover] ${coin.txid}: NOT restored: ${errText(e)}`);
    }
  }
  return out;
}

const bsv = (sats: number) => (sats / 1e8).toFixed(3).replace(/\.?0+$/, '') || '0';
const bsvExact = (sats: number) => (sats / 1e8).toFixed(8).replace(/\.?0+$/, '');

/** The confirm sheet's headline. */
export const foundHeadline = (r: ScanReport): string => {
  const sats = r.found.reduce((n, c) => n + c.sats, 0);
  if (!sats) {
    // Never "nothing found" when a store wasn't read in full: that is not an answer.
    const notRead = [...(r.unreachable ?? []), ...(r.incomplete ?? [])];
    if (notRead.length) return `Couldn’t finish reading ${notRead.join(', ')}; nothing changed.`;
    return 'No missing coins found.';
  }
  return `We found ${bsv(sats) === '0' ? bsvExact(sats) : bsv(sats)} BSV the wallet lost track of. Add it back?`;
};

/** One line after a scan with nothing to restore (or alongside the sheet). */
export const scanNote = (r: ScanReport): string => {
  const parts: string[] = [];
  if (r.unconfirmed.length) parts.push(`${r.unconfirmed.length} not confirmed yet; try again later`);
  if (r.unclear.length) parts.push(`${r.unclear.length} couldn’t be checked`);
  if (r.unreachable.length) parts.push(`couldn’t reach ${r.unreachable.join(', ')}`);
  if (r.incomplete?.length) parts.push(`couldn’t finish reading ${r.incomplete.join(', ')}; try again`);
  return parts.join('. ');
};

export const restoredLine = (r: RestoreReport): string => {
  const sats = r.restored.reduce((n, x) => n + x.sats, 0);
  const done = sats ? `Added back ${bsvExact(sats)} BSV.` : '';
  const not = r.notRestored.length ? ` ${r.notRestored.length} couldn’t be added: ${r.notRestored[0].reason}` : '';
  return (done + not).trim() || 'Nothing changed.';
};
