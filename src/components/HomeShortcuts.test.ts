import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// The home DON'T PANIC run (owner, 25 Oct 2026) may only use read/sync routines: no tx building, signing,
// broadcasting, sweeping or store switching. Repair Sync (rebroadcasts and drops token outputs), Find mined payments (can switch stores) and Restore from backup stay
// in Settings only. Coins found by the scan wait for FindMissingCoins' own "Add it back" confirm.
const src = readFileSync(join(import.meta.dir, 'HomeShortcuts.tsx'), 'utf8');

describe('HomeShortcuts DON’T PANIC run', () => {
  test('sends only the allowed background actions', () => {
    const actions = [...src.matchAll(/action:\s*'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(actions).toEqual(['STORAGE_FIND_MISSING_COINS', 'STORAGE_SYNC_BACKUPS']);
  });

  test('calls only the safe shared handlers in the run', () => {
    const handlers = [...src.matchAll(/t\.(handle\w+)\(/g)].map((m) => m[1]);
    expect(new Set(handlers)).toEqual(new Set(['handleResyncCoins', 'handleRecoverTxid']));
    // Recover by txid is a separate user tap after the run, not part of run().
    const runBody = src.slice(src.indexOf('const run = async'), src.indexOf('const done ='));
    expect(runBody).not.toContain('handleRecoverTxid');
  });

  test('never reaches Repair Sync, mined recovery, restore, sweep, sign or broadcast', () => {
    for (const bad of [
      'RECOVER_MINED',
      'STORAGE_REPAIR_SYNC',
      'runRepair',
      'handleRepairSync',
      'handleRecoverMined',
      'RESTORE_BACKUP',
      'RESTORE_MISSING_COINS',
      'sweep',
      'broadcast',
      'createAction',
      'signAction',
      'switchStore',
    ]) {
      expect(src.includes(bad)).toBe(false);
    }
  });
});
