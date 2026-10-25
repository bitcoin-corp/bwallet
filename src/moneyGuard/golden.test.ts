import { describe, expect, test } from 'bun:test';
import { unzipSync } from 'fflate';
import { getKeys, getKeysFromWifs, getTaggedDerivationKeys } from '../utils/keys';
import { decrypt, deriveKey } from '../utils/crypto';
import { openBackup } from '../utils/backupEnvelope';
import {
  b64url,
  keystorePasswordFromPrf,
  openSeed,
  prfSalt,
  unlockPasswordFromPrf,
  type PasskeyUnlock,
  type SeedBackupBlob,
} from '../mobile/passkey/seedBackup';

/**
 * Known-answer tests for the code that decides where users' money lives (docs/MONEY-GUARD.md).
 *
 * Every value below was produced by the shipped code (5.2.39) from public test inputs: the BIP39 test phrase
 * "abandon … about", fixed passwords and a PRF output of 32 × 0x07. No real wallet is involved.
 * If one of these fails, a change has moved addresses or broken old passwords/backups: existing users would
 * open the wallet and see nothing, or be unable to decrypt. Do NOT update the expected values to make the test
 * pass; find what changed. A deliberate format change needs a migration and keeps reading the old format.
 */
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PRF = new Uint8Array(32).fill(7);

describe('money guard: addresses from a seed phrase', () => {
  const k = getKeys(PHRASE);
  test('pay, ordinals and identity addresses are unchanged', () => {
    expect(k.walletAddress).toBe('125GFsvYsDtyzGkExfsX8DoHuXu2UsMUEZ');
    expect(k.walletPubKey).toBe('0358d3f1aa8bf1e2861b68868b14e0be3b70206c8fbc1bea45e1cc344b4cc5aab5');
    expect(k.ordAddress).toBe('18pBoqRpHUYf9udsab5G9LT3vQUPxEyMFf');
    expect(k.ordPubKey).toBe('02b57f7dd17dba181abc49d158f3921a66ea5a4ca8d106114cb51583549c12ef41');
    expect(k.identityAddress).toBe('16UeyS7TvuQDwYreJpZqZceEKWbjzt4JW4');
    expect(k.identityPubKey).toBe('02140e1442a7a138870b36f84e41c07bb84068b3260542a0e5b7efd32f068d29e6');
  });
  test('derivation paths are unchanged', () => {
    expect(k.walletDerivationPath).toBe("m/44'/236'/0'/1/0");
    expect(k.ordDerivationPath).toBe("m/44'/236'/1'/0/0");
    expect(k.identityDerivationPath).toBe("m/0'/236'/0'/0/0");
  });
  test('WIF-only import derives the same fallback identity', () => {
    expect(getKeysFromWifs({ payPk: k.walletWif, ordPk: k.ordWif }).identityAddress).toBe(
      '17eeAXLRcX8kCNooQpWtefXz7T6ApWAGH7',
    );
  });
  test('tagged (app) keys are unchanged', () => {
    expect(getTaggedDerivationKeys({ label: 'bchat', id: 'room' }, PHRASE).address).toBe(
      '1Ly7Z1VBeesRY4B32FkhtdNxono9yBwM5U',
    );
  });
});

// Legacy (untagged) salt: the 100k derivation every existing wallet uses must never change.
const goldenPassKey = await deriveKey('correct horse battery staple', '00112233445566778899aabbccddeeff');

describe('money guard: password keystore', () => {
  const passKey = goldenPassKey;
  test('password → key derivation is unchanged', () => {
    expect(passKey).toBe('7f795f6b204d36c5d1749d64fd20167c1273cf892a6bb6969b2fd83700308801');
  });
  test('a v2 (AES-GCM) keystore entry still decrypts', async () => {
    expect(
      await decrypt('v2:9d04390b47be93c2e93d5cfce26f8c87d6511824b98d3f259fad4995e94bb9ecbe607c1d0cb1c80ad364', passKey),
    ).toBe('hello keystore');
  });
  test('a legacy (AES-CBC) keystore entry still decrypts', async () => {
    expect(
      await decrypt(
        '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f201ZIxEMpzbsNErD+A5vEwHA==',
        passKey,
      ),
    ).toBe('hello legacy');
  });
});

describe('money guard: passkeys', () => {
  test('the passkey-derived wallet password is unchanged', async () => {
    expect(await keystorePasswordFromPrf(PRF)).toBe('pk1.8jS2d5gENaIkCL8wR7EhZi5bQLPu3uPai29PwHQjq1Q');
  });
  test('the PRF salt is unchanged (a new salt = every passkey opens nothing)', async () => {
    expect(b64url(await prfSalt())).toBe('CJ4qKgOqpcuhFkWUR40I_wzFjve2y0vyeYCVhE9sQmI');
  });
  test('a passkey seed backup made by 5.2.39 still opens', async () => {
    const blob: SeedBackupBlob = {
      kind: 'bwalletx-passkey-seed-backup',
      v: 1,
      rpId: 'web.bwalletx.com',
      credentialId: 'cred-test',
      salt: 'tO20j12YRvbmrtAvENGh1A',
      iv: 'MxUcdSU94JVHUonS',
      ct: 'RZEcIvTbHf7cJLOuUFJdKPMGA6AvcAYauLve61YLNsN1ZRd2VcfdhL1JOCCQ932zvigpTodQ01o_xZDJ26GjgNmy_Gq39u3CmO0elvCZJgGLgkFKcyMzomP_lG4hm_1MqgnUnuPI0e8eHPrKAA',
      createdAt: '2026-10-23T00:30:26.610Z',
    };
    expect(await openSeed(blob, PRF)).toBe(PHRASE);
  });
  test('a password sealed to a passkey by 5.2.39 still unseals', async () => {
    const u: PasskeyUnlock = {
      rpId: 'web.bwalletx.com',
      credentialId: 'cred-test',
      sealed: {
        salt: '-ekyqSRi_3fBQK--OEpAkw',
        iv: 'XeG6ccA9JmlFGYMB',
        ct: 'MxvIhQgkUdc1o-PGk3jq4DGb481BjaaWs7b0qM550g',
      },
      addedAt: '2026-10-23T00:30:26.610Z',
    };
    expect(await unlockPasswordFromPrf(u, PRF)).toBe('my-old-password');
  });
});

describe('money guard: backup files', () => {
  test('a v2 backup file made by 5.2.39 still opens', async () => {
    const file = Uint8Array.from(
      atob(
        'UEsDBBQAAAAAAOALV11exwUJpQAAAKUAAAATAAAAYndhbGxldC1iYWNrdXAuanNvbnsiZm9ybWF0IjoiYndhbGxldC1iYWNrdXAiLCJ2ZXJzaW9uIjoyLCJrZGYiOiJQQktERjIiLCJoYXNoIjoiU0hBLTI1NiIsIml0ZXJhdGlvbnMiOjEwMDAwMCwic2FsdCI6IjcxZmQ3MzcwNDQ2NDI0MDY2YjA4YjBiYmQzMmM5MzcwIiwiaXYiOiI4ZjkzNDdiZWZlY2Q2ZDYyMDhjODQ4ZGYifVBLAwQUAAAAAADgC1dd94OBQZ0AAACdAAAACwAAAHBheWxvYWQuYmlu/pk3homkP5X1gn8yLslY4Bu/07EOpjf0ZqEwFl8q7i2P6FfJIP6vxhLvjskZit2x6c+n31JNWkC0WZHl40L+qCtYuYZv7wWz+7tK3F4/gnBfOROuEVLRLx4b3bUU73lEpA/XJMSDSGJ6gD6dBNFFCjuaaUBnyV+Bd5mEAnEDs1J2KxNN6f3cqVH29Xq6LUrriJByQetdZEYdrOIYZ1BLAQIUABQAAAAAAOALV11exwUJpQAAAKUAAAATAAAAAAAAAAAAAAAAAAAAAABid2FsbGV0LWJhY2t1cC5qc29uUEsBAhQAFAAAAAAA4AtXXfeDgUGdAAAAnQAAAAsAAAAAAAAAAAAAAAAA1gAAAHBheWxvYWQuYmluUEsFBgAAAAACAAIAegAAAJwBAAAAAA==',
      ),
      (c) => c.charCodeAt(0),
    );
    const { files, version } = await openBackup(file, 'backup-pass', async (d) => unzipSync(d));
    expect(version).toBe(2);
    expect(new TextDecoder().decode(files['manifest.json'])).toBe('{"golden":true}');
  });
});
