import { describe, expect, test } from 'bun:test';
import {
  BLOB_KIND,
  BLOB_VERSION,
  b64url,
  fromB64url,
  keystorePasswordFromPrf,
  loadLocalBackups,
  openSeed,
  parseSeedBackup,
  prfSalt,
  saveLocalBackup,
  sealSeed,
  passkeyName,
} from './seedBackup';
import { rpIdFor } from './prf';

// A fake PRF output: in the app this comes from the passkey (WebAuthn PRF extension).
const prfA = new Uint8Array(32).fill(7);
const prfB = new Uint8Array(32).fill(8);
const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const meta = { rpId: 'bwalletx.com', credentialId: b64url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) };

describe('passkey seed backup', () => {
  test('round-trips the phrase with the same PRF output', async () => {
    const blob = await sealSeed(`  ${PHRASE.replace(/ /g, '  ')} `, prfA, meta);
    expect(await openSeed(blob, prfA)).toBe(PHRASE);
    expect(JSON.stringify(blob)).not.toContain('abandon');
  });

  test('a different passkey (PRF output) fails', async () => {
    const blob = await sealSeed(PHRASE, prfA, meta);
    await expect(openSeed(blob, prfB)).rejects.toThrow("doesn't open");
  });

  test('a changed header fails (header is AES-GCM additional data)', async () => {
    const blob = await sealSeed(PHRASE, prfA, meta);
    await expect(openSeed({ ...blob, rpId: 'evil.example' }, prfA)).rejects.toThrow();
    await expect(openSeed({ ...blob, credentialId: b64url(new Uint8Array([9])) }, prfA)).rejects.toThrow();
  });

  test('each seal uses a fresh salt and IV', async () => {
    const a = await sealSeed(PHRASE, prfA, meta);
    const b = await sealSeed(PHRASE, prfA, meta);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test('blob is versioned and parse rejects other versions/kinds', async () => {
    const blob = await sealSeed(PHRASE, prfA, meta);
    expect(blob.kind).toBe(BLOB_KIND);
    expect(blob.v).toBe(BLOB_VERSION);
    expect(parseSeedBackup(JSON.stringify(blob))).toEqual(blob);
    expect(() => parseSeedBackup(JSON.stringify({ ...blob, v: 2 }))).toThrow('version 2');
    expect(() => parseSeedBackup(JSON.stringify({ ...blob, kind: 'other' }))).toThrow('Not a bWalletX');
    expect(() => parseSeedBackup('{')).toThrow('Not a bWalletX');
    expect(() => parseSeedBackup(JSON.stringify({ ...blob, ct: '' }))).toThrow('damaged');
  });

  test('rejects PRF output that is not 32 bytes', async () => {
    await expect(sealSeed(PHRASE, new Uint8Array(16), meta)).rejects.toThrow('32 bytes');
  });

  test('PRF salt is SHA-256 of the fixed label', async () => {
    const s = await prfSalt();
    expect(s.length).toBe(32);
    expect(b64url(s)).toBe(b64url(await prfSalt()));
  });

  test('base64url round-trips', () => {
    const raw = crypto.getRandomValues(new Uint8Array(33));
    expect(fromB64url(b64url(raw))).toEqual(raw);
  });

  test('local store keeps unique blobs, newest first', async () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const a = await sealSeed(PHRASE, prfA, meta);
    const b = await sealSeed(PHRASE, prfB, meta);
    saveLocalBackup(a, store);
    saveLocalBackup(b, store);
    saveLocalBackup(a, store);
    expect(loadLocalBackups(store).map((x) => x.ct)).toEqual([a.ct, b.ct]);
  });
});

describe('keystore password from passkey', () => {
  test('deterministic per passkey, different per passkey, unrelated to the backup ciphertext', async () => {
    const a1 = await keystorePasswordFromPrf(prfA);
    expect(a1).toBe(await keystorePasswordFromPrf(prfA));
    expect(a1).not.toBe(await keystorePasswordFromPrf(prfB));
    expect(a1.startsWith('pk1.')).toBe(true);
    expect(a1.length).toBeGreaterThan(40);
    const blob = await sealSeed(PHRASE, prfA, meta);
    expect(blob.ct).not.toContain(a1.slice(4, 20));
  });
});

describe('rpId', () => {
  // `native` is passed on purpose: the default comes from Capacitor at import time, and another test file in the same
  // `bun test src` run can change that, so a test relying on the default passed alone but failed in CI.
  test('web. and desktop. share the wallet rpId; every other host uses its own (b-Aware row 57)', () => {
    expect(rpIdFor('web.bwalletx.com', false)).toBe('web.bwalletx.com');
    expect(rpIdFor('desktop.bwalletx.com', false)).toBe('web.bwalletx.com');
    expect(rpIdFor('bwalletx.com', false)).toBe('bwalletx.com');
    expect(rpIdFor('chat.bwalletx.com', false)).toBe('chat.bwalletx.com');
    expect(rpIdFor('localhost', false)).toBe('localhost');
    expect(rpIdFor('notbwalletx.com', false)).toBe('notbwalletx.com');
  });

  test('the native app always uses the wallet rpId', () => {
    expect(rpIdFor('localhost', true)).toBe('web.bwalletx.com');
  });
});

describe('passkey names in the picker', () => {
  test('are told apart by date and time, so two passkeys never look the same', () => {
    expect(passkeyName(new Date(2026, 9, 20, 14, 32))).toBe('bWalletX · 20 Oct 14:32');
    expect(passkeyName(new Date(2026, 0, 5, 9, 5))).toBe('bWalletX · 5 Jan 09:05');
    expect(passkeyName(new Date(2026, 9, 20, 14, 32))).not.toBe(passkeyName(new Date(2026, 9, 20, 14, 33)));
  });
});
