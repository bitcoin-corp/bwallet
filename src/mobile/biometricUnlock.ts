/* eslint-disable @typescript-eslint/no-explicit-any */
import { decrypt } from '../utils/crypto';
import type { PlatformHooks } from '../platform';
import { YoursNative, isNative, type BiometryType } from './native';
import { IS_TAURI } from './desktop/ipc';
import { afterUnlockRead, enrolmentOffer, lockScreenMode, type UnlockRead } from './biometricDecision';

/**
 * Face ID / Touch ID / fingerprint unlock, layered on upstream's own unlock
 * semantics (unlocked = session passKey + fresh lastActiveTime, then
 * WALLET_UNLOCKED). Plugs into upstream's platform hooks (src/platform.ts):
 * `quickUnlock` for the lock-screen button, `onWalletReady` for enrolment.
 *
 * - Enrol: once the wallet home screen shows with a passKey in storage.session
 *   (i.e. after a password unlock or wallet creation), offer once to seal it
 *   behind biometrics (per account).
 * - Unlock: read the sealed passKey, prove it decrypts the account keystore,
 *   then hand it to storage.session exactly as a password unlock would.
 */

const LABELS: Record<BiometryType, string> = {
  faceId: 'Face ID',
  touchId: 'Touch ID',
  opticId: 'Optic ID',
  fingerprint: 'fingerprint',
  none: 'biometrics',
};
const ENROLLED = (account: string) => `bio:enrolled:${account}`;
const DECLINED = 'bio:declined';
const REENROL = (account: string) => `bio:reenrol:${account}`;
const SEALED = (account: string) => `passKey:${account}`;

let biometry: BiometryType = 'none';
let chromeApi: any;
let offeredThisSession = false;

const label = () => LABELS[biometry];

const flag = {
  get: async (key: string) => (await YoursNative.secureGet({ key })).value === '1',
  set: (key: string) => YoursNative.secureSet({ key, value: '1' }),
  clear: (key: string) => YoursNative.secureRemove({ key }),
};

const selectedAccount = async (): Promise<{ id?: string; encryptedKeys?: string }> => {
  const { selectedAccount: id, accounts } = await chromeApi.storage.local.get(['selectedAccount', 'accounts']);
  return { id, encryptedKeys: id ? accounts?.[id]?.encryptedKeys : undefined };
};

// UI ------------------------------------------------------------------------

export const sheet = (title: string, body: string, primary: string, secondary: string): Promise<boolean> =>
  new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'yours-sheet-backdrop';
    el.innerHTML = `<div class="yours-sheet" role="dialog" aria-modal="true">
        <h2></h2><p></p>
        <button type="button" class="yours-sheet-primary"></button>
        <button type="button" class="yours-sheet-secondary"></button>
      </div>`;
    el.querySelector('h2')!.textContent = title;
    el.querySelector('p')!.textContent = body;
    const [yes, no] = el.querySelectorAll('button');
    yes.textContent = primary;
    no.textContent = secondary;
    const done = (value: boolean) => {
      el.remove();
      resolve(value);
    };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    document.body.appendChild(el);
  });

const toast = (text: string) => {
  const el = document.createElement('div');
  el.className = 'yours-toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

// Enrolment -----------------------------------------------------------------

const capitalised = () => label().charAt(0).toUpperCase() + label().slice(1);

const enrol = async (id: string, passKey: string) => {
  try {
    await YoursNative.biometricSet({ key: SEALED(id), value: passKey });
    await flag.set(ENROLLED(id));
    await flag.clear(REENROL(id));
    toast(`${capitalised()} unlock is on`);
  } catch (error: any) {
    if (error?.code !== 'cancelled') toast(`Couldn't turn on ${label()}`);
  }
};

const offerEnrolment = async () => {
  const overlayOpen = !!document.querySelector('.yours-overlay, .yours-sheet-backdrop');
  if (offeredThisSession || overlayOpen) return;
  offeredThisSession = true;
  const { passKey } = await chromeApi.storage.session.get('passKey');
  const { id, encryptedKeys } = await selectedAccount();
  const offer = enrolmentOffer({
    hasPassKey: typeof passKey === 'string',
    hasAccount: !!id && !!encryptedKeys,
    enrolled: !!id && (await flag.get(ENROLLED(id))),
    needsReenrol: !!id && (await flag.get(REENROL(id))),
    declined: await flag.get(DECLINED),
    offeredThisSession: false,
    overlayOpen,
  });
  if (offer === 'none' || !id) return;
  // It was on and broke (e.g. a new fingerprint was added): set it up again; the system prompt is the consent.
  if (offer === 'reenrol') return void (await enrol(id, passKey));
  const yes = await sheet(
    `Unlock with ${label()}?`,
    `Use ${label()} instead of your password to unlock your wallet on this device. Your password still works and is still needed for backups and sensitive settings.`,
    `Use ${label()}`,
    'Not now',
  );
  if (!yes) return void (await flag.set(DECLINED));
  await enrol(id, passKey);
};

const disable = async () => {
  const { id } = await selectedAccount();
  await YoursNative.biometricRemove({ key: id ? SEALED(id) : '' });
  if (id) await flag.clear(ENROLLED(id));
  if (id) await flag.clear(REENROL(id));
  await flag.set(DECLINED);
};

// Unlock --------------------------------------------------------------------

const unlock = async (): Promise<boolean> => {
  const { id, encryptedKeys } = await selectedAccount();
  if (!id || !encryptedKeys) return false;
  let passKey: string | null = null;
  let read: UnlockRead;
  try {
    passKey = (await YoursNative.biometricGet({ key: SEALED(id), reason: 'Unlock your wallet' })).value;
    const valid =
      !!passKey &&
      (await decrypt(encryptedKeys, passKey)
        .then((plain) => (JSON.parse(plain), true))
        .catch(() => false));
    read = { kind: 'value', valid };
  } catch (error: any) {
    console.warn('[biometric] unlock failed:', error?.code, error?.message);
    read = { kind: error?.code === 'cancelled' ? 'cancelled' : 'error' };
  }
  const outcome = afterUnlockRead(read);
  if (outcome === 'keep') {
    if (read.kind === 'error') toast(`${capitalised()} didn't work. Use your password.`);
    return false;
  }
  if (outcome === 'broken' || !passKey) {
    // A new fingerprint was added, the password changed, or the sealed item is gone: the sealed key is useless.
    // Remember that it was on, so the lock screen says so and the next password unlock sets it up again.
    console.warn('[biometric] sealed passKey no longer works; re-enrol after a password unlock');
    await YoursNative.biometricRemove({ key: SEALED(id) });
    await flag.clear(ENROLLED(id));
    await flag.set(REENROL(id));
    toast(reenrolNotice());
    return false;
  }
  offeredThisSession = true;
  await chromeApi.storage.session.set({ passKey });
  await chromeApi.storage.local.set({ lastActiveTime: Date.now() });
  await chromeApi.runtime.sendMessage({ action: 'WALLET_UNLOCKED' }).catch(() => undefined);
  return true;
};

/**
 * Confirm a sensitive action with Face ID / Touch ID / fingerprint (passkey "Scan to open on computer", VITE_SEEDLESS).
 * Reuses the unlock item: reading the sealed passKey needs the biometric prompt, and it must still decrypt this
 * account's keys, so a pass proves the owner is present on an enrolled device. Nothing is read or changed besides
 * that. 'unavailable' = biometrics not set up here (caller falls back to the password).
 */
export const confirmWithBiometrics = async (reason: string): Promise<'ok' | 'cancelled' | 'unavailable'> => {
  if (!chromeApi || biometry === 'none') return 'unavailable';
  const { id, encryptedKeys } = await selectedAccount();
  if (!id || !encryptedKeys || !(await flag.get(ENROLLED(id)))) return 'unavailable';
  try {
    const passKey = (await YoursNative.biometricGet({ key: SEALED(id), reason })).value;
    const ok =
      !!passKey &&
      (await decrypt(encryptedKeys, passKey)
        .then((plain) => (JSON.parse(plain), true))
        .catch(() => false));
    return ok ? 'ok' : 'unavailable';
  } catch (error: any) {
    return error?.code === 'cancelled' ? 'cancelled' : 'unavailable';
  }
};
export const biometricLabel = () => (biometry === 'none' ? '' : label());
/** Show my 12 words: the biometric prompt as a second factor, leaving the lock state alone. */
const verify = async (reason: string): Promise<boolean> => {
  const { id, encryptedKeys } = await selectedAccount();
  if (!id || !encryptedKeys || !(await isEnrolled())) return false;
  try {
    const passKey = (await YoursNative.biometricGet({ key: SEALED(id), reason })).value;
    if (!passKey) return false;
    return await decrypt(encryptedKeys, passKey)
      .then((plain) => (JSON.parse(plain), true))
      .catch(() => false);
  } catch {
    return false;
  }
};

// Platform hooks -------------------------------------------------------------

const markAllForReenrol = async () => {
  const { accounts } = await chromeApi.storage.local.get('accounts');
  for (const id of Object.keys(accounts ?? {})) {
    if (!(await flag.get(ENROLLED(id)))) continue;
    await YoursNative.biometricRemove({ key: SEALED(id) }).catch(() => undefined);
    await flag.clear(ENROLLED(id));
    await flag.set(REENROL(id));
  }
};

const reenrolNotice = () => `${capitalised()} needs setting up again: unlock with your password once`;

const enrolmentState = async () => {
  const { id } = await selectedAccount();
  if (!id) return { enrolled: false, needsReenrol: false };
  return { enrolled: await flag.get(ENROLLED(id)), needsReenrol: await flag.get(REENROL(id)) };
};

const isEnrolled = async () => lockScreenMode(await enrolmentState()) === 'prompt';

const notice = async () => (lockScreenMode(await enrolmentState()) === 'reenrol' ? reenrolNotice() : undefined);

/**
 * Returns the hooks for src/platform.ts, or {} when biometrics aren't
 * available on this device.
 */
export const initBiometricUnlock = async (chrome: any): Promise<PlatformHooks> => {
  // Phones, and Desktop on a Mac with Touch ID (src-tauri/src/bio.rs).
  if (!isNative && !IS_TAURI) return {};
  chromeApi = chrome;
  const status = await YoursNative.biometricStatus().catch(() => ({ available: false, biometryType: 'none' as const }));
  if (!status.available) return {};
  biometry = status.biometryType;

  chrome.storage.onChanged.addListener((changes: any, area: string) => {
    // Wallet reset / sign-out: nothing sealed should outlive the accounts.
    if (area === 'local' && 'accounts' in changes && changes.accounts.newValue === undefined) {
      void YoursNative.biometricRemove({ key: '' });
    }
    // A new password key (password change, or the one-time 600k upgrade after a password unlock): the sealed key
    // no longer opens the wallet. Mark it for re-enrolment now, so the wallet-ready hook sets it up again with just
    // the system prompt instead of failing at the next Face ID unlock.
    if (
      area === 'local' &&
      'salt' in changes &&
      changes.salt.oldValue &&
      changes.salt.newValue !== changes.salt.oldValue
    ) {
      void markAllForReenrol();
    }
  });

  return {
    quickUnlock: {
      label: `Use ${label()}`,
      disableLabel: `Stop using ${label()}`,
      isAvailable: isEnrolled,
      unlock,
      disable,
      verify,
      autoPrompt: true,
      notice,
    },
    onWalletReady: () => void offerEnrolment(),
  };
};
