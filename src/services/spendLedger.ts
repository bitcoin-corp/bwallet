import { normalizeOriginator } from '@1sat/wallet';

/**
 * Local month-to-date spend per app (b-Aware report, 23 Oct 2026).
 *
 * A monthly allowance is checked against how much the app has already spent this month. Upstream, that figure comes
 * from `querySpentSince`, which asks the active storage's `listActions` for the manager's spending labels. When the
 * active storage is remote, the storage server answers that question, so a faulty or compromised server could report
 * a lower figure and let payments over the allowance through without a sheet.
 *
 * This keeps our own append-only record, one IndexedDB database per account, of every payment the manager
 * authorised for an app, and makes the month-to-date figure max(local record, storage answer). The server can raise
 * the figure but never lower it below what this device has authorised.
 *
 * Recorded at authorisation time, before the action is created. A payment that later fails still counts against the
 * allowance for that month: that errs towards asking again, never towards paying without asking.
 */

export type SpendLedger = {
  record(originator: string, month: string, satoshis: number): Promise<void>;
  total(originator: string, month: string): Promise<number>;
  close(): Promise<void>;
};

const DB_PREFIX = 'bwalletx-spend-ledger:';
const STORE = 'entries';
const INDEX = 'byOriginatorMonth';

export const spendLedgerName = (accountId: string): string => {
  if (!accountId) throw new Error('spend ledger needs an account id');
  return `${DB_PREFIX}${accountId}`;
};

/** Same calendar month the upstream manager labels spends with (UTC). */
export const currentMonthUTC = (now = new Date()): string =>
  `${now.getUTCFullYear()}-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}`;

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export async function openSpendLedger(accountId: string): Promise<SpendLedger> {
  const open = indexedDB.open(spendLedgerName(accountId), 1);
  open.onupgradeneeded = () => {
    const s = open.result.createObjectStore(STORE, { autoIncrement: true });
    s.createIndex(INDEX, ['originator', 'month']);
  };
  const db = await req(open);
  return {
    async record(originator, month, satoshis) {
      if (!(satoshis > 0)) return;
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add({ originator: normalizeOriginator(originator), month, satoshis, at: Date.now() });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
    async total(originator, month) {
      const tx = db.transaction(STORE, 'readonly');
      const rows = await req(
        tx
          .objectStore(STORE)
          .index(INDEX)
          .getAll([normalizeOriginator(originator), month]) as IDBRequest<{ satoshis: number }[]>,
      );
      return rows.reduce((s, r) => s + (Number(r.satoshis) || 0), 0);
    },
    async close() {
      db.close();
    },
  };
}

type SpendingArgs = { originator: string; satoshis: number };
type Token = { originator?: string; rawOriginator?: string };
type SpendManager = {
  ensureSpendingAuthorization(args: SpendingArgs): Promise<boolean>;
  querySpentSince(token: Token): Promise<number>;
};

/**
 * Patch a permissions manager instance so every authorised spend is recorded locally and the month-to-date figure
 * used for allowance checks is never below the local record. Instance properties shadow the prototype, so the
 * manager's own internal `this.ensureSpendingAuthorization` / `this.querySpentSince` calls use these.
 */
export function withLocalSpendLedger<T extends object>(
  manager: T,
  ledger: SpendLedger,
  log: (msg: string) => void = console.warn,
): T {
  const m = manager as unknown as SpendManager;
  const ensure = m.ensureSpendingAuthorization;
  const query = m.querySpentSince;
  if (typeof ensure !== 'function' || typeof query !== 'function') {
    throw new Error('spend ledger: permissions manager has no spending hooks; allowances would trust storage alone');
  }
  m.querySpentSince = async (token: Token) => {
    const remote = await query.call(manager, token);
    const who = token.originator || token.rawOriginator || '';
    const local = who ? await ledger.total(who, currentMonthUTC()) : 0;
    if (local > remote) log(`[permissions] storage reported ${remote} sats spent this month, local record ${local}`);
    return Math.max(local, Number(remote) || 0);
  };
  m.ensureSpendingAuthorization = async (args: SpendingArgs) => {
    const ok = await ensure.call(manager, args);
    // A failed write must not let the spend go uncounted: refuse instead.
    if (ok) await ledger.record(args.originator, currentMonthUTC(), args.satoshis);
    return ok;
  };
  return manager;
}
