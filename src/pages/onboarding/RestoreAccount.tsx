import { useEffect, useRef, useState } from 'react';
import { AccountNameField } from '../../components/AccountNameField';
import {
  accountNameError,
  cleanAccountName,
  RESTORE_NAME_HINT,
  RESTORE_NAME_LABEL,
  suggestAccountName,
} from '../../utils/accountNameRules';
import { BetaGate } from '../../mobile/sweep/BetaGate';
import { useNavigate } from 'react-router-dom';
import { PasswordFields } from '../../mobile/names/PasswordFields';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, CheckCircle, ChevronRight, FileUp, Plus, Upload, Usb } from 'lucide-react';
import { isUsbSupported, openUsbWindow } from '../../services/UsbKey.service';
import relayXLogo from '../../assets/relayx.svg';
import { relayxXpub } from '../../sweep/relayxRecover';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import twetchLogo from '../../assets/twetch.svg';
import { originFromImport, saveAccountOrigin } from '../../mobile/origins/origins';
import yoursWhiteLogo from '../../assets/logos/white-logo.png';
import otherWallet from '../../assets/other-wallet.svg';
import wifWallet from '../../assets/wif-wallet.svg';
import masterWallet from '../../assets/master-wallet.svg';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageLoader } from '../../components/PageLoader';
import { Show } from '../../components/Show';
import { ObsidianBackdrop } from '../../mobile/ui/ObsidianBackdrop';
import { ToggleSwitch } from '../../components/ToggleSwitch';
import { WalletRow } from '../../components/WalletRow';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { sleep } from '../../utils/sleep';
import { useServiceContext } from '../../hooks/useServiceContext';
import { SupportedWalletImports } from '../../services/types/keys.types';
import { SettingsPage } from '../Settings';
import { saveAccountDataToChromeStorage } from '../../utils/chromeStorageHelpers';
import { normalizePhrase, phraseProblem, restoreErrorMessage } from './restoreHelpers';
import { clearHelpDeskUnpin } from '../../mobile/chat/helpDeskPin';
import { PasskeyRestoreRow } from '../../mobile/passkey/PasskeyBackup';
import { ExtPasskeyRow } from '../../mobile/passkey/ExtPasskeyRow';
import { EXT_PASSKEY_LIVE } from '../../mobile/passkey/extHandoff';
import { IS_EXTENSION } from '../../mobile/extension';
import { SEEDLESS_ENABLED } from '../../mobile/passkey/prf';
import { PasskeyCreatePanel, PasskeyUnlockButton } from '../../mobile/passkey/PasskeyCreate';
import { restoringFromComputer } from '../../mobile/passkey/openHere';
import { keystorePasswordFromPrf, passkeyName, savePasskeyUnlock } from '../../mobile/passkey/seedBackup';
import { offerSavePassword } from '../../mobile/passkey/passkeyUi';
import { takeTransferredWallet } from '../../mobile/passkey/session';
import { switchBeforeReload } from './finishSwitch';

const TRACE_ENABLED = SEEDLESS_ENABLED && import.meta.env.VITE_SEEDLESS_TRACE === '1';

export type RestoreAccountProps = {
  onNavigateBack: (page: SettingsPage) => void;
  newWallet?: boolean;
  /** Add account (an existing wallet): a "New account" row at the top opens the fresh-keys flow. */
  onNewAccount?: () => void;
};

const stepVariants = {
  enter: { opacity: 0, x: 24 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -24 },
};

const RestoreAccountInner = ({ onNavigateBack, newWallet = false, onNewAccount }: RestoreAccountProps) => {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const passkeyStart = new URLSearchParams(useLocation().search).get('passkey') === 'start';
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [step, setStep] = useState(1);
  // Passkey restore / "open on computer" (VITE_SEEDLESS=1): the passkey supplies the wallet password.
  const [passkeyPassword, setPasskeyPassword] = useState('');
  const [needPasskey, setNeedPasskey] = useState(false);
  const [seedWords, setSeedWords] = useState<string>('');
  const { addSnackbar } = useSnackbar();
  const { hideMenu, showMenu } = useBottomMenu();
  const [loading, setLoading] = useState(false);
  const [isExpertImport, setIsExpertImport] = useState(false);
  const [importWallet, setImportWallet] = useState<SupportedWalletImports | undefined>();
  const [walletDerivation, setWalletDerivation] = useState<string | null>(null);
  const [ordDerivation, setOrdDerivation] = useState<string | null>(null);
  const [identityDerivation, setIdentityDerivation] = useState<string | null>(null);
  const { keysService, chromeStorageService } = useServiceContext();
  // Required, prefilled with an editable "Account N" (owner, 18 Oct 2026: utils/accountNameRules.ts).
  const otherAccountNames = () => chromeStorageService.getAllAccounts().map((a) => a.name ?? '');
  const [accountName, setAccountName] = useState(() => suggestAccountName(otherAccountNames()));
  const [nameError, setNameError] = useState('');
  // Preview-only trace of the passkey restore (VITE_SEEDLESS=1): shows each step and the exact error on screen, because
  // on a phone there is no console (owner, 20 Oct 2026: the first passkey restore sends him back to the restore form).
  const [trace, setTrace] = useState<string[]>([]);
  const note = (m: string) => {
    // Test builds only (VITE_SEEDLESS_TRACE=1, the Vercel previews): a release shows no debug panel.
    if (TRACE_ENABLED) setTrace((t) => [...t.slice(-9), `${new Date().toLocaleTimeString()} ${m}`]);
  };
  // Cancel on the Restoring screen (owner, 20 Oct 2026: "there's no way off the restoring screen"). A cancelled run
  // is ignored when it finishes: it never jumps to the finish screen later.
  const cancelled = useRef(false);
  // The wallet arrived from the passkey hand-off (extension): say what this password is for.
  const [viaExt, setViaExt] = useState(false);
  // A passkey restore has nothing left to ask (the passkey is the password), so it goes straight to unlock.
  const viaPasskey = useRef(false);
  const cancelRestore = () => {
    cancelled.current = true;
    note('cancelled by the user');
    setLoading(false);
  };
  useEffect(() => {
    note(`screen: step ${step}, ${loading ? 'spinner' : 'form'}`);
  }, [step, loading]);
  const traceBox =
    TRACE_ENABLED && trace.length > 0 ? (
      <pre
        data-testid="restore-trace"
        className="w-full text-xs whitespace-pre-wrap break-words rounded-lg p-2 mb-3"
        style={{ background: '#111', color: '#9ae6b4' }}
      >
        {trace.join('\n')}
      </pre>
    ) : null;
  const [iconURL, setIconURL] = useState('');
  const hiddenYoursFileInput = useRef<HTMLInputElement>(null);
  const currentAccountName = (() => {
    if (newWallet) return '';
    try {
      return chromeStorageService.getCurrentAccountObject().account?.name ?? '';
    } catch {
      return '';
    }
  })();

  useEffect(() => {
    if (newWallet) hideMenu();
    return () => {
      showMenu();
    };
  }, [hideMenu, showMenu, newWallet]);

  const handleExpertToggle = () => setIsExpertImport(!isExpertImport);

  const handleYoursJsonUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || file.type !== 'application/json') {
      addSnackbar('Please upload a JSON file.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      try {
        const jsonData = JSON.parse(text);
        if (!jsonData.mnemonic) {
          addSnackbar('No seed phrase found in file.', 'error');
          return;
        }
        setSeedWords(jsonData.mnemonic);
        if (jsonData.payDerivationPath) setWalletDerivation(jsonData.payDerivationPath);
        if (jsonData.ordDerivationPath) setOrdDerivation(jsonData.ordDerivationPath);
        if (jsonData.identityDerivationPath) setIdentityDerivation(jsonData.identityDerivationPath);
        setStep(3);
      } catch {
        addSnackbar('Error parsing JSON file!', 'error');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const applyPasskeyPassword = (pw: string) => {
    setPassword(pw);
    setPasswordConfirm(pw);
    setPasskeyPassword(pw);
  };
  useEffect(() => {
    if (!SEEDLESS_ENABLED || !newWallet) return;
    const t = takeTransferredWallet();
    if (!t) return;
    setImportWallet('yours');
    setSeedWords(t.words);
    setStep(3);
    setNeedPasskey(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival from "open on computer"
  }, []);
  useEffect(() => {
    if (passkeyPassword && password === passkeyPassword && passwordConfirm === passkeyPassword) {
      setPasskeyPassword('');
      note('passkey password ready, starting the restore');
      viaPasskey.current = true;
      void handleRestore({ preventDefault: () => undefined } as React.FormEvent<HTMLFormElement>);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once both fields hold the passkey password
  }, [passkeyPassword, password, passwordConfirm]);

  const handleRestore = async (event: React.FormEvent<HTMLFormElement>) => {
    try {
      event.preventDefault();
      cancelled.current = false;
      setLoading(true);
      note(`restore: start (name "${accountName}", ${seedWords.trim().split(/\s+/).filter(Boolean).length} words, password ${password.length} chars, newWallet ${String(newWallet)})`);
      // Stage timings (owner, 6 Oct 2026: a restore took ~50 s).
      const t0 = Date.now();
      const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

      const badName = accountNameError(accountName, otherAccountNames());
      setNameError(badName);
      if (badName) {
        note(`stopped: ${badName}`);
        setLoading(false);
        addSnackbar(badName, 'error');
        return;
      }
      if (password.length < 8) {
        note('stopped: password shorter than 8');
        addSnackbar(newWallet ? 'The password must be at least 8 characters!' : restoreErrorMessage(new Error('Unauthorized!')), 'error');
        return;
      }
      const problem = phraseProblem(seedWords);
      if (problem) {
        note(`stopped: ${problem}`);
        addSnackbar(problem, 'error');
        setStep(2);
        return;
      }

      if (newWallet && password !== passwordConfirm) {
        note('stopped: passwords do not match');
        addSnackbar('The passwords do not match!', 'error');
        return;
      }

      await sleep(50);
      const keys = await keysService.generateSeedAndStoreEncrypted(
        password,
        newWallet,
        normalizePhrase(seedWords),
        walletDerivation,
        ordDerivation,
        identityDerivation,
        importWallet,
      );
      if (!keys?.mnemonic) {
        addSnackbar("Couldn't add the account.", 'error');
        return;
      }

      console.log('[restore] keys stored at', at());
      note(`keys stored (${at()})`);
      // A fresh restore pins the bWallet Help Desk again (its unpin is per device only).
      clearHelpDeskUnpin();
      const chromeObject = await chromeStorageService.getAndSetStorage();
      if (!chromeObject?.accounts) throw new Error('No accounts found!');
      const objKeys = Object.keys(chromeObject.accounts);
      if (!objKeys) throw new Error('Object identity address not found');
      await switchBeforeReload(chromeStorageService, keys.identityAddress);
      console.log('[restore] wallet started at', at());
      note(`account selected (${at()})`);
      await saveAccountDataToChromeStorage(chromeStorageService, cleanAccountName(accountName), iconURL);
      // RelayX: the inherited restore holds only /1/0 and /2/0. Keep the RelayX account's xpub (public, spends
      // nothing) so the wallet can find its Run NFTs on every RelayX address (sweep/relayxRecover.ts).
      if (importWallet === 'relayx') await rememberRelayx(chromeStorageService, keys.mnemonic);
      // Origin card + drawer tint (owner, 24 Oct 2026): remember which wallet this account was restored from.
      const from = originFromImport(importWallet);
      if (from) saveAccountOrigin(keys.identityAddress, from);
      console.log('[restore] done at', at());

      if (cancelled.current) {
        note(`finished after being cancelled (${at()}): staying on the form`);
        return;
      }
      note(`done (${at()}), showing the finish screen`);
      setStep(4);
      if (viaPasskey.current) {
        note('going straight to unlock');
        window.location.reload();
      }
    } catch (error) {
      console.log(error);
      // Class name only: a library error message could one day carry the words (review 20 Oct 2026).
      note(`ERROR: ${error instanceof Error ? error.name : typeof error}`);
      addSnackbar(restoreErrorMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleWalletSelection = (wallet?: SupportedWalletImports) => {
    setImportWallet(wallet);
    if (wallet === 'wif') {
      if (newWallet) navigate('/import-wallet');
      else onNavigateBack('import-wif');
      return;
    }
    if (newWallet && wallet === 'master') {
      navigate('/master-restore');
      return;
    }
    if (newWallet && wallet === ('usb' as SupportedWalletImports)) {
      // The folder picker needs a window that survives focus loss, so this
      // runs in the standalone USB window rather than the popup.
      void openUsbWindow('restore');
      return;
    }
    setStep(2);
  };

  const getRestoreTitle = () => {
    return importWallet === 'yours'
      ? `Restore ${theme.settings.displayName ?? `${theme.settings.walletName} wallet`}`
      : importWallet === 'panda'
        ? 'Restore Panda wallet'
        : importWallet === 'relayx'
          ? 'Restore Relay wallet'
          : importWallet === 'twetch'
            ? 'Restore Twetch wallet'
            : 'Restore wallet';
  };

  const getRestoreDescription = () => {
    return importWallet === 'yours'
      ? 'Enter your 12 words. They are all you need; the Yours extension is not required.'
      : importWallet
      ? 'Enter your seed phrase'
      : 'Enter a seed phrase and use custom derivation paths to import a wallet from anywhere!';
  };

  const accentLeft = theme.color.component.primaryButtonLeftGradient;
  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  const row = theme.color.global.row;
  const bg = theme.color.global.walletBackground;

  // Wallet option rows
  type WalletDef = { id: SupportedWalletImports | undefined; label: string; logo: React.ReactNode };
  const walletOptions: WalletDef[] = [
    {
      id: 'yours',
      label: theme.settings.walletName,
      logo: (
        <div
          className="flex items-center justify-center rounded-lg"
          style={{ backgroundColor: '#000', width: '2.25rem', height: '2.25rem', padding: '0.35rem' }}
        >
          <img src={yoursWhiteLogo} alt="Yours" style={{ width: '1rem', height: 'auto' }} />
        </div>
      ),
    },
    {
      id: 'relayx',
      label: 'RelayX',
      logo: <img src={relayXLogo} alt="RelayX" style={{ width: 'auto', height: '2.25rem' }} />,
    },
    {
      id: 'twetch',
      label: 'Twetch',
      logo: <img src={twetchLogo} alt="Twetch" style={{ width: 'auto', height: '2.25rem' }} />,
    },
    {
      id: 'wif',
      label: 'Restore with private key',
      logo: <img src={wifWallet} alt="WIF" style={{ width: 'auto', height: '2.25rem' }} />,
    },
    ...(newWallet
      ? [
          {
            id: 'master' as SupportedWalletImports,
            label: 'Restore from master backup',
            logo: (
              <div
                className="flex items-center justify-center rounded-lg"
                style={{ backgroundColor: '#000', width: '2.25rem', height: '2.25rem', padding: '0.35rem' }}
              >
                <img src={masterWallet} alt="Master" style={{ width: '1.25rem' }} />
              </div>
            ),
          },
          ...(isUsbSupported()
            ? [
                {
                  id: 'usb' as SupportedWalletImports,
                  label: 'Restore from USB key',
                  logo: (
                    <div
                      className="flex items-center justify-center rounded-lg"
                      style={{ backgroundColor: '#000', width: '2.25rem', height: '2.25rem' }}
                    >
                      <Usb size={18} color="#FFFFFF" />
                    </div>
                  ),
                },
              ]
            : []),
        ]
      : []),
    {
      id: 'other',
      label: 'Other',
      logo: <img src={otherWallet} alt="Other" style={{ width: 'auto', height: '2.25rem' }} />,
    },
  ];

  const PageHeader = ({ title, onClick }: { title: string; onClick: () => void }) => (
    <div className="flex w-full items-center gap-3 px-4 pb-4 pt-4 sticky top-0 z-10" style={{ backgroundColor: bg }}>
      <motion.button
        whileTap={{ scale: 0.9 }}
        onClick={onClick}
        className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0 border-0 outline-none cursor-pointer"
        style={{ background: '#17191E' }}
      >
        <ArrowLeft size={16} style={{ color: '#FFFFFF' }} />
      </motion.button>
      <span className="text-base font-bold" style={{ color: '#FFFFFF' }}>
        {title}
      </span>
    </div>
  );

  /** Back button + title + wallet icon for sub-steps. Rendered inside each step so it animates with the content. */
  const SubStepHeader = ({ title, onBack }: { title: string; onBack: () => void }) => (
    <>
      <div className="flex w-full items-center gap-3 px-4 pb-4 pt-4 sticky top-0 z-10" style={{ backgroundColor: bg }}>
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0 border-0 outline-none cursor-pointer"
          style={{ background: '#17191E' }}
        >
          <ArrowLeft size={16} style={{ color: '#FFFFFF' }} />
        </motion.button>
        <span className="text-base font-bold" style={{ color: '#FFFFFF' }}>
          {title}
        </span>
      </div>
      {newWallet && (
        <div
          className="flex items-center justify-center rounded-2xl mb-4 mt-2"
          style={{ width: '4.5rem', height: '4.5rem', backgroundColor: '#17191E' }}
        >
          {importWallet === 'relayx' ? (
            <img src={relayXLogo} alt="RelayX" style={{ width: 'auto', height: '2.5rem' }} />
          ) : importWallet === 'twetch' ? (
            <img src={twetchLogo} alt="Twetch" style={{ width: 'auto', height: '2.5rem' }} />
          ) : importWallet === 'wif' ? (
            <img src={wifWallet} alt="WIF" style={{ width: 'auto', height: '2.5rem' }} />
          ) : importWallet === 'other' ? (
            <img src={otherWallet} alt="Other" style={{ width: 'auto', height: '2.5rem' }} />
          ) : (
            <img src={yoursWhiteLogo} alt="Yours" style={{ width: '1.75rem', height: 'auto' }} />
          )}
        </div>
      )}
    </>
  );

  const selectImportWallet = (
    <div className={`flex flex-col items-center w-full ${newWallet ? 'pb-6' : 'pb-20'}`}>
      <PageHeader
        title={newWallet ? 'Restore a Wallet' : 'Add account'}
        onClick={() => (newWallet ? navigate('/') : onNavigateBack('manage-accounts'))}
      />
      {!newWallet && onNewAccount && (
        <div className="w-full flex flex-col gap-2.5 mb-4">
          <WalletRow
            onClick={onNewAccount}
            element={
              <div className="flex items-center gap-3 w-full">
                <div
                  className="flex items-center justify-center rounded-lg"
                  style={{ backgroundColor: accentLeft, width: '2.25rem', height: '2.25rem' }}
                >
                  <Plus size={18} color="#000" />
                </div>
                <span className="flex-1 flex flex-col">
                  <span className="text-sm font-semibold" style={{ color: contrast }}>
                    New account
                  </span>
                  <span className="text-xs" style={{ color: gray }}>
                    Fresh 12 words, same password
                  </span>
                </span>
                <ChevronRight size={16} style={{ color: gray }} />
              </div>
            }
          />
        </div>
      )}
      <p className="text-xs mb-4 text-center px-4" style={{ color: gray }}>
        {newWallet ? "Select the wallet you'd like to restore from" : 'Or restore one from 12 words'}
      </p>

      {SEEDLESS_ENABLED && newWallet && restoringFromComputer() && (
        <div
          className="w-full rounded-xl px-4 py-3 mb-3 text-left"
          style={{ background: theme.color.global.row }}
          data-testid="restore-from-computer"
        >
          <p className="text-sm font-semibold m-0" style={{ color: contrast }}>
            Put your wallet on this phone
          </p>
          <p className="text-xs mt-1 mb-0" style={{ color: gray }}>
            Tap Restore with a passkey below and choose your passkey. Your computer will tell you when it is done.
          </p>
        </div>
      )}
      {/* Prototype, VITE_SEEDLESS=1 only: the passkey opens the sealed 12 words, then the normal restore
      form runs from its name + password step (as the JSON backup upload does). */}
      {SEEDLESS_ENABLED && IS_EXTENSION && EXT_PASSKEY_LIVE && (
        <ExtPasskeyRow
          autoStart={passkeyStart}
          onWallet={(words, name) => {
            // The words came from web.bwalletx.com after the person typed the one-time code and said yes. From here
            // it is the ordinary restore: the person picks this extension's password; an existing account is never
            // overwritten (the restore refuses "already added").
            setImportWallet('yours');
            setSeedWords(words);
            setViaExt(true);
            if (name) setAccountName(cleanAccountName(name));
            setStep(3);
          }}
        />
      )}
      {SEEDLESS_ENABLED && !IS_EXTENSION && (
        <PasskeyRestoreRow
          onPhrase={(words, pk) => {
            note(`passkey opened the backup: ${words.trim().split(/\s+/).length} words`);
            setImportWallet('yours');
            setSeedWords(words);
            setStep(3);
            // The same passkey unlocks the restored wallet: its derived password, no password to invent.
            // (Add account keeps the master password, so only a new wallet does this.)
            if (newWallet)
              void keystorePasswordFromPrf(pk.prf).then((pw) => {
              pk.prf.fill(0);
              savePasskeyUnlock({ rpId: pk.rpId, credentialId: pk.credentialId });
              void offerSavePassword(passkeyName(), pw);
              applyPasskeyPassword(pw);
            });
          }}
        />
      )}
      <div className="w-full flex flex-col gap-2.5 mb-3">
        {walletOptions.map((opt) =>
          opt.id ? (
            <WalletRow
              key={opt.id}
              onClick={() => handleWalletSelection(opt.id)}
              element={
                <div className="flex items-center gap-3 w-full">
                  {opt.logo}
                  <span className="text-sm font-semibold flex-1" style={{ color: contrast }}>
                    {opt.label}
                  </span>
                  <ChevronRight size={16} style={{ color: gray }} />
                </div>
              }
            />
          ) : null,
        )}
        {!newWallet && (
          <WalletRow
            onClick={() => {
              setImportWallet('yours');
              hiddenYoursFileInput.current?.click();
            }}
            element={
              <div className="flex items-center gap-3 w-full">
                <div
                  className="flex items-center justify-center rounded-lg"
                  style={{ backgroundColor: '#17191E', width: '2.25rem', height: '2.25rem' }}
                >
                  <FileUp size={18} color="#FFFFFF" />
                </div>
                <span className="text-sm font-semibold flex-1" style={{ color: contrast }}>
                  Import a backup file
                </span>
                <ChevronRight size={16} style={{ color: gray }} />
              </div>
            }
          />
        )}
      </div>
      <input
        type="file"
        ref={step === 1 ? hiddenYoursFileInput : undefined}
        onChange={handleYoursJsonUpload}
        style={{ display: 'none' }}
        accept="application/json"
      />
    </div>
  );

  const enterSeedStep = (
    <div className={`flex flex-col items-center w-full ${newWallet ? 'pb-6' : 'pb-20'}`}>
      <SubStepHeader title={getRestoreTitle()} onBack={() => setStep(1)} />
      <p className="text-xs mb-4 text-center px-4" style={{ color: gray }}>
        {getRestoreDescription()}
      </p>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const problem = phraseProblem(seedWords);
          if (problem) {
            addSnackbar(problem, 'error');
            return;
          }
          setStep(3);
        }}
        className="flex flex-col items-center w-full"
      >
        <div className="w-[87%] mb-2">
          <textarea
            placeholder="Enter secret recovery words"
            onChange={(e) => setSeedWords(e.target.value)}
            rows={isExpertImport ? 3 : 4}
            className="w-full rounded-xl border text-sm outline-none resize-none px-4 py-3 transition-all duration-200"
            style={{
              backgroundColor: row,
              borderColor: gray + '40',
              color: contrast,
              fontFamily: "'Inter', Arial, Helvetica, sans-serif",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = `color-mix(in srgb, ${accentLeft} 50%, transparent)`;
              e.currentTarget.style.boxShadow = `0 0 0 2px color-mix(in srgb, ${accentLeft} 19%, transparent)`;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = gray + '40';
              e.currentTarget.style.boxShadow = 'none';
            }}
          />
        </div>

        <Show when={isExpertImport}>
          <Input
            theme={theme}
            placeholder="Wallet Derivation ex. m/44'/236'/0'/0/0"
            type="text"
            value={walletDerivation ?? ''}
            onChange={(e) => setWalletDerivation(e.target.value)}
            style={{ margin: '0.1rem', width: '85%' }}
          />
          <Input
            theme={theme}
            placeholder="Ordinal Derivation ex. m/44'/236'/1'/0/0"
            type="text"
            value={ordDerivation ?? ''}
            onChange={(e) => setOrdDerivation(e.target.value)}
            style={{ margin: '0.1rem', width: '85%' }}
          />
          <Input
            theme={theme}
            placeholder="Identity Derivation ex. m/0'/236'/0'/0/0"
            type="text"
            value={identityDerivation ?? ''}
            onChange={(e) => setIdentityDerivation(e.target.value)}
            style={{ margin: '0.1rem 0 0.5rem', width: '85%' }}
          />
        </Show>

        <Show when={importWallet === 'other'}>
          <div className="flex items-center w-[87%] my-2 gap-3">
            <ToggleSwitch theme={theme} on={isExpertImport} onChange={handleExpertToggle} />
            <span className="text-xs text-left" style={{ color: gray }}>
              Use custom derivations
            </span>
          </div>
        </Show>

        <p className="text-xs text-center my-3 px-4" style={{ color: gray + 'bb' }}>
          Make sure you are in a safe place and no one is watching.
        </p>

        <Button theme={theme} type="primary" label="Next" isSubmit />
      </form>

      {/* Yours JSON upload — extracts seed and derivation paths from key backup */}
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 380, damping: 22 }}
        onClick={() => hiddenYoursFileInput.current?.click()}
        className="flex items-center justify-center gap-2 w-[87%] h-9 rounded-xl border text-sm font-semibold mt-2"
        style={{
          borderColor: gray + '40',
          color: contrast,
          background: row,
        }}
      >
        <Upload size={14} style={{ color: accentLeft }} />
        Upload Yours JSON
      </motion.button>

      <input
        type="file"
        ref={hiddenYoursFileInput}
        onChange={handleYoursJsonUpload}
        style={{ display: 'none' }}
        accept="application/json"
      />
    </div>
  );

  const passwordStep = (
    <div className={`flex flex-col items-center w-full ${newWallet ? 'pb-6' : 'pb-20'}`}>
      <SubStepHeader
        title={viaExt ? 'Master password for this extension' : newWallet ? 'Create Password' : 'Your bWalletX password'}
        onBack={() => setStep(2)}
      />
      <p className="text-xs mb-4 text-center px-4" style={{ color: gray }}>
        {viaExt
          ? 'Your passkey brought your wallet here. This password unlocks all your accounts in this Chrome. Pick one your password manager will keep. Everything else on this page is optional.'
          : newWallet
          ? 'This will be used to unlock your wallet.'
          : `The password you use to unlock bWalletX${currentAccountName ? ` (checked against ${currentAccountName})` : ''}.`}
      </p>

      {SEEDLESS_ENABLED && !newWallet && <PasskeyUnlockButton label="Use passkey" onPassword={applyPasskeyPassword} />}
      {needPasskey && (
        <PasskeyCreatePanel
          onPassword={(pw) => {
            setNeedPasskey(false);
            applyPasskeyPassword(pw);
          }}
        />
      )}
      <form onSubmit={handleRestore} className="flex flex-col items-center w-full">
        <AccountNameField
          theme={theme}
          label={RESTORE_NAME_LABEL}
          hint={RESTORE_NAME_HINT}
          value={accountName}
          error={nameError}
          onChange={(v) => {
            setAccountName(v);
            if (nameError) setNameError('');
          }}
        />
        <Input
          theme={theme}
          placeholder="Icon URL"
          type="text"
          value={iconURL}
          onChange={(e) => setIconURL(e.target.value)}
        />
        {/* Passkey restore in the extension (owner, 22 Oct 2026): a generated strong password, Copy, and a required
        "I've saved it" tick, as on Create Account. The plain fields below stay byte-identical (vite.config.mobile.ts
        patches them). */}
        {viaExt && (
          <PasswordFields
            askSaved
            newWallet
            username={accountName}
            password={password}
            confirm={passwordConfirm}
            setPassword={setPassword}
            setConfirm={setPasswordConfirm}
          />
        )}
        {!viaExt && (<>
        <Input
          theme={theme}
          placeholder={newWallet ? 'Password' : 'bWalletX password'}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Show when={newWallet}>
          <Input
            theme={theme}
            placeholder="Confirm Password"
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
          />
        </Show>
        </>)}
        <div className="mt-3 w-full">
          <Button theme={theme} type="primary" label="Finish" disabled={loading} isSubmit />
        </div>
      </form>
    </div>
  );

  const successStep = (
    <div className="flex flex-col items-center w-full">
      <motion.div
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.1 }}
        className="mb-5 mt-4"
      >
        <CheckCircle size={56} style={{ color: accentLeft }} strokeWidth={1.5} />
      </motion.div>

      <motion.h2
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="text-2xl font-bold mb-2 text-center"
        style={{ color: contrast }}
      >
        Wallet Restored!
      </motion.h2>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.33 }}
        className="text-sm mb-6 text-center"
        style={{ color: gray }}
      >
        Your wallet has been successfully restored.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.42 }}
        className="w-full"
      >
        <Button
          theme={theme}
          type="primary"
          label="Enter"
          onClick={() => {
            window.location.reload();
          }}
        />
      </motion.div>
    </div>
  );

  return (
    <Show when={!loading} whenFalseContent={
        <div className="w-full flex flex-col items-center gap-3">
          <PageLoader theme={theme} message="Restoring..." />
          {traceBox}
          <button
            type="button"
            onClick={cancelRestore}
            data-testid="restore-cancel"
            className="text-sm underline border-0 bg-transparent cursor-pointer pb-4"
            style={{ color: theme.color.global.gray }}
          >
            Cancel
          </button>
        </div>
      }>
      {/* my-auto: centred when short, top-aligned (not clipped) when taller than the wallet box. */}
      <div className="flex flex-col items-center w-full px-2 pt-4 pb-4 my-auto" style={{ isolation: 'isolate' }}>
        <ObsidianBackdrop />
        {traceBox}
        <AnimatePresence mode="wait">
          {step === 1 && (
            <motion.div
              key="step1"
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="w-full"
            >
              {selectImportWallet}
            </motion.div>
          )}
          {step === 2 && (
            <motion.div
              key="step2"
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="w-full"
            >
              {enterSeedStep}
            </motion.div>
          )}
          {step === 3 && (
            <motion.div
              key="step3"
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="w-full"
            >
              {passwordStep}
            </motion.div>
          )}
          {step === 4 && (
            <motion.div
              key="step4"
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="w-full"
            >
              {successStep}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Show>
  );
};

/** Beta: a one-tap "start small" notice before restoring an existing wallet (15 Oct 2026). */
export const RestoreAccount = (p: RestoreAccountProps) => (
  <BetaGate>
    <RestoreAccountInner {...p} />
  </BetaGate>
);

async function rememberRelayx(storage: ChromeStorageService, words: string) {
  try {
    const { account } = storage.getCurrentAccountObject();
    if (!account) return;
    await storage.updateNested('accounts', {
      [account.addresses.identityAddress]: {
        ...account,
        settings: { ...account.settings, relayx: { xpub: relayxXpub(words) } },
      },
    });
  } catch (e) {
    // The account is restored either way; only the NFT finder misses its starting point.
    console.warn('[restore] RelayX xpub not saved', e);
  }
}
