import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useBottomMenu } from '../../../hooks/useBottomMenu';
import { asMenuItem, routeFor } from '../../tabs/tabs';
import { parseInvoiceLink, type SignedInvoice } from './invoice';

/**
 * Invoice pay links (invoice.ts) opening the wallet: https://web.bwalletx.com/?invoice=… on the web, and
 * bwalletx://invoice?d=… in the apps. Same hold-then-event shape as pots/subscribeLink.ts. This only holds the link
 * and opens the Wallet; BsvWallet takes it, verifies it (signature + the payee's published key) and pre-fills Send.
 * Nothing is paid by opening a link.
 */
const KEY = 'bwallet.invoiceLink';
const EVENT = 'bwallet:invoice-link';
/** A link not acted on within an hour is dropped. */
export const INVOICE_LINK_TTL_MS = 3_600_000;

let held: { s: SignedInvoice; at: number } | null = null;

export const offerInvoiceLink = (url: string | null | undefined, now = Date.now()): boolean => {
  const s = parseInvoiceLink(url);
  if (!s) return false;
  held = { s, at: now };
  try {
    localStorage.setItem(KEY, JSON.stringify(held));
  } catch {
    /* storage unavailable: the in-memory copy still works */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
  return true;
};

export const peekInvoiceLink = (now = Date.now()): SignedInvoice | null => {
  let h = held;
  if (!h) {
    try {
      h = JSON.parse(localStorage.getItem(KEY) ?? 'null') as typeof held;
    } catch {
      h = null;
    }
  }
  return h && now - h.at < INVOICE_LINK_TTL_MS ? h.s : null;
};

/** Read once: the wallet takes the held invoice link. */
export const takeInvoiceLink = (now = Date.now()): SignedInvoice | null => {
  const s = peekInvoiceLink(now);
  held = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return s;
};

export const onInvoiceLink = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => void offerInvoiceLink(url));
  void CapApp.getLaunchUrl().then((r) => void offerInvoiceLink(r?.url));
}

/** Mounted once by the top bar / phone shell: a held invoice link opens the Wallet, which takes it. */
export const useInvoiceLinks = (enabled = true) => {
  const navigate = useNavigate();
  const { handleSelect } = useBottomMenu();
  useEffect(() => {
    if (!enabled) return;
    if (typeof location !== 'undefined' && offerInvoiceLink(location.href)) {
      try {
        history.replaceState(null, '', location.pathname);
      } catch {
        /* ignore */
      }
    }
    const go = () => {
      if (!peekInvoiceLink()) return;
      handleSelect(asMenuItem('bsv'));
      navigate(routeFor('bsv') ?? '/bsv-wallet');
    };
    go();
    return onInvoiceLink(go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, enabled]);
};
