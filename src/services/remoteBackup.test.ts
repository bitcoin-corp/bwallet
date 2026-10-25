import { describe, expect, test } from 'bun:test';
import {
  BACKUP_WARNING,
  backupWarning,
  lastBackupLabel,
  PUSH_INTERVAL_MS,
  retryDelayMs,
  safeError,
  startRemoteBackupKeeper,
  type RemoteBackupState,
} from './remoteBackup';

const URL_1SAT = 'https://wallet.1sat.app';

/** A keeper with manual timers and a fake clock. Records live in two sets: this device and the remote. */
const harness = (opts: { connected: boolean; connectFails?: number; pushFails?: number }) => {
  let clock = 1_000_000;
  const timers: { fn: () => void; at: number }[] = [];
  const saved: RemoteBackupState[] = [];
  const local = new Set(['tx-a', 'tx-b', 'tx-change', 'brc29-out']);
  const remote = new Set(['tx-a', 'remote-only']);
  let connectFails = opts.connectFails ?? 0;
  let pushFails = opts.pushFails ?? 0;
  let connects = 0;
  let pushes = 0;
  const keeper = startRemoteBackupKeeper(
    {
      url: URL_1SAT,
      connect: async () => {
        connects++;
        if (connectFails-- > 0) throw new Error('WalletStorageClient rpcCall: network error 400');
      },
      push: async () => {
        pushes++;
        if (pushFails-- > 0) throw new Error('WalletStorageClient rpcCall: network error 413');
        // syncToWriter semantics: insert/update only, never delete.
        for (const r of local) remote.add(r);
      },
      save: (s) => {
        saved.push(s);
      },
      now: () => clock,
      setTimer: (fn, ms) => {
        const t = { fn, at: clock + ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        const i = timers.indexOf(t as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
      firstDelayMs: 1, // so the test drives every attempt
    },
    opts.connected,
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Advance the clock to the next timer and run it. */
  const next = async () => {
    await flush();
    timers.sort((a, b) => a.at - b.at);
    const t = timers.shift();
    if (!t) throw new Error('no timer scheduled');
    clock = t.at;
    t.fn();
    await flush();
    await flush();
    return keeper.state();
  };
  return { keeper, saved, local, remote, next, counts: () => ({ connects, pushes }) };
};

describe('online backup warning', () => {
  test('shows the exact warning while not connected', () => {
    expect(backupWarning({ url: URL_1SAT, connected: false, failures: 1 })).toBe(
      "Your wallet isn't backed up online. Make a Master Backup.",
    );
  });
  test('shows it when connected but nothing pushed yet', () => {
    expect(backupWarning({ url: URL_1SAT, connected: true, failures: 0 })).toBe(BACKUP_WARNING);
  });
  test('quiet once a push succeeded', () => {
    expect(backupWarning({ url: URL_1SAT, connected: true, failures: 0, lastSyncAt: 1 })).toBeNull();
  });
  test('quiet when no remote backup is configured (no state)', () => {
    expect(backupWarning(undefined)).toBeNull();
  });
  test('settings line names the last successful sync', () => {
    const now = 10 * 60 * 60_000;
    expect(lastBackupLabel({ url: URL_1SAT, connected: true, failures: 0, lastSyncAt: now - 5 * 60_000 }, now)).toBe(
      'Online backup: last backed up 5 min ago',
    );
    expect(lastBackupLabel({ url: URL_1SAT, connected: false, failures: 2 }, now)).toBe(
      'Online backup not connected (never backed up online)',
    );
  });
  test('back-off doubles and caps at 30 min', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(50)).toBe(30 * 60_000);
  });
  test('stored errors never carry key-shaped strings', () => {
    const wif = 'L' + '1'.repeat(51);
    expect(safeError(new Error(`bad ${wif}\nstack`))).toBe('bad [redacted]');
    expect(safeError('x'.repeat(500)).length).toBe(200);
  });
});

describe('fallback state and reconnect', () => {
  test('opened without the backup: warns, retries with back-off, then reconnects and pushes the union', async () => {
    const h = harness({ connected: false, connectFails: 2 });

    let s = await h.next(); // first try: connect fails
    expect(s.connected).toBe(false);
    expect(s.failures).toBe(1);
    expect(backupWarning(s)).toBe(BACKUP_WARNING);
    expect(s.nextRetryAt! - s.lastTriedAt!).toBe(30_000);

    s = await h.next(); // second try fails, longer wait
    expect(s.failures).toBe(2);
    expect(s.nextRetryAt! - s.lastTriedAt!).toBe(60_000);
    expect(h.remote.has('tx-change')).toBe(false);

    s = await h.next(); // third try connects and pushes
    expect(s.connected).toBe(true);
    expect(s.failures).toBe(0);
    expect(s.lastSyncAt).toBe(s.lastTriedAt);
    expect(backupWarning(s)).toBeNull();
    // Every local record is now on the remote, and nothing the remote held was deleted.
    for (const r of h.local) expect(h.remote.has(r)).toBe(true);
    expect(h.remote.has('remote-only')).toBe(true);
    expect(h.counts()).toEqual({ connects: 3, pushes: 1 });
    // The warning state was persisted before the success, so the UI saw it.
    expect(h.saved.some((x) => !x.connected)).toBe(true);
    expect(h.saved.at(-1)!.connected).toBe(true);
    h.keeper.stop();
  });

  test('connected at boot: pushes once, then on the interval; a failed push warns and retries', async () => {
    const h = harness({ connected: true, pushFails: 0 });
    let s = await h.next();
    expect(s.lastSyncAt).toBeDefined();
    expect(s.nextRetryAt! - s.lastTriedAt!).toBe(PUSH_INTERVAL_MS);
    expect(h.counts().connects).toBe(0);
    h.keeper.stop();

    const f = harness({ connected: true, pushFails: 1 });
    s = await f.next();
    expect(s.lastError).toBe('WalletStorageClient rpcCall: network error 413');
    expect(s.failures).toBe(1);
    expect(backupWarning(s)).toBe(BACKUP_WARNING);
    s = await f.next();
    expect(s.failures).toBe(0);
    expect(backupWarning(s)).toBeNull();
    f.keeper.stop();
  });
});
