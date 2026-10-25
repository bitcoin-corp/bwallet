/**
 * The encrypted backup file: the same master backup as Settings › Backup (src/utils/masterExporter.ts,
 * background MASTER_BACKUP), whose keys stay encrypted with a key derived from the wallet password.
 * Unlike masterExporter it returns the file instead of forcing a download, so iOS can offer the
 * share sheet (Save to Files, Mail, AirDrop). Nothing is sent anywhere by this module.
 * The ZIP is then sealed in a v2 envelope (utils/backupEnvelope.ts: PBKDF2-SHA256 600k + AES-GCM) under the same
 * wallet password; restore (masterImporter) reads both these and older plain files.
 */
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import { derivePasswordKey } from '../../services/passKey';
import { sealBackup } from '../../utils/backupEnvelope';
import { masterBackupFileName } from '../../utils/masterExporter';
import { accountNamesFor } from '../names/accountNames';

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'WrongPasswordError';
  }
}

export const createBackupFile = async (cs: ChromeStorageService, password: string): Promise<File> => {
  if (!password || !(await cs.verifyPassword(password))) throw new WrongPasswordError();
  const { salt, account } = cs.getCurrentAccountObject();
  // Derived here: runtime messages fan out to every page, so the password itself never leaves this one.
  const passwordKey = salt ? await derivePasswordKey(password, salt) : undefined;
  const res = (await chrome.runtime.sendMessage({ action: 'MASTER_BACKUP', passwordKey })) as
    | { success?: boolean; data?: string; error?: string }
    | undefined;
  if (!res?.success || !res.data) throw new Error(res?.error || 'Backup failed');
  const bin = atob(res.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const sealed = await sealBackup(bytes, password);
  bytes.fill(0);
  // Named for the account like Settings › Backup ($handle, else its name): owner, 15 Oct 2026.
  const names = accountNamesFor(account?.addresses?.identityAddress, account?.name ?? '');
  const name = masterBackupFileName(names.payable || names.displayName);
  return new File([sealed as Uint8Array<ArrayBuffer>], name, { type: 'application/zip' });
};

export type SaveRoute = 'share' | 'native' | 'download' | 'none';

/**
 * In the app: the OS share sheet through Capacitor Filesystem + Share (Android's WebView has no Web Share with files,
 * which left Android on "isn't available in this app yet": owner, 15 Oct 2026). In a browser: the Web Share sheet
 * with a file where supported, else a normal download.
 */
export const saveRoute = (file: File, native: boolean): SaveRoute => {
  // In the app the native sheet always: it needs no fresh tap, so making the file and sharing it is one step.
  if (native) return 'native';
  // Desktop browsers and the Chrome extension download: the file is made after an await (password check, sealing),
  // which ends Chrome's tap, so navigator.share fails with NotAllowedError there (owner, 15 Oct 2026). Only touch
  // phones get the share sheet.
  if (typeof matchMedia === 'undefined' || !matchMedia('(pointer: coarse)').matches) return 'download';
  try {
    if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) return 'share';
  } catch {
    /* canShare throws on some browsers */
  }
  return 'download';
};

const toBase64 = async (file: Blob): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** The two Capacitor calls the native route needs; injectable for tests. */
export type NativeFileShare = {
  write: (path: string, base64: string) => Promise<string>;
  share: (uri: string, name: string) => Promise<void>;
  /** Empties the app-private folder the share copies live in. */
  clear: () => Promise<void>;
};

const SHARE_DIR = 'backup-share';

const capacitorFileShare = async (): Promise<NativeFileShare> => {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  return {
    write: async (path, data) =>
      (await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })).uri,
    share: async (uri, name) => {
      await Share.share({ title: name, files: [uri], dialogTitle: 'Save your backup' });
    },
    clear: () => Filesystem.rmdir({ path: SHARE_DIR, directory: Directory.Cache, recursive: true }),
  };
};

const cancelled = (e: unknown) => /cancel/i.test(e instanceof Error ? e.message : String(e));

/**
 * The file (already sealed with the wallet password) goes to the app's private cache, the OS share sheet offers
 * Files / Drive / Mail. The previous share copy is cleared first (the receiving app may still be reading the latest
 * one when the sheet closes, so it stays until the next save). Nothing is uploaded by the app itself.
 */
export const shareNativeFile = async (file: File, io?: NativeFileShare): Promise<boolean> => {
  const fs = io ?? (await capacitorFileShare());
  await fs.clear().catch(() => undefined);
  const uri = await fs.write(`${SHARE_DIR}/${file.name}`, await toBase64(file));
  try {
    await fs.share(uri, file.name);
    return true;
  } catch (e) {
    if (cancelled(e)) return false;
    throw e;
  }
};

/** Must run inside a tap (iOS needs a user gesture for navigator.share). Resolves false if cancelled. */
export const saveBackupFile = async (file: File, route: SaveRoute): Promise<boolean> => {
  if (route === 'share') {
    // Some iOS builds reject a share that has a title, or a zip MIME type: retry with the file alone, then as
    // a generic binary, before giving up (the caller then offers a plain download link and the phrase).
    const tries: (() => ShareData)[] = [
      () => ({ files: [file] }),
      () => ({ files: [new File([file], file.name, { type: 'application/octet-stream' })] }),
    ];
    let last: unknown;
    for (const t of tries) {
      try {
        await navigator.share(t());
        return true;
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return false;
        // The tap expired before the file was ready: download instead of failing.
        if (e instanceof Error && e.name === 'NotAllowedError') return saveBackupFile(file, 'download');
        last = e;
      }
    }
    throw last;
  }
  if (route === 'native') return shareNativeFile(file);
  if (route === 'download') {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }
  return false;
};

/** A blob URL for a plain "Download file" link the user taps themselves (a fresh tap, outside the share sheet). */
export const backupDownloadUrl = (file: File) => URL.createObjectURL(file);
