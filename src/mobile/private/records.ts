import { Hash, OP, Script, Utils } from '@bsv/sdk';

/**
 * Private records, on-chain format v1 (bit-sign docs/PRIVATE-RECORDS.md, branch feat/x-import-private-mint).
 * Pure: plaintext layout, padding and the output scripts. Encryption is done by the caller with the wallet's own
 * keys (BRC-2, protocolID [2,'bmintx archive'], counterparty self) through an `Encrypt` function, so the same code
 * runs with the real wallet (random IV) and with the spec's fixed-IV test vectors.
 *
 *   §2–§3  X post records         OP_FALSE OP_RETURN B <ct> application/octet-stream binary | MAP … kid <kid>
 *   §4     seal                   OP_FALSE OP_RETURN MAP … archive-seal … | BRC3 <pubkey> <sig>
 *   §6     X reveal post          a bChat post with MAP … source x … reveal <txid:vout>
 *   §9     wallet media records   1-sat ordinal, body = ciphertext, locked to the per-record key 'lock <kid>'
 */

export const ARCHIVE_PROTOCOL: [2, string] = [2, 'bmintx archive'];
export const B_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut';
export const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
export const PRIVATE_CONTENT_TYPE = 'application/vnd.bmintx.private';
/** §9.4: clear bytes per chunk. */
export const CHUNK_SIZE = 524288;
/** §9.4: max chunks per item (100 MiB). */
export const MAX_CHUNKS = 200;
/** §5: bChatX packing for X records. */
export const X_BATCH_MAX_RECORDS = 250;
export const X_BATCH_MAX_BYTES = 180_000;

/** Encrypts `plaintext` with BRC-2 under ARCHIVE_PROTOCOL / keyID / counterparty self; returns IV ‖ ct ‖ tag. */
export type Encrypt = (plaintext: number[], keyID: string) => Promise<number[]>;

const { toArray, toHex } = Utils;
const PIPE = 0x7c;
const utf8 = (s: string) => toArray(s, 'utf8');
const pushStr = (s: Script, v: string) => s.writeBin(utf8(v));

/** 32 lowercase hex chars, 128-bit random (a record's kid, a batch kid). */
export const randomKid = (): string => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toHex(Array.from(b));
};
export const isKid = (k: string) => /^[0-9a-f]{32}$/.test(k);

// ── §2 X post plaintext ──────────────────────────────────────────────────────

export type XRecord = {
  x_id: string;
  account_id: string;
  handle: string;
  text: string;
  created_at: string;
  url: string;
  reply_to: string | null;
  reply_url: string | null;
  media: { name: string; bytes: number }[];
  long: boolean;
};

/** JSON in the spec's exact field order, space-padded to the next multiple of 128 strictly above its length. */
export function xPlaintext(r: XRecord): number[] {
  const json = JSON.stringify({
    v: 1,
    source: 'x',
    x_id: r.x_id,
    account_id: r.account_id,
    handle: r.handle,
    text: r.text,
    created_at: r.created_at,
    url: r.url,
    reply_to: r.reply_to,
    reply_url: r.reply_url,
    media: r.media.map((m) => ({ name: m.name, bytes: m.bytes })),
    long: r.long,
  });
  const bytes = utf8(json);
  const padded = Math.ceil((bytes.length + 1) / 128) * 128;
  return [...bytes, ...new Array<number>(padded - bytes.length).fill(0x20)];
}

/** Reader side of §2: the record, or null when it is not a v1 X record. */
export function parseXPlaintext(bytes: number[]): (XRecord & { v: 1; source: 'x' }) | null {
  try {
    const o = JSON.parse(Utils.toUTF8(bytes));
    if (o?.v !== 1 || o.source !== 'x' || typeof o.text !== 'string') return null;
    return o;
  } catch {
    return null;
  }
}

/** Light shape check on items a site hands to the wallet (mintPrivate source 'x'). */
export function validXRecord(r: unknown): r is XRecord {
  const o = r as XRecord;
  const str = (v: unknown) => typeof v === 'string';
  const strOrNull = (v: unknown) => v === null || str(v);
  return (
    !!o &&
    str(o.x_id) &&
    /^\d{1,25}$/.test(o.x_id) &&
    str(o.account_id) &&
    str(o.handle) &&
    str(o.text) &&
    str(o.created_at) &&
    str(o.url) &&
    strOrNull(o.reply_to) &&
    strOrNull(o.reply_url) &&
    Array.isArray(o.media) &&
    o.media.every((m) => m && str(m.name) && Number.isFinite(m.bytes)) &&
    typeof o.long === 'boolean'
  );
}

// ── §3 X record script ───────────────────────────────────────────────────────

const writeMap = (s: Script, kv: [string, string][]) => {
  pushStr(s, MAP_PREFIX);
  pushStr(s, 'SET');
  for (const [k, v] of kv) {
    pushStr(s, k);
    pushStr(s, v);
  }
};

/** OP_FALSE OP_RETURN, then exactly the 17 pushes of §3. */
export function xRecordScript(ciphertext: number[], kid: string): Script {
  if (!isKid(kid)) throw new Error('Bad record id');
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  pushStr(s, B_PREFIX);
  s.writeBin(ciphertext);
  pushStr(s, 'application/octet-stream');
  pushStr(s, 'binary');
  s.writeBin([PIPE]);
  writeMap(s, [
    ['app', 'bmintx'],
    ['type', 'archive'],
    ['v', '1'],
    ['enc', 'brc2'],
    ['kid', kid],
  ]);
  return s;
}

// ── §4 seal ──────────────────────────────────────────────────────────────────

/** What the seal key signs: sha256 over the record ciphertexts in output order (createSignature hashes again). */
export const sealData = (ciphertexts: number[][]): number[] => Hash.sha256(ciphertexts.flat());
export const sealKeyID = (batchKid: string) => `seal ${batchKid}`;

export function sealScript(count: number, batchKid: string, publicKeyHex: string, derSignatureHex: string): Script {
  if (!isKid(batchKid)) throw new Error('Bad batch id');
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  writeMap(s, [
    ['app', 'bmintx'],
    ['type', 'archive-seal'],
    ['v', '1'],
    ['n', String(count)],
    ['kid', batchKid],
  ]);
  s.writeBin([PIPE]);
  pushStr(s, 'BRC3');
  pushStr(s, publicKeyHex);
  pushStr(s, derSignatureHex);
  return s;
}

// ── §5 X batches ─────────────────────────────────────────────────────────────

/** Bytes of one X record output for `plaintextBytes` of padded plaintext (+48 ciphertext overhead + pushes). */
export const xRecordBytes = (plaintextBytes: number) =>
  xRecordScript(new Array(plaintextBytes + 48).fill(0), '0'.repeat(32)).toBinary().length;

/** Splits records into transactions: at most 250 records and 180,000 bytes of record outputs each. */
export function planXBatches<T>(items: T[], bytesOf: (t: T) => number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const it of items) {
    const b = bytesOf(it);
    if (cur.length && (cur.length >= X_BATCH_MAX_RECORDS || size + b > X_BATCH_MAX_BYTES)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ── §6 X reveal post ─────────────────────────────────────────────────────────

export const REVEAL_RE = /^[0-9a-f]{64}:\d{1,6}$/;

/**
 * The unsigned reveal post (the AIP is appended by the BAP signer, feedApi publish). `parentTxid` is the public txid
 * of the revealed parent when reply_to's post was itself revealed; never pass a still-hidden parent.
 */
export function xRevealScript(r: XRecord, reveal: string, parentTxid: string | null = null): Script {
  if (!REVEAL_RE.test(reveal)) throw new Error('Bad record id');
  if (parentTxid !== null && !/^[0-9a-f]{64}$/.test(parentTxid)) throw new Error('Bad parent id');
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  pushStr(s, B_PREFIX);
  pushStr(s, r.text);
  pushStr(s, 'text/markdown');
  pushStr(s, 'UTF-8');
  s.writeBin([PIPE]);
  const kv: [string, string][] = [
    ['app', 'bChat'],
    ['type', 'post'],
  ];
  if (parentTxid) kv.push(['context', 'tx'], ['tx', parentTxid]);
  else if (r.reply_url) kv.push(['context', 'url'], ['url', r.reply_url]);
  kv.push(
    ['source', 'x'],
    ['source_id', r.x_id],
    ['source_at', r.created_at],
    ['source_url', r.url],
    ['reveal', reveal],
  );
  writeMap(s, kv);
  return s;
}

// ── §9 wallet media records ──────────────────────────────────────────────────

export type MediaKind = 'picture' | 'music' | 'video' | '3d' | 'bavatar';
export type MediaHeader = {
  v: 1;
  kind: MediaKind;
  mime: string;
  name: string;
  bytes: number;
  sha256: string;
  chunks: number;
  chunk_size: number;
};

/** What a private mint of this content type is, or null when §9 has no kind for it (public mint only). */
export function mediaKindFor(mime: string, hint?: string | null): MediaKind | null {
  if (hint === 'picture' || hint === 'music' || hint === 'video' || hint === '3d' || hint === 'bavatar') return hint;
  if (/^image\//i.test(mime)) return 'picture';
  if (/^audio\//i.test(mime)) return 'music';
  if (/^video\//i.test(mime)) return 'video';
  if (/^model\//i.test(mime)) return '3d';
  return null;
}

/** The mint sheets' rule: private unless the user chose "Make public now", or §9 has no kind for this file. */
export const mintIsPrivate = (makePublic: boolean, mime: string | null, hint?: string | null): boolean =>
  !makePublic && (mime === null || mediaKindFor(mime, hint) !== null);

export const chunkCount = (bytes: number) => Math.max(1, Math.ceil(bytes / CHUNK_SIZE));
/** Zero bytes up to the next multiple of 1024 strictly greater than the length. */
export const padZero = (b: number[]): number[] => [
  ...b,
  ...new Array<number>(Math.ceil((b.length + 1) / 1024) * 1024 - b.length).fill(0),
];

export function mediaHeader(kind: MediaKind, mime: string, name: string, file: number[]): MediaHeader {
  const chunks = chunkCount(file.length);
  if (chunks > MAX_CHUNKS) throw new Error('That file is too big to keep private.');
  return {
    v: 1,
    kind,
    mime,
    name,
    bytes: file.length,
    sha256: toHex(Hash.sha256(file)),
    chunks,
    chunk_size: CHUNK_SIZE,
  };
}

/** u32 BE header length ‖ header JSON ‖ first chunk ‖ zero padding. */
export function mediaHeadPlaintext(h: MediaHeader, file: number[]): number[] {
  const json = utf8(
    JSON.stringify({
      v: h.v,
      kind: h.kind,
      mime: h.mime,
      name: h.name,
      bytes: h.bytes,
      sha256: h.sha256,
      chunks: h.chunks,
      chunk_size: h.chunk_size,
    }),
  );
  const len = json.length;
  return padZero([
    (len >>> 24) & 255,
    (len >>> 16) & 255,
    (len >>> 8) & 255,
    len & 255,
    ...json,
    ...file.slice(0, CHUNK_SIZE),
  ]);
}

export const chunkPlaintext = (file: number[], i: number): number[] =>
  padZero(file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
export const chunkKeyID = (kid: string, i: number) => `${kid} ${i}`;
export const lockKeyID = (kid: string) => `lock ${kid}`;

/** Reader side of §9.3: header and the head's body bytes (trimmed), or null. */
export function parseMediaHead(pt: number[]): { header: MediaHeader; body: number[] } | null {
  if (pt.length < 4) return null;
  const len = ((pt[0] << 24) >>> 0) + (pt[1] << 16) + (pt[2] << 8) + pt[3];
  try {
    const h = JSON.parse(Utils.toUTF8(pt.slice(4, 4 + len))) as MediaHeader;
    if (h?.v !== 1 || typeof h.mime !== 'string' || !Number.isInteger(h.bytes) || !Number.isInteger(h.chunks))
      return null;
    const take = h.chunks > 1 ? h.chunk_size : h.bytes;
    return { header: h, body: pt.slice(4 + len, 4 + len + take) };
  } catch {
    return null;
  }
}

/** Joins the head body and chunks 1…n-1, trims to `bytes` and checks sha256; null when anything is off. */
export function assembleMedia(h: MediaHeader, head: number[], chunks: number[][]): number[] | null {
  if (chunks.length !== h.chunks - 1) return null;
  // Each part is cut to its true length (the last chunk: bytes - i*chunk_size) before joining.
  const parts = [head, ...chunks].map((c, i) => c.slice(0, Math.min(h.chunk_size, h.bytes - i * h.chunk_size)));
  const all = parts.flat();
  if (all.length !== h.bytes || toHex(Hash.sha256(all)) !== h.sha256) return null;
  return all;
}

/** OP_FALSE OP_IF "ord" OP_1 <type> OP_0 <ct> OP_ENDIF  P2PKH(lock)  OP_RETURN MAP … */
function ordScript(ciphertext: number[], lockPubKeyHash: number[], kv: [string, string][]): Script {
  if (lockPubKeyHash.length !== 20) throw new Error('Bad lock');
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_IF);
  pushStr(s, 'ord');
  s.writeOpCode(OP.OP_1);
  pushStr(s, PRIVATE_CONTENT_TYPE);
  s.writeOpCode(OP.OP_0);
  s.writeBin(ciphertext);
  s.writeOpCode(OP.OP_ENDIF);
  s.writeOpCode(OP.OP_DUP).writeOpCode(OP.OP_HASH160).writeBin(lockPubKeyHash);
  s.writeOpCode(OP.OP_EQUALVERIFY).writeOpCode(OP.OP_CHECKSIG);
  s.writeOpCode(OP.OP_RETURN);
  writeMap(s, kv);
  return s;
}

export function mediaHeadScript(ciphertext: number[], lockPubKeyHash: number[], kid: string, n: number): Script {
  if (!isKid(kid)) throw new Error('Bad record id');
  return ordScript(ciphertext, lockPubKeyHash, [
    ['app', 'bmintx'],
    ['type', 'media'],
    ['v', '1'],
    ['enc', 'brc2'],
    ['kid', kid],
    ['n', String(n)],
  ]);
}

export function mediaChunkScript(ciphertext: number[], lockPubKeyHash: number[], kid: string, i: number): Script {
  if (!isKid(kid)) throw new Error('Bad record id');
  return ordScript(ciphertext, lockPubKeyHash, [
    ['app', 'bmintx'],
    ['type', 'media-chunk'],
    ['v', '1'],
    ['enc', 'brc2'],
    ['kid', kid],
    ['i', String(i)],
  ]);
}

/** Reads a §9 head or chunk script: its ciphertext and MAP, or null. */
export function parseMediaScript(script: Script): { ciphertext: number[]; map: Record<string, string> } | null {
  const c = script.chunks;
  if (c[0]?.op !== OP.OP_FALSE || c[1]?.op !== OP.OP_IF) return null;
  if (Utils.toUTF8(c[2]?.data ?? []) !== 'ord' || c[3]?.op !== OP.OP_1) return null;
  if (Utils.toUTF8(c[4]?.data ?? []) !== PRIVATE_CONTENT_TYPE || c[5]?.op !== OP.OP_0) return null;
  const ciphertext = c[6]?.data;
  if (!ciphertext || c[7]?.op !== OP.OP_ENDIF) return null;
  const ret = c.findIndex((ch, i) => i > 7 && ch.op === OP.OP_RETURN);
  if (ret < 0) return null;
  // A serialised script keeps everything after OP_RETURN as one blob.
  const tail = c[ret].data?.length ? Script.fromBinary(c[ret].data!).chunks : c.slice(ret + 1);
  const pushes = tail.map((ch) => Utils.toUTF8(ch.data ?? []));
  if (pushes[0] !== MAP_PREFIX || pushes[1] !== 'SET') return null;
  const map: Record<string, string> = {};
  for (let i = 2; i + 1 < pushes.length; i += 2) map[pushes[i]] = pushes[i + 1];
  if (map.app !== 'bmintx' || (map.type !== 'media' && map.type !== 'media-chunk') || !isKid(map.kid ?? ''))
    return null;
  return { ciphertext, map };
}

// ── §9.6 media reveal ────────────────────────────────────────────────────────

/** Small enough to reveal inline in one feed post: image ≤ 250 KB, video ≤ 1 MB. */
export const SMALL_REVEAL_IMAGE = 250 * 1024;
export const SMALL_REVEAL_VIDEO = 1024 * 1024;
export const revealsInline = (mime: string, bytes: number) =>
  /^image\//i.test(mime) ? bytes <= SMALL_REVEAL_IMAGE : /^video\//i.test(mime) ? bytes <= SMALL_REVEAL_VIDEO : false;

/** Small reveal: B <clear bytes> <mime> binary <name> | MAP SET app bChat type post reveal <outpoint>. */
export function mediaRevealInlineScript(file: number[], mime: string, name: string, reveal: string): Script {
  if (!REVEAL_RE.test(reveal)) throw new Error('Bad record id');
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  pushStr(s, B_PREFIX);
  s.writeBin(file);
  pushStr(s, mime);
  pushStr(s, 'binary');
  pushStr(s, name);
  s.writeBin([PIPE]);
  writeMap(s, [
    ['app', 'bChat'],
    ['type', 'post'],
    ['reveal', reveal],
  ]);
  return s;
}

/** MAP on the clear re-inscription of a large reveal. */
export const mediaRevealInscriptionMap = (reveal: string): Record<string, string> => {
  if (!REVEAL_RE.test(reveal)) throw new Error('Bad record id');
  return { app: 'bmintx', type: 'media-reveal', reveal };
};

/** Large reveal's post: MAP SET app bChat type post media_0 <outpoint>|<mime> reveal <head outpoint>. */
export function mediaRevealRefScript(inscription: string, mime: string, reveal: string): Script {
  if (!REVEAL_RE.test(reveal)) throw new Error('Bad record id');
  if (!/^[0-9a-f]{64}_\d{1,6}$/.test(inscription)) throw new Error('Bad inscription id');
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  writeMap(s, [
    ['app', 'bChat'],
    ['type', 'post'],
    ['media_0', `${inscription}|${mime}`],
    ['reveal', reveal],
  ]);
  return s;
}
