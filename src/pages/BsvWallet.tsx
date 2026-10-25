import { heldBsv21Balances } from '../mobile/airdrops/heldBalances';
import { migrationRowText } from '../utils/migrationRow';
import { quarantineFor, setQuarantineAccount } from '../mobile/airdrops/inbox';
import { withoutQuarantined } from '../mobile/airdrops/quarantine';
import { BsvPriceBar, BuyBsvButton, BuyBsvSheet } from '../mobile/wallet/BuyBsv';
import { BUY_CRYPTO_ENABLED } from '../mobile/storeBuild';
import { phoneLayoutOn } from '../mobile/phone/flag';
import { loadTokenCache, saveTokenCache } from '../mobile/wallet/tokenCache';
import { requestBackupThen as gateReceive } from '../mobile/backup/backupState';
import { MyFlipBavatar } from '../mobile/bavatar/FlipBavatar';
import { notifyMinted } from '../mobile/mint/mint';
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  List,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeft,
  ArrowRight,
  Copy,
  Check,
  Trash2,
  Plus,
  Loader2,
} from 'lucide-react';
import bsvCoin from '../assets/bsv-coin.svg';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { PageLoader } from '../components/PageLoader';
import { QrCode } from '../components/QrCode';
import { BetaLine } from '../mobile/sweep/BetaLine';
import { MainContent } from '../components/Reusable';
import { Show } from '../components/Show';
import { TopNav } from '../components/TopNav';
import { RefreshGlyph, UpToDateAnnouncer, useUpToDate } from '../components/RefreshGlyph';
import { useBottomMenu } from '../hooks/useBottomMenu';
import { useSnackbar } from '../hooks/useSnackbar';
import { useIdentity, resolveImageUrl } from '../hooks/useIdentity';
import { useTheme } from '../hooks/useTheme';
import {
  BSV_DECIMAL_CONVERSION,
  GENERIC_TOKEN_ICON,
  MNEE_ICON_URL,
  MNEE_MOBILE_REFERRAL_LINK,
} from '../utils/constants';
import { formatNumberWithCommasAndDecimals, formatUSD } from '../utils/format';
import { sleep } from '../utils/sleep';
import { isUri } from '../utils/uri';
import { AssetRow } from '../components/AssetRow';
import { DefaultTokenCards } from '../mobile/wallet/DefaultTokenCards';
import { BSV_LOCK_ROUTE } from '../mobile/wallet/rowLock';
import { BackupPromo } from '../components/BackupPromo';
import lockIcon from '../assets/lock.svg';
import { useLocation, useNavigate } from 'react-router-dom';
import { useServiceContext } from '../hooks/useServiceContext';
import { getLockData, sendAllBsv, syncAddresses, unlockBsv, type Bsv21Balance, type LockData } from '@1sat/actions';
import { sendBsv } from '../utils/guardedSendBsv';
import { getWalletBalance, fetchExchangeRate, cachedExchangeRate } from '../utils/wallet';
import { sendMessageAsync } from '../utils/chromeHelpers';
import { YoursEventName } from '../inject';
import { useSyncTracker } from '../hooks/useSyncTracker';
import { getErrorMessage, isValidEmail } from '../utils/tools';
import { UpgradeNotification } from '../components/UpgradeNotification';
import { Bsv21TokensList } from '../components/Bsv21TokensList';
import { ManageTokens } from '../components/ManageTokens';
import { Account, ChromeStorageObject } from '../services/types/chromeStorage.types';
import { SendBsv21View } from '../components/SendBsv21View';
import { AssetPicker, type PickableAsset } from '../components/AssetPicker';
import { SendConfirmation, type SendLineItem } from '../components/SendConfirmation';
import { celebrateSend } from '../components/sent/sent';
import { CoinHistory } from '../components/CoinHistory';
import { getMneeBalance, sendMnee, deriveDepositAddresses, ONESAT_MAINNET_CONTENT_URL } from '@1sat/actions';
import { MNEE_PROTOCOLS, mneeKeyDerivations } from '../utils/mneeDerivations';
import { MneeClient } from '@1sat/client';
import { PrivateKey } from '@bsv/sdk';
import { planAddressScan } from '../services/addressScan';
import { getLegacyMneeBalance, sweepLegacyMnee } from '../utils/sweepLegacyMnee';
import { cancelOwnedOrdLockListings } from '../utils/cancelOrdLockListings';
import { decrypt } from '../utils/crypto';
import type { Keys } from '../utils/keys';
import { getPlatform } from '../platform';
import { withTimeout } from '../mobile/withTimeout';
import { onPay, takePay, takePayAmount } from '../mobile/wallet/payNav';
import { onWalletAction, takeWalletAction } from '../mobile/phone/walletAction';
import { FindTokensButton } from '../mobile/wallet/FindTokensButton';
import { HiddenTokens } from '../mobile/wallet/HiddenTokens';
import { BsvPriceChart } from '../mobile/wallet/PriceChart';
import { OrdinalsAddress } from '../mobile/wallet/OrdinalsAddress';
import { useTabHome } from '../mobile/tabs/useTabHome';
import { SendCard } from '../mobile/wallet/send/SendCard';
import { isMainnetAddress } from '../mobile/names/address';
import { pendingMeta, rememberSent } from '../mobile/wallet/send/sendLogic';
import { payeeNote } from '../mobile/wallet/send/payee';
import { TokenSwipe } from '../mobile/wallet/TokenSwipe';
import { openHoldersRoom } from '../mobile/wallet/holdersRoom';
// Swipe › Lock on a token row (BSV-21 time-locks with receipts, locks/tokenLocks.ts).
const TokenLockSheet = lazy(() => import('../mobile/locks/TokenLockSheet'));
import { CoinRow } from '../mobile/wallet/CoinRow';
import { IS_EXTENSION } from '../mobile/extension';
import { useTokenRows } from '../mobile/wallet/tokenRows';
import { openTicketRoomInChat } from '../mobile/tickets/ticketRoom';
import { asMenuItem } from '../mobile/tabs/tabs';
import { RelayxRecoverScreen } from '../mobile/sweep/RelayxRecoverScreen';
import { useRelayxAccount } from '../mobile/sweep/useRelayxAccount';
import relayxIcon from '../mobile/brand/restore/relayx.svg';
import { describeWalletError } from '../brand/walletError';
import { publishBalance } from '../mobile/wallet/balanceStore';
import { HomeShortcuts } from '../components/HomeShortcuts';
import {
  BALANCE_TIMEOUT_MS,
  RATE_TIMEOUT_MS,
  balanceView,
  loadLastBalance,
  loadLastBalanceAt,
  showSyncRetry,
  staleBalanceHint,
  saveLastBalance,
} from '../mobile/wallet/balanceLoad';

// CopyAddressed feedback state hook — used in receive view

type PageState = 'main' | 'receive' | 'send' | 'sendMNEE' | 'getMNEE' | 'asset-picker';
type AmountType = 'bsv' | 'usd';

export type Recipient = {
  id: string;
  address: string;
  satSendAmount: number | null;
  usdSendAmount: number | null;
  amountType: AmountType;
  error?: string;
};

export const BsvWallet = () => {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const { updateBalance, balanceTick, isSyncing, restoreMessage } = useSyncTracker();
  const urlParams = new URLSearchParams(location.search);
  const { handleSelect, query } = useBottomMenu();
  const tokenRows = useTokenRows();
  const isReload = urlParams.get('reload') === 'true' || query === 'reload';
  urlParams.delete('reload');
  const [pageState, setPageState] = useState<PageState>('main');
  const [sendSource, setSendSource] = useState<PageState>('main');
  const [satSendAmount, setSatSendAmount] = useState<number | null>(null);
  const { addSnackbar } = useSnackbar();
  const { chromeStorageService, apiContext, keysService } = useServiceContext();
  const { profile: identityProfile } = useIdentity(apiContext, chromeStorageService);
  const avatarUrl = useMemo(() => {
    if (!identityProfile.image || !apiContext.services) return '';
    return resolveImageUrl(identityProfile.image, apiContext);
  }, [identityProfile.image, apiContext]);
  const [avatarReady, setAvatarReady] = useState(false);

  // Embedder hook (platform.ts): the wallet home is showing.
  useEffect(() => {
    getPlatform().onWalletReady?.();
  }, []);

  // Pre-load the avatar image so it's decoded before we render it.
  useEffect(() => {
    if (!avatarUrl) {
      setAvatarReady(false);
      return;
    }
    const img = new Image();
    img.src = avatarUrl;
    img.onload = () => setAvatarReady(true);
    img.onerror = () => setAvatarReady(false);
  }, [avatarUrl]);

  const [unlockAttempted, setUnlockAttempted] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sendConfirmation, setSendConfirmation] = useState<{
    icon?: string;
    lineItems: SendLineItem[];
    total: string;
    totalSats?: number;
    onConfirm: () => void;
  } | null>(null);
  // Get identityAddress from chrome storage (selected account)
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress || '';

  // A restored wallet / new device: find its token locks on chain once, in the background (quiet unless found).
  const snackRef = useRef(addSnackbar);
  snackRef.current = addSnackbar;
  const lockScanTried = useRef(new Set<string>());
  useEffect(() => {
    if (!identityAddress || !apiContext.services || lockScanTried.current.has(identityAddress)) return;
    lockScanTried.current.add(identityAddress);
    let live = true;
    void (async () => {
      try {
        const { tokenLocksScanned } = await import('../mobile/locks/tokenLocks');
        if (tokenLocksScanned(identityAddress)) return;
        const { scanTokenLocks } = await import('../mobile/locks/tokenLockApi');
        const res = await scanTokenLocks(apiContext, identityAddress, chromeStorageService);
        if (live && res.added > 0)
          snackRef.current(
            `Found ${res.added} token lock${res.added === 1 ? '' : 's'} on chain. See Pots & Locks › Locks.`,
            'info',
            5000,
          );
      } catch {
        // indexer down: the next open tries again, and Find my token locks is always there
      }
    })();
    return () => {
      live = false;
    };
  }, [identityAddress, apiContext, chromeStorageService]);
  const [receiveAddress, setReceiveAddress] = useState<string>('');
  const receiveAddressRef = useRef('');
  receiveAddressRef.current = receiveAddress;
  // All derived MNEE deposit addresses for the account (not just the currently selected
  // receiveAddress), used so MNEE balance/history aggregate deposits made to any address.
  const [mneeAddresses, setMneeAddresses] = useState<string[]>([]);
  const [depositAddresses, setDepositAddresses] = useState<
    { address: string; index: number; derivationPrefix: string; derivationSuffix: string }[]
  >([]);
  const [selectedAddressIndex, setSelectedAddressIndex] = useState(0);
  const [generatingAddress, setGeneratingAddress] = useState(false);
  // The last balance this device saw, shown at once while the wallet opens and syncs (owner, 19 Oct 2026: a big
  // wallet sat on "Still syncing. Tap to retry." for a long time before its balance appeared).
  const [bsvBalance, setBsvBalance] = useState<number>(() => (loadLastBalance(identityAddress) ?? 0) / 100_000_000);
  const [exchangeRate, setExchangeRate] = useState<number>(0);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [balanceFailed, setBalanceFailed] = useState(false);
  const [balanceKnown, setBalanceKnown] = useState(() => loadLastBalance(identityAddress) != null);
  // True only once THIS session loaded a fresh balance: MAX / send-all never act on the cached amount.
  const [balanceFresh, setBalanceFresh] = useState(false);
  // Switching account without a remount: show that account's cached balance, never the previous one's.
  const balanceAccount = useRef(identityAddress);
  useEffect(() => {
    if (balanceAccount.current === identityAddress) return;
    balanceAccount.current = identityAddress;
    const cached = loadLastBalance(identityAddress);
    setBsvBalance((cached ?? 0) / 100_000_000);
    setBalanceKnown(cached != null);
    setBalanceFresh(false);
    setBalanceFailed(false);
    setBalanceLoading(true);
  }, [identityAddress]);
  const [lockData, setLockData] = useState<LockData>();
  const [isSendAllBsv, setIsSendAllBsv] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showBackupPromo, setShowBackupPromo] = useState(false);
  const [keysAlreadyBackedUp, setKeysAlreadyBackedUp] = useState(false);
  const [legacyLeft, setLegacyLeft] = useState(0);
  const [relayxOpen, setRelayxOpen] = useState(false);
  // Restored as RelayX: open this account's own RelayX collection (settings.relayx, RestoreAccount.tsx).
  const relayxXpub = useRelayxAccount();
  // Cache first (owner round 6): last token balances at once, refreshed in the background.
  const [bsv21s, setBsv21s] = useState<Bsv21Balance[]>(() => {
    const id = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
    return withoutQuarantined(loadTokenCache<Bsv21Balance>(id), quarantineFor(id ?? ''));
  });
  const [manageFavorites, setManageFavorites] = useState(false);
  const [account, setAccount] = useState<Account>();
  const [token, setToken] = useState<{ isConfirmed: boolean; info: Bsv21Balance } | null>(null);
  // Tapping the Wallet tab returns here from Manage Tokens, a token page, Send, Receive…
  useTabHome('bsv', () => {
    setManageFavorites(false);
    setToken(null);
    setPageState('main');
  });
  const services = theme.settings.services;
  const [filteredTokens, setFilteredTokens] = useState<Bsv21Balance[]>([]);
  const [randomKey, setRandomKey] = useState(Math.random());
  // Bump to force a refresh of the per-coin CoinHistory list (e.g. after a successful send)
  const [bsvHistoryRefreshKey, setBsvHistoryRefreshKey] = useState(0);
  const [mneeHistoryRefreshKey, setMneeHistoryRefreshKey] = useState(0);
  const [mneeBalance, setMneeBalance] = useState(0);
  const [copiedAddress, setCopiedAddress] = useState(false);

  // Legacy MNEE sweep state
  const [legacyMneeBalance, setLegacyMneeBalance] = useState(0);
  const [legacyMneeAddress, setLegacyMneeAddress] = useState('');
  const [legacyMneeSweeping, setLegacyMneeSweeping] = useState(false);
  const [legacyMneeSweepMsg, setLegacyMneeSweepMsg] = useState('');
  const [showLegacyMneePrompt, setShowLegacyMneePrompt] = useState(false);

  // MNEE supports multi-recipient at the action level, so the UI mirrors BSV's pattern
  type MneeRecipient = { id: string; address: string; amount: number | null };
  const [mneeRecipients, setMneeRecipients] = useState<MneeRecipient[]>([
    { id: crypto.randomUUID(), address: '', amount: null },
  ]);

  const addMneeRecipient = () => {
    setMneeRecipients((prev) => [...prev, { id: crypto.randomUUID(), address: '', amount: null }]);
  };

  const removeMneeRecipient = (id: string) => {
    if (mneeRecipients.length > 1) {
      setMneeRecipients((prev) => prev.filter((r) => r.id !== id));
    }
  };

  const updateMneeRecipient = (id: string, field: 'address' | 'amount', value: string | number | null) => {
    setMneeRecipients((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const resetMneeRecipients = () => {
    setMneeRecipients([{ id: crypto.randomUUID(), address: '', amount: null }]);
  };

  const mneeTotal = mneeRecipients.reduce((acc, r) => acc + (r.amount ?? 0), 0);

  const [recipients, setRecipients] = useState<Recipient[]>([
    { id: crypto.randomUUID(), address: '', satSendAmount: null, usdSendAmount: null, amountType: 'usd' },
  ]);

  // Chat › Contacts › Pay: open Send with that recipient filled in (amount + confirm stay manual).
  useEffect(() => {
    const take = () => {
      const to = takePay();
      const sats = takePayAmount();
      if (!to) return;
      // A scanned bitcoin: request with an amount fills it in BSV; the confirm sheet still shows it.
      setRecipients([
        sats
          ? { id: crypto.randomUUID(), address: to, satSendAmount: sats, usdSendAmount: null, amountType: 'bsv' }
          : { id: crypto.randomUUID(), address: to, satSendAmount: null, usdSendAmount: null, amountType: 'usd' },
      ]);
      setPageState('send');
    };
    take();
    return onPay(take);
  }, []);

  // Phone layout: HOME's / the dock's Send and Receive open the same screens as the buttons under the card.
  useEffect(() => {
    const take = () => {
      const a = takeWalletAction();
      if (a === 'receive') setPageState('receive');
      else if (a === 'send') setPageState('asset-picker');
    };
    take();
    return onWalletAction(take);
  }, []);

  const addRecipient = () => {
    setRecipients((prev) => [
      ...prev,
      { id: crypto.randomUUID(), address: '', satSendAmount: null, usdSendAmount: null, amountType: 'usd' },
    ]);
  };

  const removeRecipient = (id: string) => {
    if (recipients.length > 1) {
      setRecipients((prev) => [...prev.filter((r) => r.id !== id)]);
    }
  };

  const updateRecipient = (
    id: string,
    field: 'address' | 'satSendAmount' | 'usdSendAmount' | 'amountType' | 'error',
    value: string | number | null,
  ) => {
    setRecipients((prev) => [
      ...prev.map((r) => {
        if (r.id === id) {
          // If we're updating amountType, reset both amounts
          if (field === 'amountType') {
            return {
              ...r,
              [field]: value as AmountType,
              satSendAmount: null,
              usdSendAmount: null,
            };
          }
          // Otherwise just update the specified field. Editing the address or amount clears a
          // stale submit-time error, so the message and the Send button never disagree.
          return field === 'error' ? { ...r, error: value as string } : { ...r, [field]: value, error: undefined };
        }
        return r;
      }),
    ]);
  };

  const resetRecipients = () => {
    setRecipients([
      { id: crypto.randomUUID(), address: '', satSendAmount: null, usdSendAmount: null, amountType: 'usd' },
    ]);
    setIsProcessing(false);
  };

  // BIP44-style gap limit for MNEE address discovery. `settings.maxKeyIndex` only advances
  // when the user clicks "+ New Address" in this browser session, so a restored wallet (or one
  // used across multiple devices) has no local record of higher indices that were previously
  // funded elsewhere. Rather than deriving/checking unbounded addresses, probe ahead in bounded
  // batches and stop as soon as a full batch comes back with no MNEE activity — mirrors standard
  // HD wallet address-discovery behavior instead of scanning indefinitely.
  const MNEE_GAP_LIMIT = 20;
  const MNEE_MAX_GAP_SCANS = 10; // hard cap: at most 200 addresses probed ahead per call

  /** Extend and persist maxKeyIndex if any higher, not-yet-tracked address has an MNEE balance. */
  const discoverMneeMaxKeyIndex = async (knownMaxKeyIndex: number): Promise<number> => {
    if (!apiContext) return knownMaxKeyIndex;
    let maxKeyIndex = knownMaxKeyIndex;
    let scanStart = knownMaxKeyIndex + 1;

    for (let scan = 0; scan < MNEE_MAX_GAP_SCANS; scan++) {
      const fundedIndices: number[] = [];
      for (const protocolID of MNEE_PROTOCOLS) {
        const { derivations } = await deriveDepositAddresses.execute(apiContext, {
          startIndex: scanStart,
          count: MNEE_GAP_LIMIT,
          protocolID,
        });
        const batchAddresses = derivations.map((d) => d.address);
        const res = await getMneeBalance.execute(apiContext, { addresses: batchAddresses });
        for (const b of res.balances ?? []) {
          if (b.decimalAmount <= 0) continue;
          const i = batchAddresses.indexOf(b.address);
          if (i >= 0) fundedIndices.push(scanStart + i);
        }
      }

      if (fundedIndices.length === 0) break;

      maxKeyIndex = Math.max(maxKeyIndex, ...fundedIndices);
      scanStart += MNEE_GAP_LIMIT;
    }

    if (maxKeyIndex > knownMaxKeyIndex) {
      const { account } = chromeStorageService.getCurrentAccountObject();
      if (account && account.addresses?.identityAddress === identityAddress) {
        await chromeStorageService.updateNested('accounts', {
          [identityAddress]: { settings: { ...account.settings, maxKeyIndex } } as unknown as Account,
        });
      }
    }

    return maxKeyIndex;
  };

  const MNEE_FETCH_RETRIES = 2;

  const updateMneeBalance = async (attempt = 0): Promise<number | undefined> => {
    if (!receiveAddress || !apiContext) return;
    try {
      // Aggregate MNEE balance across all derived deposit addresses for this account,
      // not just the currently selected receive address, since MNEE can be deposited
      // to any previously derived address.
      const { account: acctForMnee } = chromeStorageService.getCurrentAccountObject();
      const knownMaxKeyIndex = acctForMnee?.settings?.maxKeyIndex ?? 4; // default: 0-4 = 5 addresses
      const maxKeyIndex = await discoverMneeMaxKeyIndex(knownMaxKeyIndex);
      const derivations = mneeKeyDerivations(0, maxKeyIndex + 1);
      const res = await getMneeBalance.execute(apiContext, { derivations });
      const seen = new Set((res.balances ?? []).map((b) => b.address));
      let totalDecimal = res.totalDecimal;
      let totalAtomic = res.totalAtomic;
      if (receiveAddress && !seen.has(receiveAddress)) {
        const extra = await getMneeBalance.execute(apiContext, { addresses: [receiveAddress] });
        totalDecimal += extra.totalDecimal;
        totalAtomic += extra.totalAtomic;
        for (const b of extra.balances ?? []) seen.add(b.address);
      }
      const addresses = [...seen];
      setMneeAddresses(addresses.length ? addresses : [receiveAddress]);
      setMneeBalance(totalDecimal);
      // Share the last MNEE balance with the wallet card (the balance cards read it; nothing writes back).
      try {
        localStorage.setItem('bwallet:mnee-balance', String(totalDecimal));
        window.dispatchEvent(new Event('bwallet:mnee-balance'));
      } catch {
        /* storage unavailable */
      }

      // Update MNEE balance in Chrome storage
      const { account } = chromeStorageService.getCurrentAccountObject();
      // `identityAddress` is from this render; after Add account / a switch / during the master backup's account
      // walk the current account can be another one. Never merge one account's object under another's id.
      if (!account || account.addresses?.identityAddress !== identityAddress) return totalDecimal;

      const key: keyof ChromeStorageObject = 'accounts';
      const update: Partial<ChromeStorageObject['accounts']> = {
        [identityAddress]: {
          ...account,
          mneeBalance: {
            amount: totalAtomic,
            decimalAmount: totalDecimal,
          },
        },
      };
      await chromeStorageService.updateNested(key, update);
      return totalDecimal;
    } catch (error) {
      console.error(`Failed to update MNEE balance (attempt ${attempt + 1}):`, error);
      // The first fetch can race service-worker initialization (e.g. storage migration
      // right after an upgrade). A failed lookup would otherwise leave the balance at
      // zero until the page remounts, so retry with a short backoff.
      if (attempt < MNEE_FETCH_RETRIES) {
        setTimeout(() => void updateMneeBalance(attempt + 1), 2000 * (attempt + 1));
      }
      return undefined;
    }
  };

  const resetRecipientErrors = () => {
    setRecipients((prev) => [...prev.map((r) => ({ ...r, error: undefined }))]);
  };

  const getAndSetAccountAndBsv21s = async (): Promise<Bsv21Balance[]> => {
    setQuarantineAccount(chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '');
    const res = await heldBsv21Balances(apiContext);
    setBsv21s(res);
    saveTokenCache(chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress, res);
    setAccount(chromeStorageService.getCurrentAccountObject().account);
    return res;
  };

  /** Order-independent fingerprint of token balances, for change detection. */
  const bsv21Signature = (tokens: Bsv21Balance[]) =>
    tokens
      .map((t) => `${t.id}:${t.amt}`)
      .sort()
      .join('|');

  useEffect(() => {
    if (!bsv21s || !account) return;
    const filtered = bsv21s.filter((t) => t.id && account?.settings?.favoriteTokens?.includes(t.id));
    setFilteredTokens(filtered);
  }, [bsv21s, account]);

  useEffect(() => {
    (async () => {
      const obj = await chromeStorageService.getAndSetStorage();
      setShowWelcome(!!obj?.showWelcome);
      // Show backup promo only if not previously dismissed (per-account)
      // and no active remote. dApp prompts live in a separate prompt window,
      // so this page is always the browser-action popup.
      const acct = obj?.accounts?.[obj?.selectedAccount ?? ''];
      const dismissed = !!acct?.settings?.dismissedBackupPromo;
      const hasRemotes = (acct?.storageConfig?.remotes?.length ?? 0) > 0;
      setKeysAlreadyBackedUp(!!acct?.settings?.keysBackedUp);
      setShowBackupPromo(!dismissed && !hasRemotes);
      // Owner 19 Oct: one always-present "Bring in old assets" row; the count only changes its wording.
      const left = acct?.settings?.legacyLeft;
      setLegacyLeft(left ?? 0);
      if (obj?.selectedAccount) {
        await getAndSetAccountAndBsv21s();
      }
    })();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch receive address from service worker. Retries while it comes back empty (the wallet may still be
  // unlocking or switching account), and again whenever the app returns to the foreground, so the card's
  // address line never stays blank.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number) => {
      try {
        const response = await sendMessageAsync<{ success: boolean; data?: string }>({
          action: YoursEventName.GET_RECEIVE_ADDRESS,
        });
        if (stop) return;
        if (response?.success && response.data) {
          setReceiveAddress(response.data);
          return;
        }
      } catch (error) {
        console.error('Failed to get receive address:', error);
      }
      if (!stop && attempt < 6) timer = setTimeout(() => void load(attempt + 1), 1000 * 2 ** attempt);
    };
    void load(0);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !receiveAddressRef.current) void load(0);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    const bsvBalanceInSats = Math.round(bsvBalance * BSV_DECIMAL_CONVERSION);
    setIsSendAllBsv(balanceFresh && satSendAmount === bsvBalanceInSats);
  }, [satSendAmount, bsvBalance, balanceFresh]);

  const staleHint = staleBalanceHint({
    failed: balanceFailed,
    known: balanceKnown,
    fresh: balanceFresh,
    at: loadLastBalanceAt(identityAddress),
  });

  const applyBalance = (satoshis: number) => {
    setBsvBalance(satoshis / 100_000_000);
    saveLastBalance(identityAddress, satoshis);
    publishBalance('bsv', satoshis / 100_000_000, 'BSV');
    setBalanceKnown(true);
    setBalanceFresh(true);
    setBalanceFailed(false);
    setBalanceLoading(false);
  };

  /**
   * Load the BSV balance, bounded: the background wallet can sit on its storage lock (e.g. while
   * broadcasting a queued tx at start). On timeout/error show the last known balance with
   * "Couldn't refresh" instead of spinning forever; a late answer still lands. Returns null when
   * this attempt did not produce a balance.
   */
  const getAndSetBsvBalance = async (): Promise<number | null> => {
    const pending = getWalletBalance();
    let satoshis: number;
    try {
      satoshis = await withTimeout(pending, BALANCE_TIMEOUT_MS, 'Balance');
    } catch (err) {
      console.warn('[BsvWallet] balance not refreshed:', err instanceof Error ? err.message : err);
      const cached = loadLastBalance(identityAddress);
      if (cached != null && !balanceKnown) {
        setBsvBalance(cached / 100_000_000);
        setBalanceKnown(true);
      }
      setBalanceFailed(true);
      setBalanceLoading(false);
      pending.then(applyBalance).catch(() => undefined);
      return null;
    }
    applyBalance(satoshis);
    await loadRate();
    return satoshis;
  };

  // While the balance is unknown or stale, keep asking every 10 s (owner, 6 Oct 2026: after a restore the
  // wallet is busy syncing for a minute or more, and "Couldn't refresh" stayed until a manual tap).
  useEffect(() => {
    if (!balanceFailed) return;
    const t = setInterval(() => void getAndSetBsvBalance(), 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balanceFailed]);

  const loadRate = async () => {
    const rate = await withTimeout(
      fetchExchangeRate(apiContext.chain, apiContext.wocApiKey),
      RATE_TIMEOUT_MS,
      'Exchange rate',
    ).catch(() => null);
    if (rate) setExchangeRate(rate);
  };

  // The price on its own, retried every 15 s until it arrives (owner, 6 Oct 2026: the balance showed 35M sats
  // but $0.00 for good). It used to be fetched only after a balance that answered in time, so a slow balance
  // or one slow price request left the dollar value at zero until the next refresh.
  useEffect(() => {
    if (exchangeRate > 0) return;
    const known = cachedExchangeRate();
    if (known > 0) return setExchangeRate(known);
    void loadRate();
    const t = setInterval(() => void loadRate(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchangeRate]);

  useEffect(() => {
    if (updateBalance) {
      getAndSetBsvBalance();
      loadLocks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateBalance]);

  // Every finished sync / paymail receipt, not just the first (updateBalance latches at true).
  useEffect(() => {
    if (!balanceTick) return;
    getAndSetBsvBalance();
    loadLocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balanceTick]);

  useEffect(() => {
    if (isReload) window.location.reload();
  }, [isReload]);

  const loadLocks = async () => {
    const lockData = await getLockData.execute(apiContext, {});
    setLockData(lockData);
  };

  useEffect(() => {
    if (loadLocks) loadLocks();
    getAndSetBsvBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch MNEE balance once receiveAddress is available
  useEffect(() => {
    if (receiveAddress) {
      updateMneeBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiveAddress]);

  // Refresh MNEE when the service worker's address sync finishes, the same trigger
  // that refreshes the BSV balance. Without this, MNEE was fetched exactly once.
  useEffect(() => {
    if (!isSyncing && receiveAddress) {
      updateMneeBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSyncing]);

  // Check for legacy MNEE balance (old address) once wallet is ready
  useEffect(() => {
    if (!apiContext?.services?.mnee) return;
    (async () => {
      try {
        const { account } = chromeStorageService.getCurrentAccountObject();
        const passKey = await chromeStorageService.getPassKey();
        if (!account?.encryptedKeys || !passKey) return;
        const decrypted = await decrypt(account.encryptedKeys, passKey);
        const keys: Keys = JSON.parse(decrypted);
        if (!keys.walletWif) return;
        const legacyAddr = PrivateKey.fromWif(keys.walletWif).toPublicKey().toAddress();
        setLegacyMneeAddress(legacyAddr);
        const balance = await getLegacyMneeBalance(apiContext.services!.mnee, legacyAddr);
        setLegacyMneeBalance(balance);
      } catch (err) {
        console.error('[legacyMneeCheck]', err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiveAddress, apiContext?.services?.mnee]);

  const handleSweepLegacyMnee = async () => {
    if (!apiContext?.services?.mnee) return;
    setLegacyMneeSweeping(true);
    setLegacyMneeSweepMsg('Starting...');
    try {
      const { account } = chromeStorageService.getCurrentAccountObject();
      const passKey = await chromeStorageService.getPassKey();
      if (!account?.encryptedKeys || !passKey) throw new Error('Keys unavailable');
      const decrypted = await decrypt(account.encryptedKeys, passKey);
      const keys: Keys = JSON.parse(decrypted);
      if (!keys.walletWif) throw new Error('No legacy wallet key');

      // Derive the BRC-29 destination address
      const derivationResult = await deriveDepositAddresses.execute(apiContext, {
        startIndex: 0,
        count: 1,
      });
      const destinationAddress = derivationResult.derivations[0]?.address;
      if (!destinationAddress) throw new Error('Could not derive destination address');

      const result = await sweepLegacyMnee({
        mneeClient: apiContext.services.mnee,
        legacyPrivateKey: PrivateKey.fromWif(keys.walletWif),
        destinationAddress,
        onProgress: setLegacyMneeSweepMsg,
      });

      if (result.error) {
        addSnackbar(`Sweep failed: ${result.error}`, 'error');
      } else {
        addSnackbar(`Moved $${result.amount?.toFixed(2)} MNEE to your new wallet!`, 'success');
        setLegacyMneeBalance(0);
        updateMneeBalance();
        setMneeHistoryRefreshKey((k) => k + 1);
      }
    } catch (err) {
      addSnackbar(`Sweep failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      setLegacyMneeSweeping(false);
      setShowLegacyMneePrompt(false);
    }
  };

  const [isRefreshing, setIsRefreshing] = useState(false);
  // Manual refresh that found nothing new: the refresh icon turns into a tick for a moment (no toast).
  const [upToDate, showUpToDate] = useUpToDate();
  const [getBsvOpen, setGetBsvOpen] = useState(false);
  const [tokenLock, setTokenLock] = useState<Bsv21Balance | null>(null);

  /**
   * Re-sync addresses, then reload BSV, MNEE, and BSV-21 balances.
   * With `notifyIfUnchanged`, tell the user when nothing moved so a manual refresh
   * that finds no new funds does not look like it silently failed.
   */
  const refreshUtxos = async ({ showLoad = false, notifyIfUnchanged = false } = {}) => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    if (showLoad) setIsProcessing(true);
    // Snapshot before: BSV in satoshis (not USD, so a rate tick is not "a change").
    const before = {
      sats: Math.round(bsvBalance * 100_000_000),
      mnee: mneeBalance,
      tokens: bsv21Signature(bsv21s),
    };
    let synced = true;
    try {
      const { account: acct } = chromeStorageService.getCurrentAccountObject();
      // Same window as the startup sync, so addresses handed out on other devices count too (services/addressScan.ts).
      const { count } = planAddressScan(acct?.settings?.maxKeyIndex, acct?.settings?.addressScanThrough);
      // The wallet's own sync runs it (sharing one run with the startup sync and the background alarm,
      // services/addressResync.ts); a wallet that can't take the message falls back to syncing from here.
      const viaWallet = await withTimeout(
        chrome.runtime
          .sendMessage({ action: 'RESYNC_ADDRESSES', manual: notifyIfUnchanged })
          .then((r: { success?: boolean } | undefined) => r?.success === true)
          .catch(() => false),
        BALANCE_TIMEOUT_MS,
        'Address sync',
      );
      if (!viaWallet && apiContext) {
        // Bounded: a hung sync held the whole refresh (and the balance after it) indefinitely (owner, 6 Oct 2026).
        await withTimeout(syncAddresses.execute(apiContext, { count }), BALANCE_TIMEOUT_MS, 'Address sync');
      }
    } catch (err) {
      synced = false;
      console.error('[refreshUtxos] syncAddresses failed:', err);
    }
    try {
      // MNEE and token lookups bounded too: either one hanging kept the card's refresh icon spinning for good
      // (owner, 6 Oct 2026). A late answer still updates the screen; it just isn't waited for.
      const bounded = <T,>(p: Promise<T>, what: string) =>
        withTimeout(p, BALANCE_TIMEOUT_MS, what).catch((err) => {
          console.warn('[refreshUtxos]', err instanceof Error ? err.message : err);
          return undefined;
        });
      const [sats, mnee, tokens] = await Promise.all([
        getAndSetBsvBalance(),
        bounded(updateMneeBalance(), 'MNEE balance'),
        bounded(getAndSetAccountAndBsv21s(), 'Tokens'),
      ]);
      if (loadLocks) loadLocks();
      const unchanged =
        sats !== null &&
        sats === before.sats &&
        mnee !== undefined &&
        mnee === before.mnee &&
        tokens !== undefined &&
        bsv21Signature(tokens) === before.tokens;
      if (notifyIfUnchanged && synced && unchanged) {
        showUpToDate();
      }
      // NFTs: reload the list on a manual refresh or when anything moved, so purchases appear without reopening.
      if (notifyIfUnchanged || !unchanged) notifyMinted();
    } finally {
      if (showLoad) setIsProcessing(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (!identityAddress || isSyncing) return;
    getAndSetBsvBalance();
    // Auto-unlock: attempt to unlock matured coins via CWI
    if (!unlockAttempted && lockData?.unlockable) {
      (async () => {
        const res = await unlockBsv.execute(apiContext, {});
        setUnlockAttempted(true);
        if (res.txid) {
          await refreshUtxos();
          await sleep(1000);
          addSnackbar('Successfully unlocked coins!', 'success');
        }
        // Note: unlockBsv may return error if it requires direct key access
        // In that case, unlocking happens on the service worker side
      })();
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityAddress, isSyncing, lockData]);

  const resetSendState = () => {
    setIsProcessing(false);
    resetRecipients();
    setIsSendAllBsv(false);
    setSatSendAmount(null);
  };

  const handleCopyToClipboard = () => {
    navigator.clipboard.writeText(receiveAddress).then(() => {
      addSnackbar('Copied!', 'success');
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    });
  };

  const copyAddress = (address: string) => {
    navigator.clipboard.writeText(address).then(() => {
      addSnackbar('Copied!', 'success');
    });
  };

  const setPrimaryAddress = (address: string) => {
    const { account, selectedAccount } = chromeStorageService.getCurrentAccountObject();
    if (account && selectedAccount) {
      chromeStorageService.updateNested('accounts', {
        [selectedAccount]: { primaryAddress: address } as unknown as Account,
      });
    }
  };

  const fetchDepositAddresses = async () => {
    try {
      const response = await sendMessageAsync<{
        success: boolean;
        data?: { address: string; index: number; derivationPrefix: string; derivationSuffix: string }[];
      }>({
        action: 'GET_DEPOSIT_ADDRESSES',
      });
      if (response?.success && response.data) {
        setDepositAddresses(response.data);
      }
    } catch (error) {
      console.error('Failed to get deposit addresses:', error);
    }
  };

  const handleGenerateAddress = async () => {
    setGeneratingAddress(true);
    try {
      const response = await sendMessageAsync<{
        success: boolean;
        data?: { address: string; index: number; derivationPrefix: string; derivationSuffix: string };
      }>({
        action: 'GENERATE_NEW_ADDRESS',
      });
      if (response?.success && response.data) {
        setDepositAddresses((prev) => [...prev, response.data!]);
        setSelectedAddressIndex(response.data.index);
        setReceiveAddress(response.data.address);
        setPrimaryAddress(response.data.address);
        addSnackbar('New address generated!', 'success');
      }
    } catch (error) {
      console.error('Failed to generate address:', error);
      addSnackbar('Failed to generate address', 'error');
    } finally {
      setGeneratingAddress(false);
    }
  };

  const handleSendMNEE = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await sleep(25);

    // Validate all recipients
    for (const r of mneeRecipients) {
      if (!r.address || r.amount === null || r.amount === undefined) {
        addSnackbar('All recipients must have an address and amount!', 'info');
        return;
      }
      if (!isValidEmail(r.address) && !isMainnetAddress(r.address)) {
        addSnackbar('All recipients must have a valid BSV or Paymail address!', 'info');
        return;
      }
      if (r.amount <= 0.00001) {
        addSnackbar('Minimum send amount is 0.00001 MNEE per recipient!', 'error');
        return;
      }
    }

    if (mneeTotal > mneeBalance) {
      addSnackbar('Insufficient MNEE balance!', 'error');
      return;
    }

    if (!apiContext) {
      addSnackbar('Wallet not ready.', 'error');
      return;
    }

    // Consolidate duplicate addresses by summing amounts
    const mneeConsolidated = new Map<string, number>();
    const mneeOrder: string[] = [];
    for (const r of mneeRecipients) {
      mneeConsolidated.set(r.address, (mneeConsolidated.get(r.address) ?? 0) + (r.amount as number));
      if (!mneeOrder.includes(r.address)) mneeOrder.push(r.address);
    }
    const lineItems: SendLineItem[] = mneeOrder.map((addr) => ({
      address: addr,
      amount: `$${mneeConsolidated.get(addr)!.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })} MNEE`,
    }));

    setSendConfirmation({
      icon: MNEE_ICON_URL,
      lineItems,
      total: `$${mneeTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })} MNEE`,
      onConfirm: async () => {
        setSendConfirmation(null);
        setIsProcessing(true);

        try {
          const { account: acctForSend } = chromeStorageService.getCurrentAccountObject();
          const sendCount = (acctForSend?.settings?.maxKeyIndex ?? 4) + 1;

          addSnackbar('Transaction initiated. Processing...', 'info');

          const res = await sendMnee.execute(apiContext, {
            recipients: mneeRecipients.map((r) => ({ address: r.address, amount: r.amount as number })),
            derivations: mneeKeyDerivations(0, sendCount),
          });

          if (res.error) {
            addSnackbar(`Transaction failed: ${res.error}`, 'error');
            setIsProcessing(false);
            return;
          }

          resetMneeRecipients();
          setMneeBalance((prev) => Math.max(0, prev - mneeTotal));
          updateMneeBalance().catch((err) => console.error('[handleSendMNEE] reconcile refresh failed:', err));
          setMneeHistoryRefreshKey((k) => k + 1);
          setPageState('main');
          if (!celebrateSend(res, { amount: { kind: 'mnee', amount: mneeTotal }, recipients: mneeOrder })) {
            addSnackbar('Transaction Successful!', 'success');
          }
        } catch (error: unknown) {
          console.error('MNEE transfer error:', error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (errorMessage.includes('status: 423')) {
            addSnackbar('The sending or receiving address may be frozen. Please contact support.', 'error');
          } else {
            addSnackbar(getErrorMessage(errorMessage) || 'Transfer failed. Please try again.', 'error');
          }
        } finally {
          setIsProcessing(false);
        }
      },
    });
  };

  const handleSendBsv = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    resetRecipientErrors();
    await sleep(25);

    //? multi-send validate all recipients
    for (const recipient of recipients) {
      if (!isValidEmail(recipient.address) && !isMainnetAddress(recipient.address)) {
        updateRecipient(recipient.id, 'error', 'Provide a valid BSV or Paymail address.');
        addSnackbar('All recipients must have valid BSV or Paymail addresses.', 'info');
        return;
      }

      if (
        (!recipient.satSendAmount || recipient.satSendAmount <= 0) &&
        (!recipient.usdSendAmount || recipient.usdSendAmount <= 0)
      ) {
        updateRecipient(recipient.id, 'error', 'Provide an amount.');
        addSnackbar('All recipients must have an amount.', 'info');
        return;
      }
    }

    //? multi-send calculate all amounts
    const sendRecipients = recipients.map((r) => {
      let satoshis = r.satSendAmount ?? 0;
      if (r.amountType === 'usd' && r.usdSendAmount) {
        satoshis = Math.ceil((r.usdSendAmount / exchangeRate) * BSV_DECIMAL_CONVERSION);
      }
      return isValidEmail(r.address) ? { paymail: r.address, satoshis } : { address: r.address, satoshis };
    });

    // Send-all from a cached (possibly stale) balance: wait for the fresh one.
    if (isSendAllBsv && !balanceFresh) {
      addSnackbar('Updating balance…', 'info');
      return;
    }
    const totalSats = isSendAllBsv
      ? Math.round(bsvBalance * BSV_DECIMAL_CONVERSION)
      : sendRecipients.reduce((acc, r) => acc + (r.satoshis ?? 0), 0);

    // Consolidate duplicate addresses by summing satoshis
    const consolidated = new Map<string, number>();
    const addressOrder: string[] = [];
    for (const r of sendRecipients) {
      const addr = r.address ?? r.paymail ?? '';
      consolidated.set(addr, (consolidated.get(addr) ?? 0) + r.satoshis);
      if (!addressOrder.includes(addr)) addressOrder.push(addr);
    }
    const lineItems: SendLineItem[] = addressOrder.map((addr) => ({
      address: addr,
      amount: `${formatNumberWithCommasAndDecimals(consolidated.get(addr)! / BSV_DECIMAL_CONVERSION, 8)} BSV`,
      sats: consolidated.get(addr)!,
      // Payee safety (15 Oct 2026): name, bAvatar, key fingerprint, first payment, look-alike warning.
      payee: payeeNote(identityAddress, addr, pendingMeta(addr)),
    }));

    setSendConfirmation({
      icon: bsvCoin,
      lineItems,
      total: `${formatNumberWithCommasAndDecimals(totalSats / BSV_DECIMAL_CONVERSION, 8)} BSV`,
      totalSats,
      onConfirm: async () => {
        setSendConfirmation(null);
        setIsProcessing(true);

        let sendRes;
        if (isSendAllBsv) {
          const r = sendRecipients[0];
          const destination = r.address ?? r.paymail ?? '';
          // OPL-4696: cancel OrdLock listings before send-all / BSV sweep (fail soft).
          try {
            await cancelOwnedOrdLockListings(apiContext, {
              force: true,
              sessionKey: 'bsv-send-all',
            });
          } catch (err) {
            console.warn('[BsvWallet] OrdLock auto-cancel before sendAll failed', err);
          }
          sendRes = await sendAllBsv.execute(sendContext(), {
            destination,
          });
        } else {
          sendRes = await sendBsv.execute(sendContext(), { requests: sendRecipients });
        }

        if (!sendRes.txid || sendRes.error) {
          addSnackbar(getErrorMessage(sendRes.error), 'error');
          setIsProcessing(false);
          // A refused send may have cleared coins spent on another device: show the corrected balance.
          refreshUtxos().catch((err) => console.error('[handleSendBsv] refresh after failed send:', err));
          return;
        }

        setBsvBalance((prev) => Math.max(0, prev - totalSats / BSV_DECIMAL_CONVERSION));
        rememberSent(identityAddress, addressOrder);
        refreshUtxos().catch((err) => console.error('[handleSendBsv] reconcile refresh failed:', err));
        resetSendState();
        setBsvHistoryRefreshKey((k) => k + 1);
        setPageState('main');
        if (
          !celebrateSend(sendRes, {
            amount: { kind: 'bsv', sats: totalSats },
            recipients: addressOrder,
            rate: exchangeRate,
          })
        ) {
          addSnackbar('Transaction Successful!', 'success');
        }
      },
    });
  };

  // @1sat/actions keeps only error.message, which drops WERR_REVIEW_ACTIONS' per-tx status (owner's $1 send, 17 Oct:
  // "Undelayed createAction or signAction results require review" and nothing else). Put the status into the message.
  const sendContext = () => {
    const wallet = apiContext.wallet;
    const explain =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      async (...a: A) => {
        try {
          return await fn(...a);
        } catch (e) {
          if (e instanceof Error) e.message = describeWalletError(e);
          throw e;
        }
      };
    return {
      ...apiContext,
      wallet: Object.assign(Object.create(wallet), {
        createAction: explain(wallet.createAction.bind(wallet)),
        signAction: explain(wallet.signAction.bind(wallet)),
      }),
    };
  };

  const fillInputWithAllBsv = () => {
    if (!balanceFresh) {
      addSnackbar('Updating balance…', 'info');
      return;
    }
    const maxSats = Math.round(bsvBalance * BSV_DECIMAL_CONVERSION);
    setSatSendAmount(maxSats);
    // MAX is single-recipient only. Preserve the existing recipient's id and
    // address/paymail so we don't wipe the user's input or remount the card.
    setRecipients((prev) => [
      {
        ...(prev[0] ?? {}),
        satSendAmount: maxSats,
        usdSendAmount: null,
        amountType: 'bsv',
        error: undefined,
      },
    ]);
  };

  const getMneeLabel = () => {
    return mneeTotal > 0 ? `Send ${mneeTotal.toFixed(5)} MNEE` : 'Enter Send Details';
  };

  const handleDismissWelcome = async () => {
    await chromeStorageService.update({ showWelcome: false });
    setShowWelcome(false);
  };

  const handleMigrationBannerClick = async () => {
    const { account } = chromeStorageService.getCurrentAccountObject();
    if (account) {
      await chromeStorageService.updateNested('accounts', {
        [account.addresses.identityAddress]: {
          ...account,
          settings: { ...account.settings, sweepStarted: true },
        },
      });
    }
    navigate('/sweep');
  };

  /** Token rows' Lock: one small handler so token locks (feat/token-locks) can swap it out. */
  // Token rows' Lock: the token-lock sheet (locks/TokenLockSheet.tsx).
  const lockToken = (t: Bsv21Balance) => setTokenLock(t);

  const handleTokenClick = (token: Bsv21Balance) => {
    if (token.all.pending > 0n) {
      addSnackbar('Pending tokens cannot be sent!', 'error', 2000);
      return;
    }
    setToken({
      isConfirmed: true,
      info: token,
    });
  };

  /** Fill the given MNEE recipient with (balance - already-assigned - fee). */
  const handleFillMaxMnee = async (id: string) => {
    const assignedElsewhere = mneeRecipients.reduce((acc, r) => (r.id === id ? acc : acc + (r.amount ?? 0)), 0);
    const available = Math.max(0, mneeBalance - assignedElsewhere);

    if (!apiContext?.services?.mnee) {
      updateMneeRecipient(id, 'amount', available);
      return;
    }
    try {
      const config = await apiContext.services.mnee.getConfig();
      const atomicAvailable = MneeClient.toAtomicAmount(available);
      const fee = config.fees.find((f) => atomicAvailable >= f.min && atomicAvailable <= f.max)?.fee || 0;
      updateMneeRecipient(id, 'amount', MneeClient.fromAtomicAmount(Math.max(0, atomicAvailable - fee)));
    } catch {
      updateMneeRecipient(id, 'amount', available);
    }
  };

  // Fetch deposit addresses when entering receive view and sync selected index to primaryAddress
  useEffect(() => {
    if (pageState === 'receive') {
      fetchDepositAddresses().then(() => {
        // Honor the persisted primaryAddress instead of defaulting to index 0
        const { account: acct } = chromeStorageService.getCurrentAccountObject();
        const primary = acct?.primaryAddress;
        if (primary) {
          setDepositAddresses((prev) => {
            const match = prev.find((d) => d.address === primary);
            if (match) {
              setSelectedAddressIndex(match.index);
              setReceiveAddress(match.address);
            }
            return prev;
          });
        }
      });
    }
  }, [pageState, chromeStorageService]);

  const receive = (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      className="flex flex-col items-center w-full pt-14 px-4 overflow-y-auto bw-dock-pad overflow-x-hidden self-start"
      style={{ height: '100%', backgroundColor: theme.color.global.walletBackground }}
    >
      {/* Header row */}
      <div className="flex items-center gap-3 w-full mb-5">
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={() => {
            setPageState('main');
            getAndSetBsvBalance();
          }}
          className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0 border-0 outline-none cursor-pointer"
          style={{ background: '#17191E' }}
        >
          <ArrowLeft size={16} style={{ color: '#FFFFFF' }} />
        </motion.button>
        <h2 className="text-base font-bold tracking-tight flex-1" style={{ color: theme.color.global.contrast }}>
          Receive Assets
        </h2>
      </div>

      {/* Your bAvatar: tap to turn it over to the same address as a pay code (flip bAvatar, 14 Oct 2026). */}
      <div className="mb-4 flex flex-col items-center gap-1">
        <MyFlipBavatar address={receiveAddress} size={144} backSize={200} />
        <span className="text-[11px]" style={{ color: theme.color.global.gray }}>
          Tap your bAvatar to flip it
        </span>
      </div>

      <BetaLine className="mb-3" />

      {/* QR code */}
      <QrCode address={receiveAddress} onClick={handleCopyToClipboard} />

      {/* Address copy row */}
      <motion.button
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.98 }}
        onClick={handleCopyToClipboard}
        className="flex items-center gap-2 mt-5 px-4 py-3 rounded-xl w-full border-0 outline-none cursor-pointer text-left"
        style={{ background: theme.color.global.row }}
      >
        <AnimatePresence mode="wait">
          {copiedAddress ? (
            <motion.div
              key="check"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ duration: 0.18 }}
            >
              <Check size={16} style={{ color: theme.color.component.primaryButtonLeftGradient }} />
            </motion.div>
          ) : (
            <motion.div
              key="copy"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ duration: 0.18 }}
            >
              <Copy size={16} style={{ color: theme.color.global.gray }} />
            </motion.div>
          )}
        </AnimatePresence>
        <span className="text-xs font-mono truncate flex-1" style={{ color: theme.color.global.contrast }}>
          {receiveAddress}
        </span>
        <span className="text-xs shrink-0" style={{ color: theme.color.global.gray }}>
          {copiedAddress ? 'Copied!' : 'Copy'}
        </span>
      </motion.button>

      {/* Info text */}
      <Show
        when={services.ordinals || services.bsv21}
        whenFalseContent={
          <p className="text-xs text-center mt-4 mb-2 max-w-[16rem]" style={{ color: theme.color.global.gray }}>
            You may safely send{' '}
            <span className="font-semibold" style={{ color: theme.color.component.primaryButtonLeftGradient }}>
              Bitcoin SV (BSV)
            </span>{' '}
            to this address.
          </p>
        }
      >
        <p className="text-xs text-center mt-4 mb-2 max-w-[16rem]" style={{ color: theme.color.global.gray }}>
          You may safely send{' '}
          <span className="font-semibold" style={{ color: theme.color.component.primaryButtonLeftGradient }}>
            BSV, MNEE, and Ordinals
          </span>{' '}
          to this address.
        </p>
      </Show>

      {/* Deposit Addresses */}
      {depositAddresses.length > 0 && (
        <div className="w-full mt-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold" style={{ color: theme.color.global.contrast }}>
              My Deposit Addresses
            </h3>
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={handleGenerateAddress}
              disabled={generatingAddress}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[0.65rem] font-semibold border-0 outline-none cursor-pointer"
              style={{
                background: 'rgba(161,255,139,0.12)',
                color: '#A1FF8B',
                opacity: generatingAddress ? 0.5 : 1,
              }}
            >
              {generatingAddress ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
              New Address
            </motion.button>
          </div>

          <div className="flex flex-col gap-1.5">
            {depositAddresses.map((d) => {
              const isSelected = d.index === selectedAddressIndex;
              return (
                <motion.button
                  key={d.index}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => {
                    setSelectedAddressIndex(d.index);
                    setReceiveAddress(d.address);
                    setPrimaryAddress(d.address);
                  }}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-lg w-full border-0 outline-none cursor-pointer text-left"
                  style={{
                    background: isSelected ? 'rgba(161,255,139,0.08)' : theme.color.global.row,
                    border: isSelected ? '1px solid rgba(161,255,139,0.25)' : '1px solid transparent',
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-[0.65rem] font-mono truncate" style={{ color: theme.color.global.contrast }}>
                      {d.address}
                    </p>
                    <p className="text-[0.55rem] mt-0.5" style={{ color: theme.color.global.gray }}>
                      {d.derivationPrefix} {d.derivationSuffix}
                    </p>
                  </div>
                  <motion.div
                    whileTap={{ scale: 0.85 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      copyAddress(d.address);
                    }}
                    className="flex-shrink-0 p-1 rounded"
                    style={{ color: theme.color.global.gray }}
                  >
                    <Copy size={12} />
                  </motion.div>
                </motion.button>
              );
            })}
          </div>
        </div>
      )}
      <OrdinalsAddress />
    </motion.div>
  );

  /** The BSV view (price chart, send): the BSV card's tap, and the top row's price (owner round 7). */
  /**
   * Swap into BSV pays a fresh deposit address of this wallet (tracked by the address manager, so the BSV shows in
   * the balance); falls back to the current receive address.
   */
  const getSwapAddress = async (): Promise<string> => {
    // Android report (10 Oct): "Get deposit address" stayed grey. GENERATE_NEW_ADDRESS can wait on the background's
    // startup or the in-progress lock and never answer, and the fallback read a stale `receiveAddress` from the
    // render that created this function (often still ''). Now: time-boxed, then the latest receive address (ref),
    // then ask the background for it. Empty → SwapFlow shows "Couldn't get your BSV address — try again".
    const withTimeout = <T,>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    try {
      const r = await withTimeout(
        sendMessageAsync<{ success: boolean; data?: { address: string } }>({ action: 'GENERATE_NEW_ADDRESS' }),
        8000,
      );
      if (r?.success && r.data?.address) {
        const fresh = r.data as { address: string; index: number; derivationPrefix: string; derivationSuffix: string };
        setDepositAddresses((prev) => [...prev, fresh]);
        return fresh.address;
      }
    } catch {
      /* fall back below */
    }
    if (receiveAddressRef.current) return receiveAddressRef.current;
    try {
      const r = await withTimeout(
        sendMessageAsync<{ success: boolean; data?: string }>({ action: YoursEventName.GET_RECEIVE_ADDRESS }),
        8000,
      );
      if (r?.success && r.data) return r.data;
    } catch {
      /* reported by SwapFlow */
    }
    return '';
  };

  const openBsvView = () => {
    setSendSource('main');
    setPageState('send');
  };

  const listItemStyle = {
    borderColor: theme.color.global.gray + '14',
  };

  const main = (
    <MainContent>
      <motion.div
        // Phone layout: every card shows at once (no 70 ms-per-card fade-in queue, which on a busy iPhone left
        // only the wallet card visible for a while; owner round 6).
        initial={phoneLayoutOn() ? false : 'hidden'}
        animate="visible"
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.07 } },
        }}
        className="flex flex-col items-center w-full pt-14 pb-16 overflow-y-auto bw-dock-pad"
        style={{ minHeight: '100%' }}
      >
        {/* ── BSV price + Buy BSV (owner, 6 Oct 2026); the migration banner moved below the token buttons ── */}
        {/* One top row for both editions (store parity): the store build swaps Buy BSV for Receive, no Swap card. */}
        <BsvPriceBar
          onReceive={() => void gateReceive(chromeStorageService, () => setPageState('receive'))}
          onPrice={openBsvView}
          getAddress={getSwapAddress}
          bsvSats={Math.round(bsvBalance * 100_000_000)}
          mneeUsd={services.mnee ? mneeBalance : 0}
          tokenCount={bsv21s.length}
        />

        {/* ── Profile avatar ── */}
        <Show when={avatarReady}>
          <motion.div
            variants={{ hidden: { opacity: 0, y: -12 }, visible: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            <motion.img
              whileHover={{ scale: 1.06 }}
              src={avatarUrl}
              className="w-12 h-12 rounded-full object-cover"
              style={{ outline: `2px solid color-mix(in srgb, ${theme.color.component.primaryButtonLeftGradient} 25%, transparent)` }}
              alt="Profile"
            />
          </motion.div>
        </Show>

        {/* ── USD balance ── */}
        <motion.div
          variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="flex flex-col items-center mt-1"
        >
          <div className="flex items-center gap-2">
            {balanceView({ loading: balanceLoading, failed: balanceFailed, known: balanceKnown }) === 'spinner' ? (
              <Loader2 size={28} className="animate-spin" style={{ color: theme.color.global.gray }} />
            ) : balanceView({ loading: balanceLoading, failed: balanceFailed, known: balanceKnown }) === 'unknown' ? (
              <h1
                title="Balance unavailable"
                className="text-4xl font-bold tracking-tight select-none"
                style={{ color: theme.color.global.gray, letterSpacing: '-0.02em' }}
              >
                —
              </h1>
            ) : (
              <h1
                title={isSyncing ? 'Syncing…' : 'Balance'}
                className="text-4xl font-bold tracking-tight select-none"
                style={{ color: theme.color.global.contrast, letterSpacing: '-0.02em' }}
              >
                {formatUSD(bsvBalance * exchangeRate + (services.mnee ? mneeBalance : 0))}
              </h1>
            )}
            <AnimatePresence>
              {isSyncing && !balanceLoading && (
                <motion.div
                  key="sync-spinner"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.2 }}
                  title="Syncing wallet…"
                  className="flex items-center justify-center"
                >
                  <Loader2 size={18} className="animate-spin" style={{ color: theme.color.global.gray }} />
                </motion.div>
              )}
            </AnimatePresence>
            {!balanceLoading && (
              <motion.button
                whileHover={{ opacity: 1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => refreshUtxos({ notifyIfUnchanged: true })}
                disabled={isRefreshing}
                title={upToDate ? 'Up to date' : 'Refresh balances'}
                aria-label={upToDate ? 'Balances are up to date' : 'Refresh balances'}
                className={`flex items-center gap-1.5 border-0 outline-none bg-transparent p-1 cursor-pointer${upToDate ? ' bw-uptodate' : ''}`}
                style={{ color: theme.color.global.gray, opacity: 0.55, transition: 'color 150ms, opacity 150ms' }}
              >
                <RefreshGlyph refreshing={isRefreshing} done={upToDate} />
                {upToDate && <span className="text-sm font-semibold">Up to date</span>}
              </motion.button>
            )}
            {!balanceLoading && (
              <UpToDateAnnouncer done={upToDate} />
            )}
          </div>
          {showSyncRetry({ failed: balanceFailed, known: balanceKnown }) && (
            <button
              type="button"
              onClick={() => void getAndSetBsvBalance()}
              className="mt-1 text-[11px] border-0 bg-transparent cursor-pointer p-0"
              style={{ color: theme.color.global.gray }}
            >
              Still syncing. Tap to retry.
            </button>
          )}
          {staleHint && (
            <p className="mt-1 text-[11px] m-0" style={{ color: theme.color.global.gray, opacity: 0.8 }}>
              {staleHint}
            </p>
          )}
          {restoreMessage && (
            <p role="status" className="mt-1 text-[11px] m-0" style={{ color: theme.color.global.gray }}>
              {restoreMessage}
            </p>
          )}
        </motion.div>

        {/* ── Action buttons ── */}
        <motion.div
          variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
          transition={{ duration: 0.32, ease: 'easeOut' }}
          className="flex items-center gap-4 mt-6 w-[88%]"
        >
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            onClick={() => setPageState('receive')}
            className="flex flex-1 items-center justify-center gap-2 py-3 rounded-2xl font-semibold text-sm border-0 outline-none cursor-pointer"
            style={{
              background: `linear-gradient(135deg, ${theme.color.component.primaryButtonLeftGradient}, ${theme.color.component.primaryButtonRightGradient})`,
              color: theme.color.component.primaryButtonText,
            }}
          >
            <ArrowDownToLine size={16} strokeWidth={2.5} />
            Receive
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            onClick={() => setPageState('asset-picker')}
            className="flex flex-1 items-center justify-center gap-2 py-3 rounded-2xl font-semibold text-sm border-0 outline-none cursor-pointer"
            style={{
              background: `linear-gradient(135deg, ${theme.color.component.primaryButtonLeftGradient}, ${theme.color.component.primaryButtonRightGradient})`,
              color: theme.color.component.primaryButtonText,
            }}
          >
            <ArrowUpFromLine size={16} strokeWidth={2.5} />
            Send
          </motion.button>
        </motion.div>

        {/* ── RelayX account: its collection up top (owner, 17 Oct 2026: a restored RelayX account showed nothing; Run
            NFTs and most RelayX coins aren't in the normal lists). ── */}
        {relayxXpub && (
          <button
            type="button"
            onClick={() => setRelayxOpen(true)}
            className="flex w-[92%] items-center gap-3 rounded-2xl border-0 px-4 py-3.5 mb-3 text-left cursor-pointer active:scale-[0.99] transition-transform"
            style={{ background: 'linear-gradient(135deg, #2669FF, #1B4FD1)', color: '#fff' }}
          >
            <img src={relayxIcon} alt="" width={36} height={36} className="shrink-0 rounded-[9px]" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold">Your RelayX collection</span>
              <span className="block text-[12px] opacity-85">
                Your RelayX NFTs, and BSV on your old RelayX addresses
              </span>
            </span>
            <ArrowRight size={16} className="shrink-0" />
          </button>
        )}

        {/* ── Assets section ── */}
        <motion.div
          variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="w-full mt-6"
        >
          {/* Section header */}
          <div className="flex items-center px-4 mb-2">
            <span
              className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: theme.color.global.gray }}
            >
              Assets
            </span>
            <div className="flex-1 ml-3 h-px opacity-20" style={{ backgroundColor: theme.color.global.gray }} />
          </div>

          <CoinRow id="bsv">
          <TokenSwipe
            id="bsv"
            noArchive
            label="BSV"
            pinned={tokenRows.pinned.includes('bsv')}
            onSend={() => setPageState('send')}
            onReceive={() => void gateReceive(chromeStorageService, () => setPageState('receive'))}
            onChat={() => handleSelect(asMenuItem('chat'))}
            onLock={() => navigate(BSV_LOCK_ROUTE)}
          >
          <AssetRow
            still={!IS_EXTENSION}
            balance={bsvBalance}
            icon={bsvCoin}
            ticker="BSV"
            decimals={8}
            usdBalance={bsvBalance * exchangeRate}
            subline={
              // bWallet: the BSV price, so a moving dollar balance can be read against it (owner, 5 Oct 2026).
              <span className="text-xs mt-0.5" style={{ color: theme.color.global.gray }}>
                {exchangeRate > 0 ? `1 BSV = ${formatUSD(exchangeRate)}` : 'Balance'}
              </span>
            }
            showPointer={true}
            onClick={openBsvView}
            // Empty wallet: "Get BSV" where the balance would be, like Get MNEE / Get PNEEs (owner, 6 Oct 2026).
            action={
              bsvBalance === 0 && BUY_CRYPTO_ENABLED
                ? { label: 'Get BSV', onClick: () => setGetBsvOpen(true) }
                : undefined
            }
          />
          </TokenSwipe>
          </CoinRow>
          {tokenLock && (
            <Suspense fallback={null}>
              <TokenLockSheet
                token={tokenLock}
                onClose={() => setTokenLock(null)}
                onDone={() => void refreshUtxos().then(() => setRandomKey(Math.random()))}
              />
            </Suspense>
          )}
          {BUY_CRYPTO_ENABLED && getBsvOpen && (
            <BuyBsvSheet
              onClose={() => setGetBsvOpen(false)}
              onReceive={() => {
                setGetBsvOpen(false);
                void gateReceive(chromeStorageService, () => setPageState('receive'));
              }}
            />
          )}
          <CoinRow id="mnee">
          <Show when={services.mnee}>
            <TokenSwipe
              id="mnee"
              noArchive
              label="MNEE USD"
              pinned={tokenRows.pinned.includes('mnee')}
              onSend={() => {
                setSendSource('main');
                setPageState('sendMNEE');
              }}
              onReceive={() => void gateReceive(chromeStorageService, () => setPageState('receive'))}
              onChat={() => openHoldersRoom('mnee', () => handleSelect(asMenuItem('chat')))}
              onLock={() => addSnackbar('Locking MNEE isn’t available yet.', 'info', 2500)}
            >
            <AssetRow
              still={!IS_EXTENSION}
              balance={mneeBalance}
              icon={MNEE_ICON_URL}
              ticker="MNEE USD"
              decimals={5}
              usdBalance={mneeBalance}
              showPointer={mneeBalance > 0 || legacyMneeBalance > 0}
              isMNEE
              onGetMneeClick={BUY_CRYPTO_ENABLED ? () => setPageState('getMNEE') : undefined}
              onClick={() => {
                if (legacyMneeBalance > 0) {
                  setShowLegacyMneePrompt(true);
                  return;
                }
                if (mneeBalance > 0) {
                  setSendSource('main');
                  setPageState('sendMNEE');
                }
              }}
            />
            </TokenSwipe>
          </Show>
          </CoinRow>
          <DefaultTokenCards
            onSendToken={(id) => {
              const t = filteredTokens.find((x) => x.id === id);
              if (!t) return addSnackbar('PNEEs can be sent once indexed.', 'info', 2500);
              setSendSource('main');
              handleTokenClick(t);
            }}
            onReceive={() => void gateReceive(chromeStorageService, () => setPageState('receive'))}
            onChat={() => openHoldersRoom('pnee', () => handleSelect(asMenuItem('chat')))}
          />
          <CoinRow id="locks">
          {lockData && (
            <Show when={services.locks && lockData.totalLocked > 0}>
              <AssetRow
                animate
                ticker="Total Locked"
                showPointer={true}
                balance={lockData.totalLocked / BSV_DECIMAL_CONVERSION}
                usdBalance={Number((lockData.unlockable / BSV_DECIMAL_CONVERSION).toFixed(3))}
                icon={lockIcon}
                isLock
                nextUnlock={lockData?.nextUnlock}
                onClick={() => handleSelect('tools', 'pending-locks')}
              />
            </Show>
          )}
          </CoinRow>
        </motion.div>

        {/* ── Favorite tokens ── */}
        <Show when={services.bsv21}>
          <motion.div
            variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="w-full"
          >
            {filteredTokens.length > 0 && (
              <Bsv21TokensList
                key={randomKey}
                hideStatusLabels
                tokens={filteredTokens}
                theme={theme}
                onTokenClick={(t: Bsv21Balance) => {
                  setSendSource('main');
                  handleTokenClick(t);
                }}
                onReceive={() => void gateReceive(chromeStorageService, () => setPageState('receive'))}
                onChat={(t: Bsv21Balance) => openTicketRoomInChat(t.id, handleSelect)}
                onLock={lockToken}
              />
            )}
          </motion.div>
        </Show>

        {/* ── Quick links (Manage Tokens) ── */}
        <Show when={services.bsv21}>
          <motion.div
            variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="w-full mt-4 px-4 flex flex-col gap-2"
          >
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => setManageFavorites(!manageFavorites)}
              className="flex items-center gap-3 w-full px-4 py-3 rounded-xl border text-left cursor-pointer outline-none transition-colors duration-150 bg-[var(--bw-surface)] hover:bg-[#1f2128]"
              style={listItemStyle}
            >
              <List size={16} color={theme.color.global.gray} />
              <span className="text-sm font-semibold" style={{ color: theme.color.global.gray }}>
                Manage Tokens List
              </span>
            </motion.button>
            <FindTokensButton
              style={listItemStyle}
              onFound={() => void refreshUtxos().then(() => setRandomKey(Math.random()))}
            />
            <HiddenTokens tokens={bsv21s} style={listItemStyle} />
          </motion.div>
        </Show>

        {/* Bottom breathing room */}
        <div className="h-4" />
        {/* Owner 17 Oct 2026: old assets must always be findable at the bottom of the wallet, not only when a
            banner decides to show. Two rows: the Yours/old-address migration tool, and the RelayX NFT importer. */}
        <div className="flex flex-col gap-2 w-[92%] mt-2 mb-6">
          <p className="m-0 text-xs font-semibold" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
            Bring in old assets
          </p>
          <button
            type="button"
            data-testid="migration-tool-row"
            onClick={() => void handleMigrationBannerClick()}
            className="flex items-center justify-between gap-2 px-4 py-3 rounded-xl border-0 cursor-pointer text-left"
            style={{ background: 'rgba(253,176,34,0.08)', border: '1px solid rgba(253,176,34,0.2)', color: '#FDB022' }}
          >
            <span className="text-sm">
              <b>Migration tool</b>: {migrationRowText(legacyLeft)}
            </span>
            <ArrowRight size={14} className="shrink-0" />
          </button>
          <button
            type="button"
            onClick={() => setRelayxOpen(true)}
            className="flex items-center justify-between gap-2 px-4 py-3 rounded-xl border-0 cursor-pointer text-left"
            style={{ background: 'rgba(46,144,250,0.10)', border: '1px solid rgba(46,144,250,0.35)', color: '#53B1FD' }}
          >
            <span className="text-sm">
              {relayxXpub ? (
                <>
                  <b>Your RelayX NFTs</b>: this account was restored from RelayX. See its Run NFTs (NPG and more)
                </>
              ) : (
                <>
                  <b>RelayX NFT Collection Importer</b>: find your Run NFTs (NPG and more) from your RelayX words
                </>
              )}
            </span>
            <ArrowRight size={14} className="shrink-0" />
          </button>
        </div>
        <HomeShortcuts />
        {relayxOpen && <RelayxRecoverScreen xpub={relayxXpub} onBack={() => setRelayxOpen(false)} />}

      </motion.div>
    </MainContent>
  );

  // ── Asset picker (opened by the top-level Send button) ──────────────────────
  const pickableAssets: PickableAsset[] = [
    {
      kind: 'bsv',
      ticker: 'BSV',
      icon: bsvCoin,
      balance: bsvBalance,
      usdBalance: bsvBalance * exchangeRate,
    },
    ...(services.mnee
      ? [
          {
            kind: 'mnee' as const,
            ticker: 'MNEE' as const,
            icon: MNEE_ICON_URL,
            balance: mneeBalance,
            usdBalance: mneeBalance,
          },
        ]
      : []),
    ...(services.bsv21
      ? bsv21s
          .filter((t) => t.all.confirmed > 0n)
          .map(
            (t) =>
              ({
                kind: 'bsv21' as const,
                token: t,
                icon: t.icon
                  ? isUri(t.icon)
                    ? t.icon
                    : `${ONESAT_MAINNET_CONTENT_URL}/${t.icon}`
                  : GENERIC_TOKEN_ICON,
              }) as PickableAsset,
          )
      : []),
  ];

  const handleAssetSelected = (asset: PickableAsset) => {
    setSendSource('asset-picker');
    switch (asset.kind) {
      case 'bsv':
        setPageState('send');
        return;
      case 'mnee':
        if (legacyMneeBalance > 0) {
          setShowLegacyMneePrompt(true);
          return;
        }
        setPageState('sendMNEE');
        return;
      case 'bsv21':
        setPageState('main');
        handleTokenClick(asset.token);
        return;
    }
  };

  const assetPickerView = (
    <AssetPicker assets={pickableAssets} onBack={() => setPageState('main')} onSelect={handleAssetSelected} />
  );

  const sendMNEE = (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      className="flex flex-col items-center w-full pt-14 px-4 overflow-y-auto bw-dock-pad overflow-x-hidden self-start"
      style={{ height: '100%', backgroundColor: theme.color.global.walletBackground }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 w-full mb-5">
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={() => {
            setPageState(sendSource);
            resetMneeRecipients();
          }}
          className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0 border-0 outline-none cursor-pointer"
          style={{ background: '#17191E' }}
        >
          <ArrowLeft size={16} style={{ color: '#FFFFFF' }} />
        </motion.button>
        <div className="flex items-center gap-2 flex-1">
          <img src={MNEE_ICON_URL} className="w-6 h-6 rounded-full" alt="MNEE" />
          <h2 className="text-base font-bold tracking-tight" style={{ color: theme.color.global.contrast }}>
            Send MNEE
          </h2>
        </div>
      </div>

      {/* Balance chip (display-only; per-recipient MAX is inside each card) */}
      <div
        className="flex items-center gap-2 px-4 py-2 rounded-full mb-5"
        style={{ background: theme.color.global.row }}
      >
        <img src={MNEE_ICON_URL} alt="MNEE" className="w-4 h-4 rounded-full object-cover flex-shrink-0" />
        <span className="text-xs" style={{ color: theme.color.global.gray }}>
          Balance
        </span>
        <span className="text-sm font-semibold font-mono" style={{ color: theme.color.global.contrast }}>
          {formatNumberWithCommasAndDecimals(mneeBalance, 5)}
        </span>
        <span className="text-xs font-semibold" style={{ color: theme.color.component.primaryButtonLeftGradient }}>
          MNEE
        </span>
      </div>

      {/* Form */}
      <form noValidate onSubmit={(e) => handleSendMNEE(e)} className="flex flex-col items-center w-full gap-3">
        {/* Recipient cards */}
        <AnimatePresence>
          {mneeRecipients.map((recipient, idx) => (
            <motion.div
              key={recipient.id}
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="w-full rounded-2xl p-4 flex flex-col gap-3"
              style={{ background: theme.color.global.row }}
            >
              {/* Card header */}
              <div className="flex items-center justify-between">
                <span
                  className="text-[10px] font-semibold uppercase tracking-widest"
                  style={{ color: theme.color.global.gray }}
                >
                  {mneeRecipients.length > 1 ? `Recipient ${idx + 1}` : 'Recipient'}
                </span>
                {mneeRecipients.length > 1 && (
                  <motion.button
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    type="button"
                    onClick={() => removeMneeRecipient(recipient.id)}
                    className="flex items-center justify-center w-6 h-6 rounded-full border-0 outline-none cursor-pointer"
                    style={{ background: '#ff444415', color: '#ff4444' }}
                  >
                    <Trash2 size={12} />
                  </motion.button>
                )}
              </div>

              {/* Address input */}
              <Input
                theme={theme}
                placeholder="Enter Address"
                type="text"
                onChange={(e) => updateMneeRecipient(recipient.id, 'address', e.target.value)}
                value={recipient.address}
              />

              {/* Amount input + MAX */}
              <div
                className="flex items-center w-[85%] mx-auto rounded-xl border"
                style={{
                  backgroundColor: theme.color.global.row,
                  borderColor: theme.color.global.gray + '40',
                }}
              >
                <input
                  placeholder="Enter MNEE Amount"
                  type="number"
                  step="0.00001"
                  className="flex-1 bg-transparent h-9 px-4 text-sm outline-none border-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
                  style={{
                    color: theme.color.global.contrast,
                    fontFamily: "'Inter', Arial, Helvetica, sans-serif",
                  }}
                  value={recipient.amount !== null && recipient.amount !== undefined ? recipient.amount : ''}
                  onChange={(e) => {
                    const inputValue = e.target.value;
                    updateMneeRecipient(recipient.id, 'amount', inputValue === '' ? null : Number(inputValue));
                  }}
                  onWheel={(e) => {
                    (e.target as HTMLInputElement).blur();
                    e.stopPropagation();
                    setTimeout(() => (e.target as HTMLInputElement).focus(), 0);
                  }}
                />
                {mneeRecipients.length === 1 && (
                  <motion.button
                    whileTap={{ scale: 0.93 }}
                    type="button"
                    onClick={() => handleFillMaxMnee(recipient.id)}
                    className="flex items-center gap-1 px-2.5 py-1.5 mr-1.5 rounded-lg border-0 outline-none cursor-pointer shrink-0"
                    style={{ background: `color-mix(in srgb, ${theme.color.component.primaryButtonLeftGradient} 9%, transparent)` }}
                    title="Fill with available MNEE (minus fee)"
                  >
                    <span
                      className="text-[11px] font-bold"
                      style={{ color: theme.color.component.primaryButtonLeftGradient }}
                    >
                      MAX
                    </span>
                  </motion.button>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Add recipient */}
        <motion.button
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
          type="button"
          onClick={addMneeRecipient}
          className="flex items-center justify-center gap-2 w-full py-3 rounded-2xl border-0 outline-none cursor-pointer"
          style={{
            background: `color-mix(in srgb, ${theme.color.component.primaryButtonLeftGradient} 6%, transparent)`,
            border: `1px dashed color-mix(in srgb, ${theme.color.component.primaryButtonLeftGradient} 25%, transparent)`,
          }}
        >
          <Plus size={14} style={{ color: theme.color.component.primaryButtonLeftGradient }} />
          <span className="text-sm font-semibold" style={{ color: theme.color.component.primaryButtonLeftGradient }}>
            Add Recipient
          </span>
        </motion.button>

        {/* Send button */}
        <Button
          theme={theme}
          type="primary"
          label={getMneeLabel()}
          disabled={
            isProcessing ||
            mneeTotal <= 0 ||
            mneeRecipients.some((r) => !r.address || r.amount === null || r.amount === undefined || r.amount <= 0)
          }
          isSubmit
        />
      </form>

      <CoinHistory
        filter={{
          type: 'mnee',
          addresses: mneeAddresses.length ? mneeAddresses : receiveAddress ? [receiveAddress] : [],
        }}
        refreshKey={mneeHistoryRefreshKey}
      />
    </motion.div>
  );

  const getMnee = (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      className="flex flex-col items-center w-full pt-14 px-4 overflow-y-auto bw-dock-pad overflow-x-hidden self-start"
      style={{ height: '100%', backgroundColor: theme.color.global.walletBackground }}
    >
      {/* Header */}
      <div className="flex items-center w-full mb-5 mt-2">
        <motion.button
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          onClick={() => setPageState('main')}
          className="flex items-center justify-center w-8 h-8 rounded-full border-0 outline-none cursor-pointer mr-3"
          style={{ background: theme.color.global.row, color: theme.color.global.gray }}
        >
          <ArrowLeft size={16} />
        </motion.button>
        <h2 className="text-base font-bold tracking-tight" style={{ color: theme.color.global.contrast }}>
          Get MNEE
        </h2>
      </div>

      {/* Info card */}
      <div className="w-full rounded-2xl p-5 mb-5" style={{ background: theme.color.global.row }}>
        <div className="flex items-center gap-3 mb-3">
          <img src={MNEE_ICON_URL} className="w-10 h-10 rounded-full" alt="MNEE" />
          <div>
            <p className="text-sm font-bold" style={{ color: theme.color.global.contrast }}>
              MNEE Stablecoin
            </p>
            <p className="text-xs" style={{ color: theme.color.global.gray }}>
              1 MNEE = $1.00 USD
            </p>
          </div>
        </div>
        <p className="text-xs leading-relaxed" style={{ color: theme.color.global.gray }}>
          MNEE is the{' '}
          <span className="font-semibold" style={{ color: theme.color.component.primaryButtonLeftGradient }}>
            first USD-backed stablecoin
          </span>{' '}
          on the BSV blockchain. Each token is fully collateralized with US T-bills and cash equivalents.
        </p>
      </div>

      {/* QR code */}
      <QrCode link={MNEE_MOBILE_REFERRAL_LINK} onClick={handleCopyToClipboard} />

      <p className="text-xs font-semibold mt-4 mb-5" style={{ color: theme.color.global.gray }}>
        Scan with your mobile device to get started
      </p>
    </motion.div>
  );

  const send = (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      className="flex flex-col items-center w-full pt-14 px-4 overflow-y-auto bw-dock-pad overflow-x-hidden self-start"
      style={{ height: '100%', backgroundColor: theme.color.global.walletBackground }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 w-full mb-5">
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={() => {
            setPageState(sendSource);
            resetRecipients();
            resetSendState();
          }}
          className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0 border-0 outline-none cursor-pointer"
          style={{ background: '#17191E' }}
        >
          <ArrowLeft size={16} style={{ color: '#FFFFFF' }} />
        </motion.button>
        <div className="flex items-center gap-2 flex-1">
          <h2 className="text-base font-bold tracking-tight" style={{ color: theme.color.global.contrast }}>
            Send BSV
          </h2>
        </div>
      </div>

      {/* Send card (src/mobile/wallet/send): recipient first, dollars first, one clear button. */}
      <SendCard
        theme={theme}
        rows={recipients}
        balanceBsv={bsvBalance}
        rate={exchangeRate}
        sendAll={isSendAllBsv}
        processing={isProcessing}
        account={identityAddress}
        onUpdate={updateRecipient}
        onAdd={addRecipient}
        onRemove={removeRecipient}
        onMax={fillInputWithAllBsv}
        onAmountEdited={() => setSatSendAmount(null)}
        onSubmit={(e) => handleSendBsv(e)}
      />

      {/* Price chart and Buy BSV go BELOW the form (owner, 17 Oct 2026: "No one wants to see the price
          chart when they press send"), so Send opens on who you're paying. */}
      {/* BSV price, last 30 days */}
      <div className="w-full mt-5 mb-5 rounded-2xl p-4" style={{ background: theme.color.global.row }}>
        <BsvPriceChart />
      </div>
      {/* Buy BSV under the chart (owner, 6 Oct 2026). */}
      {BUY_CRYPTO_ENABLED && (
        <BuyBsvButton
          className="w-full mb-5"
          onReceive={() => void gateReceive(chromeStorageService, () => setPageState('receive'))}
        />
      )}


      <div className="w-full px-4">
        <CoinHistory filter={{ type: 'bsv' }} refreshKey={bsvHistoryRefreshKey} />
      </div>
    </motion.div>
  );

  if (showWelcome) {
    return <UpgradeNotification onDismiss={handleDismissWelcome} />;
  }

  return (
    <>
      <TopNav />
      {showBackupPromo && (
        <BackupPromo
          theme={theme}
          keysService={keysService}
          keysAlreadyBackedUp={keysAlreadyBackedUp}
          onKeysBackedUp={async () => {
            setKeysAlreadyBackedUp(true);
            const { account } = chromeStorageService.getCurrentAccountObject();
            if (account) {
              await chromeStorageService.updateNested('accounts', {
                [account.addresses.identityAddress]: {
                  ...account,
                  settings: { ...account.settings, keysBackedUp: true },
                },
              });
            }
          }}
          onDismiss={async () => {
            setShowBackupPromo(false);
            const { account } = chromeStorageService.getCurrentAccountObject();
            if (account) {
              await chromeStorageService.updateNested('accounts', {
                [account.addresses.identityAddress]: {
                  ...account,
                  settings: { ...account.settings, dismissedBackupPromo: true },
                },
              });
            }
          }}
        />
      )}
      <Show when={manageFavorites}>
        <ManageTokens
          onBack={() => {
            setManageFavorites(false);
            // Favorites are already saved; show them now rather than after the balance fetch.
            setAccount(chromeStorageService.getCurrentAccountObject().account);
            getAndSetAccountAndBsv21s();
            setRandomKey(Math.random());
          }}
          tokens={bsv21s}
          theme={theme}
        />
      </Show>
      <Show when={!!token}>
        {token && (
          <SendBsv21View
            token={token}
            onBack={(sentAtomic) => {
              // Optimistic update: if the exit was triggered by a successful send,
              // immediately decrement our cached token balance for this tokenId.
              // We already know the send succeeded — no need to wait on the
              // overlay service to catch up.
              if (sentAtomic && sentAtomic > 0n && token?.info.id) {
                const tokenId = token.info.id;
                setBsv21s((prev) =>
                  prev.map((t) =>
                    t.id === tokenId
                      ? {
                          ...t,
                          all: {
                            ...t.all,
                            confirmed: t.all.confirmed > sentAtomic ? t.all.confirmed - sentAtomic : 0n,
                          },
                        }
                      : t,
                  ),
                );
              }
              setToken(null);
              setPageState(sendSource);
              // Kick off background reconciliation with the authoritative source —
              // fire-and-forget, doesn't block the UI transition.
              Promise.all([getAndSetAccountAndBsv21s(), getAndSetBsvBalance()]).catch((err) =>
                console.error('[SendBsv21View] reconcile refresh failed:', err),
              );
            }}
          />
        )}
      </Show>
      <Show when={isProcessing && pageState === 'main'}>
        <PageLoader theme={theme} message="Loading wallet..." />
      </Show>
      <Show when={isProcessing && pageState === 'send'}>
        <PageLoader theme={theme} message="Sending BSV..." />
      </Show>
      <Show when={isProcessing && pageState === 'sendMNEE'}>
        <PageLoader theme={theme} message="Sending MNEE..." />
      </Show>
      <Show when={!isProcessing && pageState === 'main' && !token && !manageFavorites}>{main}</Show>
      <Show when={!isProcessing && pageState === 'receive'}>{receive}</Show>
      <Show when={!isProcessing && pageState === 'asset-picker'}>{assetPickerView}</Show>
      <Show when={!isProcessing && pageState === 'send'}>{send}</Show>
      <Show when={!isProcessing && pageState === 'sendMNEE'}>{sendMNEE}</Show>
      {BUY_CRYPTO_ENABLED && <Show when={!isProcessing && pageState === 'getMNEE'}>{getMnee}</Show>}
      <SendConfirmation
        show={!!sendConfirmation}
        theme={theme}
        icon={sendConfirmation?.icon}
        lineItems={sendConfirmation?.lineItems ?? []}
        total={sendConfirmation?.total}
        totalSats={sendConfirmation?.totalSats}
        usdPerBsv={exchangeRate}
        isProcessing={isProcessing}
        onConfirm={() => sendConfirmation?.onConfirm()}
        onCancel={() => setSendConfirmation(null)}
      />

      {/* Legacy MNEE sweep prompt */}
      <AnimatePresence>
        {showLegacyMneePrompt && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex items-center justify-center"
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: theme.color.global.walletBackground,
              zIndex: 100,
            }}
          >
            <Show
              when={legacyMneeSweeping}
              whenFalseContent={
                <motion.div
                  initial={{ scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  className="flex flex-col items-center text-center px-6 w-full"
                >
                  <img src={MNEE_ICON_URL} alt="MNEE" className="w-12 h-12 rounded-full mb-4" />
                  <h2 className="text-xl font-bold mb-2" style={{ color: theme.color.global.contrast }}>
                    Legacy MNEE Found
                  </h2>
                  <p className="text-sm mb-2 leading-relaxed" style={{ color: theme.color.global.gray }}>
                    You have{' '}
                    <span className="font-semibold" style={{ color: theme.color.global.contrast }}>
                      $
                      {legacyMneeBalance.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 5,
                      })}{' '}
                      MNEE
                    </span>{' '}
                    at your legacy address. Move it to your new wallet?
                  </p>
                  <p
                    className="text-[0.65rem] font-mono break-all mb-6 cursor-pointer"
                    style={{ color: theme.color.global.gray }}
                    title="Copy legacy address"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(legacyMneeAddress)
                        .then(() => addSnackbar('Legacy address copied!', 'success'));
                    }}
                  >
                    {legacyMneeAddress}
                  </p>
                  <div className="flex items-center gap-3 w-[87%]">
                    <div className="flex-1">
                      <Button
                        theme={theme}
                        type="secondary-outline"
                        label="Later"
                        onClick={() => {
                          setShowLegacyMneePrompt(false);
                          if (mneeBalance > 0) {
                            setSendSource('main');
                            setPageState('sendMNEE');
                          }
                        }}
                      />
                    </div>
                    <div className="flex-1">
                      <Button theme={theme} type="primary" label="Move MNEE" onClick={handleSweepLegacyMnee} />
                    </div>
                  </div>
                </motion.div>
              }
            >
              <PageLoader theme={theme} message={legacyMneeSweepMsg || 'Moving MNEE...'} />
            </Show>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
