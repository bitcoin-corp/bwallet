/* global chrome */
import { siteThemeFor } from './mobile/theme/connectTheme';
import type { AccentId } from './mobile/theme/accents';
import { revokeOriginatorInAccounts } from './services/accountPermissionStore';
import { routeBchatUrl } from './services/bchatOrigin';
import { createMasterBackupGate } from './services/masterBackupGate';
import { promptsShowInPanel } from './services/panelPrompt';
import { isSessionExpired } from './utils/lockTimeout';
import { originatorForOrigin } from './services/originKey';
import { pairedGrantAllowed, takePendingFor } from './services/pairedPromptGuard';
import {
  addGrant,
  decide as decideStream,
  isSpendingAuthAction,
  newGrantId,
  outputSats,
  streamProtocolOption,
  withoutStreamOption,
  parseSpendingAuthRequest,
  parseStreamState,
  passCovers,
  publicGrant,
  recordSpend,
  revokeGrant,
  revokeGrantsForOriginator,
  SPENDING_AUTH_REQUEST,
  SPENDING_AUTH_REVOKE,
  SPENDING_AUTH_STATUS,
  SPENDING_AUTH_VERSION,
  spentLastHour,
  STREAM_GRANTS_KEY,
  tidy,
  type StreamPass,
  type StreamState,
} from './services/streamGrants';
import type { StreamGrantPrompt } from './promptProtocol';
import { ALLOWANCES_ENABLED } from './services/allowanceFlag';
import {
  DEFAULT_ENVELOPE_USD,
  ENVELOPE_PRESETS_USD,
  isMicropaymentSite,
  markMicropayments,
  closeEnvelopeInAccounts,
} from './services/envelopes';
import {
  ADDRESS_RESYNC_ALARM,
  ADDRESS_RESYNC_PERIOD_MINUTES,
  pageHidden,
  refreshShouldSync,
  shouldResync,
} from './services/addressResync';
import { balanceWithDeposits } from './services/depositBalance';
import { arrivingSats } from './services/receiveGuard';
import { recoverySummary } from './services/recoverFailed';
import { timedStep, txidRecoverySummary } from './services/recoverByTxid';
import { paymailRestoreSummary } from './mobile/names/paymail';
import { isEmpty, summarizeActive, switchToLocalVerified, type SwitchDeps } from './services/restoreFromRemote';
import { insufficientFundsMessage, isInsufficientFunds, prepareFunding, type FundingSnapshot } from './services/fundingPrep';
import { mirrorToMiner } from './mobile/minerMirror';
import { panelUnlockMessages, shouldPushPrompt, type ShownPrompt } from './services/promptQueue';
import { RequestParams, ResponseEventDetail, YoursEventName } from './inject';
import { recordCall, recordPayment, requestedSats, updateConnectionLog } from './mobile/wallet/connectionLog';
import { CWIEventName } from './cwi';
import { describeWalletError } from './brand/walletError';
import { userDeniedError, withDenialCode } from './services/userDenied';
import { HANDOFF_ENABLED } from './mobile/passkey/extHandoff';
import { HANDOFF_ALARM, handleExternalHandoff, sweepExpiredHandoff } from './mobile/passkey/extHandoffStore';
import {
  healInvalidSend,
  withHealMessage,
  isInvalidTxReview,
  resyncMessage,
  resyncSpent,
  type HealReport,
} from './services/invalidSendHeal';
import { refusalFor } from './services/broadcastRefusals';
import { createWithSpentRetry, retryEligible } from './services/spentRetry';
import {
  AUTO_RESYNC_DELAY_MS,
  readAutoResyncCoins,
  runAutoResyncIfDue,
  type AutoResyncDeps,
  type AutoResyncReader,
  type WocAnswer,
} from './services/autoCoinResync';
import { withCoinResyncLock } from './services/coinResyncLock';
import type {
  ListOutputsArgs,
  RelinquishOutputArgs,
  ListActionsArgs,
  GetPublicKeyArgs,
  GetHeaderArgs,
  CreateHmacArgs,
  CreateSignatureArgs,
  VerifySignatureArgs,
  VerifyHmacArgs,
  CreateActionArgs,
  SignActionArgs,
  AbortActionArgs,
  InternalizeActionArgs,
  WalletEncryptArgs,
  WalletDecryptArgs,
  RevealCounterpartyKeyLinkageArgs,
  RevealSpecificKeyLinkageArgs,
  AcquireCertificateArgs,
  ListCertificatesArgs,
  ProveCertificateArgs,
  RelinquishCertificateArgs,
  DiscoverByIdentityKeyArgs,
  DiscoverByAttributesArgs,
  WalletInterface,
} from '@bsv/sdk';
import type {
  PermissionRequest,
  GroupedPermissionRequest,
  GroupedPermissions,
  CounterpartyPermissionRequest,
  CounterpartyPermissions,
} from '@bsv/wallet-toolbox-client';
import type { LocalWalletPermissionsManager } from '@1sat/wallet-browser';
import { deriveDepositAddresses } from '@1sat/actions';
import { removeWindow } from './utils/chromeHelpers';
import { Account, ChromeStorageObject, StorageConfig } from './services/types/chromeStorage.types';
import { ChromeStorageService } from './services/ChromeStorage.service';
import {
  denyAllOneSatPrompts,
  getPendingOneSatPrompt,
  handleOneSatPermissionResponse,
  initOneSatPromptBridge,
} from './services/oneSatPrompt';
import type { PromptKind, UsbCheckRequest } from './promptProtocol';
import {
  allowanceGranted,
  allowanceSats,
  DEFAULT_ALLOWANCE_USD,
  PermissionBundler,
  TRUST_SITE_BASKET,
  BLOCK_SITE_BASKET,
  BLOCKED_SITE_REFUSAL,
  blockActive,
  trustCovers,
  trustedBasketsFrom,
  POST_BASKET,
  POST_PROTOCOL,
  postPackCompanions,
  type BundleRequest,
} from './services/permissionBundle';
import { normalizeOriginator } from '@1sat/wallet';
import { withDefaultExpiry } from './services/grantExpiry';
import { markPayeeMismatch, parsePayees, payeesAllowed } from './services/allowanceGuard';
import { ADMIN_ORIGINATOR, initWallet, openAccountStorageForBackup, type AccountContext } from './initWallet';
import { isExtensionSender, reservedOriginatorRefusal } from './services/adminOriginator';
import { isReservedBasket, RESERVED_BASKET_REFUSAL, revokeBasketGrantsForOriginator } from './services/reservedBaskets';
import { pinnedProtocol, pinnedProtocolRefusal, PINNED_PROTOCOLS_VERSION, versionWithPins } from './services/pinnedProtocols';
import {
  DeferredEncrypts,
  labelCoveredByIntent,
  mintIntentFor,
  mintSheetFor,
  ProtocolCalls,
  shouldDeferEncrypt,
  type MintIntent,
  type MintSheet,
} from './services/pinnedMint';
import { isReservedProtocol, reservedProtocolRefusal, RESERVED_REFUSAL, withoutReservedProtocols } from './services/reservedProtocols';
import { healIndexFundActions } from './mobile/tokens/indexFundHeal';
import { continuesChain, endChain, isAlreadyProcessedAbort, markChainStep, startsChain } from './services/dappChain';
import { HOSTED_YOURS_IMAGE } from './utils/constants';
import { WalletBackupService } from './backup/WalletBackupService';
import { repairStaleAccounts, usbRekey, type UsbRekeyRequest } from './services/usbRekeyBackground';
import { finishInterruptedReconcile, reconcileStorage } from './services/storageReconcileBackground';
import { RECONCILE_RECORD_KEY, reconcileOutcome, type ReconcileRecord } from './services/storageReconcile';
import { USB_HANDLE_DB_NAME } from './services/UsbKey.service';
import {
  QUEUED_MESSAGE,
  RepeatGuard,
  queuedResult,
  queuedSend,
  repeatRefusal,
  repeatFingerprints,
} from './services/repeatGuard';
import { releasedMessage } from './services/stuckSends';
import { createSendRetry, SEND_RETRY_ALARM } from './services/sendRetry';
import {
  createActionBytes,
  kickSendWaiting,
  resultIsQueued,
  withBroadcastNow,
  pendingShape,
  shouldDelay,
  signActionBytes,
  withDelayedBroadcast,
} from './services/bigDelayed';
import { CALL_NOTIFICATION_PREFIX, CALL_RING_ALARM, callNotification, callsToAnnounce, fetchIncoming } from './services/callRinger';
import { openCallsWindow } from './mobile/calls/popout';
import {
  isUsbRecoverySession,
  readUsbLastSeen,
  USB_KEY_ABSENT_MESSAGE,
  USB_SEEN_MAX_AGE_MS,
} from './services/usbPresence';
import {
  closeUsbBackupReader,
  usbBackupChunk,
  usbBackupSettings,
  type UsbBackupChunkRequest,
} from './services/usbBackupBackground';


let chromeStorageService = new ChromeStorageService();
const isInServiceWorker = self?.document === undefined;

// Account context - null if locked or not initialized
let accountContext: AccountContext | null = null;

/** WhatsOnChain's spender for an outpoint (confirmed or mempool); null when unspent (404), throws when it can't tell. */
async function wocSpend(outpoint: string): Promise<string | null> {
  const [txid, vout] = outpoint.split('_');
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/${vout}/spent`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`woc ${r.status}`);
  const j = (await r.json()) as { txid?: string };
  return typeof j.txid === 'string' ? j.txid : null;
}

/** WhatsOnChain's spender and whether that spend is mined; null when unspent (404); throws when it can't tell. */
async function wocSpendStatus(outpoint: string): Promise<WocAnswer> {
  const [txid, vout] = outpoint.split('_');
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/${vout}/spent`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`woc ${r.status}`);
  const j = (await r.json()) as { txid?: string; status?: string };
  if (typeof j.txid !== 'string') throw new Error('woc: no spender');
  return { txid: j.txid, confirmed: j.status === 'confirmed' };
}

/** Is this txid known to WhatsOnChain (mempool or mined)? false only on 404; null when it can't tell. */
async function wocTxKnown(txid: string): Promise<boolean | null> {
  try {
    const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`);
    if (r.status === 404) return false;
    return r.ok ? true : null;
  } catch {
    return null;
  }
}

/** The account's chain; WhatsOnChain lookups here are mainnet only. */
const ctxChain = (ctx: AccountContext): string =>
  (ctx.syncContext as unknown as { chain?: string }).chain ??
  (ctx.syncContext.services as unknown as { chain?: string }).chain ??
  'main';

/** invalidSendHeal against this account's storage, the 1sat spend index, then WhatsOnChain. Never throws. */
async function healRejectedInputs(ctx: AccountContext, error: unknown): Promise<HealReport | null> {
  const { account } = chromeStorageService.getCurrentAccountObject();
  const identityKey = account?.pubKeys?.identityPubKey || '';
  const txo = (ctx.syncContext.services as unknown as { txo?: { getSpend: (o: string) => Promise<string | null> } }).txo;
  if (!identityKey || !txo) return null;
  try {
    const rejected = (error as { reviewActionResults?: { txid?: string; status?: string }[] }).reviewActionResults?.find(
      (r) => r?.status === 'invalidTx',
    )?.txid;
    return await healInvalidSend(error, (o) => txo.getSpend(o), {
      markSpent: (txid, vout) =>
        ctx.storage.runAsStorageProvider(async (sp) => {
          const user = (await sp.findUsers({ partial: { identityKey } }))[0];
          if (!user) return 0;
          let n = 0;
          for (const o of await sp.findOutputs({ partial: { userId: user.userId, txid, vout, spendable: true } }))
            n += await sp.updateOutput(o.outputId, { spendable: false });
          return n;
        }),
    }, { fallback: wocSpend, reason: refusalFor(rejected) });
  } catch (err) {
    console.error('[createAction] invalidTx heal failed:', err);
    return null;
  }
}
/**
 * Clear every coin storage lists as spendable that the chain proves was spent (resyncSpent, fail closed: only coins
 * with a named spending txid). Owner's iPhone, 19 Oct 2026: ~$51 of coins spent from another device holding the same
 * seed still showed as balance; the toolbox's sync only adds outputs and never re-checks ones it holds, so they were
 * found one failed send at a time. Returns null when storage/services aren't ready. Never throws.
 */
async function resyncAccountCoins(
  ctx: AccountContext,
  identityKey: string,
  onStep?: (step: string) => void,
): Promise<HealReport | null> {
  const txo = (ctx.syncContext.services as unknown as { txo?: { getSpend: (o: string) => Promise<string | null> } }).txo;
  if (!identityKey || !txo) return null;
  try {
    const outpoints = await ctx.storage.runAsStorageProvider(async (sp) => {
      const user = (await sp.findUsers({ partial: { identityKey } }))[0];
      if (!user) return [] as string[];
      return (await sp.findOutputs({ partial: { userId: user.userId, spendable: true } }))
        .filter((o) => !!o.txid)
        .map((o) => `${o.txid}_${o.vout}`);
    });
    onStep?.(`Checking ${outpoints.length} coins…`);
    return await resyncSpent(outpoints, (o) => txo.getSpend(o), markSpentStore(ctx, identityKey), {
      fallback: ctxChain(ctx) === 'main' ? wocSpend : undefined,
      onProgress: (done) => onStep?.(`Checked ${done} of ${outpoints.length} coins…`),
    });
  } catch (err) {
    console.error('[resyncCoins] failed:', err);
    return null;
  }
}

/** HealStore over this account's storage: spendable → false for one outpoint. */
const markSpentStore = (ctx: AccountContext, identityKey: string) => ({
  markSpent: (txid: string, vout: number) =>
    ctx.storage.runAsStorageProvider(async (sp) => {
      const user = (await sp.findUsers({ partial: { identityKey } }))[0];
      if (!user) return 0;
      let n = 0;
      for (const o of await sp.findOutputs({ partial: { userId: user.userId, txid, vout, spendable: true } }))
        n += await sp.updateOutput(o.outputId, { spendable: false });
      return n;
    }),
});

/** Unfinished actions: their txids are not "spenders", and the coins they hold are not checked. */
const PENDING_STATUSES = ['unsigned', 'nosend', 'sending', 'unprocessed', 'failed'] as const;

/** Inputs for autoCoinResync from this account's storage: default-basket coins, pending actions. */
async function autoResyncDeps(
  ctx: AccountContext,
  identityKey: string,
  cleared: Record<string, string>,
): Promise<AutoResyncDeps | null> {
  const txo = (
    ctx.syncContext.services as unknown as {
      txo?: { getSpends: (o: string[]) => Promise<(string | null | undefined)[]> };
    }
  ).txo;
  if (!identityKey || !txo?.getSpends) return null;
  // The device's own store must be active: with a remote (1Sat) store active, as on web before the switch to this
  // device, there is no StorageProvider to repair ("WalletStorageProvider does not support StorageProvider", web,
  // 19 Oct 2026). Skip (not due-stamped), the next unlock tries again.
  if (!ctx.storage.isActiveStorageProvider()) return null;
  const read = await readAutoResyncCoins(
    {
      runAsReader: (f) => ctx.storage.runAsReader((r) => f(r as unknown as AutoResyncReader)),
      isActiveStorageProvider: () => ctx.storage.isActiveStorageProvider(),
    },
    identityKey,
    [...PENDING_STATUSES],
  );
  if (!read) return null;
  const { userId } = read;
  const setSpendable = (outpoint: string, spendable: boolean, spender?: string) =>
    ctx.storage.runAsStorageProvider(async (sp) => {
      const [txid, vout] = outpoint.split('_');
      const spentBy = spender ? (await sp.findTransactions({ partial: { userId, txid: spender }, noRawTx: true }))[0] : undefined;
      let n = 0;
      for (const o of await sp.findOutputs({ partial: { userId, txid, vout: Number(vout), spendable: !spendable }, noScript: true }))
        n += await sp.updateOutput(o.outputId, { spendable, spentBy: spendable ? undefined : spentBy?.transactionId });
      return n;
    });
  return {
    coins: read.coins,
    cleared,
    ownPendingTxids: read.ownPendingTxids,
    ownPendingInputs: read.ownPendingInputs,
    getSpends: (b) => txo.getSpends(b),
    woc: ctxChain(ctx) === 'main' ? wocSpendStatus : undefined,
    markSpent: (o, by) => setSpendable(o, false, by),
    markUnspent: (o) => setSpendable(o, true),
  };
}
// Set while wallet is reinitializing (e.g. account switch) to prevent
// ensureWallet from launching a popup during the transition.
let reinitPromise: Promise<WalletInterface | null> | null = null;
// Tracks active extension popup connections via chrome.runtime.onConnect.
// When the browser-action popup opens, it connects with name 'extension-popup'.
// When it closes, the port disconnects automatically. No timers needed.
const activePopupPorts = new Set<chrome.runtime.Port>();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'extension-popup') {
    activePopupPorts.add(port);
    if (panelPromptOnConnect) {
      const { kind, requestID } = panelPromptOnConnect;
      panelPromptOnConnect = undefined;
      promptInPanel = true;
      // Give the panel's listener a moment to attach before posting.
      setTimeout(() => postToPanels({ action: 'SHOW_PROMPT_PANEL', kind, requestID }), 300);
    }
    // A panel opening while a themed site is active wears its theme straight away.
    setTimeout(() => void pushSiteTheme(true), 300);
    port.onDisconnect.addListener(() => {
      activePopupPorts.delete(port);
      if (promptInPanel && activePopupPorts.size === 0) {
        promptInPanel = false;
        denyAllPendingPrompts();
      }
    });
  }
});

/**
 * Send a balance update notification to the popup.
 * Uses the SYNC_STATUS_UPDATE event which useSyncTracker listens for.
 */
const notifyBalanceUpdate = () => {
  chrome.runtime
    .sendMessage({
      action: YoursEventName.SYNC_STATUS_UPDATE,
      data: { status: 'complete' },
    })
    .catch(() => {
      // Ignore errors if popup is not open
    });
};

// Drop live context immediately; destroy in background (never block lock on hung close).
/**
 * Bumped on every lock/drop. An initialisation that started before a lock
 * must not publish its wallet afterwards: `runInitializeWallet` compares the
 * generation it started under with the current one before assigning.
 */
let lockGeneration = 0;

const dropWalletContext = (reason: string) => {
  lockGeneration++;
  void closeUsbBackupReader();
  const ctx = accountContext;
  accountContext = null;
  if (!ctx) return;
  console.log(`[background] dropWalletContext (${reason}): gone immediately`);
  void ctx.close().catch((err) => console.error(`[background] close after ${reason}:`, err));
};

// Initialize wallet on startup (will be null if locked)
/**
 * The initialization currently in flight, whoever started it (startup, unlock,
 * account switch, restore). ensureWallet() waits on it so popup calls that arrive
 * while the wallet is being built are queued instead of failing with
 * "Wallet not available" — which left the first MNEE lookup after an unlock at zero.
 */
let initInFlight: Promise<WalletInterface | null> | null = null;

/** The stuck-send review, with a notification for any send it released (services/stuckSends.ts). */
const reviewQueuedSends = async (ctx: AccountContext) => {
  const r = await ctx.releaseStuckSends();
  if (r.queued || r.error) console.log('[background] queued-send review:', r);
  if (r.released.length)
    chrome.notifications?.create(`bwx-released-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Payment cancelled',
      message: releasedMessage(r.released),
    });
  return r;
};

/** Retries queued sends every few minutes while any exist (services/sendRetry.ts). */
const sendRetry = createSendRetry({
  sendWaiting: async () => (accountContext ? await accountContext.sendWaitingNow() : ''),
  review: async () => (accountContext ? await reviewQueuedSends(accountContext) : { queued: 1, error: 'wallet closed' }),
  alarms: chrome.alarms,
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SEND_RETRY_ALARM) return;
  if (!accountContext) {
    // Worker woke for the alarm: open the wallet if it is unlocked; a locked wallet keeps the alarm for later.
    const ok = await ensureWallet(true).then(
      () => true,
      () => false,
    );
    if (!ok || !accountContext) return;
  }
  await sendRetry.tick();
});
(globalThis as { document?: Document }).document?.addEventListener('visibilitychange', () => {
  if (pageHidden() === false && sendRetry.armed() && accountContext) void sendRetry.tick();
});

const initializeWallet = (): Promise<WalletInterface | null> => {
  const run = runInitializeWallet();
  initInFlight = run;
  return run.finally(() => {
    if (initInFlight === run) initInFlight = null;
  });
};

/** Set by the service-worker block so the pending import can stream progress to a restore window. */
let restoreProgressFn: ((message: string) => void) | undefined;
/** In-flight pending-restore imports by identity key, so a second init joins rather than duplicates. */
const pendingImports = new Map<string, Promise<void>>();

const runInitializeWallet = async (): Promise<WalletInterface | null> => {
  console.log('[background] initializeWallet: starting, current accountContext:', !!accountContext);
  // Stage timings (owner, 6 Oct 2026: a restore took ~50 s); read them in the service worker console.
  const t0 = Date.now();
  const stage = (name: string) => console.log(`[background] initializeWallet: ${name} at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (accountContext) {
    dropWalletContext('before-init');
  }
  // USB key security: finish any re-key whose read-back never ran, so no
  // account is left under a previous epoch's key.
  try {
    await repairStaleAccounts(chromeStorageService);
  } catch (err) {
    console.error('[background] repairStaleAccounts failed:', err);
  }

  console.log('[background] initializeWallet: calling initWallet...');
  // Pending restore data for the CURRENT account (Phase 2 of two-phase restore).
  // Each account's data is stored separately — syncFromReader only accepts the
  // authenticated account's identityKey. Other accounts' data stays in IndexedDB
  // until they are switched to and initializeWallet runs again.
  //
  // This runs via `beforeSync`, i.e. before initWallet starts the address and
  // message syncs. The import needs the toolbox's exclusive sync lock, which
  // waits for all reader/writer locks; once the address sync is running it
  // holds those almost continuously and the import never starts, and every
  // wallet read (balance, storage info) then queues behind it.
  const PENDING_IMPORT_MAX_ATTEMPTS = 3;
  const runPendingImport = async (
    storage: import('@1sat/wallet-browser').WalletStorageManager,
    currentIdentityKey: string,
  ) => {
    // A timed-out import keeps running; a later init must join it, not start
    // a second writer for the same account.
    const existing = pendingImports.get(currentIdentityKey);
    if (existing) {
      console.log('[background] initializeWallet: pending import already running for this account; joining it');
      await existing.catch(() => undefined);
      return;
    }
    console.log('[background] initializeWallet: Found pending restore data, importing...');
    // Watchdog: say so every 10 s while the import is in flight, so a hang is visible.
    const started = Date.now();
    const watchdog = setInterval(() => {
      console.warn(`[background] PendingRestore: still importing after ${Math.round((Date.now() - started) / 1000)}s`);
    }, 10_000);
    // Hard cap, generous: the import must never take the wallet down with it.
    // Balance reads queue behind the import anyway (it holds the sync lock),
    // so a short cap only hides the wait; this one exists for a wedged import.
    // On timeout the wallet initialises without it and the parked data stays.
    const IMPORT_TIMEOUT_MS = 10 * 60_000;
    let timedOut = false;
    const importPromise = WalletBackupService.importPendingWalletData(
      storage as unknown as Parameters<typeof WalletBackupService.importPendingWalletData>[0],
      currentIdentityKey,
      (event) => {
        console.log('[background] PendingRestore:', event.message);
        restoreProgressFn?.(event.message);
      },
    ).finally(() => pendingImports.delete(currentIdentityKey));
    pendingImports.set(currentIdentityKey, importPromise);
    try {
      await Promise.race([
        importPromise,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, IMPORT_TIMEOUT_MS),
        ),
      ]);
      if (timedOut) {
        console.error(
          `[background] initializeWallet: Pending restore timed out after ${IMPORT_TIMEOUT_MS / 1000}s; continuing without it`,
        );
      } else {
        console.log('[background] initializeWallet: Pending restore complete');
      }
    } catch (error) {
      console.error('[background] initializeWallet: Pending restore failed:', error);
      // The parked chunks may be the whole wallet: keep them for another try
      // (a transient failure, a worker killed mid-import). Give up only after
      // repeated failures so a broken backup cannot stall every unlock.
      const attempts = await WalletBackupService.notePendingRestoreAttempt(currentIdentityKey);
      if (attempts >= PENDING_IMPORT_MAX_ATTEMPTS) {
        console.error(`[background] initializeWallet: giving up on pending restore after ${attempts} attempts`);
        await WalletBackupService.clearAccountPendingRestore(currentIdentityKey);
      }
    } finally {
      clearInterval(watchdog);
    }
  };

  /**
   * Runs before the address sync (see initWallet's beforeSync). With a local
   * active store the parked chunks are the wallet and must land first. With a
   * remote active store the import is a no-op that clears the parked data.
   */
  const importPendingRestore = async ({
    storage,
  }: {
    storage: import('@1sat/wallet-browser').WalletStorageManager;
  }) => {
    const { account: currentAccount } = chromeStorageService.getCurrentAccountObject();
    const currentIdentityKey = currentAccount?.pubKeys?.identityPubKey || '';
    if (!currentIdentityKey) return;
    const hasPending = await WalletBackupService.hasPendingRestore(currentIdentityKey);
    console.log(
      '[background] initializeWallet: hasPendingRestore for',
      currentIdentityKey.slice(0, 8) + '...:',
      hasPending,
    );
    if (!hasPending) return;
    await runPendingImport(storage, currentIdentityKey);
    if (!(await WalletBackupService.hasPendingRestore(currentIdentityKey))) pendingUtxoReview.add(currentIdentityKey);
  };

  /**
   * Once the address sync has finished after a restore, release outputs the
   * chain says were spent since the backup. Runs after the sync, not before:
   * it takes the manager's exclusive locks and does one network lookup per
   * change output.
   */
  const pendingUtxoReview = new Set<string>();
  const reviewRestoredUtxos = async ({ storage }: { storage: import('@1sat/wallet-browser').WalletStorageManager }) => {
    const { account } = chromeStorageService.getCurrentAccountObject();
    const identityKey = account?.pubKeys?.identityPubKey || '';
    if (!identityKey || !pendingUtxoReview.delete(identityKey)) return;
    await WalletBackupService.reviewRestoredUtxos(
      storage as unknown as Parameters<typeof WalletBackupService.reviewRestoredUtxos>[0],
      identityKey,
    );
  };

  const startedUnder = lockGeneration;
  // Filled in once initWallet returns; the broadcast callback reads it lazily.
  const mirror: { services?: Parameters<typeof mirrorToMiner>[0] } = {};
  const ctx = await initWallet(chromeStorageService, {
    onTransactionBroadcasted: (txid: string) => {
      console.log('[background] Transaction broadcasted:', txid);
      notifyBalanceUpdate();
      // Also hand it straight to a miner (mobile/minerMirror.ts).
      void mirrorToMiner(mirror.services as Parameters<typeof mirrorToMiner>[0], txid);
    },
    onTransactionProven: (txid: string) => {
      console.log('[background] Transaction proven:', txid);
      notifyBalanceUpdate();
    },
    beforeSync: async (a) => {
      stage('storage ready, before sync');
      await importPendingRestore(a);
    },
    afterSync: async (a) => {
      stage('address sync done');
      await reviewRestoredUtxos(a);
    },
  });
  if (lockGeneration !== startedUnder || !(await chromeStorageService.getPassKey())) {
    // Locked while we were initialising (a restore's detached init can run
    // for minutes). Storage and UI say locked; do not hand out a live wallet.
    console.log('[background] initializeWallet: locked during init; discarding the wallet');
    await ctx.close().catch((err) => console.error('[background] close after late lock:', err));
    return null;
  }
  stage('initWallet done');
  accountContext = ctx;
  mirror.services = ctx.syncContext.services as unknown as Parameters<typeof mirrorToMiner>[0];
  console.log('[background] initializeWallet: initWallet returned, accountContext:', !!accountContext);

  if (accountContext) {
    bindPermissionCallbacks(accountContext.wallet);
    console.log('[background] initializeWallet: bound permission callbacks');
    // Abort token-indexing payments that were built but never sent (bounded, never throws).
    void healIndexFundActions(accountContext.baseWallet).then((r) => {
      if (r.aborted.length || r.pending.length || r.errors.length) console.log('[background] indexFund heal:', r);
    });
    // Release a site's inscription chain that broke part-way and still holds change (services/streamHeal.ts).
    // The stranded-stream auto-abort (services/streamHeal.ts) is off (audit, 11 Oct 2026): it ran on every
    // service-worker restart and could abort an action whose transaction had gone out. The toolbox's own
    // no-send expiry releases genuinely abandoned steps.
    // Restore any mined transaction storage holds as failed, so its change counts again ($vexvoid, 11 Oct 2026).
    // Order matters (owner, 14 Oct 2026): both repairs need this device's storage active, so switch first.
    const ctx = accountContext;
    const localReady = preferLocalStorage(ctx);
    storageSwitch = localReady;
    void localReady.finally(() => {
      if (storageSwitch === localReady) storageSwitch = null;
    });
    // Coins spent elsewhere (another device, same seed) stay "spendable" here until checked: check the default basket
    // at most every 30 minutes per account (persisted), fail closed (services/autoCoinResync.ts). Off the unlock path:
    // after this device's store is active, and a while after unlock so the first balance read and the address sync
    // are not queued behind its scan of every coin (owner's big wallet, 19 Oct 2026).
    {
      const key = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey || '';
      const gen = lockGeneration;
      if (key)
        void localReady
          .then(() => new Promise((r) => setTimeout(r, AUTO_RESYNC_DELAY_MS)))
          .then(() =>
            // Locked or switched account since: skip (the next unlock tries again).
            lockGeneration !== gen || accountContext !== ctx
              ? null
              : runAutoResyncIfDue(
                  key,
                  {
                    get: (k) => chrome.storage.local.get(k),
                    set: (items) => chrome.storage.local.set(items),
                  },
                  (cleared) => autoResyncDeps(ctx, key, cleared),
                ),
          )
          .then((r) => {
            if (r && (r.released || r.restored)) {
              console.warn('[background] auto coin resync:', r);
              notifyBalanceUpdate();
            }
          })
          .catch((err) => console.error('[background] auto coin resync failed:', err));
    }
    void (async () => {
      await localReady;
      // Paymail receipts whose derivation only the server recorded (restore from seed, 14 Oct 2026). Idempotent.
      await ctx
        .restorePaymails()
        .then((p) => (p.restored || p.errors.length ? console.log('[background] paymail restore:', p) : undefined))
        .catch((err: unknown) => console.warn('[background] paymail restore failed:', err));
      const r = await ctx.recoverFailed();
      if (r.failed || r.error || r.skipped) console.log('[background] failed-action review:', r);
      // bMail postage broadcast by the recipient while our row still says nosend (Bureau retest, 18 Oct 2026).
      await ctx
        .reconcilePostage()
        .then((p) => (p.settled.length || p.errors.length ? console.log('[background] postage reconcile:', p) : undefined))
        .catch((err: unknown) => console.warn('[background] postage reconcile failed:', err));
      // Give up on queued sends that never reached the network, and give the money back (services/stuckSends.ts).
      // Anything still queued keeps the send-retry alarm on (services/sendRetry.ts).
      const q = await reviewQueuedSends(ctx);
      if (q.queued > 0 || q.error) sendRetry.arm();
    })().catch((err: unknown) => console.error('[background] startup storage repairs failed:', err));
  }

  return accountContext?.wallet ?? null;
};

/**
 * bWallet: keep the wallet's main copy on the device, 1Sat storage as the backup (owner, 4 Oct 2026).
 * 1Sat's remote storage caps BEEF depth at 12, so token buys with a deep ancestry fail while it is
 * active ("Maximum BEEF depth exceeded"). Once per account, switch a remote-active wallet to local,
 * but only after verifying the device holds everything the remote holds (services/restoreFromRemote.ts;
 * restore incident 14 Oct 2026). Short → stay remote-active and retry next open. Someone who later
 * picks remote again in Wallet Backup keeps that choice (the flag is set).
 */
/**
 * Wallets whose switch to this device failed in this session (22 Oct 2026: a brand-new wallet's switch broke the
 * toolbox's storage, "not initialized" on every read, and the balance never loaded). They stay on the backup store
 * until the next service-worker start, so a rebuild after the failure can't loop back into the same switch.
 */
const switchFailedThisSession = new Set<string>();

/**
 * The switch to this device's store while it runs. A master backup closes the live wallet to export each account;
 * doing that mid-switch left the switch working on a closed wallet ("makeAvailable" / "not initialized", reproduced
 * 22 Oct 2026 by making backups during sign-up), so the backup waits for it and a switch never starts during one.
 */
let storageSwitch: Promise<void> | null = null;

/** After a failed switch: if the active store no longer answers, rebuild the wallet once (it stays on the backup). */
const recoverAfterFailedSwitch = async (ctx: NonNullable<typeof accountContext>, id: string) => {
  switchFailedThisSession.add(id);
  const works = await summarizeActive(ctx.baseWallet as never).then(
    () => true,
    () => false,
  );
  if (works || accountContext !== ctx) return;
  console.warn('[background] storage: the store is unusable after a failed switch; reopening the wallet on the backup');
  await initializeWallet().catch((e) => console.error('[background] storage: reopening the wallet failed:', e));
  notifyBalanceUpdate();
};

const preferLocalStorage = async (ctx: NonNullable<typeof accountContext>) => {
  try {
    const { account } = chromeStorageService.getCurrentAccountObject();
    if (account && switchFailedThisSession.has(account.addresses.identityAddress)) return;
    if (masterBackupInFlight) return;
    const config = account?.storageConfig as (StorageConfig & { localFirst?: boolean }) | undefined;
    if (!account || !config) return;
    const remoteUrl = config.activeRemote || config.remotes?.[0];
    if (!remoteUrl) return;
    const save = (storageConfig: StorageConfig & { localFirst?: boolean }) =>
      chromeStorageService.updateNested('accounts', {
        [account.addresses.identityAddress]: { storageConfig } as unknown as Account,
      });
    const remotes = config.remotes?.includes(remoteUrl) ? config.remotes : [...(config.remotes ?? []), remoteUrl];
    const deps = restoreDeps(ctx, remoteUrl);

    if (config.activeRemote && !config.localFirst) {
      // First open on this device (or a retry after a short pull): switch only once the device holds it all.
      console.log('[background] storage: switching active to this device after a verified copy of the backup');
      const r = await switchToLocalVerified(deps);
      sendRestoreStatus(r.ok ? undefined : null);
      console.log('[background] storage: verified switch', r);
      if (r.ok) await save({ ...config, activeRemote: undefined, remotes, localFirst: true });
      else await recoverAfterFailedSwitch(ctx, account.addresses.identityAddress);
      return;
    }

    if (!config.activeRemote) {
      // Already local-active (switched before this fix): an EMPTY device store beside a backup is the incident
      // state ($bug, 14 Oct 2026). Pull the backup in, verified; stay on the backup if that fails.
      const local = await summarizeActive(ctx.baseWallet as never);
      if (!isEmpty(local)) return;
      console.log('[background] storage: this device holds nothing; loading from the backup');
      const r = await switchToLocalVerified(deps);
      sendRestoreStatus(r.ok ? undefined : null);
      console.log('[background] storage: recovery from backup', r);
      if (!r.ok && r.activeIsRemote) await save({ ...config, activeRemote: remoteUrl, remotes, localFirst: false });
      if (!r.ok) await recoverAfterFailedSwitch(ctx, account.addresses.identityAddress);
    }
  } catch (err) {
    sendRestoreStatus(null);
    console.warn('[background] storage: could not settle the active store:', err);
  }
};

/** "Loading your wallet from backup…" on the balance card; undefined = done, null = done without the copy. */
const sendRestoreStatus = (message: string | undefined | null) => {
  chrome.runtime
    .sendMessage({
      action: YoursEventName.SYNC_STATUS_UPDATE,
      data: message ? { status: 'restoring', message } : { status: 'restored', ok: message === undefined },
    })
    .catch(() => undefined);
};

/** Production wiring of services/restoreFromRemote.ts. */
const restoreDeps = (ctx: NonNullable<typeof accountContext>, remoteUrl: string): SwitchDeps => {
  const activeRemoteUrl = () => ctx.storage.getStores().find((s) => s.isActive && !s.isConflicting)?.endpointURL;
  return {
    remoteUrl,
    activeRemoteUrl,
    setActiveStorage: ctx.setActiveStorage,
    summarize: () => summarizeActive(ctx.baseWallet as never),
    pullRemote: async () => {
      const store = (
        ctx.storage as unknown as { _stores: { storage: { endpointUrl?: string } }[] }
      )._stores.find((s) => s.storage.endpointUrl === remoteUrl)?.storage;
      if (!store) throw new Error('backup store not connected');
      const { identityKey } = await ctx.storage.getAuth();
      await ctx.storage.syncFromReader(identityKey, store as never);
    },
    progress: (m) => sendRestoreStatus(m),
    log: (...a) => console.log(...a),
  };
};

// Start initialization — clean up stale popup windows then initialize wallet.
// ensureWallet() awaits this so CWI messages don't launch popups during init.
const startupInitPromise = chromeStorageService
  .getAndSetStorage()
  .then(async () => {
    // Before any wallet init can start a new repair run.
    await finishInterruptedReconcile().catch((err) =>
      console.error('[background] could not close out an interrupted storage repair:', err),
    );

    // Close any orphaned extension popup windows from a previous session/reload.
    // The USB key window is a user-driven multi-step flow, not a prompt: the
    // worker idles out and restarts while the user reads or writes a recovery
    // code, and closing it here would abort enrolment mid-way.
    const extOrigin = chrome.runtime.getURL('');
    const usbUrl = chrome.runtime.getURL('usb.html');
    const allWindows = await chrome.windows.getAll({ populate: true });
    for (const w of allWindows) {
      if (w.tabs?.some((t) => t.url?.startsWith(usbUrl))) continue;
      if (w.type === 'popup' && w.id && w.tabs?.some((t) => t.url?.startsWith(extOrigin))) {
        try {
          await chrome.windows.remove(w.id);
        } catch {
          // Window already gone
        }
      }
    }
    await chrome.storage.local.remove('popupWindowId');

    // One-time migration: prompts now live in memory + prompt.html windows,
    // so drop request entries persisted by older versions.
    await chrome.storage.local.remove([
      'permissionRequest',
      'groupedPermissionRequest',
      'counterpartyPermissionRequest',
      'oneSatPermissionRequest',
      'transactionApprovalRequest',
      'sendMNEERequest',
    ]);

    // Only initialize wallet if it's within the active session window.
    // If locked (inactive or manual lock), keys stay encrypted until the user unlocks.
    await chromeStorageService.getAndSetStorage();
    const { account, lastActiveTime } = chromeStorageService.getCurrentAccountObject();
    const passKey = await chromeStorageService.getPassKey();
    const isUnlocked =
      passKey && account?.encryptedKeys && !isSessionExpired(lastActiveTime, getInactivityLimit());

    if (isUnlocked) {
      try {
        await initializeWallet();
      } catch (error) {
        console.error('[background] Failed to initialize wallet on startup — locking:', error);
        await chromeStorageService.clearPassKey();
        await chromeStorageService.update({ isLocked: true, lastActiveTime: 0 });
      }
    } else if (account?.encryptedKeys) {
      // Wallet exists but can't initialize (no passKey or timed out) — ensure locked state
      await chromeStorageService.clearPassKey();
      await chromeStorageService.update({ isLocked: true, lastActiveTime: 0 });
    }
  })
  .catch((error) => {
    console.error('[background] Startup initialization failed:', error);
  });

/**
 * Get the current wallet instance (WalletPermissionsManager).
 * Returns null if wallet is locked or not initialized.
 */
export const getWallet = (): WalletInterface | null => {
  console.log('[background] getWallet called, accountContext:', !!accountContext, 'wallet:', !!accountContext?.wallet);
  return accountContext?.wallet ?? null;
};

/**
 * Ensure the wallet is available, prompting user to unlock if needed.
 * Waits for startup initialization first so we don't launch a popup
 * while the wallet is still auto-initializing from a persisted passKey.
 */
const ensureWallet = async (suppressPopup = false): Promise<WalletInterface> => {
  await startupInitPromise;
  // During a master backup, wait for it (and the original account to reopen) instead of failing (masterBackupGate.ts).
  if (masterBackupGate.active) await masterBackupGate.wait();
  if (accountContext?.wallet) {
    return accountContext.wallet;
  }

  // If wallet is currently initializing (startup, unlock, account switch, restore),
  // wait for that instead of rejecting or launching a popup.
  const inFlight = reinitPromise ?? initInFlight;
  if (inFlight) {
    const wallet = await inFlight.catch(() => null);
    if (wallet) return wallet;
  }

  // Still no context — check again after reinit may have completed
  if (accountContext?.wallet) {
    return accountContext.wallet;
  }

  // No accountContext — passKey is cleared on lock, so the user must enter their password.
  // Check if a wallet exists to unlock (encryptedKeys must be present).
  await chromeStorageService.getAndSetStorage();
  const { account } = chromeStorageService.getCurrentAccountObject();

  if (!account?.encryptedKeys) {
    return Promise.reject(new Error('No wallet exists - create wallet first'));
  }

  // Wallet exists but is locked — prompt user to unlock via popup
  // (unless suppressed, e.g. when called from the extension popup itself)
  if (suppressPopup) {
    return Promise.reject(new Error('Wallet not available'));
  }
  return new Promise((resolve, reject) => {
    pendingWalletWaiters.push({ resolve, reject });
    if (pendingWalletWaiters.length === 1) {
      showUnlockUi();
    }
  });
};

console.log('Yours Wallet Background Script Running!');

type CallbackResponse = (response: ResponseEventDetail) => void;

// Pending permission requests waiting for user approval
const pendingPermissionRequests = new Map<
  string,
  {
    request: PermissionRequest & { requestID: string };
    resolve: () => void;
    reject: (error: Error) => void;
  }
>();

// One sheet per action (docs/ONE-SHEET-PERMISSIONS.md): single permission requests from one site are
// merged into one bundle and shown as one sheet. Each request stays in pendingPermissionRequests and is
// still answered through the manager's grantPermission / denyPermission.
type BundledRequest = PermissionRequest & { requestID: string };
const permissionBundler = new PermissionBundler<BundledRequest & BundleRequest>({
  onReady: (bundle) => showPromptUi('bundle', bundle.id),
  // Requests that waited behind the site's last sheet get their own sheet now, with their companions.
  onPromote: (bundle) => askCompanionsFor(bundle),
  // Live sheet: a line joined the open sheet; it reloads, marks it "New" and holds its button for a moment.
  onUpdate: (bundle) => notifyPromptUpdated('bundle', bundle.id),
});
let notifyPromptUpdated: (kind: PromptKind, requestID: string) => void = () => undefined;

// Pending wallet initialization waiters (for ensureWallet when service worker wakes without passKey)
const pendingWalletWaiters: {
  resolve: (wallet: WalletInterface) => void;
  reject: (error: Error) => void;
}[] = [];

/**
 * Gated dApp calls (sign, spend, reveal) waiting for the user to confirm a
 * registered USB key is present. One prompt serves every call queued behind it.
 */
const pendingUsbChecks = new Map<
  string,
  { request: UsbCheckRequest; resolve: () => void; reject: (e: Error) => void }
>();
let usbCheckInFlight: Promise<void> | null = null;
/** No prompt window can answer: refuse every waiting call rather than hold them forever. */
const failPendingUsbChecks = (message: string) => {
  for (const pending of pendingUsbChecks.values()) pending.reject(new Error(message));
  pendingUsbChecks.clear();
};
/** A confirm prompt nobody answers must not hold dApp and popup calls open indefinitely. */
const USB_CHECK_TIMEOUT_MS = 3 * 60_000;

/**
 * Streaming spending grants (services/streamGrants.ts, bMovies watch-to-pay). State lives in chrome.storage.local;
 * every write goes through one queue so a tick's spend and a revoke never overwrite each other.
 */
let streamWrites: Promise<unknown> = Promise.resolve();
const readStreamState = async (): Promise<StreamState> => {
  const got = await chrome.storage.local.get(STREAM_GRANTS_KEY).catch(() => ({}) as Record<string, unknown>);
  return parseStreamState((got as Record<string, unknown>)[STREAM_GRANTS_KEY]);
};
const updateStreamState = <T>(fn: (s: StreamState) => { state?: StreamState; result: T }): Promise<T> => {
  const run = streamWrites.then(async () => {
    const out = fn(await readStreamState());
    if (out.state) await chrome.storage.local.set({ [STREAM_GRANTS_KEY]: tidy(out.state, Date.now()) });
    return out.result;
  });
  streamWrites = run.catch(() => undefined);
  return run;
};
/**
 * One sheet for a pinned site's paid action (services/pinnedMint.ts). protocolCalls: protocol calls each site has
 * running. deferredEncrypts: rate cap for self-encrypts let through. mintIntents: the mint createAction running per
 * site (spendSeen once its spend reached a sheet; after that nothing more is let through). mintBundles: the sheet
 * words for a bundle holding a mint's spend.
 */
const protocolCalls = new ProtocolCalls();
const deferredEncrypts = new DeferredEncrypts();
const mintIntents = new Map<string, MintIntent & { spendSeen?: boolean }>();
const mintBundles = new Map<string, MintSheet>();

/** One in-flight stream-approved createAction per originator (see StreamPass). */
const streamPasses = new Map<string, StreamPass & { done: Promise<void>; finish: () => void }>();
/** Sites waiting on the "Allow <site> to stream up to $X/hour" sheet. */
const pendingStreamGrantRequests = new Map<
  string,
  { request: StreamGrantPrompt; resolve: (capSatsPerHour: number | null) => void }
>();
const failPendingStreamGrants = () => {
  for (const p of pendingStreamGrantRequests.values()) p.resolve(null);
  pendingStreamGrantRequests.clear();
};

/**
 * A master backup closes the live wallet and walks every account's storage
 * in turn. Nothing else may bring a wallet up meanwhile: a dApp call landing
 * then would initialise whichever account the export had selected last.
 */
let masterBackupInFlight = false;
/** Wallet requests that land during the backup wait here; released once the original account is open again. */
const masterBackupGate = createMasterBackupGate();

const pendingGroupedPermissionRequests = new Map<
  string,
  {
    request: GroupedPermissionRequest;
    resolve: () => void;
    reject: (error: Error) => void;
  }
>();

const pendingCounterpartyPermissionRequests = new Map<
  string,
  {
    request: CounterpartyPermissionRequest;
    resolve: () => void;
    reject: (error: Error) => void;
  }
>();

let popupWindowId: number | undefined;
let denyAllPendingPrompts: () => void = () => undefined;
/** Deny the open prompts of one originator (its grants were just revoked: Forget, unpair, lapse). */
let denyPendingPromptsFor: (originator: string) => void = () => undefined;

// bWalletX: when the wallet's side panel is open, approval prompts render inside it (an overlay of
// prompt.html) instead of a separate popup window (owner, 6 Oct 2026). activePopupPorts are the open
// panels (App.tsx connects 'extension-popup'); the window remains the fallback when no panel is open.
let promptInPanel = false;
// The prompt the open prompt UI is showing (set when it loads its payload); see services/promptQueue.ts.
let shownPrompt: ShownPrompt | undefined;
// Set when the background opened the side panel itself: the prompt shows once the panel connects.
let panelPromptOnConnect: { kind: PromptKind; requestID?: string } | undefined;

// In-page sheet (docs/ONE-SHEET-PERMISSIONS.md §3d): prompt.html in an iframe the content script puts over
// the site, used when the side panel is closed and Chrome won't open it without a click in the wallet.
const dappTabs = new Map<string, { tabId: number; windowId: number }>();
let inPageSheet: { tabId: number; token: string } | undefined;
const hideInPageSheet = () => {
  if (!inPageSheet) return;
  const { tabId } = inPageSheet;
  inPageSheet = undefined;
  chrome.tabs?.sendMessage(tabId, { action: 'BWX_INPAGE_SHEET_HIDE' }).catch(() => undefined);
};
// Connected-site themes (mobile/theme/connectTheme.ts): tab → the bundled pack its site declared after connecting.
// The open panel wears the active tab's pack and goes back to the user's own theme on any other tab.
const siteThemeTabs = new Map<number, AccentId>();
let siteThemeShown: AccentId | null = null;
const activeTabId = async (): Promise<number | undefined> => {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t?.id;
  } catch {
    return undefined;
  }
};
const pushSiteTheme = async (force = false) => {
  const tab = await activeTabId();
  const theme = (tab !== undefined && siteThemeTabs.get(tab)) || null;
  if (!force && theme === siteThemeShown) return;
  siteThemeShown = theme;
  postToPanels({ action: 'SITE_THEME', theme });
};
chrome.tabs?.onActivated?.addListener(() => void pushSiteTheme());
chrome.windows?.onFocusChanged?.addListener(() => void pushSiteTheme());
chrome.tabs?.onRemoved?.addListener((tabId) => {
  if (siteThemeTabs.delete(tabId)) void pushSiteTheme();
});
chrome.tabs?.onUpdated?.addListener((tabId, info) => {
  // A reload or navigation: the page declares again once it reconnects.
  if (info.status === 'loading' && siteThemeTabs.delete(tabId)) void pushSiteTheme();
});
const postToPanels = (msg: unknown) =>
  activePopupPorts.forEach((p) => {
    try {
      p.postMessage(msg);
    } catch {
      /* panel closing */
    }
  });
// Always tell an open panel to drop its prompt overlay: a stale one (its request gone) would otherwise sit over
// the panel's own screens, e.g. hiding the unlock screen a waiting site needs.
const hidePanelPrompt = () => {
  promptInPanel = false;
  shownPrompt = undefined;
  postToPanels({ action: 'HIDE_PROMPT_PANEL' });
};

// In-flight dApp CWI requests that may have opened (or reused) the floating popup.
let inFlightDappRequests = 0;

// Window ids the background closed itself. windows.onRemoved treats any other
// close of the prompt window as the user dismissing it and denies every pending
// prompt; a background-initiated close already checked that nothing was pending.
const selfClosedWindowIds = new Set<number>();

const hasQueuedDappUi = (): boolean =>
  pendingUsbChecks.size > 0 ||
  pendingStreamGrantRequests.size > 0 ||
  pendingPermissionRequests.size > 0 ||
  pendingGroupedPermissionRequests.size > 0 ||
  pendingCounterpartyPermissionRequests.size > 0 ||
  getPendingOneSatPrompt() !== undefined;

const closeDappPopup = (): void => {
  hidePanelPrompt();
  hideInPageSheet();
  if (!popupWindowId) return;
  selfClosedWindowIds.add(popupWindowId);
  removeWindow(popupWindowId);
  popupWindowId = undefined;
  chrome.storage.local.remove('popupWindowId');
};

/**
 * Close the floating dApp popup when no permission/approval UI is queued.
 * Ignores in-flight CWI work so unlock and permission screens dismiss as
 * soon as their UI is done; a later prompt reopens via showPromptUi.
 * Never touches the browser-action popup (activePopupPorts).
 */
/**
 * Until this time, nothing closes the dApp popup on its own: a sheet is showing why an answer was refused
 * ("This request changed while you were answering…"). The sheet closes it itself (CLOSE_PROMPT_WINDOW).
 */
let holdPopupOpenUntil = 0;
const STALE_NOTICE_MS = 5000;

const closeDappPopupIfNoUi = (): void => {
  if (Date.now() < holdPopupOpenUntil) return;
  if (!popupWindowId && !promptInPanel && !inPageSheet) return;
  if (pendingWalletWaiters.length > 0) return;
  if (hasQueuedDappUi()) return;
  closeDappPopup();
};

/**
 * Close the floating dApp popup only when fully idle: no queued UI, no
 * unlock waiters, and no in-flight dApp CWI requests.
 */
const closeDappPopupIfIdle = (): void => {
  if (Date.now() < holdPopupOpenUntil) return;
  if (!popupWindowId && !promptInPanel && !inPageSheet) return;
  if (inFlightDappRequests > 0) return;
  if (pendingWalletWaiters.length > 0) return;
  if (hasQueuedDappUi()) return;
  closeDappPopup();
};

/** Look up a queued prompt payload for the prompt window by kind/requestID. */
const getPendingPromptPayload = (kind: string, requestID?: string): unknown => {
  switch (kind) {
    case 'permission':
      return requestID ? pendingPermissionRequests.get(requestID)?.request : undefined;
    case 'bundle': {
      const bundle = requestID ? permissionBundler.get(requestID) : undefined;
      const mint = bundle ? mintBundles.get(bundle.id) : undefined;
      return bundle
        ? { bundleID: bundle.id, originator: bundle.originator, items: bundle.items, ...(mint ? { mint } : {}) }
        : undefined;
    }
    case 'groupedPermission':
      return requestID ? pendingGroupedPermissionRequests.get(requestID)?.request : undefined;
    case 'counterpartyPermission':
      return requestID ? pendingCounterpartyPermissionRequests.get(requestID)?.request : undefined;
    case 'oneSatPermission':
      return getPendingOneSatPrompt(requestID);
    case 'usbCheck':
      return requestID ? pendingUsbChecks.get(requestID)?.request : undefined;
    case 'streamGrant':
      return requestID ? pendingStreamGrantRequests.get(requestID)?.request : undefined;
    default:
      return undefined;
  }
};

/** The oldest queued prompt, if any, for the prompt window to render next. */
const getNextPendingPrompt = (): { kind: PromptKind; requestID: string } | undefined => {
  // A key check is holding up a call that already passed permission: first.
  const usbCheck = pendingUsbChecks.keys().next();
  if (!usbCheck.done) return { kind: 'usbCheck', requestID: usbCheck.value };
  const streamGrant = pendingStreamGrantRequests.keys().next();
  if (!streamGrant.done) return { kind: 'streamGrant', requestID: streamGrant.value };
  const bundle = permissionBundler.list()[0];
  if (bundle) {
    permissionBundler.flush(bundle.id); // the sheet is asking now: no need to wait out the merge window
    return { kind: 'bundle', requestID: bundle.id };
  }
  const permission = pendingPermissionRequests.keys().next();
  if (!permission.done) return { kind: 'permission', requestID: permission.value };
  const grouped = pendingGroupedPermissionRequests.keys().next();
  if (!grouped.done) return { kind: 'groupedPermission', requestID: grouped.value };
  const counterparty = pendingCounterpartyPermissionRequests.keys().next();
  if (!counterparty.done) return { kind: 'counterpartyPermission', requestID: counterparty.value };
  return getPendingOneSatPrompt()
    ? { kind: 'oneSatPermission', requestID: getPendingOneSatPrompt()!.requestID }
    : undefined;
};

/** Read the user's configured lock timeout in ms (Infinity = Never, the default). */
const getInactivityLimit = () => chromeStorageService.getLockTimeout();

// Periodic inactivity check — destroys decrypted keys when session expires.
// This runs even when the popup is closed, ensuring keys don't linger in the service worker.
chrome.alarms.create('inactivity-lock', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'inactivity-lock' || !accountContext) return;
  await chromeStorageService.getAndSetStorage();
  const { lastActiveTime } = chromeStorageService.getCurrentAccountObject();
  // Never (the default): only a deliberate lock, which writes lastActiveTime 0, gets here.
  if (isSessionExpired(lastActiveTime, getInactivityLimit())) {
    console.log('[background] Inactivity detected — wallet gone, clearing passKey');
    dropWalletContext('inactivity');
    await chromeStorageService.clearPassKey();
    await chromeStorageService.update({ isLocked: true });
  }
});

// Keep the address sync running while the wallet is open (services/addressResync.ts): a payment that lands while
// the wallet is open shows within about a minute, not only after a refresh or unlock. Quiet (no spinner); shares
// one in-flight run with the startup sync and the refresh button. On web and phones (chromeShim alarms) it skips
// while the page is hidden and runs straight away when the page comes back.
const maybeResyncAddresses = () => {
  const ctx = accountContext;
  if (
    !ctx ||
    !shouldResync({
      unlocked: true,
      hidden: pageHidden(),
      busy: ctx.addressSyncBusy(),
      lastFinishedAt: ctx.lastAddressSyncAt(),
      now: Date.now(),
    })
  )
    return;
  ctx.resyncAddresses({ quiet: true }).catch((err) => console.error('[background] address resync failed:', err));
};
chrome.alarms.create(ADDRESS_RESYNC_ALARM, { periodInMinutes: ADDRESS_RESYNC_PERIOD_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ADDRESS_RESYNC_ALARM) maybeResyncAddresses();
});
(globalThis as { document?: Document }).document?.addEventListener('visibilitychange', () => {
  if (pageHidden() === false) maybeResyncAddresses();
});

// Ring when the side panel is closed (services/callRinger.ts): every 30 s while unlocked and no
// panel or calls window is open, a notification per new incoming call; clicking opens the Calls window.
chrome.alarms.create(CALL_RING_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CALL_RING_ALARM || !accountContext) return;
  const base = accountContext.baseWallet;
  try {
    const incoming = await fetchIncoming(async (u, i) => fetch(await routeBchatUrl(u), i), {
      identityKey: async () => (await base.getPublicKey({ identityKey: true })).publicKey,
      sign: async (message) => {
        const { signature } = await base.createSignature({
          data: Array.from(new TextEncoder().encode(message)),
          protocolID: [2, 'bwallet calls'],
          keyID: '1',
          counterparty: 'anyone',
        });
        return signature.map((b) => b.toString(16).padStart(2, '0')).join('');
      },
    });
    const stored = await chrome.storage.session.get('bwxRungCalls').catch(() => ({}) as Record<string, unknown>);
    const seen = new Set<string>(Array.isArray(stored.bwxRungCalls) ? (stored.bwxRungCalls as string[]) : []);
    const fresh = callsToAnnounce(incoming, seen, activePopupPorts.size > 0);
    for (const c of fresh) {
      const n = callNotification(c);
      chrome.notifications?.create(n.id, n.options);
      seen.add(c.id);
    }
    if (fresh.length) await chrome.storage.session.set({ bwxRungCalls: [...seen].slice(-50) }).catch(() => undefined);
  } catch (e) {
    console.warn('[background] call ring check failed:', e instanceof Error ? e.message : e);
  }
});
chrome.notifications?.onClicked?.addListener((id) => {
  if (!id.startsWith(CALL_NOTIFICATION_PREFIX)) return;
  chrome.notifications.clear(id);
  openCallsWindow(chrome as never);
});

// Forward declarations for the prompt-window launchers (defined inside the
// isInServiceWorker block below).
let showPromptUi: (kind: PromptKind, requestID?: string) => void = () => {
  console.warn('showPromptUi called before initialization');
};
let showUnlockUi: () => void = () => {
  console.warn('showUnlockUi called before initialization');
};

/**
 * Bind permission callbacks to the WalletPermissionsManager.
 * These callbacks are triggered when an external app needs permission.
 */
const bindPermissionCallbacks = (manager: LocalWalletPermissionsManager) => {
  // Protocol permission (signing, encrypting, HMAC, etc.)
  manager.bindCallback('onProtocolPermissionRequested', async (request: PermissionRequest & { requestID: string }) => {
    console.log('Protocol permission requested:', request);
    await showPermissionPrompt(request);
  });

  // Basket access permission (listing, inserting, removing outputs)
  manager.bindCallback('onBasketAccessRequested', async (request: PermissionRequest & { requestID: string }) => {
    console.log('Basket access requested:', request);
    await showPermissionPrompt(request);
  });

  // Certificate access permission
  manager.bindCallback('onCertificateAccessRequested', async (request: PermissionRequest & { requestID: string }) => {
    console.log('Certificate access requested:', request);
    await showPermissionPrompt(request);
  });

  // Spending authorization
  manager.bindCallback(
    'onSpendingAuthorizationRequested',
    async (request: PermissionRequest & { requestID: string }) => {
      console.log('Spending authorization requested:', request);
      await showPermissionPrompt(request);
    },
  );

  // Grouped permission (all permissions from manifest.json bundled)
  manager.bindCallback('onGroupedPermissionRequested', async (request: GroupedPermissionRequest) => {
    console.log('Grouped permission requested:', request);
    await showGroupedPermissionPrompt(request);
  });

  // Counterparty pact (level-2 protocols for a specific counterparty)
  manager.bindCallback('onCounterpartyPermissionRequested', async (request: CounterpartyPermissionRequest) => {
    console.log('Counterparty permission requested:', request);
    await showCounterpartyPermissionPrompt(request);
  });
};

/**
 * Show a permission prompt popup and wait for user response.
 * Returns a promise that resolves when user grants permission or rejects when denied.
 */
const showPermissionPrompt = (request: PermissionRequest & { requestID: string }): Promise<void> => {
  console.log('[background] showPermissionPrompt called, requestID:', request.requestID, 'type:', request.type);
  if (request.type === 'protocol' && isReservedProtocol(request.protocolID) && request.originator !== ADMIN_ORIGINATOR) {
    accountContext?.wallet.denyPermission(request.requestID).catch(() => undefined);
    return Promise.reject(new Error(RESERVED_REFUSAL));
  }
  // The wallet's own baskets (coins, ordinals, tokens, locks, names) are never offered to a site.
  if (request.type === 'basket' && isReservedBasket(request.basket) && request.originator !== ADMIN_ORIGINATOR) {
    accountContext?.wallet.denyPermission(request.requestID).catch(() => undefined);
    return Promise.reject(new Error(RESERVED_BASKET_REFUSAL));
  }
  // A pinned site's paid action (services/pinnedMint.ts): its self-encrypts, and its own label while its
  // createAction runs, go through for that one call (ephemeral, nothing stored); its spend is the one sheet.
  const mintSite = request.originator && request.originator !== ADMIN_ORIGINATOR ? normalizeOriginator(request.originator) : '';
  if (mintSite && accountContext?.wallet) {
    const asSite = { ...request, originator: mintSite };
    const now = Date.now();
    if (shouldDeferEncrypt(asSite, protocolCalls, deferredEncrypts, now)) {
      deferredEncrypts.note(mintSite, request.protocolID as [number, string], now);
      return accountContext.wallet.grantPermission({ requestID: request.requestID, ephemeral: true });
    }
    const intent = mintIntents.get(mintSite);
    if (intent && !intent.spendSeen && labelCoveredByIntent(asSite, intent))
      return accountContext.wallet.grantPermission({ requestID: request.requestID, ephemeral: true });
  }
  // A stream-approved createAction is running for this site: its spend (within the budget) and its label are
  // answered here, without a sheet. Nothing else is (services/streamGrants.ts passCovers).
  // Streaming grants are allowances: with envelopes (the default) no pass ever answers a spend (allowanceFlag.ts).
  const pass =
    ALLOWANCES_ENABLED && request.originator ? streamPasses.get(normalizeOriginator(request.originator)) : undefined;
  if (pass && accountContext?.wallet && passCovers(pass, { ...request, originator: normalizeOriginator(request.originator) })) {
    if (request.type === 'spending') pass.charged = request.spending?.satoshis;
    return accountContext.wallet.grantPermission({ requestID: request.requestID, ephemeral: true });
  }
  return Promise.all([siteBlocked(request.originator), siteTrustedFor(request)]).then(
    ([blocked, trusted]) =>
      new Promise<void>((resolve, reject) => {
        if (blocked) {
          accountContext?.wallet.denyPermission(request.requestID).catch(() => undefined);
          reject(new Error(BLOCKED_SITE_REFUSAL));
          return;
        }
        if (trusted && accountContext?.wallet) {
          // A site the user said "don't ask again" for: routine requests go through without a sheet.
          accountContext.wallet
            .grantPermission({ requestID: request.requestID, expiry: withDefaultExpiry(0) })
            .then(() => resolve())
            .catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        let bundle;
        try {
          // A request arriving while this site's sheet is open waits for its own sheet (never joins that one).
          bundle = permissionBundler.add(request as BundledRequest & BundleRequest);
        } catch (error) {
          accountContext?.wallet.denyPermission(request.requestID).catch(() => undefined);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        pendingPermissionRequests.set(request.requestID, { request, resolve, reject });
        if (!bundle) return; // queued: companions are asked when its sheet opens (askCompanionsFor)
        askPostCompanions(request.originator, bundle.items);
        askMintCompanions(mintSite, request, bundle.id);
      }),
  );
};

/**
 * A pinned site's mint spend reached a sheet: ask, on the SAME sheet, for the pinned protocol (so its records open
 * later without a sheet) and the action's own labels (so it can list them). The manager only asks for what the site
 * has not been granted. The sheet gets the mint's words ("Mint 3 videos, locked to you on bvideox.com").
 */
/** A bundle opened from a site's queue: ask for its post and mint companions, as add() does for a new request. */
const askCompanionsFor = (bundle: { id: string; originator: string; items: (BundledRequest & BundleRequest)[] }) => {
  askPostCompanions(bundle.originator, bundle.items);
  const site =
    bundle.originator && bundle.originator !== ADMIN_ORIGINATOR ? normalizeOriginator(bundle.originator) : '';
  for (const r of bundle.items) askMintCompanions(site, r, bundle.id);
};

const askMintCompanions = (site: string, request: PermissionRequest & { requestID: string }, bundleID: string) => {
  const wallet = accountContext?.wallet;
  const intent = site ? mintIntents.get(site) : undefined;
  if (!wallet || !intent || intent.spendSeen || request.type !== 'spending') return;
  intent.spendSeen = true;
  mintBundles.set(bundleID, mintSheetFor(intent, request.spending?.satoshis ?? 0));
  const reason = pinnedProtocol(intent.protocolID)?.label ?? intent.description;
  const asks = [
    { protocolID: intent.protocolID as [0 | 1 | 2, string], usageType: 'encrypting' as const },
    ...intent.labels.map((l) => ({ protocolID: [1, `action label ${l}`] as [0 | 1 | 2, string], usageType: 'generic' as const })),
  ];
  for (const a of asks)
    wallet
      .ensureProtocolPermission({
        originator: request.originator,
        privileged: false,
        protocolID: a.protocolID,
        counterparty: 'self',
        usageType: a.usageType,
        reason,
      })
      .catch(() => undefined);
};

/**
 * A site's first post: when one of the first-post set (identity basket "bap", post signature "sigma") reaches a
 * sheet, ask for the others at the same moment, so they join the SAME sheet ("Allow <site> to post for you")
 * instead of arriving one after another. The manager only asks for what the site has not been granted, and the
 * site's later real call finds the grant (or joins the pending request). A refusal here only rejects this
 * pre-ask; the site still gets the standard denial on its own call.
 */
const postAskedAt = new Map<string, number>();
const askPostCompanions = (originator: string, items: BundleRequest[]) => {
  const wallet = accountContext?.wallet;
  if (!wallet || !originator || originator === ADMIN_ORIGINATOR) return;
  if (postPackCompanions(items).length === 0) return;
  // Once per site per minute: the companions' own sheets come back through here.
  const last = postAskedAt.get(originator);
  if (last !== undefined && Date.now() - last < 60_000) return;
  postAskedAt.set(originator, Date.now());
  for (const kind of postPackCompanions(items)) {
    const ask =
      kind === 'basket'
        ? wallet.ensureBasketAccess({ originator, basket: POST_BASKET, usageType: 'listing', reason: 'Post as you' })
        : wallet.ensureProtocolPermission({
            originator,
            privileged: false,
            protocolID: POST_PROTOCOL,
            counterparty: 'self',
            usageType: 'signing',
            reason: 'Sign your posts',
          });
    ask.catch(() => undefined);
  }
};

/**
 * True when the user ticked "Don't ask again" for this site and this request is a routine kind that the approved
 * sheet covered (a basket only if it was one shown on that sheet).
 */
/** The user chose "Block this site" on a sheet (BundleSheet): every request from it is refused without a sheet. */
const siteBlocked = async (originator: string | undefined): Promise<boolean> => {
  const store = accountContext?.permissionStore;
  if (!store || !originator || originator === ADMIN_ORIGINATOR) return false;
  try {
    const grant = await store.findGrant({ type: 'basket', originator: normalizeOriginator(originator), basket: BLOCK_SITE_BASKET });
    return blockActive(grant as { expiry: number } | null);
  } catch {
    return false;
  }
};

const siteTrustedFor = async (request: PermissionRequest & { requestID: string }): Promise<boolean> => {
  const store = accountContext?.permissionStore;
  if (!store || !request.originator) return false;
  try {
    const grant = await store.findGrant({
      type: 'basket',
      originator: normalizeOriginator(request.originator),
      basket: TRUST_SITE_BASKET,
    });
    return trustCovers(grant as { expiry: number; baskets?: unknown } | null, request as BundledRequest & BundleRequest);
  } catch {
    return false;
  }
};

/** Forget site, basket part: see revokeBasketGrantsForOriginator. Also clears the manager's recent-grant cover. */
const revokeBasketGrantsFor = async (originator: string): Promise<void> => {
  const store = accountContext?.permissionStore;
  if (!store || !originator) return;
  await revokeBasketGrantsForOriginator(store, originator, normalizeOriginator);
  const recent = (accountContext?.wallet as unknown as { recentGrants?: unknown } | undefined)?.recentGrants;
  if (recent instanceof Map) recent.clear();
};

const showGroupedPermissionPrompt = async (request: GroupedPermissionRequest): Promise<void> => {
  if (await siteBlocked(request.originator)) {
    accountContext?.wallet.denyGroupedPermission(request.requestID).catch(() => undefined);
    throw new Error(BLOCKED_SITE_REFUSAL);
  }
  return new Promise((resolve, reject) => {
    pendingGroupedPermissionRequests.set(request.requestID, { request, resolve, reject });
    showPromptUi('groupedPermission', request.requestID);
  });
};

const showCounterpartyPermissionPrompt = async (request: CounterpartyPermissionRequest): Promise<void> => {
  if (await siteBlocked(request.originator)) {
    accountContext?.wallet.denyCounterpartyPermission(request.requestID).catch(() => undefined);
    throw new Error(BLOCKED_SITE_REFUSAL);
  }
  return new Promise((resolve, reject) => {
    pendingCounterpartyPermissionRequests.set(request.requestID, { request, resolve, reject });
    showPromptUi('counterpartyPermission', request.requestID);
  });
};

// only run in background worker
if (isInServiceWorker) {
  const deleteAllIDBDatabases = async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name?.startsWith('block')) continue;
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
        console.log(`Deleted database: ${db.name}`);
      }
    }

    console.log('All IndexedDB databases deleted.');
  };

  const signOut = async () => {
    dropWalletContext('signOut');
    await chromeStorageService.clearPassKey();
    await deleteAllIDBDatabases();
  };

  const switchAccount = async () => {
    console.log('[background] switchAccount: starting');
    const doSwitch = async () => {
      try {
        // An envelope sheet asked under the old account must not be answered on the new one.
        failPendingStreamGrants();
        dropWalletContext('switchAccount');
        chromeStorageService = new ChromeStorageService();
        await chromeStorageService.getAndSetStorage();
        console.log('[background] switchAccount: storage loaded, initializing wallet');
        await initializeWallet();
        console.log('[background] switchAccount: wallet initialized successfully');
        return (accountContext as AccountContext | null)?.wallet ?? null;
      } catch (error) {
        console.error('[background] switchAccount: failed to initialize wallet:', error);
        return null;
      } finally {
        reinitPromise = null;
      }
    };
    reinitPromise = doSwitch();
    await reinitPromise;
  };

  const createNewPopup = (kind?: PromptKind, requestID?: string) => {
    console.log('[background] createNewPopup called', kind, requestID);
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (requestID) params.set('requestID', requestID);
    const query = params.toString();
    chrome.windows.create(
      {
        url: chrome.runtime.getURL('prompt.html') + (query ? `?${query}` : ''),
        type: 'popup',
        width: 392,
        height: 567,
      },
      (window) => {
        popupWindowId = window?.id;
        if (popupWindowId) {
          chrome.storage.local.set({
            popupWindowId,
          });
        } else if (kind === 'usbCheck') {
          failPendingUsbChecks(USB_KEY_ABSENT_MESSAGE);
        }
      },
    );
  };

  const notifyPromptWindow = (kind: PromptKind, requestID?: string) => {
    // One approval at a time: a prompt still being answered is never replaced; this one waits in the queue and
    // the UI loads it next (prompt-tab advance → GET_NEXT_PROMPT).
    const stillPending = !!shownPrompt && !!getPendingPromptPayload(shownPrompt.kind, shownPrompt.requestID);
    if (!shouldPushPrompt(shownPrompt, stillPending, { kind, requestID })) return;
    chrome.runtime.sendMessage({ action: 'SHOW_PROMPT', kind, requestID }).catch(() => {
      // No listener (window still booting); it reads its URL params on mount
    });
  };

  notifyPromptUpdated = (kind, requestID) => {
    notifyPromptWindow(kind, requestID);
  };

  showPromptUi = (kind, requestID) => {
    console.log('[background] showPromptUi called', kind, requestID);

    // Side panel open: show the prompt inside it (the panel's own unlock screen covers 'unlock').
    // Extension only: the phone and web wallet also connect an 'extension-popup' port, but their UI has no
    // PanelPrompt, so a prompt sent there was never drawn and the site waited forever (bChatX in the bApp
    // frame stuck on "Connecting", 14 Oct 2026). They show prompts as overlays (windows.create below).
    if (promptsShowInPanel(activePopupPorts.size, chrome) && kind !== 'unlock') {
      promptInPanel = true;
      postToPanels({ action: 'SHOW_PROMPT_PANEL', kind, requestID });
      notifyPromptWindow(kind, requestID); // an overlay that is already up loads the next prompt
      return;
    }

    // A sheet is already over the site: it loads the next prompt in place.
    if (inPageSheet) {
      notifyPromptWindow(kind, requestID);
      return;
    }

    // Desktop extension only (the phone build has no side panel and shows its own overlay).
    const tab = kind === 'usbCheck' ? undefined : tabForPrompt(kind, requestID);
    if (tab && (chrome as unknown as { sidePanel?: unknown }).sidePanel) {
      void openInsideWallet(kind, requestID, tab).then((shown) => {
        if (!shown) showPromptWindow(kind, requestID);
      });
      return;
    }
    showPromptWindow(kind, requestID);
  };

  /** The site's tab for a prompt, from the request's originator (or the last site that called). */
  const tabForPrompt = (kind: PromptKind, requestID?: string) => {
    const payload = requestID ? (getPendingPromptPayload(kind, requestID) as { originator?: string } | undefined) : undefined;
    const origin = payload?.originator;
    if (origin && dappTabs.has(origin)) return dappTabs.get(origin);
    return undefined;
  };

  /**
   * Try the side panel (Chrome may refuse without a click in the wallet), then the in-page sheet.
   * Resolves false when neither showed, so the caller falls back to the separate window.
   */
  const openInsideWallet = async (
    kind: PromptKind,
    requestID: string | undefined,
    tab: { tabId: number; windowId: number },
  ): Promise<boolean> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sp = (chrome as any).sidePanel;
    try {
      await sp.open({ tabId: tab.tabId, windowId: tab.windowId });
      // The panel connects its port in a moment; show the prompt there once it does.
      panelPromptOnConnect = { kind, requestID };
      return true;
    } catch {
      /* no user gesture: fall through to the in-page sheet */
    }
    const token = crypto.randomUUID();
    const params = new URLSearchParams({ kind, inpage: token });
    if (requestID) params.set('requestID', requestID);
    inPageSheet = { tabId: tab.tabId, token }; // before the frame loads: it checks the token on boot
    try {
      const res = (await chrome.tabs.sendMessage(tab.tabId, {
        action: 'BWX_INPAGE_SHEET_SHOW',
        query: params.toString(),
      })) as { ok?: boolean } | undefined;
      if (res?.ok) return true;
    } catch {
      /* no content script here (chrome://, Web Store, tab gone) */
    }
    if (inPageSheet?.token === token) inPageSheet = undefined;
    return false;
  };

  const showPromptWindow = (kind: PromptKind, requestID?: string) => {

    // Check if any popup window with our extension URL is already open
    chrome.windows.getAll({ populate: true }, (windows) => {
      const promptUrl = chrome.runtime.getURL('prompt.html');
      const existingPopup = windows.find(
        (w) => w.type === 'popup' && w.tabs?.some((tab) => tab.url?.startsWith(promptUrl)),
      );

      if (existingPopup) {
        // Focus existing popup and push the new prompt into it
        chrome.windows.update(existingPopup.id!, { focused: true });
        popupWindowId = existingPopup.id;
        notifyPromptWindow(kind, requestID);
        return;
      }

      // Fast path: module-level variable still has the popup ID
      if (popupWindowId) {
        chrome.windows
          .update(popupWindowId, { focused: true })
          .then(() => notifyPromptWindow(kind, requestID))
          .catch(() => {
            popupWindowId = undefined;
            createNewPopup(kind, requestID);
          });
        return;
      }

      // Module-level var is lost after service worker suspension; check storage
      chrome.storage.local.get('popupWindowId', (result) => {
        if (result.popupWindowId) {
          chrome.windows
            .update(result.popupWindowId, { focused: true })
            .then(() => {
              popupWindowId = result.popupWindowId;
              notifyPromptWindow(kind, requestID);
            })
            .catch(() => {
              chrome.storage.local.remove('popupWindowId');
              createNewPopup(kind, requestID);
            });
        } else {
          createNewPopup(kind, requestID);
        }
      });
    });
  };

  showUnlockUi = () => {
    // The browser-action popup renders its own unlock UI; never force a
    // window over it just to unlock.
    if (activePopupPorts.size > 0) {
      // The panel shows its own unlock screen, but only if told (it may think it is unlocked after the
      // inactivity lock) and only if no stale prompt overlay covers it.
      promptInPanel = false;
      shownPrompt = undefined;
      panelUnlockMessages().forEach((m) => postToPanels(m));
      return;
    }
    showPromptUi('unlock');
  };

  // Wire the 1Sat permission module's prompt bridge into the prompt flow.
  // Done once during background init so showOneSatPrompt has a working
  // bridge before initWallet (called on unlock) registers the module.
  initOneSatPromptBridge({
    showPrompt: (requestID) => showPromptUi('oneSatPermission', requestID),
  });

  // Passkey hand-off from web.bwalletx.com (VITE_SEEDLESS=1 builds only; notes/extension-passkey-handoff.md). The
  // manifest lets only that exact page message the extension; this re-checks sender.origin anyway. The words are
  // parked in chrome.storage.session and are NEVER restored here or logged: the popup releases them after the
  // person types the code the web page shows. Anything refused gets the same generic answer.
  if (HANDOFF_ENABLED) {
    void sweepExpiredHandoff();
    chrome.alarms?.onAlarm.addListener((a) => a.name === HANDOFF_ALARM && void sweepExpiredHandoff());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chrome.runtime.onMessage.addListener((message: any, sender, answer: CallbackResponse) => {
    // Every refusal by the user carries code ERR_PERMISSION_DENIED (services/userDenied.ts), so a site can tell
    // "declined" from "failed" on every path (extension, phone dApp browser, bApp frames, pairing).
    const sendResponse: CallbackResponse = (response) => answer(withDenialCode(response));
    console.log(
      '[background] Received message:',
      message.action,
      'originator:',
      message.originator,
      'from:',
      sender.origin,
    );

    // Passkey hand-off from web.bwalletx.com, forwarded by content.ts (VITE_SEEDLESS=1 only). sender.origin is Chrome's
    // own value for the tab; handleExternalHandoff accepts exactly https://web.bwalletx.com plus the one-time nonce.
    if (HANDOFF_ENABLED && message?.action === 'bwxExtHandoff') {
      void handleExternalHandoff(message.data, sender.origin).then((ok) => (sendResponse as (r: unknown) => void)({ ok }));
      return true;
    }

    // Live-balance messages are for the wallet page (src/mobile/wallet/live/liveBus.ts), not the wallet: never
    // answer them here, so a page's session report can never reach a wallet method or a connect prompt.
    if (message?.action === 'bwxSessionSpend' || message?.action === 'bwxLiveSpend') return false;
    // Connected-site theme (mobile/theme/connectTheme.ts): the id comes from the page, the origin from Chrome.
    if (message?.action === 'bwxSiteTheme') {
      if (sender.id === chrome.runtime.id && sender.tab?.id !== undefined && sender.frameId === 0) {
        const id = siteThemeFor(sender.origin, message.theme);
        if (id) siteThemeTabs.set(sender.tab.id, id);
        else siteThemeTabs.delete(sender.tab.id);
        void pushSiteTheme();
      }
      return false;
    }
    // Subscribe requests are answered by the wallet page (src/mobile/pots/siteSubscribe.ts), never by a wallet method.
    // SUBSCRIPTIONS_ENABLED written out (literal env) so the minifier drops it from a store bundle.
if (!(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
) && message?.action === 'bwxSubscribe') return false;

    // Check if message is from our own extension pages. Admin status follows from THIS, never from an
    // originator string a page supplies (security review H1).
    const isFromExtension = isExtensionSender(sender, chrome.runtime.id);

    // A web page whose host is the bare extension id (http://<extid>/) would pass the host cross-check below
    // and become the wallet itself. Refuse the admin originator from anything but our own pages.
    const reserved = reservedOriginatorRefusal(isFromExtension, message?.originator, ADMIN_ORIGINATOR);
    if (reserved) {
      sendResponse({ type: message?.action, success: false, error: reserved });
      return true;
    }

    // A page message with no claimed originator takes the sender's real one, so it is never checked (or granted)
    // as "no site" (payment-safety audit 24 Oct 2026, B1 Low).
    if (!isFromExtension && message && typeof message === 'object' && !message.originator && sender.origin) {
      const filled = originatorForOrigin(sender.origin);
      if (filled.originator) message.originator = filled.originator;
    }

    // Cross-validate originator against sender.origin for external messages
    if (!isFromExtension && message.originator && sender.origin) {
      // The originator must be the one derived from the sender's origin; plain-http (non-loopback) senders are
      // refused so they never share an https site's grants or allowances (security review M3).
      const expected = originatorForOrigin(sender.origin);
      if (!expected.originator) {
        sendResponse({ type: message.action, success: false, error: expected.error });
        return true;
      }
      if (message.originator !== expected.originator) {
        sendResponse({ type: message.action, success: false, error: 'Origin mismatch' });
        return true;
      }
    }

    // Wallet-internal protocols (bTrust, Locks, funds, presign…) are never available to an outside site or app,
    // and the refusal comes before any unlock or permission sheet (services/reservedProtocols.ts, audit C1).
    if (!isFromExtension && message?.originator !== ADMIN_ORIGINATOR) {
      const refusal =
        reservedProtocolRefusal(String(message?.action ?? ''), message?.params) ??
        // Protocols pinned to their home site (services/pinnedProtocols.ts): a user's private archive keys.
        pinnedProtocolRefusal(
          String(message?.action ?? ''),
          message?.params,
          sender.origin ? normalizeOriginator(sender.origin) : undefined,
        );
      if (refusal) {
        sendResponse({ type: message.action, success: false, error: refusal });
        return true;
      }
    }

    // Remember which tab each site talks from, so its sheet can open over that tab (in-page sheet).
    if (!isFromExtension && message.originator && sender.tab?.id !== undefined) {
      dappTabs.set(message.originator, { tabId: sender.tab.id, windowId: sender.tab.windowId });
    }

    // Streaming spending grants (services/streamGrants.ts). A site's request/revoke/status: the originator is
    // always Chrome's (or the native WebView's) sender.origin, never anything the page put in the message.
    if (!isFromExtension && isSpendingAuthAction(message?.action)) {
      const derived = originatorForOrigin(sender.origin);
      if (!derived.originator) {
        sendResponse({ type: message.action, success: false, error: derived.error });
        return true;
      }
      void handleSpendingAuth(String(message.action), derived.originator, message.params, sendResponse);
      return true;
    }
    // Settings › Envelopes and Coin return. Extension pages only.
    if (typeof message?.action === 'string' && message.action.startsWith('ENVELOPE')) {
      if (!isFromExtension) {
        sendResponse({ type: message.action, success: false, error: 'Unauthorized' });
        return true;
      }
      void handleEnvelopesInternal(message as { action: string } & Record<string, unknown>, sendResponse);
      return true;
    }
    // The wallet's own Streaming permissions screen and the grant sheet. Extension pages only.
    if (typeof message?.action === 'string' && message.action.startsWith('STREAM_GRANT')) {
      if (!isFromExtension) {
        sendResponse({ type: message.action, success: false, error: 'Unauthorized' });
        return true;
      }
      void handleStreamGrantInternal(message as { action: string } & Record<string, unknown>, sendResponse);
      return true;
    }

    // Queued sends the network has not accepted (services/stuckSends.ts resolveUnsent): list them, send one now, or
    // cancel one the network never got (releases its inputs). Extension pages only; never a site.
    if (message?.action === 'UNSENT_SENDS') {
      if (!isFromExtension) {
        sendResponse({ type: message.action, success: false, error: 'Unauthorized' });
        return true;
      }
      void (async () => {
        const ctx = accountContext;
        if (!ctx) throw new Error('Unlock your wallet first');
        const m = message as { txid?: string; how?: 'send' | 'cancel' };
        if (!m.txid) return { queued: await ctx.listUnsent() };
        if (m.how !== 'send' && m.how !== 'cancel') throw new Error('Say send or cancel');
        const out = await ctx.resolveUnsent(m.txid, m.how);
        if (out.ok && out.result === 'cancelled') notifyBalanceUpdate();
        if (out.ok && out.result === 'still-queued') sendRetry.arm();
        return out;
      })()
        .then((data) => sendResponse({ type: 'UNSENT_SENDS', success: true, data }))
        .catch((e: unknown) =>
          sendResponse({ type: 'UNSENT_SENDS', success: false, error: e instanceof Error ? e.message : String(e) }),
        );
      return true;
    }

    // Actions that don't require authorization
    const noAuthRequired = [
      YoursEventName.SWITCH_ACCOUNT,
      YoursEventName.SIGNED_OUT,
      // CWI auth check (no auth required - just checks status)
      CWIEventName.IS_AUTHENTICATED,
      // CWI discovery (no auth required - substrate detection ping)
      CWIEventName.GET_VERSION,
      // Permission responses from popup
      'PERMISSION_RESPONSE',
      'BUNDLE_PERMISSION_RESPONSE',
      'BUNDLE_SHEET_FREEZE',
      'GET_BUNDLE_ALLOWANCE',
      'GROUPED_PERMISSION_RESPONSE',
      'COUNTERPARTY_PERMISSION_RESPONSE',
      'ONE_SAT_PERMISSION_RESPONSE',
      'USB_CHECK_RESPONSE',
      // Prompt window flow queries
      'GET_PROMPT_PAYLOAD',
      'GET_NEXT_PROMPT',
      'CLOSE_PROMPT_WINDOW',
      'INPAGE_SHEET_CHECK',
      // Internal UI requests (no external domain)
      YoursEventName.GET_BALANCE,
      YoursEventName.GET_PUB_KEYS,
      YoursEventName.GET_LEGACY_ADDRESSES,
      YoursEventName.GET_RECEIVE_ADDRESS,
      YoursEventName.GET_SOCIAL_PROFILE,
      // Wallet lock/unlock
      'WALLET_LOCKED',
      'WALLET_UNLOCKED',
      // Master backup/restore
      'MASTER_BACKUP',
      'MASTER_RESTORE',
      // USB key security (popup / USB window internal)
      'USB_REKEY',
      'USB_PING',
      'USB_BACKUP_CHUNK',
      'USB_BACKUP_SETTINGS',
      // Storage management (popup internal)
      'STORAGE_GET_INFO',
      'STORAGE_SYNC_BACKUPS',
      'STORAGE_REPAIR_SYNC',
      'STORAGE_RECOVER_MINED',
      'STORAGE_RECOVER_TXID',
      'STORAGE_RECONCILE_POSTAGE',
      'STORAGE_RESYNC_COINS',
      'STORAGE_RESTORE_BACKUP',
      'BSV21_FIX_STALE',
      'BSV21_FIX_UNSEEN',
      'STORAGE_SET_ACTIVE_STORAGE',
      'STORAGE_ADD_REMOTE',
      'STORAGE_REMOVE_REMOTE',
      // Permissions management (popup internal)
      'PERMISSIONS_LIST_ALL',
      'PERMISSIONS_QUERY_SPENT',
      'PERMISSIONS_REVOKE_ONE',
      'PERMISSIONS_REVOKE_ALL',
      // Settings (popup internal)
      'UPDATE_FEE_RATE',
      // Address management (popup internal)
      'GET_DEPOSIT_ADDRESSES',
      'GENERATE_NEW_ADDRESS',
      // The Wallet home's refresh: its handler below was unreachable without this entry (the message fell through
      // to the CWI switch, which never answered, so every refresh waited out its 15 s timeout).
      'RESYNC_ADDRESSES',
    ];

    if (noAuthRequired.includes(message.action)) {
      // IS_AUTHENTICATED and GET_VERSION are read-only discovery endpoints safe for any caller.
      // Everything else is an internal popup→background message that requires the sender
      // to be the extension itself (not a web page proxied through the content script).
      const openToAll = [CWIEventName.IS_AUTHENTICATED, CWIEventName.GET_VERSION];
      if (!openToAll.includes(message.action) && !isFromExtension) {
        sendResponse({ type: message.action, success: false, error: 'Unauthorized' });
        return true;
      }

      switch (message.action) {
        case YoursEventName.SWITCH_ACCOUNT:
          switchAccount()
            .then(() => {
              sendResponse({ type: YoursEventName.SWITCH_ACCOUNT, success: true });
            })
            .catch((error) => {
              sendResponse({ type: YoursEventName.SWITCH_ACCOUNT, success: false, error: String(error) });
            });
          return true;
        case YoursEventName.SIGNED_OUT:
          return signOut();
        // CWI auth check
        case CWIEventName.IS_AUTHENTICATED:
          return processCWIIsAuthenticated(sendResponse);
        // CWI discovery - substrate detection ping, no wallet needed
        case CWIEventName.GET_VERSION:
          sendResponse({
            type: CWIEventName.GET_VERSION,
            success: true,
            // pinnedProtocols: sites can tell this wallet keeps pinned protocols (services/pinnedProtocols.ts) to their home site.
            data: { version: versionWithPins(`yours-wallet-${chrome.runtime.getManifest().version}`), pinnedProtocols: PINNED_PROTOCOLS_VERSION },
          });
          return true;
        // Permission responses from popup UI
        case 'PERMISSION_RESPONSE':
          return processPermissionResponse(message as { requestID: string; granted: boolean; expiry?: number });
        case 'BUNDLE_PERMISSION_RESPONSE':
          return processBundlePermissionResponse(
            message as {
              bundleID: string;
              decisions: Record<string, boolean>;
              allowanceUsd?: number;
              allowancePerPaymentUsd?: number;
              allowancePayees?: string[];
              envelopeUsd?: number;
              remember?: boolean;
              trustSite?: boolean;
              block?: boolean;
              seenHash?: string;
            },
            sendResponse,
          );
        case 'BUNDLE_SHEET_FREEZE':
          // The user touched the sheet: anything arriving now gets its own sheet.
          permissionBundler.freeze((message as { bundleID: string }).bundleID);
          sendResponse({ type: 'BUNDLE_SHEET_FREEZE', success: true });
          return true;
        case 'GET_BUNDLE_ALLOWANCE':
          getBundleAllowance((message as { originator: string }).originator)
            .then((data) => sendResponse({ type: 'GET_BUNDLE_ALLOWANCE', success: true, data }))
            .catch((error) => sendResponse({ type: 'GET_BUNDLE_ALLOWANCE', success: false, error: String(error) }));
          return true;
        case 'GROUPED_PERMISSION_RESPONSE':
          return processGroupedPermissionResponse(
            message as { requestID: string; granted: Partial<GroupedPermissions> | null; expiry?: number },
          );
        case 'COUNTERPARTY_PERMISSION_RESPONSE':
          return processCounterpartyPermissionResponse(
            message as { requestID: string; granted: Partial<CounterpartyPermissions> | null; expiry?: number },
          );
        case 'ONE_SAT_PERMISSION_RESPONSE': {
          const { requestID, approved } = message as { requestID: string; approved: boolean };
          const handled = handleOneSatPermissionResponse(requestID, !!approved);
          sendResponse({ type: 'ONE_SAT_PERMISSION_RESPONSE', success: handled });
          return true;
        }
        case 'USB_CHECK_RESPONSE': {
          const { requestID, ok } = message as { requestID: string; ok: boolean };
          const pending = pendingUsbChecks.get(requestID);
          pendingUsbChecks.delete(requestID);
          if (pending) {
            if (ok) pending.resolve();
            else pending.reject(new Error(USB_KEY_ABSENT_MESSAGE));
          }
          sendResponse({ type: 'USB_CHECK_RESPONSE', success: !!pending });
          return true;
        }
        // Prompt window payload/flow queries
        case 'GET_PROMPT_PAYLOAD': {
          const { kind, requestID } = message as { kind: string; requestID?: string };
          const payload = getPendingPromptPayload(kind, requestID);
          if (payload) shownPrompt = { kind, requestID };
          console.log('[background] GET_PROMPT_PAYLOAD', kind, requestID, 'found:', !!payload);
          sendResponse({ type: 'GET_PROMPT_PAYLOAD', success: !!payload, data: payload });
          return true;
        }
        case 'GET_NEXT_PROMPT': {
          sendResponse({
            type: 'GET_NEXT_PROMPT',
            success: true,
            data: { prompt: getNextPendingPrompt(), busy: inFlightDappRequests > 0 },
          });
          return true;
        }
        // The prompt window never closes itself. It asks here, and the background
        // closes it only if nothing is pending at that instant; otherwise it hands
        // back the next prompt to render. This removes the race where a prompt
        // queued between "nothing pending" and the actual close was denied as a
        // user dismissal by windows.onRemoved.
        case 'INPAGE_SHEET_CHECK': {
          // The in-page sheet proves it was put there by us (token from showInPageSheet), not framed by the site.
          const { token } = message as { token?: string };
          const ok = !!token && !!inPageSheet && token === inPageSheet.token;
          sendResponse({ type: 'INPAGE_SHEET_CHECK', success: ok });
          return true;
        }
        case 'RESYNC_ADDRESSES': {
          // The refresh button's address sync runs here, sharing the one in-flight run with the startup sync and
          // the alarm (services/addressResync.ts), so two syncs never overlap.
          const ctx = accountContext;
          if (!ctx) {
            sendResponse({ type: 'RESYNC_ADDRESSES', success: false, error: 'locked' });
            return true;
          }
          const manual = message.manual === true;
          if (
            !refreshShouldSync({
              manual,
              busy: ctx.addressSyncBusy(),
              lastFinishedAt: ctx.lastAddressSyncAt(),
              now: Date.now(),
            })
          ) {
            // An automatic refresh right after a finished run: storage is already current.
            sendResponse({ type: 'RESYNC_ADDRESSES', success: true });
            return true;
          }
          ctx
            .resyncAddresses({ quiet: true })
            .then(() => sendResponse({ type: 'RESYNC_ADDRESSES', success: true }))
            .catch((err: unknown) =>
              sendResponse({
                type: 'RESYNC_ADDRESSES',
                success: false,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          return true;
        }
        case 'MOVE_PROMPT_TO_WINDOW': {
          // The in-page sheet couldn't arm its buttons (visibility check never passed): answer the
          // same pending request in the wallet's own popup window instead. Nothing is denied.
          hideInPageSheet();
          createNewPopup();
          sendResponse({ type: 'MOVE_PROMPT_TO_WINDOW', success: true });
          return true;
        }
        case 'DISMISS_PROMPT_PANEL': {
          promptInPanel = false;
          postToPanels({ action: 'HIDE_PROMPT_PANEL' });
          hideInPageSheet();
          denyAllPendingPrompts();
          sendResponse({ type: 'DISMISS_PROMPT_PANEL', success: true });
          return true;
        }
        case 'CLOSE_PROMPT_WINDOW': {
          const next = getNextPendingPrompt();
          if (next) {
            sendResponse({ type: 'CLOSE_PROMPT_WINDOW', success: false, data: { prompt: next } });
            return true;
          }
          if (pendingWalletWaiters.length > 0) {
            sendResponse({ type: 'CLOSE_PROMPT_WINDOW', success: false, data: { prompt: { kind: 'unlock' } } });
            return true;
          }
          shownPrompt = undefined;
          // Nothing left: an open panel always drops its overlay (even if it was shown via another path).
          if (activePopupPorts.size > 0) hidePanelPrompt();
          if (promptInPanel || inPageSheet) {
            hidePanelPrompt();
            hideInPageSheet();
            sendResponse({ type: 'CLOSE_PROMPT_WINDOW', success: true });
            return true;
          }
          const windowId = popupWindowId ?? sender.tab?.windowId;
          if (windowId !== undefined) {
            selfClosedWindowIds.add(windowId);
            removeWindow(windowId);
            if (windowId === popupWindowId) {
              popupWindowId = undefined;
              chrome.storage.local.remove('popupWindowId');
            }
          }
          sendResponse({ type: 'CLOSE_PROMPT_WINDOW', success: true });
          return true;
        }
        // Internal UI requests (no external domain, direct from popup)
        case YoursEventName.GET_BALANCE:
          processGetBalanceRequest(sendResponse);
          return true;
        case YoursEventName.GET_PUB_KEYS:
          processGetPubKeysRequest(sendResponse);
          return true;
        case YoursEventName.GET_LEGACY_ADDRESSES:
          processGetLegacyAddressesRequest(sendResponse);
          return true;
        case YoursEventName.GET_RECEIVE_ADDRESS:
          processGetReceiveAddressRequest(sendResponse);
          return true;
        case YoursEventName.GET_SOCIAL_PROFILE:
          processGetSocialProfileRequest(sendResponse);
          return true;
        case 'WALLET_LOCKED': {
          // Gone immediately so lock never waits on hung AuthFetch/storage close.
          dropWalletContext('WALLET_LOCKED');
          chromeStorageService.clearPassKey().catch(() => {});
          sendResponse({ type: 'WALLET_LOCKED', success: true });
          return true;
        }
        case 'WALLET_UNLOCKED':
          // If wallet context already exists and has pending requests, skip reinitialization
          // to preserve active CWI operations (e.g., createAction waiting for permission)
          if (accountContext && pendingPermissionRequests.size > 0) {
            console.log(
              '[background] WALLET_UNLOCKED: skipping reinitialization, pending requests:',
              pendingPermissionRequests.size,
            );
            sendResponse({ type: 'WALLET_UNLOCKED', success: true });
            return true;
          }
          // Reinitialize wallet after user unlocks with password
          chromeStorageService.getAndSetStorage().then(() => {
            initializeWallet()
              .then(async (wallet) => {
                // Mark wallet as unlocked in storage BEFORE resolving waiters,
                // so requests resolved from the queue see the unlocked state.
                await chromeStorageService.update({ isLocked: false, lastActiveTime: Date.now() });

                sendResponse({ type: 'WALLET_UNLOCKED', success: !!wallet });

                // Resolve any CWI handlers waiting for the wallet
                if (wallet && pendingWalletWaiters.length > 0) {
                  for (const waiter of pendingWalletWaiters.splice(0)) {
                    waiter.resolve(wallet);
                  }
                }
                // Close the unlock popup only once fully idle: in-flight dApp
                // calls resumed by this unlock may still raise an approval
                // screen in this window; silent calls close it via their
                // completion hook moments later. Deferred so the resumed
                // handlers (microtasks behind the waiters above) can register
                // as in-flight before the idle check runs; a synchronous check
                // always saw zero and closed the window under the next prompt.
                setTimeout(closeDappPopupIfIdle, 50);
              })
              .catch((error: Error) => {
                console.error('Failed to initialize wallet:', error);
                sendResponse({ type: 'WALLET_UNLOCKED', success: false, error: error.message });
                for (const waiter of pendingWalletWaiters.splice(0)) {
                  waiter.reject(error);
                }
              });
          });
          return true;
        case 'MASTER_BACKUP':
          processMasterBackup(message.passwordKey, sendResponse);
          return true;
        case 'USB_PING':
          // Keeps the worker from idling out while the USB window is open.
          sendResponse({ type: 'USB_PING', success: true });
          return true;
        case 'USB_BACKUP_CHUNK':
        case 'USB_BACKUP_SETTINGS': {
          // Read-only view of the shared local database for the popup's USB sync.
          // Refused while locked: no session, no backup.
          const storageIdentityKey = chromeStorageService.storage?.storageIdentityKey;
          chromeStorageService
            .getPassKey()
            .then(async (passKey) => {
              if (!passKey || !storageIdentityKey) {
                sendResponse({ type: message.action, success: false, error: 'Wallet is locked' });
                return;
              }
              // Never open a second connection to the local database while the
              // wallet is initialising: a pending backup import writes to it
              // then, and a competing open can stall those transactions.
              if (initInFlight || reinitPromise || masterBackupInFlight) {
                sendResponse({
                  type: message.action,
                  success: false,
                  error: masterBackupInFlight ? 'Master backup in progress' : 'Wallet is starting up',
                  data: { busy: true },
                });
                return;
              }
              const res =
                message.action === 'USB_BACKUP_CHUNK'
                  ? await usbBackupChunk(storageIdentityKey, message as UsbBackupChunkRequest)
                  : await usbBackupSettings(storageIdentityKey);
              sendResponse({ type: message.action, ...res });
            })
            .catch((err: Error) => sendResponse({ type: message.action, success: false, error: err.message }));
          return true;
        }
        case 'USB_REKEY':
          usbRekey(chromeStorageService, message as UsbRekeyRequest, { lockGeneration: () => lockGeneration })
            .then((res) => sendResponse({ type: 'USB_REKEY', ...res }))
            .catch((err: Error) => sendResponse({ type: 'USB_REKEY', success: false, error: err.message }));
          return true;
        case 'MASTER_RESTORE':
          processMasterRestore(message, sendResponse);
          return true;
        case 'STORAGE_GET_INFO':
          processStorageGetInfo(sendResponse);
          return true;
        case 'STORAGE_SYNC_BACKUPS':
          processStorageSyncBackups(sendResponse);
          return true;
        case 'STORAGE_REPAIR_SYNC':
          processStorageRepairSync(sendResponse, Array.isArray(message.tokenIds) ? message.tokenIds : undefined);
          return true;
        case 'STORAGE_RECOVER_MINED':
          processRecoverMined(sendResponse);
          return true;
        case 'STORAGE_RECONCILE_POSTAGE':
          void (async () => {
            try {
              await ensureWallet(true);
              if (!accountContext) throw new Error('Wallet not initialized');
              const data = await accountContext.reconcilePostage(message.force === true);
              if (data.settled.length || data.errors.length) console.log('[STORAGE_RECONCILE_POSTAGE]', data);
              sendResponse({ type: 'STORAGE_RECONCILE_POSTAGE', success: true, data });
            } catch (err) {
              sendResponse({
                type: 'STORAGE_RECONCILE_POSTAGE',
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })();
          return true;
        case 'STORAGE_RECOVER_TXID':
          processRecoverTxid(typeof message.txid === 'string' ? message.txid : '', sendResponse);
          return true;
        case 'STORAGE_RESYNC_COINS':
          processResyncCoins(sendResponse);
          return true;
        case 'STORAGE_RESTORE_BACKUP':
          processRestoreBackup(sendResponse);
          return true;
        case 'BSV21_FIX_STALE':
          processBsv21FixStale(typeof message.tokenId === 'string' ? message.tokenId : '', sendResponse);
          return true;
        case 'BSV21_FIX_UNSEEN':
          processBsv21FixUnseen(
            typeof message.tokenId === 'string' ? message.tokenId : '',
            message.keysOnly === true,
            sendResponse,
          );
          return true;
        case 'STORAGE_SET_ACTIVE_STORAGE':
          processStorageSetActiveStorage(message.target, sendResponse);
          return true;
        case 'STORAGE_ADD_REMOTE':
          processStorageAddRemote(message.url, sendResponse);
          return true;
        case 'STORAGE_REMOVE_REMOTE':
          processStorageRemoveRemote(message.url, sendResponse);
          return true;
        case 'UPDATE_FEE_RATE': {
          const rate = message.feeRate;
          if (typeof rate === 'number' && rate >= 1 && accountContext) {
            // Access the internal storage provider to update fee model at runtime.
            // This reaches into WalletStorageManager internals — if the SDK changes
            // its structure, the guard below will catch it and log a warning.
            const active = (
              accountContext.storage as unknown as { _active?: { storage?: { feeModel?: unknown } } }
            )._active;
            if (active?.storage?.feeModel) {
              active.storage.feeModel = { model: 'sat/kb', value: rate };
            } else {
              console.warn(
                '[background] UPDATE_FEE_RATE: could not resolve storage._active.storage.feeModel —',
                'fee rate will apply on next wallet initialization',
              );
            }
          }
          sendResponse({ type: 'UPDATE_FEE_RATE', success: true });
          return true;
        }
        case 'PERMISSIONS_LIST_ALL':
          processPermissionsListAll(sendResponse);
          return true;
        case 'PERMISSIONS_QUERY_SPENT':
          processPermissionsQuerySpent(message, sendResponse);
          return true;
        case 'PERMISSIONS_REVOKE_ONE':
          processPermissionsRevokeOne(message, sendResponse);
          return true;
        case 'PERMISSIONS_REVOKE_ALL':
          processPermissionsRevokeAll(message, sendResponse);
          return true;
        case 'GET_DEPOSIT_ADDRESSES': {
          startupInitPromise.then(() => {
            if (!accountContext) {
              sendResponse({ type: 'GET_DEPOSIT_ADDRESSES', success: false, error: 'Wallet not initialized' });
              return;
            }
            const am = accountContext.syncContext.addressManager;
            const addresses = [];
            for (let i = 0; i <= am.getMaxKeyIndex(); i++) {
              const d = am.getAddressAtIndex(i);
              if (d) addresses.push(d);
            }
            sendResponse({ type: 'GET_DEPOSIT_ADDRESSES', success: true, data: addresses });
          });
          return true;
        }
        case 'GENERATE_NEW_ADDRESS': {
          if ((globalThis as { __generatingAddress?: boolean }).__generatingAddress) {
            sendResponse({
              type: 'GENERATE_NEW_ADDRESS',
              success: false,
              error: 'Address generation already in progress',
            });
            return true;
          }
          (globalThis as { __generatingAddress?: boolean }).__generatingAddress = true;
          startupInitPromise.then(async () => {
            try {
              if (!accountContext) {
                sendResponse({ type: 'GENERATE_NEW_ADDRESS', success: false, error: 'Wallet not initialized' });
                return;
              }
              const am = accountContext.syncContext.addressManager;
              const newIndex = am.getMaxKeyIndex() + 1;
              const { derivations } = await deriveDepositAddresses.execute(
                { wallet: accountContext.baseWallet, chain: 'main', isBaseWallet: true },
                { startIndex: newIndex, count: 1 },
              );
              const newDerivation = derivations[0];

              // Persist BEFORE updating in-memory state so a crash can't lose the index
              const { account, selectedAccount } = chromeStorageService.getCurrentAccountObject();
              if (account && selectedAccount) {
                const key: keyof ChromeStorageObject = 'accounts';
                await chromeStorageService.updateNested(key, {
                  [selectedAccount]: {
                    settings: { ...account.settings, maxKeyIndex: newIndex },
                  } as unknown as Account,
                });
              }

              am.addAddress(newDerivation);

              sendResponse({ type: 'GENERATE_NEW_ADDRESS', success: true, data: newDerivation });
            } catch (error) {
              sendResponse({
                type: 'GENERATE_NEW_ADDRESS',
                success: false,
                error: error instanceof Error ? error.message : String(error),
              });
            } finally {
              (globalThis as { __generatingAddress?: boolean }).__generatingAddress = false;
            }
          });
          return true;
        }
        default:
          break;
      }

      return;
    }

    // If message is from our own extension popup, check wallet state without launching popup.
    // The popup handles its own UI (unlock/create wallet pages).
    if (isFromExtension) {
      const { account } = chromeStorageService.getCurrentAccountObject();
      if (!account?.encryptedKeys) {
        sendResponse({
          type: message.action,
          success: false,
          error: 'Wallet not available',
        });
        return true;
      }
      // Wallet credentials exist, continue to ensureWallet (which won't launch popup
      // because suppressPopup flag is set for this call).
    }

    // Track dApp CWI work so the floating popup closes when the request is
    // done and no approval UI remains. Extension-internal callers skip this —
    // they use suppressPopup and must not own popupWindowId lifecycle.
    // Which protocol calls a site has running (services/pinnedMint.ts): a pinned site's self-encrypt is only let
    // through while nothing else on that protocol is in flight. Counted from the call's start to its end.
    const trackProtocolCall = (run: () => Promise<unknown>): Promise<unknown> => {
      const end =
        !isFromExtension && typeof message?.originator === 'string' && message.originator !== ADMIN_ORIGINATOR
          ? protocolCalls.start(String(message.action), normalizeOriginator(message.originator), message.params)
          : () => undefined;
      return Promise.resolve()
        .then(run)
        .finally(end);
    };
    const runDappRequest = (work: Promise<unknown>) => {
      if (isFromExtension) {
        void work;
        return;
      }
      inFlightDappRequests++;
      void Promise.resolve(work)
        .catch(() => {})
        .finally(() => {
          inFlightDappRequests--;
          void closeDappPopupIfIdle();
        });
    };

    ensureWallet(isFromExtension)
      .then(() => {
        console.log('[background] ensureWallet resolved for action:', message.action);
        // Connections log (History › Connections): which outside site or app called, and what.
        if (!isFromExtension && typeof message.originator === 'string' && message.originator !== ADMIN_ORIGINATOR) {
          const origin = message.originator;
          void updateConnectionLog((l) => recordCall(l, origin, String(message.action)));
        }
        switch (message.action) {
          // CWI (BRC-100) handlers - direct passthrough to wallet
          // WalletPermissionsManager handles permission prompts internally
          case CWIEventName.WAIT_FOR_AUTHENTICATION:
            runDappRequest(processCWIWaitForAuthentication(message, sendResponse));
            return true;
          case CWIEventName.LIST_OUTPUTS:
            runDappRequest(processCWIListOutputs(message, sendResponse));
            return true;
          case CWIEventName.GET_NETWORK:
            runDappRequest(processCWIGetNetwork(message, sendResponse));
            return true;
          case CWIEventName.GET_HEIGHT:
            runDappRequest(processCWIGetHeight(message, sendResponse));
            return true;
          case CWIEventName.GET_HEADER_FOR_HEIGHT:
            runDappRequest(processCWIGetHeaderForHeight(message, sendResponse));
            return true;
          case CWIEventName.GET_PUBLIC_KEY:
            runDappRequest(trackProtocolCall(() => processCWIGetPublicKey(message, sendResponse)));
            return true;
          case CWIEventName.LIST_ACTIONS:
            runDappRequest(processCWIListActions(message, sendResponse));
            return true;
          case CWIEventName.VERIFY_SIGNATURE:
            runDappRequest(trackProtocolCall(() => processCWIVerifySignature(message, sendResponse)));
            return true;
          case CWIEventName.VERIFY_HMAC:
            runDappRequest(trackProtocolCall(() => processCWIVerifyHmac(message, sendResponse)));
            return true;
          case CWIEventName.CREATE_HMAC:
            runDappRequest(trackProtocolCall(() => processCWICreateHmac(message, sendResponse)));
            return true;
          case CWIEventName.CREATE_SIGNATURE:
            runDappRequest(trackProtocolCall(() => processCWICreateSignature(message, sendResponse)));
            return true;
          case CWIEventName.ENCRYPT:
            runDappRequest(trackProtocolCall(() => processCWIEncrypt(message, sendResponse)));
            return true;
          case CWIEventName.DECRYPT:
            runDappRequest(trackProtocolCall(() => processCWIDecrypt(message, sendResponse)));
            return true;
          case CWIEventName.CREATE_ACTION:
            runDappRequest(processCWICreateAction(message, sendResponse));
            return true;
          case CWIEventName.SIGN_ACTION:
            runDappRequest(processCWISignAction(message, sendResponse));
            return true;
          case CWIEventName.ABORT_ACTION:
            runDappRequest(processCWIAbortAction(message, sendResponse));
            return true;
          case CWIEventName.INTERNALIZE_ACTION:
            runDappRequest(processCWIInternalizeAction(message, sendResponse));
            return true;
          case CWIEventName.RELINQUISH_OUTPUT:
            runDappRequest(processCWIRelinquishOutput(message, sendResponse));
            return true;
          case CWIEventName.REVEAL_COUNTERPARTY_KEY_LINKAGE:
            runDappRequest(processCWIRevealCounterpartyKeyLinkage(message, sendResponse));
            return true;
          case CWIEventName.REVEAL_SPECIFIC_KEY_LINKAGE:
            runDappRequest(trackProtocolCall(() => processCWIRevealSpecificKeyLinkage(message, sendResponse)));
            return true;
          case CWIEventName.ACQUIRE_CERTIFICATE:
            runDappRequest(processCWIAcquireCertificate(message, sendResponse));
            return true;
          case CWIEventName.LIST_CERTIFICATES:
            runDappRequest(processCWIListCertificates(message, sendResponse));
            return true;
          case CWIEventName.PROVE_CERTIFICATE:
            runDappRequest(processCWIProveCertificate(message, sendResponse));
            return true;
          case CWIEventName.RELINQUISH_CERTIFICATE:
            runDappRequest(processCWIRelinquishCertificate(message, sendResponse));
            return true;
          case CWIEventName.DISCOVER_BY_IDENTITY_KEY:
            runDappRequest(processCWIDiscoverByIdentityKey(message, sendResponse));
            return true;
          case CWIEventName.DISCOVER_BY_ATTRIBUTES:
            runDappRequest(processCWIDiscoverByAttributes(message, sendResponse));
            return true;

          default:
            break;
        }
      })
      .catch((error: Error) => {
        sendResponse({
          type: message.action,
          success: false,
          error: error.message || 'Wallet unavailable',
        });
        if (!isFromExtension) void closeDappPopupIfIdle();
      });

    return true;
  });

  // STORAGE MANAGEMENT HANDLERS ********************************

  const processStorageGetInfo = async (sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
    } catch (err) {
      sendResponse({
        type: 'STORAGE_GET_INFO',
        success: false,
        error: err instanceof Error ? err.message : 'Wallet not available',
      });
      return;
    }
    if (!accountContext) {
      sendResponse({ type: 'STORAGE_GET_INFO', success: false, error: 'Wallet not initialized' });
      return;
    }
    const { storage, remoteStorage } = accountContext;
    (async () => {
      try {
        const stores = storage.getStores();
        const settings = storage.getSettings();
        const activeStore = stores.find((s) => s.isActive);
        const backupStores = stores.filter((s) => s.isBackup);
        // Surface the persisted per-account config so the UI can render
        // from the same source of truth used at init time.
        const { account } = chromeStorageService.getCurrentAccountObject();
        const storageConfig: StorageConfig = account?.storageConfig ?? {
          remotes: [],
        };

        let outputCount = 0;
        let transactionCount = 0;
        try {
          const userId = await storage.getUserId();
          outputCount = await storage.runAsStorageProvider(async (sp) => sp.countOutputs({ partial: { userId } }));
          transactionCount = await storage.runAsStorageProvider(async (sp) =>
            sp.countTransactions({ partial: { userId } }),
          );
        } catch {
          // Counts may not be available during initialization
        }

        let syncStates: Array<{
          storageIdentityKey: string;
          storageName: string;
          status: string;
          when?: string;
        }> = [];
        try {
          const states = await storage.runAsStorageProvider(async (sp) => sp.findSyncStates({ partial: {} }));
          syncStates = states.map((s) => ({
            storageIdentityKey: s.storageIdentityKey,
            storageName: s.storageName,
            status: s.status,
            when: s.when?.toISOString(),
          }));
        } catch {
          // findSyncStates may not be available
        }

        sendResponse({
          type: 'STORAGE_GET_INFO',
          success: true,
          data: {
            activeStore: activeStore
              ? {
                  storageIdentityKey: activeStore.storageIdentityKey,
                  storageName: activeStore.storageName,
                  endpointURL: activeStore.endpointURL,
                  isEnabled: activeStore.isEnabled,
                }
              : null,
            backupStores: backupStores.map((s) => ({
              storageIdentityKey: s.storageIdentityKey,
              storageName: s.storageName,
              endpointURL: s.endpointURL,
            })),
            storageIdentityKey: settings.storageIdentityKey,
            remoteUrl: remoteStorage?.endpointUrl,
            outputCount,
            transactionCount,
            syncStates,
            storageConfig,
          },
        });
      } catch (error) {
        sendResponse({
          type: 'STORAGE_GET_INFO',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  const processStorageSyncBackups = async (sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
    } catch (err) {
      sendResponse({
        type: 'STORAGE_SYNC_BACKUPS',
        success: false,
        error: err instanceof Error ? err.message : 'Wallet not available',
      });
      return;
    }
    if (!accountContext) {
      sendResponse({ type: 'STORAGE_SYNC_BACKUPS', success: false, error: 'Wallet not initialized' });
      return;
    }
    accountContext.storage
      .updateBackups()
      .then((log) => {
        sendResponse({ type: 'STORAGE_SYNC_BACKUPS', success: true, data: { log } });
      })
      .catch((error: unknown) => {
        console.error('[STORAGE_SYNC_BACKUPS] updateBackups failed:', error);
        sendResponse({
          type: 'STORAGE_SYNC_BACKUPS',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  /** Reconcile local and remote storage to the union of both; see storageReconcileBackground. */
  /**
   * Settings › Troubleshooting › Find mined payments: the same mined-but-stuck repair the worker runs at startup
   * (services/recoverFailed.ts), on demand, with a one-line result (dkg sweep, 14 Oct 2026).
   */
  /** Live step text for Settings › Troubleshooting (owner, 15 Oct 2026: no more silent "Checking…"). */
  const sendRecoverProgress = (kind: 'txid' | 'mined', step: string) => {
    chrome.runtime.sendMessage({ action: 'RECOVER_PROGRESS', data: { kind, step } }).catch(() => undefined);
  };

  /** Settings › Troubleshooting › Resync coins: clear coins the chain proves were spent elsewhere (resyncSpent). */
  const processResyncCoins = async (sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
      if (!accountContext) throw new Error('Wallet not initialized');
      const ctx = accountContext;
      const identityKey = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey || '';
      const report = await withCoinResyncLock(() =>
        resyncAccountCoins(ctx, identityKey, (step) => sendRecoverProgress('txid', step)),
      );
      if (!report) throw new Error('Wallet services are not ready yet. Try again in a moment.');
      console.log('[STORAGE_RESYNC_COINS]', report);
      sendResponse({ type: 'STORAGE_RESYNC_COINS', success: true, data: { report, summary: resyncMessage(report) } });
    } catch (err) {
      sendResponse({ type: 'STORAGE_RESYNC_COINS', success: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Settings › Troubleshooting › Recover a payment by transaction ID (services/recoverByTxid.ts). */
  const processRecoverTxid = async (txid: string, sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
      if (!accountContext) throw new Error('Wallet not initialized');
      const report = await accountContext.recoverTxid(txid, (step) => sendRecoverProgress('txid', step));
      console.log('[STORAGE_RECOVER_TXID]', report);
      sendResponse({
        type: 'STORAGE_RECOVER_TXID',
        success: report.result === 'restored' || report.result === 'already',
        data: { report, summary: txidRecoverySummary(report) },
      });
    } catch (err) {
      sendResponse({ type: 'STORAGE_RECOVER_TXID', success: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const processRecoverMined = async (sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
      if (!accountContext) throw new Error('Wallet not initialized');
      const ctx = accountContext;
      const say = (step: string) => sendRecoverProgress('mined', step);
      say('Checking payments that didn’t finish…');
      let report = await timedStep('find mined', 60_000, 'Checking unfinished payments took too long', () =>
        ctx.recoverFailed(),
      );
      let switchNote = '';
      // Remote-active wallets were skipped (the repair needs this device's store). Copy the backup in, verified,
      // and run again on the device's store (dkg, 15 Oct 2026: a restored account starts remote-active).
      if (report.skipped) {
        const { account } = chromeStorageService.getCurrentAccountObject();
        const config = account?.storageConfig as (StorageConfig & { localFirst?: boolean }) | undefined;
        const remoteUrl = config?.activeRemote || config?.remotes?.[0];
        if (account && config && remoteUrl) {
          say('Copying your backup to this device…');
          const r = await timedStep(
            'switch to device',
            90_000,
            'Copying the backup to this device took too long',
            () => switchToLocalVerified(restoreDeps(ctx, remoteUrl)),
          ).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
          console.log('[STORAGE_RECOVER_MINED] verified switch', r);
          if (r.ok) {
            const remotes = config.remotes?.includes(remoteUrl) ? config.remotes : [...(config.remotes ?? []), remoteUrl];
            await chromeStorageService.updateNested('accounts', {
              [account.addresses.identityAddress]: {
                storageConfig: { ...config, activeRemote: undefined, remotes, localFirst: true },
              } as unknown as Account,
            });
            say('Checking payments that didn’t finish…');
            report = await timedStep('find mined (device)', 60_000, 'Checking unfinished payments took too long', () =>
              ctx.recoverFailed(),
            );
          } else {
            // Say exactly what stopped the switch (owner to dkg, 15 Oct 2026). The by-txid pass below still runs:
            // it repairs in this device's store and merges into the remote with the toolbox's sync.
            switchNote = `This device's storage couldn't take over from the backup: ${r.reason}.`;
          }
        }
      }
      // Sweeps in this wallet's own records whose output storage never recorded as ours (dkg 9f66943b): try each by
      // txid; recoverByTxid only adds an output a stored derivation proves is ours.
      const extra: string[] = [];
      const done = new Set([...report.restored, ...(report.notRestored ?? []).map((n) => n.txid)]);
      say('Looking for sweeps in your history…');
      const cands = await timedStep('sweep candidates', 20_000, 'Reading your sweeps took too long', () =>
        ctx.sweepCandidates(),
      ).catch(() => [] as string[]);
      for (const [i, txid] of cands.entries()) {
        if (done.has(txid)) continue;
        const t = await ctx.recoverTxid(txid, (step) => say(`Sweep ${i + 1} of ${cands.length}: ${step}`));
        if (t.result === 'restored' || t.result === 'error') extra.push(txidRecoverySummary(t));
      }
      const base = switchNote && report.skipped ? '' : recoverySummary(report);
      const parts = [switchNote, base === 'Nothing to restore' && (extra.length || switchNote) ? '' : base, ...extra];
      const summary = parts.filter(Boolean).join(' ') || 'Nothing to restore';
      console.log('[STORAGE_RECOVER_MINED]', report, extra);
      sendResponse({ type: 'STORAGE_RECOVER_MINED', success: !report.error, data: { report, summary } });
    } catch (err) {
      sendResponse({
        type: 'STORAGE_RECOVER_MINED',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * Settings › Troubleshooting › Restore from backup: pull the remote store in (verified) and re-internalize paymail
   * receipts the device lacks (restore from seed, 14 Oct 2026). Merge only; never deletes.
   */
  const processRestoreBackup = async (sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
      const ctx = accountContext;
      if (!ctx) throw new Error('Wallet not initialized');
      const { account } = chromeStorageService.getCurrentAccountObject();
      const config = account?.storageConfig;
      const remoteUrl = config?.activeRemote || config?.remotes?.[0];
      const parts: string[] = [];
      let ok = true;
      if (remoteUrl) {
        const r = await switchToLocalVerified(restoreDeps(ctx, remoteUrl));
        sendRestoreStatus(r.ok ? undefined : null);
        console.log('[STORAGE_RESTORE_BACKUP] store', r);
        if (r.ok) {
          parts.push(`Backup copied (${r.local.outputs} coins, ${r.local.spendableSats.toLocaleString()} sats)`);
          if (account && config?.activeRemote) {
            await chromeStorageService.updateNested('accounts', {
              [account.addresses.identityAddress]: {
                storageConfig: { ...config, activeRemote: undefined, localFirst: true },
              } as unknown as Account,
            });
          }
        } else {
          ok = false;
          parts.push(`Backup not copied: ${r.reason}`);
        }
      }
      const p = await ctx.restorePaymails().catch((e: unknown) => {
        ok = false;
        return e instanceof Error ? e.message : String(e);
      });
      parts.push(typeof p === 'string' ? `Paymail: ${p}` : paymailRestoreSummary(p));
      void ctx.resyncAddresses({ quiet: true });
      sendResponse({ type: 'STORAGE_RESTORE_BACKUP', success: ok, data: { summary: parts.join('. ') } });
    } catch (err) {
      sendResponse({
        type: 'STORAGE_RESTORE_BACKUP',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const processStorageRepairSync = async (sendResponse: CallbackResponse, tokenIds?: string[]) => {
    try {
      await ensureWallet(true);
    } catch (err) {
      sendResponse({
        type: 'STORAGE_REPAIR_SYNC',
        success: false,
        error: err instanceof Error ? err.message : 'Wallet not available',
      });
      return;
    }
    if (!accountContext) {
      sendResponse({ type: 'STORAGE_REPAIR_SYNC', success: false, error: 'Wallet not initialized' });
      return;
    }

    try {
      const { account } = chromeStorageService.getCurrentAccountObject();
      const config: StorageConfig = account?.storageConfig ?? { remotes: [] };
      const remoteUrl = config.activeRemote || config.remotes?.[0];
      // After the reconcile (or alone, with no remote): token outputs on chain
      // that no store recorded, searched over the wider window too. Then a final
      // pass relinquishes token outputs the overlay or chain reports spent: the
      // merge is a union and can bring a spent one back (TERANODE, 12 Oct 2026).
      const tokenPass = async (): Promise<NonNullable<ReconcileRecord['tokens']>> => {
        const errors: string[] = [];
        let recovered = 0;
        try {
          const r = await accountContext!.recoverTokens({ thorough: true, tokenIds });
          recovered = r.imported.length;
        } catch (err) {
          console.error('[STORAGE_REPAIR_SYNC] token recovery failed:', err);
          errors.push(`recover: ${err instanceof Error ? err.message : String(err)}`);
        }
        let staleDropped: NonNullable<ReconcileRecord['tokens']>['staleDropped'] = [];
        try {
          const pass = await accountContext!.dropSpentTokens();
          staleDropped = pass.dropped;
          errors.push(...pass.errors);
        } catch (err) {
          console.error('[STORAGE_REPAIR_SYNC] token spend pass failed:', err);
          errors.push(`spend pass: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Outputs the overlay has never seen: submit mined ones, rebroadcast unfinished ones (SCAM, 16 Oct 2026).
        let unseenFixed = 0;
        try {
          const u = await accountContext!.healUnseenTokens();
          unseenFixed = u.submitted.length + u.rebroadcast.length + (u.keysRepaired ?? 0);
          staleDropped = [...staleDropped, ...u.dropped];
          if (u.keysDropped) errors.push(`${u.keysDropped} token output(s) this wallet can't sign were removed`);
          errors.push(...u.errors);
        } catch (err) {
          console.error('[STORAGE_REPAIR_SYNC] unseen token pass failed:', err);
          errors.push(`unseen pass: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { recovered, staleDropped, ...(unseenFixed ? { unseenFixed } : {}), ...(errors.length ? { errors } : {}) };
      };
      // The Repair Log shows the token pass too; without a remote it is the whole record.
      const saveTokenRecord = async (tokens: NonNullable<ReconcileRecord['tokens']>, base?: ReconcileRecord) => {
        const now = new Date().toISOString();
        const record: ReconcileRecord = base
          ? { ...base, tokens }
          : {
              startedAt: now,
              finishedAt: now,
              trigger: 'manual',
              appVersion: chrome.runtime.getManifest().version,
              remoteUrl: '',
              verify: { onlyLocal: 0, onlyRemote: 0, mismatched: [] },
              tokens,
            };
        await chrome.storage.local.set({ [RECONCILE_RECORD_KEY]: record });
      };
      if (!remoteUrl) {
        const tokens = await tokenPass();
        await saveTokenRecord(tokens).catch(() => undefined);
        sendResponse({
          type: 'STORAGE_REPAIR_SYNC',
          success: true,
          data: { tokensRecovered: tokens.recovered, staleDropped: tokens.staleDropped.length, noRemote: true },
        });
        return;
      }

      const record = await reconcileStorage(
        accountContext.storage,
        accountContext.syncContext.services,
        remoteUrl,
        'manual',
      );
      const tokens = await tokenPass();
      await saveTokenRecord(tokens, record).catch(() => undefined);

      sendResponse({
        type: 'STORAGE_REPAIR_SYNC',
        success: true,
        data: {
          outcome: reconcileOutcome(record),
          tokensRecovered: tokens.recovered,
          staleDropped: tokens.staleDropped.length,
        },
      });
    } catch (error) {
      console.error('[STORAGE_REPAIR_SYNC] reconcile failed:', error);
      sendResponse({
        type: 'STORAGE_REPAIR_SYNC',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** "Fix and send" (SendBsv21View unseen prompt): get this token's unknown outputs in front of the overlay. */
  const processBsv21FixUnseen = async (tokenId: string, keysOnly: boolean, sendResponse: CallbackResponse) => {
    if (!/^[0-9a-f]{64}[._]\d+$/i.test(tokenId)) {
      sendResponse({ type: 'BSV21_FIX_UNSEEN', success: false, error: 'Invalid token ID' });
      return;
    }
    try {
      await ensureWallet(true);
      if (!accountContext) throw new Error('Wallet not initialized');
      const data = await accountContext.healUnseenTokens(tokenId, keysOnly);
      sendResponse({ type: 'BSV21_FIX_UNSEEN', success: true, data });
    } catch (error) {
      console.error('[BSV21_FIX_UNSEEN] failed:', error);
      sendResponse({
        type: 'BSV21_FIX_UNSEEN',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** "Fix and send" (SendBsv21View stale prompt): one token's local records made to match the overlay. */
  const processBsv21FixStale = async (tokenId: string, sendResponse: CallbackResponse) => {
    if (!/^[0-9a-f]{64}[._]\d+$/i.test(tokenId)) {
      sendResponse({ type: 'BSV21_FIX_STALE', success: false, error: 'Invalid token ID' });
      return;
    }
    try {
      await ensureWallet(true);
      if (!accountContext) throw new Error('Wallet not initialized');
      const data = await accountContext.fixStaleToken(tokenId);
      sendResponse({ type: 'BSV21_FIX_STALE', success: true, data });
    } catch (error) {
      console.error('[BSV21_FIX_STALE] failed:', error);
      sendResponse({
        type: 'BSV21_FIX_STALE',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Patch and persist the current account's storageConfig. */
  const updateStorageConfig = async (patch: (current: StorageConfig) => StorageConfig): Promise<StorageConfig> => {
    const { account } = chromeStorageService.getCurrentAccountObject();
    if (!account) throw new Error('No account loaded');
    const identityAddress = account.addresses.identityAddress;
    const existing: StorageConfig = account.storageConfig ?? { remotes: [] };
    const next = patch(existing);
    await chromeStorageService.updateNested('accounts', {
      [identityAddress]: { storageConfig: next } as unknown as Account,
    });
    return next;
  };

  const processStorageSetActiveStorage = async (target: 'local' | string, sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
    } catch (err) {
      sendResponse({
        type: 'STORAGE_SET_ACTIVE_STORAGE',
        success: false,
        error: err instanceof Error ? err.message : 'Wallet not available',
      });
      return;
    }
    if (!accountContext) {
      sendResponse({
        type: 'STORAGE_SET_ACTIVE_STORAGE',
        success: false,
        error: 'Wallet not initialized',
      });
      return;
    }
    try {
      await accountContext.setActiveStorage(target);
      const nextConfig = await updateStorageConfig((current) => {
        if (target === 'local') {
          return { ...current, activeRemote: undefined, remotes: current.remotes ?? [] };
        }
        const remotes = current.remotes ?? [];
        const withTarget = remotes.includes(target) ? remotes : [...remotes, target];
        return { ...current, activeRemote: target, remotes: withTarget };
      });
      sendResponse({
        type: 'STORAGE_SET_ACTIVE_STORAGE',
        success: true,
        data: { storageConfig: nextConfig },
      });
    } catch (error) {
      sendResponse({
        type: 'STORAGE_SET_ACTIVE_STORAGE',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const processStorageAddRemote = async (url: string, sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
    } catch (err) {
      sendResponse({
        type: 'STORAGE_ADD_REMOTE',
        success: false,
        error: err instanceof Error ? err.message : 'Wallet not available',
      });
      return;
    }
    if (!accountContext) {
      sendResponse({
        type: 'STORAGE_ADD_REMOTE',
        success: false,
        error: 'Wallet not initialized',
      });
      return;
    }
    try {
      await accountContext.addRemote(url);
      const nextConfig = await updateStorageConfig((current) => {
        const remotes = current.remotes ?? [];
        return {
          ...current,
          remotes: remotes.includes(url) ? remotes : [...remotes, url],
        };
      });
      sendResponse({
        type: 'STORAGE_ADD_REMOTE',
        success: true,
        data: { storageConfig: nextConfig },
      });
    } catch (error) {
      sendResponse({
        type: 'STORAGE_ADD_REMOTE',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Remove a remote from the configured list. Pure config persistence —
   * the SDK does not support detaching a live connection, so the removed
   * remote stays connected for this session and will simply not be
   * reconnected on next unlock. Refuses if the URL is the current active.
   */
  const processStorageRemoveRemote = async (url: string, sendResponse: CallbackResponse) => {
    try {
      const nextConfig = await updateStorageConfig((current) => {
        if (current.activeRemote === url) {
          throw new Error('Cannot remove the active remote — switch active to local or another remote first.');
        }
        return {
          ...current,
          remotes: (current.remotes ?? []).filter((r) => r !== url),
        };
      });
      sendResponse({
        type: 'STORAGE_REMOVE_REMOTE',
        success: true,
        data: { storageConfig: nextConfig },
      });
    } catch (error) {
      sendResponse({
        type: 'STORAGE_REMOVE_REMOTE',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // PERMISSIONS MANAGEMENT HANDLERS ********************************

  // WPM token shapes vary by kind; tag each with the kind it was listed under.
  type PermissionToken = Parameters<LocalWalletPermissionsManager['revokePermission']>[0] & {
    type?: string;
    rawOriginator?: string;
  };

  const processPermissionsListAll = async (sendResponse: CallbackResponse) => {
    try {
      const wpm = (await ensureWallet(true)) as LocalWalletPermissionsManager;

      const [protocols, baskets, spending, certificates] = await Promise.all([
        wpm.listProtocolPermissions({}),
        wpm.listBasketAccess({}),
        wpm.listSpendingAuthorizations({}),
        wpm.listCertificateAccess({}),
      ]);

      // Tag each token with its type, pass everything else through as-is
      const allTokens: PermissionToken[] = [
        ...protocols.map((t: PermissionToken) => ({ ...t, type: 'protocol' })),
        ...baskets.map((t: PermissionToken) => ({ ...t, type: 'basket' })),
        ...spending.map((t: PermissionToken) => ({ ...t, type: 'spending' })),
        ...certificates.map((t: PermissionToken) => ({ ...t, type: 'certificate' })),
      ];

      // Group by originator
      const groupMap = new Map<string, PermissionToken[]>();
      for (const token of allTokens) {
        const key = token.originator ?? token.rawOriginator ?? '';
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key)!.push(token);
      }

      const groups = Array.from(groupMap.entries()).map(([originator, permissions]) => ({
        originator,
        permissions,
      }));

      sendResponse({ type: 'PERMISSIONS_LIST_ALL', success: true, data: { groups } });
    } catch (error) {
      console.error('[PERMISSIONS_LIST_ALL] Error:', error);
      sendResponse({
        type: 'PERMISSIONS_LIST_ALL',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const processPermissionsQuerySpent = async (message: { token: PermissionToken }, sendResponse: CallbackResponse) => {
    try {
      const wpm = (await ensureWallet(true)) as LocalWalletPermissionsManager;
      const satoshisSpent = await wpm.querySpentSince(message.token);
      sendResponse({ type: 'PERMISSIONS_QUERY_SPENT', success: true, data: { satoshisSpent } });
    } catch (error) {
      console.error('[PERMISSIONS_QUERY_SPENT] Error:', error);
      sendResponse({
        type: 'PERMISSIONS_QUERY_SPENT',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const processPermissionsRevokeOne = async (message: { token: PermissionToken }, sendResponse: CallbackResponse) => {
    try {
      const wpm = (await ensureWallet(true)) as LocalWalletPermissionsManager;
      await wpm.revokePermission(message.token);
      sendResponse({ type: 'PERMISSIONS_REVOKE_ONE', success: true });
    } catch (error) {
      console.error('[PERMISSIONS_REVOKE_ONE] Error:', error);
      sendResponse({
        type: 'PERMISSIONS_REVOKE_ONE',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const processPermissionsRevokeAll = async (
    message: { originator: string; allAccounts?: boolean },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const wpm = (await ensureWallet(true)) as LocalWalletPermissionsManager;
      // Open sheets for this originator are denied first, so approving one afterwards writes nothing.
      denyPendingPromptsFor(message.originator);
      const revoked = await wpm.revokeAllForOriginator(message.originator);
      // Forget site removes its basket grants and site-trust record too, whatever form the originator was
      // stored under, and drops the manager's short-lived memory of recent grants.
      await revokeBasketGrantsFor(message.originator);
      // Envelopes and streaming grants are spend rights too: Forget site / Revoke all / unpair ends them (Coin
      // return) and revokes the site's streaming grants (b-Aware rows 53, 62, 24 Oct 2026).
      const site = normalizeOriginator(message.originator);
      await accountContext?.envelopes.close(site);
      await updateStreamState((st) => ({ state: revokeGrantsForOriginator(st, site, Date.now()), result: undefined }));
      // Grants are per account; a device-wide pairing is withdrawn from the other accounts' stores too.
      if (message.allAccounts) {
        const ids = chromeStorageService
          .getAllAccounts()
          .map((a) => a.addresses?.identityAddress)
          .filter((x): x is string => !!x);
        await revokeOriginatorInAccounts(ids, site);
        await closeEnvelopeInAccounts(ids, site);
      }
      sendResponse({ type: 'PERMISSIONS_REVOKE_ALL', success: true, data: { revokedCount: revoked.length } });
    } catch (error) {
      console.error('[PERMISSIONS_REVOKE_ALL] Error:', error);
      sendResponse({
        type: 'PERMISSIONS_REVOKE_ALL',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // PERMISSION RESPONSE HANDLER ********************************

  const processPermissionResponse = (response: { requestID: string; granted: boolean; expiry?: number }) => {
    const pending = pendingPermissionRequests.get(response.requestID);
    if (!pending) {
      console.warn('No pending permission request found for:', response.requestID);
      return;
    }

    pendingPermissionRequests.delete(response.requestID);
    permissionBundler.removeRequest(response.requestID);

    // A paired originator is granted only while its pairing is current (checked at approve time).
    if (response.granted && !pairedGrantAllowed(pending.request.originator)) {
      accountContext?.wallet.denyPermission(response.requestID).catch(console.error);
      pending.reject(new Error('This pairing has ended'));
      closeDappPopupIfNoUi();
      return true;
    }

    if (response.granted) {
      // Grant the permission through the manager
      // No expiry given: the grant lasts GRANT_DEFAULT_DAYS (services/grantExpiry.ts, audit 24 Oct B1), never for ever.
      accountContext?.wallet
        .grantPermission({
          requestID: response.requestID,
          expiry: withDefaultExpiry(response.expiry),
        })
        .then(() => {
          pending.resolve();
        })
        .catch((error) => {
          pending.reject(error);
        });
    } else {
      // Deny the permission
      accountContext?.wallet
        .denyPermission(response.requestID)
        .then(() => {
          pending.reject(userDeniedError());
        })
        .catch((error) => {
          pending.reject(error);
        });
    }

    closeDappPopupIfNoUi();
    return true;
  };

  /** USD per BSV from the wallet's price cache, if it has one. */
  const cachedUsdPerBsv = async (): Promise<number | undefined> => {
    // Callback form: the phone build's chrome shim may not return a promise.
    const r = await new Promise<Record<string, unknown>>((res) =>
      chrome.storage.local.get('exchangeRateCache', (v) => res(v ?? {})),
    );
    const rate = (r?.exchangeRateCache as { rate?: number } | undefined)?.rate;
    return typeof rate === 'number' && rate > 0 ? rate : undefined;
  };

  /** A sheet nobody answers must not hold the site's request open forever. */
  const STREAM_GRANT_TIMEOUT_MS = 3 * 60_000;

  /** requestSpendingAuthorization / revokeSpendingAuthorization / status, from a site (originator already derived). */
  const handleSpendingAuth = async (
    action: string,
    originator: string,
    params: unknown,
    sendResponse: CallbackResponse,
  ): Promise<void> => {
    const reply = (r: { success: boolean; data?: unknown; error?: string }) => sendResponse({ type: action, ...r });
    const now = Date.now();
    const key = normalizeOriginator(originator);
    if (!ALLOWANCES_ENABLED) return handleEnvelopeAuth(action, key, params, reply);
    try {
      if (action === SPENDING_AUTH_STATUS) {
        const state = await readStreamState();
        const grants = state.grants.filter((g) => g.originator === key && !g.revokedAt && g.expiresAt > now);
        reply({
          success: true,
          data: {
            version: SPENDING_AUTH_VERSION,
            paused: state.paused,
            grants: grants.map((g) => publicGrant(g, state, now)),
          },
        });
        return;
      }
      if (action === SPENDING_AUTH_REVOKE) {
        const id = (params as { grantId?: unknown } | undefined)?.grantId;
        if (typeof id !== 'string') return reply({ success: false, error: 'grantId is required' });
        const ok = await updateStreamState((s) => {
          const next = revokeGrant(s, id, now, key);
          return { state: next, result: !!next };
        });
        return ok ? reply({ success: true, data: { revoked: true, grantId: id } }) : reply({ success: false, error: 'Unknown grant' });
      }
      if (action !== SPENDING_AUTH_REQUEST) return reply({ success: false, error: 'Unknown call' });

      const parsed = parseSpendingAuthRequest(params, now);
      if (!parsed.ok) return reply({ success: false, error: parsed.error });
      const state = await readStreamState();
      if (state.paused) return reply({ success: false, error: 'Streaming payments are paused in bWalletX' });
      if (state.ceilingSatsPerHour < 1) return reply({ success: false, error: 'Streaming payments are turned off in bWalletX' });
      const req = parsed.request;
      const requestID = `stream-${now}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt: StreamGrantPrompt = {
        requestID,
        originator: key,
        protocolName: req.protocolID[1],
        capSatsPerHour: Math.min(req.capSatsPerHour, state.ceilingSatsPerHour),
        ceilingSatsPerHour: state.ceilingSatsPerHour,
        expiresAt: req.expiresAt,
        description: req.description,
        usdPerBsv: await cachedUsdPerBsv().catch(() => undefined),
      };
      const answer = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          if (pendingStreamGrantRequests.delete(requestID)) resolve(null);
        }, STREAM_GRANT_TIMEOUT_MS);
        pendingStreamGrantRequests.set(requestID, {
          request: prompt,
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
        });
        showPromptUi('streamGrant', requestID);
      });
      if (answer === null) return reply({ success: false, error: 'Declined' });
      // The user may only lower the cap, never raise it past what the site asked or the global ceiling.
      const cap = Math.max(1, Math.floor(Math.min(answer, prompt.capSatsPerHour)));
      const grant = {
        id: newGrantId(),
        originator: key,
        protocolID: req.protocolID,
        label: req.protocolID[1],
        capSatsPerHour: cap,
        expiresAt: req.expiresAt,
        createdAt: Date.now(),
        description: req.description,
        ...(req.payees ? { payees: req.payees } : {}),
        spends: [],
        totalSats: 0,
      };
      await updateStreamState((s) => ({ state: addGrant(s, grant), result: undefined }));
      reply({
        success: true,
        data: {
          grantId: grant.id,
          protocolID: grant.protocolID,
          capSatsPerHour: cap,
          expiry: Math.floor(grant.expiresAt / 1000),
        },
      });
    } catch (e) {
      reply({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  /**
   * requestSpendingAuthorization with envelopes (the default, services/envelopes.ts). The site asks; the user sees
   * "Put $X in <site>'s envelope" and picks the amount. Status reports the balance. Revoke is Coin return: a site
   * may always give the user's earmark back, never take or raise it.
   */
  const handleEnvelopeAuth = async (
    action: string,
    site: string,
    params: unknown,
    reply: (r: { success: boolean; data?: unknown; error?: string }) => void,
  ): Promise<void> => {
    try {
      const store = accountContext?.envelopes;
      if (!store) return reply({ success: false, error: 'Wallet is locked' });
      const shape = (balanceSats: number) => ({
        version: SPENDING_AUTH_VERSION,
        envelope: true,
        grantId: `envelope:${site}`,
        balanceSats,
        remainingSats: balanceSats,
        active: balanceSats > 0,
      });
      if (action === SPENDING_AUTH_STATUS) {
        const env = await store.get(site);
        return reply({ success: true, data: { ...shape(env?.balanceSats ?? 0), grants: env ? [shape(env.balanceSats)] : [] } });
      }
      if (action === SPENDING_AUTH_REVOKE) {
        const returned = await store.close(site);
        return reply({ success: true, data: { revoked: true, grantId: `envelope:${site}`, returnedSats: returned } });
      }
      if (action !== SPENDING_AUTH_REQUEST) return reply({ success: false, error: 'Unknown call' });
      const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
      const description = typeof p.description === 'string' ? p.description.trim().slice(0, 140) || undefined : undefined;
      const pid = p.protocolID;
      const protocolName = Array.isArray(pid) && typeof pid[1] === 'string' ? pid[1].slice(0, 60) : '';
      const usdPerBsv = await cachedUsdPerBsv().catch(() => undefined);
      const env = await store.get(site);
      const requestID = `envelope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt: StreamGrantPrompt = {
        requestID,
        originator: site,
        protocolName,
        // The sheet's default fill; the user picks the amount (presets), the site does not set it.
        capSatsPerHour: usdPerBsv ? allowanceSats(DEFAULT_ENVELOPE_USD, usdPerBsv) : 0,
        ceilingSatsPerHour: 0,
        expiresAt: 0,
        description,
        usdPerBsv,
        envelope: { balanceSats: env?.balanceSats ?? 0 },
      };
      const answer = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          if (pendingStreamGrantRequests.delete(requestID)) resolve(null);
        }, STREAM_GRANT_TIMEOUT_MS);
        pendingStreamGrantRequests.set(requestID, {
          request: prompt,
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
        });
        showPromptUi('streamGrant', requestID);
      });
      if (answer === null) return reply({ success: false, error: 'Declined' });
      const balance = await store.fill(site, Math.floor(answer));
      reply({ success: true, data: shape(balance) });
    } catch (e) {
      reply({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  /** Settings › Envelopes and a connected app's Coin return (extension pages only, never a site). */
  const handleEnvelopesInternal = async (
    message: { action: string } & Record<string, unknown>,
    sendResponse: CallbackResponse,
  ): Promise<void> => {
    const reply = (r: { success: boolean; data?: unknown; error?: string }) => sendResponse({ type: message.action, ...r });
    try {
      const store = accountContext?.envelopes;
      if (!store) return reply({ success: false, error: 'Wallet is locked' });
      switch (message.action) {
        case 'ENVELOPES_LIST':
          return reply({
            success: true,
            data: { envelopes: await store.list(), usdPerBsv: await cachedUsdPerBsv().catch(() => undefined) },
          });
        case 'ENVELOPE_COIN_RETURN': {
          const site = normalizeOriginator(String(message.originator ?? ''));
          return reply({ success: true, data: { returnedSats: await store.close(site) } });
        }
        default:
          return reply({ success: false, error: 'Unknown call' });
      }
    } catch (e) {
      reply({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  /** The grant sheet's answer and the Streaming permissions screen (extension pages only). */
  const handleStreamGrantInternal = async (
    message: { action: string } & Record<string, unknown>,
    sendResponse: CallbackResponse,
  ): Promise<void> => {
    const reply = (r: { success: boolean; data?: unknown; error?: string }) => sendResponse({ type: message.action, ...r });
    const now = Date.now();
    try {
      switch (message.action) {
        case 'STREAM_GRANT_RESPONSE': {
          const requestID = String(message.requestID ?? '');
          const pending = pendingStreamGrantRequests.get(requestID);
          pendingStreamGrantRequests.delete(requestID);
          const cap = message.capSatsPerHour;
          // A pairing that ended while the sheet was open gets nothing, as on the other four sheets.
          const allowed = !!pending && pairedGrantAllowed(pending.request.originator);
          pending?.resolve(allowed && typeof cap === 'number' && Number.isFinite(cap) && cap >= 1 ? cap : null);
          return reply({ success: !!pending });
        }
        case 'STREAM_GRANTS_LIST': {
          const state = await readStreamState();
          return reply({
            success: true,
            data: {
              paused: state.paused,
              ceilingSatsPerHour: state.ceilingSatsPerHour,
              usdPerBsv: await cachedUsdPerBsv().catch(() => undefined),
              grants: state.grants.map((g) => ({
                ...publicGrant(g, state, now),
                originator: g.originator,
                description: g.description,
                createdAt: g.createdAt,
                revoked: !!g.revokedAt,
                expired: g.expiresAt <= now,
                totalSats: g.totalSats,
                spentLastHourSats: spentLastHour(g, now),
              })),
            },
          });
        }
        case 'STREAM_GRANTS_REVOKE': {
          const id = String(message.grantId ?? '');
          const ok = await updateStreamState((s) => {
            const next = revokeGrant(s, id, now);
            return { state: next, result: !!next };
          });
          return reply({ success: ok });
        }
        case 'STREAM_GRANTS_SETTINGS': {
          await updateStreamState((s) => ({
            state: {
              ...s,
              paused: typeof message.paused === 'boolean' ? message.paused : s.paused,
              ceilingSatsPerHour:
                typeof message.ceilingSatsPerHour === 'number' && message.ceilingSatsPerHour >= 0
                  ? Math.floor(message.ceilingSatsPerHour)
                  : s.ceilingSatsPerHour,
            },
            result: undefined,
          }));
          return reply({ success: true });
        }
        default:
          return reply({ success: false, error: 'Unknown call' });
      }
    } catch (e) {
      reply({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  /** What the sheet needs for the allowance line: the price, and whether the site already has an allowance. */
  const getBundleAllowance = async (originator: string) => {
    const usdPerBsv = await cachedUsdPerBsv();
    let existingSats: number | undefined;
    const store = accountContext?.permissionStore;
    // Envelopes by default: an old stored allowance is not shown and grants nothing (services/allowanceFlag.ts).
    if (ALLOWANCES_ENABLED && store && originator) {
      const grant = await store.findGrant({ type: 'spending', originator: normalizeOriginator(originator) });
      const live = grant && (grant.expiry === 0 || grant.expiry * 1000 > Date.now());
      if (live && grant.authorizedAmount != null) existingSats = grant.authorizedAmount;
    }
    let envelope: { offer: boolean; balanceSats?: number; presetsUsd: readonly number[] } | undefined;
    if (!ALLOWANCES_ENABLED && originator) {
      const site = normalizeOriginator(originator);
      const env = await accountContext?.envelopes.get(site).catch(() => undefined);
      envelope = {
        // A pay sheet offers the envelope for a micropayments site, or to top up one the site already has.
        offer: !!env || isMicropaymentSite(site),
        balanceSats: env?.balanceSats,
        presetsUsd: ENVELOPE_PRESETS_USD,
      };
    }
    return { usdPerBsv, existingSats, defaultUsd: DEFAULT_ALLOWANCE_USD, allowances: ALLOWANCES_ENABLED, envelope };
  };

  /**
   * The answer to one sheet. Each request is still granted or denied through the manager, exactly as the
   * one-prompt-per-permission flow did. A ticked allowance is stored as the site's monthly spending grant
   * (the same record a manifest's grouped grant writes), so later payments under it need no sheet.
   */
  const processBundlePermissionResponse = (
    response: {
      bundleID: string;
      decisions: Record<string, boolean>;
      allowanceUsd?: number;
      /** Optional: the most one payment may take without asking (default: a quarter of the month). */
      allowancePerPaymentUsd?: number;
      /** Optional: the only output locking scripts (hex) the allowance pays without asking. */
      allowancePayees?: string[];
      /** "Put $X in <site>'s envelope" / "Top up the envelope", ticked on a pay sheet (services/envelopes.ts). */
      envelopeUsd?: number;
      remember?: boolean;
      trustSite?: boolean;
      /** "Block this site": decline everything, revoke its grants, refuse its later requests. */
      block?: boolean;
      /** sheetHash of the lines on screen when the user tapped. A mismatch grants nothing. */
      seenHash?: string;
    },
    sendResponse: CallbackResponse,
  ) => {
    const bundle = permissionBundler.get(response.bundleID);
    // Envelopes by default: no sheet sets a monthly allowance (services/allowanceFlag.ts).
    if (!ALLOWANCES_ENABLED) response = { ...response, allowanceUsd: 0, allowancePerPaymentUsd: 0, allowancePayees: undefined };
    if (response.block && bundle) {
      // Nothing on a blocked sheet is granted or stored, whatever the decisions say.
      const none = Object.fromEntries(bundle.items.map((i) => [i.requestID, false]));
      response = { ...response, decisions: none, allowanceUsd: 0, envelopeUsd: 0, trustSite: false, remember: false };
    }
    // A mint sheet answers this one mint: never a monthly allowance or "don't ask again" (services/pinnedMint.ts).
    if (mintBundles.delete(response.bundleID)) {
      response = {
        ...response,
        allowanceUsd: 0,
        allowancePerPaymentUsd: 0,
        allowancePayees: undefined,
        envelopeUsd: 0,
        trustSite: false,
      };
    }
    // Bound to exactly what was on screen: a missing or different hash grants nothing (permissionBundle.ts).
    const result = permissionBundler.resolve(response.bundleID, response.decisions ?? {}, response.seenHash ?? '');
    if (!bundle || !result) {
      sendResponse({ type: 'BUNDLE_PERMISSION_RESPONSE', success: false, error: 'Request expired' });
      return true;
    }
    // Set now, before the denied requests settle: their callers' clean-up would otherwise close the window
    // before the sheet can say why nothing was allowed.
    if (result.stale) holdPopupOpenUntil = Date.now() + STALE_NOTICE_MS;
    if (result.granted.length > 0 && !pairedGrantAllowed(bundle.originator)) {
      for (const r of [...result.granted, ...result.denied]) {
        const pending = pendingPermissionRequests.get(r.requestID);
        pendingPermissionRequests.delete(r.requestID);
        accountContext?.wallet.denyPermission(r.requestID).catch(console.error);
        pending?.reject(new Error('This pairing has ended'));
      }
      sendResponse({ type: 'BUNDLE_PERMISSION_RESPONSE', success: false, error: 'This pairing has ended' });
      closeDappPopupIfNoUi();
      return true;
    }
    const remember = response.remember !== false;
    // Not remembered: the grants last this visit (an hour), then the site asks again.
    // Remembered: GRANT_DEFAULT_DAYS (services/grantExpiry.ts), not for ever (audit 24 Oct B1).
    const expiry = remember ? withDefaultExpiry(0) : Math.floor(Date.now() / 1000) + 3600;
    const wallet = accountContext?.wallet;

    if (response.block) {
      // Its queued requests are refused now, before their own sheet opens.
      denyPendingPromptsFor(bundle.originator);
    }
    const blockSite = async () => {
      const store = accountContext?.permissionStore;
      if (!response.block || !store) return;
      const wpm = (await ensureWallet(true)) as LocalWalletPermissionsManager;
      await wpm.revokeAllForOriginator(bundle.originator);
      await revokeBasketGrantsFor(bundle.originator);
      await store.putGrant({
        key: { type: 'basket', originator: normalizeOriginator(bundle.originator), basket: BLOCK_SITE_BASKET },
        expiry: 0,
        grantedAt: Date.now(),
        reason: 'Blocked: every request is refused',
      } as Parameters<typeof store.putGrant>[0]);
    };

    const work = (async () => {
      await blockSite().catch((error) => console.error('[background] block site failed:', error));
      const usd = Number(response.allowanceUsd ?? 0);
      // Only a sheet about money may set one; a plain sign-in never does (permissionBundle.ts offersAllowance).
      if (usd > 0 && allowanceGranted(bundle, result.granted) && accountContext?.permissionStore) {
        const usdPerBsv = await cachedUsdPerBsv();
        const sats = allowanceSats(usd, usdPerBsv);
        if (sats > 0) {
          const perUsd = Number(response.allowancePerPaymentUsd ?? 0);
          const perPaymentSats = perUsd > 0 ? Math.min(sats, allowanceSats(perUsd, usdPerBsv)) : undefined;
          const payees = parsePayees(response.allowancePayees);
          await accountContext.permissionStore.putGrant({
            key: { type: 'spending', originator: normalizeOriginator(bundle.originator) },
            expiry,
            grantedAt: Date.now(),
            authorizedAmount: sats,
            reason: `Up to $${usd} a month without asking`,
            // Per-payment cap and payee list (services/allowanceGuard.ts, audit 24 Oct B2).
            ...(perPaymentSats !== undefined ? { perPaymentSats } : {}),
            ...(payees ? { payees } : {}),
          } as Parameters<typeof accountContext.permissionStore.putGrant>[0]);
        }
      }
      // The envelope: only on a sheet carrying a payment the user approved. The money stays in the wallet; this is
      // an earmark the site may spend from without a sheet, released by Coin return (services/envelopes.ts).
      const envUsd = Number(response.envelopeUsd ?? 0);
      const paid = result.granted.some((r) => (r as BundleRequest).type === 'spending');
      if (!ALLOWANCES_ENABLED && envUsd > 0 && Number.isFinite(envUsd) && paid && accountContext?.envelopes) {
        const sats = allowanceSats(envUsd, await cachedUsdPerBsv());
        // Keyed exactly as guardEnvelopes spends it: the site's own originator, port kept (the bundle's is the
        // host-only permission key, so "shop.com:8443" would otherwise fill "shop.com"'s envelope; b-Aware row 58).
        const spendReq = result.granted.find((r) => (r as BundleRequest).type === 'spending') as BundleRequest;
        const site = normalizeOriginator(spendReq.displayOriginator ?? bundle.originator);
        if (sats > 0) await accountContext.envelopes.fill(site, sats);
      }
      // "Don't ask again": routine requests from this site are granted without a sheet from now on.
      if (response.trustSite && remember && result.granted.length > 0 && accountContext?.permissionStore) {
        await accountContext.permissionStore.putGrant({
          key: { type: 'basket', originator: normalizeOriginator(bundle.originator), basket: TRUST_SITE_BASKET },
          expiry,
          grantedAt: Date.now(),
          reason: 'Sign-in and signing without asking',
          // Only the baskets on this sheet; any other basket asks again.
          baskets: trustedBasketsFrom(result.granted as (BundledRequest & BundleRequest)[]),
        } as Parameters<typeof accountContext.permissionStore.putGrant>[0]);
      }
      await Promise.all([
        ...result.granted.map(async (r) => {
          const pending = pendingPermissionRequests.get(r.requestID);
          pendingPermissionRequests.delete(r.requestID);
          if (!pending) return;
          try {
            if (!wallet) throw new Error('Wallet is locked');
            await wallet.grantPermission({ requestID: r.requestID, expiry });
            pending.resolve();
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
        ...result.denied.map(async (r) => {
          const pending = pendingPermissionRequests.get(r.requestID);
          pendingPermissionRequests.delete(r.requestID);
          if (!pending) return;
          try {
            await wallet?.denyPermission(r.requestID);
          } finally {
            pending.reject(userDeniedError());
          }
        }),
      ]);
    })();

    work
      .catch((error) => console.error('[background] bundle response failed:', error))
      .finally(() => {
        sendResponse(
          result.stale
            ? {
                type: 'BUNDLE_PERMISSION_RESPONSE',
                success: false,
                error: 'This request changed while you were answering, so nothing was allowed. Ask the site to try again.',
              }
            : { type: 'BUNDLE_PERMISSION_RESPONSE', success: true },
        );
        // A stale answer keeps the window open (holdPopupOpenUntil, set above) so the sheet can show why; it closes itself.
        if (!result.stale) closeDappPopupIfNoUi();
      });
    return true;
  };

  /** Envelopes by default: a connect sheet never stores a monthly allowance, whatever it sent (allowanceFlag.ts). */
  const withoutGroupedAllowance = (granted: Partial<GroupedPermissions>): Partial<GroupedPermissions> => {
    if (ALLOWANCES_ENABLED || !granted.spendingAuthorization) return granted;
    const { spendingAuthorization: _drop, ...rest } = granted;
    void _drop;
    return rest;
  };

  const processGroupedPermissionResponse = (response: {
    requestID: string;
    granted: Partial<GroupedPermissions> | null;
    expiry?: number;
  }) => {
    const pending = pendingGroupedPermissionRequests.get(response.requestID);
    if (!pending) {
      console.warn('No pending grouped permission request found for:', response.requestID);
      return;
    }

    pendingGroupedPermissionRequests.delete(response.requestID);

    if (response.granted && !pairedGrantAllowed(pending.request.originator)) {
      accountContext?.wallet.denyGroupedPermission(response.requestID).catch(console.error);
      pending.reject(new Error('This pairing has ended'));
      closeDappPopupIfNoUi();
      return true;
    }

    if (response.granted) {
      accountContext?.wallet
        .grantGroupedPermission({
          requestID: response.requestID,
          // Reserved wallet-internal protocols are never granted to a site, whatever the sheet sent (audit C1).
          granted: withoutGroupedAllowance(
            response.granted.protocolPermissions
              ? {
                  ...response.granted,
                  protocolPermissions: withoutReservedProtocols(response.granted.protocolPermissions),
                }
              : response.granted,
          ),
          expiry: withDefaultExpiry(response.expiry),
        })
        .then(() => {
          pending.resolve();
        })
        .catch((error) => {
          pending.reject(error);
        });
    } else {
      accountContext?.wallet
        .denyGroupedPermission(response.requestID)
        .then(() => {
          pending.reject(userDeniedError());
        })
        .catch((error) => {
          pending.reject(error);
        });
    }

    closeDappPopupIfNoUi();
    return true;
  };

  const processCounterpartyPermissionResponse = (response: {
    requestID: string;
    granted: Partial<CounterpartyPermissions> | null;
    expiry?: number;
  }) => {
    const pending = pendingCounterpartyPermissionRequests.get(response.requestID);
    if (!pending) {
      console.warn('No pending counterparty permission request found for:', response.requestID);
      return;
    }

    pendingCounterpartyPermissionRequests.delete(response.requestID);

    if (response.granted && !pairedGrantAllowed(pending.request.originator)) {
      accountContext?.wallet.denyCounterpartyPermission(response.requestID).catch(console.error);
      pending.reject(new Error('This pairing has ended'));
      closeDappPopupIfNoUi();
      return true;
    }

    if (response.granted) {
      accountContext?.wallet
        .grantCounterpartyPermission({
          requestID: response.requestID,
          granted: response.granted,
          expiry: withDefaultExpiry(response.expiry),
        })
        .then(() => {
          pending.resolve();
        })
        .catch((error) => {
          pending.reject(error);
        });
    } else {
      accountContext?.wallet
        .denyCounterpartyPermission(response.requestID)
        .then(() => {
          pending.reject(userDeniedError());
        })
        .catch((error) => {
          pending.reject(error);
        });
    }

    closeDappPopupIfNoUi();
    return true;
  };

  // YOURS-SPECIFIC HANDLERS ********************************

  const processGetBalanceRequest = async (sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
    } catch (err) {
      sendResponse({
        type: YoursEventName.GET_BALANCE,
        success: false,
        error: err instanceof Error ? err.message : 'Wallet not available',
      });
      return;
    }
    if (!accountContext) {
      sendResponse({
        type: YoursEventName.GET_BALANCE,
        success: false,
        error: 'Wallet not initialized',
      });
      return;
    }
    // Received-but-not-yet-swept deposits count too (services/depositBalance.ts).
    balanceWithDeposits(accountContext.baseWallet)
      .then((satoshis) => {
        sendResponse({
          type: YoursEventName.GET_BALANCE,
          success: true,
          data: satoshis,
        });
      })
      .catch((error) => {
        sendResponse({
          type: YoursEventName.GET_BALANCE,
          success: false,
          error: error instanceof Error ? error.message : JSON.stringify(error),
        });
      });
  };

  const processGetPubKeysRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        sendResponse({
          type: YoursEventName.GET_PUB_KEYS,
          success: true,
          data: account.pubKeys,
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_PUB_KEYS,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetLegacyAddressesRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        sendResponse({
          type: YoursEventName.GET_LEGACY_ADDRESSES,
          success: true,
          data: account.addresses,
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_LEGACY_ADDRESSES,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetReceiveAddressRequest = async (sendResponse: CallbackResponse) => {
    try {
      await ensureWallet(true);
    } catch (err) {
      sendResponse({
        type: YoursEventName.GET_RECEIVE_ADDRESS,
        success: false,
        error: err instanceof Error ? err.message : 'Wallet not available',
      });
      return;
    }
    try {
      if (!accountContext) {
        sendResponse({
          type: YoursEventName.GET_RECEIVE_ADDRESS,
          success: false,
          error: 'Wallet not initialized',
        });
        return;
      }
      // Prefer the user's selected primaryAddress from storage; fall back to index 0.
      const { account } = chromeStorageService.getCurrentAccountObject();
      // Only hand out an address whose payments the wallet can credit (one the address manager derives); a stored
      // primaryAddress it can't derive would collect money the wallet never adds (owner, 11 Oct 2026, $vexvoid).
      const am = accountContext.syncContext.addressManager;
      const stored = account?.primaryAddress;
      const address = stored && am.getDerivation(stored) ? stored : am.getPrimaryAddress();
      sendResponse({
        type: YoursEventName.GET_RECEIVE_ADDRESS,
        success: true,
        data: address,
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_RECEIVE_ADDRESS,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
  };

  const processGetSocialProfileRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        const displayName = account.settings?.socialProfile?.displayName ?? 'Anonymous';
        const avatar = account.settings?.socialProfile?.avatar ?? HOSTED_YOURS_IMAGE;
        sendResponse({
          type: YoursEventName.GET_SOCIAL_PROFILE,
          success: true,
          data: { displayName, avatar },
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_SOCIAL_PROFILE,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  // MASTER BACKUP/RESTORE HANDLERS ********************************

  const processMasterBackup = async (passwordKey: string | undefined, sendResponse: CallbackResponse) => {
    // Remember where the user started so we can restore even if export fails.
    const originalSelectedAccount = chromeStorageService.getCurrentAccountObject().selectedAccount || '';

    const broadcastProgress = (event: {
      message: string;
      stage?: string;
      accountName?: string;
      accountIndex?: number;
      totalAccounts?: number;
    }) => {
      console.log('[MasterBackup]', event.message);
      chrome.runtime
        .sendMessage({
          action: 'MASTER_BACKUP_PROGRESS',
          data: event,
        })
        .catch(() => {
          // Popup may not be listening — that's fine
        });
    };

    /** Awaitable close — dropWalletContext is fire-and-forget and races IDB. */
    const closeLiveWallet = async (reason: string) => {
      const ctx = accountContext;
      accountContext = null;
      if (!ctx) return;
      console.log(`[MasterBackup] closing live wallet (${reason})`);
      // The USB backup reader shares the database the export is about to walk.
      await closeUsbBackupReader();
      try {
        await ctx.close();
      } catch (err) {
        console.error(`[MasterBackup] close after ${reason}:`, err);
      }
    };

    const restoreOriginalAccount = async () => {
      masterBackupInFlight = false;
      try {
        if (originalSelectedAccount) {
          await chromeStorageService.update({ selectedAccount: originalSelectedAccount });
        }
        await chromeStorageService.getAndSetStorage();
        // Full init so the user lands back on a normal live wallet.
        await initializeWallet();
      } catch (err) {
        console.error('[MasterBackup] failed to restore original account:', err);
      } finally {
        masterBackupGate.end();
      }
    };

    try {
      // Extension-internal: fail closed if locked (no unlock popup).
      try {
        await ensureWallet(true);
      } catch (err) {
        sendResponse({
          type: 'MASTER_BACKUP',
          success: false,
          error: err instanceof Error ? err.message : 'Wallet not available',
        });
        return;
      }

      if (!accountContext) {
        sendResponse({
          type: 'MASTER_BACKUP',
          success: false,
          error: 'Wallet not initialized',
        });
        return;
      }

      const chain = 'main' as const;

      // Same order as Settings backup overlay (getAllAccounts).
      const accountsList = chromeStorageService
        .getAllAccounts()
        .map((acct) => {
          const withAddress = acct as Account & { address?: string };
          const identityAddress = withAddress.address || acct.addresses?.identityAddress || '';
          return {
            identityKey: acct.pubKeys?.identityPubKey || '',
            identityAddress,
            name: acct.name || identityAddress.slice(0, 8),
          };
        })
        .filter((a) => a.identityKey && a.identityAddress);

      if (accountsList.length === 0) {
        sendResponse({ type: 'MASTER_BACKUP', success: false, error: 'No accounts found to back up' });
        return;
      }

      // Never close the wallet under a running switch to this device's store (see storageSwitch).
      if (storageSwitch) {
        console.log('[MasterBackup] waiting for the storage switch to finish');
        await storageSwitch;
      }
      // From here until restoreOriginalAccount: no wallet may come up.
      masterBackupInFlight = true;
      masterBackupGate.begin();
      // Release the live wallet so per-account opens own the IDB connection.
      await closeLiveWallet('before-master-backup');

      const blob = await WalletBackupService.exportAllAccounts(
        chromeStorageService,
        chain,
        accountsList,
        async (acct) => {
          // Do NOT use chromeStorageService.switchAccount — that emits SWITCH_ACCOUNT
          // and would race a full initializeWallet while we hold a backup session.
          await chromeStorageService.update({ selectedAccount: acct.identityAddress });
          await chromeStorageService.getAndSetStorage();
          const opened = await openAccountStorageForBackup(chromeStorageService);
          // wallet-browser vs wallet-toolbox-client WalletStorageManager types differ at compile time only.
          return {
            storage: opened.storage as unknown as import('@bsv/wallet-toolbox-client').WalletStorageManager,
            close: opened.close,
          };
        },
        passwordKey,
        broadcastProgress,
      );

      // Convert blob to base64 for message passing
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Data = btoa(binary);

      await restoreOriginalAccount();

      sendResponse({
        type: 'MASTER_BACKUP',
        success: true,
        data: base64Data,
      });
    } catch (error) {
      console.error('[MasterBackup] Error:', error);
      broadcastProgress({
        stage: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      await restoreOriginalAccount();
      sendResponse({
        type: 'MASTER_BACKUP',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Decode a base64 string to Uint8Array. Returns the narrow `ArrayBuffer`-backed
   *  variant (not `ArrayBufferLike`) so the result is assignable to fflate's
   *  `Unzipped` type when fed into `FileRestoreReader` downstream. */
  const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };

  /**
   * Process a master restore request.
   *
   * The popup decompresses the ZIP (where Web Workers are available) and sends
   * only the extracted entries the background needs. The background never
   * touches the raw ZIP — no sync decompression in the service worker.
   */
  /** Stream restore stages to whichever page started the restore. Best effort. */
  const restoreProgress = (message: string, stage: 'importing' | 'complete' = 'importing') => {
    chrome.runtime.sendMessage({ action: 'MASTER_RESTORE_PROGRESS', data: { message, stage } }).catch(() => {});
  };
  restoreProgressFn = (message) => restoreProgress(message);

  const processMasterRestore = async (
    message: {
      legacy: boolean;
      /** PBKDF2(password, backup salt), hex. Derived on the page so the password never rides the runtime fan-out. */
      passwordKey: string;
      chromeStorageData: string;
      manifestData?: string;
      settingsData?: string;
      chunksData?: Record<string, string>;
      /** USB restore only: turn USB unlock back on before the wallet initialises. */
      usbRekey?: UsbRekeyRequest;
    },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const { legacy, passwordKey, chromeStorageData } = message;

      // Decode the pre-extracted entries from the popup
      const chromeStorageBytes = fromBase64(chromeStorageData);
      const manifestBytes = message.manifestData ? fromBase64(message.manifestData) : undefined;
      const settingsBytes = message.settingsData ? fromBase64(message.settingsData) : undefined;

      // Decode chunk entries back to Uint8Arrays
      let chunks: Record<string, Uint8Array<ArrayBuffer>> | undefined;
      if (message.chunksData) {
        chunks = {};
        for (const [key, b64] of Object.entries(message.chunksData)) {
          chunks[key] = fromBase64(b64);
        }
      }

      console.log('[MasterRestore] Restoring from backup...', legacy ? '(legacy)' : '(v1/v2)');

      await chromeStorageService.getAndSetStorage();
      if (chromeStorageService.getUsbSecurity()?.enabled) {
        throw new Error('Turn off USB key security before restoring a backup');
      }
      const manifest = await WalletBackupService.restoreFromExtractedData(
        chromeStorageService,
        {
          chromeStorage: chromeStorageBytes,
          manifest: manifestBytes,
          settings: settingsBytes,
          chunks,
          isLegacy: legacy,
        },
        passwordKey,
        (event) => {
          console.log('[MasterRestore]', event.message);
          restoreProgress(event.message);
        },
        // Any handles and re-key bookkeeping from a previous enrolment on this
        // profile are meaningless for restored, password-only keys. Cleared only
        // once the restore is known to go ahead, so a refused restore leaves them.
        async () => {
          await chromeStorageService.remove(['usbSecurity', 'keyEpoch', 'keyRecovery', 'keyRekey']);
          await new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(USB_HANDLE_DB_NAME);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          });
        },
      );

      // Refresh chrome storage service to pick up restored data (including passKey)
      await chromeStorageService.getAndSetStorage();
      console.log('[MasterRestore] Chrome storage refreshed');

      // Restored from a USB key: put USB unlock back exactly as it was, with the
      // same wrappers and recovery code. Done here, before the wallet
      // initialises, so no account writer races the re-key.
      if (message.usbRekey) {
        restoreProgress('Turning the USB security key back on…');
        const r = await usbRekey(chromeStorageService, message.usbRekey, { lockGeneration: () => lockGeneration });
        if (!r.success) {
          // The wallet is restored and usable with the password alone; the
          // user can turn the security key on again from Settings.
          console.error('[MasterRestore] USB security key could not be re-enabled:', r.error);
          restoreProgress(
            `Restored, but the USB security key could not be re-enabled (${r.error}). Turn it on from Settings.`,
          );
        }
        await chromeStorageService.getAndSetStorage();
      }

      // Keys and settings are in place and every account's data is parked for
      // import. Reply now: the wallet initialisation that follows can take
      // minutes on a large wallet, and the caller has nothing to wait for.
      sendResponse({
        type: 'MASTER_RESTORE',
        success: true,
        data: manifest,
      });

      // Initialize the wallet so it's ready when the popup opens. For v1/v2
      // this also triggers Phase 2 import of pending wallet data. If the
      // worker is stopped before this finishes, the next popup open resumes it.
      restoreProgress('Importing wallet data…');
      console.log('[MasterRestore] Initializing wallet...');
      initializeWallet()
        .then((wallet) => {
          console.log('[MasterRestore] Wallet initialized:', !!wallet);
          restoreProgress('Restore complete', 'complete');
        })
        .catch((err: Error) => {
          console.error('[MasterRestore] Wallet init after restore failed:', err);
          restoreProgress(`Wallet will finish importing on next open (${err.message})`, 'complete');
        });
    } catch (error) {
      console.error('[MasterRestore] Error:', error);
      sendResponse({
        type: 'MASTER_RESTORE',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // CWI (BRC-100) HANDLERS ********************************
  // All handlers are direct passthroughs - WalletPermissionsManager handles permission prompts

  // Reports the user's authentication status (wallet set up and unlocked).
  // Per BRC-100 this is user-to-wallet status, independent of the calling
  // origin — site-level trust is handled by the permissions manager.
  const checkIsAuthenticated = async (): Promise<boolean> => {
    await chromeStorageService.getAndSetStorage();
    const result = chromeStorageService.getCurrentAccountObject();
    if (!result?.account) return false;

    const currentTime = Date.now();
    const lastActiveTime = result.lastActiveTime;

    return !result.isLocked && !isSessionExpired(lastActiveTime, getInactivityLimit(), currentTime);
  };

  const processCWIIsAuthenticated = (sendResponse: CallbackResponse) => {
    checkIsAuthenticated()
      .then((isAuthenticated) => {
        sendResponse({
          type: CWIEventName.IS_AUTHENTICATED,
          success: true,
          data: { authenticated: isAuthenticated },
        });
      })
      .catch(() => {
        sendResponse({
          type: CWIEventName.IS_AUTHENTICATED,
          success: true,
          data: { authenticated: false },
        });
      });

    return true;
  };

  const processCWIWaitForAuthentication = async (
    message: { params: RequestParams; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();

      // The permissions manager handles the grouped-permission flow: it
      // fetches the originator's manifest.json and prompts once for any
      // declared permissions before resolving.
      const result = await w.waitForAuthentication({}, message.originator);
      sendResponse({
        type: CWIEventName.WAIT_FOR_AUTHENTICATION,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.WAIT_FOR_AUTHENTICATION,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
  };

  // Direct passthrough handlers - wallet handles permissions internally
  const processCWIListOutputs = async (
    message: { params: ListOutputsArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();

      const result = await w.listOutputs(message.params, message.originator);
      sendResponse({
        type: CWIEventName.LIST_OUTPUTS,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.LIST_OUTPUTS,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIGetNetwork = async (message: { originator?: string }, sendResponse: CallbackResponse) => {
    try {
      const w = await ensureWallet();

      const result = await w.getNetwork({}, message.originator);
      sendResponse({
        type: CWIEventName.GET_NETWORK,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.GET_NETWORK,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIGetHeight = async (message: { originator?: string }, sendResponse: CallbackResponse) => {
    try {
      const w = await ensureWallet();

      const result = await w.getHeight({}, message.originator);
      sendResponse({
        type: CWIEventName.GET_HEIGHT,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.GET_HEIGHT,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIGetHeaderForHeight = async (message: { params: GetHeaderArgs }, sendResponse: CallbackResponse) => {
    try {
      const w = await ensureWallet();

      const result = await w.getHeaderForHeight(message.params);
      sendResponse({
        type: CWIEventName.GET_HEADER_FOR_HEIGHT,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.GET_HEADER_FOR_HEIGHT,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIGetPublicKey = async (
    message: { params: GetPublicKeyArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      console.log(
        '[background] processCWIGetPublicKey: entering, params:',
        JSON.stringify(message.params),
        'originator:',
        message.originator,
      );
      const w = await ensureWallet();
      console.log('[background] processCWIGetPublicKey: ensureWallet resolved, calling w.getPublicKey...');
      const result = await w.getPublicKey(message.params, message.originator);
      console.log('[background] processCWIGetPublicKey: getPublicKey returned successfully');
      sendResponse({
        type: CWIEventName.GET_PUBLIC_KEY,
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[background] processCWIGetPublicKey: error:', error);
      sendResponse({
        type: CWIEventName.GET_PUBLIC_KEY,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIListActions = async (
    message: { params: ListActionsArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();

      const result = await w.listActions(message.params, message.originator);
      sendResponse({
        type: CWIEventName.LIST_ACTIONS,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.LIST_ACTIONS,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIVerifySignature = async (
    message: { params: VerifySignatureArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      console.log('[background] processCWIVerifySignature: entering, originator:', message.originator);
      const w = await ensureWallet();
      console.log('[background] processCWIVerifySignature: ensureWallet resolved, calling w.verifySignature...');
      const result = await w.verifySignature(message.params, message.originator);
      console.log('[background] processCWIVerifySignature: success');
      sendResponse({
        type: CWIEventName.VERIFY_SIGNATURE,
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[background] processCWIVerifySignature: error:', error);
      sendResponse({
        type: CWIEventName.VERIFY_SIGNATURE,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  /**
   * USB key security, dApp side. The popup and the prompt window check the
   * key themselves; a dApp with a standing grant reaches the wallet with no
   * window open at all. So before any call that signs, spends, or reveals,
   * require that some wallet window has read a registered key within
   * USB_SEEN_MAX_AGE_MS; otherwise open the prompt window for one click.
   * Calls arriving while that prompt is up share it.
   */
  const ensureUsbSeen = async (reason: string, originator?: string): Promise<void> => {
    await chromeStorageService.getAndSetStorage();
    if (!chromeStorageService.getUsbSecurity()?.enabled) return;
    const seen = await readUsbLastSeen();
    if (seen !== undefined && Date.now() - seen < USB_SEEN_MAX_AGE_MS) return;
    if (await isUsbRecoverySession()) return;
    if (usbCheckInFlight) return usbCheckInFlight;
    const requestID = `usb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    usbCheckInFlight = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingUsbChecks.delete(requestID)) reject(new Error(USB_KEY_ABSENT_MESSAGE));
      }, USB_CHECK_TIMEOUT_MS);
      const settle = (fn: () => void) => () => {
        clearTimeout(timer);
        fn();
      };
      pendingUsbChecks.set(requestID, {
        request: { requestID, reason, originator },
        resolve: settle(resolve),
        reject: (e) => settle(() => reject(e))(),
      });
      showPromptUi('usbCheck', requestID);
    }).finally(() => {
      usbCheckInFlight = null;
    });
    return usbCheckInFlight;
  };

  const processCWICreateHmac = async (
    message: { params: CreateHmacArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    console.log(
      '[background] processCWICreateHmac called, originator:',
      message.originator,
      'params:',
      JSON.stringify(message.params),
    );
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('sign with your keys', message.originator);
      console.log('[background] processCWICreateHmac: wallet obtained, calling w.createHmac...');
      const result = await w.createHmac(message.params, message.originator);
      console.log('[background] processCWICreateHmac: success');
      sendResponse({
        type: CWIEventName.CREATE_HMAC,
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[background] processCWICreateHmac: error:', error);
      sendResponse({
        type: CWIEventName.CREATE_HMAC,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIVerifyHmac = async (
    message: { params: VerifyHmacArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      console.log('[background] processCWIVerifyHmac: entering, originator:', message.originator);
      const w = await ensureWallet();
      console.log('[background] processCWIVerifyHmac: ensureWallet resolved, calling w.verifyHmac...');
      const result = await w.verifyHmac(message.params, message.originator);
      console.log('[background] processCWIVerifyHmac: success');
      sendResponse({
        type: CWIEventName.VERIFY_HMAC,
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[background] processCWIVerifyHmac: error:', error);
      sendResponse({
        type: CWIEventName.VERIFY_HMAC,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  // Signing operations - wallet handles permission prompts internally via callbacks
  const processCWICreateSignature = async (
    message: { params: CreateSignatureArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      console.log('[background] processCWICreateSignature: entering, originator:', message.originator);
      const w = await ensureWallet();
      await ensureUsbSeen('sign with your keys', message.originator);
      console.log('[background] processCWICreateSignature: ensureWallet resolved, calling w.createSignature...');
      const result = await w.createSignature(message.params, message.originator);
      console.log('[background] processCWICreateSignature: success');
      sendResponse({
        type: CWIEventName.CREATE_SIGNATURE,
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[background] processCWICreateSignature: error:', error);
      sendResponse({
        type: CWIEventName.CREATE_SIGNATURE,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIEncrypt = async (
    message: { params: WalletEncryptArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('encrypt data with your keys', message.originator);

      const result = await w.encrypt(message.params, message.originator);
      sendResponse({
        type: CWIEventName.ENCRYPT,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.ENCRYPT,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIDecrypt = async (
    message: { params: WalletDecryptArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('decrypt data with your keys', message.originator);

      const result = await w.decrypt(message.params, message.originator);
      sendResponse({
        type: CWIEventName.DECRYPT,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.DECRYPT,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  // Never pay twice for the same thing while the first is still going out (services/repeatGuard.ts, vexvoid.com
  // 11 Oct 2026). Kept in session storage: the service worker sleeps between a failed-looking attempt and the retry.
  const repeatGuard = new RepeatGuard();
  let repeatGuardLoaded = false;
  const withRepeatGuard = async <T>(fn: (g: RepeatGuard) => T): Promise<T> => {
    if (!repeatGuardLoaded) {
      repeatGuardLoaded = true;
      try {
        repeatGuard.load((await chrome.storage.session.get('bwxRepeatGuard')).bwxRepeatGuard);
      } catch {
        /* session storage unavailable: memory only */
      }
    }
    const r = fn(repeatGuard);
    chrome.storage.session.set({ bwxRepeatGuard: repeatGuard.toJSON() }).catch(() => undefined);
    return r;
  };

  const processCWICreateAction = async (
    message: { params: CreateActionArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    let fundingSnap: FundingSnapshot | undefined;
    let streamPass: (StreamPass & { done: Promise<void>; finish: () => void }) | undefined;
    let spentHeal: HealReport | null | undefined;
    let releasePayeeMark: (() => void) | undefined;
    let releaseMicropay: (() => void) | undefined;
    let ownMintIntent: MintIntent | undefined;
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('build and sign a transaction', message.originator);
      // A monthly allowance with a payee allowlist covers only payments to those payees; this call asks otherwise
      // (services/allowanceGuard.ts, payment-safety audit 24 Oct 2026 B2).
      if (
        ALLOWANCES_ENABLED &&
        message.originator &&
        message.originator !== ADMIN_ORIGINATOR &&
        accountContext?.permissionStore
      ) {
        const site = normalizeOriginator(message.originator);
        const allowance = (await accountContext.permissionStore
          .findGrant({ type: 'spending', originator: site })
          .catch(() => null)) as { payees?: string[] } | null;
        if (allowance?.payees?.length && !payeesAllowed(allowance.payees, message.params.outputs))
          releasePayeeMark = markPayeeMismatch(site);
      }

      console.log('[createAction] Starting with originator:', message.originator);
      console.log(
        '[createAction] Params:',
        JSON.stringify({
          description: message.params.description,
          inputCount: message.params.inputs?.length ?? 0,
          outputCount: message.params.outputs?.length ?? 0,
          options: message.params.options,
          hasInputBEEF: !!message.params.inputBEEF,
          inputBEEFLength: message.params.inputBEEF?.length ?? 0,
        }),
      );

      // Safe only because the onMessage router refuses ADMIN_ORIGINATOR from any non-extension sender (H1).
      const isAdmin = message.originator === ADMIN_ORIGINATOR;
      // Streaming grant (services/streamGrants.ts): a call from a site holding a live grant, carrying its protocol
      // label and inside the rolling hour's budget, has its spend answered without a sheet. Anything else prompts.
      const streamKey = !isAdmin && message.originator ? normalizeOriginator(message.originator) : undefined;
      // A call naming a streaming protocol is a micropayment: its pay sheet offers the site an envelope.
      if (streamKey && !ALLOWANCES_ENABLED && streamProtocolOption(message.params).length)
        releaseMicropay = markMicropayments(streamKey);
      // Streaming grants are allowances: with envelopes (the default) they approve nothing (allowanceFlag.ts).
      if (streamKey && ALLOWANCES_ENABLED) {
        // One stream-approved call per site at a time, so its pass can never answer a different call's spend.
        for (let busy = streamPasses.get(streamKey); busy; busy = streamPasses.get(streamKey)) await busy.done;
        const decision = decideStream(await readStreamState(), {
          originator: streamKey,
          // The label, or options.spendingAuthorization.protocolID (the form bmovies-app sends); both name the protocol.
          labels: [...(message.params.labels ?? []), ...streamProtocolOption(message.params)],
          sats: outputSats(message.params.outputs),
          now: Date.now(),
          outputs: message.params.outputs,
        });
        if (decision.approve) {
          let finish = () => undefined as void;
          const done = new Promise<void>((r) => (finish = r));
          streamPass = {
            grantId: decision.grant.id,
            originator: streamKey,
            label: decision.grant.label,
            maxSats: decision.budget,
            done,
            finish,
          };
          streamPasses.set(streamKey, streamPass);
          console.log('[createAction] streaming grant covers this call; budget left', decision.budget);
        }
      }
      // A pinned site's mint (services/pinnedMint.ts): read before spendingAuthorization is stripped. One per site.
      if (streamKey) {
        const intent = mintIntentFor(streamKey, message.params);
        if (intent && !mintIntents.has(streamKey)) {
          mintIntents.set(streamKey, intent);
          ownMintIntent = intent;
        }
      }
      // options.spendingAuthorization is ours, not BRC-100: never pass it on to the signer.
      message.params = withoutStreamOption(message.params);
      const usesSendAllSentinel = message.params.outputs?.some((o) => o.satoshis === 2099999999999999) === true;
      const signer = isAdmin && usesSendAllSentinel && accountContext?.baseWallet ? accountContext.baseWallet : w;

      // createAction funds from managed change in the 'default' basket only; money the balance shows in the
      // deposit basket or still arriving would be invisible to it (services/fundingPrep.ts, vexvoid.com 11 Oct 2026).
      // Never between the steps of a site's multi-step action: the preparation's own wallet actions break the
      // chain (services/dappChain.ts, vexvoid.com streamed mint 11 Oct 2026).
      const continuing = !isAdmin && continuesChain(message.params);
      // Every site payment is checked against the repeat guard, chain or not: the chain options are the site's own
      // words, so they may skip funding preparation but never the guard (b-Aware row 55, 24 Oct 2026). A noSend step
      // is checked but not recorded: nothing went out yet, and a retried chain must not be refused for it.
      const { fingerprint, recordedFingerprint } = isAdmin
        ? { fingerprint: null, recordedFingerprint: null }
        : await repeatFingerprints(message.params).catch(() => ({ fingerprint: null, recordedFingerprint: null }));
      const earlier = await withRepeatGuard((g) => g.check(fingerprint));
      if (earlier) {
        console.warn('[createAction] identical request still going out; refusing a second payment', earlier);
        sendResponse({ type: CWIEventName.CREATE_ACTION, success: false, error: repeatRefusal(earlier) });
        return true;
      }
      if (continuing) {
        console.log('[createAction] continues a site chain: funding preparation skipped');
      } else if (accountContext) {
        const ctx = accountContext;
        fundingSnap = await prepareFunding({
          wallet: ctx.baseWallet as unknown as Parameters<typeof prepareFunding>[0]['wallet'],
          sweep: ctx.sweepDeposits,
          arriving: arrivingSats,
          creditArriving: ctx.creditArriving,
          recoverFailed: ctx.recoverFailed,
        });
      } else {
        console.warn('[createAction] no account context: skipping funding preparation');
      }

      // A big transaction goes to the background sender, so the site gets {txid, pending} at once instead of
      // waiting on a long upload (services/bigDelayed.ts, owner 12 Oct 2026). Small ones are never changed.
      const bytes = createActionBytes(message.params);
      // A site's own acceptDelayedBroadcast (or the BRC-100 default, true) is not honoured: a small send goes out
      // now, so the answer is the network's; only the wallet decides to send a big one in the background, and then
      // it answers {pending: true} and arms the retry (services/bigDelayed.ts withBroadcastNow, bvideox.com mint
      // b6963e8c…, 24 Oct 2026: a queued send answered like a broadcast one and never went out).
      const delayed = shouldDelay(
        bytes,
        isAdmin ? message.params.options : { ...(message.params.options ?? {}), acceptDelayedBroadcast: undefined },
      );
      const args = delayed
        ? withDelayedBroadcast(message.params)
        : isAdmin
          ? message.params
          : withBroadcastNow(message.params);
      if (delayed) console.log(`[createAction] ${bytes} bytes: sending in the background`);

      let result: Awaited<ReturnType<typeof signer.createAction>>;
      try {
        // UTXO_SPENT (coins spent from another device): heal, then retry ONCE when safe (services/spentRetry.ts).
        const ctxForHeal = accountContext;
        const outcome = await createWithSpentRetry({
          create: () => signer.createAction(args, message.originator),
          heal: (e) => (ctxForHeal ? healRejectedInputs(ctxForHeal, e) : Promise.resolve(null)),
          txKnown: (txid) => (ctxForHeal && ctxChain(ctxForHeal) === 'main' ? wocTxKnown(txid) : Promise.resolve(null)),
          reason: (txid) => refusalFor(txid),
          eligible: retryEligible({ isAdmin, continuing, delayed, sendAll: usesSendAllSentinel, args }),
          log: (m, d) => console.warn(m, d ?? ''),
        });
        spentHeal = outcome.heal;
        if (spentHeal?.released) notifyBalanceUpdate();
        if (!outcome.ok) throw outcome.error;
        if (outcome.retried) console.warn('[createAction] sent on retry after clearing spent coins', spentHeal);
        result = outcome.result;
      } catch (err) {
        // Queued to retry is not a failure: the wallet will send it. Say so, and guard against paying again.
        if (queuedSend(err)) {
          const queued = queuedResult(err);
          await withRepeatGuard((g) => g.record(recordedFingerprint, { origin: message.originator, txid: queued?.txid }));
          // With its txid, answer like a send (BRC-100 callers read txid) and say it's pending; else the old message.
          if (!queued) throw new Error(QUEUED_MESSAGE);
          sendResponse({ type: CWIEventName.CREATE_ACTION, success: true, data: queued });
          return true;
        }
        throw err;
      }
      console.log('[createAction] Success');
      if (streamPass) {
        const pass = streamPass;
        const sats = pass.charged ?? outputSats(message.params.outputs);
        await updateStreamState((st) => ({
          state: recordSpend(st, pass.grantId, { at: Date.now(), sats, txid: result.txid }),
          result: undefined,
        })).catch((e: unknown) => console.warn('[createAction] stream spend not recorded:', e));
      }
      const ref = result.signableTransaction?.reference;
      if (bigRefBytes.size > 200) bigRefBytes.clear();
      if (ref && bytes > 0) bigRefBytes.set(ref, bytes + (result.signableTransaction?.tx?.length ?? 0));
      // Queued, not accepted (the wallet's own background send, or a broadcaster with no verdict): never answered
      // like a broadcast. Marked pending, and the retry is armed so it really goes out.
      if (result.txid && (delayed || (!isAdmin && resultIsQueued(result)))) {
        result = pendingShape(result);
        if (accountContext) {
          sendRetry.arm();
          kickSendWaiting(sendRetry.tick);
        }
      }
      await withRepeatGuard((g) =>
        g.record(recordedFingerprint, {
          origin: message.originator,
          reference: result.signableTransaction?.reference,
          txid: result.txid,
        }),
      );
      if (!isAdmin && (continuing || startsChain(message.params))) markChainStep();
      // Live balance: tell any open wallet page at once, so the card ticks down before the next fetch (owner, 8 Oct
      // 2026). Display only; the page reconciles on its next balance load (src/mobile/wallet/live/liveBus.ts).
      if (result.txid || result.tx) {
        const sats = requestedSats(message.params.outputs);
        if (sats > 0)
          chrome.runtime
            .sendMessage({
              action: 'bwxLiveSpend',
              data: {
                sats,
                txid: result.txid,
                label: message.params.description?.slice(0, 60) ?? '',
                origin: message.originator && message.originator !== ADMIN_ORIGINATOR ? message.originator : undefined,
              },
            })
            ?.catch(() => {
              /* no wallet page open */
            });
      }
      if (message.originator && message.originator !== ADMIN_ORIGINATOR && result.txid) {
        const origin = message.originator;
        const payment = {
          at: Date.now(),
          txid: result.txid,
          sats: requestedSats(message.params.outputs),
          description: message.params.description?.slice(0, 120),
        };
        void updateConnectionLog((l) => recordPayment(l, origin, payment));
      }
      sendResponse({
        type: CWIEventName.CREATE_ACTION,
        success: true,
        data: result,
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'Unknown';
      // describeWalletError: WERR_REVIEW_ACTIONS' per-tx status (doubleSpend, invalidTx…) only survives as text here.
      const errorMessage = error instanceof Error ? describeWalletError(error) : JSON.stringify(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error('[createAction] Error:', errorName, errorMessage);
      if (errorStack) console.error('[createAction] Stack:', errorStack);
      const friendly = fundingSnap && isInsufficientFunds(error) ? insufficientFundsMessage(error, fundingSnap) : null;
      if (friendly) console.error('[createAction] Funding:', friendly);
      // Rejected as invalid: clear the inputs the chain proves spent, or the retry picks them again (invalidSendHeal.ts).
      // Already done by createWithSpentRetry when the createAction itself failed (never heal twice).
      const heal =
        spentHeal !== undefined
          ? spentHeal
          : isInvalidTxReview(error) && accountContext
            ? await healRejectedInputs(accountContext, error)
            : null;
      if (heal) console.warn('[createAction] invalidTx heal:', heal);
      sendResponse({
        type: CWIEventName.CREATE_ACTION,
        success: false,
        // Heal outcome first: the page cuts long errors, and a long broadcaster reason hid "tap Send again" (19 Oct).
        error: withHealMessage(friendly ?? errorMessage, heal),
      });
    } finally {
      releasePayeeMark?.();
      releaseMicropay?.();
      if (ownMintIntent && mintIntents.get(ownMintIntent.origin) === ownMintIntent) mintIntents.delete(ownMintIntent.origin);
      if (streamPass) {
        if (streamPasses.get(streamPass.originator) === streamPass) streamPasses.delete(streamPass.originator);
        streamPass.finish();
      }
    }
    return true;
  };

  /** The txid storage holds for an action reference (the signed transaction), or null. */
  const txidForReference = async (reference: string | undefined): Promise<string | null> => {
    if (!reference || !accountContext?.storage) return null;
    return accountContext.storage.runAsStorageProvider(async (sp) => {
      const [t] = await sp.findTransactions({ partial: { reference }, noRawTx: true });
      return t?.txid ?? null;
    });
  };

  /** Bytes known for a signable action's reference (set at createAction; storage when the worker restarted). */
  const bigRefBytes = new Map<string, number>();
  const signableBytes = async (reference: string | undefined): Promise<number> => {
    if (!reference) return 0;
    const known = bigRefBytes.get(reference);
    if (known !== undefined) return known;
    return accountContext ? await accountContext.referenceBytes(reference).catch(() => 0) : 0;
  };

  const processCWISignAction = async (
    message: { params: SignActionArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('sign a transaction', message.originator);

      markChainStep();
      // Big: the background sender uploads it (services/bigDelayed.ts).
      const bytes = (await signableBytes(message.params.reference)) + signActionBytes(message.params);
      const site = !!message.originator && message.originator !== ADMIN_ORIGINATOR;
      // As createAction: a site's acceptDelayedBroadcast is not honoured; small sends go out now (withBroadcastNow).
      const delayed = shouldDelay(
        bytes,
        site ? { ...(message.params.options ?? {}), acceptDelayedBroadcast: undefined } : message.params.options,
      );
      if (delayed) console.log(`[signAction] ${bytes} bytes: sending in the background`);
      bigRefBytes.delete(message.params.reference);
      let result = await w.signAction(
        delayed ? withDelayedBroadcast(message.params) : site ? withBroadcastNow(message.params) : message.params,
        message.originator,
      );
      if (result?.txid && (delayed || (site && resultIsQueued(result)))) {
        result = pendingShape(result);
        if (accountContext) {
          sendRetry.arm();
          kickSendWaiting(sendRetry.tick);
        }
      }
      console.log('[signAction] Success', result?.txid ? `txid=${result.txid}` : '');
      await withRepeatGuard((g) => g.signed(message.params.reference, result?.txid));
      // The step that broadcasts the batch ends the chain; otherwise it stays active for the next step.
      if (result?.sendWithResults?.length) endChain();
      else markChainStep();
      sendResponse({
        type: CWIEventName.SIGN_ACTION,
        success: true,
        data: result,
      });
    } catch (error) {
      // Queued to retry is not a failure (services/repeatGuard.ts): answer with the txid, marked pending. When the
      // error itself carries no txid, the signed transaction is in storage under the action's reference.
      const queued = queuedResult(
        error,
        queuedSend(error) ? await txidForReference(message.params.reference).catch(() => null) : null,
      );
      if (queued) {
        console.warn('[signAction] queued for retry, answering pending:', queued.txid);
        await withRepeatGuard((g) => g.signed(message.params.reference, queued.txid));
        endChain();
        sendResponse({ type: CWIEventName.SIGN_ACTION, success: true, data: queued });
        return true;
      }
      console.error('[signAction] Error:', error);
      if (error && typeof error === 'object') {
        const { sendWithResults, txid, code } = error as Record<string, unknown>;
        if (sendWithResults) {
          console.error('[signAction] sendWithResults:', JSON.stringify(sendWithResults, null, 2));
          console.error('[signAction] txid:', txid, 'code:', code);
        }
      }
      sendResponse({
        type: CWIEventName.SIGN_ACTION,
        success: false,
        // Queued to retry is not a failure (services/repeatGuard.ts): the wallet will send it on its own.
        error: queuedSend(error) ? QUEUED_MESSAGE : error instanceof Error ? describeWalletError(error) : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIAbortAction = async (
    message: { params: AbortActionArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();

      // Never abort an action whose transaction the network already has: that strands money that really moved.
      const ref = String(message.params?.reference ?? '');
      if (accountContext && (await accountContext.knownOnChain(ref))) {
        console.warn('[abortAction] transaction is already on chain; not aborting:', ref);
        sendResponse({ type: CWIEventName.ABORT_ACTION, success: true, data: { aborted: false } });
        return true;
      }
      const result = await w.abortAction(message.params, message.originator);
      if (result?.aborted) await withRepeatGuard((g) => g.aborted(String(message.params?.reference ?? '')));
      sendResponse({
        type: CWIEventName.ABORT_ACTION,
        success: true,
        data: result,
      });
    } catch (error) {
      // An abort of an action that is already signed or shared has nothing to do. Answer it as done, so the site
      // reports the step that actually failed instead of this refusal (services/dappChain.ts; @1sat/actions
      // completeSignedAction aborts after a failed local check and surfaces only the abort's error).
      if (isAlreadyProcessedAbort(error)) {
        console.warn('[abortAction] already signed or shared; nothing to abort:', message.params?.reference);
        sendResponse({ type: CWIEventName.ABORT_ACTION, success: true, data: { aborted: false } });
        return true;
      }
      sendResponse({
        type: CWIEventName.ABORT_ACTION,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIInternalizeAction = async (
    message: { params: InternalizeActionArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('accept a payment into the wallet', message.originator);
      const result = await w.internalizeAction(message.params, message.originator);
      sendResponse({
        type: CWIEventName.INTERNALIZE_ACTION,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.INTERNALIZE_ACTION,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIRelinquishOutput = async (
    message: { params: RelinquishOutputArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('release an output', message.originator);
      const result = await w.relinquishOutput(message.params, message.originator);
      sendResponse({
        type: CWIEventName.RELINQUISH_OUTPUT,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.RELINQUISH_OUTPUT,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIRevealCounterpartyKeyLinkage = async (
    message: { params: RevealCounterpartyKeyLinkageArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('reveal key linkage', message.originator);
      const result = await w.revealCounterpartyKeyLinkage(message.params, message.originator);
      sendResponse({
        type: CWIEventName.REVEAL_COUNTERPARTY_KEY_LINKAGE,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.REVEAL_COUNTERPARTY_KEY_LINKAGE,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIRevealSpecificKeyLinkage = async (
    message: { params: RevealSpecificKeyLinkageArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('reveal key linkage', message.originator);
      const result = await w.revealSpecificKeyLinkage(message.params, message.originator);
      sendResponse({
        type: CWIEventName.REVEAL_SPECIFIC_KEY_LINKAGE,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.REVEAL_SPECIFIC_KEY_LINKAGE,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIAcquireCertificate = async (
    message: { params: AcquireCertificateArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('acquire a certificate', message.originator);
      const result = await w.acquireCertificate(message.params, message.originator);
      sendResponse({
        type: CWIEventName.ACQUIRE_CERTIFICATE,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.ACQUIRE_CERTIFICATE,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIListCertificates = async (
    message: { params: ListCertificatesArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      const result = await w.listCertificates(message.params, message.originator);
      sendResponse({
        type: CWIEventName.LIST_CERTIFICATES,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.LIST_CERTIFICATES,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIProveCertificate = async (
    message: { params: ProveCertificateArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('prove a certificate', message.originator);
      const result = await w.proveCertificate(message.params, message.originator);
      sendResponse({
        type: CWIEventName.PROVE_CERTIFICATE,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.PROVE_CERTIFICATE,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIRelinquishCertificate = async (
    message: { params: RelinquishCertificateArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      await ensureUsbSeen('relinquish a certificate', message.originator);
      const result = await w.relinquishCertificate(message.params, message.originator);
      sendResponse({
        type: CWIEventName.RELINQUISH_CERTIFICATE,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.RELINQUISH_CERTIFICATE,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIDiscoverByIdentityKey = async (
    message: { params: DiscoverByIdentityKeyArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      const result = await w.discoverByIdentityKey(message.params, message.originator);
      sendResponse({
        type: CWIEventName.DISCOVER_BY_IDENTITY_KEY,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.DISCOVER_BY_IDENTITY_KEY,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  const processCWIDiscoverByAttributes = async (
    message: { params: DiscoverByAttributesArgs; originator?: string },
    sendResponse: CallbackResponse,
  ) => {
    try {
      const w = await ensureWallet();
      const result = await w.discoverByAttributes(message.params, message.originator);
      sendResponse({
        type: CWIEventName.DISCOVER_BY_ATTRIBUTES,
        success: true,
        data: result,
      });
    } catch (error) {
      sendResponse({
        type: CWIEventName.DISCOVER_BY_ATTRIBUTES,
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      });
    }
    return true;
  };

  // Deny every pending prompt: the user closed the prompt window, dismissed the side-panel prompt, or
  // closed the side panel while a prompt was showing in it.
  denyAllPendingPrompts = () => {
      for (const [requestID, pending] of pendingPermissionRequests) {
        accountContext?.wallet.denyPermission(requestID).catch(console.error);
        pending.reject(new Error('User dismissed the request'));
      }
      pendingPermissionRequests.clear();
      permissionBundler.clear();

      for (const [requestID, pending] of pendingGroupedPermissionRequests) {
        accountContext?.wallet.denyGroupedPermission(requestID).catch(console.error);
        pending.reject(new Error('User dismissed the request'));
      }
      pendingGroupedPermissionRequests.clear();

      for (const [requestID, pending] of pendingCounterpartyPermissionRequests) {
        accountContext?.wallet.denyCounterpartyPermission(requestID).catch(console.error);
        pending.reject(new Error('User dismissed the request'));
      }
      pendingCounterpartyPermissionRequests.clear();

      denyAllOneSatPrompts();

      failPendingUsbChecks(USB_KEY_ABSENT_MESSAGE);
      failPendingStreamGrants();

      // Reject any CWI handlers waiting for wallet unlock
      for (const waiter of pendingWalletWaiters.splice(0)) {
        waiter.reject(new Error('User dismissed the unlock request'));
      }

  };

  denyPendingPromptsFor = (originator: string) => {
    for (const [requestID, pending] of takePendingFor(pendingPermissionRequests, originator)) {
      permissionBundler.removeRequest(requestID);
      accountContext?.wallet.denyPermission(requestID).catch(console.error);
      pending.reject(new Error('The site was disconnected'));
    }
    for (const [requestID, pending] of takePendingFor(pendingGroupedPermissionRequests, originator)) {
      accountContext?.wallet.denyGroupedPermission(requestID).catch(console.error);
      pending.reject(new Error('The site was disconnected'));
    }
    for (const [requestID, pending] of takePendingFor(pendingCounterpartyPermissionRequests, originator)) {
      accountContext?.wallet.denyCounterpartyPermission(requestID).catch(console.error);
      pending.reject(new Error('The site was disconnected'));
    }
    // The envelope / stream sheet too: an open one answers "declined", so Allow after a disconnect writes nothing
    // (b-Aware rows 53-54, 24 Oct 2026).
    for (const [, pending] of takePendingFor(pendingStreamGrantRequests, originator)) pending.resolve(null);
    closeDappPopupIfNoUi();
  };

  // In-page sheet: the site's tab closed or navigated away, so the sheet is gone. Deny what it was showing.
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    if (inPageSheet?.tabId !== tabId) return;
    inPageSheet = undefined;
    denyAllPendingPrompts();
  });
  chrome.tabs?.onUpdated?.addListener((tabId, info) => {
    if (inPageSheet?.tabId !== tabId || info.status !== 'loading') return;
    inPageSheet = undefined;
    denyAllPendingPrompts();
  });

  // HANDLE WINDOW CLOSE *****************************************
  chrome.windows.onRemoved.addListener((closedWindowId) => {
    console.log('Window closed: ', closedWindowId);

    if (selfClosedWindowIds.delete(closedWindowId)) {
      // Background closed it after checking nothing was pending. If a prompt was
      // queued in the meantime, it was sent to a dying window: reopen for it.
      if (closedWindowId === popupWindowId) {
        popupWindowId = undefined;
        chromeStorageService.remove('popupWindowId');
      }
      const next = getNextPendingPrompt();
      if (next) showPromptUi(next.kind, next.requestID);
      else if (pendingWalletWaiters.length > 0) showUnlockUi();
      return;
    }

    if (closedWindowId === popupWindowId) {
      denyAllPendingPrompts();
      popupWindowId = undefined;
      chromeStorageService.remove('popupWindowId');
    }
  });
}

// ─── bWalletX pairing links ──────────────────────────────────
// `bwalletx login` prints https://www.bwallet.space/pair?… ; opening it in Chrome hands it to the side
// panel (src/mobile/pair/links.ts reads PAIR_LINK_KEY), which runs the usual confirm flow. Only the
// link is passed: the relay session itself runs in the panel, where the wallet keys are.
const PAIR_LINK_KEY = 'bwalletxPendingPairLink';
const isPairUrl = (url?: string) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.host === 'www.bwallet.space' || u.host === 'bwallet.space') && u.pathname === '/pair' && u.searchParams.has('c');
  } catch {
    return false;
  }
};
const seenPairLinks = new Set<string>();
// Phones have chrome.tabs without onUpdated: an unguarded call threw here and stopped the whole background worker
// (owner, 6 Oct 2026: nothing answered, balance stuck refreshing).
chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
  const url = info.url ?? (info.status === 'loading' ? tab.url : undefined);
  if (!isPairUrl(url) || seenPairLinks.has(url!)) return;
  seenPairLinks.add(url!);
  void chrome.storage.local.set({ [PAIR_LINK_KEY]: url });
  // sidePanel.open wants a user gesture; a link click usually counts, else the link waits until the panel opens.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sp = (chrome as any).sidePanel;
  const nudge = () =>
    chrome.notifications?.create('bwalletx-pair', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Pairing link received',
      message: 'Open bWalletX (toolbar icon) to check the code and pair.',
    });
  if (sp?.open) Promise.resolve(sp.open({ tabId, windowId: tab.windowId })).catch(nudge);
  else nudge();
});

// ─── Sign in with bWalletX ───────────────────────────────────
// auth.bwalletx.com/authorize's "Use the Chrome extension" button opens auth.bwalletx.com/wallet?id=<32 hex>.
// Hand the URL to the side panel (src/mobile/auth/authLink.ts reads AUTH_LINK_KEY), which shows the one-sheet
// approval. Only the request id travels; the panel fetches the request from the server it trusts.
const AUTH_LINK_KEY = 'bwalletxPendingAuthLink';
const isAuthUrl = (url?: string) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.origin === 'https://auth.bwalletx.com' && u.pathname === '/wallet' && /^[0-9a-f]{32}$/.test(u.searchParams.get('id') ?? '');
  } catch {
    return false;
  }
};
const seenAuthLinks = new Set<string>();
chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
  const url = info.url ?? (info.status === 'loading' ? tab.url : undefined);
  if (!isAuthUrl(url) || seenAuthLinks.has(url!)) return;
  seenAuthLinks.add(url!);
  void chrome.storage.local.set({ [AUTH_LINK_KEY]: url });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sp = (chrome as any).sidePanel;
  const nudge = () =>
    chrome.notifications?.create('bwalletx-auth', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Sign-in request',
      message: 'Open bWalletX (toolbar icon) to approve.',
    });
  if (sp?.open) Promise.resolve(sp.open({ tabId, windowId: tab.windowId })).catch(nudge);
  else nudge();
});
