import { manifestVersion, settingsBuildInfo } from '../utils/versionLabel';
import { requestThemeSheet } from '../mobile/theme/themeNav';
import { THEME_ORDERS_ENABLED } from '../mobile/storeBuild';
import { AvatarTooBigError } from '../mobile/names/animatedAvatar';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Palette,
  Users,
  UserCircle,
  Shield,
  Key,
  Lock,
  LogOut,
  Database,
  Gauge,
  ChevronLeft,
  ChevronRight,
  Download,
  QrCode as QrCodeIcon,
  HardDrive,
  Pencil,
  Plus,
  Fingerprint,
  Loader2,
  Copy,
  Check,
  Camera,
  AlertTriangle,
  CheckCircle2,
  Minus,
  Usb,
  LifeBuoy,
  Wrench,
  Volume2,
  Radio,
  Receipt,
  Coins,
  Search,
  ScrollText,
  X as XIcon,
  Play,
  Wallet,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { requestIgnoreBattery } from '../mobile/spaces/battery';
import { FaEnvelope } from 'react-icons/fa';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { QrCode } from '../components/QrCode';
import { Show } from '../components/Show';
import { SpeedBump } from '../components/SpeedBump';
import { TopNav } from '../components/TopNav';
import { useBottomMenu } from '../hooks/useBottomMenu';
import { useIdentity, resolveImageUrl } from '../hooks/useIdentity';
import { useTheme } from '../hooks/useTheme';
import { useServiceContext } from '../hooks/useServiceContext';
import { useSignOut } from '../mobile/account/useMenuAccounts';
import { FEE_PER_KB, SUPPORT_EMAIL_URL } from '../utils/constants';
import { ChromeStorageObject, UsbBackupAccountStatus, UsbSecurity } from '../services/types/chromeStorage.types';
import {
  deleteHandle,
  getHandle,
  isUsbSupported,
  listPresentSticks,
  openUsbWindow,
  queryHandlePermission,
  requestHandlePermission,
} from '../services/UsbKey.service';
import { AvatarPicker } from '../components/AvatarPicker';
import { CreateAccount } from './onboarding/CreateAccount';
import { RestoreAccount } from './onboarding/RestoreAccount';
import { ImportAccount } from './onboarding/ImportAccount';
import { MasterBackupProgressEvent, streamDataToZip } from '../utils/masterExporter';
import { accountNamesFor } from '../mobile/names/accountNames';
import { currentAccountBackupName } from '../utils/accountBackupName';
import { useSnackbar } from '../hooks/useSnackbar';
import { ShowSeedWords } from '../components/ShowSeedWords';
import { saveBackupFile, saveRoute } from '../mobile/backup/backupFile';
import { requestSettingsScreen, searchSettings, type SettingsEntry } from '../utils/settingsSearch';
import { PermissionsManager } from './PermissionsManager';
import { StreamingPermissions } from './StreamingPermissions';
import { EnvelopesSettings } from './EnvelopesSettings';
import { ALLOWANCES_ENABLED } from '../services/allowanceFlag';
import { StorageStatus } from './StorageStatus';
import { REPAIR_PHASE_LABELS, useStorageRepair } from '../hooks/useStorageRepair';
import { RECONCILE_RECORD_KEY, type ReconcileOutcome, type ReconcileRecord } from '../services/storageReconcile';
import { YoursIcon } from '../components/YoursIcon';
import activeCircle from '../assets/active-circle.png';
import ProgressBar from '@ramonak/react-progress-bar';

import { derivePasswordKey } from '../services/passKey';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { MAX_LOCK_TIMEOUT_MINUTES, lockTimeoutMinutes } from '../utils/lockTimeout';

const ThemeOrderSheet = THEME_ORDERS_ENABLED ? lazy(() => import('../mobile/themeOrder/ThemeOrderSheet')) : null;

const LOCK_TIMEOUT_CHOICES = [1, 5, 10, 15, 30, 60, 240, 1440];
import { getDisplayCurrency, setDisplayCurrency, type DisplayCurrency } from '../utils/displayCurrency';
import { usePrefs } from '../mobile/settings/usePrefs';
import { sendMessageAsync } from '../utils/chromeHelpers';
import {
  runUsbBackup,
  summariseUsbBackup,
  USB_BACKUP_WARN_BYTES,
  usbBackupEnabled,
  usbBackupTotalBytes,
  wipePendingUsbBackups,
  wipeUsbBackup,
} from '../services/usbBackup';

export type SettingsPage =
  | 'main'
  | 'manage-accounts'
  | 'create-account'
  | 'restore-account'
  | 'import-wif'
  | 'account-list'
  | 'edit-account'
  | 'identity'
  | 'export-keys-options'
  | 'export-keys-qr'
  | 'show-words'
  | 'storage'
  | 'permissions'
  | 'streaming'
  | 'envelopes'
  | 'usb-security'
  | 'troubleshooting';

type DecisionType =
  | 'sign-out'
  | 'export-master-backup'
  | 'export-keys'
  | 'export-keys-qr-code'
  | 'delete-account'
  | 'inscribe-avatar'
  | 'save-profile'
  | 'remove-usb-stick'
  | 'disable-usb-backup';

// --- Animation variants ---
const pageVariants = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.22, ease: 'easeOut' } },
  exit: { opacity: 0, x: -16, transition: { duration: 0.15, ease: 'easeIn' } },
};

const stagger = {
  animate: { transition: { staggerChildren: 0.055 } },
};

const rowVariant = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
};

// --- Sub-components ---

type SettingRowProps = {
  icon: React.ReactNode;
  label: string;
  description?: React.ReactNode;
  right?: React.ReactNode;
  onClick?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  danger?: boolean;
};

const SettingRow = ({ icon, label, description, right, onClick, isFirst, isLast, danger }: SettingRowProps) => {
  return (
    <motion.div
      variants={rowVariant}
      whileTap={onClick ? { scale: 0.985 } : undefined}
      onClick={onClick}
      className={`flex items-center justify-between px-4 py-3 bg-[var(--bw-surface)] ${onClick ? 'cursor-pointer hover:bg-[var(--bw-card2,#1f2128)]' : ''} ${isFirst ? 'rounded-t-xl' : ''} ${isLast ? 'rounded-b-xl' : ''} transition-colors duration-150`}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: danger ? 'rgba(239,68,68,0.15)' : 'rgba(161,255,139,0.1)' }}
        >
          <span style={{ color: danger ? '#ef4444' : '#A1FF8B' }}>{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight truncate" style={{ color: danger ? '#ef4444' : 'var(--bw-text, #FFFFFF)' }}>
            {label}
          </p>
          {description && (
            <p className="text-xs mt-0.5 leading-tight" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
              {description}
            </p>
          )}
        </div>
      </div>
      {right !== undefined ? (
        <div className="flex-shrink-0 ml-3">{right}</div>
      ) : onClick ? (
        <ChevronRight size={16} color="#98A2B3" className="flex-shrink-0 ml-2" />
      ) : null}
    </motion.div>
  );
};

const Divider = () => <div className="h-px mx-4" style={{ backgroundColor: 'rgba(152,162,179,0.1)' }} />;

const formatBackupFreshness = (iso?: string): string => {
  if (!iso) return 'Never backed up';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'Backed up just now';
  if (min < 60) return `Backed up ${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Backed up ${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return `Backed up ${days} day${days === 1 ? '' : 's'} ago`;
};

type SectionProps = {
  title: string;
  children: React.ReactNode;
};

const Section = ({ title, children }: SectionProps) => (
  <motion.div variants={rowVariant} className="w-full mb-4">
    <p className="text-xs font-semibold uppercase tracking-widest mb-2 px-1" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
      {title}
    </p>
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(152,162,179,0.12)' }}>
      {children}
    </div>
  </motion.div>
);

type IdentifierRowProps = {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
};

const IdentifierRow = ({ label, value, copied, onCopy }: IdentifierRowProps) => (
  <motion.div variants={rowVariant} onClick={onCopy} className="w-full cursor-pointer pt-1" title={`Copy ${label}`}>
    <div className="flex items-center justify-center gap-1.5">
      <span className="text-[9px] uppercase tracking-wider" style={{ color: '#475467' }}>
        {label}
      </span>
      <span className="text-[10px] font-mono" style={{ color: '#475467' }}>
        {value.length > 40 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value}
      </span>
      {copied ? <Check size={10} style={{ color: '#34D399' }} /> : <Copy size={10} style={{ color: '#475467' }} />}
    </div>
  </motion.div>
);

type SubPageHeaderProps = {
  title: string;
  onBack: () => void;
};

const SubPageHeader = ({ title, onBack }: SubPageHeaderProps) => (
  <div className="flex items-center gap-3 mb-5 w-full">
    <motion.button
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.92 }}
      onClick={onBack}
      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: '#17191E', border: '1px solid rgba(152,162,179,0.15)' }}
    >
      <ChevronLeft size={18} color="#FFFFFF" />
    </motion.button>
    <h2 className="text-base font-bold" style={{ color: 'var(--bw-text, #FFFFFF)' }}>
      {title}
    </h2>
  </div>
);

const describeTokens = (record: ReconcileRecord): string => {
  const t = record.tokens;
  if (!t) return '';
  const parts: string[] = [];
  if (t.recovered) parts.push(`${t.recovered} token ${t.recovered === 1 ? 'output' : 'outputs'} found`);
  if (t.staleDropped.length)
    parts.push(`${t.staleDropped.length} already-spent token ${t.staleDropped.length === 1 ? 'record' : 'records'} removed`);
  if (t.unseenFixed)
    parts.push(`${t.unseenFixed} token ${t.unseenFixed === 1 ? 'transfer' : 'transfers'} sent to the indexer`);
  return parts.length ? ` · ${parts.join(', ')}` : '';
};

const describeRepair = (record: ReconcileRecord, outcome: ReconcileOutcome): string => {
  if (!record.remoteUrl && record.tokens && outcome !== 'running') return `Tokens checked${describeTokens(record)}`;
  return describeRepairBase(record, outcome) + (outcome === 'running' ? '' : describeTokens(record));
};

const describeRepairBase = (record: ReconcileRecord, outcome: ReconcileOutcome): string => {
  switch (outcome) {
    case 'running':
      return record.phase ? `${REPAIR_PHASE_LABELS[record.phase]}...` : 'Starting...';
    case 'clean':
      return 'Local and remote match';
    case 'differences':
      return 'Finished with differences left';
    case 'failed':
      return `Failed: ${record.error ?? 'unknown error'}`;
  }
};

// --- Main Component ---

// Manifest version reflects what's actually loaded in the browser; the commit hash is
// stamped by vite at build time, so a stale `build/` dir is immediately visible here.
// Nothing time- or environment-dependent is injected, keeping builds reproducible.
// "-dirty" is stripped for users; error reports keep it.
const buildInfo = settingsBuildInfo(manifestVersion(), __BUILD_COMMIT__);

export const Settings = () => {
  const { theme } = useTheme();
  const [appPrefs, setAppPrefs] = usePrefs();
  const { addSnackbar } = useSnackbar();
  const { record: repairRecord, outcome: repairOutcome, runRepair } = useStorageRepair();
  const { query, handleSelect } = useBottomMenu();
  const [showSpeedBump, setShowSpeedBump] = useState(false);
  const [themeOrderOpen, setThemeOrderOpen] = useState(false);
  const { chromeStorageService, keysService, lockWallet, apiContext } = useServiceContext();
  // The USB Security Key page is reachable from two places; back returns to whichever opened it.
  const [usbBackTo, setUsbBackTo] = useState<SettingsPage>('main');
  const [page, setPage] = useState<SettingsPage>(() => {
    if (query === 'manage-accounts') return 'manage-accounts';
    if (query === 'create-account') return 'create-account';
    if (query === 'restore-account') return 'restore-account';
    if (query === 'storage') return 'storage';
    if (query === 'troubleshooting') return 'troubleshooting';
    return 'main';
  });
  const [speedBumpMessage, setSpeedBumpMessage] = useState('');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [decisionType, setDecisionType] = useState<DecisionType | undefined>();
  const identity = useIdentity(apiContext, chromeStorageService);
  const [exportKeysQrData, setExportKeysAsQrData] = useState('');
  const [shouldVisibleExportedKeys, setShouldVisibleExportedKeys] = useState(false);
  const [enteredName, setEnteredName] = useState(identity.profile.name);
  const [enteredImage, setEnteredImage] = useState(identity.profile.image);
  const [enteredDescription, setEnteredDescription] = useState(identity.profile.description);
  const [enteredAccountName, setEnteredAccountName] = useState('');
  const [enteredAccountIcon, setEnteredAccountIcon] = useState('');
  const [copiedBapId, setCopiedBapId] = useState(false);
  const [copiedIdentityKey, setCopiedIdentityKey] = useState(false);
  const [identityPubKey, setIdentityPubKey] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [pendingAvatar, setPendingAvatar] = useState<{ base64: string; mimeType: string; byteSize: number } | null>(
    null,
  );
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [masterBackupProgress, setMasterBackupProgress] = useState(0);
  const [backupSavedText, setBackupSavedText] = useState('');
  const [masterBackupEventText, setMasterBackupEventText] = useState('');
  const [backupInProgress, setBackupInProgress] = useState(false);
  const [backupAccounts, setBackupAccounts] = useState<
    Array<{ name: string; icon: string; status: 'pending' | 'active' | 'done' }>
  >([]);
  const [backupDone, setBackupDone] = useState(false);
  const [backupError, setBackupError] = useState('');
  const currentAccount = chromeStorageService.getCurrentAccountObject();
  const [customFeeRate, setCustomFeeRate] = useState(currentAccount.account?.settings.customFeeRate ?? FEE_PER_KB);
  const [displayCurrency, setDisplayCurrencyState] = useState<DisplayCurrency>(getDisplayCurrency);
  // 0 = Never (the default): chat, Spaces, feed and mail need the wallet to stay open.
  const [lockTimeout, setLockTimeout] = useState(() => lockTimeoutMinutes(currentAccount.account?.settings));
  const [selectedAccountIdentityAddress, setSelectedAccountIdentityAddress] = useState<string | undefined>();

  // --- USB key security ---
  const usbSupported = isUsbSupported();
  const [usbSecurity, setUsbSecurity] = useState<UsbSecurity | undefined>(() => chromeStorageService.getUsbSecurity());
  const [presentSticks, setPresentSticks] = useState<string[]>([]);
  const [uncheckedSticks, setUncheckedSticks] = useState<string[]>([]);
  const [pendingRemoveStickId, setPendingRemoveStickId] = useState<string | undefined>();
  const usbProbing = useRef(false);
  // --- USB backup (OPL-4685) ---
  const [usbBackupStatus, setUsbBackupStatus] = useState<Record<string, UsbBackupAccountStatus> | undefined>(
    () => chromeStorageService.storage?.usbBackupStatus,
  );
  const [usbBackingUp, setUsbBackingUp] = useState(false);
  const usbBackupOn = usbBackupEnabled(usbSecurity);
  const usbBackupSummary = summariseUsbBackup(usbSecurity, usbBackupStatus);
  const usbBackupOverdue = usbBackupOn && usbBackupSummary.some((s) => s.stale);
  const usbBackupBytes = usbBackupTotalBytes(usbBackupStatus);
  const usbBackupLarge = usbBackupOn && usbBackupBytes >= USB_BACKUP_WARN_BYTES;

  const refreshUsbSecurity = useCallback(async () => {
    await chromeStorageService.getAndSetStorage();
    const latest = chromeStorageService.getUsbSecurity();
    setUsbSecurity(latest);
    setUsbBackupStatus(chromeStorageService.storage?.usbBackupStatus);
    if (!latest?.enabled || usbProbing.current) {
      if (!latest?.enabled) {
        setPresentSticks([]);
        setUncheckedSticks([]);
      }
      return;
    }
    usbProbing.current = true;
    try {
      const { present, needPermission } = await listPresentSticks(latest);
      setPresentSticks(present);
      setUncheckedSticks(needPermission);
    } catch {
      setPresentSticks([]);
      setUncheckedSticks([]);
    } finally {
      usbProbing.current = false;
    }
  }, [chromeStorageService]);

  // The USB window writes usbSecurity from another context: follow storage
  // changes and window focus so this page never shows a stale list.
  useEffect(() => {
    if (!usbSupported) return;
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && ('usbSecurity' in changes || 'usbBackupStatus' in changes)) void refreshUsbSecurity();
    };
    const onFocus = () => void refreshUsbSecurity();
    chrome.storage.onChanged.addListener(onChanged);
    window.addEventListener('focus', onFocus);
    return () => {
      chrome.storage.onChanged.removeListener(onChanged);
      window.removeEventListener('focus', onFocus);
    };
  }, [usbSupported, refreshUsbSecurity]);

  // Keep the "Inserted" badge live while the USB page is open.
  useEffect(() => {
    if (page !== 'usb-security' || !usbSupported) return;
    void refreshUsbSecurity();
    const timer = window.setInterval(() => void refreshUsbSecurity(), 2000);
    return () => window.clearInterval(timer);
  }, [page, usbSupported, refreshUsbSecurity]);

  const handleRemoveUsbStickIntent = (stickId: string) => {
    if (!usbSecurity) return;
    if (usbSecurity.sticks.length <= 1) {
      addSnackbar('Add another key first, or turn the USB security key off', 'error');
      return;
    }
    const label = usbSecurity.sticks.find((s) => s.id === stickId)?.label ?? 'this key';
    setPendingRemoveStickId(stickId);
    setSpeedBumpMessage(
      `Remove "${label}"? It will no longer unlock this wallet. Its backup copy is erased now if the key is inserted; otherwise it stays on the drive.`,
    );
    setDecisionType('remove-usb-stick');
    setShowSpeedBump(true);
  };

  const handleRemoveUsbStick = async () => {
    const usb = chromeStorageService.getUsbSecurity();
    const id = pendingRemoveStickId;
    setPendingRemoveStickId(undefined);
    if (!usb || !id || usb.sticks.length <= 1) return;
    try {
      await chromeStorageService.updateUsbSecurity((current) => {
        if (current.sticks.length <= 1) throw new Error('Add another key first, or turn the USB security key off');
        return { ...current, sticks: current.sticks.filter((s) => s.id !== id) };
      });
    } catch (err) {
      addSnackbar(err instanceof Error ? err.message : 'Could not remove the USB key', 'error');
      return;
    }
    // The encrypted wallet copy should not outlive the key's registration
    // when the drive is here to erase it from.
    const handle = await getHandle(id);
    const wiped = !!handle && (await queryHandlePermission(handle)) === 'granted' && (await wipeUsbBackup(handle));
    await deleteHandle(id);
    addSnackbar(wiped === 'removed' ? 'USB key removed and its backup erased' : 'USB key removed', 'success');
    await refreshUsbSecurity();
  };

  const handleUsbBackupNow = async () => {
    if (usbBackingUp) return;
    if (presentSticks.length === 0) {
      addSnackbar('Insert a registered USB key first', 'error');
      return;
    }
    setUsbBackingUp(true);
    let result: Awaited<ReturnType<typeof runUsbBackup>>;
    try {
      result = await runUsbBackup(chromeStorageService);
    } finally {
      setUsbBackingUp(false);
    }
    await refreshUsbSecurity();
    if (!result.ran) addSnackbar('No USB key could be read', 'error');
    else if (result.errors.length > 0) addSnackbar(`USB backup failed: ${result.errors[0]}`, 'error');
    else addSnackbar(result.changed ? 'USB backup updated' : 'USB backup up to date', 'success');
  };

  const handleToggleUsbBackup = async () => {
    if (usbBackupOn) {
      setSpeedBumpMessage(
        'Turn off USB backup? The encrypted wallet copy is erased from your USB keys: inserted keys now, others the next time they are inserted while the wallet is open.',
      );
      setDecisionType('disable-usb-backup');
      setShowSpeedBump(true);
      return;
    }
    try {
      await chromeStorageService.updateUsbSecurity((current) => ({ ...current, backup: { enabled: true } }));
    } catch (err) {
      addSnackbar(err instanceof Error ? err.message : 'Could not update USB backup', 'error');
      return;
    }
    await refreshUsbSecurity();
  };

  const handleDisableUsbBackup = async () => {
    try {
      await chromeStorageService.updateUsbSecurity((current) => ({
        ...current,
        backup: { enabled: false, wipeAt: new Date().toISOString() },
      }));
      // Inserted keys are erased right away; the rest as they turn up.
      await wipePendingUsbBackups(chromeStorageService);
    } catch (err) {
      addSnackbar(err instanceof Error ? err.message : 'Could not turn off USB backup', 'error');
      return;
    }
    await refreshUsbSecurity();
    const usb = chromeStorageService.getUsbSecurity();
    const wipeAt = usb?.backup?.wipeAt ?? '';
    const remaining = usb?.sticks.filter((s) => !s.backupWipedAt || s.backupWipedAt < wipeAt).length ?? 0;
    addSnackbar(
      remaining > 0 ? `USB backup off. ${remaining} key(s) will be erased when inserted` : 'USB backup off and erased',
      'success',
    );
  };

  // React to query deep-links (e.g. clicking "+ Add New Account" in the TopNav
  // wallet switcher while already on the Settings page).
  useEffect(() => {
    if (query === 'manage-accounts') setPage('manage-accounts');
    else if (query === 'create-account') setPage('create-account');
    else if (query === 'restore-account') setPage('restore-account');
    else if (query === 'storage') setPage('storage');
    else if (query === 'troubleshooting') setPage('troubleshooting');
  }, [query]);

  // Identity key comes from the wallet itself, not cached storage. The popup's
  // ChromeCWI sends the admin originator, so this bypasses permission prompts.
  useEffect(() => {
    if (page !== 'identity' || identityPubKey) return;
    apiContext.wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => setIdentityPubKey(publicKey))
      .catch(() => setIdentityPubKey(''));
  }, [page, identityPubKey, apiContext]);

  const handleDeleteAccountIntent = () => {
    setDecisionType('delete-account');
    setSpeedBumpMessage('Are you sure you want to delete this account? All keys and data will be lost.');
    setShowSpeedBump(true);
  };

  const handleSignOutIntent = () => {
    setDecisionType('sign-out');
    setSpeedBumpMessage('Sign this account out of chat and lock the wallet? Your keys stay on this device.');
    setShowSpeedBump(true);
  };

  const handleMasterBackupIntent = () => {
    const accountCount = chromeStorageService.getAllAccounts().length;
    setDecisionType('export-master-backup');
    setSpeedBumpMessage(
      `This will back up ALL ${accountCount} account${accountCount === 1 ? '' : 's'} in your wallet — keys, transactions, and settings. Make sure you are in a safe place.`,
    );
    setShowSpeedBump(true);
  };

  const handleExportKeysIntent = () => {
    setDecisionType('export-keys');
    setSpeedBumpMessage(
      'You are about to download your private keys. Make sure you are in a safe place and no one is watching.',
    );
    setShowSpeedBump(true);
  };

  const handleExportKeysAsQrCodeIntent = () => {
    setDecisionType('export-keys-qr-code');
    setSpeedBumpMessage(
      'You are about to make your private keys visible in QR code format. Make sure you are in a safe place and no one is watching.',
    );
    setShowSpeedBump(true);
  };

  const handleAvatarUpload = async (file: File) => {
    setShowAvatarPicker(false);
    // Show local preview immediately
    setAvatarPreview(URL.createObjectURL(file));
    // Prepare the image (resize) and show cost confirmation
    try {
      const prepared = await identity.prepareAvatar(file);
      setPendingAvatar(prepared);
      const estimatedSats = prepared.byteSize + 200;
      setDecisionType('inscribe-avatar');
      setSpeedBumpMessage(
        `Inscribing your avatar will cost approximately ${estimatedSats.toLocaleString()} sats. Proceed?`,
      );
      setShowSpeedBump(true);
    } catch (e) {
      addSnackbar(e instanceof AvatarTooBigError ? e.message : 'Failed to process image', 'error');
      setAvatarPreview(null);
    }
  };

  const handleAvatarSelectExisting = (url: string) => {
    setShowAvatarPicker(false);
    setEnteredImage(url);
    setAvatarPreview(null);
  };

  const handleConfirmAvatarInscribe = async () => {
    if (!pendingAvatar) return;
    setAvatarUploading(true);
    const res = await identity.inscribeAvatar(pendingAvatar.base64, pendingAvatar.mimeType);
    setAvatarUploading(false);
    setPendingAvatar(null);
    if (res.error) {
      addSnackbar(res.error, 'error');
      setAvatarPreview(null);
    } else if (res.url) {
      setEnteredImage(res.url);
      addSnackbar('Avatar inscribed on-chain', 'success');
    }
  };

  const handleSaveProfile = async () => {
    const res = await identity.saveProfile({
      name: enteredName,
      image: enteredImage,
      description: enteredDescription,
    });
    if (res.error) {
      addSnackbar(res.error, 'error');
    } else {
      addSnackbar('Profile saved on-chain', 'success');
    }
  };

  const handleCopyBapId = () => {
    if (!identity.bapId) return;
    navigator.clipboard.writeText(identity.bapId);
    setCopiedBapId(true);
    setTimeout(() => setCopiedBapId(false), 2000);
  };

  const handleCopyIdentityKey = () => {
    if (!identityPubKey) return;
    navigator.clipboard.writeText(identityPubKey);
    setCopiedIdentityKey(true);
    setTimeout(() => setCopiedIdentityKey(false), 2000);
  };

  const handleAccountEditSave = async () => {
    const accounts = chromeStorageService.getAllAccounts();
    const account = accounts.find((acc) => acc.addresses.identityAddress === selectedAccountIdentityAddress);
    if (!account || !selectedAccountIdentityAddress) return;
    const key: keyof ChromeStorageObject = 'accounts';
    const update: Partial<ChromeStorageObject['accounts']> = {
      [selectedAccountIdentityAddress]: {
        ...account,
        name: enteredAccountName,
        icon: enteredAccountIcon,
      },
    };
    await chromeStorageService.updateNested(key, update);
    setSelectedAccountIdentityAddress(undefined);
    setPage('main');
  };

  const handleDeleteAccount = async () => {
    if (!selectedAccountIdentityAddress) {
      addSnackbar('No account selected', 'error');
      return;
    }
    const res = await chromeStorageService.getAndSetStorage();
    let accounts = chromeStorageService.getAllAccounts();
    if (accounts.length === 1) {
      addSnackbar('You cannot delete your only account', 'error');
      return;
    }
    if (res?.selectedAccount === selectedAccountIdentityAddress) {
      addSnackbar('You cannot delete the currently selected account. Switch to another account first.', 'error');
      return;
    }
    const key: keyof ChromeStorageObject = 'accounts';
    indexedDB.deleteDatabase(`txos-${selectedAccountIdentityAddress}-${chromeStorageService.getNetwork()}`);
    await chromeStorageService.removeNested(key, selectedAccountIdentityAddress);
    await chromeStorageService.getAndSetStorage();
    accounts = chromeStorageService.getAllAccounts();
    await chromeStorageService.switchAccount(accounts[0].addresses.identityAddress);
    setSelectedAccountIdentityAddress(undefined);
    setPage('main');
  };

  useEffect(() => {
    if (identity.loading || identity.error) return;
    setEnteredName(identity.profile.name);
    setEnteredImage(identity.profile.image);
    setEnteredDescription(identity.profile.description);
    setAvatarPreview(null);
  }, [identity.loading, identity.error, identity.profile]);

  const exportKeys = async (password: string) => {
    const keys = await keysService.retrieveKeys(password);

    const keysToExport = {
      mnemonic: keys.mnemonic,
      payPk: keys.walletWif,
      payDerivationPath: keys.walletDerivationPath,
      ordPk: keys.ordWif,
      ordDerivationPath: keys.ordDerivationPath,
      identityPk: keys.identityWif,
      identityDerivationPath: keys.identityDerivationPath,
    };

    // Inside the iOS / Android app an <a download> does nothing (owner, 19 Oct 2026), so the file goes through the
    // same route as the phone's backup file: the OS share sheet in the app, a download in a browser. Either way say
    // what happened.
    const name = currentAccountBackupName(chromeStorageService, 'json');
    const file = new File([JSON.stringify(keysToExport, null, 2)], name, { type: 'application/json' });
    const route = saveRoute(file, Capacitor.isNativePlatform());
    try {
      const saved = await saveBackupFile(file, route);
      if (!saved) addSnackbar('Not saved — try again', 'info');
      else if (route === 'download') addSnackbar(`Saved to Downloads: ${name}`, 'success');
      else addSnackbar(`Saved: ${name}`, 'success');
    } catch {
      addSnackbar("Couldn't save the keys file. Try Show my 12 words instead.", 'error');
    }
  };

  const exportKeysAsQrCode = async (password: string) => {
    const keys = await keysService.retrieveKeys(password);

    const keysToExport = {
      mnemonic: keys.mnemonic,
      payPk: keys.walletWif,
      payDerivationPath: keys.walletDerivationPath,
      ordPk: keys.ordWif,
      ordDerivationPath: keys.ordDerivationPath,
    };

    const jsonData = JSON.stringify(keysToExport, null, 2);
    setExportKeysAsQrData(jsonData);

    setPage('export-keys-qr');
    setShouldVisibleExportedKeys(true);
    setTimeout(() => {
      setShouldVisibleExportedKeys(false);
      setExportKeysAsQrData('');
    }, 10000);
  };

  // Sign out = sign this account out of chat and lock the wallet. It never removes the encrypted keys: that was
  // upstream's chromeStorageService.clear() + SIGNED_OUT (IndexedDB deleted), which on bWalletX Desktop / web
  // made the next visit ask for the 12 words (owner, 9 Oct 2026, D8). Removing a wallet is Forgot password or
  // Delete account, both of which say so.
  const signOutAndLock = useSignOut();
  const signOut = async () => {
    setDecisionType(undefined);
    setShowSpeedBump(false);
    await signOutAndLock(chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress);
  };

  const handleCancel = () => {
    setShowSpeedBump(false);
    setPendingRemoveStickId(undefined);
    if (decisionType === 'inscribe-avatar') {
      setAvatarPreview(null);
      setPendingAvatar(null);
    }
  };

  const handleSpeedBumpConfirm = async (password?: string) => {
    if (decisionType === 'sign-out') {
      signOut();
    }

    if (decisionType === 'delete-account') {
      await handleDeleteAccount();
      setDecisionType(undefined);
      setShowSpeedBump(false);
    }

    if (decisionType === 'export-master-backup' && password) {
      const isVerified = await chromeStorageService.verifyPassword(password);
      if (!isVerified) {
        addSnackbar('Invalid password!', 'error');
        return;
      }
      handleMasterBackup(password);
      setDecisionType(undefined);
      setShowSpeedBump(false);
    }
    if (decisionType === 'export-keys' && password) {
      void exportKeys(password).catch(() => addSnackbar('Wrong password', 'error'));
      setDecisionType(undefined);
      setShowSpeedBump(false);
    }
    if (decisionType === 'export-keys-qr-code' && password) {
      exportKeysAsQrCode(password);
      setDecisionType(undefined);
      setShowSpeedBump(false);
    }
    if (decisionType === 'inscribe-avatar') {
      handleConfirmAvatarInscribe();
      setDecisionType(undefined);
      setShowSpeedBump(false);
    }
    if (decisionType === 'save-profile') {
      handleSaveProfile();
      setDecisionType(undefined);
      setShowSpeedBump(false);
    }
    if (decisionType === 'remove-usb-stick') {
      setDecisionType(undefined);
      setShowSpeedBump(false);
      await handleRemoveUsbStick();
    }
    if (decisionType === 'disable-usb-backup') {
      setDecisionType(undefined);
      setShowSpeedBump(false);
      await handleDisableUsbBackup();
    }
  };

  const commitCustomFeeRate = useCallback(async () => {
    const rate = customFeeRate;
    if (!rate || rate < 1) {
      setCustomFeeRate(currentAccount.account?.settings.customFeeRate ?? FEE_PER_KB);
      if (rate !== undefined && rate < 1) addSnackbar('Fee rate must be at least 1 sat/kb', 'error');
      return;
    }
    const { account, selectedAccount } = chromeStorageService.getCurrentAccountObject();
    if (!account || !selectedAccount) return;
    const key: keyof ChromeStorageObject = 'accounts';
    const update: Partial<ChromeStorageObject['accounts']> = {
      [selectedAccount]: {
        ...account,
        settings: { ...account.settings, customFeeRate: rate },
      },
    };
    await chromeStorageService.updateNested(key, update);
    chrome.runtime.sendMessage({ action: 'UPDATE_FEE_RATE', feeRate: rate }).catch(() => {});
  }, [customFeeRate, chromeStorageService, currentAccount, addSnackbar]);

  const commitLockTimeout = useCallback(
    async (value: number) => {
      const minutes = !value || value < 1 ? 0 : Math.min(Math.floor(value), MAX_LOCK_TIMEOUT_MINUTES);
      setLockTimeout(minutes);
      const { account, selectedAccount } = chromeStorageService.getCurrentAccountObject();
      if (!account || !selectedAccount) return;
      const key: keyof ChromeStorageObject = 'accounts';
      const update: Partial<ChromeStorageObject['accounts']> = {
        [selectedAccount]: {
          ...account,
          settings: { ...account.settings, lockTimeout: minutes, lockTimeoutChosen: true },
        },
      };
      await chromeStorageService.updateNested(key, update);
    },
    [chromeStorageService],
  );

  const handleMasterBackup = async (password?: string) => {
    // Derive here: runtime messages fan out to every open extension page, so
    // the plaintext password never leaves this one. The worker only needs the key.
    const { salt } = chromeStorageService.getCurrentAccountObject();
    const passwordKey = password && salt ? derivePasswordKey(password, salt) : undefined;
    // Populate overlay with all accounts
    const allAccounts = chromeStorageService.getAllAccounts();
    setBackupAccounts(
      allAccounts.map((a) => {
        // The account's $handle, not its placeholder name ("Account 1") (owner, 11 Oct 2026).
        const n = accountNamesFor(a.addresses?.identityAddress, a.name);
        return { name: n.payable ? `$${n.payable}` : n.displayName, icon: a.icon || '', status: 'pending' };
      }),
    );
    setBackupInProgress(true);
    setBackupDone(false);
    setBackupError('');
    setMasterBackupProgress(0);
    setMasterBackupEventText('Preparing backup...');

    let route: ReturnType<typeof saveRoute> = 'download';
    // In the iOS / Android app the file goes to the share sheet; "complete" only once it was really saved.
    const save = (file: File) => {
      route = saveRoute(file, Capacitor.isNativePlatform());
      return saveBackupFile(file, route);
    };
    try {
      const result = await streamDataToZip(
        chromeStorageService,
        (e: MasterBackupProgressEvent) => {
          setMasterBackupEventText(e.message);
          const progress = e.endValue && e.value ? Math.ceil((e.value / e.endValue) * 100) : 0;
          setMasterBackupProgress(progress);

          // Update per-account status based on accountIndex
          if (e.accountIndex !== undefined && e.totalAccounts !== undefined) {
            setBackupAccounts((prev) =>
              prev.map((a, i) => ({
                ...a,
                status: i < e.accountIndex! ? 'done' : i === e.accountIndex! ? 'active' : 'pending',
              })),
            );
          }

          if (e.stage === 'complete') {
            setBackupAccounts((prev) => prev.map((a) => ({ ...a, status: 'done' })));
          }
        },
        passwordKey,
        password,
        save,
      );
      if (!result.saved) {
        setBackupError('Not saved — try again');
        setMasterBackupEventText('Not saved — try again');
        return;
      }
      setBackupSavedText(
        route === 'download' ? `Saved to Downloads: ${result.fileName}` : `Saved: ${result.fileName}`,
      );
      // USB key security enrolment requires a fresh backup this session.
      await chrome.storage.session.set({ usbBackupConfirmedAt: Date.now() });
      setBackupDone(true);
      setMasterBackupEventText('Backup complete!');
      setMasterBackupProgress(100);
      setBackupAccounts((prev) => prev.map((a) => ({ ...a, status: 'done' })));
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setBackupError(msg);
      setMasterBackupEventText(`Backup failed: ${msg}`);
    }
  };

  const dismissBackupOverlay = () => {
    setBackupInProgress(false);
    setBackupDone(false);
    setBackupError('');
    setMasterBackupEventText('');
    setMasterBackupProgress(0);
    setBackupAccounts([]);
  };

  const handleLockWallet = async () => {
    lockWallet();
    handleSelect('bsv');
  };

  // --- Page renders ---

  const mainPage = (
    <motion.div
      key="main"
      variants={stagger}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-20"
    >
      {/* Appearance (owner, 15 Oct 2026): the same Theme sheet the card's sliders icon opens. */}
      <Section title="Appearance">
        <SettingRow
          icon={<Palette size={16} />}
          label="Theme"
          description="App colours and your card design"
          onClick={() => {
            requestThemeSheet();
            handleSelect('bsv');
          }}
          isFirst
          isLast={!(THEME_ORDERS_ENABLED && ThemeOrderSheet)}
        />
        {/* Get your own theme (16 Oct 2026, $99 a year): bWalletX only, a lazy chunk never in a store build. */}
        {THEME_ORDERS_ENABLED && ThemeOrderSheet && (
          <>
            <Divider />
            <SettingRow
              icon={<Palette size={16} />}
              label="Get your own edition"
              description="Your colours and art as a bWalletX theme · $99 a year"
              onClick={() => setThemeOrderOpen(true)}
              isLast
            />
          </>
        )}
      </Section>
      {THEME_ORDERS_ENABLED && ThemeOrderSheet && themeOrderOpen && (
        <Suspense fallback={null}>
          <ThemeOrderSheet onClose={() => setThemeOrderOpen(false)} />
        </Suspense>
      )}

      {/* Account section */}
      <Section title="Account">
        <SettingRow
          icon={<Users size={16} />}
          label="Manage Accounts"
          description="Create, restore, or edit accounts"
          onClick={() => setPage('manage-accounts')}
          isFirst
        />
        <Divider />
        <SettingRow
          icon={<Shield size={16} />}
          label="Permissions"
          description="Review and revoke connected apps and permissions"
          onClick={() => setPage('permissions')}
        />
        <Divider />
        <SettingRow
          icon={<Wallet size={16} />}
          label="Envelopes"
          description="Money set aside for one site's small payments: what is left, Coin return"
          onClick={() => setPage('envelopes')}
          isLast={!ALLOWANCES_ENABLED}
        />
        {/* Streaming grants are allowances: shown only while allowances are on (services/allowanceFlag.ts). */}
        {ALLOWANCES_ENABLED && <Divider />}
        {ALLOWANCES_ENABLED && (
          <SettingRow
            icon={<Play size={16} />}
            label="Streaming permissions"
            description="Sites that stream payments while you watch: spend, Revoke, Pause all"
            onClick={() => setPage('streaming')}
            isLast
          />
        )}
      </Section>

      {/* Recovery phrase (owner, 19 Oct 2026): there was no way to SEE the 12 words. */}
      <Section title="Recovery phrase">
        <SettingRow
          icon={<ScrollText size={16} />}
          label="Show my 12 words"
          description="See this account's recovery phrase. Password needed"
          onClick={() => setPage('show-words')}
          isFirst
          isLast
        />
      </Section>

      {/* Security section */}
      <Section title="Security">
        <SettingRow
          icon={<Key size={16} />}
          label="Wallet Backup"
          description="Backup seed, download JSON, or QR code"
          onClick={() => setPage('export-keys-options')}
          isFirst
          isLast={!usbSupported}
        />
        {usbSupported && (
          <>
            <Divider />
            <SettingRow
              icon={<Usb size={16} />}
              label="USB Security Key"
              description={
                usbSecurity?.enabled
                  ? `${usbSecurity.sticks.length} key${usbSecurity.sticks.length === 1 ? '' : 's'} registered${usbBackupOverdue ? ' · backup overdue' : ''}`
                  : 'Two-factor unlock with any USB drive'
              }
              right={
                usbBackupOverdue ? (
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle size={14} style={{ color: '#FBBF24' }} />
                    <ChevronRight size={16} color="#98A2B3" />
                  </div>
                ) : undefined
              }
              onClick={() => {
                setUsbBackTo('main');
                setPage('usb-security');
              }}
              isLast
            />
          </>
        )}
      </Section>

      {/* Preferences section */}
      <Section title="Preferences">
        <SettingRow
          icon={<Fingerprint size={16} />}
          label="Posting profile"
          description="Your on-chain name and photo that sign your posts"
          onClick={() => setPage('identity')}
          isFirst
        />
        <Divider />
        <SettingRow
          icon={<Gauge size={16} />}
          label="Custom Fee Rate"
          description="Default: 100 sat/kb"
          right={
            <Input
              theme={theme}
              placeholder="100"
              type="number"
              onChange={(e) => setCustomFeeRate(Number(e.target.value))}
              onBlur={() => commitCustomFeeRate()}
              value={customFeeRate}
              style={{ width: '5rem', margin: 0 }}
            />
          }
        />
        <Divider />
        <SettingRow
          icon={<Lock size={16} />}
          label="Auto-lock"
          description="Lock anytime with ⌘L or the menu."
          right={
            <select
              aria-label="Auto-lock"
              value={lockTimeout}
              onChange={(e) => void commitLockTimeout(Number(e.target.value))}
              style={{ border: '1px solid #444', borderRadius: 8, padding: '4px 6px' }}
            >
              <option value={0}>Never (recommended)</option>
              {[...new Set([...LOCK_TIMEOUT_CHOICES, ...(lockTimeout ? [lockTimeout] : [])])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    After {m} minute{m === 1 ? '' : 's'}
                  </option>
                ))}
            </select>
          }
        />
        <Divider />
        {Capacitor.getPlatform() === 'android' && (
          <>
            <SettingRow
              icon={<Radio size={16} />}
              label="Spaces with the screen off"
              description="Let bWalletX keep a live Space running when the screen sleeps"
              onClick={() => void requestIgnoreBattery()}
            />
            <Divider />
          </>
        )}
        <SettingRow
          icon={<Volume2 size={16} />}
          label="Sounds"
          description="Play a chime when a payment is sent"
          right={
            <ToggleSwitch
              theme={theme}
              on={appPrefs.sounds}
              onChange={() => setAppPrefs({ sounds: !appPrefs.sounds })}
            />
          }
        />
        <Divider />
        <SettingRow
          icon={<Coins size={16} />}
          label="Currency"
          description="Show amounts in (payments are unchanged)"
          right={
            <select
              aria-label="Display currency"
              value={displayCurrency}
              onChange={(e) => {
                const c: DisplayCurrency = e.target.value === 'GBP' ? 'GBP' : 'USD';
                setDisplayCurrency(c);
                setDisplayCurrencyState(c);
              }}
              style={{ border: '1px solid #444', borderRadius: 8, padding: '4px 6px' }}
            >
              <option value="USD">US dollar ($)</option>
              <option value="GBP">British pound (£)</option>
            </select>
          }
        />
        <Divider />
        <SettingRow
          icon={<Receipt size={16} />}
          label="Tax reports"
          description="Rules for History › Gains (not tax advice)"
          right={
            <select
              aria-label="Tax rules"
              value={appPrefs.taxCountry}
              onChange={(e) => setAppPrefs({ taxCountry: e.target.value === 'other' ? 'other' : 'uk' })}
              style={{ border: '1px solid #444', borderRadius: 8, padding: '4px 6px' }}
            >
              <option value="uk">UK (HMRC pooling, GBP)</option>
              <option value="other">Other (FIFO, USD)</option>
            </select>
          }
          isLast
        />
      </Section>

      {/* Help section */}
      <Section title="Help">
        <SettingRow
          icon={<LifeBuoy size={16} />}
          label="Troubleshooting"
          description="Repair sync, repair log, and support"
          onClick={() => setPage('troubleshooting')}
          isFirst
          isLast
        />
      </Section>

      {/* Danger Zone */}
      <Section title="Danger Zone">
        <SettingRow
          icon={<Lock size={16} />}
          label="Lock Wallet"
          description="Immediately lock the wallet"
          onClick={handleLockWallet}
          isFirst
          isLast
        />
        <Divider />
        <SettingRow
          icon={<LogOut size={16} />}
          label="Sign Out"
          description="Sign out of chat and lock the wallet. Your keys stay on this device"
          onClick={handleSignOutIntent}
          isFirst
          isLast
          danger
        />
      </Section>

      {/* Build info footer — click to copy for bug reports */}
      <div
        className="mt-6 text-center text-xs cursor-pointer select-none"
        style={{ color: theme.color.global.gray }}
        title="Click to copy build info"
        onClick={() => {
          navigator.clipboard.writeText(buildInfo);
          addSnackbar('Build info copied', 'success');
        }}
      >
        {buildInfo}
      </div>
    </motion.div>
  );

  const [missingTokenId, setMissingTokenId] = useState('');
  const missingTokenValid = /^[0-9a-f]{64}[._]\d+$/i.test(missingTokenId.trim());

  const handleRepairSync = async (tokenIds?: string[]) => {
    if (repairOutcome === 'running') return;
    // Once a run starts, the overlay shows its result; only a refusal before
    // that (no remote, wallet unavailable) needs a snackbar.
    const before = repairRecord?.startedAt;
    try {
      const response = await runRepair(tokenIds);
      const recovered = response?.data?.tokensRecovered ?? 0;
      const dropped = response?.data?.staleDropped ?? 0;
      if (recovered > 0 || dropped > 0) {
        const parts = [
          recovered > 0 ? `found ${recovered} token ${recovered === 1 ? 'output' : 'outputs'} this wallet had missed` : '',
          dropped > 0 ? `removed ${dropped} already-spent token ${dropped === 1 ? 'record' : 'records'}` : '',
        ].filter(Boolean);
        const text = parts.join(', ');
        addSnackbar(text.charAt(0).toUpperCase() + text.slice(1), 'success');
      } else if (response?.success && response.data?.noRemote) {
        addSnackbar('Tokens checked: nothing to fix', 'success');
      }
      if (response?.success) return;
      const after = (await chrome.storage.local.get(RECONCILE_RECORD_KEY))[RECONCILE_RECORD_KEY] as
        | ReconcileRecord
        | undefined;
      if (after?.startedAt === before) addSnackbar(response?.error ?? 'Repair failed', 'error');
    } catch (error) {
      addSnackbar(error instanceof Error ? error.message : 'Repair failed', 'error');
    }
  };

  // Live step + elapsed seconds for the two recovery buttons (owner, 15 Oct 2026: "Checking…" forever).
  const [recoverStep, setRecoverStep] = useState<{ mined?: string; txid?: string }>({});
  const [recoverStartedAt, setRecoverStartedAt] = useState<{ mined?: number; txid?: number }>({});
  const [, setTick] = useState(0);
  useEffect(() => {
    const onMsg = (m: { action?: string; data?: { kind?: 'mined' | 'txid'; step?: string } }) => {
      if (m?.action !== 'RECOVER_PROGRESS' || !m.data?.kind) return;
      const { kind, step } = m.data;
      setRecoverStep((p) => ({ ...p, [kind]: step }));
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  useEffect(() => {
    if (!recoverStartedAt.mined && !recoverStartedAt.txid) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [recoverStartedAt]);
  const elapsed = (k: 'mined' | 'txid') =>
    recoverStartedAt[k] ? ` (${Math.floor((Date.now() - recoverStartedAt[k]!) / 1000)} s)` : '';
  const [recoverFailedMined, setRecoverFailedMined] = useState(false);
  const [recoverFailedTxid, setRecoverFailedTxid] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverResult, setRecoverResult] = useState('');
  const handleRecoverMined = async () => {
    if (recovering) return;
    setRecovering(true);
    setRecoverResult('');
    setRecoverFailedMined(false);
    setRecoverStep((p) => ({ ...p, mined: 'Starting…' }));
    setRecoverStartedAt((p) => ({ ...p, mined: Date.now() }));
    try {
      const r = await sendMessageAsync<{ success: boolean; error?: string; data?: { summary?: string } }>({
        action: 'STORAGE_RECOVER_MINED',
      });
      const text = r?.data?.summary ?? r?.error ?? 'No answer from the wallet. Try again.';
      setRecoverResult(text);
      setRecoverFailedMined(!r?.success);
      addSnackbar(text, r?.success ? 'success' : 'error');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Check failed';
      setRecoverResult(text);
      setRecoverFailedMined(true);
      addSnackbar(text, 'error');
    } finally {
      setRecovering(false);
      setRecoverStartedAt((p) => ({ ...p, mined: undefined }));
    }
  };

  const [recoverTxid, setRecoverTxid] = useState('');
  const [recoveringTxid, setRecoveringTxid] = useState(false);
  const [recoverTxidResult, setRecoverTxidResult] = useState('');
  const handleRecoverTxid = async () => {
    if (recoveringTxid) return;
    setRecoveringTxid(true);
    setRecoverTxidResult('');
    setRecoverFailedTxid(false);
    setRecoverStep((p) => ({ ...p, txid: 'Starting…' }));
    setRecoverStartedAt((p) => ({ ...p, txid: Date.now() }));
    try {
      const r = await sendMessageAsync<{ success: boolean; error?: string; data?: { summary?: string } }>({
        action: 'STORAGE_RECOVER_TXID',
        txid: recoverTxid.trim(),
      });
      const text = r?.data?.summary ?? r?.error ?? 'No answer from the wallet. Try again.';
      setRecoverTxidResult(text);
      setRecoverFailedTxid(!r?.success && !/not mined|isn’t|belongs|already/i.test(text));
      addSnackbar(text, r?.success ? 'success' : 'error');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Check failed';
      setRecoverTxidResult(text);
      setRecoverFailedTxid(true);
      addSnackbar(text, 'error');
    } finally {
      setRecoveringTxid(false);
      setRecoverStartedAt((p) => ({ ...p, txid: undefined }));
    }
  };

  // Resync coins (owner, 17 Oct 2026): clear coins spent from another device, so sends stop failing UTXO_SPENT.
  const [resyncing, setResyncing] = useState(false);
  const [resyncResult, setResyncResult] = useState('');
  const handleResyncCoins = async () => {
    if (resyncing) return;
    setResyncing(true);
    setResyncResult('');
    setRecoverStep((p) => ({ ...p, txid: 'Starting…' }));
    try {
      const r = await sendMessageAsync<{ success: boolean; error?: string; data?: { summary?: string } }>({
        action: 'STORAGE_RESYNC_COINS',
      });
      const text = r?.data?.summary ?? r?.error ?? 'No answer from the wallet. Try again.';
      setResyncResult(text);
      addSnackbar(text, r?.success ? 'success' : 'error');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Resync failed';
      setResyncResult(text);
      addSnackbar(text, 'error');
    } finally {
      setResyncing(false);
    }
  };

  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState('');
  const handleRestoreBackup = async () => {
    if (restoring) return;
    setRestoring(true);
    setRestoreResult('');
    try {
      const r = await sendMessageAsync<{ success: boolean; error?: string; data?: { summary?: string } }>({
        action: 'STORAGE_RESTORE_BACKUP',
      });
      const text = r?.data?.summary ?? r?.error ?? 'Nothing to restore';
      setRestoreResult(text);
      addSnackbar(text, r?.success ? 'success' : 'error');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Restore failed';
      setRestoreResult(text);
      addSnackbar(text, 'error');
    } finally {
      setRestoring(false);
    }
  };

  const handleCopyRepairLog = () => {
    if (!repairRecord) return;
    navigator.clipboard.writeText(JSON.stringify(repairRecord, null, 2));
    addSnackbar('Repair log copied', 'success');
  };

  const troubleshootingPage = (
    <motion.div
      key="troubleshooting"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-20"
    >
      <SubPageHeader title="Troubleshooting" onBack={() => setPage('main')} />
      <motion.div variants={stagger} initial="initial" animate="animate" className="w-full">
        <Section title="Storage">
          <SettingRow
            icon={<Wrench size={16} />}
            label={repairOutcome === 'running' ? 'Repairing...' : 'Repair Sync'}
            description="Check local and remote storage against each other and fix differences"
            onClick={repairOutcome === 'running' ? undefined : () => void handleRepairSync()}
            isFirst
            isLast={false}
          />
          <Divider />
          <SettingRow
            icon={<Wrench size={16} />}
            label={recovering ? `${recoverStep.mined ?? 'Checking…'}${elapsed('mined')}` : recoverFailedMined ? 'Find mined payments · Try again' : 'Find mined payments'}
            description={
              recoverResult ||
              'Money sent or swept that is on chain but not showing (an interrupted send or sweep): check and restore it'
            }
            onClick={recovering ? undefined : () => void handleRecoverMined()}
            isLast={false}
          />
          <Divider />
          <SettingRow
            icon={<Wrench size={16} />}
            label={restoring ? 'Loading your wallet from backup…' : 'Restore from backup'}
            description={
              restoreResult ||
              'New device missing your balance or history? Copy everything from your backup and bring back paymail payments'
            }
            onClick={restoring ? undefined : () => void handleRestoreBackup()}
            isLast={false}
          />
          <Divider />
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-sm font-semibold">Find a missing token</span>
            <span className="text-xs opacity-70">
              A token you hold doesn&apos;t show? Paste its token ID (txid_0). The wallet follows that token from its
              start and adds any outputs that belong to you.
            </span>
            <div className="flex gap-2">
              <Input
                theme={theme}
                id="missing-token-id"
                placeholder="Token ID"
                value={missingTokenId}
                onChange={(e) => setMissingTokenId(e.target.value)}
                style={{ flex: 1, margin: 0 }}
              />
              <Button
                theme={theme}
                type="primary"
                label="Search"
                disabled={!missingTokenValid || repairOutcome === 'running'}
                onClick={() => void handleRepairSync([missingTokenId.trim()])}
              />
            </div>
          </div>
          <Divider />
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-sm font-semibold">Resync coins</span>
            <span className="text-xs opacity-70">
              {resyncing
                ? recoverStep.txid ?? 'Checking…'
                : resyncResult ||
                'Sends failing with “UTXO_SPENT” or “already spent”? Coins were spent somewhere else (another device with the same words). This checks each coin on chain and clears only the ones proven spent.'}
            </span>
            <Button
              theme={theme}
              type="secondary"
              label={resyncing ? 'Checking…' : 'Resync coins'}
              disabled={resyncing}
              onClick={() => void handleResyncCoins()}
            />
          </div>
          <Divider />
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-sm font-semibold">Recover a payment by transaction ID</span>
            <span
              className={
                !recoveringTxid && /^(Checked|Restored|Found)/.test(recoverTxidResult ?? '')
                  ? 'text-xs font-semibold'
                  : 'text-xs opacity-70'
              }
              style={
                !recoveringTxid && /^(Checked|Restored|Found)/.test(recoverTxidResult ?? '')
                  ? { color: '#22c55e' }
                  : undefined
              }
            >
              {recoveringTxid
                ? `${recoverStep.txid ?? 'Checking…'}${elapsed('txid')}`
                : recoverTxidResult ||
                'Money on chain that never showed up here (a sweep or send from this wallet)? Paste the transaction ID. Only coins this wallet’s records prove are yours are added.'}
            </span>
            <div className="flex gap-2">
              <Input
                theme={theme}
                id="recover-txid"
                placeholder="Transaction ID"
                value={recoverTxid}
                onChange={(e) => setRecoverTxid(e.target.value)}
                style={{ flex: 1, margin: 0 }}
              />
              <Button
                theme={theme}
                type="primary"
                label={recoveringTxid ? 'Checking…' : recoverFailedTxid ? 'Try again' : 'Recover'}
                disabled={!/^[0-9a-fA-F]{64}$/.test(recoverTxid.trim()) || recoveringTxid}
                onClick={() => void handleRecoverTxid()}
              />
            </div>
          </div>
          {repairRecord && repairOutcome && (
            <>
              <Divider />
              <SettingRow
                icon={<Copy size={16} />}
                label="Copy Repair Log"
                description={
                  <>
                    {describeRepair(repairRecord, repairOutcome)}
                    <br />
                    {`${repairRecord.trigger === 'migration' ? 'After update' : 'Manual'} · ${new Date(
                      repairRecord.finishedAt ?? repairRecord.startedAt,
                    ).toLocaleString()}`}
                  </>
                }
                onClick={handleCopyRepairLog}
                isLast
              />
            </>
          )}
        </Section>

        <Section title="Support">
          <SettingRow
            icon={<FaEnvelope size={16} />}
            label="Email support"
            description="support@bwalletx.com. Paste your repair log if sync looks wrong."
            onClick={() => window.open(SUPPORT_EMAIL_URL, '_blank')}
            isFirst
            isLast
          />
        </Section>
      </motion.div>
    </motion.div>
  );

  const manageAccountsPage = (
    <motion.div
      key="manage-accounts"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-4"
    >
      <SubPageHeader title="Manage Accounts" onBack={() => setPage('main')} />
      <motion.div variants={stagger} initial="initial" animate="animate" className="w-full">
        <Section title="Actions">
          {/* One Add account screen: New account on top, then restore / import (owner, 10 Oct 2026). */}
          <SettingRow
            icon={<Plus size={16} />}
            label="Add account"
            description="New, or restore from 12 words or a backup"
            onClick={() => setPage('restore-account')}
            isFirst
          />
          <Divider />
          <SettingRow
            icon={<Pencil size={16} />}
            label="Edit Account"
            description="Edit an existing account"
            onClick={() => setPage('account-list')}
            isLast
          />
        </Section>
      </motion.div>
    </motion.div>
  );

  const exportKeysAsQrCodePage = (
    <motion.div
      key="export-keys-qr"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-4"
    >
      <SubPageHeader title="Keys as QR Code" onBack={() => setPage('main')} />
      {shouldVisibleExportedKeys ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-4"
        >
          <div
            className="p-4 rounded-2xl"
            style={{
              backgroundColor: '#17191E',
              border: '1px solid rgba(152,162,179,0.15)',
            }}
          >
            <QrCode address={exportKeysQrData} />
          </div>
          <p className="text-xs text-center" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
            This QR code will disappear in 10 seconds.
          </p>
        </motion.div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-8">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{ backgroundColor: 'rgba(239,68,68,0.12)' }}
          >
            <QrCodeIcon size={22} color="#ef4444" />
          </div>
          <p className="text-sm" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
            Timed out. Please try again.
          </p>
        </div>
      )}
    </motion.div>
  );

  const exportKeyOptionsPage = (
    <motion.div
      key="export-keys-options"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-4"
    >
      <SubPageHeader title="Wallet Backup" onBack={() => setPage('main')} />
      <motion.div variants={stagger} initial="initial" animate="animate" className="w-full space-y-4">
        {/* Remote Backup — featured card */}
        <motion.div variants={rowVariant}>
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={() => setPage('storage')}
            className="w-full rounded-xl p-4 text-left border-0 outline-none cursor-pointer"
            style={{
              background: 'linear-gradient(135deg, rgba(161,255,139,0.08), rgba(52,211,153,0.04))',
              border: '1px solid rgba(161,255,139,0.15)',
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: 'rgba(161,255,139,0.12)' }}
              >
                <Database size={18} color="#A1FF8B" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold" style={{ color: 'var(--bw-text, #FFFFFF)' }}>
                  Remote Backup
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
                  Your wallet is automatically backed up. Manage storage, upgrade, or change providers.
                </p>
              </div>
              <ChevronRight size={16} style={{ color: 'var(--bw-muted, #98A2B3)' }} />
            </div>
          </motion.button>
        </motion.div>

        {/* Manual backup options */}
        <Section title="Manual Backup">
          <motion.div variants={rowVariant}>
            <SettingRow
              icon={<ScrollText size={16} />}
              label="Show my 12 words"
              description="See this account's recovery phrase to write down"
              onClick={() => setPage('show-words')}
              isFirst
            />
          </motion.div>
          <Divider />
          <motion.div variants={rowVariant}>
            <SettingRow
              icon={<HardDrive size={16} />}
              label="Master Backup"
              description={`Back up all ${chromeStorageService.getAllAccounts().length} account${chromeStorageService.getAllAccounts().length === 1 ? '' : 's'} — keys, transactions, and settings`}
              onClick={handleMasterBackupIntent}
            />
          </motion.div>
          {usbSupported && (
            <>
              <Divider />
              <SettingRow
                icon={<Usb size={16} />}
                label="USB Security Key"
                description={
                  usbSecurity?.enabled
                    ? usbBackupOn
                      ? `Encrypted copy kept on ${usbSecurity.sticks.length} key${usbSecurity.sticks.length === 1 ? '' : 's'}${usbBackupOverdue ? ' · backup overdue' : ''}`
                      : 'USB backup is off'
                    : 'Two-factor unlock with an encrypted copy on each key'
                }
                right={
                  usbBackupOverdue ? (
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle size={14} style={{ color: '#FBBF24' }} />
                      <ChevronRight size={16} color="#98A2B3" />
                    </div>
                  ) : undefined
                }
                onClick={() => {
                  setUsbBackTo('export-keys-options');
                  setPage('usb-security');
                }}
              />
            </>
          )}
          <Divider />
          <SettingRow
            icon={<Download size={16} />}
            label="Download Keys"
            description="Download seed, private, and public keys as JSON"
            onClick={handleExportKeysIntent}
          />
          <Divider />
          <SettingRow
            icon={<QrCodeIcon size={16} />}
            label="Export as QR Code"
            description="Display private keys as QR code for mobile import"
            onClick={handleExportKeysAsQrCodeIntent}
            isLast
          />
        </Section>
      </motion.div>
    </motion.div>
  );

  const avatarSrc = avatarPreview || (enteredImage ? resolveImageUrl(enteredImage, apiContext) : '');

  const identityPage = (
    <motion.div
      key="identity"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-24"
    >
      <SubPageHeader title="Posting profile" onBack={() => setPage('main')} />

      {identity.loading && !identity.bapId ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={24} className="animate-spin" style={{ color: 'var(--bw-muted, #98A2B3)' }} />
        </div>
      ) : (
        <motion.div variants={stagger} initial="initial" animate="animate" className="w-full space-y-3">
          {/* Intro text for first-time users */}
          {!identity.isPublished && (
            <motion.p
              variants={rowVariant}
              className="text-xs text-center"
              style={{ color: 'var(--bw-muted, #98A2B3)', lineHeight: 1.5 }}
            >
              Set up your posting profile so apps and other users can recognize you. Your profile is stored permanently
              on the blockchain.
            </motion.p>
          )}

          {/* Avatar — tap to pick */}
          <motion.div variants={rowVariant} className="flex flex-col items-center">
            <button
              onClick={() => setShowAvatarPicker(true)}
              className="relative cursor-pointer group"
              disabled={avatarUploading}
            >
              <div
                className="w-20 h-20 rounded-full overflow-hidden flex items-center justify-center"
                style={{
                  background: avatarSrc ? undefined : 'linear-gradient(135deg, #A1FF8B, #34D399)',
                  border: '2px solid rgba(161,255,139,0.3)',
                }}
              >
                {avatarSrc ? (
                  <img src={avatarSrc} className="w-full h-full object-cover" alt="Avatar" />
                ) : (
                  <UserCircle size={36} color="#010101" />
                )}
                {avatarUploading && (
                  <div className="absolute inset-0 rounded-full flex items-center justify-center bg-black/60">
                    <Loader2 size={20} className="animate-spin" style={{ color: 'var(--bw-text, #fff)' }} />
                  </div>
                )}
              </div>
              <div
                className="absolute -bottom-0.5 -right-0.5 w-6 h-6 rounded-full flex items-center justify-center"
                style={{ background: '#1D2939', border: '2px solid #010101' }}
              >
                <Camera size={12} style={{ color: '#D0D5DD' }} />
              </div>
            </button>
            <p className="text-[10px] mt-1.5" style={{ color: '#667085' }}>
              Tap to change
            </p>
          </motion.div>

          {/* Name */}
          <motion.div variants={rowVariant} className="w-full">
            <Input
              theme={theme}
              placeholder="Your name"
              type="text"
              onChange={(e) => setEnteredName(e.target.value)}
              value={enteredName}
            />
          </motion.div>

          {/* Bio */}
          <motion.div variants={rowVariant} className="w-full">
            <Input
              theme={theme}
              placeholder="A short bio..."
              type="text"
              onChange={(e) => setEnteredDescription(e.target.value)}
              value={enteredDescription}
            />
          </motion.div>

          {identity.error && (
            <p className="text-xs text-center" style={{ color: '#F97066' }}>
              {identity.error}
            </p>
          )}

          {/* Save */}
          <motion.div variants={rowVariant} className="w-full pb-6">
            <Button
              theme={theme}
              type="primary"
              label={identity.isPublished ? 'Update Profile' : 'Create Posting Profile'}
              onClick={handleSaveProfile}
              loading={identity.loading}
              disabled={avatarUploading}
            />
            <p className="text-[10px] text-center mt-1.5" style={{ color: '#667085' }}>
              This will broadcast a small transaction
            </p>
          </motion.div>

          {identity.bapId && identity.isPublished && (
            <IdentifierRow label="BAP ID" value={identity.bapId} copied={copiedBapId} onCopy={handleCopyBapId} />
          )}

          {identityPubKey && (
            <IdentifierRow
              label="Identity Key"
              value={identityPubKey}
              copied={copiedIdentityKey}
              onCopy={handleCopyIdentityKey}
            />
          )}
        </motion.div>
      )}
    </motion.div>
  );

  const accountList = (
    <motion.div
      key="account-list"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-4"
    >
      <SubPageHeader title="Edit Account" onBack={() => setPage('manage-accounts')} />
      <motion.div variants={stagger} initial="initial" animate="animate" className="w-full space-y-2">
        {chromeStorageService.getAllAccounts().map((account) => (
          <motion.div
            key={account.addresses.identityAddress}
            variants={rowVariant}
            whileTap={{ scale: 0.99 }}
            onClick={() => {
              setSelectedAccountIdentityAddress(account.addresses.identityAddress);
              setEnteredAccountName(account.name);
              setEnteredAccountIcon(account.icon);
              setPage('edit-account');
            }}
            className="flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition-colors duration-150 bg-[var(--bw-surface)] hover:bg-[var(--bw-card2,#1f2128)]"
            style={{
              border: '1px solid rgba(152,162,179,0.12)',
            }}
          >
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <img
                src={account.icon || activeCircle}
                className="w-9 h-9 rounded-full object-cover flex-shrink-0"
                alt={account.name}
              />
              <p className="text-sm font-semibold truncate" style={{ color: 'var(--bw-text, #FFFFFF)' }}>
                {account.name}
              </p>
            </div>
            <ChevronRight size={16} color="#98A2B3" className="flex-shrink-0 ml-2" />
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );

  const editAccount = (
    <motion.div
      key="edit-account"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-4"
    >
      <SubPageHeader
        title="Edit Account"
        onBack={() => {
          setSelectedAccountIdentityAddress(undefined);
          setPage('account-list');
        }}
      />

      <motion.div variants={stagger} initial="initial" animate="animate" className="w-full space-y-4">
        <motion.div variants={rowVariant}>
          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
            Account Label
          </label>
          <Input
            theme={theme}
            placeholder="Account Label"
            type="text"
            onChange={(e) => setEnteredAccountName(e.target.value)}
            value={enteredAccountName}
          />
        </motion.div>
        <motion.div variants={rowVariant}>
          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
            Icon URL
          </label>
          <Input
            theme={theme}
            placeholder="https://..."
            type="text"
            onChange={(e) => setEnteredAccountIcon(e.target.value)}
            value={enteredAccountIcon}
          />
        </motion.div>
        <motion.div variants={rowVariant} className="flex flex-col gap-2">
          <Button
            theme={theme}
            type="primary"
            label="Save"
            style={{ marginTop: '0.25rem' }}
            onClick={handleAccountEditSave}
          />
          <Button theme={theme} type="warn" label="Delete Account" onClick={handleDeleteAccountIntent} />
        </motion.div>
      </motion.div>
    </motion.div>
  );

  const usbSecurityPage = (
    <motion.div
      key="usb-security"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-24"
    >
      <SubPageHeader title="USB Security Key" onBack={() => setPage(usbBackTo)} />
      <motion.div variants={stagger} initial="initial" animate="animate" className="w-full space-y-4">
        {!usbSecurity?.enabled ? (
          <>
            <motion.div
              variants={rowVariant}
              className="rounded-xl p-4"
              style={{
                background: 'linear-gradient(135deg, rgba(161,255,139,0.08), rgba(52,211,153,0.04))',
                border: '1px solid rgba(161,255,139,0.15)',
              }}
            >
              <div className="flex items-center gap-3 mb-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: 'rgba(161,255,139,0.12)' }}
                >
                  <Usb size={18} color="#A1FF8B" />
                </div>
                <div>
                  <p className="text-sm font-semibold" style={{ color: 'var(--bw-text, #FFFFFF)' }}>
                    USB security key
                  </p>
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
                    Two-factor unlock: your password plus a USB drive
                  </p>
                </div>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
                Any USB drive works. Unlocking needs it plugged in, so your password alone is never enough. You get a
                recovery code in case the drive is lost.
              </p>
            </motion.div>

            <motion.div
              variants={rowVariant}
              className="flex items-start gap-2 rounded-xl px-4 py-3"
              style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: '#FBBF24' }} />
              <p className="text-xs leading-snug" style={{ color: '#FBBF24' }}>
                Make a master backup first.
              </p>
            </motion.div>

            <motion.div variants={rowVariant} className="flex flex-col items-center gap-2">
              <Button theme={theme} type="primary" label="Turn on" onClick={() => void openUsbWindow('enroll')} />
              <Button
                theme={theme}
                type="secondary-outline"
                label="Make a backup first"
                onClick={() => setPage('export-keys-options')}
              />
            </motion.div>
          </>
        ) : (
          <>
            <Section title="Registered keys">
              {usbSecurity.sticks.map((stick, i) => {
                const inserted = presentSticks.includes(stick.id);
                const unchecked = uncheckedSticks.includes(stick.id);
                const backup = usbBackupSummary.find((s) => s.stickId === stick.id);
                // Needs a user gesture: one Chrome bubble for this one handle.
                const checkStick = async () => {
                  const handle = await getHandle(stick.id);
                  if (handle) await requestHandlePermission(handle);
                  await refreshUsbSecurity();
                };
                return (
                  <div key={stick.id}>
                    {i > 0 && <Divider />}
                    <SettingRow
                      icon={<Usb size={16} />}
                      label={stick.label}
                      description={
                        <span className="flex flex-col gap-0.5">
                          <span>Added {new Date(stick.addedAt).toLocaleDateString()}</span>
                          {usbBackupOn && backup && (
                            <span className="inline-flex items-center gap-1.5">
                              {backup.stale && (
                                <span
                                  className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                                  style={{ backgroundColor: '#FBBF24' }}
                                />
                              )}
                              {formatBackupFreshness(backup.lastBackupAt)}
                            </span>
                          )}
                        </span>
                      }
                      isFirst={i === 0}
                      isLast={i === usbSecurity.sticks.length - 1}
                      right={
                        <div className="flex items-center gap-2">
                          {inserted && (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-2 py-0.5"
                              style={{ backgroundColor: 'rgba(52,211,153,0.15)', color: '#34D399' }}
                            >
                              <span
                                className="inline-block w-1.5 h-1.5 rounded-full"
                                style={{ backgroundColor: '#34D399' }}
                              />
                              Inserted
                            </span>
                          )}
                          {!inserted && unchecked && (
                            <motion.button
                              whileTap={{ scale: 0.95 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                void checkStick();
                              }}
                              className="text-[10px] font-semibold rounded-full px-2 py-0.5 border-none cursor-pointer"
                              style={{ backgroundColor: 'rgba(161,255,139,0.12)', color: '#A1FF8B' }}
                            >
                              Check
                            </motion.button>
                          )}
                          <motion.button
                            whileTap={{ scale: 0.95 }}
                            onClick={() => handleRemoveUsbStickIntent(stick.id)}
                            className="text-[11px] font-semibold rounded-lg px-2 py-1 border-none cursor-pointer outline-none"
                            style={{ backgroundColor: 'rgba(239,68,68,0.12)', color: '#ef4444' }}
                          >
                            Remove
                          </motion.button>
                        </div>
                      }
                    />
                  </div>
                );
              })}
            </Section>

            <Section title="Manage">
              <SettingRow
                icon={<HardDrive size={16} />}
                label="USB backup"
                description={
                  usbBackupLarge
                    ? `Large (${Math.round(usbBackupBytes / (1024 * 1024))} MB). Keep a master backup file too`
                    : 'Encrypted copy on each key. Key + password restores it'
                }
                right={<ToggleSwitch theme={theme} on={usbBackupOn} onChange={() => void handleToggleUsbBackup()} />}
                isFirst
              />
              {usbBackupOn && (
                <>
                  <Divider />
                  <SettingRow
                    icon={usbBackingUp ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                    label="Back up now"
                    description={
                      usbBackingUp
                        ? 'Backing up...'
                        : presentSticks.length > 0
                          ? 'Sync inserted keys'
                          : 'Insert a registered key'
                    }
                    onClick={() => void handleUsbBackupNow()}
                  />
                </>
              )}
              <Divider />
              <SettingRow
                icon={<Plus size={16} />}
                label="Add another USB key"
                description="Needs a registered key inserted"
                onClick={() => void openUsbWindow('add')}
              />
              <Divider />
              <SettingRow
                icon={<AlertTriangle size={16} />}
                label="Lost a key? Rotate"
                description="Old keys stop working"
                onClick={() => void openUsbWindow('rotate')}
              />
              <Divider />
              <SettingRow
                icon={<Lock size={16} />}
                label="Turn off"
                description="Password-only unlock"
                onClick={() => void openUsbWindow('disable')}
                danger
                isLast
              />
            </Section>

            <motion.p variants={rowVariant} className="text-[10px] text-center px-2" style={{ color: '#475467' }}>
              Not a hardware wallet. Keys are in memory while unlocked.
            </motion.p>
          </>
        )}
      </motion.div>
    </motion.div>
  );

  const wordsAccount = (() => {
    const acc = chromeStorageService.getCurrentAccountObject().account;
    const n = accountNamesFor(acc?.addresses?.identityAddress, acc?.name ?? '');
    return n.payable ? `$${n.payable}` : n.displayName || acc?.name || 'This account';
  })();

  const showWordsPage = (
    <motion.div
      key="show-words"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-20"
    >
      <SubPageHeader title="Show my 12 words" onBack={() => setPage('main')} />
      <ShowSeedWords
        accountLabel={wordsAccount}
        verifyPassword={(pw) => chromeStorageService.verifyPassword(pw)}
        readMnemonic={async () => (await keysService.retrieveKeys()).mnemonic}
        onDone={() => setPage('main')}
        onCopied={(text) => addSnackbar(text, 'info')}
      />
    </motion.div>
  );

  const searchResults: SettingsEntry[] = settingsQuery.trim() ? searchSettings(settingsQuery) : [];

  const openSettingsEntry = (entry: SettingsEntry) => {
    setSettingsQuery('');
    const t = entry.target;
    if (t.kind === 'theme') {
      requestThemeSheet();
      handleSelect('bsv');
    } else if (t.kind === 'screen') {
      requestSettingsScreen(t.screen);
    } else if (t.page === 'main') {
      // A row on this page: bring it into view once the full list is back.
      window.setTimeout(() => {
        const row = Array.from(document.querySelectorAll('p')).find((el) => el.textContent === entry.label);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 60);
    } else {
      setPage(t.page as SettingsPage);
    }
  };

  const settingsSearchBar = (
    <div className="w-full px-4 pt-1 pb-3">
      <div
        className="flex items-center gap-2 rounded-xl px-3"
        style={{ backgroundColor: 'var(--bw-surface, #17191E)', border: '1px solid rgba(152,162,179,0.15)' }}
      >
        <Search size={15} color="#98A2B3" className="flex-shrink-0" />
        <input
          type="text"
          role="searchbox"
          enterKeyHint="search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={settingsQuery}
          onChange={(e) => setSettingsQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && searchResults[0]) openSettingsEntry(searchResults[0]);
            if (e.key === 'Escape') setSettingsQuery('');
          }}
          className="flex-1 bg-transparent border-0 outline-none py-2.5 text-sm min-w-0"
          style={{ color: 'var(--bw-text, #FFFFFF)' }}
        />
        {settingsQuery && (
          <button
            aria-label="Clear search"
            onClick={() => setSettingsQuery('')}
            className="bg-transparent border-0 p-1 cursor-pointer flex"
          >
            <XIcon size={14} color="#98A2B3" />
          </button>
        )}
      </div>
    </div>
  );

  const searchResultsPage = (
    <motion.div
      key="settings-search"
      variants={stagger}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full px-4 pb-20">
      {searchResults.length ? (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(152,162,179,0.12)' }}>
          {searchResults.map((r, i) => (
            <div key={r.id}>
              {i > 0 && <Divider />}
              <SettingRow
                icon={<Search size={16} />}
                label={r.label}
                description={r.description}
                onClick={() => openSettingsEntry(r)}
                isFirst={i === 0}
                isLast={i === searchResults.length - 1}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-center py-8" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
          No settings match “{settingsQuery.trim()}”
        </p>
      )}
    </motion.div>
  );

  return (
    <>
      <Show
        when={!showSpeedBump}
        whenFalseContent={
          <SpeedBump
            theme={theme}
            message={speedBumpMessage}
            onCancel={handleCancel}
            onConfirm={(password?: string) => handleSpeedBumpConfirm(password)}
            showSpeedBump={showSpeedBump}
            withPassword={
              decisionType === 'delete-account' ||
              decisionType === 'export-keys' ||
              decisionType === 'export-keys-qr-code' ||
              decisionType === 'export-master-backup'
            }
          />
        }
      >
        <div
          className="bw-75h flex flex-col items-center w-full overflow-x-hidden"
          style={{
            backgroundColor: '#010101',
            minHeight: '100%',
            height: 'calc(75%)',
            overflowY: 'auto',
          }}
        >
          <TopNav />

          {/* Page spacer for fixed TopNav */}
          <div className="h-14 w-full flex-shrink-0" />

          {/* Page transitions */}
          {page === 'main' && settingsSearchBar}
          <AnimatePresence mode="wait">
            {page === 'main' && (settingsQuery.trim() ? searchResultsPage : mainPage)}

            {page === 'manage-accounts' && manageAccountsPage}

            {page === 'create-account' && (
              <motion.div
                key="create-account"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="w-full pb-4"
              >
                <CreateAccount onNavigateBack={() => setPage('manage-accounts')} />
              </motion.div>
            )}

            {page === 'restore-account' && (
              <motion.div
                key="restore-account"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="w-full pb-4"
              >
                <RestoreAccount onNavigateBack={(p: SettingsPage) => setPage(p)} onNewAccount={() => setPage('create-account')} />
              </motion.div>
            )}

            {page === 'import-wif' && (
              <motion.div
                key="import-wif"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="w-full pb-4"
              >
                <ImportAccount onNavigateBack={() => setPage('restore-account')} />
              </motion.div>
            )}

            {page === 'account-list' && accountList}

            {page === 'edit-account' && editAccount}

            {page === 'identity' && identityPage}

            {page === 'permissions' && (
              <motion.div
                key="permissions"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="w-full px-4 pb-4"
              >
                <SubPageHeader title="Permissions" onBack={() => setPage('main')} />
                <PermissionsManager onBack={() => setPage('main')} />
              </motion.div>
            )}

            {page === 'envelopes' && (
              <motion.div
                key="envelopes"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="w-full px-4 pb-4"
              >
                <SubPageHeader title="Envelopes" onBack={() => setPage('main')} />
                <EnvelopesSettings />
              </motion.div>
            )}

            {page === 'streaming' && (
              <motion.div
                key="streaming"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="w-full px-4 pb-4"
              >
                <SubPageHeader title="Streaming permissions" onBack={() => setPage('main')} />
                <StreamingPermissions />
              </motion.div>
            )}

            {page === 'storage' && (
              <motion.div
                key="storage"
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="w-full px-4 pb-4"
              >
                <StorageStatus onBack={() => setPage('export-keys-options')} />
              </motion.div>
            )}

            {page === 'export-keys-options' && exportKeyOptionsPage}

            {page === 'export-keys-qr' && exportKeysAsQrCodePage}

            {page === 'show-words' && showWordsPage}

            {page === 'usb-security' && usbSecurityPage}

            {page === 'troubleshooting' && troubleshootingPage}
          </AnimatePresence>
        </div>
      </Show>
      {showAvatarPicker && (
        <AvatarPicker
          theme={theme}
          apiContext={apiContext}
          onUploadNew={handleAvatarUpload}
          onSelectExisting={handleAvatarSelectExisting}
          onClose={() => setShowAvatarPicker(false)}
        />
      )}

      {/* Full-screen backup overlay — locks all interaction during backup */}
      <AnimatePresence>
        {backupInProgress && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-[9999] flex flex-col items-center justify-center px-6"
            style={{ backgroundColor: '#010101' }}
          >
            <YoursIcon width="3rem" />

            <h2 className="text-lg font-bold mt-4 mb-1 text-center" style={{ color: 'var(--bw-text, #FFFFFF)' }}>
              {backupDone ? 'Backup Complete' : backupError === 'Not saved — try again' ? 'Not Saved' : backupError ? 'Backup Failed' : 'Backing Up All Accounts'}
            </h2>
            <p className="text-xs mb-5 text-center" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
              {backupDone
                ? backupSavedText
                : backupError
                  ? backupError
                  : `Exporting wallet data for ${backupAccounts.length} account${backupAccounts.length === 1 ? '' : 's'}`}
            </p>

            {/* Per-account status list. Scrolls within a fixed height so the
                progress bar and Done button stay on screen with many accounts. */}
            <div className="w-full max-w-xs space-y-2 mb-5 overflow-y-auto pr-1" style={{ maxHeight: '11rem' }}>
              {backupAccounts.map((acct, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg"
                  style={{ backgroundColor: '#17191E' }}
                >
                  <img
                    src={acct.icon || activeCircle}
                    className="w-7 h-7 rounded-full object-cover flex-shrink-0"
                    alt=""
                  />
                  <span className="text-sm flex-1 truncate" style={{ color: 'var(--bw-text, #FFFFFF)' }}>
                    {acct.name}
                  </span>
                  {acct.status === 'done' && <CheckCircle2 size={16} color="#A1FF8B" />}
                  {acct.status === 'active' && (
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    >
                      <Loader2 size={16} color="#A1FF8B" />
                    </motion.div>
                  )}
                  {acct.status === 'pending' && <Minus size={16} color="#98A2B3" />}
                </div>
              ))}
            </div>

            {/* Progress bar */}
            {!backupDone && !backupError && masterBackupProgress > 0 && (
              <div className="w-full max-w-xs mb-3">
                <ProgressBar
                  completed={masterBackupProgress}
                  bgColor={theme.color.component.progressBar}
                  baseBgColor={theme.color.component.progressBarTrack}
                  height="18px"
                  labelSize="10px"
                  borderRadius="9px"
                />
              </div>
            )}

            {/* Status message */}
            {!backupDone && !backupError && (
              <p className="text-xs text-center" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
                {masterBackupEventText}
              </p>
            )}

            {/* Error icon */}
            {backupError && (
              <div className="mb-3">
                <AlertTriangle size={32} color="#ef4444" />
              </div>
            )}

            {/* Done / Error dismiss button */}
            {(backupDone || backupError) && (
              <motion.button
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                whileTap={{ scale: 0.95 }}
                onClick={dismissBackupOverlay}
                className="mt-4 px-6 py-2.5 rounded-xl text-sm font-semibold border-0 cursor-pointer"
                style={{
                  background: backupError
                    ? '#ef4444'
                    : `linear-gradient(135deg, ${theme.color.component.primaryButtonLeftGradient}, ${theme.color.component.primaryButtonRightGradient})`,
                  color: backupError ? '#FFFFFF' : theme.color.component.primaryButtonText,
                }}
              >
                {backupError ? 'Close' : 'Done'}
              </motion.button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
