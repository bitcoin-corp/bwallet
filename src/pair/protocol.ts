/**
 * Phone pairing protocol (tokenblaster.lol docs/wallet-connect.md §4), shared by the site side and
 * bWallet. Kept dependency-light (@bsv/sdk + WebCrypto) so the same file can be copied into sites
 * until it ships as @b0ase/wallet.
 *
 *   QR:     https://www.bwallet.space/pair?v=1&r=<relay host>&c=<channel>&k=<site pubkey>&o=<origin>&e=<expiry>
 *   key:    ECDH(secp256k1) → HKDF-SHA256(salt = channel bytes, info = "bwallet-pair-v1") → AES-256-GCM
 *   frame:  { s: seq, n: nonce b64, d: ciphertext b64 }, AAD = "<sender role>|<s>", s strictly increasing
 *   code:   first 2 bytes of SHA-256(key bits) → 4 digits, shown on both screens
 */
import { PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';

export const PAIR_VERSION = '1';
export const PAIR_INFO = 'bwallet-pair-v1';
// www: the bare domain redirects there, and app-link checks (Apple's AASA) don't follow redirects.
export const PAIR_HOST = 'www.bwallet.space';
const PAIR_HOSTS = new Set([PAIR_HOST, 'bwallet.space']);
export const DEFAULT_RELAY = 'relay.bwallet.space';
export const QR_LIFETIME_S = 120;

/**
 * The only relay a wallet will use (security audit 19 Oct 2026, H1). A pairing link names its relay, and the relay
 * reports the site's origin, so a link pointing at someone else's relay could claim to be any site. Loopback is
 * accepted only when the caller allows it (development builds).
 */
export const isAllowedRelay = (relay: string, allowLocal = false) =>
  relay === DEFAULT_RELAY || (allowLocal && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(relay));

export type Role = 'site' | 'wallet';
export type WalletInfo = { name: string; icon?: string; rdns: string };

/** `s` (optional): the site's origin proof, a DER signature (hex) over pairProofMessage by a key in its well-known file. */
export type PairLink = { v: string; r: string; c: string; k: string; o: string; e: number; s?: string };

/** Plaintext messages inside encrypted frames. */
export type PairMessage =
  | { t: 'req'; id: string; action: string; params: unknown }
  | { t: 'res'; id: string; result?: unknown; error?: { code: string; message: string } }
  | { t: 'ready' }
  | { t: 'ping' }
  | { t: 'close'; reason: string };

/** Unencrypted frames: from the relay, and the phone's hello (its key isn't shared yet). */
export type RelayFrame = { t: 'relay'; verifiedOrigin?: string; peer?: 'joined' | 'left'; role?: Role; error?: string };
export type HelloFrame = { t: 'hello'; k: string; info: WalletInfo };
export type SealedFrame = { s: number; n: string; d: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

// Chunked: String.fromCharCode(...bytes) overflows the call stack on large frames (signed transactions).
const binary = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
export const b64url = (bytes: Uint8Array) =>
  btoa(binary(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};
const b64 = (bytes: Uint8Array) => btoa(binary(bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export const newChannel = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

export function pairUrl(link: PairLink): string {
  const q = new URLSearchParams({ v: link.v, r: link.r, c: link.c, k: link.k, o: link.o, e: String(link.e) });
  if (link.s) q.set('s', link.s);
  return `https://${PAIR_HOST}/pair?${q}`;
}

/** Parse a scanned QR (https link or bwallet:// fallback). Throws on anything else. */
export function parsePairUrl(
  text: string,
  nowS = Math.floor(Date.now() / 1000),
  opts: { allowLocalRelay?: boolean } = {},
): PairLink {
  const u = new URL(text.trim());
  const ok =
    (u.protocol === 'https:' && PAIR_HOSTS.has(u.host) && u.pathname === '/pair') ||
    (u.protocol === 'bwallet:' && /pair/.test(u.href));
  if (!ok) throw new Error('Not a bWallet pairing code');
  const g = (k: string) => u.searchParams.get(k) ?? '';
  const link: PairLink = { v: g('v'), r: g('r'), c: g('c'), k: g('k'), o: g('o'), e: Number(g('e')) };
  if (link.v !== PAIR_VERSION) throw new Error('This pairing code needs a newer bWallet');
  if (!/^[A-Za-z0-9_-]{22}$/.test(link.c)) throw new Error('Bad pairing code');
  if (!/^0[23][0-9a-f]{64}$/i.test(link.k)) throw new Error('Bad pairing code');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(link.r)) throw new Error('Bad pairing code');
  if (!isAllowedRelay(link.r, opts.allowLocalRelay))
    throw new Error("This pairing code uses a pairing service bWalletX doesn't trust. Don't connect.");
  const o = new URL(link.o);
  if (o.origin !== link.o) throw new Error('Bad pairing code');
  if (!Number.isFinite(link.e) || link.e < nowS) throw new Error('This code has expired. Ask the site for a new one.');
  const sig = g('s');
  if (sig && /^30[0-9a-f]{10,150}$/i.test(sig)) link.s = sig.toLowerCase();
  return link;
}

// ---- Origin proof (docs/PAIRING-ORIGIN-PROOF.md; bridge audit 25 Oct 2026, B3) ----
// The relay's origin is only the WebSocket Origin header, which any non-browser client can set. A site proves its
// origin by publishing pairing keys at https://<origin>/.well-known/bwalletx-pair.json ({"keys":["02…"]}), fetched by
// the phone itself over TLS, and putting in the QR a signature by one of them over the channel, its ephemeral key,
// the origin and the expiry. Without a valid proof the wallet shows the host as "claims to be".

export const PAIR_PROOF_PATH = '/.well-known/bwalletx-pair.json';
const PROOF_MAX_BYTES = 8 * 1024;
const PROOF_TIMEOUT_MS = 5000;

/** What the site signs: binds the proof to this channel and ephemeral key, so it can't be replayed elsewhere. */
export const pairProofMessage = (l: Pick<PairLink, 'c' | 'k' | 'o' | 'e'>) =>
  Utils.toArray(`${PAIR_INFO}|proof|${l.c}|${l.k.toLowerCase()}|${l.o}|${l.e}`, 'utf8');

/** Site side: sign a link with the origin's pairing key (its public key goes in the well-known file). */
export const signPairProof = (l: Pick<PairLink, 'c' | 'k' | 'o' | 'e'>, originKey: PrivateKey) =>
  Utils.toHex(originKey.sign(pairProofMessage(l)).toDER() as number[]);

/** True only when the link's signature checks against a key the origin itself publishes. Never throws. */
export async function verifyPairProof(link: PairLink, f: typeof fetch = fetch): Promise<boolean> {
  if (!link.s) return false;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), PROOF_TIMEOUT_MS) : null;
  try {
    const o = new URL(link.o);
    if (o.protocol !== 'https:') return false;
    const r = await f(`${o.origin}${PAIR_PROOF_PATH}`, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (!r.ok || (r.url && new URL(r.url).origin !== o.origin)) return false;
    const text = await r.text();
    if (text.length > PROOF_MAX_BYTES) return false;
    const keys = (JSON.parse(text) as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return false;
    const sig = Signature.fromDER(link.s, 'hex');
    const msg = pairProofMessage(link);
    return keys
      .slice(0, 8)
      .some((k) => typeof k === 'string' && /^0[23][0-9a-f]{64}$/i.test(k) && PublicKey.fromString(k).verify(msg, sig));
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A fresh relay role claim (16 random bytes): the relay then admits this role only with the same claim. */
export const newClaim = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

export const relaySocketUrl = (relay: string, channel: string, role: Role, expiry?: number, claim?: string) => {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(relay);
  const q = new URLSearchParams({ role });
  if (expiry) q.set('e', String(expiry));
  if (claim) q.set('claim', claim);
  return `${local ? 'ws' : 'wss'}://${relay}/v1/c/${channel}?${q}`;
};

/** Shared AES key + 4-digit comparison code from my private key and their public key. */
export async function deriveSession(mine: PrivateKey, theirs: string, channel: string) {
  const point = mine.deriveSharedSecret(PublicKey.fromString(theirs));
  const ikm = new Uint8Array(point.encode(true) as number[]);
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: fromB64url(channel), info: enc.encode(PAIR_INFO) },
      base,
      256,
    ),
  );
  const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bits));
  const code = String(((h[0] << 8) | h[1]) % 10000).padStart(4, '0');
  return { key, code };
}

/** One direction-aware encrypted pipe. `me` is the sender role used in the AAD. */
export class Sealer {
  private sent = 0;
  private lastSeen = 0;
  constructor(
    private key: CryptoKey,
    private me: Role,
  ) {}

  async seal(msg: PairMessage): Promise<SealedFrame> {
    const s = ++this.sent;
    const n = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: n, additionalData: enc.encode(`${this.me}|${s}`) },
        this.key,
        enc.encode(JSON.stringify(msg)),
      ),
    );
    return { s, n: b64(n), d: b64(ct) };
  }

  /** Decrypts a frame from the other side; null for replays, reflections or tampering. */
  async open(f: SealedFrame): Promise<PairMessage | null> {
    if (!Number.isInteger(f.s) || f.s <= this.lastSeen) return null;
    const from: Role = this.me === 'site' ? 'wallet' : 'site';
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(f.n), additionalData: enc.encode(`${from}|${f.s}`) },
        this.key,
        fromB64(f.d),
      );
      this.lastSeen = f.s;
      return JSON.parse(dec.decode(pt)) as PairMessage;
    } catch {
      return null;
    }
  }

  /** For resuming a session after a reload: continue counters where they were. */
  get counters() {
    return { sent: this.sent, lastSeen: this.lastSeen };
  }
  restore(c: { sent: number; lastSeen: number }) {
    this.sent = c.sent;
    this.lastSeen = c.lastSeen;
  }
}

export const isSealed = (x: unknown): x is SealedFrame =>
  !!x && typeof x === 'object' && 'd' in x && 'n' in x && 's' in x;
