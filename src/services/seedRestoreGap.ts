/**
 * A restore from the 12 words brings back only what the seed can find on its own: coins on the wallet's plain
 * addresses and paymail receipts the paymail server can replay (restorePaymails). Change outputs, app baskets and
 * other BRC-29 coins are locked to keys derived with a prefix/suffix that lives ONLY in the storage that made them
 * (the other device's database, the 1Sat remote store, or a master backup file). If none of that came across, the
 * restored wallet shows a fraction of the real balance with no hint why (owner, 25 Oct 2026: phone $495, restored
 * extension $1.53).
 *
 * So after a seed restore the balance card offers "Bring over your full wallet from your phone or backup" until
 * the user imports a master backup or says it is all there. Showing it is cheap and never spends anything; missing
 * it costs the user their money's visibility. The flag lives per device (localStorage), like the account origin.
 */

export const SEED_RESTORE_KEY_PREFIX = 'bw:seedRestore:';
/** Offer for this long after a restore; later a fresh install would carry its own flag. */
export const SEED_RESTORE_OFFER_MS = 30 * 24 * 60 * 60 * 1000;

export type SeedRestoreState = {
  /** When this device restored the account from its 12 words. */
  restoredAt: number;
  /** The user tapped "It's all here". */
  dismissed?: boolean;
  /** A master backup was imported after the restore. */
  importedAt?: number;
};

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const store = (): Store | undefined => {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
};

const key = (identityAddress: string) => `${SEED_RESTORE_KEY_PREFIX}${identityAddress}`;

export const readSeedRestore = (identityAddress: string, s: Store | undefined = store()): SeedRestoreState | null => {
  if (!identityAddress || !s) return null;
  try {
    const v = JSON.parse(s.getItem(key(identityAddress)) ?? 'null') as SeedRestoreState | null;
    return v && typeof v.restoredAt === 'number' ? v : null;
  } catch {
    return null;
  }
};

const write = (identityAddress: string, v: SeedRestoreState, s: Store | undefined) => {
  if (!identityAddress || !s) return;
  try {
    s.setItem(key(identityAddress), JSON.stringify(v));
  } catch {
    // storage blocked: the offer just does not show
  }
};

/** Call when an account has just been restored from its 12 words on this device. */
export const markSeedRestore = (identityAddress: string, now = Date.now(), s: Store | undefined = store()) =>
  write(identityAddress, { restoredAt: now }, s);

export const dismissSeedRestore = (identityAddress: string, s: Store | undefined = store()) => {
  const v = readSeedRestore(identityAddress, s);
  if (v) write(identityAddress, { ...v, dismissed: true }, s);
};

/** Call when a master backup has been imported: the derivation records came across. */
export const markBackupImported = (identityAddress: string, now = Date.now(), s: Store | undefined = store()) => {
  const v = readSeedRestore(identityAddress, s);
  if (v) write(identityAddress, { ...v, importedAt: now }, s);
};

/** Should the balance card offer to bring over the full wallet? Pure; see the file comment. */
export const shouldOfferFullWallet = (state: SeedRestoreState | null, now = Date.now()): boolean => {
  if (!state) return false;
  if (state.dismissed || state.importedAt) return false;
  return now - state.restoredAt < SEED_RESTORE_OFFER_MS;
};
