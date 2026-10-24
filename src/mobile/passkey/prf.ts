/* WebAuthn PRF for the passkey seed backup (prototype). See docs/SEEDLESS-PASSKEY.md for the rpId choice. */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { STORE_BUILD } from '../storeBuild';
import { NATIVE_RP_ID, nativeCreateWithPrf, nativeGetPrf, type PasskeysPlugin } from './nativePasskeys';
import { b64url, fromB64url, prfSalt } from './seedBackup';

/** iOS / Android apps: passkeys go through the native "Passkeys" plugin (nativePasskeys.ts), not the web view. */
const IS_NATIVE = Capacitor.isNativePlatform();
const Passkeys = registerPlugin<PasskeysPlugin>('Passkeys');

/**
 * Off everywhere unless built with VITE_SEEDLESS=1, and never in a store build (the App Store / Play shells can't
 * use web passkeys for bwalletx.com anyway, see the doc). Written literally so Vite drops the code when off.
 */
export const SEEDLESS_ENABLED: boolean = import.meta.env.VITE_SEEDLESS === '1' && !STORE_BUILD;

/**
 * The only hosts that use the wallet's rpId (web.bwalletx.com). An explicit list, never a wildcard over
 * *.bwalletx.com (same rule as WALLET_ORIGINS in openHere.ts): other subdomains must not be able to reach the
 * seed backup. desktop. is allowed by the browser through https://web.bwalletx.com/.well-known/webauthn.
 * Anywhere else (bwalletx.com, other subdomains, localhost, previews) uses its own host, so a passkey made there
 * only works there and opens nothing of the wallet's.
 */
export const WALLET_RP_HOSTS: readonly string[] = ['web.bwalletx.com', 'desktop.bwalletx.com'];

export const rpIdFor = (hostname: string, native = IS_NATIVE): string =>
  native || WALLET_RP_HOSTS.includes(hostname) ? NATIVE_RP_ID : hostname;

export type PrfSupport = {
  webauthn: boolean;
  secureContext: boolean;
  platformAuthenticator: boolean | null;
  /** From PublicKeyCredential.getClientCapabilities() where the browser has it; null = the browser didn't say. */
  prfCapability: boolean | null;
  origin: string;
  rpId: string;
  /** Our best guess before trying: only a real create() proves it (prf.enabled). */
  likely: boolean;
  notes: string[];
};

type PKC = typeof PublicKeyCredential & {
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
};

export async function detectPrfSupport(): Promise<PrfSupport> {
  if (IS_NATIVE) {
    const origin = typeof location === 'undefined' ? '' : location.origin;
    try {
      const a = await Passkeys.isAvailable();
      return {
        webauthn: a.available,
        secureContext: true,
        platformAuthenticator: a.available,
        prfCapability: a.prf,
        origin,
        rpId: NATIVE_RP_ID,
        likely: a.available && a.prf !== false,
        notes: [`Native passkeys (${Capacitor.getPlatform()})`, ...(a.reason ? [a.reason] : [])],
      };
    } catch (e) {
      const why = `Passkeys plugin missing: ${String(e)}`;
      return {
        webauthn: false,
        secureContext: true,
        platformAuthenticator: false,
        prfCapability: false,
        origin,
        rpId: NATIVE_RP_ID,
        likely: false,
        notes: [why],
      };
    }
  }
  const notes: string[] = [];
  const loc = typeof location === 'undefined' ? undefined : location;
  const origin = loc?.origin ?? '';
  const rpId = rpIdFor(loc?.hostname ?? '');
  const secureContext = typeof isSecureContext !== 'undefined' && isSecureContext;
  const P = (typeof window !== 'undefined' ? window.PublicKeyCredential : undefined) as PKC | undefined;
  const webauthn = !!P && !!navigator.credentials?.create;
  let platformAuthenticator: boolean | null = null;
  let prfCapability: boolean | null = null;
  if (P) {
    try {
      platformAuthenticator = await P.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      platformAuthenticator = null;
    }
    if (typeof P.getClientCapabilities === 'function') {
      try {
        const caps = await P.getClientCapabilities();
        if ('extension:prf' in caps) prfCapability = !!caps['extension:prf'];
      } catch {
        notes.push('getClientCapabilities() threw');
      }
    } else notes.push('No getClientCapabilities(): PRF can only be proven by making a test passkey.');
  }
  if (origin.startsWith('chrome-extension:')) notes.push('Chrome extension origin: cannot use the bwalletx.com rpId.');
  if (origin.startsWith('capacitor:') || origin === 'https://localhost' || origin === 'http://localhost')
    notes.push('Looks like a Capacitor shell: the web origin does not match bwalletx.com, a native plugin is needed.');
  const likely = webauthn && secureContext && prfCapability !== false && !origin.startsWith('chrome-extension:');
  return { webauthn, secureContext, platformAuthenticator, prfCapability, origin, rpId, likely, notes };
}

type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } };

const prfOut = (ext: AuthenticationExtensionsClientOutputs): PrfResults | undefined =>
  (ext as { prf?: PrfResults }).prf;

const bytes = (b: ArrayBuffer | ArrayBufferView): Uint8Array =>
  b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** Ask the passkey for its PRF output. With no credentialId the browser offers any passkey for this rpId. */
export async function getPrf(rpId: string, credentialId?: string): Promise<{ credentialId: string; prf: Uint8Array }> {
  const first = await prfSalt();
  if (IS_NATIVE) return nativeGetPrf(Passkeys, first, rpId, credentialId);
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId,
      userVerification: 'required',
      allowCredentials: credentialId ? [{ type: 'public-key', id: fromB64url(credentialId) as BufferSource }] : [],
      extensions: { prf: { eval: { first } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was chosen.');
  const out = prfOut(cred.getClientExtensionResults())?.results?.first;
  if (!out) throw new Error("This passkey can't make a backup key (no PRF). Use your 12 words instead.");
  return { credentialId: b64url(new Uint8Array(cred.rawId)), prf: bytes(out) };
}

/**
 * Make a new passkey for this wallet and get its PRF output. Chrome returns only prf.enabled at create time; Safari
 * and some security keys return results too. When there are none, one get() follows (a second Face ID prompt).
 * The user handle is random: the passkey doesn't identify the wallet, the blob does.
 */
export async function createPasskeyWithPrf(
  rpId: string,
  label: string,
): Promise<{ credentialId: string; prf: Uint8Array }> {
  const first = await prfSalt();
  if (IS_NATIVE) return nativeCreateWithPrf(Passkeys, first, rpId, label);
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: rpId, name: 'bWalletX' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was made.');
  const credentialId = b64url(new Uint8Array(cred.rawId));
  const prf = prfOut(cred.getClientExtensionResults());
  if (prf?.results?.first) return { credentialId, prf: bytes(prf.results.first) };
  if (prf?.enabled === false || !prf)
    throw new Error("This device's passkeys can't make a backup key (no PRF). Keep your 12 words safe instead.");
  return getPrf(rpId, credentialId);
}
