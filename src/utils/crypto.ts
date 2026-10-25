import { ECIES, PrivateKey, PublicKey, Utils } from '@bsv/sdk';
import CryptoJS from 'crypto-js';

const V2_PREFIX = 'v2:';

// --- Key derivation ---
//
// The wallet salt carries its own PBKDF2 iteration count, so every place that already stores or copies the salt
// (storage, master backups, USB restore.json) carries the count with it and needs no format change:
//   untagged 32-hex salt          → legacy 100,000 iterations, crypto-js, exactly as before (never changes)
//   "pbkdf2:<iterations>:<hex>"   → PBKDF2-SHA256 at that count via Web Crypto (new wallets + upgraded ones: 600,000)
// Old wallets are upgraded after the next password unlock (ChromeStorageService.upgradeKdf).

export const LEGACY_KDF_ITERATIONS = 100_000;
export const KDF_ITERATIONS = 600_000;
const MAX_KDF_ITERATIONS = 10_000_000;
const TAGGED_SALT = /^pbkdf2:(\d{6,8}):([0-9a-f]{16,128})$/;

/** The iteration count a stored salt asks for, or null when the salt is not one we wrote. */
export const saltIterations = (salt: string): number | null => {
  if (typeof salt !== 'string') return null;
  const m = TAGGED_SALT.exec(salt);
  if (!m) return /^[0-9a-f]{16,128}$/.test(salt) ? LEGACY_KDF_ITERATIONS : null;
  const n = Number(m[1]);
  return n >= LEGACY_KDF_ITERATIONS && n <= MAX_KDF_ITERATIONS ? n : null;
};

/** True for a salt still on the old 100k derivation (upgrade it after the next password unlock). */
export const isLegacySalt = (salt: string | undefined): boolean =>
  !!salt && saltIterations(salt) === LEGACY_KDF_ITERATIONS && !TAGGED_SALT.test(salt);

export const deriveKey = async (password: string, salt: string): Promise<string> => {
  const m = TAGGED_SALT.exec(salt);
  if (!m) {
    // Legacy: unchanged, or every existing password would stop working.
    const key = CryptoJS.PBKDF2(password, salt, {
      keySize: 256 / 32,
      iterations: LEGACY_KDF_ITERATIONS,
      // crypto-js 4.2 defaults to SHA-256 but 4.1.x defaulted to SHA-1 and the
      // dependency range spans both. Pin it so a resolver change can't silently
      // invalidate every stored password.
      hasher: CryptoJS.algo.SHA256,
    });
    return key.toString(CryptoJS.enc.Hex);
  }
  const iterations = saltIterations(salt);
  if (!iterations) throw new Error('Unsupported key derivation settings');
  return pbkdf2Hex(password, m[2], iterations);
};

/** PBKDF2-SHA256, 32 bytes, hex. Password and salt string are UTF-8, the same inputs crypto-js uses. */
export const pbkdf2Hex = async (password: string, salt: string, iterations: number): Promise<string> => {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password) as BufferSource, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt) as BufferSource, iterations },
    base,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
};

export const generateRandomSalt = (length = 16) => {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(length)));
};

/** A fresh wallet salt at the current iteration count. */
export const generateWalletSalt = (iterations = KDF_ITERATIONS) => `pbkdf2:${iterations}:${generateRandomSalt()}`;

// --- Hex conversion helpers ---

export const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

export const bytesToHex = (bytes: Uint8Array): string => {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

// --- v2: AES-256-GCM via Web Crypto API (passKey used directly as key) ---

const importKey = async (passKeyHex: string): Promise<CryptoKey> => {
  return crypto.subtle.importKey('raw', hexToBytes(passKeyHex).buffer as ArrayBuffer, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
};

export const encrypt = async (textToEncrypt: string, passKeyHex: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV per NIST recommendation for GCM
  const key = await importKey(passKeyHex);
  const encoded = new TextEncoder().encode(textToEncrypt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  // GCM auth tag is appended to ciphertext automatically
  return V2_PREFIX + bytesToHex(iv) + bytesToHex(new Uint8Array(ciphertext));
};

// --- Decrypt: v2 (AES-GCM) or legacy (CryptoJS AES-CBC with 1k-iteration PBKDF2) ---

export const decrypt = async (data: string, passKeyHex: string): Promise<string> => {
  if (data.startsWith(V2_PREFIX)) {
    const payload = data.slice(V2_PREFIX.length);
    const iv = hexToBytes(payload.slice(0, 24)); // 12 bytes = 24 hex chars
    const ciphertext = hexToBytes(payload.slice(24));
    const key = await importKey(passKeyHex);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
      key,
      ciphertext.buffer as ArrayBuffer,
    );
    return new TextDecoder().decode(decrypted);
  }

  // Legacy: salt(32 hex) + iv(32 hex) + base64 ciphertext, PBKDF2 1k iterations AES-CBC
  return decryptLegacy(data, passKeyHex);
};

const decryptLegacy = (saltedCiphertext: string, password: string): string => {
  const salt = CryptoJS.enc.Hex.parse(saltedCiphertext.slice(0, 32));
  const iv = CryptoJS.enc.Hex.parse(saltedCiphertext.slice(32, 64));
  const ciphertext = saltedCiphertext.slice(64);

  const key256Bits = CryptoJS.PBKDF2(password, salt, {
    keySize: 256 / 32,
    iterations: 1000,
  });

  const bytes = CryptoJS.AES.decrypt(ciphertext, key256Bits, { iv });
  return bytes.toString(CryptoJS.enc.Utf8);
};

// --- ECIES (unchanged) ---

export const encryptUsingPrivKey = (
  message: string,
  encoding: 'utf8' | 'hex' | 'base64' = 'utf8',
  pubKeys: PublicKey[],
  privateKey: PrivateKey,
) => {
  const msgBuf = Utils.toArray(message, encoding);
  return pubKeys.map((pubKey) => Utils.toBase64(ECIES.electrumEncrypt(msgBuf, pubKey, privateKey)));
};

export const decryptUsingPrivKey = (messages: string[], privateKey: PrivateKey) => {
  return messages.map((m) => Utils.toBase64(ECIES.electrumDecrypt(Utils.toArray(m, 'base64'), privateKey)));
};
