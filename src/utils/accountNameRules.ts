/**
 * Every account has a name (owner, 18 Oct 2026): it names the account in the switcher and its backup files
 * (backupFileName.ts). Create / import / restore prefill an editable suggestion, refuse an empty name and refuse
 * a name another account in this wallet already has.
 */
export const ACCOUNT_NAME_MAX = 40;

export const cleanAccountName = (name: string): string => name.trim().replace(/\s+/g, ' ');

const same = (a: string, b: string) => cleanAccountName(a).toLowerCase() === cleanAccountName(b).toLowerCase();

/** "Account N": the first free number from the account count up. */
export const suggestAccountName = (existing: readonly string[]): string => {
  for (let n = existing.length + 1; ; n++) {
    const s = `Account ${n}`;
    if (!existing.some((e) => same(e, s))) return s;
  }
};

/** Why the name can't be saved, or '' when it can. */
export const accountNameError = (name: string, existing: readonly string[]): string => {
  const n = cleanAccountName(name);
  if (!n) return 'Give this account a name.';
  if (n.length > ACCOUNT_NAME_MAX) return `Keep the name to ${ACCOUNT_NAME_MAX} characters or fewer.`;
  if (existing.some((e) => same(e, n))) return `You already have an account called "${n}". Pick another name.`;
  return '';
};

/** Old accounts made before names were required: blank, or still the automatic "Account N". */
export const needsAccountName = (name: string | undefined | null): boolean => {
  const n = cleanAccountName(name ?? '');
  return !n || /^account \d+$/i.test(n);
};

/**
 * Restore (24 Oct 2026): the account name is only a label on this device. A wallet with an on-chain profile name
 * or a $name shows that once it syncs, so say so instead of asking for a name that looks like it will be used.
 */
export const RESTORE_NAME_LABEL = 'Name on this device only';
export const RESTORE_NAME_HINT = 'If this wallet already has a name on chain or a $name, that comes back by itself.';
