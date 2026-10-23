/* eslint-disable @typescript-eslint/no-explicit-any */
import { startRoute } from '../calls/popout';
import { YoursEventName } from '../../inject';
import type { YoursNativePlugin } from '../native';

/**
 * "Forgot password": remove the wallet stored on this device so it can be
 * restored from its recovery phrase. Mirrors upstream's Settings sign-out
 * (chrome.storage.local.clear + SIGNED_OUT, whose background handler drops the
 * wallet context, clears the passKey and deletes IndexedDB), plus the mobile
 * extras: the biometric-sealed passKey and its flags. No crypto here.
 *
 * DOM localStorage is cleared too (b-Aware report, 23 Oct 2026): it held the phone-pairing sessions (each with its
 * pairing ECDH key), the revoke queue, the agent report outbox, card and theme caches, and the next wallet restored
 * on the device reconnected the old pairings. Every origin this code runs on is the wallet's own (the Capacitor app,
 * the extension, web.bwalletx.com), so clear() is used rather than a prefix list that new keys could slip past.
 */

const RESTORE_FLAG = 'bwallet:open-restore';
export const RESTORE_ROUTE = '/restore-wallet';

type Deps = {
  chrome: any;
  native: Pick<YoursNativePlugin, 'biometricRemove' | 'secureKeys' | 'secureRemove'>;
  idb?: Pick<IDBFactory, 'databases' | 'deleteDatabase'>;
  session?: Pick<Storage, 'setItem'>;
  local?: Pick<Storage, 'clear'>;
  /** Close live pairing sockets and forget the sessions (pair/sessions.ts closeAllPairings). */
  closePairings?: () => Promise<void> | void;
  wait?: (ms: number) => Promise<void>;
  /** Open the restore screen after the reload (Forgot password). Account deletion passes false. */
  restore?: boolean;
};

const deleteDb = (idb: Pick<IDBFactory, 'deleteDatabase'>, name: string) =>
  new Promise<void>((resolve) => {
    const req = idb.deleteDatabase(name);
    const done = () => resolve();
    req.onsuccess = done;
    req.onerror = done;
    // Still open somewhere: the delete completes once it closes; don't hang the UI.
    req.onblocked = () => setTimeout(done, 1500);
  });

export const wipeLocalWallet = async ({
  chrome,
  native,
  idb = indexedDB,
  session = sessionStorage,
  local = globalThis.localStorage,
  closePairings = async () => (await import('../pair/sessions')).closeAllPairings(),
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  restore = true,
}: Deps): Promise<void> => {
  // Biometrics first, so the old passKey can't come back even if a later step fails.
  await native.biometricRemove({ key: '' }).catch(() => undefined);
  const { keys } = await native.secureKeys().catch(() => ({ keys: [] as string[] }));
  for (const key of keys.filter((k) => k.startsWith('bio:'))) {
    await native.secureRemove({ key }).catch(() => undefined);
  }

  // Paired sites: close the sockets now, so nothing keeps relaying until the reload.
  await Promise.resolve()
    .then(closePairings)
    .catch(() => undefined);
  try {
    local?.clear();
  } catch {
    /* storage unavailable */
  }

  // Upstream sign-out (Settings.tsx): clear local storage, tell the background.
  await chrome.storage.local.clear();
  await chrome.storage.session?.clear?.().catch?.(() => undefined);
  chrome.runtime.sendMessage({ action: YoursEventName.SIGNED_OUT }, () => void chrome.runtime.lastError);
  await wait(300);

  // The background deletes IndexedDB too, but a reload stops its worker; do it here
  // as well and wait. Same filter as background.ts (block header DBs are shared data).
  const dbs = (await idb.databases?.().catch(() => [])) ?? [];
  for (const db of dbs) {
    if (!db.name || db.name.startsWith('block')) continue;
    await deleteDb(idb, db.name);
  }

  if (!restore) return;
  try {
    session.setItem(RESTORE_FLAG, '1');
  } catch {
    /* falls back to the Start screen, which also offers Restore */
  }
};

/** MemoryRouter's first entry: the restore screen once, right after a wipe. */
export const initialRoute = (): string => {
  try {
    if (sessionStorage.getItem(RESTORE_FLAG)) {
      sessionStorage.removeItem(RESTORE_FLAG);
      return RESTORE_ROUTE;
    }
  } catch {
    /* no sessionStorage */
  }
  // The extension's popped-out Calls window opens on /m/calls (calls/popout.ts).
  return startRoute();
};
