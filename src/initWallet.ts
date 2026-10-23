import { openAccountPermissionStore } from './services/accountPermissionStore';
import { openSpendLedger, withLocalSpendLedger } from './services/spendLedger';
import { rememberRefusals } from './services/broadcastRefusals';
import { knownOnChain, recoverMinedFailedActions, type RecoverReport } from './services/recoverFailed';
import { singleFlight } from './services/addressResync';
import { sizeAwareBroadcast } from './services/bigBroadcast';
import { releaseStuckSends, type QueuedSend, type ReleaseReport } from './services/stuckSends';
import {
  createWebWallet,
  createIndexedDbTaskStateStore,
  type WebWalletConfig,
  Wallet,
  WalletStorageManager,
  StorageClient,
  LocalWalletPermissionsManager,
  IndexedDbPermissionStore,
} from '@1sat/wallet-browser';
import { preserveOriginalErrors } from './services/permissionAbortGuard';
import { guardReservedBaskets, revokeReservedBasketGrants } from './services/reservedBaskets';
import { guardReservedProtocols, revokeReservedProtocolGrants } from './services/reservedProtocols';
import { guardSpending } from './mobile/config/killSwitch';
import {
  syncAddresses,
  syncMessages,
  sweepDeposit,
  internalizeBeef,
  signP2PKHInput,
  deriveDepositAddresses,
  createContext as createActionContext,
} from '@1sat/actions';
import { BSV21_BASKET, DEPOSIT_BASKET, FUNDING_BASKET, ONESAT_BASKET, ONESAT_PROTOCOL } from '@1sat/types';
import { createAssetPermissionModules } from '@1sat/permission-module';
import { Beef, Transaction, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import { rescueStuckOutputs, type DepositDerivation } from './services/receiveRescue';
import { ChromeStorageService } from './services/ChromeStorage.service';
import { MESSAGEBOX_URL } from './utils/constants';
import type { Account, StorageConfig } from './services/types/chromeStorage.types';
import { decrypt } from './utils/crypto';
import type { Keys } from './utils/keys';
import { initSyncContext, type SyncContext } from './initSyncContext';
import { refileLegacyBaskets } from './services/legacyBaskets';
import { readReconcileRecord, reconcileStorage } from './services/storageReconcileBackground';
import { shouldResumeReconcile } from './services/storageReconcile';
import { showOneSatPrompt } from './services/oneSatPrompt';
import {
  runSpendPass,
  runStaleFix,
  runUnseenHeal,
  runStartupTokenHeal,
  runTokenRecovery,
  type TokenHealArgs,
} from './services/tokenRecoveryWallet';
import type { HealAction, SpendPassReport, StaleFixResult, UnseenHealReport } from './services/tokenSendHeal';
import { planAddressScan, resetSyncCursor } from './services/addressScan';
import {
  checkReceiveAddresses,
  markMoved,
  movedEntries,
  normOutpoint,
  restoreMoved,
  setArriving,
} from './services/receiveGuard';
import { internalizeBackoff } from './services/internalizeBackoff';
import { fixUtxoStatus, utxoStatusFromTxo } from './services/utxoStatus';
import { restorePaymailHistory, type PaymailRestoreReport } from './mobile/names/paymail';
import { makeRecoverDeps, runRecoverOnce } from './services/recoverFailedWiring';
import { recoverPaymentByTxid, type TxidRecoverReport } from './services/recoverByTxid';
import { makePostageReconcileWiring, makeTxidRecoverDeps, sweepCandidateTxids } from './services/recoverByTxidWiring';
import { reconcilePostage, wocIsMined, type PostageReconcileReport } from './services/postageReconcile';
import { chainActive } from './services/dappChain';
import { healthStatus, SYNC_HEALTH_KEY } from './services/storageHealth';
import type { TokenRecoveryOptions, TokenRecoveryResult } from './services/tokenRecovery';

// Admin originator for the extension (bypasses all permission checks). The bare
// extension ID, as ChromeCWI sends it: toolbox permission checks reject a URL
// scheme. ⚠ A web page CAN have this host (http://<extid>/ on a network that resolves
// single-label names), so the background router grants admin only to the extension's own
// pages and refuses this originator from any other sender (services/adminOriginator.ts).
export const ADMIN_ORIGINATOR = chrome.runtime.id;

/**
 * Wrap a wallet so every method call pre-binds `originator` to the supplied
 * value. Used to route internal-wallet calls (background sync, etc.) through
 * the permissions manager as the admin originator — encryption/decryption
 * still applies, permission prompts are short-circuited via the
 * `isAdminOriginator` check inside the manager.
 */
function withOriginator(wallet: WalletInterface, originator: string): WalletInterface {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return function (...args: unknown[]) {
        if (args.length < 2 || args[1] === undefined) {
          return (value as (...a: unknown[]) => unknown).call(target, args[0], originator);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as WalletInterface;
}

/**
 * Decrypt keys from chrome storage using the passKey from session storage.
 * Throws if account or passKey is missing (caller should ensure authentication first).
 */
const decryptKeys = async (chromeStorageService: ChromeStorageService): Promise<Keys> => {
  const { account } = chromeStorageService.getCurrentAccountObject();
  const passKey = await chromeStorageService.getPassKey();

  if (!account?.encryptedKeys) {
    throw new Error('No account found - wallet not initialized');
  }
  if (!passKey) {
    throw new Error('No passKey found - user not authenticated');
  }

  const decrypted = await decrypt(account.encryptedKeys, passKey);
  return JSON.parse(decrypted) as Keys;
};

/**
 * Account context containing wallet and necessary sync components.
 * All components share the same lifecycle (account-specific).
 */
/** The receive guard's stuck-output rescue broadcast (receiveRescue.ts). Off: see runReceiveGuard. */
const RESCUE_AUTO_BROADCAST = false as boolean;

export interface AccountContext {
  wallet: LocalWalletPermissionsManager;
  baseWallet: Wallet;
  syncContext: SyncContext;
  storage: WalletStorageManager;
  remoteStorage?: StorageClient;
  /** The grant store the permissions manager reads (one-sheet connect writes the monthly allowance here). */
  permissionStore: IndexedDbPermissionStore;
  setActiveStorage: (target: 'local' | string) => Promise<void>;
  addRemote: (url: string) => Promise<void>;
  /** Find and import token outputs the wallet owns on chain but has no record of (tokenRecovery.ts). */
  recoverTokens: (options?: TokenRecoveryOptions) => Promise<TokenRecoveryResult>;
  /** "Fix and send": one token's spent records dropped and its valid change imported (tokenSendHeal.ts). */
  fixStaleToken: (tokenId: string) => Promise<StaleFixResult>;
  /** Repair Sync's final pass: relinquish token outputs the overlay or chain reports spent. */
  dropSpentTokens: () => Promise<SpendPassReport>;
  /** Token outputs the overlay doesn't know: submit, rebroadcast, or relinquish (all tokens, or one). */
  healUnseenTokens: (tokenId?: string, keysOnly?: boolean) => Promise<UnseenHealReport>;
  /** Run the address sync now, or join the run already in flight (services/addressResync.ts). Quiet = no spinner. */
  resyncAddresses: (options?: { quiet?: boolean }) => Promise<void>;
  /** When the last address sync finished (ms since epoch), 0 before the first. */
  lastAddressSyncAt: () => number;
  /** True while an address sync is running. */
  addressSyncBusy: () => boolean;
  /** Move anything waiting in the deposit basket into the funding basket (sweepDeposit). */
  sweepDeposits: () => Promise<{ swept?: number }>;
  /** Credit payments seen on chain at our receive addresses that storage lacks (receive guard), now. */
  creditArriving: () => Promise<void>;
  /** Restore actions storage marked failed whose transaction is mined (services/recoverFailed.ts). */
  recoverFailed: () => Promise<RecoverReport>;
  /** Recover one mined payment by txid from the derivation any reachable store holds (services/recoverByTxid.ts). */
  recoverTxid: (txid: string, progress?: (step: string) => void) => Promise<TxidRecoverReport>;
  /** Settle bMail postage held as nosend/unsent whose tx the chain says is mined (services/postageReconcile.ts). */
  reconcilePostage: (force?: boolean) => Promise<PostageReconcileReport>;
  /** Sweep txids from this wallet's own records, for Find mined payments (recoverByTxidWiring.ts). */
  sweepCandidates: () => Promise<string[]>;
  /** Re-internalize paymail receipts the server recorded that this device lacks (restore from seed, 14 Oct 2026). */
  restorePaymails: () => Promise<PaymailRestoreReport>;
  /** Cancel queued sends that never reached the network after GIVE_UP_MS, releasing inputs (stuckSends.ts). */
  releaseStuckSends: () => Promise<ReleaseReport>;
  /** Run the Monitor's SendWaiting task now (a big send was queued: services/bigDelayed.ts). */
  sendWaitingNow: () => Promise<string>;
  /** Bytes storage holds for an action reference (unsigned tx + input BEEF), 0 when unknown. */
  referenceBytes: (reference: string) => Promise<number>;
  /** True when the network already knows this txid (never abort such an action). */
  knownOnChain: (txid: string) => Promise<boolean>;
  /** Call to stop sync and destroy wallet */
  close: () => Promise<void>;
}

/**
 * Resolve a per-account storage config into the flat fields the SDK factory
 * expects. Missing storageConfig → local-only (no remotes).
 */
const resolveStorageConfig = (
  storageConfig: StorageConfig | undefined,
): { activeRemote?: string; backups?: string[] } => {
  if (!storageConfig) {
    return {};
  }
  const { activeRemote, remotes = [] } = storageConfig;
  // `remotes[]` holds every configured remote including the active; filter
  // the active out before passing to the factory so it doesn't double-connect.
  const backups = activeRemote ? remotes.filter((url) => url !== activeRemote) : remotes;
  return { activeRemote, backups };
};

/**
 * Read the per-install storageIdentityKey from chrome storage, generating
 * and persisting a new random value on first use. Shared across all
 * accounts on this install — the identity is a property of the local
 * IndexedDB, not of any individual account. Distinct from other installs
 * of the same account on the same remote so `WalletStorageManager` can
 * correctly identify which local store is authoritative.
 */
const ensureStorageIdentityKey = async (chromeStorageService: ChromeStorageService): Promise<string> => {
  const existing = chromeStorageService.getCurrentAccountObject().storageIdentityKey;
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const key = `yours-${hex}`;
  await chromeStorageService.update({ storageIdentityKey: key });
  return key;
};

export interface InitWalletOptions {
  onTransactionBroadcasted?: (txid: string) => void;
  onTransactionProven?: (txid: string) => void;
  /**
   * Runs once the wallet and storage are ready but BEFORE the address and
   * message syncs start. Work that needs the toolbox's exclusive sync lock
   * (a pending backup import) must happen here: the address sync holds
   * reader/writer locks almost continuously and the sync lock waits for all
   * of them, so an import started after it never gets in.
   */
  beforeSync?: (ctx: { storage: WalletStorageManager }) => Promise<void>;
  /** Runs once the address sync has completed (not on its failure). Errors are logged, never thrown. */
  afterSync?: (ctx: { storage: WalletStorageManager }) => Promise<void>;
}

/**
 * Open storage for the *currently selected* account for master backup only.
 * No address sync, permissions UI, or accountContext side effects.
 * Caller must set selectedAccount before calling, and await close() when done.
 */
export const openAccountStorageForBackup = async (
  chromeStorageService: ChromeStorageService,
): Promise<{ storage: WalletStorageManager; close: () => Promise<void> }> => {
  await chromeStorageService.getAndSetStorage();
  const keys = await decryptKeys(chromeStorageService);
  if (!keys.identityWif) {
    throw new Error('No identity key found in decrypted keys');
  }

  const { account } = chromeStorageService.getCurrentAccountObject();
  const { activeRemote, backups } = resolveStorageConfig(account?.storageConfig);
  const storageIdentityKey = await ensureStorageIdentityKey(chromeStorageService);

  const { storage, destroy, monitor } = await createWebWallet({
    privateKey: keys.identityWif,
    chain: 'main',
    feeModel: { model: 'sat/kb', value: chromeStorageService.getCustomFeeRate() },
    activeRemote,
    backups,
    storageIdentityKey,
    taskStateStore: createIndexedDbTaskStateStore(),
    // No boot runOnce: its BackupSync (which now also runs for a remote active store; toolbox patch) would contend
    // with the backup's getSyncChunk. stopTasks below only ends a task loop; it cannot recall a runOnce in flight.
    skipInitialMonitor: true,
  });

  // Stop monitor work so BackupSync/runOnce does not contend with getSyncChunk.
  try {
    monitor.stopTasks();
  } catch {
    // ignore
  }

  return {
    storage,
    close: async () => {
      await destroy();
    },
  };
};

/**
 * Initialize the Wallet instance with all sync components.
 *
 * Uses remote storage as the sole storage backend — no local IndexedDB.
 * The server handles transaction lifecycle (broadcasting, proof checking).
 *
 * Throws if account or passKey is missing (caller should ensure authentication first).
 * Call this after user authentication (unlock).
 */
export const initWallet = async (
  chromeStorageService: ChromeStorageService,
  options?: InitWalletOptions,
): Promise<AccountContext> => {
  // Ensure storage is loaded
  await chromeStorageService.getAndSetStorage();

  // 1. BROWSER-SPECIFIC: Decrypt keys
  const keys = await decryptKeys(chromeStorageService);
  if (!keys.identityWif) {
    throw new Error('No identity key found in decrypted keys');
  }

  const chain = 'main' as const;

  // 2. Create wallet using browser factory. Storage topology comes from the
  // current account's persisted storageConfig. storageIdentityKey is
  // per-install and lazily materialized.
  const { account } = chromeStorageService.getCurrentAccountObject();
  const { activeRemote, backups } = resolveStorageConfig(account?.storageConfig);
  const storageIdentityKey = await ensureStorageIdentityKey(chromeStorageService);

  const walletConfig: WebWalletConfig = {
    privateKey: keys.identityWif,
    chain,
    feeModel: { model: 'sat/kb', value: chromeStorageService.getCustomFeeRate() },
    activeRemote,
    backups,
    storageIdentityKey,
    taskStateStore: createIndexedDbTaskStateStore(),
  };

  const t0 = Date.now();
  const mark = (step: string) => console.log(`[initWallet] +${Date.now() - t0}ms ${step}`);
  mark(`createWebWallet start (activeRemote=${activeRemote ?? 'local'}, backups=${backups?.length ?? 0})`);
  const {
    wallet: baseWallet,
    destroy: destroyWallet,
    storage,
    remoteStorage,
    setActiveStorage,
    addRemote,
    monitor: walletMonitor,
    services: toolboxServices,
  } = await createWebWallet(walletConfig).catch(async (err: unknown) => {
    // A backup that won't connect (e.g. 1Sat answering HTTP 400 to the iPhone WebView's auth
    // handshake) must not take the whole wallet down: the device's own copy is authoritative when
    // it's active. Open without backups; the address sync still finds funds on chain.
    if (activeRemote || !backups?.length) throw err;
    console.warn('[initWallet] backup storage failed to connect; opening without it:', err);
    return createWebWallet({ ...walletConfig, backups: [] });
  });
  mark(
    `createWebWallet done; active=${storage.getActiveStoreName?.() ?? '?'} stores=${JSON.stringify(
      storage.getStores?.().map((s) => ({ name: s.storageName, active: s.isActive, enabled: s.isEnabled })) ?? [],
    )}`,
  );

  // Big mints need longer than the broadcaster's fixed 30 s to upload (services/bigBroadcast.ts, vexvoid 12 Oct 2026).
  if (!sizeAwareBroadcast(toolboxServices)) console.warn('[initWallet] broadcaster timeout not tunable');
  // Every payment ends here: our screens and dApps through the permissions manager, send-all and background jobs
  // directly. The `spending` kill switch pauses createAction/signAction on it (mobile/config/killSwitch.ts).
  guardSpending(baseWallet);
  if (!rememberRefusals(toolboxServices)) console.warn('[initWallet] broadcast refusals not recorded');
  // UnFail's output verdicts read getUtxoStatus: parse api.1sat.app's "txid.vout" (dkg, 14 Oct 2026; services/utxoStatus.ts).
  if (!fixUtxoStatus(toolboxServices)) console.warn('[initWallet] getUtxoStatus not patched (no txo client)');

  // 3. Build the IndexedDB-backed permission store used by
  //    LocalWalletPermissionsManager for basket/cert/spending grants.
  //    One store per account (b-Aware report, 23-24 Oct 2026): grants and allowances never cross accounts.
  const accountId =
    chromeStorageService.getCurrentAccountObject().selectedAccount || account?.addresses?.identityAddress;
  // No account yet (fresh install): a store of its own, never the legacy shared one, so start-up cannot fail here.
  const permissionStore = await openAccountPermissionStore(
    accountId || 'no-account',
    chromeStorageService.getAllAccounts().length,
  );

  // Month-to-date app spend kept on this device, per account, so a remote storage server cannot under-report it
  // and let payments past a monthly allowance through (services/spendLedger.ts, b-Aware report 23 Oct 2026).
  const spendLedger = await openSpendLedger(accountId || 'no-account');

  // 4. Build per-asset permission modules (1sat / opns / bsv21 / lock).
  //    Shared toolkit; separate BRC-99 scheme ids. Base wallet is used for
  //    internal apply crypto so createSignature does not re-prompt.
  const assetModules = createAssetPermissionModules({
    wallet: baseWallet,
    promptHandler: showOneSatPrompt,
    adminOriginator: ADMIN_ORIGINATOR,
    // Reuse the same permission store the LocalWalletPermissionsManager
    // uses, so basket grants persisted via the grouped-permission popup
    // are picked up by the module's basket-access checks (and vice versa).
    permissionStore,
  });

  // 5. Wrap with permissions manager for external app access control.
  // Grants persist in IndexedDB (off-chain) via LocalWalletPermissionsManager.
  // Wallet-internal protocols (bTrust, Locks, funds, presign…) are refused to every outside originator before any
  // prompt (services/reservedProtocols.ts, security audit 19 Oct 2026 C1).
  // The wallet's own baskets (coins, ordinals, tokens, locks, names) likewise (services/reservedBaskets.ts).
  const wallet = guardReservedBaskets(
    guardReservedProtocols(
      preserveOriginalErrors(
        withLocalSpendLedger(
          new LocalWalletPermissionsManager(
            baseWallet,
            ADMIN_ORIGINATOR,
            { permissionModules: assetModules },
            { store: permissionStore },
          ),
          spendLedger,
        ),
      ),
      ADMIN_ORIGINATOR,
    ),
    ADMIN_ORIGINATOR,
  );
  // Upgrade migration (C1): grants a site already holds for a reserved protocol are removed. Idempotent.
  await revokeReservedProtocolGrants(permissionStore, ADMIN_ORIGINATOR)
    .then((n) => n && console.warn(`[initWallet] revoked ${n} app grant(s) for wallet-internal protocols`))
    .catch((e: unknown) => console.warn('[initWallet] reserved-protocol grant cleanup failed:', e));
  await revokeReservedBasketGrants(permissionStore, ADMIN_ORIGINATOR)
    .then((n) => n && console.warn(`[initWallet] revoked ${n} app grant(s) for wallet-internal baskets`))
    .catch((e: unknown) => console.warn('[initWallet] reserved-basket grant cleanup failed:', e));

  // 5. Initialize sync context (derives addresses, creates services, queue, addressManager).
  // Background sync calls go through the manager-wrapped wallet (admin
  // originator pre-bound) so internalizeAction encrypts customInstructions
  // consistently with dApp-initiated writes. Without this wrap, sync would
  // bypass the manager entirely and produce plaintext customInstructions —
  // creating mixed-encoding rows that break later reads.
  const adminWallet = withOriginator(wallet, ADMIN_ORIGINATOR);

  mark('permissions + sync context ready');

  const maxKeyIndex = account?.settings?.maxKeyIndex ?? 4; // default: 0-4 = 5 addresses
  const syncContext = await initSyncContext({
    wallet: adminWallet,
    chain,
    maxKeyIndex,
  });

  // 5b. Persist the primary address so other accounts can display it in the UI.
  // Only set it if the account doesn't already have one — preserve the user's
  // selection from the receive screen across lock/unlock and account switches.
  if (!account?.primaryAddress) {
    const primaryAddress = syncContext.addressManager.getPrimaryAddress();
    if (primaryAddress) {
      const identityAddress = keys.identityAddress;
      chromeStorageService.updateNested('accounts', {
        [identityAddress]: { primaryAddress } as unknown as Account,
      });
    }
  }

  // 6. Run address sync via syncAddresses action (fire-and-forget)
  const actionCtx = createActionContext(adminWallet, { chain, services: syncContext.services });

  const sendSyncStatus = (data: { status: string; [key: string]: unknown }) => {
    // Remember the outcome for the storage badge on Settings (services/storageHealth.ts).
    if (['complete', 'error', 'sweep-failed', 'receive-failed', 'arriving'].includes(data.status)) {
      const error =
        typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : undefined;
      const health = {
        status: healthStatus(data.status, error),
        at: Date.now(),
        error,
        satoshis: typeof data.satoshis === 'number' ? data.satoshis : undefined,
      };
      chrome.storage.local.set({ [SYNC_HEALTH_KEY(keys.identityAddress)]: health }).catch(() => undefined);
    }
    chrome.runtime
      .sendMessage({
        action: 'syncStatusUpdate',
        data,
      })
      .catch(() => {
        // Ignore errors if popup is not open
      });
  };

  if (options?.beforeSync) {
    mark('beforeSync start');
    try {
      await options.beforeSync({ storage });
    } catch (err) {
      console.error('[initWallet] beforeSync failed:', err);
    }
    mark('beforeSync done');
  }

  // Wallet-data migrations. After beforeSync so a restored backup's data is in
  // storage before they look at it, and before the address sync, whose locks
  // would keep the reconcile's sync lock waiting.
  const stampDataVersion = (dataVersion: number) =>
    chromeStorageService.updateNested('accounts', {
      [keys.identityAddress]: { dataVersion } as unknown as Account,
    });
  // Steps run in order; each stamps its own version (see ACCOUNT_DATA_VERSION).
  let dataVersion = account?.dataVersion ?? 0;

  if (dataVersion < 1) {
    mark('legacy basket migration start');
    try {
      await refileLegacyBaskets(storage);
      await stampDataVersion(1);
      dataVersion = 1;
    } catch (err) {
      console.error('[initWallet] legacy basket migration failed; will retry next open', err);
    }
    mark('legacy basket migration done');
  }

  // Runs once whatever the outcome: a failed run leaves its record for
  // Settings > Troubleshooting, where the user can retry. Only a run the
  // worker never finished (no stamp) is tried again on the next open.
  if (dataVersion === 1) {
    const config = account?.storageConfig;
    const remoteUrl = config?.activeRemote || config?.remotes?.[0];
    if (remoteUrl) {
      mark('storage reconcile migration start');
      await reconcileStorage(storage, syncContext.services, remoteUrl, 'migration').catch((err) =>
        console.error('[initWallet] storage reconcile migration failed:', err),
      );
      mark('storage reconcile migration done');
    }
    await stampDataVersion(2);
  }

  // A repair the extension worker was stopped in the middle of (not one that failed) runs again
  // on the next open, even if its notice was dismissed, up to MAX_RECONCILE_RESUMES times.
  // The repair overlay shows its progress while it runs.
  if (dataVersion >= 1) {
    const config = account?.storageConfig;
    const remoteUrl = config?.activeRemote || config?.remotes?.[0];
    const previous = remoteUrl ? await readReconcileRecord().catch(() => undefined) : undefined;
    if (remoteUrl && previous && shouldResumeReconcile(previous)) {
      mark('storage reconcile resume start');
      await reconcileStorage(
        storage,
        syncContext.services,
        remoteUrl,
        previous.trigger,
        (previous.resumeAttempts ?? 0) + 1,
      ).catch((err) => console.error('[initWallet] resumed storage reconcile failed:', err));
      mark('storage reconcile resume done');
    }
  }

  const recoverTokens = (recoveryOptions?: TokenRecoveryOptions) =>
    runTokenRecovery({
      wallet: adminWallet,
      services: syncContext.services,
      identityWif: keys.identityWif,
      chain,
      options: recoveryOptions,
      addresses: () => [...syncContext.addressManager.getAddresses(), keys.identityAddress],
    });

  const tokenHealArgs: TokenHealArgs & { addresses: () => string[] } = {
    wallet: adminWallet,
    listFailedActions: async () =>
      (
        await baseWallet.listFailedActions(
          { labels: [], includeOutputs: true, includeOutputLockingScripts: true, limit: 200 },
          false,
        )
      ).actions as unknown as HealAction[],
    services: syncContext.services,
    identityWif: keys.identityWif,
    chain,
    addresses: () => [...syncContext.addressManager.getAddresses(), keys.identityAddress],
  };
  const fixStaleToken = (tokenId: string) => runStaleFix(tokenHealArgs, tokenId);
  const dropSpentTokens = () => runSpendPass(tokenHealArgs);
  const healUnseenTokens = (tokenId?: string, keysOnly?: boolean) =>
    runUnseenHeal(tokenHealArgs, { tokenId, keysOnly });
  let tokenHealDone = false;
  /** Once per open: token sends broadcast but left unfinished (a suspended Safari tab), then the usual walk. */
  const startupTokenHeal = async () => {
    if (tokenHealDone) return;
    tokenHealDone = true;
    try {
      const r = await runStartupTokenHeal(tokenHealArgs);
      if (r.imported.length || r.errors.length || r.journalled.length) console.log('[initWallet] token send heal:', r);
    } catch (err) {
      console.error('[initWallet] token send heal failed:', err);
    }
  };

  // Scan past maxKeyIndex (addresses handed out on other devices) and rescan history once whenever that window
  // reaches indexes this device never scanned: the sync's one resume cursor would otherwise skip their payments
  // (owner, 10 Oct 2026: 0.254 BSV at a fresh address never showed). services/addressScan.ts.
  const scanPlan = planAddressScan(maxKeyIndex, account?.settings?.addressScanThrough);
  if (scanPlan.resetCursor) {
    try {
      const { publicKey: idKey } = await adminWallet.getPublicKey({ identityKey: true });
      const reset = await resetSyncCursor(idKey);
      console.log(
        `[initWallet] Address scan widened to ${scanPlan.count}; history rescan ${reset ? 'queued' : 'not needed'}`,
      );
    } catch (err) {
      console.error('[initWallet] sync cursor reset failed:', err);
    }
  }
  const persistScanThrough = () => {
    const { account: acct, selectedAccount } = chromeStorageService.getCurrentAccountObject();
    if (!acct || !selectedAccount || (acct.settings?.addressScanThrough ?? -1) >= scanPlan.through) return;
    chromeStorageService
      .updateNested('accounts', {
        [selectedAccount]: {
          settings: { ...acct.settings, addressScanThrough: scanPlan.through },
        } as unknown as Account,
      })
      .catch((err: unknown) => console.error('[initWallet] saving addressScanThrough failed:', err));
  };

  // Sweep anything already waiting in the deposit basket now, not only after a sync that finds new payments: a
  // sweep that failed before (or never ran) otherwise leaves received money unspendable until the next payment
  // arrives (owner, 10 Oct 2026, the new $vexvoid account). The balance counts the basket either way
  // (services/depositBalance.ts).
  sweepDeposit
    .execute(actionCtx, {})
    .then((r) => {
      if (r.swept) console.log(`[initWallet] Swept ${r.swept} waiting deposit(s) into the wallet`, r.txid);
    })
    .catch((err: unknown) => {
      console.error('[initWallet] deposit sweep failed:', err);
      sendSyncStatus({ status: 'sweep-failed', error: err instanceof Error ? err.message : String(err) });
    });

  // Deposit derivation for one of our addresses: the address manager's window first, then a wider scan (an
  // address handed out past this device's maxKeyIndex), which is added to the manager so sync and the guard see it.
  const stuckSince = new Map<string, number>();
  // Outputs the wallet already moved, kept across service-worker restarts (services/receiveGuard.ts markMoved).
  const MOVED_KEY = 'bwxMovedOutpoints';
  const rememberMoved = (outpoints: string[]) => {
    markMoved(outpoints);
    chrome.storage?.local
      ?.set({ [MOVED_KEY]: movedEntries() })
      .catch((err: unknown) => console.error('[receiveGuard] saving moved outputs failed:', err));
  };
  try {
    const stored = await chrome.storage?.local?.get(MOVED_KEY);
    restoreMoved(stored?.[MOVED_KEY]);
  } catch {
    /* nothing remembered yet */
  }
  const DERIVATION_SEARCH_LIMIT = 200;
  let derivationSearchedThrough = -1;
  const depositDerivationFor = async (address: string): Promise<DepositDerivation | null> => {
    const am = syncContext.addressManager;
    const known = am.getDerivation(address);
    if (known) return { address, derivationPrefix: known.derivationPrefix, derivationSuffix: known.derivationSuffix };
    const start = Math.max(am.getMaxKeyIndex() + 1, derivationSearchedThrough + 1);
    if (start > DERIVATION_SEARCH_LIMIT) return null;
    const { derivations } = await deriveDepositAddresses.execute(
      { wallet: adminWallet, services: syncContext.services, chain, isBaseWallet: true },
      { startIndex: start, count: DERIVATION_SEARCH_LIMIT - start + 1 },
    );
    derivationSearchedThrough = DERIVATION_SEARCH_LIMIT;
    const hit = derivations.find((d) => d.address === address);
    if (!hit) return null;
    am.addAddress(hit);
    console.log(`[receiveGuard] ${address} is deposit index ${hit.index}; added to the address manager`);
    return { address, derivationPrefix: hit.derivationPrefix, derivationSuffix: hit.derivationSuffix };
  };

  // The address the Receive screen shows must always count (services/receiveGuard.ts; owner, 10 Oct 2026:
  // $5 at the $vexvoid receive address never showed). Runs after every address sync, clean or not.
  const receiveGuardOnce = async () => {
    // Never between the steps of a connected site's multi-step action (services/dappChain.ts).
    if (chainActive()) {
      console.log('[receiveGuard] a site action is in progress; check deferred');
      return;
    }
    const shown = chromeStorageService.getCurrentAccountObject().account?.primaryAddress;
    const addresses = [...(shown ? [shown] : []), ...syncContext.addressManager.getAddresses()];
    const walletOutpoints = async () => {
      const all: string[] = [];
      for (const basket of [FUNDING_BASKET, DEPOSIT_BASKET, ONESAT_BASKET, BSV21_BASKET]) {
        try {
          const r = await baseWallet.listOutputs({ basket, limit: 10000 });
          for (const o of r.outputs) all.push(o.outpoint);
        } catch {
          /* a basket that can't be read just isn't counted as known */
        }
      }
      return all;
    };
    const outputSats = async (outpoint: string) => {
      const [txid, vout] = normOutpoint(outpoint).split('.');
      const raw = await syncContext.services.beef.getRawTx(txid);
      return Transaction.fromBinary(Array.from(raw)).outputs[Number(vout)]?.satoshis ?? 0;
    };
    const first = await checkReceiveAddresses(addresses, {
      ownerSync: (a) => syncContext.services.owner.sync(a),
      outputSats,
      walletOutpoints,
    });
    if (!first.satoshis) {
      setArriving(0);
      return;
    }
    console.warn(
      `[receiveGuard] ${first.satoshis} sats at our receive addresses missing from storage; retrying`,
      first,
    );
    const { publicKey: senderIdentityKey } = await adminWallet.getPublicKey({ identityKey: true });
    const derivations = new Map<string, unknown>();
    for (const address of syncContext.addressManager.getAddresses()) {
      const d = syncContext.addressManager.getDerivation(address);
      if (!d) continue;
      derivations.set(address, {
        outputIndex: 0,
        derivationPrefix: d.derivationPrefix,
        derivationSuffix: d.derivationSuffix,
        senderIdentityKey,
        protocolID: ONESAT_PROTOCOL as WalletProtocol,
        counterparty: 'self',
      });
    }
    for (const txid of first.txids) {
      // A txid that storage can't take (e.g. its action is marked failed) is not retried on every sync.
      if (!internalizeBackoff.due(txid)) continue;
      try {
        const beef = await syncContext.services.beef.getBeef(txid);
        const r = await internalizeBeef({
          beef,
          addressDerivations: derivations as Parameters<typeof internalizeBeef>[0]['addressDerivations'],
          wallet: adminWallet,
          services: syncContext.services,
          chain,
        });
        // internalizeBeef resolves with internalized: 0 when no output matched a derivation: not a success.
        if (r.internalized) {
          internalizeBackoff.clear(txid);
          console.log(`[receiveGuard] internalized ${txid} (${r.internalized} output(s))`);
        } else {
          internalizeBackoff.fail(txid, 'no output matched');
          console.warn(`[receiveGuard] ${txid}: no output matched our derivations`);
        }
      } catch (err) {
        const wait = internalizeBackoff.fail(txid, err);
        console.error(`[receiveGuard] internalize ${txid} failed (next try in ${Math.round(wait / 60000)} min):`, err);
        sendSyncStatus({ status: 'receive-failed', txid, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await sweepDeposit
      .execute(actionCtx, {})
      .catch((err: unknown) => console.error('[receiveGuard] sweep failed:', err));
    const after = await checkReceiveAddresses(addresses, {
      ownerSync: (a) => syncContext.services.owner.sync(a),
      outputSats,
      walletOutpoints,
    });
    // Still missing after a direct internalize: storage won't take this txid (services/receiveRescue.ts). Spend
    // each stuck output back to the same address in a fresh transaction and credit that one instead.
    let final = after;
    // Off (audit, 11 Oct 2026): the rescue broadcast outside storage and could double-spend an in-flight spend,
    // because walletOutpoints only lists spendable outputs. Stuck money now just counts as arriving.
    if (RESCUE_AUTO_BROADCAST && after.satoshis) {
      const rescued = await rescueStuckOutputs(after.outputs, {
        getRawTx: async (txid) => Array.from(await syncContext.services.beef.getRawTx(txid)),
        getBeef: async (txid) => Array.from(await syncContext.services.beef.getBeef(txid)),
        isConfirmed: async (txid) => {
          try {
            const b = Beef.fromBinary(Array.from(await syncContext.services.beef.getBeef(txid)));
            return b.findTxid(txid)?.bumpIndex !== undefined;
          } catch {
            return false;
          }
        },
        derivationFor: (address) => depositDerivationFor(address),
        signInput: async (tx, i, protocolID, keyID) => {
          const r = await signP2PKHInput(actionCtx, tx, i, protocolID, keyID, 'self');
          if (typeof r !== 'string') throw new Error(r.error);
          return r;
        },
        broadcast: async (tx) => {
          const r = await syncContext.services.submitToStack(tx.toBinary());
          if (['REJECTED', 'DOUBLE_SPEND_ATTEMPTED', 'INVALID', 'MALFORMED'].includes(r.txStatus))
            throw new Error(`network refused the sweep (${r.txStatus}${r.extraInfo ? `: ${r.extraInfo}` : ''})`);
        },
        internalize: async (beef, ds) => {
          const map = new Map<string, unknown>();
          for (const [address, d] of ds)
            map.set(address, {
              outputIndex: 0,
              derivationPrefix: d.derivationPrefix,
              derivationSuffix: d.derivationSuffix,
              senderIdentityKey,
              protocolID: ONESAT_PROTOCOL as WalletProtocol,
              counterparty: 'self',
            });
          const r = await internalizeBeef({
            beef: Uint8Array.from(beef),
            addressDerivations: map as Parameters<typeof internalizeBeef>[0]['addressDerivations'],
            wallet: adminWallet,
            services: syncContext.services,
            chain,
          });
          return r.internalized;
        },
        protocolID: ONESAT_PROTOCOL as WalletProtocol,
        feeRate: chromeStorageService.getCustomFeeRate(),
        alreadySpent: (outpoint) => rememberMoved([outpoint]),
        firstSeen: (outpoint) => {
          const k = normOutpoint(outpoint);
          if (!stuckSince.has(k)) stuckSince.set(k, Date.now());
          return stuckSince.get(k) ?? Date.now();
        },
      });
      if (rescued.length) {
        rememberMoved(rescued.map((r) => r.from));
        await sweepDeposit
          .execute(actionCtx, {})
          .catch((err: unknown) => console.error('[receiveGuard] sweep after rescue failed:', err));
        final = await checkReceiveAddresses(addresses, {
          ownerSync: (a) => syncContext.services.owner.sync(a),
          outputSats,
          walletOutpoints,
        });
      }
    }
    // Whatever is still missing counts as arriving, so the balance never shows $0 for it.
    setArriving(final.satoshis);
    if (final.satoshis) sendSyncStatus({ status: 'arriving', satoshis: final.satoshis });
  };
  // One receive-guard run at a time: overlapping runs each internalized and swept the same outputs.
  const receiveGuardFlight = singleFlight(receiveGuardOnce);
  const runReceiveGuard = () => receiveGuardFlight.run();
  const guard = () => runReceiveGuard().catch((err) => console.error('[receiveGuard] failed:', err));

  // One address sync at a time, shared by the startup run, the background alarm and the refresh button
  // (services/addressResync.ts). A quiet run (the alarm) shows no spinner; its 'complete' still refreshes the balance.
  let quietRun = false;
  let afterSyncDone = false;
  const addressSync = singleFlight(async () => {
    const quiet = quietRun;
    if (!quiet) {
      console.log('[initWallet] Starting address sync...');
      sendSyncStatus({ status: 'start', addressCount: scanPlan.count });
    }
    await syncAddresses
      .execute(actionCtx, {
        count: scanPlan.count,
        onProgress: (progress) => {
          if (!quiet) sendSyncStatus({ status: 'progress', ...progress });
        },
      })
      .then(async (result) => {
        sendSyncStatus({ status: 'complete', ...result });
        // Only a clean run counts as having read the new addresses' history; a failed one keeps the rescan pending.
        if (result.failed === 0) persistScanThrough();
        console.log('[initWallet] Address sync complete:', result);
        // Token outputs no address scan can see (change of a send this storage
        // never recorded). Cheap when there is nothing to find; cached per tx.
        void startupTokenHeal().then(() =>
          recoverTokens().catch((err) => console.error('[initWallet] token recovery failed:', err)),
        );
        void guard();
        // afterSync is a once-per-open hook, not for every background resync.
        if (options?.afterSync && !afterSyncDone) {
          afterSyncDone = true;
          try {
            await options.afterSync({ storage });
          } catch (err) {
            console.error('[initWallet] afterSync failed:', err);
          }
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendSyncStatus({ status: 'error', message });
        console.error('[initWallet] Address sync failed:', error);
        void guard();
        recoverTokens().catch((err) => console.error('[initWallet] token recovery failed:', err));
      });
  });
  const resyncAddresses = (options?: { quiet?: boolean }) => {
    if (!addressSync.busy()) quietRun = options?.quiet ?? false;
    return addressSync.run();
  };
  void resyncAddresses();

  // Sync incoming paymail payments from the message box (fire-and-forget)
  syncMessages
    .execute(actionCtx, { messageboxUrl: MESSAGEBOX_URL })
    .then((result) => {
      if (result.processed > 0 || result.failed > 0) {
        console.log('[initWallet] Message box sync complete:', result);
      }
    })
    .catch((error: unknown) => {
      console.error('[initWallet] Message box sync failed:', error);
    });

  // Create close function
  const close = async () => {
    await destroyWallet();
  };

  return {
    wallet,
    baseWallet,
    syncContext,
    storage,
    remoteStorage,
    permissionStore,
    setActiveStorage,
    addRemote,
    recoverTokens,
    fixStaleToken,
    dropSpentTokens,
    healUnseenTokens,
    resyncAddresses,
    lastAddressSyncAt: addressSync.lastFinishedAt,
    addressSyncBusy: addressSync.busy,
    sweepDeposits: () => sweepDeposit.execute(actionCtx, {}),
    creditArriving: () => runReceiveGuard(),
    recoverFailed: () =>
      runRecoverOnce(() =>
        recoverMinedFailedActions(
          makeRecoverDeps({
            storage,
            wallet: baseWallet,
            services: toolboxServices,
            monitor: walletMonitor,
          }),
        ),
      ).then((r) => {
        // A restored action may now be internalizable (its status was 'failed'): let the receive guard retry it.
        for (const txid of r.restored) internalizeBackoff.clear(txid);
        return r;
      }),
    recoverTxid: (txid: string, progress?: (step: string) => void) =>
      recoverPaymentByTxid(
        txid,
        makeTxidRecoverDeps({
          progress,
          storage,
          wallet: baseWallet as never,
          services: toolboxServices as never,
          legacyAddresses: (() => {
            const a = chromeStorageService.getCurrentAccountObject().account?.addresses;
            return a
              ? [
                  { label: 'identity', address: a.identityAddress },
                  { label: 'legacy BSV', address: a.bsvAddress },
                  { label: 'legacy ordinals', address: a.ordAddress },
                ].filter((x) => !!x.address)
              : [];
          })(),
        }),
      ).then((r) => {
        if (r.result === 'restored') internalizeBackoff.clear(r.txid);
        return r;
      }),
    reconcilePostage: (force?: boolean) =>
      reconcilePostage(
        {
          ...makePostageReconcileWiring({ storage, wallet: baseWallet as never, services: toolboxServices as never }),
          isMined: (txid) => wocIsMined(txid),
        },
        { force },
      ),
    sweepCandidates: () => {
      const txo = (toolboxServices as unknown as { txo?: { getSpends?: (o: string[]) => Promise<(string | null)[]> } })
        .txo;
      return sweepCandidateTxids(storage, txo?.getSpends ? (o) => txo.getSpends!.call(txo, o) : undefined);
    },
    restorePaymails: async () => {
      const held = new Set<string>();
      for (let offset = 0; ; offset += 1000) {
        const page = await baseWallet.listOutputs({ basket: 'default', limit: 1000, offset });
        for (const o of page.outputs) held.add(o.outpoint);
        if (page.outputs.length < 1000) break;
      }
      const txo = (toolboxServices as unknown as { txo?: { get?: (o: string) => Promise<never> } }).txo;
      return restorePaymailHistory((u, i) => fetch(u, i), baseWallet, {
        hasOutput: async (txid, vout) => held.has(`${txid}.${vout}`),
        isUnspent: async (txid, vout) => {
          const get = txo?.get;
          if (!get) return undefined;
          const r = await utxoStatusFromTxo((o) => get.call(txo, o), `${txid}.${vout}`);
          return r.status === 'success' ? r.isUtxo : undefined;
        },
        fetchBeef: async (txid) => (await toolboxServices.getBeefForTxid(txid)).toBinary(),
      });
    },
    knownOnChain: (txid) => knownOnChain(txid, (t) => toolboxServices.getRawTx(t)),
    sendWaitingNow: async () => (walletMonitor ? await walletMonitor.runTask('SendWaiting') : ''),
    referenceBytes: (reference) =>
      storage.runAsStorageProvider(async (sp) => {
        const [t] = await sp.findTransactions({ partial: { reference } });
        return (t?.rawTx?.length ?? 0) + (t?.inputBEEF?.length ?? 0);
      }),
    releaseStuckSends: () =>
      releaseStuckSends({
        listQueued: () =>
          storage.runAsStorageProvider(async (sp) => {
            const out: QueuedSend[] = [];
            for (const t of await sp.findTransactions({
              partial: { status: 'sending', isOutgoing: true },
              noRawTx: true,
            })) {
              if (!t.txid) continue;
              const [req] = await sp.findProvenTxReqs({ partial: { txid: t.txid } });
              out.push({
                transactionId: t.transactionId,
                txid: t.txid,
                createdAt: new Date(t.created_at).getTime(),
                attempts: req?.attempts ?? 0,
                description: t.description,
                satoshis: t.satoshis,
              });
            }
            return out;
          }),
        knownOnChain: (txid) => knownOnChain(txid, (t) => toolboxServices.getRawTx(t)),
        cancel: (q) =>
          storage.runAsStorageProvider(async (sp) => {
            for (const req of await sp.findProvenTxReqs({ partial: { txid: q.txid } }))
              await sp.updateProvenTxReq(req.provenTxReqId, { status: 'invalid' });
            await sp.updateTransactionStatus('failed', q.transactionId);
          }),
        available: () => storage.isActiveStorageProvider(),
      }),
    close,
  };
};
