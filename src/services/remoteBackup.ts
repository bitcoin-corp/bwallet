/**
 * Online backup watch (wallet safety, 25 Oct 2026).
 *
 * A local-active wallet keeps a copy of its records on a remote store (wallet.1sat.app). When that copy
 * fails to connect, initWallet used to open without it and say nothing: the owner's iPhone held ~$495 of
 * change and BRC-29 outputs that no other device could restore from 12 words. This keeper makes that state
 * visible and self-healing:
 *   - the state is written to chrome.storage.local (REMOTE_BACKUP_KEY) so every screen can warn;
 *   - a failed connection is retried with back-off;
 *   - after it reconnects, the device's records are pushed up (wallet-toolbox syncToWriter: inserts and
 *     updates only, never deletes, so the remote ends up holding the union);
 *   - the last successful push time is kept for Settings → Storage.
 */

export const REMOTE_BACKUP_KEY = (identityAddress: string) => `remoteBackup:${identityAddress}`;

export const BACKUP_WARNING = "Your wallet isn't backed up online. Make a Master Backup.";

export type RemoteBackupState = {
  url: string;
  connected: boolean;
  /** Last time the device's records were pushed up successfully. */
  lastSyncAt?: number;
  lastTriedAt?: number;
  lastError?: string;
  /** Failed attempts in a row (connect or push). */
  failures: number;
  nextRetryAt?: number;
};

const MIN_RETRY_MS = 30_000;
const MAX_RETRY_MS = 30 * 60_000;
/** While connected, push again this often so the last-sync time stays honest. */
export const PUSH_INTERVAL_MS = 10 * 60_000;

/** 30 s, 1 min, 2 min … capped at 30 min. */
export const retryDelayMs = (failures: number) => Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.max(0, failures - 1));

/** The warning to show, or null when the online copy is fine. Only shown when a remote backup is configured. */
export const backupWarning = (s: RemoteBackupState | undefined): string | null =>
  s && (!s.connected || s.lastSyncAt == null) ? BACKUP_WARNING : null;

const ago = (ms: number) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** Settings → Storage line. */
export const lastBackupLabel = (s: RemoteBackupState | undefined, now = Date.now()): string => {
  if (!s) return 'Online backup: not set up';
  const last = s.lastSyncAt != null ? `last backed up ${ago(now - s.lastSyncAt)}` : 'never backed up online';
  if (s.connected && s.lastSyncAt != null) return `Online backup: ${last}`;
  const retry = s.nextRetryAt != null && s.nextRetryAt > now ? ` · retrying in ${ago(-(now - s.nextRetryAt)).replace(' ago', '')}` : '';
  return `Online backup not connected (${last})${retry}`;
};

/** Error text safe to store: first line only, capped, and never anything shaped like key material. */
export const safeError = (e: unknown): string =>
  String((e as Error)?.message ?? e)
    .split('\n')[0]
    .replace(/\b(?:[5KL][1-9A-HJ-NP-Za-km-z]{50,51}|[0-9a-fA-F]{64})\b/g, '[redacted]')
    .slice(0, 200);

export type RemoteBackupDeps = {
  url: string;
  /** Register the remote store with the wallet (createWebWallet's addRemote). */
  connect: () => Promise<void>;
  /** Push this device's records to every backup (WalletStorageManager.updateBackups). */
  push: () => Promise<void>;
  save: (s: RemoteBackupState) => Promise<void> | void;
  load?: () => Promise<RemoteBackupState | undefined>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Wait before the first attempt (boot reads the balance under the same storage lock). */
  firstDelayMs?: number;
};

export type RemoteBackupKeeper = {
  /** Run one step now (connect if needed, then push). Resolves with the state after it. */
  tick: () => Promise<RemoteBackupState>;
  state: () => RemoteBackupState;
  stop: () => void;
};

/**
 * `connected` says whether the remote registered when the wallet opened. The keeper pushes at once (and so
 * records a first lastSyncAt), then keeps pushing on PUSH_INTERVAL_MS; on failure it retries with back-off.
 */
export function startRemoteBackupKeeper(deps: RemoteBackupDeps, connected: boolean): RemoteBackupKeeper {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let state: RemoteBackupState = { url: deps.url, connected, failures: 0 };
  let timer: unknown;
  let stopped = false;
  let running: Promise<RemoteBackupState> | undefined;

  const save = async () => {
    try {
      await deps.save(state);
    } catch {
      // storage write failures must never break the wallet
    }
  };

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      void tick();
    }, ms);
  };

  const step = async (): Promise<RemoteBackupState> => {
    state = { ...state, lastTriedAt: now() };
    try {
      if (!state.connected) {
        await deps.connect();
        state = { ...state, connected: true };
      }
      await deps.push();
      state = { ...state, lastSyncAt: now(), lastError: undefined, failures: 0, nextRetryAt: now() + PUSH_INTERVAL_MS };
      await save();
      schedule(PUSH_INTERVAL_MS);
    } catch (e) {
      const failures = state.failures + 1;
      const wait = retryDelayMs(failures);
      state = { ...state, lastError: safeError(e), failures, nextRetryAt: now() + wait };
      await save();
      console.warn(`[remoteBackup] ${state.connected ? 'push' : 'connect'} failed (${failures}); retry in ${wait} ms`);
      schedule(wait);
    }
    return state;
  };

  const tick = () => {
    if (stopped) return Promise.resolve(state);
    running ??= step().finally(() => {
      running = undefined;
    });
    return running;
  };

  // Keep the last good sync time across launches, then write the current state before trying.
  void (async () => {
    const prev = await deps.load?.().catch(() => undefined);
    if (prev?.url === deps.url && prev.lastSyncAt != null && state.lastSyncAt == null)
      state = { ...state, lastSyncAt: prev.lastSyncAt };
    await save();
    if (deps.firstDelayMs) schedule(deps.firstDelayMs);
    else void tick();
  })();

  return {
    tick,
    state: () => state,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
    },
  };
}
