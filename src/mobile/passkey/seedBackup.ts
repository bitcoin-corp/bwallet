/**
 * Passkey seed backup (prototype, behind VITE_SEEDLESS=1, see docs/SEEDLESS-PASSKEY.md).
 *
 * The wallet still makes the normal 12 words. This file only seals those words with a key that comes from a
 * passkey's PRF output, so the user can get them back later with Face ID / fingerprint instead of paper:
 *
 *   PRF(passkey, PRF_SALT) -> 32 bytes -> HKDF-SHA256(salt = random 16 bytes, info = HKDF_INFO) -> AES-256-GCM key
 *
 * The blob is versioned JSON. Its header (version, rpId, credential id, hkdf salt) is the AES-GCM additional data,
 * so changing any of it makes decryption fail. Nothing here touches key derivation or the password keystore.
 * Pure WebCrypto; the WebAuthn calls live in prf.ts so this file is unit-tested without a browser.
 */

export const BLOB_KIND = 'bwalletx-passkey-seed-backup';
export const BLOB_VERSION = 1;
/** The label hashed into the fixed PRF eval input (one per wallet backup scheme, not secret). */
export const PRF_LABEL = 'bwalletx seed backup v1';
export const HKDF_INFO = 'bwalletx seed backup v1 aes-256-gcm';

export type SeedBackupBlob = {
  kind: typeof BLOB_KIND;
  v: 1;
  /** Relying party the passkey belongs to ("web.bwalletx.com" in production). */
  rpId: string;
  /** base64url credential id, so restore can ask for exactly this passkey. */
  credentialId: string;
  /** base64url random HKDF salt. */
  salt: string;
  /** base64url 12-byte AES-GCM IV. */
  iv: string;
  /** base64url ciphertext + tag. */
  ct: string;
  createdAt: string;
  /** Optional, shown on the restore screen so the user can tell backups apart. Not secret. */
  label?: string;
  /** Optional identity address of the account the words belong to (Settings lists accounts with a backup). */
  account?: string;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const fromB64url = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Fixed PRF input: SHA-256("bwalletx seed backup v1"). Same for every wallet, so any device can re-derive it. */
export const prfSalt = async (): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(PRF_LABEL)));

const aad = (b: Pick<SeedBackupBlob, 'v' | 'rpId' | 'credentialId' | 'salt'>) =>
  enc.encode(JSON.stringify([BLOB_KIND, b.v, b.rpId, b.credentialId, b.salt]));

const aesKey = async (prfOutput: Uint8Array, salt: Uint8Array): Promise<CryptoKey> => {
  if (prfOutput.length !== 32) throw new Error('PRF output must be 32 bytes');
  const ikm = await crypto.subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode(HKDF_INFO) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

export async function sealSeed(
  mnemonic: string,
  prfOutput: Uint8Array,
  meta: { rpId: string; credentialId: string; label?: string; account?: string },
): Promise<SeedBackupBlob> {
  const phrase = mnemonic.trim().split(/\s+/).join(' ');
  if (!phrase) throw new Error('Nothing to back up');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const head = { v: BLOB_VERSION as 1, rpId: meta.rpId, credentialId: meta.credentialId, salt: b64url(salt) };
  const key = await aesKey(prfOutput, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(head) as BufferSource },
      key,
      enc.encode(phrase),
    ),
  );
  return {
    kind: BLOB_KIND,
    ...head,
    iv: b64url(iv),
    ct: b64url(ct),
    createdAt: new Date().toISOString(),
    ...(meta.label ? { label: meta.label } : {}),
    ...(meta.account ? { account: meta.account } : {}),
  };
}

/** Throws on a wrong passkey, a tampered header or a damaged file (AES-GCM authenticates all three). */
export async function openSeed(blob: SeedBackupBlob, prfOutput: Uint8Array): Promise<string> {
  const key = await aesKey(prfOutput, fromB64url(blob.salt));
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(blob.iv) as BufferSource, additionalData: aad(blob) as BufferSource },
      key,
      fromB64url(blob.ct) as BufferSource,
    );
    return dec.decode(pt);
  } catch {
    throw new Error("This passkey doesn't open this backup.");
  }
}

/** Parse a recovery file or stored string; rejects anything that isn't a v1 blob (newer versions name themselves). */
export function parseSeedBackup(raw: string): SeedBackupBlob {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error('Not a bWalletX passkey backup file.');
  }
  const o = j as Partial<SeedBackupBlob> & { v?: unknown };
  if (!o || o.kind !== BLOB_KIND) throw new Error('Not a bWalletX passkey backup file.');
  if (o.v !== BLOB_VERSION) throw new Error(`Backup version ${String(o.v)} needs a newer bWalletX.`);
  for (const f of ['rpId', 'credentialId', 'salt', 'iv', 'ct'] as const) {
    if (typeof o[f] !== 'string' || !o[f]) throw new Error('This backup file is damaged.');
  }
  return o as SeedBackupBlob;
}

/** v1 local store: one list in localStorage (web app only; the blob is useless without the passkey). */
export const LOCAL_KEY = 'bwx:passkey-seed-backups';

export const loadLocalBackups = (store: Pick<Storage, 'getItem'> = localStorage): SeedBackupBlob[] => {
  try {
    const list = JSON.parse(store.getItem(LOCAL_KEY) ?? '[]') as unknown[];
    return list.flatMap((x) => {
      try {
        return [parseSeedBackup(JSON.stringify(x))];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

export const saveLocalBackup = (blob: SeedBackupBlob, store: Pick<Storage, 'getItem' | 'setItem'> = localStorage) => {
  const rest = loadLocalBackups(store).filter((b) => b.ct !== blob.ct);
  store.setItem(LOCAL_KEY, JSON.stringify([blob, ...rest].slice(0, 10)));
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * What a new passkey is called in the phone's passkey picker: "bWalletX · 20 Oct 14:32". Every passkey used to be
 * just "bWalletX", so with two of them on one address the picker showed identical entries and a restore that chose
 * the wrong one failed with "No backup found" (owner, 20 Oct 2026: the first restore failed, the second worked).
 */
export const passkeyName = (when: Date = new Date()): string => {
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  return `bWalletX · ${when.getDate()} ${MONTHS[when.getMonth()]} ${hh}:${mm}`;
};

export const backupFileName = (blob: SeedBackupBlob) =>
  `bwalletx-passkey-backup-${blob.createdAt.slice(0, 10)}-${blob.credentialId.slice(0, 6)}.json`;

/**
 * "Continue with a passkey" (no password to invent): the wallet's normal keystore password is derived from the same
 * PRF output with a different HKDF label, so it is unrelated to the backup key and never shown or typed. The
 * keystore format, unlock and change-password code are unchanged; the passkey just types the password for you.
 */
export const KEYSTORE_INFO = 'bwalletx keystore password v1';
export async function keystorePasswordFromPrf(prfOutput: Uint8Array): Promise<string> {
  if (prfOutput.length !== 32) throw new Error('PRF output must be 32 bytes');
  const ikm = await crypto.subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32) as BufferSource, info: enc.encode(KEYSTORE_INFO) },
    ikm,
    256,
  );
  return `pk1.${b64url(new Uint8Array(bits))}`;
}

/**
 * Which passkey unlocks this browser's wallet. Two kinds:
 * - made with "Continue with a passkey": no `sealed`, the password IS keystorePasswordFromPrf(prf);
 * - an existing password wallet that added a passkey (Settings): `sealed` holds the user's own password, AES-GCM
 *   under a PRF-derived key (its own HKDF label), so the typed password keeps working and the keystore is unchanged.
 */
export const UNLOCK_KEY = 'bwx:passkey-unlock';
export const UNLOCK_INFO = 'bwalletx unlock password v1';
export type SealedPassword = { salt: string; iv: string; ct: string };
export type PasskeyUnlock = { rpId: string; credentialId: string; sealed?: SealedPassword; addedAt?: string };

const unlockAad = (u: Pick<PasskeyUnlock, 'rpId' | 'credentialId'>) =>
  enc.encode(JSON.stringify([UNLOCK_KEY, 1, u.rpId, u.credentialId]));

const unlockKey = async (prfOutput: Uint8Array, salt: Uint8Array): Promise<CryptoKey> => {
  if (prfOutput.length !== 32) throw new Error('PRF output must be 32 bytes');
  const ikm = await crypto.subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode(UNLOCK_INFO) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

export async function sealPassword(
  password: string,
  prfOutput: Uint8Array,
  ids: Pick<PasskeyUnlock, 'rpId' | 'credentialId'>,
): Promise<PasskeyUnlock> {
  if (!password) throw new Error('No password to seal');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: unlockAad(ids) as BufferSource },
      await unlockKey(prfOutput, salt),
      enc.encode(password),
    ),
  );
  return {
    rpId: ids.rpId,
    credentialId: ids.credentialId,
    sealed: { salt: b64url(salt), iv: b64url(iv), ct: b64url(ct) },
    addedAt: new Date().toISOString(),
  };
}

/** The wallet password this passkey stands for (sealed one, or the derived one for passkey-made wallets). */
export async function unlockPasswordFromPrf(u: PasskeyUnlock, prfOutput: Uint8Array): Promise<string> {
  if (!u.sealed) return keystorePasswordFromPrf(prfOutput);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(u.sealed.iv) as BufferSource, additionalData: unlockAad(u) as BufferSource },
      await unlockKey(prfOutput, fromB64url(u.sealed.salt)),
      fromB64url(u.sealed.ct) as BufferSource,
    );
    return dec.decode(pt);
  } catch {
    throw new Error("This passkey doesn't unlock this wallet. Use your password.");
  }
}

export const loadPasskeyUnlock = (store: Pick<Storage, 'getItem'> = localStorage): PasskeyUnlock | null => {
  try {
    const o = JSON.parse(store.getItem(UNLOCK_KEY) ?? 'null') as PasskeyUnlock | null;
    return o && typeof o.rpId === 'string' && typeof o.credentialId === 'string' ? o : null;
  } catch {
    return null;
  }
};
export const savePasskeyUnlock = (u: PasskeyUnlock, store: Pick<Storage, 'setItem'> = localStorage) =>
  store.setItem(UNLOCK_KEY, JSON.stringify(u));

/** Settings › Remove passkey: forget the unlock record and every local backup sealed with that passkey. */
export const removePasskey = (store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage) => {
  const u = loadPasskeyUnlock(store);
  store.removeItem(UNLOCK_KEY);
  if (!u) return;
  const rest = loadLocalBackups(store).filter((b) => b.credentialId !== u.credentialId);
  store.setItem(LOCAL_KEY, JSON.stringify(rest));
};
