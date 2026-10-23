import { useCallback, useEffect, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { satsToUsdText, usdToSats } from '../services/streamGrants';
import { sendMessageAsync } from '../utils/chromeHelpers';

type Row = {
  grantId: string;
  originator: string;
  protocolID: [2, string];
  capSatsPerHour: number;
  expiry: number;
  spentLastHourSats: number;
  remainingSats: number;
  totalSats: number;
  active: boolean;
  revoked: boolean;
  expired: boolean;
  description?: string;
};
type ListData = { grants: Row[]; paused: boolean; ceilingSatsPerHour: number; usdPerBsv?: number };

const money = (sats: number, rate?: number) => {
  const usd = satsToUsdText(sats, rate);
  return usd ? `${usd} (${sats.toLocaleString()} sats)` : `${sats.toLocaleString()} sats`;
};

/**
 * Settings › Streaming permissions: every site allowed to stream payments while you watch, with what it has spent
 * this hour and in total, and Revoke. Plus the global ceiling and "Pause all streaming" (the kill switch).
 */
export const StreamingPermissions = () => {
  const { theme } = useTheme();
  const [data, setData] = useState<ListData | null>(null);
  const [ceilingText, setCeilingText] = useState('');

  const load = useCallback(async () => {
    const r = await sendMessageAsync<{ success: boolean; data?: ListData }>({ action: 'STREAM_GRANTS_LIST' }).catch(
      () => null,
    );
    if (r?.success && r.data) {
      setData(r.data);
      const rate = r.data.usdPerBsv;
      setCeilingText(rate ? ((r.data.ceilingSatsPerHour / 1e8) * rate).toFixed(2) : String(r.data.ceilingSatsPerHour));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  if (!data) return <p style={{ color: gray }}>Loading…</p>;
  const rate = data.usdPerBsv;

  const settings = async (patch: { paused?: boolean; ceilingSatsPerHour?: number }) => {
    await sendMessageAsync({ action: 'STREAM_GRANTS_SETTINGS', ...patch }).catch(() => null);
    await load();
  };
  const saveCeiling = () => {
    const n = Number(ceilingText);
    if (!Number.isFinite(n) || n < 0) return;
    void settings({ ceilingSatsPerHour: rate ? usdToSats(n, rate) : Math.floor(n) });
  };
  const revoke = async (id: string) => {
    await sendMessageAsync({ action: 'STREAM_GRANTS_REVOKE', grantId: id }).catch(() => null);
    await load();
  };

  const live = data.grants.filter((g) => !g.revoked && !g.expired);
  const past = data.grants.filter((g) => g.revoked || g.expired);

  return (
    <div className="flex flex-col gap-4 text-sm" style={{ color: contrast }}>
      <p className="m-0 text-xs" style={{ color: gray }}>
        Sites you let stream payments while you watch. Only their own streaming payments, inside the hourly cap, go
        through without asking.
      </p>
      <label className="flex items-center justify-between gap-2">
        <span>Pause all streaming</span>
        <input
          type="checkbox"
          aria-label="Pause all streaming"
          checked={data.paused}
          onChange={(e) => void settings({ paused: e.target.checked })}
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        <span>Most per hour, all sites {rate ? '($)' : '(sats)'}</span>
        <span className="flex gap-2">
          <input
            aria-label="Global ceiling per hour"
            inputMode="decimal"
            value={ceilingText}
            onChange={(e) => setCeilingText(e.target.value)}
            className="w-24 px-2 py-1 rounded bg-transparent border"
            style={{ color: contrast }}
          />
          <button
            type="button"
            onClick={saveCeiling}
            className="px-2 py-1 rounded border bg-transparent"
            style={{ color: contrast }}
          >
            Save
          </button>
        </span>
      </div>
      <p className="m-0 text-xs" style={{ color: gray }}>
        {money(data.ceilingSatsPerHour, rate)} an hour across every site
      </p>
      {live.length === 0 && <p style={{ color: gray }}>No site can stream payments right now.</p>}
      {live.map((g) => (
        <div key={g.grantId} className="flex flex-col gap-1 p-3 rounded border" style={{ borderColor: '#ffffff22' }}>
          <div className="flex justify-between items-center">
            <strong>{g.originator}</strong>
            <button
              type="button"
              onClick={() => void revoke(g.grantId)}
              className="px-2 py-1 rounded border bg-transparent"
              style={{ color: '#ef4444' }}
            >
              Revoke
            </button>
          </div>
          <span style={{ color: gray }}>
            {g.protocolID[1]} · up to {money(g.capSatsPerHour, rate)}/hour · until{' '}
            {new Date(g.expiry * 1000).toLocaleString()}
          </span>
          <span>
            This hour: {money(g.spentLastHourSats, rate)} · Total: {money(g.totalSats, rate)}
          </span>
          {data.paused && <span style={{ color: gray }}>Paused</span>}
        </div>
      ))}
      {past.length > 0 && (
        <div className="flex flex-col gap-1" style={{ color: gray }}>
          <span>Ended</span>
          {past.map((g) => (
            <span key={g.grantId}>
              {g.originator} · {g.revoked ? 'revoked' : 'expired'} · total {money(g.totalSats, rate)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
