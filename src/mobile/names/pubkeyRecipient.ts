import { ECIES, Hash, PrivateKey, PublicKey, Utils } from '@bsv/sdk';

/**
 * "Send to any public key" (owner, 24 Oct 2026): a raw secp256k1 public key typed in the recipient box,
 * e.g. Satoshi's genesis-block key. No paymail needed.
 *
 * Two ways to deliver to a key:
 *   - 'plain':  the key's own P2PKH address (HASH160 of the key exactly as typed, so an uncompressed key pays the
 *               uncompressed address: the genesis key → 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa). Right for raw / legacy
 *               keys. A note goes in the same transaction, encrypted with standard Electrum ECIES ("BIE1"), which
 *               anyone holding the private key can open with common tools (Electrum "Decrypt message",
 *               @bsv/sdk ECIES.electrumDecrypt, bsv.js ECIES). An ephemeral sender key is used, so the note does
 *               not name the sender.
 *   - 'wallet': the key is a BRC-100 wallet's identity key. A plain P2PKH there lands where that wallet doesn't
 *               look, so the NFT goes to a BRC-29 key derived from the key (sendOrdinals `counterparty`) and the
 *               derivation details + note travel as a bMail (BRC-2 to the identity key), so their wallet reads it.
 *
 * Nothing here signs or broadcasts.
 */

export type KeyMode = 'plain' | 'wallet';

export type ParsedKey = { hex: string; compressed: boolean };

const HEX_RE = /^[0-9a-f]+$/i;

/** Accept 33-byte compressed (02/03…) or 65-byte uncompressed (04…) hex, on the curve. */
export const parsePubKey = (raw: string): ParsedKey | { error: string } | null => {
  const s = raw.trim().replace(/^0x/i, '');
  const looksHex = HEX_RE.test(s);
  // Only claim the input when it plausibly is a key; names and addresses fall through to the other parsers.
  if (!looksHex || !/^0[234]/.test(s) || s.length < 60) return null;
  if (!(s.length === 66 && /^0[23]/.test(s)) && !(s.length === 130 && s.startsWith('04')))
    return { error: 'A public key is 66 hex characters (02/03…) or 130 (04…)' };
  if (!onCurve(s)) return { error: "That isn't a valid public key" };
  return { hex: s.toLowerCase(), compressed: s.length === 66 };
};

const P = 2n ** 256n - 2n ** 32n - 977n;
const modpow = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  b %= P;
  for (; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
};
/** secp256k1 check done here (the SDK accepts some off-curve encodings): x < p and y² = x³ + 7 has a solution. */
const onCurve = (hex: string): boolean => {
  const x = BigInt(`0x${hex.slice(2, 66)}`);
  if (x === 0n || x >= P) return false;
  const rhs = (modpow(x, 3n) + 7n) % P;
  if (hex.length === 130) {
    const y = BigInt(`0x${hex.slice(66)}`);
    return y < P && (y * y) % P === rhs;
  }
  const y = modpow(rhs, (P + 1n) / 4n);
  return (y * y) % P === rhs;
};

export const GENESIS_PUBKEY =
  '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f';

/** Well-known keys, by the form they are usually quoted in. */
export const KNOWN_KEYS: Record<string, string> = {
  [GENESIS_PUBKEY]: 'Satoshi (genesis block key)',
};

export const knownKeyLabel = (hex: string): string | undefined => KNOWN_KEYS[hex.toLowerCase()];

/** Mainnet P2PKH address of the key in the exact form given (compressed or uncompressed). */
export const keyAddress = (hex: string): string =>
  Utils.toBase58Check(Hash.hash160(Utils.toArray(hex, 'hex')) as number[], [0x00]);

/** The compressed form (how wallets publish identity keys), for self-send checks and BRC-42 derivation. */
export const compressedKey = (hex: string): string => PublicKey.fromString(hex).toString();

/** Default delivery: compressed keys are most likely wallet identity keys; uncompressed / legacy keys are not. */
export const defaultKeyMode = (k: ParsedKey): KeyMode => (!k.compressed || knownKeyLabel(k.hex) ? 'plain' : 'wallet');

export const shortKey = (hex: string) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

export const PLAIN_KEY_WARNING =
  "Most public keys have no wallet watching them. Anything sent to this key's plain address may never be seen or spent.";

// --- Encrypted note (plain mode) ---

export const NOTE_MAX = 1000;
export const NOTE_SCHEME = 'bie1';

/** Standard Electrum ECIES (BIE1) with a fresh ephemeral key: the key's holder decrypts with common tools. */
export const encryptNoteForKey = (note: string, keyHex: string, ephemeral?: PrivateKey): number[] =>
  ECIES.electrumEncrypt(
    Utils.toArray(note, 'utf8'),
    PublicKey.fromString(keyHex),
    ephemeral ?? PrivateKey.fromRandom(),
  );

/** What the key's holder runs (tests use it for the round-trip). */
export const decryptNoteWithKey = (cipher: number[], priv: PrivateKey): string =>
  Utils.toUTF8(ECIES.electrumDecrypt(cipher, priv));

/**
 * MAP fields appended (OP_RETURN | MAP SET …) to the transfer output in the same transaction. Only the
 * base64 BIE1 ciphertext is on chain; nothing readable in clear.
 */
export const noteMap = (cipher: number[]): Record<string, string> => ({
  app: 'bwalletx',
  type: 'note',
  enc: NOTE_SCHEME,
  note: Utils.toBase64(cipher),
});

// --- Sender's local copy ---

export type SentKeyNote = { at: number; key: string; address: string; mode: KeyMode; txid: string; note: string };
const NOTES_KEY = 'bw-sent-key-notes';

export const saveSentKeyNote = (n: SentKeyNote) => {
  try {
    const all = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]') as SentKeyNote[];
    localStorage.setItem(NOTES_KEY, JSON.stringify([n, ...all].slice(0, 200)));
  } catch {
    /* local copy is a convenience only */
  }
};
