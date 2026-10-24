import { describe, expect, test } from 'bun:test';
import { WalletBackupService } from './WalletBackupService';
import type { ChromeStorageService } from '../services/ChromeStorage.service';
import type { Account } from '../services/types/chromeStorage.types';
import { encrypt } from '../utils/crypto';

const OLD_KEY = 'a'.repeat(64);
const NEW_KEY = 'b'.repeat(64);

const account = async (name: string, key: string): Promise<Account> =>
  ({ name, encryptedKeys: await encrypt(JSON.stringify({ walletWif: name }), key) }) as unknown as Account;

/** A storage double that records writes; the restore must not reach any of them when it refuses. */
const fakeStorage = (accounts: Record<string, Account>) => {
  const writes: unknown[] = [];
  const service = {
    storage: { accounts },
    update: async (v: unknown) => void writes.push(['update', v]),
    setPassKey: async (v: unknown) => void writes.push(['setPassKey', v]),
  } as unknown as ChromeStorageService;
  return { service, writes };
};

const legacyArchive = (accounts: Record<string, Account>, selectedAccount: string) =>
  new TextEncoder().encode(JSON.stringify({ accounts, selectedAccount, accountNumber: 1, salt: 'ff'.repeat(16) }));

describe('master restore over a live wallet', () => {
  test('refuses when a resident account is not in the backup and would not open with the restored key', async () => {
    const live = { resident: await account('Agent', OLD_KEY) };
    const archive = { other: await account('Other', NEW_KEY) };
    const { service, writes } = fakeStorage(live);
    let prepared = false;
    await expect(
      WalletBackupService.restoreFromExtractedData(
        service,
        { chromeStorage: legacyArchive(archive, 'other'), isLegacy: true },
        NEW_KEY,
        () => {},
        async () => {
          prepared = true;
        },
      ),
    ).rejects.toThrow(/already has a wallet.*Agent/);
    expect(writes).toHaveLength(0);
    expect(prepared).toBe(false);
  });

  test('allows a restore onto a fresh install', async () => {
    await WalletBackupService.assertResidentAccountsSurvive({}, { x: await account('X', NEW_KEY) }, NEW_KEY);
    await WalletBackupService.assertResidentAccountsSurvive(undefined, { x: await account('X', NEW_KEY) }, NEW_KEY);
  });

  test('allows it when every resident account is in the backup (it is replaced, not stranded)', async () => {
    const live = { a: await account('A', OLD_KEY) };
    await WalletBackupService.assertResidentAccountsSurvive(live, { a: await account('A', NEW_KEY) }, NEW_KEY);
  });

  test('allows it when resident accounts still open with the restored key (same wallet, same password)', async () => {
    const live = { a: await account('A', NEW_KEY), extra: await account('Extra', NEW_KEY) };
    await WalletBackupService.assertResidentAccountsSurvive(live, { a: await account('A', NEW_KEY) }, NEW_KEY);
  });

  test('ignores keyless ghost entries', async () => {
    const live = { ghost: { name: 'ghost' } as unknown as Account };
    await WalletBackupService.assertResidentAccountsSurvive(live, {}, NEW_KEY);
  });

  test('a passing restore runs the pre-write step before writing', async () => {
    const archive = { other: await account('Other', NEW_KEY) };
    const { service, writes } = fakeStorage({});
    const order: string[] = [];
    await WalletBackupService.restoreFromExtractedData(
      service,
      { chromeStorage: legacyArchive(archive, 'other'), isLegacy: true },
      NEW_KEY,
      () => {},
      async () => {
        order.push(`prepare@${writes.length}`);
      },
    );
    expect(order).toEqual(['prepare@0']);
    expect(writes.length).toBe(2);
  });
});
