import { useEffect, useState } from 'react';
import { Database, ChevronRight } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useStorageRepair } from '../../hooks/useStorageRepair';
import { ErrorActions } from '../errors/ErrorActions';
import { RemoteBackupLine } from '../../components/RemoteBackupBanner';
import { SYNC_HEALTH_KEY, storageLabel, syncHealthLabel, type SyncHealth } from '../../services/storageHealth';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const RED = '#F97066';
const oneLine = 'block overflow-hidden text-ellipsis whitespace-nowrap';

/**
 * Where this account's wallet data lives and how its last sync went (owner, 10 Oct 2026). Sits under the
 * "Settings for" card; tap for a plain-English explanation and Repair Sync.
 */
export const StorageBadge = () => {
  const { chromeStorageService } = useServiceContext();
  const { account, selectedAccount } = chromeStorageService.getCurrentAccountObject();
  const [health, setHealth] = useState<SyncHealth | undefined>();
  const [open, setOpen] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const { runRepair } = useStorageRepair();
  const key = selectedAccount ? SYNC_HEALTH_KEY(selectedAccount) : '';

  useEffect(() => {
    if (!key) return;
    chrome.storage.local.get(key).then((r) => setHealth(r[key]));
    const onChanged = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && key in c) setHealth(c[key].newValue);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [key]);

  const label = storageLabel(account?.storageConfig);
  const h = syncHealthLabel(health);
  const tone = h.failing || label.warn ? RED : MUTED;

  return (
    <div className="mt-1" data-testid="storage-badge">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-left border-0 cursor-pointer"
        style={{ background: '#101114' }}
        aria-expanded={open}
        aria-label="Where this account's data is stored"
      >
        <Database size={16} color={label.warn ? RED : GOLD} />
        <span className="min-w-0 flex-1">
          <span className={`${oneLine} text-[13px] font-semibold text-white select-text`}>{label.title}</span>
          <span className={`${oneLine} text-xs select-text`} style={{ color: tone }}>
            {h.text}
          </span>
        </span>
        <ChevronRight size={16} color={MUTED} style={{ transform: open ? 'rotate(90deg)' : '' }} />
      </button>
      {h.failing && h.error && (
        <div className="mt-1 px-1">
          <ErrorActions message={`Wallet sync failing: ${h.error}`} color={RED} />
        </div>
      )}
      {open && (
        <div
          className="mt-1 rounded-xl p-3 text-xs leading-relaxed select-text"
          style={{ background: 'var(--bw-surface)', color: '#D0D5DD' }}
        >
          <p className="m-0 font-bold text-white">{label.title}</p>
          <p className="m-0 mt-0.5" style={{ color: label.warn ? RED : MUTED }}>
            {label.detail}
          </p>
          <p className="m-0 mt-2">
            Your <b>keys</b> never leave this device. The wallet&apos;s <b>records</b> (balance, coins, tokens and
            history) live where it says above, and a backup server keeps a copy so another device can pick them up. The
            money itself is on the BSV blockchain, not on any server.
          </p>
          <p className="m-0 mt-2" style={{ color: MUTED }}>
            {h.text}
          </p>
          <div className="mt-1">
            <RemoteBackupLine />
          </div>
          <button
            type="button"
            disabled={repairing}
            onClick={async () => {
              setRepairing(true);
              try {
                await runRepair();
              } finally {
                setRepairing(false);
              }
            }}
            className="mt-3 rounded-full px-4 py-2 text-sm font-bold border-0 cursor-pointer"
            style={{ background: GOLD, color: '#000', opacity: repairing ? 0.6 : 1 }}
          >
            {repairing ? 'Repairing…' : 'Repair Sync'}
          </button>
        </div>
      )}
    </div>
  );
};
