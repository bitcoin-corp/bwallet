import { useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from './Button';
import { useTheme } from '../hooks/useTheme';
import { useSnackbar } from '../hooks/useSnackbar';
import { sendMessageAsync } from '../utils/chromeHelpers';
import type { ScanReport } from '../services/findMissingCoins';

type ScanAnswer = { success: boolean; error?: string; data?: { report: ScanReport; headline: string; note: string } };
type RestoreAnswer = { success: boolean; error?: string; data?: { summary: string } };

const bsv = (sats: number) => (sats / 1e8).toFixed(8).replace(/\.?0+$/, '');
const day = (ms?: number) => (ms ? new Date(ms).toLocaleDateString() : '');

/**
 * Settings › Storage (and Troubleshooting): Find missing coins (services/findMissingCoins.ts). Scan is read only;
 * one confirm sheet; the restore never broadcasts or moves coins.
 */
export const FindMissingCoins = () => {
  const { theme } = useTheme();
  const { addSnackbar } = useSnackbar();
  const [busy, setBusy] = useState<'' | 'scan' | 'restore'>('');
  const [scan, setScan] = useState<ScanAnswer['data'] | null>(null);
  const [line, setLine] = useState('');
  const [confirm, setConfirm] = useState(false);

  const runScan = async () => {
    if (busy) return;
    setBusy('scan');
    setLine('');
    setScan(null);
    try {
      const r = await sendMessageAsync<ScanAnswer>({ action: 'STORAGE_FIND_MISSING_COINS' });
      if (!r?.success || !r.data) throw new Error(r?.error ?? 'No answer from the wallet. Try again.');
      setScan(r.data);
      if (r.data.report.found.length) setConfirm(true);
      else setLine([r.data.headline, r.data.note].filter(Boolean).join(' '));
    } catch (e) {
      setLine(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setBusy('');
    }
  };

  const runRestore = async () => {
    setConfirm(false);
    if (!scan?.report.found.length) return;
    setBusy('restore');
    try {
      const r = await sendMessageAsync<RestoreAnswer>({
        action: 'STORAGE_RESTORE_MISSING_COINS',
        txids: scan.report.found.map((c) => c.txid),
      });
      const text = r?.data?.summary ?? r?.error ?? 'No answer from the wallet. Try again.';
      setLine(text);
      addSnackbar(text, r?.success ? 'success' : 'error');
    } catch (e) {
      setLine(e instanceof Error ? e.message : 'Restore failed');
    } finally {
      setBusy('');
      setScan(null);
    }
  };

  const found = scan?.report.found ?? [];

  return (
    <div
      className="w-full rounded-xl p-4 space-y-2 bg-[var(--bw-surface)]"
      style={{ border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <div className="flex items-start gap-2.5">
        <Search size={16} className="shrink-0 mt-0.5" style={{ color: '#FDB022' }} />
        <div className="flex-1">
          <p className="text-xs font-semibold mb-1" style={{ color: '#F2F4F7' }}>
            Find missing coins
          </p>
          <p className="text-[10px] leading-relaxed" style={{ color: '#D0D5DD' }}>
            {line || 'Coins on chain that the wallet stopped counting. We check this device and your backups.'}
          </p>
        </div>
      </div>
      {confirm && found.length > 0 ? (
        <div className="space-y-2" role="dialog" aria-label="Add missing coins back">
          <p className="text-sm font-semibold" style={{ color: '#F2F4F7' }}>
            {scan!.headline}
          </p>
          <ul className="space-y-1">
            {found.map((c) => (
              <li key={c.txid} className="text-[11px]" style={{ color: '#D0D5DD' }}>
                <span className="font-semibold">{bsv(c.sats)} BSV</span>
                {c.createdAt ? ` · ${day(c.createdAt)}` : ''}
                {c.description ? ` · ${c.description}` : ''}
              </li>
            ))}
          </ul>
          <p className="text-[10px]" style={{ color: '#98A2B3' }}>
            Nothing is sent. The wallet just counts these coins again.
          </p>
          <Button
            theme={theme}
            type="primary"
            style={{ background: '#FDB022', color: '#0A0A0B' }}
            label="Add it back"
            onClick={() => void runRestore()}
          />
          <Button theme={theme} type="secondary" label="Not now" onClick={() => setConfirm(false)} />
        </div>
      ) : (
        <Button
          theme={theme}
          type="primary"
          style={{ background: '#FDB022', color: '#0A0A0B' }}
          label={busy === 'scan' ? 'Checking…' : busy === 'restore' ? 'Adding back…' : 'Find missing coins'}
          onClick={runScan}
          disabled={!!busy}
        />
      )}
    </div>
  );
};
