/**
 * A master restore must never write over or delete rows in a REMOTE active store (wallet.1sat.app): with a remote
 * active the parked backup chunks are dropped, and with a local active they go in through the toolbox's
 * syncFromReader (a merge: rows are inserted or updated, never deleted).
 */
import { describe, expect, test } from 'bun:test';
import { WalletBackupService } from './WalletBackupService';

const svc = WalletBackupService as unknown as Record<string, unknown>;

const withPending = async (fn: () => Promise<void>) => {
  const get = svc.getAccountPendingRestore;
  const clear = svc.clearAccountPendingRestore;
  const cleared: string[] = [];
  svc.getAccountPendingRestore = async () => ({
    manifest: { version: 1, createdAt: '', chain: 'main', identityKey: 'idk', chunkCount: 0 },
    chunks: {},
    chunkCount: 0,
  });
  svc.clearAccountPendingRestore = async (k: string) => {
    cleared.push(k);
  };
  try {
    await fn();
  } finally {
    svc.getAccountPendingRestore = get;
    svc.clearAccountPendingRestore = clear;
  }
  return cleared;
};

describe('master restore is merge-only', () => {
  test('remote active store: nothing is written to it', async () => {
    const calls: string[] = [];
    const storage = {
      getActive: () => ({ isStorageProvider: () => false }),
      syncFromReader: async () => calls.push('syncFromReader'),
      updateBackups: async () => calls.push('updateBackups'),
    };
    await withPending(() => WalletBackupService.importPendingWalletData(storage as never, 'idk', () => {}));
    expect(calls).toEqual([]);
  });

  test('local active store: imported only through syncFromReader (merge), nothing else touched', async () => {
    const calls: string[] = [];
    const storage = {
      getActive: () => ({ isStorageProvider: () => true }),
      syncFromReader: async () => calls.push('syncFromReader'),
    };
    await withPending(() => WalletBackupService.importPendingWalletData(storage as never, 'idk', () => {}));
    expect(calls).toEqual(['syncFromReader']);
  });
});
