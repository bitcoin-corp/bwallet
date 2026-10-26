import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { IS_TAURI, tauriNative } from './desktop/ipc';

/**
 * YoursNative: the app's own native plugin (ios/App/App/YoursNativePlugin.swift,
 * android/.../YoursNativePlugin.java). Kept in-repo rather than using third-party
 * plugins because it holds the keystore and the biometric-protected passKey.
 *
 * - secure*: Keychain (ThisDeviceOnly, excluded from backups) / Android Keystore-wrapped prefs.
 * - biometric*: an item readable only after Face ID / Touch ID / fingerprint.
 * - browser*: in-app browser for dApps; native supplies each request's origin.
 */

export type BiometryType = 'faceId' | 'touchId' | 'opticId' | 'fingerprint' | 'none';

export type BrowserRequest = {
  requestId: string;
  /** Trusted: from the native WebView's frame info, never from page script. */
  origin: string;
  url: string;
  payload: string;
};

export interface YoursNativePlugin {
  secureGet(opts: { key: string }): Promise<{ value: string | null }>;
  secureSet(opts: { key: string; value: string }): Promise<void>;
  secureRemove(opts: { key: string }): Promise<void>;
  secureKeys(): Promise<{ keys: string[] }>;

  biometricStatus(): Promise<{ available: boolean; biometryType: BiometryType }>;
  biometricSet(opts: { key: string; value: string }): Promise<void>;
  /** Rejects with code 'cancelled' if the user dismisses the prompt. */
  biometricGet(opts: { key: string; reason: string }): Promise<{ value: string | null }>;
  biometricRemove(opts: { key: string }): Promise<void>;
  /**
   * Face ID / Touch ID / fingerprint OR the phone's passcode (iOS deviceOwnerAuthentication, Android
   * BiometricPrompt + DEVICE_CREDENTIAL). Phones only; optional so the web and desktop shims can leave it out.
   */
  deviceOwnerAuth?(opts: { reason: string }): Promise<{ ok: boolean }>;

  browserOpen(opts: { url: string; provider: string }): Promise<void>;
  browserClose(): Promise<void>;
  browserSetHidden(opts: { hidden: boolean }): Promise<void>;
  browserRespond(opts: { requestId: string; response: string }): Promise<void>;
  /** Dispatch a provider event (account/network change) into the page. */
  browserEmit(opts: { event: string; detail: string }): Promise<void>;
  /** Android: the package that installed this app (com.android.vending = Google Play); null if unknown. */
  installerPackage(): Promise<{ installer: string | null }>;

  /** bWallet calls: route call audio to the loudspeaker (true) or the earpiece (false). */
  audioSetSpeaker(opts: { on: boolean }): Promise<void>;

  /** iOS: ASWebAuthenticationSession; resolves with the `<scheme>://…` URL it ended on, rejects 'cancelled'. */
  authSession(opts: { url: string; scheme: string; httpsHost?: string; httpsPath?: string }): Promise<{ url: string }>;

  /** Open this app's page in the OS Settings app (iOS: app-settings:, Android: app details). */
  openAppSettings(): Promise<void>;
  /** Android: open an intent://…;scheme=https;package=… return URL (pair/openReturn.ts); https fallback inside. */
  openIntentUri?(opts: { uri: string }): Promise<void>;
  /** iOS: AVCaptureDevice access for the mic or camera; prompts the first time. */
  mediaAccess(opts: { kind: 'mic' | 'camera' }): Promise<{ granted: boolean }>;

  /** iOS: which APNs gateway this build's push token is for (Debug builds → sandbox). */
  pushEnv(): Promise<{ env: 'production' | 'sandbox' }>;

  /** Hold the dock's b to talk (agent/voice.ts): iOS SFSpeechRecognizer, Android SpeechRecognizer. */
  speechAvailable(): Promise<{ available: boolean }>;
  /** Asks for the mic / speech permission the first time; resolves once listening (or why not). */
  speechStart(): Promise<{ started: boolean; reason?: 'denied' | 'asked' | 'unavailable' | 'error' }>;
  /** Stops and resolves with the final transcript. */
  speechStop(): Promise<{ text: string }>;
  speechCancel(): Promise<void>;
  /** A short haptic tick. */
  haptic(): Promise<void>;

  /**
   * Copy a secret (secretClipboard.ts): Android marks the clip sensitive; iOS writes a local-only item that
   * expires after `seconds`. Resolves a token identifying this clip for secretClear.
   */
  secretCopy(opts: { text: string; seconds: number }): Promise<{ token: string }>;
  /** Clears the clipboard only if it still holds the clip `token` names (never reads its text on iOS). */
  secretClear(opts: { token: string }): Promise<void>;

  addListener(event: 'speechPartial', fn: (e: { text: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'speechLevel', fn: (e: { level: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'browserRequest', fn: (req: BrowserRequest) => void): Promise<PluginListenerHandle>;
  addListener(event: 'browserClosed', fn: () => void): Promise<PluginListenerHandle>;
}

/** Browser-preview fallback: plain storage, no biometrics, links open in a tab. */
const web: Partial<YoursNativePlugin> = {
  async secureGet({ key }) {
    return { value: localStorage.getItem(`secure:${key}`) };
  },
  async secureSet({ key, value }) {
    localStorage.setItem(`secure:${key}`, value);
  },
  async secureRemove({ key }) {
    localStorage.removeItem(`secure:${key}`);
  },
  async secureKeys() {
    return {
      keys: Object.keys(localStorage)
        .filter((k) => k.startsWith('secure:'))
        .map((k) => k.slice(7)),
    };
  },
  async biometricStatus() {
    return { available: false, biometryType: 'none' };
  },
  async biometricRemove() {},
  async browserOpen({ url }) {
    window.open(url, '_blank', 'noopener');
  },
  async browserClose() {},
  async browserSetHidden() {},
  async browserRespond() {},
  async browserEmit() {},
  async audioSetSpeaker() {},
  async installerPackage() {
    return { installer: null };
  },
  async speechAvailable() {
    return { available: false };
  },
  async haptic() {
    navigator.vibrate?.(15);
  },
  async secretCopy({ text }) {
    await navigator.clipboard.writeText(text);
    return { token: '' };
  },
  async secretClear() {},
};

export const YoursNative = registerPlugin<YoursNativePlugin>('YoursNative', {
  // Desktop (Tauri): keystore, flags and biometrics go to the Rust side (desktop/ipc.ts); the rest stays web.
  web: () => (IS_TAURI ? { ...web, ...tauriNative() } : web) as YoursNativePlugin,
});

export const isNative = Capacitor.isNativePlatform();
