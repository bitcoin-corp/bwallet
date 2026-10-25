import { useContext, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { BottomMenuContext } from '../contexts/BottomMenuContext';
import { useServiceContext } from '../hooks/useServiceContext';
import {
  backupWarning,
  lastBackupLabel,
  REMOTE_BACKUP_KEY,
  type RemoteBackupState,
} from '../services/remoteBackup';

/** The current account's online-backup state (written by initWallet's keeper, services/remoteBackup.ts). */
export const useRemoteBackup = (): RemoteBackupState | undefined => {
  const { chromeStorageService } = useServiceContext();
  const { selectedAccount } = chromeStorageService.getCurrentAccountObject();
  const [state, setState] = useState<RemoteBackupState | undefined>();
  const key = selectedAccount ? REMOTE_BACKUP_KEY(selectedAccount) : '';

  useEffect(() => {
    setState(undefined);
    if (!key) return;
    chrome.storage.local
      .get(key)
      .then((r) => setState(r[key]))
      .catch(() => undefined);
    const onChanged = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && key in c) setState(c[key].newValue);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [key]);

  return state;
};

/**
 * Persistent warning while the online backup isn't connected (wallet safety, 25 Oct 2026). Not dismissable:
 * it goes away by itself once the keeper reconnects and pushes. Tap → Settings › Wallet Backup (Master Backup).
 */
export const RemoteBackupBanner = () => {
  const state = useRemoteBackup();
  const menu = useContext(BottomMenuContext);
  const warning = backupWarning(state);
  if (!warning) return null;
  return (
    <button
      type="button"
      data-testid="remote-backup-warning"
      onClick={() => menu?.handleSelect('settings', 'export-keys-options')}
      className="fixed left-0 right-0 top-0 z-[60] flex items-start gap-2 px-4 py-2 text-left border-0 cursor-pointer"
      style={{
        background: '#3A1512',
        color: '#FECDCA',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)',
      }}
    >
      <AlertTriangle size={16} color="#F97066" className="shrink-0 mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-white">{warning}</span>
        <span className="block text-xs">{lastBackupLabel(state)}</span>
      </span>
    </button>
  );
};

/** Settings › Storage line: last successful online backup. */
export const RemoteBackupLine = () => {
  const state = useRemoteBackup();
  if (!state) return null;
  const warn = !!backupWarning(state);
  return (
    <p
      data-testid="remote-backup-last-sync"
      className="w-full m-0 text-xs select-text"
      style={{ color: warn ? '#F97066' : '#98A2B3' }}
    >
      {lastBackupLabel(state)}
      {warn && state.lastError ? ` · ${state.lastError}` : ''}
    </p>
  );
};
