import { useEffect, useState } from 'react';
import { bareName } from './names';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getMyName } from './myName';
import { isPlaceholderName } from './handlePrompt';
import {
  collectPaymailNow,
  ctxIdentityAddress,
  getCachedProfileName,
  getOwnedNames,
  getPaymail,
  getPrimaryName,
  onAccountNamesChange,
  payableLabel,
  pickPrimary,
  syncAccountNames,
} from './accountName';

/** Paymail inbox check while the app is open and visible (one signed POST, ~0.2 s). */
export const PAYMAIL_INBOX_POLL_MS = 15_000;

export type AccountNames = {
  /** BAP profile name, else the account's name. */
  displayName: string;
  /** OpNS name in use (owned / bound), or ''. */
  handle: string;
  /** bWallet paymail in full (name@bwallet.space), or '' (always '' when paymail is unconfigured). */
  paymail: string;
  /** How bWallet shows the payable name: the paymail without our domain, else the OpNS handle. */
  payable: string;
  /** "Testytester · testytester" (or just the display name). */
  label: string;
  /** Every name this identity can be shown as (paymail name, then OpNS names), for the primary-name picker. */
  names: string[];
};

/** The paymail name first, then each OpNS name, without repeats. */
export const nameCandidates = (paymailName: string, opns: readonly string[]): string[] =>
  [paymailName, ...opns].filter((n, i, all) => !!n && all.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i);

/** Names for an account from the cache (no network). Also used for the drawer rows of other accounts. */
export const accountNamesFor = (identityAddress?: string, accountName = '', profileName = ''): AccountNames => {
  const handle = getMyName(identityAddress);
  const paymail = getPaymail(identityAddress);
  const short = bareName(paymail);
  const names = nameCandidates(
    short,
    getOwnedNames(identityAddress).map((o) => o.name),
  );
  const payable = pickPrimary(names, getPrimaryName(identityAddress)) || short || handle;
  // A placeholder ("Anonymous", "Account 1") is never shown as the name: the paymail name wins over it.
  const displayName =
    [getCachedProfileName(identityAddress), profileName, accountName].find((n) => n && !isPlaceholderName(n)) ||
    payable ||
    accountName;
  const primaryIsOpns = payable !== short && payable !== '';
  return {
    displayName,
    handle,
    paymail,
    payable,
    label: primaryIsOpns ? payableLabel(displayName, payable, '') : payableLabel(displayName, handle, short),
    names,
  };
};

/**
 * Names for the current account. Paints from the cache, then (when `sync`) refreshes from the
 * chain: BAP profile, the opns basket, and the paymail server (which also collects paymail payments).
 */
export const useAccountNames = (identityAddress?: string, accountName = '', profileName = '', sync = true) => {
  const { apiContext } = useServiceContext();
  const [names, setNames] = useState(() => accountNamesFor(identityAddress, accountName, profileName));
  useEffect(() => {
    const update = () => setNames(accountNamesFor(identityAddress, accountName, profileName));
    update();
    return onAccountNamesChange(update);
  }, [identityAddress, accountName, profileName]);
  useEffect(() => {
    if (!sync || !apiContext || !identityAddress) return;
    const run = () => syncAccountNames(apiContext, identityAddress).catch(() => undefined);
    run();
    const t = setInterval(run, 150_000);
    return () => clearInterval(t);
  }, [apiContext, identityAddress, sync]);
  // Paymail payments arrive on our server, not on chain addresses: check that inbox every 15 s while
  // visible and at once on return to the app, instead of only inside the 150 s name sync above.
  useEffect(() => {
    if (!sync || !apiContext || !identityAddress) return;
    const tick = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (!getPaymail(identityAddress)) return; // no paymail yet: the name sync finds it
      if ((await ctxIdentityAddress(apiContext)) !== identityAddress) return; // mid account switch
      await collectPaymailNow(apiContext);
    };
    const run = () => void tick().catch(() => undefined);
    const t = setInterval(run, PAYMAIL_INBOX_POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [apiContext, identityAddress, sync]);
  return names;
};
