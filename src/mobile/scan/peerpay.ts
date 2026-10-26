/**
 * BRC-125 `peerpay:` URIs: `peerpay:<identity key>?sats=<n>`. Pure: no network, no side effects.
 *
 * A peerpay link only ever pre-fills the Send card (recipient = the key, amount = `sats` when > 0). Nothing here
 * sends: the user still reviews and confirms, as BRC-125 requires ("Wallets MUST NOT broadcast a transaction before
 * the user explicitly confirms"). Unknown parameters are ignored. A key that is not exactly 66 lowercase hex
 * characters of a valid compressed secp256k1 point is rejected (BRC-125 security: an invalid key loses the funds).
 */
import { PublicKey } from '@bsv/sdk';

export type PeerPay = { key: string; amountSats?: number };

const KEY = /^0[23][0-9a-f]{64}$/;

/** True for anything that starts with the scheme (case-insensitive), valid or not. */
export const isPeerPayUri = (raw: string) => /^peerpay:/i.test(raw.trim());

/** The key and amount, or null for anything that isn't a valid peerpay URI. */
export function parsePeerPay(raw: string | null | undefined): PeerPay | null {
  const text = (raw ?? '').trim();
  const m = /^peerpay:([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(text);
  if (!m) return null;
  const key = m[1];
  if (!KEY.test(key)) return null;
  try {
    const p = PublicKey.fromString(key);
    if (p.toString() !== key) return null;
  } catch {
    return null;
  }
  const out: PeerPay = { key };
  for (const part of (m[2] ?? '').split('&')) {
    const eq = part.indexOf('=');
    if (eq < 1 || part.slice(0, eq) !== 'sats') continue;
    const v = part.slice(eq + 1);
    // sats = 1*DIGIT; 0 means unspecified. Anything else (sign, decimals, too big) is ignored, never guessed.
    if (/^\d{1,16}$/.test(v)) {
      const n = Number(v);
      if (Number.isSafeInteger(n) && n > 0) out.amountSats = n;
    }
  }
  return out;
}

/** Build one (the Receive side, tests). */
export const peerPayUri = (key: string, sats?: number) =>
  `peerpay:${key.toLowerCase()}${sats && sats > 0 ? `?sats=${Math.floor(sats)}` : ''}`;
