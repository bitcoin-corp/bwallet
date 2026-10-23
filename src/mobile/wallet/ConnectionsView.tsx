import { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe } from 'lucide-react';
import { bsvString, type HistoryRow } from './txHistory';
import {
  loadConnectionLog,
  mergeConnections,
  readDeviceAppHosts,
  type ConnectionLog,
  type ConnectionRow,
  type PermissionGroup as Group,
} from './connectionLog';
import { ErrorActions } from '../errors/ErrorActions';
import { forgetSiteConnected, setSiteThemeAllowed, siteThemeAllowed } from '../theme/connectSiteTheme';

const CARD = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const GOLD = 'var(--bw-accent-hi)';
const RED = '#F97066';

type Msg = { action: string; [k: string]: unknown };
const send = async <T,>(msg: Msg): Promise<{ success: boolean; data?: T; error?: string }> => {
  const c = (globalThis as { chrome?: { runtime?: { sendMessage?: (m: Msg) => Promise<unknown> } } }).chrome;
  if (!c?.runtime?.sendMessage) return { success: false, error: 'unavailable' };
  return (await c.runtime.sendMessage(msg)) as { success: boolean; data?: T; error?: string };
};

const when = (t?: number) => (t ? new Date(t).toLocaleString() : '');
const GRANT_NAMES: Record<string, string> = {
  protocol: 'keys/signing',
  basket: 'data access',
  spending: 'spending',
  certificate: 'identity',
};

/** History › Connections: every site or app that used the wallet, what it may do, and what it spent. */
export const ConnectionsView = ({ rows }: { rows: HistoryRow[] }) => {
  const [log, setLog] = useState<ConnectionLog>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // "Use this site's theme" per site (docs/SITE-THEME.md); bumped to re-read after a toggle.
  const [, setThemeTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const [l, g] = await Promise.all([
      loadConnectionLog(),
      send<{ groups: Group[] }>({ action: 'PERMISSIONS_LIST_ALL' }).catch(() => null),
    ]);
    setLog(l);
    setGroups(g?.success ? (g.data?.groups ?? []) : []);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const list = useMemo(() => mergeConnections(log, groups, rows, readDeviceAppHosts()), [log, groups, rows]);

  const revoke = async (r: ConnectionRow) => {
    if (!r.originator) return;
    if (!window.confirm(`Revoke everything ${r.host} may do? It will have to ask again next time.`)) return;
    setBusy(r.host);
    setError('');
    const res = await send({ action: 'PERMISSIONS_REVOKE_ALL', originator: r.originator }).catch((e) => ({
      success: false,
      error: String(e),
    }));
    if (!res.success) setError(res.error || 'Could not revoke');
    else forgetSiteConnected(r.host);
    setBusy('');
    await load();
  };

  return (
    <div className="flex-1 overflow-y-auto px-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 32px)' }}>
      <p className="text-xs mt-4" style={{ color: MUTED }}>
        Sites and apps that have used this wallet, what they may do, and what you paid them. Calls and payments are
        recorded from this version on; earlier use shows only as permissions.
      </p>
      {error && (
        <div className="flex flex-col gap-1.5">
          <div className="text-sm mt-2" style={{ color: RED }}>
            {error}
          </div>
          <ErrorActions message={String(error)} />
        </div>
      )}
      {loading && (
        <div className="text-sm mt-6 text-center" style={{ color: MUTED }}>
          Loading…
        </div>
      )}
      {!loading && list.length === 0 && (
        <div className="text-sm mt-6 text-center" style={{ color: MUTED }}>
          No apps have connected yet.
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2">
        {list.map((r) => (
          <div key={r.host} className="rounded-xl p-3" style={{ background: CARD }}>
            <div className="flex items-center gap-2">
              <Globe size={16} style={{ color: MUTED }} />
              <span className="text-sm font-semibold flex-1 min-w-0 truncate">{r.host}</span>
              {r.game && (
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full"
                  style={{ border: `1px solid ${LINE}`, color: MUTED }}
                >
                  game
                </span>
              )}
            </div>
            <div className="text-xs mt-1" style={{ color: MUTED }}>
              {r.lastSeen
                ? `Last used ${when(r.lastSeen)} · first ${when(r.firstSeen)}`
                : 'Not used since logging began'}
            </div>
            <div className="text-xs mt-1" style={{ color: MUTED }}>
              {r.calls} {r.calls === 1 ? 'call' : 'calls'} · {r.payments} {r.payments === 1 ? 'payment' : 'payments'} ·
              spent {bsvString(r.spentSats).replace(/\.?0+$/, '')} BSV
              {r.spendLimitSats !== undefined &&
                ` · allowance ${bsvString(r.spendLimitSats).replace(/\.?0+$/, '')} BSV`}
            </div>
            {Object.keys(r.grants).length > 0 && (
              <div className="text-xs mt-1" style={{ color: '#fff' }}>
                Allowed:{' '}
                {Object.entries(r.grants)
                  .map(([t, n]) => `${GRANT_NAMES[t] ?? t}${n > 1 ? ` ×${n}` : ''}`)
                  .join(', ')}
              </div>
            )}
            <label className="flex items-center gap-2 text-xs mt-2" style={{ color: MUTED }}>
              <input
                type="checkbox"
                checked={siteThemeAllowed(r.host)}
                onChange={(e) => {
                  setSiteThemeAllowed(r.host, e.target.checked);
                  setThemeTick((n) => n + 1);
                }}
              />
              Use this site&apos;s theme
            </label>
            {r.originator && (
              <button
                type="button"
                disabled={busy === r.host}
                onClick={() => void revoke(r)}
                className="mt-2 text-xs px-3 py-1 rounded-full cursor-pointer bg-transparent"
                style={{ color: GOLD, border: `1px solid ${LINE}` }}
              >
                {busy === r.host ? 'Revoking…' : 'Revoke access'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default ConnectionsView;
