/**
 * BRC-125 `peerpay:` deep links opening the app (a tapped link, an NFC tag, another app). The link is held until
 * the top bar (TopNav) or the phone shell (useAppServices) takes it, then pre-fills the Send card through the same
 * path a scanned code uses (wallet/payNav.ts). It never sends: the user reviews the recipient and amount and
 * confirms on the Send card as usual.
 */
import { useContext, useEffect } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { asMenuItem } from '../tabs/tabs';
import { requestPay } from '../wallet/payNav';
import { parsePeerPay, type PeerPay } from './peerpay';

let pending: PeerPay | null = null;
const listeners = new Set<() => void>();

/** Hold a peerpay link (invalid ones are dropped). True when it was one. */
export const offerPeerPayLink = (url?: string | null): boolean => {
  const pp = parsePeerPay(url);
  if (!pp) return false;
  pending = pp;
  for (const l of listeners) l();
  return true;
};

export const takePeerPayLink = (): PeerPay | null => {
  const p = pending;
  pending = null;
  return p;
};

export const onPeerPayLink = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => void offerPeerPayLink(url));
  void CapApp.getLaunchUrl().then((r) => void offerPeerPayLink(r?.url));
}

/** Mounted once (TopNav, or the phone shell): a held link opens Send with the key and amount filled in. */
export const usePeerPayLinks = (enabled = true) => {
  const selectTab = useContext(BottomMenuContext)?.handleSelect;
  useEffect(() => {
    if (!enabled) return;
    const go = () => {
      const pp = takePeerPayLink();
      if (!pp) return;
      requestPay(pp.key, pp.amountSats);
      selectTab?.(asMenuItem('bsv'));
    };
    go();
    return onPeerPayLink(go);
  }, [enabled, selectTab]);
};
