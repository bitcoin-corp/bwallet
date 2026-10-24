/**
 * bMail over the wallet + message box. BRC-100 calls only (works with any BRC-100 wallet):
 *  - send: BRC-29 postage payment (createAction) + BRC-2 encrypt + messagebox sendMessage, one tap.
 *  - fetch: listMessages('bmail') → decode → verify postage (output to me ≥ claimed) → internalize → store → ack.
 *  - open: BRC-2 decrypt.
 */
import { MessageBoxClient } from '@bsv/message-box-client';
import { Beef, P2PKH, PublicKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import {
  BMAIL_BOX,
  BMAIL_PROTOCOL,
  BRC29_PROTOCOL,
  bytesToSealed,
  decodeEnvelope,
  encodeEnvelope,
  newMessageId,
  sealedToBytes,
  type Envelope,
  type Postage,
  type Sealed,
} from './envelope';
import type { Received, Sent } from './store';
import {
  LetterTooLargeError,
  TOO_LARGE_CONFIRMING,
  TOO_LARGE_TEXT,
  dropPending,
  isRefusal,
  letterKey,
  loadPending,
  putPending,
  relayLimit,
  trimPostageBeef,
  utf8Bytes,
  wocProof,
  type ProofFetcher,
} from './delivery';

/**
 * bMail's own relay (owner, 9 Oct 2026): messagebox.1sat.app refused recipients without a 1Sat account, so bMail
 * runs bitcoin-sv/message-box-server on our server, where any identity key can receive with no sign-up.
 * Override (testing / self-hosting): localStorage 'bwx.bmail.host' or globalThis.__BMAIL_HOST__, https only.
 */
export const BMAIL_DEFAULT_HOST = 'https://messagebox.bwalletx.com';
export const bmailHost = (): string => {
  const pick = (v: unknown) => (typeof v === 'string' && /^https:\/\/[^\s/]+/.test(v) ? v.replace(/\/+$/, '') : '');
  let stored: string | null = null;
  try {
    stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('bwx.bmail.host');
  } catch {
    stored = null;
  }
  return pick(stored) || pick((globalThis as { __BMAIL_HOST__?: unknown }).__BMAIL_HOST__) || BMAIL_DEFAULT_HOST;
};

const mbox = (wallet: WalletInterface) => new MessageBoxClient({ walletClient: wallet, host: bmailHost() });

export const myKey = async (wallet: WalletInterface) =>
  (await wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase();

const rand = () => Utils.toBase64([...crypto.getRandomValues(new Uint8Array(12))]);

/**
 * Sign a BRC-29 postage payment of `sats` to `to`. With `noSend` (the default for bMail sends) the wallet signs it
 * but does not broadcast: sendMail broadcasts only after the relay has accepted the letter, so a refused letter
 * never costs a stamp.
 */
export const payPostage = async (
  wallet: WalletInterface,
  to: string,
  sats: number,
  id: string,
  opts: { noSend?: boolean } = {},
): Promise<Postage> => {
  const derivationPrefix = rand();
  const derivationSuffix = rand();
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: to,
  });
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex();
  const r = await wallet.createAction({
    description: 'bMail postage',
    outputs: [{ lockingScript, satoshis: sats, outputDescription: `bMail stamp ${id.slice(0, 8)}` }],
    options: { randomizeOutputs: false, ...(opts.noSend ? { noSend: true } : {}) },
  });
  if (!r.tx || !r.txid) throw new Error('The wallet did not return the postage payment');
  return {
    txid: r.txid,
    sats,
    outputIndex: 0,
    beef: Utils.toHex(r.tx),
    derivationPrefix,
    derivationSuffix,
  };
};

/** Broadcast a postage tx signed with noSend (after the relay accepted the letter). */
export const ARC_URL = 'https://arc.gorillapool.io/v1/tx';

/**
 * Broadcast a postage tx signed with noSend (after the relay accepted the letter). The wallet is asked to send it
 * now (acceptDelayedBroadcast: false; a delayed share waits on a monitor the web wallet may not run, which left
 * the 18 Oct Bureau stamps unbroadcast). If the wallet does not report it sent, the BEEF goes straight to ARC.
 */
export const broadcastPostage = async (
  wallet: WalletInterface,
  postage: Pick<Postage, 'txid' | 'beef'>,
  fetchImpl: typeof fetch = fetch,
): Promise<'wallet' | 'arc'> => {
  try {
    const r = await wallet.createAction({
      description: 'bMail postage',
      options: { sendWith: [postage.txid], acceptDelayedBroadcast: false },
    });
    const mine = r.sendWithResults?.find((x) => x.txid === postage.txid);
    if (mine && mine.status !== 'failed') return 'wallet';
  } catch (e) {
    console.warn('[bMail] wallet postage broadcast failed', e);
  }
  const beef = Beef.fromBinary(Utils.toArray(postage.beef, 'hex')).toBinary();
  const res = await fetchImpl(ARC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(beef),
  });
  const j = (await res.json().catch(() => ({}))) as { txStatus?: string; status?: number; detail?: string };
  const ok = res.ok && !/REJECTED|DOUBLE_SPEND/i.test(String(j.txStatus ?? ''));
  if (!ok) throw new Error(`Postage broadcast failed: ${j.detail ?? j.txStatus ?? res.status}`);
  return 'arc';
};

/** Release a signed-but-never-broadcast stamp so its coins are spendable again. */
export const releasePostage = async (wallet: WalletInterface, txid: string) => {
  try {
    await wallet.abortAction({ reference: txid });
  } catch {
    /* already gone */
  }
};

export type SendArgs = {
  to: string;
  toLabel: string;
  sealed: Sealed;
  /** Total postage (stamp + reply-paid credit). 0 = unstamped. */
  sats: number;
  replyPaidSats: number;
  inReplyTo?: string;
  usesReplyCredit?: boolean;
  /** Postage already paid for this mail on an earlier attempt whose delivery failed: reuse it, do not pay twice. */
  postage?: Postage;
  /** Message id from that earlier attempt (keeps the postage stamp and the envelope id together). */
  id?: string;
  /** Called as soon as the stamp is signed, before delivery, so a caller can keep it if delivery then fails. */
  onPostagePaid?: (postage: Postage, id: string) => void | Promise<void>;
};

export type SendDeps = {
  /** Relay body limit in bytes (default: ask the relay, GET /limits). */
  limit?: number;
  /** Merkle proof lookup for trimming the postage BEEF (default WhatsOnChain; null = no lookup). */
  fetchProof?: ProofFetcher | null;
  /** fetch for the ARC fallback broadcast (tests). */
  broadcastFetch?: typeof fetch;
  /** Delivery (default: the message box client). */
  deliver?: (body: string) => Promise<unknown>;
};

/**
 * Send one letter. Order (never lose a stamp): sign postage with noSend → trim + size-check the envelope against the
 * relay limit → deliver to the relay → only then broadcast the stamp. A pending record (local) keeps the stamp
 * while this runs; a retry of the same letter (same recipient/subject/body) reuses it instead of paying again.
 */
export const sendMail = async (wallet: WalletInterface, a: SendArgs, deps: SendDeps = {}): Promise<Sent> => {
  const from = await myKey(wallet);
  const host = bmailHost();
  const key = letterKey(a.to, a.sealed.subject, a.sealed.body);
  const prior = a.postage ? undefined : loadPending<Postage>(from).find((p) => p.key === key && p.to === a.to);
  // Reuse the earlier stamp even if the price moved since (e.g. the BSV rate): it is already signed for this letter.
  const reuse = prior;
  const id = a.id ?? reuse?.id ?? newMessageId();
  const { ciphertext } = await wallet.encrypt({
    plaintext: sealedToBytes(a.sealed),
    protocolID: BMAIL_PROTOCOL,
    keyID: id,
    counterparty: a.to,
  });
  let postage = a.postage ?? reuse?.postage;
  let state: 'signed' | 'broadcast' | 'given' = a.postage ? 'given' : (reuse?.state ?? 'signed');
  if (!postage && a.sats > 0) {
    postage = await payPostage(wallet, a.to, a.sats, id, { noSend: true });
    state = 'signed';
    putPending(from, { key, id, to: a.to, postage, state, at: Date.now() });
    await a.onPostagePaid?.(postage, id);
  }
  const unbroadcast = state === 'signed' && !!postage;
  const giveUp = async () => {
    if (unbroadcast && postage) await releasePostage(wallet, postage.txid);
    if (state !== 'given') dropPending(from, key);
  };
  if (postage) {
    try {
      const fetchProof = deps.fetchProof === null ? undefined : (deps.fetchProof ?? wocProof());
      const beef = await trimPostageBeef(postage.beef, fetchProof);
      if (beef !== postage.beef) {
        postage = { ...postage, beef };
        if (state !== 'given') putPending(from, { key, id, to: a.to, postage, state, at: Date.now() });
      }
    } catch (e) {
      console.warn('[bMail] could not trim postage', e);
    }
  }
  const env: Envelope = { t: 'bmail', v: 1, id, from, to: a.to, at: Date.now(), sealed: Utils.toBase64(ciphertext) };
  if (postage) env.postage = postage;
  if (postage && a.replyPaidSats > 0) env.replyPaidSats = a.replyPaidSats;
  if (a.inReplyTo) env.inReplyTo = a.inReplyTo;
  if (a.usesReplyCredit) env.usesReplyCredit = true;
  const body = encodeEnvelope(env);
  const limit = deps.limit ?? (await relayLimit(host));
  const bytes = utf8Bytes(body);
  if (bytes > limit) {
    // The stamp alone is too big (its coins' unconfirmed ancestry): release it if unpaid; keep it if already paid.
    const stampBig = !!postage && utf8Bytes(body) - postage.beef.length < limit;
    if (state !== 'broadcast') await giveUp();
    throw new LetterTooLargeError(stampBig ? TOO_LARGE_CONFIRMING : TOO_LARGE_TEXT, bytes, limit);
  }
  // TODO(bmail pay-to-open): escrow the stamp instead of paying it outright (BMAIL.md §5.3).
  try {
    if (deps.deliver) await deps.deliver(body);
    else await mbox(wallet).sendMessage({ recipient: a.to, messageBox: BMAIL_BOX, body, skipEncryption: true }, host);
  } catch (e) {
    // A refusal (4xx) will not change on retry: release an unpaid stamp. Network/5xx: keep it for the retry.
    if (isRefusal(e) && state !== 'broadcast') await giveUp();
    if (/HTTP 413/.test(String((e as Error)?.message))) throw new LetterTooLargeError(TOO_LARGE_TEXT, bytes, limit);
    throw e;
  }
  if (unbroadcast && postage) {
    try {
      await broadcastPostage(wallet, postage, deps.broadcastFetch);
    } catch (e) {
      // Delivered: the recipient's wallet broadcasts the stamp when it accepts it, so the letter still counts.
      console.warn('[bMail] postage broadcast after delivery failed', e);
    }
  }
  if (state !== 'given') dropPending(from, key);
  return {
    id,
    to: a.to,
    toLabel: a.toLabel,
    at: env.at,
    subject: a.sealed.subject,
    body: a.sealed.body,
    sats: postage?.sats ?? 0,
    replyPaidSats: env.replyPaidSats ?? 0,
    txid: postage?.txid,
    inReplyTo: a.inReplyTo,
    ...(a.sealed.agreement !== undefined ? { agreement: a.sealed.agreement } : {}),
    ...(a.sealed.offer !== undefined ? { offer: a.sealed.offer } : {}),
  };
};

/**
 * Check the postage: the BEEF's tx has the claimed txid, and its output pays ≥ claimed sats to the BRC-29 key
 * only I can derive from the sender's key. Then internalize it (the wallet validates and keeps the coins).
 * Returns verified sats (0 when anything fails).
 */
export const verifyPostage = async (
  wallet: WalletInterface,
  env: Envelope,
  internalize = true,
): Promise<{ sats: number; note?: string }> => {
  const p = env.postage;
  if (!p) return { sats: 0 };
  try {
    const tx = Transaction.fromAtomicBEEF(Utils.toArray(p.beef, 'hex'));
    if (tx.id('hex') !== p.txid) return { sats: 0, note: 'Postage txid does not match' };
    const out = tx.outputs[p.outputIndex];
    if (!out || (out.satoshis ?? 0) < p.sats) return { sats: 0, note: 'Postage output is smaller than claimed' };
    const { publicKey } = await wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${p.derivationPrefix} ${p.derivationSuffix}`,
      counterparty: env.from,
      forSelf: true,
    });
    const want = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex();
    if (out.lockingScript.toHex() !== want) return { sats: 0, note: 'Postage is not paid to you' };
    if (!internalize) return { sats: out.satoshis ?? 0 };
    try {
      await wallet.internalizeAction({
        tx: Utils.toArray(p.beef, 'hex'),
        outputs: [
          {
            outputIndex: p.outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: p.derivationPrefix,
              derivationSuffix: p.derivationSuffix,
              senderIdentityKey: env.from,
            },
          },
        ],
        description: 'bMail postage received',
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // Already internalized on an earlier fetch is fine; anything else means the payment is not good.
      if (!/already|duplicate|exists/i.test(m)) return { sats: 0, note: `Postage not accepted: ${m}`.slice(0, 160) };
    }
    return { sats: out.satoshis ?? 0 };
  } catch (e) {
    return { sats: 0, note: e instanceof Error ? e.message.slice(0, 160) : 'Bad postage' };
  }
};

/** Fetch new mail, verify postage, return items to store plus relay ids to acknowledge afterwards. */
export const fetchMail = async (
  wallet: WalletInterface,
  ctx: { me: string; sent: Sent[]; known: Set<string> },
): Promise<{ items: Received[]; ack: string[] }> => {
  const client = mbox(wallet);
  const msgs = await client.listMessages({ messageBox: BMAIL_BOX, host: bmailHost() });
  const items: Received[] = [];
  const ack: string[] = [];
  for (const m of msgs) {
    const env = decodeEnvelope(m.body);
    // Not bMail, or the relay-authenticated sender is not who the envelope claims: drop it.
    if (!env || env.from !== String(m.sender).toLowerCase() || env.to !== ctx.me) {
      ack.push(m.messageId);
      continue;
    }
    if (ctx.known.has(env.id)) {
      ack.push(m.messageId);
      continue;
    }
    const v = await verifyPostage(wallet, env);
    const mine = env.inReplyTo ? ctx.sent.find((s) => s.id === env.inReplyTo && s.to === env.from) : undefined;
    const replyCredit = !!(env.usesReplyCredit && mine && mine.replyPaidSats > 0);
    items.push({
      id: env.id,
      from: env.from,
      at: Math.min(env.at, Date.now()),
      verifiedSats: replyCredit ? Math.max(v.sats, mine?.replyPaidSats ?? 0) : v.sats,
      replyCredit,
      env,
      relayId: m.messageId,
      verifyNote: v.note,
    });
    ack.push(m.messageId);
  }
  return { items, ack };
};

/**
 * Notifier peek (notify/engine.ts): list the bmail box WITHOUT acknowledging or internalizing anything, so the
 * bMail screen still receives every message. Postage is checked read-only.
 */
export const peekMail = async (wallet: WalletInterface, me: string): Promise<{ env: Envelope; sats: number }[]> => {
  const msgs = await mbox(wallet).listMessages({ messageBox: BMAIL_BOX, host: bmailHost() });
  const out: { env: Envelope; sats: number }[] = [];
  for (const m of msgs) {
    const env = decodeEnvelope(m.body);
    if (!env || env.from !== String(m.sender).toLowerCase() || env.to !== me) continue;
    out.push({ env, sats: (await verifyPostage(wallet, env, false)).sats });
  }
  return out;
};

export const acknowledge = async (wallet: WalletInterface, ids: string[]) => {
  if (ids.length) await mbox(wallet).acknowledgeMessage({ messageIds: ids, host: bmailHost() });
};

export const openMail = async (wallet: WalletInterface, env: Envelope): Promise<Sealed> => {
  const { plaintext } = await wallet.decrypt({
    ciphertext: Utils.toArray(env.sealed, 'base64'),
    protocolID: BMAIL_PROTOCOL,
    keyID: env.id,
    counterparty: env.from,
  });
  // TODO(bmail receipts): for Certified / pay-to-open mail, sign + broadcast an open receipt here (BMAIL.md §5.2).
  return bytesToSealed(plaintext);
};
