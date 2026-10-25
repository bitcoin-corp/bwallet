/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import CryptoJS from 'crypto-js';
import {
  KDF_ITERATIONS,
  LEGACY_KDF_ITERATIONS,
  decrypt,
  deriveKey,
  encrypt,
  generateWalletSalt,
  isLegacySalt,
  pbkdf2Hex,
  saltIterations,
} from './crypto';

const PW = 'correct horse battery staple';
const LEGACY_SALT = '00112233445566778899aabbccddeeff';

describe('password key derivation', () => {
  test('legacy 100k salt: unchanged golden value, and Web Crypto agrees with crypto-js', async () => {
    const k = await deriveKey(PW, LEGACY_SALT);
    expect(k).toBe('7f795f6b204d36c5d1749d64fd20167c1273cf892a6bb6969b2fd83700308801');
    expect(await pbkdf2Hex(PW, LEGACY_SALT, LEGACY_KDF_ITERATIONS)).toBe(k);
    const cj = CryptoJS.PBKDF2(PW, LEGACY_SALT, { keySize: 8, iterations: 1000, hasher: CryptoJS.algo.SHA256 });
    expect(await pbkdf2Hex(PW, LEGACY_SALT, 1000)).toBe(cj.toString(CryptoJS.enc.Hex));
  });

  test('new salts name 600k and round-trip a keystore entry', async () => {
    const salt = generateWalletSalt();
    expect(salt.startsWith(`pbkdf2:${KDF_ITERATIONS}:`)).toBe(true);
    expect(saltIterations(salt)).toBe(KDF_ITERATIONS);
    expect(isLegacySalt(salt)).toBe(false);
    const key = await deriveKey(PW, salt);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(await pbkdf2Hex(PW, salt.split(':')[2], KDF_ITERATIONS));
    expect(key).not.toBe(await deriveKey(PW, LEGACY_SALT));
    expect(await decrypt(await encrypt('{"k":1}', key), key)).toBe('{"k":1}');
    expect(await deriveKey('wrong password', salt)).not.toBe(key);
  });

  test('salt parsing: legacy, tagged, and refusals', async () => {
    expect(saltIterations(LEGACY_SALT)).toBe(LEGACY_KDF_ITERATIONS);
    expect(isLegacySalt(LEGACY_SALT)).toBe(true);
    expect(isLegacySalt(undefined)).toBe(false);
    expect(saltIterations('pbkdf2:600000:zz')).toBeNull();
    expect(saltIterations('pbkdf2:1000:00112233445566778899aabbccddeeff')).toBeNull();
    expect(saltIterations('pbkdf2:99999999:00112233445566778899aabbccddeeff')).toBeNull();
    expect(saltIterations('nope')).toBeNull();
    await expect(deriveKey(PW, 'pbkdf2:099999:00112233445566778899aabbccddeeff')).rejects.toThrow();
  });
});

// --- upgrade after unlock -----------------------------------------------------------------------------------------

type Store = Record<string, any>;
let local: Store;
let session: Store;
let failSet = false;

const pick = (s: Store, keys: string | string[] | null) => {
  if (keys === null) return structuredClone(s);
  const out: Store = {};
  for (const k of typeof keys === 'string' ? [keys] : keys) if (k in s) out[k] = structuredClone(s[k]);
  return out;
};

// Bun shares globals across test files: put the real (or absent) chrome back afterwards.
const prevChrome = (globalThis as any).chrome;
afterAll(() => {
  (globalThis as any).chrome = prevChrome;
});

(globalThis as any).chrome = {
  runtime: { lastError: undefined },
  storage: {
    onChanged: { addListener: () => undefined },
    local: {
      get: (keys: any, cb: (r: Store) => void) => {
        (globalThis as any).chrome.runtime.lastError = undefined;
        cb(pick(local, keys));
      },
      set: (obj: Store, cb?: () => void) => {
        if (!failSet) Object.assign(local, structuredClone(obj));
        (globalThis as any).chrome.runtime.lastError = failSet ? new Error('disk full') : undefined;
        cb?.();
      },
    },
    session: {
      get: async (keys: any) => pick(session, keys),
      set: async (obj: Store) => void Object.assign(session, obj),
      remove: async (keys: string[]) => keys.forEach((k) => delete session[k]),
    },
  },
};

const { ChromeStorageService } = await import('../services/ChromeStorage.service');

const plainA = JSON.stringify({ mnemonic: 'a b c', walletWif: 'wif-a' });
const plainB = JSON.stringify({ mnemonic: 'd e f', walletWif: 'wif-b' });

const service = async () => {
  const svc = new ChromeStorageService();
  (svc as any).getAndSetStorage = async () => undefined;
  await svc.setPassKey(await deriveKey(PW, LEGACY_SALT));
  return svc;
};

beforeEach(async () => {
  failSet = false;
  session = {};
  const oldKey = await deriveKey(PW, LEGACY_SALT);
  local = {
    salt: LEGACY_SALT,
    accounts: {
      '1A': { addresses: { identityAddress: '1A' }, encryptedKeys: await encrypt(plainA, oldKey) },
      '1B': { addresses: { identityAddress: '1B' }, encryptedKeys: await encrypt(plainB, oldKey) },
      '1W': { addresses: { identityAddress: '1W' } },
    },
  };
});

describe('upgradeKdf: 100k wallet moves to 600k after a password unlock', () => {
  test('re-encrypts every account under the 600k key, swaps the session key, old key stops working', async () => {
    const svc = await service();
    const before = structuredClone(local.accounts);
    expect(await svc.upgradeKdf(PW)).toBe(true);
    expect(saltIterations(local.salt)).toBe(KDF_ITERATIONS);
    const newKey = await deriveKey(PW, local.salt);
    expect(await svc.getPassKey()).toBe(newKey);
    expect(session.passKey).toBe(newKey);
    expect(await decrypt(local.accounts['1A'].encryptedKeys, newKey)).toBe(plainA);
    expect(await decrypt(local.accounts['1B'].encryptedKeys, newKey)).toBe(plainB);
    expect(local.accounts['1W']).toEqual(before['1W']);
    await expect(decrypt(local.accounts['1A'].encryptedKeys, await deriveKey(PW, LEGACY_SALT))).rejects.toThrow();
    // Second unlock: nothing left to do.
    expect(await svc.upgradeKdf(PW)).toBe(false);
  });

  test('a wrong password changes nothing', async () => {
    const svc = await service();
    const snap = structuredClone(local);
    expect(await svc.upgradeKdf('not the password')).toBe(false);
    expect(local).toEqual(snap);
    expect(session.passKey).toBe(await deriveKey(PW, LEGACY_SALT));
  });

  test('USB key security on: skipped, nothing changes', async () => {
    local.usbSecurity = { enabled: true };
    const svc = await service();
    const snap = structuredClone(local);
    expect(await svc.upgradeKdf(PW)).toBe(false);
    expect(local).toEqual(snap);
  });

  test('a blob that will not open: nothing is written, the old wallet still opens', async () => {
    local.accounts['1B'].encryptedKeys = 'v2:' + '00'.repeat(40);
    const svc = await service();
    const snap = structuredClone(local);
    expect(await svc.upgradeKdf(PW)).toBe(false);
    expect(local).toEqual(snap);
    expect(await decrypt(local.accounts['1A'].encryptedKeys, await deriveKey(PW, LEGACY_SALT))).toBe(plainA);
  });

  test('a failed write keeps the old key in the session (old data still opens)', async () => {
    const svc = await service();
    failSet = true;
    const snap = structuredClone(local);
    expect(await svc.upgradeKdf(PW)).toBe(false);
    expect(local).toEqual(snap);
    expect(await svc.getPassKey()).toBe(await deriveKey(PW, LEGACY_SALT));
  });

  test('old AES-CBC keystore entries are carried over to the 600k key as AES-GCM', async () => {
    const oldKey = await deriveKey(PW, LEGACY_SALT);
    const salt = CryptoJS.lib.WordArray.random(16);
    const iv = CryptoJS.lib.WordArray.random(16);
    const k = CryptoJS.PBKDF2(oldKey, salt, { keySize: 8, iterations: 1000 });
    const ct = CryptoJS.AES.encrypt(plainB, k, { iv }).toString();
    local.accounts['1B'].encryptedKeys = salt.toString() + iv.toString() + ct;
    expect(await decrypt(local.accounts['1B'].encryptedKeys, oldKey)).toBe(plainB);
    const svc = await service();
    expect(await svc.upgradeKdf(PW)).toBe(true);
    expect(local.accounts['1B'].encryptedKeys.startsWith('v2:')).toBe(true);
    expect(await decrypt(local.accounts['1B'].encryptedKeys, await deriveKey(PW, local.salt))).toBe(plainB);
  });

  test('killed between the two writes (phones store accounts and salt separately): unlock repairs the salt', async () => {
    local.selectedAccount = '1A';
    const svc = await service();
    expect(await svc.upgradeKdf(PW)).toBe(true);
    const newSalt = local.salt;
    // New blobs, old salt, recovery note still there.
    local.salt = LEGACY_SALT;
    local.kdfPending = { prevSalt: LEGACY_SALT, salt: newSalt };
    (svc as any).storage = local;
    expect(await svc.verifyPassword('wrong password')).toBe(false);
    expect(local.salt).toBe(LEGACY_SALT);
    expect(await svc.verifyPassword(PW)).toBe(true);
    expect(local.salt).toBe(newSalt);
    expect(local.kdfPending).toBeNull();
    expect(await svc.getPassKey()).toBe(await deriveKey(PW, newSalt));
  });

  test('killed the other way round (new salt, old blobs): unlock goes back to the old salt, upgrade retries', async () => {
    local.selectedAccount = '1A';
    const svc = await service();
    const pendingSalt = generateWalletSalt();
    local.salt = pendingSalt;
    local.kdfPending = { prevSalt: LEGACY_SALT, salt: pendingSalt };
    (svc as any).storage = local;
    expect(await svc.verifyPassword(PW)).toBe(true);
    expect(local.salt).toBe(LEGACY_SALT);
    expect(await svc.upgradeKdf(PW)).toBe(true);
    expect(await decrypt(local.accounts['1A'].encryptedKeys, await deriveKey(PW, local.salt))).toBe(plainA);
  });

  test('the unlock screen runs it, only with the USB key off', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../components/UnlockWallet.tsx', import.meta.url), 'utf8');
    expect(src).toContain('if (!usbEnabled) await chromeStorageService.upgradeKdf(password)');
  });
});
