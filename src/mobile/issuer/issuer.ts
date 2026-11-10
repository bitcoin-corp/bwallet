import {
  BigNumber,
  BSM,
  ECDSA,
  Hash,
  KeyDeriver,
  OP,
  PrivateKey,
  PublicKey,
  Script,
  Signature,
  Transaction,
  Utils,
} from '@bsv/sdk';
import { verifyBrc217 } from './brc217';

/**
 * Verifiable issuers: every mint bWallet makes carries an issuer statement, signed by the
 * account's identity key, in the SAME transaction as the token.
 *
 * One extra 0-sat OP_RETURN output (Bitcoin Schema MAP + AIP, the format bmap / 1satsocial
 * already index). The 1Sat token output itself is untouched, so 1Sat indexing is unaffected:
 *
 *   OP_FALSE OP_RETURN
 *     1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5 SET app bWallet type issue kind <bsv21|ordinal>
 *       [ticker <SYM>] script_sha256 <hex> identity_key <33-byte hex>
 *   | 15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva BITCOIN_ECDSA <address> <compact sig>
 *
 * - script_sha256 = sha256 of the token output's locking script (the inscription). The token id
 *   (`<txid>_<vout>`) cannot be signed — it does not exist until the tx is built — so the
 *   signature binds the exact output instead, and the verifier finds it by hash (robust to
 *   output reordering).
 * - The AIP key is the identity key's BRC-42 child [2,'bwallet issuer'] / '1' / counterparty
 *   'anyone' (the wallet never signs with its root key). Anyone can re-derive that child's
 *   public key from identity_key, so a verifier checks: AIP signature valid, AIP address ==
 *   derived address, script hash matches the token output. identity_key then resolves to a
 *   handle / paymail / KYC.
 *
 * Pure: no network, no wallet. Shared verbatim (modulo imports) with bit-sign's registry.
 */
export const ISSUER_APP = 'bWallet';
export const ISSUER_PROTOCOL: [2, string] = [2, 'bwallet issuer'];
export const ISSUER_KEY_ID = '1';
export const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
export const AIP_PREFIX = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva';
export const AIP_ALGORITHM = 'BITCOIN_ECDSA';

export type IssueKind = 'bsv21' | 'ordinal';
export interface IssueFields {
  kind: IssueKind;
  ticker?: string | null;
  scriptSha256: string;
  identityKey: string;
}

const { toArray, toHex, toUTF8 } = Utils;
const PIPE = 0x7c;
const ORD = toHex(toArray('ord', 'utf8'));

export const sha256Hex = (bytes: number[]) => toHex(Hash.sha256(bytes));
export const scriptSha256 = (lockingScriptHex: string) => sha256Hex(toArray(lockingScriptHex, 'hex'));
export const isIdentityKey = (k: unknown): k is string => typeof k === 'string' && /^0[23][0-9a-f]{64}$/i.test(k);
export const isTokenId = (t: unknown): t is string => typeof t === 'string' && /^[0-9a-f]{64}_\d{1,6}$/i.test(t);
export const normTokenId = (t: string) => t.trim().toLowerCase().replace('.', '_');

/** 1Sat inscription envelope (OP_FALSE OP_IF "ord" …) anywhere in the script. */
export function isInscriptionScript(lockingScriptHex: string): boolean {
  let chunks;
  try {
    chunks = Script.fromHex(lockingScriptHex).chunks;
  } catch {
    return false;
  }
  for (let i = 0; i + 2 < chunks.length; i++) {
    if (
      chunks[i].op === OP.OP_FALSE &&
      chunks[i + 1].op === OP.OP_IF &&
      chunks[i + 2].data &&
      toHex(chunks[i + 2].data!) === ORD
    )
      return true;
  }
  return false;
}

/** BSV-20/21 ticker from an inscription's JSON body (deploy+mint `sym`, or v1 `tick`), else null. */
export function inscriptionTicker(lockingScriptHex: string): string | null {
  try {
    for (const c of Script.fromHex(lockingScriptHex).chunks) {
      if (!c.data || c.data[0] !== 0x7b) continue; // '{'
      const j = JSON.parse(toUTF8(c.data)) as { p?: string; sym?: string; tick?: string };
      if (j?.p === 'bsv-20') return (j.sym || j.tick || '').toString() || null;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

const mapPairs = (f: IssueFields): [string, string][] => [
  ['app', ISSUER_APP],
  ['type', 'issue'],
  ['kind', f.kind],
  ...(f.ticker ? ([['ticker', f.ticker]] as [string, string][]) : []),
  ['script_sha256', f.scriptSha256.toLowerCase()],
  ['identity_key', f.identityKey.toLowerCase()],
];

/** Unsigned issuer MAP script (sign with AIP before adding to the tx). */
export function issueMapScript(f: IssueFields): Script {
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  s.writeBin(toArray(MAP_PREFIX, 'utf8'));
  s.writeBin(toArray('SET', 'utf8'));
  for (const [k, v] of mapPairs(f)) {
    s.writeBin(toArray(k, 'utf8'));
    s.writeBin(toArray(v, 'utf8'));
  }
  return s;
}

/**
 * AIP signed bytes, exactly as @1sat/actions applyAip / bmap build them: OP_RETURN byte, every
 * non-empty push after it (up to the AIP separator), then a trailing '|'.
 */
export function aipMessage(chunks: Script['chunks']): number[] {
  const buf: number[] = [];
  let seen = false;
  let content = false;
  for (const c of chunks) {
    if (c.op === OP.OP_RETURN) {
      buf.push(OP.OP_RETURN);
      seen = true;
      continue;
    }
    if (!seen) continue;
    if (c.data && c.data.length) {
      buf.push(...c.data);
      content = true;
    }
  }
  if (content) buf.push(PIPE);
  return buf;
}

/** Append an AIP signature made with a raw key (tests, tools). The wallet uses @1sat/actions applyAip. */
export function signIssueWithKey(script: Script, key: PrivateKey): Script {
  const msg = aipMessage(script.chunks);
  const hash = BSM.magicHash(msg);
  const pub = key.toPublicKey();
  const sig = ECDSA.sign(new BigNumber(hash), key, true);
  const compact = sig.toCompact(sig.CalculateRecoveryFactor(pub, new BigNumber(hash)), true) as number[];
  const out = new Script(script.chunks.slice());
  out.writeBin([PIPE]);
  out.writeBin(toArray(AIP_PREFIX, 'utf8'));
  out.writeBin(toArray(AIP_ALGORITHM, 'utf8'));
  out.writeBin(toArray(pub.toAddress(), 'utf8'));
  out.writeBin(compact);
  return out;
}

/** The BRC-42 child (public) key the issuer signs with, derivable by anyone from the identity key. */
export function issuerSigningKey(identityKey: string): PublicKey {
  return new KeyDeriver(new PrivateKey(1)).derivePublicKey(ISSUER_PROTOCOL, ISSUER_KEY_ID, identityKey, false);
}
/** Private side of issuerSigningKey (what the wallet's createSignature uses) — tests only. */
export function issuerSigningPrivateKey(identityPriv: PrivateKey): PrivateKey {
  return new KeyDeriver(identityPriv).derivePrivateKey(ISSUER_PROTOCOL, ISSUER_KEY_ID, 'anyone');
}

export interface ParsedIssue {
  fields: Record<string, string>;
  address: string;
  signature: number[];
  message: number[];
}

/**
 * A script parsed from bytes keeps everything after a top-level OP_RETURN as ONE raw chunk
 * (@bsv/sdk); re-split it into its pushes so built and parsed scripts look the same.
 */
export function expandChunks(script: Script): Script['chunks'] {
  const out: Script['chunks'] = [];
  for (const c of script.chunks) {
    if (c.op === OP.OP_RETURN && c.data && c.data.length) {
      out.push({ op: OP.OP_RETURN });
      try {
        out.push(...Script.fromBinary(c.data).chunks);
      } catch {
        return script.chunks;
      }
    } else out.push(c);
  }
  return out;
}

/** Parse one OP_RETURN as an issuer statement (MAP app=bWallet type=issue + AIP), else null. */
export function parseIssueScript(script: Script): ParsedIssue | null {
  const ch = expandChunks(script);
  const ret = ch.findIndex((c) => c.op === OP.OP_RETURN);
  if (ret < 0) return null;
  const parts: number[][][] = [[]];
  for (const c of ch.slice(ret + 1)) {
    const d = c.data ?? [];
    if (d.length === 1 && d[0] === PIPE) parts.push([]);
    else parts[parts.length - 1].push(d);
  }
  const str = (b: number[]) => toUTF8(b);
  const map = parts.find((p) => p.length && str(p[0]) === MAP_PREFIX && str(p[1] ?? []) === 'SET');
  const aipIdx = parts.findIndex((p) => p.length >= 4 && str(p[0]) === AIP_PREFIX);
  if (!map || aipIdx < 0) return null;
  const fields: Record<string, string> = {};
  for (let i = 2; i + 1 < map.length; i += 2) fields[str(map[i])] = str(map[i + 1]);
  if (fields.app !== ISSUER_APP || fields.type !== 'issue') return null;
  const aip = parts[aipIdx];
  if (str(aip[1]) !== AIP_ALGORITHM) return null;
  // Signed bytes: everything before the AIP separator.
  let pipes = 0;
  let cut = ch.length;
  for (let i = ret + 1; i < ch.length; i++) {
    const d = ch[i].data;
    if (d && d.length === 1 && d[0] === PIPE && ++pipes === aipIdx) {
      cut = i;
      break;
    }
  }
  return { fields, address: str(aip[2]), signature: aip[3], message: aipMessage(ch.slice(0, cut)) };
}

/** Does `signature` (compact, BSM) over `message` recover to `address`? */
export function aipValid(message: number[], signature: number[], address: string): boolean {
  try {
    const sig = Signature.fromCompact(signature);
    const hash = new BigNumber(BSM.magicHash(message));
    for (let r = 0; r < 4; r++) {
      try {
        const pub = sig.RecoverPublicKey(r, hash);
        if (pub.toAddress() === address && BSM.verify(message, sig, pub)) return true;
      } catch {
        /* next recovery id */
      }
    }
  } catch {
    /* malformed */
  }
  return false;
}

export type IssueVerdict =
  | { ok: true; tokenId: string; identityKey: string; kind: IssueKind; ticker: string | null; address: string }
  | { ok: false; reason: string };

/**
 * Verify the issuer statement for `tokenId` (`<txid>_<vout>`) inside its deploy/mint tx.
 * Every check is local to the tx: no indexer is trusted.
 */
export function verifyIssueTx(tx: Transaction, tokenId: string): IssueVerdict {
  const id = normTokenId(tokenId);
  if (!isTokenId(id)) return { ok: false, reason: 'bad token id' };
  const [txid, voutStr] = id.split('_');
  if (tx.id('hex') !== txid) return { ok: false, reason: 'tx does not match token id' };
  const vout = Number(voutStr);
  const out = tx.outputs[vout];
  if (!out) return { ok: false, reason: 'no such output' };
  const tokenHex = out.lockingScript.toHex();
  const want = scriptSha256(tokenHex);
  let lastReason = 'no issuer signature';
  for (const o of tx.outputs) {
    const p = parseIssueScript(o.lockingScript);
    if (!p) continue;
    const f = p.fields;
    if ((f.script_sha256 || '').toLowerCase() !== want) {
      lastReason = 'issuer signature is for another output';
      continue;
    }
    if (!isIdentityKey(f.identity_key)) {
      lastReason = 'bad identity key';
      continue;
    }
    if (!aipValid(p.message, p.signature, p.address)) {
      lastReason = 'invalid signature';
      continue;
    }
    if (issuerSigningKey(f.identity_key).toAddress() !== p.address) {
      lastReason = 'signature is not from the stated identity';
      continue;
    }
    const kind: IssueKind = f.kind === 'ordinal' ? 'ordinal' : 'bsv21';
    return {
      ok: true,
      tokenId: id,
      identityKey: f.identity_key.toLowerCase(),
      kind,
      ticker: inscriptionTicker(tokenHex) ?? (f.ticker || null),
      address: p.address,
    };
  }
  // BRC-217 (26 Oct 2026 on): the token output signs itself. MAP identity_key names the account; the author
  // address must be that key's issuer child, as for the statement above.
  const b = verifyBrc217(tokenHex);
  if (b.ok) {
    const key = b.map.identity_key;
    if (!isIdentityKey(key)) return { ok: false, reason: 'bad identity key' };
    if (issuerSigningKey(key).toAddress() !== b.address)
      return { ok: false, reason: 'signature is not from the stated identity' };
    return {
      ok: true,
      tokenId: id,
      identityKey: key.toLowerCase(),
      kind: 'ordinal',
      ticker: inscriptionTicker(tokenHex),
      address: b.address,
    };
  }
  if (b.reason !== 'no author section' && b.reason !== 'not lock-first' && b.reason !== 'no inscription')
    lastReason = b.reason;
  return { ok: false, reason: lastReason };
}
