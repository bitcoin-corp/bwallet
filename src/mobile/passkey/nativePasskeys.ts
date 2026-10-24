/*
 * Native passkeys for the Capacitor apps (iOS + Android). The web view's origin is capacitor://localhost or
 * https://localhost, never bwalletx.com, so navigator.credentials can't use our rpId there. The "Passkeys" plugin
 * (ios/App/App/PasskeysPlugin.swift, android/.../PasskeysPlugin.java) asks the OS directly:
 *   iOS 18+   ASAuthorizationPlatformPublicKeyCredentialProvider + PRF (webcredentials:web.bwalletx.com entitlement)
 *   Android   Credential Manager (androidx.credentials) with extensions.prf (assetlinks.json on web.bwalletx.com)
 * Same rpId (web.bwalletx.com) and same PRF salt as the web, so one synced passkey opens the same backups everywhere.
 * All binary values cross the bridge as base64url strings.
 */
import { b64url, fromB64url } from './seedBackup';

/**
 * The wallet's rpId (web, desktop and the apps). Scoped to web.bwalletx.com, not the registrable domain: with
 * rpId bwalletx.com any *.bwalletx.com page could ask for the passkey and get the same PRF output, so the seed
 * backup would open from any subdomain (b-Aware row 57). desktop.bwalletx.com joins through Related Origin
 * Requests (public/.well-known/webauthn). The apps' AASA / assetlinks files live on
 * https://web.bwalletx.com/.well-known/.
 */
export const NATIVE_RP_ID = 'web.bwalletx.com';

export type NativePasskeyAvailability = {
  /** The OS can make/use passkeys for bwalletx.com from this app. */
  available: boolean;
  /** PRF is known to be supported (iOS 18+); null = can only be proven by trying (Android). */
  prf: boolean | null;
  /** Why not, in words for the check page. */
  reason?: string;
};

export type NativeCreateResult = { credentialId: string; prf?: string; prfEnabled?: boolean };
export type NativeGetResult = { credentialId: string; prf?: string };

export interface PasskeysPlugin {
  isAvailable(): Promise<NativePasskeyAvailability>;
  create(o: {
    rpId: string;
    rpName: string;
    userId: string;
    userName: string;
    challenge: string;
    prfSalt: string;
  }): Promise<NativeCreateResult>;
  get(o: { rpId: string; challenge: string; allowCredentials: string[]; prfSalt: string }): Promise<NativeGetResult>;
}

const NO_PRF_GET = "This passkey can't make a backup key (no PRF). Use your 12 words instead.";
const NO_PRF_CREATE = "This device's passkeys can't make a backup key (no PRF). Keep your 12 words safe instead.";

const rand = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Turn plugin rejections into the same user-facing messages as the web path. */
const friendly = (e: unknown): Error => {
  const code = (e as { code?: string })?.code;
  const msg = (e as { message?: string })?.message ?? String(e);
  if (code === 'CANCELLED') return new Error('No passkey was chosen.');
  if (code === 'NO_PRF') return new Error(NO_PRF_GET);
  if (code === 'UNSUPPORTED') return new Error(`Passkeys aren't available here: ${msg}`);
  return e instanceof Error ? e : new Error(msg);
};

export async function nativeGetPrf(
  plugin: PasskeysPlugin,
  salt: Uint8Array,
  rpId: string,
  credentialId?: string,
): Promise<{ credentialId: string; prf: Uint8Array }> {
  let r: NativeGetResult;
  try {
    r = await plugin.get({
      rpId,
      challenge: rand(32),
      allowCredentials: credentialId ? [credentialId] : [],
      prfSalt: b64url(salt),
    });
  } catch (e) {
    throw friendly(e);
  }
  if (!r?.credentialId) throw new Error('No passkey was chosen.');
  if (!r.prf) throw new Error(NO_PRF_GET);
  return { credentialId: r.credentialId, prf: fromB64url(r.prf) };
}

/** Make a passkey; if the OS gives PRF only at sign-in (Android, like Chrome), follow with one get(). */
export async function nativeCreateWithPrf(
  plugin: PasskeysPlugin,
  salt: Uint8Array,
  rpId: string,
  label: string,
): Promise<{ credentialId: string; prf: Uint8Array }> {
  let r: NativeCreateResult;
  try {
    r = await plugin.create({
      rpId,
      rpName: 'bWalletX',
      userId: rand(16),
      userName: label,
      challenge: rand(32),
      prfSalt: b64url(salt),
    });
  } catch (e) {
    const err = friendly(e);
    throw err.message === NO_PRF_GET ? new Error(NO_PRF_CREATE) : err;
  }
  if (!r?.credentialId) throw new Error('No passkey was made.');
  if (r.prf) return { credentialId: r.credentialId, prf: fromB64url(r.prf) };
  if (r.prfEnabled === false) throw new Error(NO_PRF_CREATE);
  return nativeGetPrf(plugin, salt, rpId, r.credentialId);
}
