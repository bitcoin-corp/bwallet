/**
 * Subscribe links from our own services (first user: bChatX Plus, owner 9 Oct 2026), the v1 hand-off of
 * docs/POTS-SUBSCRIPTIONS-PLAN.md §4 before the full signed "Subscribe with bWalletX" request exists.
 *
 *   bwalletx://subscribe?service=bchat&plan=plus&usd=0.01&period=day&ref=bchatx-plus:<24 hex>&return=<url>
 *   https://web.bwalletx.com/m/settings?subscribe=bchat&plan=plus&usd=0.01&period=day&ref=…   (web wallet)
 *
 * ⚠ THE LINK NAMES A SERVICE, NEVER AN ADDRESS. The payee is the wallet's own address for that service
 * (ownServicePayees()); a link that could carry an address would let any page redirect a daily payment.
 * The user still picks the pot, sees the amount and taps Set up: nothing is paid by opening a link.
 *
 * `ref` is written into an OP_RETURN of each payment (potSend.signFromPot memo) so the service can tie the
 * payment to the account that asked, the way bit-sign settlement binds by reference.
 *
 * ⚠ STORE BUILD: none of this. SUBSCRIPTIONS_ENABLED is a literal env check, so the parser answers null, the
 * listener is never added and the banner text is dropped (docs/STORE-AUDIT.md, Apple 3.1.1, Play Payments).
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { SUBSCRIPTIONS_ENABLED } from '../storeBuild';
import type { Period } from './pots';

export type SubscribeRequest = {
  service: string;
  plan: string;
  usd: number;
  period: Exclude<Period, object>;
  memo: string;
  returnUrl: string | null;
  at: number;
};

const SERVICES = new Set(['bchat']);
const PERIODS = new Set(['day', 'week', 'month', 'year']);
/** A service reference: `<service>-<plan>:<hex>`, short enough for one OP_RETURN push. */
export const MEMO_RE = /^[a-z][a-z0-9-]{1,23}:[0-9a-f]{8,64}$/;
/** A single subscription payment from a link is never more than this (the user can still type more). */
export const MAX_LINK_USD = 5;
const RETURN_HOSTS = new Set([
  'bchatx.com',
  'www.bchatx.com',
  'chat.bwalletx.com',
  'bit-sign.online',
  'www.bit-sign.online',
  'localhost',
]);
const KEY = 'bwallet.pots.subscribeRequest';
const EVENT = 'bwallet:subscribe-request';
/** A request not acted on within an hour is dropped. */
export const REQUEST_TTL_MS = 3_600_000;

/** What a subscribe link asks for, or null when it is none, malformed, or this build has no subscriptions. */
export const parseSubscribeLink = (
  url: string | null | undefined,
  now = Date.now(),
  subsOn = SUBSCRIPTIONS_ENABLED,
): SubscribeRequest | null => {
  if (!subsOn || !url) return null;
  try {
    const u = new URL(url);
    let service: string | null;
    if (u.protocol === 'bwalletx:') {
      if (u.host !== 'subscribe') return null;
      service = u.searchParams.get('service');
    } else if (u.protocol === 'https:' || u.protocol === 'http:') {
      service = u.searchParams.get('subscribe');
    } else return null;
    if (!service || !SERVICES.has(service)) return null;
    const q = u.searchParams;
    if (q.has('address') || q.has('payee') || q.has('paymail')) return null; // never take a payee from a link
    const usd = Number(q.get('usd'));
    if (!(usd > 0 && usd <= MAX_LINK_USD)) return null;
    const period = q.get('period') || 'month';
    if (!PERIODS.has(period)) return null;
    const memo = q.get('ref') || '';
    if (!MEMO_RE.test(memo)) return null;
    if (service === 'bchat' && !memo.startsWith('bchatx-')) return null;
    let returnUrl: string | null = null;
    const r = q.get('return');
    if (r) {
      try {
        const ru = new URL(r);
        if (ru.protocol === 'https:' && RETURN_HOSTS.has(ru.hostname)) returnUrl = ru.toString();
      } catch {
        /* ignore a bad return */
      }
    }
    const plan = (q.get('plan') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 24);
    return { service, plan, usd, period: period as SubscribeRequest['period'], memo, returnUrl, at: now };
  } catch {
    return null;
  }
};

/** The label a request shows: "bChatX Plus". */
export const requestLabel = (r: Pick<SubscribeRequest, 'service' | 'plan'>) =>
  r.service === 'bchat' && r.plan === 'plus' ? 'bChatX Plus' : r.service === 'bchat' ? 'bChat' : r.service;

const read = (now = Date.now()): SubscribeRequest | null => {
  try {
    const v = localStorage.getItem(KEY);
    const r = v ? (JSON.parse(v) as SubscribeRequest) : null;
    return r && now - r.at < REQUEST_TTL_MS ? r : null;
  } catch {
    return null;
  }
};

/** A request arrived since the screen last looked: open Settings once for it. */
let fresh = false;

/** Hold a request until the Subscriptions screen takes it (survives making a new pot). */
export const offerSubscribeLink = (url?: string | null): boolean => {
  const r = parseSubscribeLink(url);
  if (!r) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
    fresh = true;
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* storage unavailable */
  }
  return true;
};
export const peekSubscribeRequest = (now = Date.now()) => (SUBSCRIPTIONS_ENABLED ? read(now) : null);
export const clearSubscribeRequest = () => {
  try {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* storage unavailable */
  }
};
export const onSubscribeRequest = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};
export const SUBSCRIBE_OPEN_EVENT = EVENT;

if (SUBSCRIPTIONS_ENABLED && Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => void offerSubscribeLink(url));
  void CapApp.getLaunchUrl().then((r) => void offerSubscribeLink(r?.url));
}

/** Mounted once by the top bar / phone shell: a held request opens Settings (which opens Subscriptions). */
export const useSubscribeLinks = (enabled = true) => {
  const navigate = useNavigate();
  useEffect(() => {
    if (!SUBSCRIPTIONS_ENABLED || !enabled) return;
    // Web wallet: the link is this page's own URL.
    if (typeof location !== 'undefined' && offerSubscribeLink(location.href)) {
      try {
        history.replaceState(null, '', location.pathname);
      } catch {
        /* ignore */
      }
    }
    const go = () => {
      if (!fresh || !peekSubscribeRequest()) return;
      fresh = false;
      navigate('/m/settings');
    };
    go();
    return onSubscribeRequest(go);
  }, [navigate, enabled]);
};
