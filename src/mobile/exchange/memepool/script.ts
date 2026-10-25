/**
 * The only script shapes a Memepool trade may contain, built and parsed byte for byte the way their core/ord.js does
 * (inscription envelope, then a bare P2PKH). A parsed script is rebuilt canonically and compared, so a script with
 * anything extra (another lock, trailing data, a second envelope) is never read as a token or as ours.
 */
import { Utils } from '@bsv/sdk';

const te = (s: string) => Utils.toArray(s, 'utf8');
const hex = (b: number[]) => Utils.toHex(b);

/** Minimal push of `bytes`. */
function push(bytes: number[]): string {
  const n = bytes.length;
  if (n === 0) return '00';
  if (n < 0x4c) return hex([n]) + hex(bytes);
  if (n <= 0xff) return hex([0x4c, n]) + hex(bytes);
  if (n <= 0xffff) return hex([0x4d, n & 0xff, n >> 8]) + hex(bytes);
  return hex([0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]) + hex(bytes);
}

/** The 20-byte public key hash (hex) of a base58 P2PKH address, or null. */
export function addressPkh(address: string): string | null {
  try {
    const { prefix, data } = Utils.fromBase58Check(address);
    const p = Array.isArray(prefix) ? prefix : Utils.toArray(prefix as string, 'hex');
    if (p.length !== 1 || p[0] !== 0 || (data as number[]).length !== 20) return null;
    return hex(data as number[]);
  } catch {
    return null;
  }
}

export const isAddress = (a: unknown): a is string =>
  typeof a === 'string' && /^1[1-9A-HJ-NP-Za-km-z]{24,33}$/.test(a) && addressPkh(a) !== null;

export const p2pkhFromPkh = (pkh: string) => `76a914${pkh}88ac`;
export const p2pkhFromAddress = (address: string): string => {
  const pkh = addressPkh(address);
  if (!pkh) throw new Error('bad address');
  return p2pkhFromPkh(pkh);
};

/** Bare P2PKH → pkh hex, else null. */
export const parseP2pkh = (script: string): string | null => {
  const m = /^76a914([0-9a-f]{40})88ac$/.exec(script);
  return m ? m[1] : null;
};

/** Canonical BSV-21 transfer of `amt` tokens of `id` locked to `pkh`. */
export const bsv21TransferScript = (pkh: string, id: string, amt: bigint): string =>
  '0063' +
  push(te('ord')) +
  '51' +
  push(te('application/bsv-20')) +
  '00' +
  push(te(JSON.stringify({ p: 'bsv-20', op: 'transfer', id, amt: amt.toString() }))) +
  '68' +
  p2pkhFromPkh(pkh);

/** Read one push at `i` of `b` → { data, next }, or null. */
function readPush(b: number[], i: number): { data: number[]; next: number } | null {
  const op = b[i];
  if (op === undefined) return null;
  let n: number;
  let at: number;
  if (op > 0 && op < 0x4c) [n, at] = [op, i + 1];
  else if (op === 0x4c) [n, at] = [b[i + 1], i + 2];
  else if (op === 0x4d) [n, at] = [b[i + 1] | (b[i + 2] << 8), i + 3];
  else return null;
  if (n === undefined || Number.isNaN(n) || at + n > b.length) return null;
  return { data: b.slice(at, at + n), next: at + n };
}

/**
 * EXACTLY a canonical BSV-21 transfer (one envelope, bsv-20 content type, a transfer JSON of a decimal amount, then a
 * bare P2PKH) → { id, amt, pkh }, else null.
 */
export function parseBsv21Transfer(script: string): { id: string; amt: bigint; pkh: string } | null {
  if (!/^0063[0-9a-f]+$/.test(script) || script.length % 2) return null;
  const b = Utils.toArray(script, 'hex');
  const tag = readPush(b, 2);
  if (!tag || Utils.toUTF8(tag.data) !== 'ord' || b[tag.next] !== 0x51) return null;
  const ct = readPush(b, tag.next + 1);
  if (!ct || Utils.toUTF8(ct.data) !== 'application/bsv-20' || b[ct.next] !== 0x00) return null;
  const body = readPush(b, ct.next + 1);
  if (!body || body.data.length > 1024) return null;
  let j: { p?: unknown; op?: unknown; id?: unknown; amt?: unknown };
  try {
    j = JSON.parse(Utils.toUTF8(body.data));
  } catch {
    return null;
  }
  if (j.p !== 'bsv-20' || j.op !== 'transfer' || typeof j.id !== 'string') return null;
  if (typeof j.amt !== 'string' || !/^[1-9]\d{0,19}$/.test(j.amt)) return null;
  const amt = BigInt(j.amt);
  if (amt > BigInt('18446744073709551615')) return null;
  const pkh = parseP2pkh(hex(b.slice(body.next + 1)));
  if (b[body.next] !== 0x68 || !pkh) return null;
  // Rebuilt canonically, byte for byte, or it isn't one.
  return bsv21TransferScript(pkh, j.id, amt) === script ? { id: j.id, amt, pkh } : null;
}

/** Any inscription envelope at the start of a script (token or not). */
export const isInscription = (script: string) => script.startsWith('0063');
/** OP_FALSE OP_RETURN data: carries no money. */
export const isOpReturn = (script: string) => script.startsWith('006a');
