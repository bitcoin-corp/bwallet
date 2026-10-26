import { executeTrackedAction, inscribe, type OneSatContext } from '@1sat/actions';
import { Hash, PublicKey, Script, Transaction, Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import { publish } from '../feed/feedApi';
import { fileToBase64, withFeeOutput } from '../mint/mint';
import {
  ARCHIVE_PROTOCOL,
  assembleMedia,
  chunkCount,
  chunkKeyID,
  chunkPlaintext,
  lockKeyID,
  mediaChunkScript,
  mediaHeader,
  mediaHeadPlaintext,
  mediaHeadScript,
  mediaRevealInlineScript,
  mediaRevealInscriptionMap,
  mediaRevealRefScript,
  parseMediaHead,
  parseMediaScript,
  planXBatches,
  randomKid,
  revealsInline,
  sealData,
  sealKeyID,
  sealScript,
  validXRecord,
  xPlaintext,
  xRecordBytes,
  xRecordScript,
  type Encrypt,
  type MediaHeader,
  type MediaKind,
  type XRecord,
} from './records';

/**
 * Private mints (owner, 25 Oct 2026: every in-wallet mint of user content is encrypted by default). The wallet
 * encrypts with its own keys as admin (no originator), so services/pinnedProtocols.ts is never involved and no outside
 * site ever holds [2,'bmintx archive']. Plaintext never leaves this device: only ciphertext goes into the outputs.
 */

/** Wallet basket for the 1-sat private media outputs (kept apart from the public ordinals basket). */
export const PRIVATE_BASKET = 'bmintx private';
/** Label on every private media mint; the vault finds them with listActions. */
export const MEDIA_LABEL = 'bmintx media';
export const ARCHIVE_LABEL = 'bmintx archive';
export const batchLabel = (kid: string) => `bmintx batch ${kid}`;
/** The UI keeps a private mint inside one transaction (spec: 10 MB of outputs per tx). 18 chunks ≈ 9.5 MB. */
export const MAX_PRIVATE_BYTES = 9 * 1024 * 1024;

const self = { protocolID: ARCHIVE_PROTOCOL, counterparty: 'self' as const };

export const walletEncrypt =
  (wallet: WalletInterface): Encrypt =>
  async (plaintext, keyID) =>
    (await wallet.encrypt({ ...self, plaintext, keyID })).ciphertext;

const lockHash = async (wallet: WalletInterface, kid: string) => {
  const { publicKey } = await wallet.getPublicKey({ ...self, keyID: lockKeyID(kid) });
  return PublicKey.fromString(publicKey).toHash() as number[];
};

/** §4 seal, or null when the wallet can't sign (readers must not require it). */
async function seal(wallet: WalletInterface, kid: string, cts: number[][]) {
  try {
    const keyID = sealKeyID(kid);
    const { publicKey } = await wallet.getPublicKey({ ...self, keyID });
    const { signature } = await wallet.createSignature({ ...self, keyID, data: sealData(cts) });
    return sealScript(cts.length, kid, publicKey, Utils.toHex(signature));
  } catch {
    return null;
  }
}

export type PrivateMediaPlan = {
  kid: string;
  header: MediaHeader;
  outputs: CreateActionArgs['outputs'] & object;
};

/**
 * Builds the outputs of one private media mint (§9): head, chunks 1…n-1 (all 1 sat, same per-record lock), then the
 * seal when n > 1. Pure apart from the wallet's encrypt / getPublicKey / createSignature.
 */
export async function planPrivateMedia(
  wallet: WalletInterface,
  m: { file: number[]; mime: string; name: string; kind: MediaKind },
  opts: { encrypt?: Encrypt; kid?: string } = {},
): Promise<PrivateMediaPlan> {
  const kid = opts.kid ?? randomKid();
  const encrypt = opts.encrypt ?? walletEncrypt(wallet);
  const header = mediaHeader(m.kind, m.mime, m.name, m.file);
  const lock = await lockHash(wallet, kid);
  const n = header.chunks;
  const custom = (i: number) =>
    JSON.stringify({ protocolID: ARCHIVE_PROTOCOL, keyID: lockKeyID(kid), counterparty: 'self', kid, i });
  const cts: number[][] = [await encrypt(mediaHeadPlaintext(header, m.file), kid)];
  const outputs: PrivateMediaPlan['outputs'] = [
    {
      lockingScript: mediaHeadScript(cts[0], lock, kid, n).toHex(),
      satoshis: 1,
      outputDescription: 'Private item (locked to you)',
      basket: PRIVATE_BASKET,
      tags: [`kid:${kid}`, 'part:head', `kind:${m.kind}`],
      customInstructions: custom(0),
    },
  ];
  for (let i = 1; i < n; i++) {
    const ct = await encrypt(chunkPlaintext(m.file, i), chunkKeyID(kid, i));
    cts.push(ct);
    outputs.push({
      lockingScript: mediaChunkScript(ct, lock, kid, i).toHex(),
      satoshis: 1,
      outputDescription: `Private item, part ${i + 1} of ${n}`,
      basket: PRIVATE_BASKET,
      tags: [`kid:${kid}`, `part:${i}`],
      customInstructions: custom(i),
    });
  }
  if (n > 1) {
    const s = await seal(wallet, kid, cts);
    if (s) outputs.push({ lockingScript: s.toHex(), satoshis: 0, outputDescription: 'Private item seal' });
  }
  return { kid, header, outputs };
}

/** Ciphertext bytes the outputs of a private mint carry, for the fee estimate (no encryption needed). */
export function privateMediaBytes(fileBytes: number): number {
  const n = chunkCount(fileBytes);
  // head: 4 + ~260 header + first chunk, zero-padded to 1024 (strictly above), + 48; chunks the same without header.
  const pad = (len: number) => Math.ceil((len + 1) / 1024) * 1024 + 48;
  const first = Math.min(fileBytes, 524288);
  let total = pad(4 + 300 + first) + 140; // + envelope, lock, MAP
  for (let i = 1; i < n; i++) total += pad(Math.min(524288, fileBytes - i * 524288)) + 140;
  if (n > 1) total += 260; // seal
  return total;
}

export type PrivateMintResult = { txid: string; kid: string; outpoint: string; networkSats: number | null };

/**
 * One private media mint, one transaction. Same fee rules as the public mint: the 1% bWallet mint fee output
 * (withFeeOutput) when one is built in. No issuer signature and no bit-sign registration: both would publicly tie the
 * private record to the account.
 */
export async function mintPrivateMedia(
  ctx: OneSatContext,
  m: { file: number[]; mime: string; name: string; kind: MediaKind; feeSats: number },
): Promise<PrivateMintResult> {
  const plan = await planPrivateMedia(ctx.wallet as WalletInterface, m);
  const wallet = withFeeOutput(ctx, m.feeSats).wallet as WalletInterface;
  const res = await executeTrackedAction(wallet, {
    description: `Mint privately (${m.kind})`,
    outputs: plan.outputs,
    labels: [MEDIA_LABEL],
    options: { randomizeOutputs: false },
  });
  if (!res.txid) throw new Error('The wallet did not return a transaction id.');
  let networkSats: number | null = null;
  try {
    if (res.tx) networkSats = Transaction.fromAtomicBEEF(res.tx).getFee();
  } catch {
    networkSats = null;
  }
  return { txid: res.txid, kid: plan.kid, outpoint: `${res.txid}:0`, networkSats };
}

// ── reading your own private media ───────────────────────────────────────────

export type PrivateItem = {
  /** Head record id, `<txid>:<vout>`. */
  outpoint: string;
  kid: string;
  header: MediaHeader;
  /** The clear file, in memory only. */
  file: Uint8Array<ArrayBuffer>;
};

/**
 * Your private media, newest first: listActions by label, then decrypt each head and its chunks (§9.5). Records that
 * fail to decrypt or fail the sha256 are skipped. Nothing decrypted is stored.
 */
export async function listPrivateMedia(wallet: WalletInterface, limit = 50, offset = 0): Promise<PrivateItem[]> {
  const { actions } = await wallet.listActions({
    labels: [MEDIA_LABEL],
    includeOutputs: true,
    includeOutputLockingScripts: true,
    limit,
    offset,
  });
  const out: PrivateItem[] = [];
  for (const a of [...actions].reverse()) {
    const parsed = (a.outputs ?? [])
      .map((o) => ({
        vout: o.outputIndex,
        rec: o.lockingScript ? parseMediaScript(Script.fromHex(o.lockingScript)) : null,
      }))
      .filter((p) => p.rec);
    for (const head of parsed.filter((p) => p.rec!.map.type === 'media')) {
      const kid = head.rec!.map.kid;
      try {
        const pt = (await wallet.decrypt({ ...self, keyID: kid, ciphertext: head.rec!.ciphertext })).plaintext;
        const h = parseMediaHead(pt);
        if (!h) continue;
        const chunks: number[][] = [];
        for (let i = 1; i < h.header.chunks; i++) {
          const c = parsed.find(
            (p) => p.rec!.map.type === 'media-chunk' && p.rec!.map.kid === kid && p.rec!.map.i === String(i),
          );
          if (!c) throw new Error('missing chunk');
          chunks.push(
            (await wallet.decrypt({ ...self, keyID: chunkKeyID(kid, i), ciphertext: c.rec!.ciphertext })).plaintext,
          );
        }
        const file = assembleMedia(h.header, h.body, chunks);
        if (file) out.push({ outpoint: `${a.txid}:${head.vout}`, kid, header: h.header, file: new Uint8Array(file) });
      } catch {
        // not ours, or incomplete: skip
      }
    }
  }
  return out;
}

// ── reveal (one-way) ─────────────────────────────────────────────────────────

/** Labels a reveal post so the vault can mark the item Public. */
export const REVEAL_LABEL = 'bchat reveal';
export const revealTag = (outpoint: string) => `reveal:${outpoint}`;

/**
 * §9.6: makes one private item public for good. Small images / videos go inline in one bChat post; anything else is
 * inscribed in clear as a normal 1-sat ordinal (MAP type media-reveal) and a post references it. Both posts are
 * AIP-signed with the account's BAP posting identity (feedApi publish, the same path bChatX posts use).
 * The private record stays encrypted and unspent.
 */
export async function revealMedia(
  ctx: OneSatContext,
  item: PrivateItem,
): Promise<{ postTxid: string; inscription?: string }> {
  const { mime, name, bytes } = item.header;
  const file = Array.from(item.file);
  if (revealsInline(mime, bytes)) {
    const postTxid = await publish(
      ctx,
      mediaRevealInlineScript(file, mime, name, item.outpoint),
      'Reveal (public post)',
      [revealTag(item.outpoint)],
      undefined,
      [REVEAL_LABEL],
    );
    return { postTxid };
  }
  const ins = await inscribe.execute(ctx, {
    base64Content: fileToBase64(item.file.buffer as ArrayBuffer),
    contentType: mime,
    map: mediaRevealInscriptionMap(item.outpoint),
  });
  if (!ins.txid || ins.error) throw new Error(ins.error || 'Reveal failed');
  const inscription = `${ins.txid}_0`;
  const postTxid = await publish(
    ctx,
    mediaRevealRefScript(inscription, mime, item.outpoint),
    'Reveal (public post)',
    [revealTag(item.outpoint)],
    undefined,
    [REVEAL_LABEL],
  );
  return { postTxid, inscription };
}

// ── mintPrivate({ source: 'x', items }) ──────────────────────────────────────

export type XBatchPlan = {
  batchKid: string;
  records: { kid: string; plaintext: number[]; x_id: string; index: number }[];
};

/** Validates and packs X records (§5: 250 per tx, 180,000 bytes of record outputs). Throws on a bad item. */
export function planXMint(items: unknown[]): XBatchPlan[] {
  if (!Array.isArray(items) || !items.length) throw new Error('Nothing to lock.');
  const recs = items.map((r, i) => {
    if (!validXRecord(r)) throw new Error(`Item ${i + 1} is not a valid post.`);
    return { kid: randomKid(), plaintext: xPlaintext(r as XRecord), x_id: (r as XRecord).x_id, index: i };
  });
  return planXBatches(recs, (r) => xRecordBytes(r.plaintext.length)).map((records) => ({
    batchKid: randomKid(),
    records,
  }));
}

/** Rough cost for the one sheet: record bytes + per-tx overhead at the fee rate. */
export function estimateXMint(plans: XBatchPlan[], satsPerKb: number): { sats: number; txs: number; posts: number } {
  const bytes = plans.reduce(
    (s, p) => s + p.records.reduce((t, r) => t + xRecordBytes(r.plaintext.length), 0) + 600,
    0,
  );
  return {
    sats: Math.ceil((bytes * satsPerKb) / 1000),
    txs: plans.length,
    posts: plans.reduce((s, p) => s + p.records.length, 0),
  };
}

/**
 * Locks X posts to the user: each batch is one transaction (records at vouts 0…n-1, then the seal, then change),
 * labelled per §5 so a resumed import can check what was made. Returns the txids in order. Run only after the
 * user approved the one sheet.
 */
export async function mintPrivateX(
  ctx: OneSatContext,
  plans: XBatchPlan[],
  opts: {
    encrypt?: Encrypt;
    onProgress?: (done: number, total: number) => void;
    /** Called after each landed batch (so a resumed request never mints it twice). */
    onBatch?: (txid: string, records: MintedRecord[]) => void;
  } = {},
): Promise<string[]> {
  const wallet = ctx.wallet as WalletInterface;
  const encrypt = opts.encrypt ?? walletEncrypt(wallet);
  const txids: string[] = [];
  for (const p of plans) {
    const cts: number[][] = [];
    const outputs: CreateActionArgs['outputs'] & object = [];
    for (const r of p.records) {
      const ct = await encrypt(r.plaintext, r.kid);
      cts.push(ct);
      outputs.push({ lockingScript: xRecordScript(ct, r.kid).toHex(), satoshis: 0, outputDescription: 'Private post' });
    }
    const s = await seal(wallet, p.batchKid, cts);
    if (s) outputs.push({ lockingScript: s.toHex(), satoshis: 0, outputDescription: 'Private posts seal' });
    const res = await executeTrackedAction(wallet, {
      description: `Lock ${p.records.length} posts to you`,
      outputs,
      labels: [ARCHIVE_LABEL, batchLabel(p.batchKid)],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: true },
    });
    if (!res.txid) throw new Error('The wallet did not return a transaction id.');
    txids.push(res.txid);
    opts.onBatch?.(
      res.txid,
      p.records.map((r, vout) => ({ x_id: r.x_id, index: r.index, outpoint: `${res.txid}:${vout}` })),
    );
    opts.onProgress?.(txids.length, plans.length);
  }
  return txids;
}

// ── the wallet request (spec §10) ────────────────────────────────────────────

export type MintedRecord = { x_id: string; index: number; outpoint: string };
export type MintPrivateResult = {
  records: { x_id: string; outpoint: string }[];
  txids: string[];
  complete: boolean;
  /** Index of the first item not minted when complete is false. */
  stoppedAt?: number;
};
export const MAX_REQUEST_ITEMS = 25_000;

export class MintPrivateError extends Error {
  constructor(
    public code: 'USER_REFUSED' | 'REQUEST_ID_REUSED' | 'BAD_REQUEST' | 'TOO_MANY_ITEMS',
    message: string,
  ) {
    super(message);
    this.name = 'MintPrivateError';
  }
}

/** Stored per request: the items' hash and every record minted so far. Ids and outpoints only, never text. */
type Stored = { hash: string; total: number; minted: MintedRecord[]; txids: string[] };
export type RequestStore = { get: (key: string) => Stored | null; set: (key: string, v: Stored) => void };

export const localRequestStore = (prefix = 'bw.mintPrivate.'): RequestStore => ({
  get: (k) => {
    try {
      const v = localStorage.getItem(prefix + k);
      return v ? (JSON.parse(v) as Stored) : null;
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(prefix + k, JSON.stringify(v));
    } catch {
      // storage full / blocked: idempotency then holds for this session only
    }
  },
});

/** sha256 over the canonical items (each re-serialised in §2 field order). */
export const itemsHash = (items: XRecord[]): string =>
  Utils.toHex(
    Hash.sha256(Utils.toArray(JSON.stringify(items.map((r) => Utils.toUTF8(xPlaintext(r)).trimEnd())), 'utf8')),
  );

const resultOf = (s: Stored): MintPrivateResult => {
  const records = [...s.minted].sort((a, b) => a.index - b.index);
  const done = new Set(records.map((r) => r.index));
  let first = 0;
  while (done.has(first)) first++;
  const complete = first >= s.total;
  return {
    records: records.map(({ x_id, outpoint }) => ({ x_id, outpoint })),
    txids: s.txids,
    complete,
    ...(!complete && { stoppedAt: first }),
  };
};

/**
 * `wallet.mintPrivate({ source:'x', requestId, items })` (spec §10, amended 26 Oct 2026 with bChatX).
 * requestId is scoped to originator + identity key. Same id + same items → the stored result, plus any items not yet
 * minted, minted now (never twice). Same id + different items → REQUEST_ID_REUSED, nothing minted. One sheet
 * (`confirm`) for the whole request; a decline → USER_REFUSED, nothing minted. A failure part way returns
 * complete:false with stoppedAt.
 */
export async function handleMintPrivate(
  ctx: OneSatContext,
  req: { source?: unknown; requestId?: unknown; items?: unknown },
  env: {
    originator: string;
    identityKey: string;
    satsPerKb: number;
    confirm: (sheet: { posts: number; sats: number; txs: number; originator: string }) => Promise<boolean>;
    store?: RequestStore;
    encrypt?: Encrypt;
  },
): Promise<MintPrivateResult> {
  if (req.source !== 'x') throw new MintPrivateError('BAD_REQUEST', "Only source 'x' is supported.");
  if (typeof req.requestId !== 'string' || !/^[\w-]{8,100}$/.test(req.requestId))
    throw new MintPrivateError('BAD_REQUEST', 'A requestId is required.');
  if (!Array.isArray(req.items) || !req.items.length) throw new MintPrivateError('BAD_REQUEST', 'Nothing to lock.');
  if (req.items.length > MAX_REQUEST_ITEMS)
    throw new MintPrivateError('TOO_MANY_ITEMS', `Up to ${MAX_REQUEST_ITEMS} items per request.`);
  req.items.forEach((r, i) => {
    if (!validXRecord(r)) throw new MintPrivateError('BAD_REQUEST', `Item ${i + 1} is not a valid post.`);
  });
  const items = req.items as XRecord[];
  const store = env.store ?? localRequestStore();
  const key = `${env.originator}|${env.identityKey}|${req.requestId}`;
  const hash = itemsHash(items);
  const prior = store.get(key);
  if (prior && prior.hash !== hash)
    throw new MintPrivateError('REQUEST_ID_REUSED', 'This requestId was used with different items.');
  const state: Stored = prior ?? { hash, total: items.length, minted: [], txids: [] };
  const done = new Set(state.minted.map((m) => m.index));
  const todo = items.map((r, index) => ({ r, index })).filter((x) => !done.has(x.index));
  if (!todo.length) return resultOf(state);
  const plans = planXMint(todo.map((x) => x.r)).map((p) => ({
    ...p,
    records: p.records.map((rec) => ({ ...rec, index: todo[rec.index].index })),
  }));
  const est = estimateXMint(plans, env.satsPerKb);
  if (!(await env.confirm({ posts: est.posts, sats: est.sats, txs: est.txs, originator: env.originator })))
    throw new MintPrivateError('USER_REFUSED', 'The user declined.');
  try {
    await mintPrivateX(ctx, plans, {
      encrypt: env.encrypt,
      onBatch: (txid, records) => {
        state.txids.push(txid);
        state.minted.push(...records);
        store.set(key, state);
      },
    });
  } catch {
    // Stop here: what landed is stored and returned; the rest can be resumed with the same requestId.
  }
  store.set(key, state);
  return resultOf(state);
}
