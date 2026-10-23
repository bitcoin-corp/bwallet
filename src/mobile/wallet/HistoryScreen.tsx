import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  RefreshCw,
  Repeat,
  X,
} from 'lucide-react';
import { copyLink } from '../chat/shareLink';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import { saveTextFile } from '../agents/saveText';
import {
  balances,
  bsvString,
  fileStem,
  filterRange,
  rangeFor,
  toCsv,
  totals,
  usdValue,
  type HistoryRow,
  type RangePreset,
} from './txHistory';
import type { Progress } from './txHistoryFetch';
import { CATEGORIES, assetText, filterCategory, historyLooksIncomplete, type Category } from './historyEvents';
import { loadLastBalance } from './balanceLoad';
import { ConnectionsView } from './ConnectionsView';
import { GainsView } from './GainsView';
import { loadHistoryRows } from './historyLoad';
import { historyCacheKey, readHistoryCache, writeHistoryCache, type LoadedHistory } from './historyCache';
import { statementHtml } from './txStatement';
import { hiddenByRange, updatedText } from './historyRefresh';

const BG = '#0d0e11';
const CARD = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

/** Height of the web wallet's beta banner when it is on screen (0 elsewhere). */
const webBannerHeight = () =>
  typeof document === 'undefined'
    ? 0
    : Math.round(document.querySelector('.bwallet-web-banner')?.getBoundingClientRect().height ?? 0);
const GOLD = 'var(--bw-accent-hi)';
const GREEN = '#32D583';
const RED = '#F97066';

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

const fmtBsv = (sats: number) => `${bsvString(sats).replace(/\.?0+$/, '') || '0'} BSV`;
const fmtSats = (sats: number) => `${sats.toLocaleString()} sats`;

type Loaded = LoadedHistory;
const cacheKey = historyCacheKey;
const readCache = readHistoryCache;
const writeCache = writeHistoryCache;

/** Activity / History for the current account: full on-chain history, summary, CSV and printable statement. */
export const HistoryScreen = ({
  onClose,
  inline = false,
}: {
  onClose: () => void;
  /** Wide web layout: render in place as a panel, not a full-screen dialog. */
  inline?: boolean;
}) => {
  const { chromeStorageService, apiContext } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const addrs = account?.addresses;
  const addresses = useMemo(
    () => [...new Set([addrs?.bsvAddress, addrs?.ordAddress, addrs?.identityAddress].filter((a): a is string => !!a))],
    [addrs?.bsvAddress, addrs?.ordAddress, addrs?.identityAddress],
  );
  const accountName = account?.name || addrs?.bsvAddress || 'Account';
  const key = cacheKey(addresses);
  const [data, setData] = useState<Loaded | null>(() => readCache(key));
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [shown, setShown] = useState(100);
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [view, setView] = useState<'tx' | 'connections' | 'gains'>('tx');

  // Wide web (desktop.bwalletx.com): the dialog fills the page and transactions are a table. Phone layout unchanged.
  const wide = !inline && typeof document !== 'undefined' && document.documentElement.classList.contains('ww-on');
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /**
   * `manual`: the person pressed Refresh, so always show the spinner and progress. Before, a refresh with a cached
   * copy on screen was always quiet: no spinner, no message, and (with the rows outside the 30-day range) nothing
   * visibly changed, so "Refresh history" looked dead.
   */
  const load = useCallback(
    async (manual = false) => {
      setError('');
      // On open with a cached copy on screen, refresh quietly: no progress bar over rows the user is reading.
      const quiet = !manual && !!readCache(key);
      if (manual) setRefreshing(true);
      if (!quiet) setProgress({ phase: 'Starting', done: 0, total: 1 });
      try {
        const now = Date.now();
        const rows = await loadHistoryRows({
          addresses,
          identityAddress: addrs?.identityAddress,
          apiContext,
          onProgress: quiet ? () => undefined : setProgress,
          now,
        });
        const loaded = { rows, at: now };
        writeCache(key, loaded);
        setData(loaded);
        setNow(Date.now());
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`Couldn't refresh history: ${msg}`);
      } finally {
        setProgress(null);
        setRefreshing(false);
      }
    },
    [addresses, addrs?.identityAddress, apiContext, key],
  );
  const refresh = () => void load(true);
  const busy = !!progress || refreshing;

  useEffect(() => {
    void load();
  }, [load]);

  const range = useMemo(() => rangeFor(preset, data?.at ?? Date.now(), custom), [preset, custom, data?.at]);
  const rows = useMemo(
    () =>
      data ? filterCategory(filterRange(data.rows, range) as (HistoryRow & { category: Category })[], category) : [],
    [data, range, category],
  );
  const sum = totals(rows);
  const bal = data ? balances(data.rows, range) : null;
  // Only a range that runs to now can be checked against the wallet's balance.
  const incomplete =
    !!data &&
    historyLooksIncomplete(
      sum,
      range.to === null || range.to >= data.at - 60_000 ? (bal?.closing ?? null) : null,
      category === 'all' ? loadLastBalance(addrs?.identityAddress) : null,
    );
  const stem = fileStem(accountName, range);
  const hidden = data ? hiddenByRange(data.rows, range) : 0;

  const exportCsv = () => void saveTextFile(`${stem}.csv`, toCsv(rows, accountName), 'text/csv;charset=utf-8');
  const exportPdf = () => {
    const html = statementHtml({
      account: accountName,
      addresses,
      range,
      rows,
      // A category-filtered statement has no meaningful account balance.
      opening: category === 'all' ? (bal?.opening ?? null) : null,
      closing: category === 'all' ? (bal?.closing ?? null) : null,
      autoPrint: !isNative,
    });
    if (!isNative) {
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const w = window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (w) return;
    }
    // Phones: share the statement page (open it, then Print → Save as PDF).
    void saveTextFile(`${stem}-statement.html`, html, 'text/html');
  };

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  const page = (
    <div
      role={inline ? 'region' : 'dialog'}
      aria-label="Transaction history"
      data-ww-fill={wide ? '' : undefined}
      className={inline ? 'flex h-full min-h-0 flex-col' : 'fixed inset-0 flex flex-col'}
      style={{
        background: BG,
        color: '#fff',
        zIndex: inline ? undefined : 2000,
        // Clear the web beta banner (it sits above every overlay), else it hides the close button.
        paddingTop: inline ? 0 : `calc(env(safe-area-inset-top) + ${webBannerHeight()}px)`,
      }}
    >
      <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${LINE}` }}>
        <div className="flex-1 min-w-0">
          <div className="font-semibold">History</div>
          <div className="text-xs truncate" style={{ color: MUTED }} aria-live="polite">
            {accountName}
            {busy ? ' · Refreshing…' : data ? ` · ${updatedText(data.at, now)}` : ''}
          </div>
        </div>
        <button
          type="button"
          aria-label="Reload history"
          disabled={busy}
          onClick={refresh}
          className="p-2 bg-transparent border-0 cursor-pointer"
          style={{ color: MUTED }}
        >
          <RefreshCw size={18} className={busy ? 'animate-spin' : ''} />
        </button>
        {!inline && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-2 bg-transparent border-0 cursor-pointer"
            style={{ color: '#fff' }}
          >
            <X size={20} />
          </button>
        )}
      </div>

      <div className="flex gap-2 px-4 pt-3" role="tablist" aria-label="History view">
        {(
          [
            ['tx', 'Transactions'],
            ['gains', 'Gains'],
            ['connections', 'Connections'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className="flex-1 py-2 rounded-xl text-sm font-semibold border-0 cursor-pointer"
            style={{ background: view === id ? '#fff' : CARD, color: view === id ? '#000' : '#fff' }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'connections' ? (
        <ConnectionsView rows={data?.rows ?? []} />
      ) : view === 'gains' ? (
        <GainsView rows={data?.rows ?? []} account={accountName} />
      ) : (
        <div
          className="flex-1 overflow-y-auto px-4 pb-8"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 32px)' }}
        >
          {progress && (
            <div className="mt-4" aria-live="polite">
              <div className="text-xs mb-1" style={{ color: MUTED }}>
                Loading full history… {progress.phase}
                {progress.total > 1 ? ` (${progress.done}/${progress.total})` : ''}
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: LINE }}>
                <div
                  className="h-full"
                  style={{ width: `${Math.max(4, pct)}%`, background: GOLD, transition: 'width .3s' }}
                />
              </div>
            </div>
          )}
          {error && (
            <div className="mt-4 text-sm" style={{ color: RED }}>
              {error}{' '}
              <button
                type="button"
                onClick={refresh}
                className="underline bg-transparent border-0"
                style={{ color: GOLD }}
              >
                Retry
              </button>
              {data && (
                <div className="text-xs mt-1" style={{ color: MUTED }}>
                  Showing the copy loaded {updatedText(data.at, now).replace(/^Updated /, '')}.
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 mt-4" role="group" aria-label="Date range">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={preset === p.id}
                onClick={() => {
                  setPreset(p.id);
                  setShown(100);
                }}
                className="px-3 py-1 rounded-full text-xs border-0 cursor-pointer"
                style={{ background: preset === p.id ? GOLD : CARD, color: preset === p.id ? '#000' : '#fff' }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 mt-2 pb-1" role="group" aria-label="Category">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={category === c.id}
                onClick={() => {
                  setCategory(c.id);
                  setShown(100);
                }}
                className="px-3 py-1 rounded-full text-xs cursor-pointer whitespace-nowrap"
                style={{
                  background: category === c.id ? '#fff' : 'transparent',
                  color: category === c.id ? '#000' : MUTED,
                  border: `1px solid ${category === c.id ? '#fff' : LINE}`,
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="flex gap-2 mt-2 text-xs items-center" style={{ color: MUTED }}>
              <label className="flex flex-col gap-1">
                From
                <input
                  type="date"
                  value={custom.from}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  className="rounded px-2 py-1"
                  style={{ background: CARD, color: '#fff', border: `1px solid ${LINE}` }}
                />
              </label>
              <label className="flex flex-col gap-1">
                To
                <input
                  type="date"
                  value={custom.to}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  className="rounded px-2 py-1"
                  style={{ background: CARD, color: '#fff', border: `1px solid ${LINE}` }}
                />
              </label>
            </div>
          )}

          <div className={`grid ${wide ? 'grid-cols-4' : 'grid-cols-2'} gap-2 mt-4`}>
            {[
              ['In', sum.inSats, GREEN],
              ['Out', -sum.outSats, RED],
              ['Fees', -sum.feeSats, MUTED],
              ['Net', sum.netSats, sum.netSats >= 0 ? GREEN : RED],
            ].map(([k, v, c]) => (
              <div key={k as string} className="rounded-xl p-3" style={{ background: CARD }}>
                <div className="text-xs" style={{ color: MUTED }}>
                  {k as string}
                </div>
                <div className="font-semibold" style={{ color: c as string }}>
                  {fmtBsv(v as number)}
                </div>
                <div className="text-xs" style={{ color: MUTED }}>
                  {fmtSats(v as number)}
                </div>
              </div>
            ))}
          </div>
          {incomplete && (
            <div
              role="status"
              className="text-xs mt-2 rounded-lg p-2"
              style={{ color: GOLD, border: `1px solid ${GOLD}` }}
            >
              <div>History may be incomplete. Refresh it, or run Repair Sync (Settings &gt; Troubleshooting).</div>
              {/* A visible button: pull-to-refresh doesn't exist in the Chrome extension (owner, 11 Oct 2026). */}
              <button
                type="button"
                disabled={busy}
                onClick={refresh}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 border-0 cursor-pointer font-semibold"
                style={{ background: GOLD, color: '#000' }}
              >
                <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
                {busy ? 'Refreshing…' : 'Refresh history'}
              </button>
            </div>
          )}
          {bal && (
            <div className="text-xs mt-2" style={{ color: MUTED }}>
              {sum.count} transactions
              {/* Opening / closing are for the whole account, so only beside the unfiltered list. */}
              {category === 'all' && ` · opening ${fmtBsv(bal.opening)} · closing ${fmtBsv(bal.closing)}`}
            </div>
          )}

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              disabled={!data}
              onClick={exportCsv}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl py-3 border-0 cursor-pointer font-semibold"
              style={{ background: GOLD, color: '#000', opacity: data ? 1 : 0.5 }}
            >
              <Download size={16} /> Export CSV
            </button>
            <button
              type="button"
              disabled={!data}
              onClick={exportPdf}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl py-3 cursor-pointer font-semibold"
              style={{ background: CARD, color: '#fff', border: `1px solid ${LINE}`, opacity: data ? 1 : 0.5 }}
            >
              <FileText size={16} /> PDF statement
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            {data && rows.length === 0 && (
              <div className="text-sm mt-6 text-center" style={{ color: MUTED }}>
                No transactions in this period.
                {hidden > 0 && preset !== 'all' && (
                  <div className="mt-2">
                    {hidden} {hidden === 1 ? 'transaction is' : 'transactions are'} outside it.{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setPreset('all');
                        setShown(100);
                      }}
                      className="underline bg-transparent border-0 cursor-pointer"
                      style={{ color: GOLD }}
                    >
                      Show all time
                    </button>
                  </div>
                )}
              </div>
            )}
            {wide && rows.length > 0 ? (
              <TxTable rows={rows.slice(0, shown)} all={data?.rows ?? []} />
            ) : (
              rows.slice(0, shown).map((r) => <Row key={r.txid} r={r} />)
            )}
            {rows.length > shown && (
              <button
                type="button"
                onClick={() => setShown((n) => n + 200)}
                className="py-2 bg-transparent border-0 cursor-pointer text-sm"
                style={{ color: GOLD }}
              >
                Show more ({rows.length - shown} left)
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
  return inline ? page : createPortal(page, document.body);
};

const Row = ({ r }: { r: HistoryRow }) => {
  const Icon = r.direction === 'in' ? ArrowDownLeft : r.direction === 'out' ? ArrowUpRight : Repeat;
  const color = r.direction === 'in' ? GREEN : r.direction === 'out' ? RED : MUTED;
  const usd = usdValue(r);
  return (
    <div className="rounded-xl p-3 flex gap-3" style={{ background: CARD }}>
      <div className="mt-1" style={{ color }}>
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between gap-2">
          <span className="text-sm font-semibold capitalize">{r.label}</span>
          <span className="text-sm font-semibold" style={{ color }}>
            {r.amountSats > 0 ? '+' : ''}
            {fmtBsv(r.amountSats)}
          </span>
        </div>
        <div className="flex justify-between gap-2 text-xs" style={{ color: MUTED }}>
          <span>{new Date(r.time).toLocaleString()}</span>
          <span>
            {fmtSats(r.amountSats)}
            {usd ? ` · $${usd}${r.usdRateIsCurrent ? ' (current rate)' : ''}` : ''}
          </span>
        </div>
        {(r.asset || r.app || r.appNote) && (
          <div className="text-xs mt-1 break-all" style={{ color: '#fff' }}>
            {r.asset && <span>{assetText(r.asset)} </span>}
            {r.app && (
              <span style={{ color: MUTED }}>
                {r.asset ? '· ' : ''}via {r.app}
              </span>
            )}
            {r.appNote && (
              <span>
                {r.asset || r.app ? ' · ' : ''}“{r.appNote}”
              </span>
            )}
          </div>
        )}
        {r.purpose && (
          <div className="text-xs mt-1 break-words" style={{ color: '#fff' }}>
            <span style={{ color: MUTED }}>For:</span> {r.purpose}
          </div>
        )}
        {(r.feeSats > 0 || r.counterparty || r.note) && (
          <div className="text-xs mt-1 break-all" style={{ color: MUTED }}>
            {r.feeSats > 0 && <span>Fee {fmtSats(r.feeSats)} </span>}
            {r.counterparty && (
              <span>
                · {r.direction === 'in' ? 'from' : 'to'} {r.counterparty}{' '}
              </span>
            )}
            {r.note && <span>· {r.note}</span>}
          </div>
        )}
        <a
          href={`https://whatsonchain.com/tx/${r.txid}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs inline-flex items-center gap-1 mt-1 font-mono"
          style={{ color: GOLD }}
        >
          {r.txid.slice(0, 12)}…{r.txid.slice(-6)} <ExternalLink size={11} />
          {r.confirmations === 0 && <span style={{ color: MUTED }}> · unconfirmed</span>}
        </a>
        <CopyTxid txid={r.txid} />
      </div>
    </div>
  );
};

/** Wide layout: one row per tx with a running balance (balance after the tx, from the whole history). */
const TxTable = ({ rows, all }: { rows: HistoryRow[]; all: HistoryRow[] }) => {
  const after = useMemo(() => {
    const m = new Map<string, number>();
    let run = 0;
    for (const r of [...all].sort((a, b) => a.time - b.time || a.txid.localeCompare(b.txid))) {
      run += r.amountSats - r.feeSats;
      m.set(r.txid, run);
    }
    return m;
  }, [all]);
  const th = 'text-left font-semibold px-3 py-2 whitespace-nowrap';
  const td = 'px-3 py-2 align-top';
  return (
    <div className="rounded-xl overflow-x-auto" style={{ background: CARD }}>
      <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
        <thead style={{ color: MUTED, borderBottom: `1px solid ${LINE}` }}>
          <tr>
            <th className={th}>Date</th>
            <th className={th}>Type</th>
            <th className={th}>Description</th>
            <th className={`${th} text-right`}>Amount</th>
            <th className={`${th} text-right`}>Fee</th>
            <th className={`${th} text-right`}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color = r.direction === 'in' ? GREEN : r.direction === 'out' ? RED : MUTED;
            const usd = usdValue(r);
            const desc = [
              r.asset ? assetText(r.asset) : '',
              r.app ? `via ${r.app}` : '',
              r.appNote ? `“${r.appNote}”` : '',
              r.counterparty ? `${r.direction === 'in' ? 'from' : 'to'} ${r.counterparty}` : '',
              r.note,
              r.purpose ? `For: ${r.purpose}` : '',
            ]
              .filter(Boolean)
              .join(' · ');
            const bal = after.get(r.txid);
            return (
              <tr key={r.txid} style={{ borderTop: `1px solid ${LINE}` }}>
                <td className={`${td} whitespace-nowrap`} style={{ color: MUTED }}>
                  {new Date(r.time).toLocaleString()}
                  {r.confirmations === 0 && <div className="text-xs">unconfirmed</div>}
                </td>
                <td className={`${td} capitalize whitespace-nowrap`}>{r.label}</td>
                <td className={td} style={{ maxWidth: 420 }}>
                  <div className="break-words">{desc || '—'}</div>
                  <a
                    href={`https://whatsonchain.com/tx/${r.txid}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs inline-flex items-center gap-1 font-mono"
                    style={{ color: GOLD }}
                  >
                    {r.txid.slice(0, 12)}…{r.txid.slice(-6)} <ExternalLink size={11} />
                  </a>
                  <CopyTxid txid={r.txid} />
                </td>
                <td className={`${td} text-right whitespace-nowrap font-mono`} style={{ color }}>
                  {r.amountSats > 0 ? '+' : ''}
                  {fmtBsv(r.amountSats)}
                  {usd && (
                    <div className="text-xs" style={{ color: MUTED }}>
                      ${usd}
                      {r.usdRateIsCurrent ? ' (current rate)' : ''}
                    </div>
                  )}
                </td>
                <td className={`${td} text-right whitespace-nowrap font-mono`} style={{ color: MUTED }}>
                  {r.feeSats > 0 ? fmtSats(r.feeSats) : '—'}
                </td>
                <td className={`${td} text-right whitespace-nowrap font-mono`}>
                  {bal === undefined ? '—' : fmtBsv(bal)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

/** Copy a transaction ID in one tap (for Settings › Troubleshooting › Recover a payment by transaction ID). */
const CopyTxid = ({ txid }: { txid: string }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy transaction ID"
      title="Copy transaction ID"
      className="text-xs inline-flex items-center gap-1 ml-2"
      style={{ color: MUTED }}
      onClick={async () => {
        if ((await copyLink(txid)) !== 'copied') return;
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={11} /> : <Copy size={11} />} {done ? 'Copied' : 'Copy ID'}
    </button>
  );
};

export default HistoryScreen;
