import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { FindMissingCoins } from './FindMissingCoins';
import { useTheme } from '../hooks/useTheme';
import { sendMessageAsync } from '../utils/chromeHelpers';

type SyncAnswer = { success?: boolean; error?: string };

/** Settings › Storage › Sync Now (STORAGE_SYNC_BACKUPS), as a home card with a one-line status. */
export const SyncNowCard = () => {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState('');

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setLine('Syncing…');
    try {
      const r = await sendMessageAsync<SyncAnswer>({ action: 'STORAGE_SYNC_BACKUPS' });
      if (r?.success) setLine('Synced · just now');
      else setLine(r?.error ?? 'Sync failed. Try again.');
    } catch (e) {
      setLine(e instanceof Error ? e.message : 'Sync failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="w-full rounded-xl p-4 space-y-2 bg-[var(--bw-surface)]"
      style={{ border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <div className="flex items-start gap-2.5">
        <RefreshCw size={16} className={`shrink-0 mt-0.5${busy ? ' animate-spin' : ''}`} style={{ color: '#FDB022' }} />
        <div className="flex-1">
          <p className="text-xs font-semibold mb-1" style={{ color: '#F2F4F7' }}>
            Sync now
          </p>
          <p role="status" className="text-[10px] leading-relaxed" style={{ color: '#D0D5DD' }}>
            {line || 'Copy this wallet to your backups now.'}
          </p>
        </div>
      </div>
      <Button
        theme={theme}
        type="primary"
        style={{ background: '#FDB022', color: '#0A0A0B' }}
        label={busy ? 'Syncing…' : 'Sync now'}
        onClick={() => void run()}
        disabled={busy}
      />
    </div>
  );
};

/**
 * Wallet home, at the very bottom (owner, 25 Oct 2026): Find missing coins and Sync now, the same actions as
 * Settings › Storage. Side by side when they fit, stacked otherwise (wrapping, never a sideways strip).
 */
export const HomeShortcuts = () => (
  <div className="bw-home-shortcuts flex flex-wrap gap-3 w-[92%] mb-6" data-testid="home-shortcuts">
    <div className="flex-1 basis-[260px] min-w-0">
      <FindMissingCoins />
    </div>
    <div className="flex-1 basis-[260px] min-w-0">
      <SyncNowCard />
    </div>
  </div>
);
