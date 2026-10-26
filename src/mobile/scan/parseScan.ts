import { parseRecipient } from '../names/names';
import { PAIR_HOST } from '../../pair/protocol';
import { parseAppLink, type AppLink } from '../spaces/invite';
import { isPeerPayUri, parsePeerPay } from './peerpay';

/**
 * What a scanned QR (or pasted text) means to bWallet. Pure: no network, no side effects.
 * Nothing here ever sends: a 'pay' result only pre-fills the Send card, which still asks to confirm.
 */
export type Scan =
  | { kind: 'pair'; text: string }
  /** "Open on computer" (passkey/openHere.ts, VITE_SEEDLESS builds act on it). */
  | { kind: 'open'; text: string }
  /** The computer's "Put this wallet on your phone" code (https://web.bwalletx.com/restore?passkey=1&…). */
  | { kind: 'restore'; url: string }
  | { kind: 'pay'; to: string; amountSats?: number; label?: string; message?: string; peerpay?: true }
  | { kind: 'person'; handle: string; to: string }
  /** A Space page, invite or room link (https /s/ /i/ /r/ on our hosts, or bwalletx://space|invite|room/…). */
  | { kind: 'join'; url: string; link: AppLink }
  | { kind: 'text'; text: string };

/** https://www.bwallet.space/open?… (passkey/openHere.ts isOpenLink; inlined to keep this module dependency-free). */
const isOpenLink = (s: string) => {
  try {
    const u = new URL(s);
    return (u.host === PAIR_HOST || u.host === 'bwallet.space') && u.pathname === '/open';
  } catch {
    return false;
  }
};

/** Only the two wallet web hosts, the /restore page and the passkey flag. Opened in the browser, never acted on here. */
const restoreUrl = (s: string): string | null => {
  try {
    const u = new URL(s);
    const hostOk = u.protocol === 'https:' && ['web.bwalletx.com', 'desktop.bwalletx.com'].includes(u.host);
    return hostOk && u.pathname.replace(/\/$/, '') === '/restore' && u.searchParams.get('passkey') === '1'
      ? u.href
      : null;
  } catch {
    return null;
  }
};

const SATS = 100_000_000;
const PERSON_HOSTS = new Set(['bwalletx.com', 'www.bwalletx.com']);
const HANDLE = /^[a-z0-9_.-]{1,50}$/i;

/** Same test as pair/links.ts isPairLink (not imported: that module pulls in Capacitor). */
const isPairLink = (s: string) => {
  try {
    const u = new URL(s);
    return (u.host === PAIR_HOST || u.host === 'bwallet.space') && u.pathname === '/pair';
  } catch {
    return false;
  }
};

/** "0.001" BSV → 100000 sats, exactly (string maths, no float). Null for anything else. */
export const bsvToSats = (raw: string): number | null => {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s) && !/^\.\d{1,8}$/.test(s)) return null;
  const [i = '0', d = ''] = s.split('.');
  const n = Number(i || '0') * SATS + Number(d.padEnd(8, '0'));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const recipientOk = (v: string) => {
  const k = parseRecipient(v).kind;
  return k === 'address' || k === 'paymail' || k === 'handle';
};

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

export const parseScan = (raw: string | null | undefined): Scan => {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'text', text: '' };

  if (isPairLink(text) || /^bwallet:.*pair/i.test(text)) return { kind: 'pair', text };
  if (isOpenLink(text)) return { kind: 'open', text };
  const restore = restoreUrl(text);
  if (restore) return { kind: 'restore', url: restore };

  const link = parseAppLink(text);
  if (link) return { kind: 'join', url: text, link };

  // BRC-125: peerpay:<identity key>?sats=<n>. Pre-fills Send only; an invalid key is shown as text, never paid.
  if (isPeerPayUri(text)) {
    const pp = parsePeerPay(text);
    if (!pp) return { kind: 'text', text };
    return { kind: 'pay', to: pp.key, ...(pp.amountSats ? { amountSats: pp.amountSats } : {}), peerpay: true };
  }

  // BIP21: bitcoin:<address>?amount=0.01&label=…&message=… (also bsv:, payto:).
  const uri = text.match(/^(?:bitcoin|bsv|payto):(?:\/\/)?([^?]*)(?:\?(.*))?$/i);
  if (uri) {
    const to = safeDecode(uri[1]).trim();
    if (!to || !recipientOk(to)) return { kind: 'text', text };
    const out: Extract<Scan, { kind: 'pay' }> = { kind: 'pay', to };
    for (const part of (uri[2] ?? '').split('&')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      const k = part.slice(0, eq).toLowerCase();
      const v = safeDecode(part.slice(eq + 1)).slice(0, 200);
      if (k === 'amount') {
        const sats = bsvToSats(v);
        if (sats) out.amountSats = sats;
      } else if (k === 'label' && v) out.label = v;
      else if (k === 'message' && v) out.message = v;
    }
    return out;
  }

  // Person pages: https://bwalletx.com/$alice or /u/alice.
  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      if (PERSON_HOSTS.has(u.host.toLowerCase())) {
        const path = safeDecode(u.pathname);
        const m = path.match(/^\/\$([^/]+)\/?$/) ?? path.match(/^\/u\/([^/]+)\/?$/);
        if (m && HANDLE.test(m[1])) {
          const handle = m[1].toLowerCase();
          return { kind: 'person', handle, to: `$${handle}` };
        }
      }
    } catch {
      /* not a URL */
    }
    return { kind: 'text', text };
  }

  // Plain address, paymail or $handle.
  if (text.length <= 120 && !/\s/.test(text) && recipientOk(text)) return { kind: 'pay', to: text };

  return { kind: 'text', text };
};
