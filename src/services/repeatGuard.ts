/**
 * Never pay twice for the same thing while the first payment is still going out.
 *
 * vexvoid.com, 11 Oct 2026: a 6.4 MB video mint was paid three times (~670,000 sats each). Each time the
 * broadcaster answered "service error" at first, the site showed a failure, and the owner tried again; the
 * wallet had queued every one of them ('sending') and the Monitor's SendWaiting task kept retrying until all
 * three went out. Retrying a queued payment is right for the toolbox. Building an identical new one is not.
 *
 * A site's createAction is fingerprinted by its outputs. An inscription's fingerprint is its content (the
 * envelope), with any P2PKH lock removed, so a fresh receive address per attempt still matches. A second
 * identical request within REPEAT_WINDOW_MS is refused with a plain message, unless the first one was
 * aborted. Display and refusal only: nothing here builds, signs, sends or aborts a transaction.
 */
import type { CreateActionArgs } from '@bsv/sdk';

export const REPEAT_WINDOW_MS = 60 * 60 * 1000;

const ORD_MARKER = '0063036f7264'; // OP_FALSE OP_IF "ord"
const P2PKH = /76a914[0-9a-f]{40}88ac/g;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fingerprint of what a createAction pays for, or null when it isn't worth guarding (no outputs, or only
 * small plain payments, where repeats are normal: tips, chat messages).
 */
export async function requestFingerprint(
  args: Pick<CreateActionArgs, 'outputs'>,
  minScriptHex = 2_000,
): Promise<string | null> {
  const parts: string[] = [];
  for (const o of args.outputs ?? []) {
    const s = (o.lockingScript ?? '').toLowerCase();
    if (s.includes(ORD_MARKER)) parts.push(`ord:${s.replace(P2PKH, '')}`);
    else if (s.length >= minScriptHex) parts.push(`big:${s}:${o.satoshis}`);
  }
  if (!parts.length) return null;
  return sha256Hex(parts.sort().join('|'));
}

/**
 * The fingerprint a site's createAction is checked against, and the one recorded after it. Chain options
 * (sendWith, noSendChange, knownTxids, noSend) are the site's own words: they never switch the check off (b-Aware
 * row 55, 24 Oct 2026). A noSend step is checked but not recorded, because nothing has gone out yet and a retried
 * chain must not be refused for it.
 */
export async function repeatFingerprints(
  args: Pick<CreateActionArgs, 'outputs' | 'options'>,
): Promise<{ fingerprint: string | null; recordedFingerprint: string | null }> {
  const fingerprint = await requestFingerprint(args);
  return { fingerprint, recordedFingerprint: args.options?.noSend ? null : fingerprint };
}

export type RepeatEntry = { at: number; origin?: string; reference?: string; txid?: string; aborted?: boolean };

export class RepeatGuard {
  private entries = new Map<string, RepeatEntry>();

  constructor(private now: () => number = Date.now) {}

  /** For chrome.storage.session: the background service worker sleeps after ~30 s idle and forgets memory. */
  toJSON(): [string, RepeatEntry][] {
    return [...this.entries];
  }
  load(saved: unknown) {
    if (!Array.isArray(saved)) return;
    for (const [fp, e] of saved as [string, RepeatEntry][])
      if (typeof fp === 'string' && e && typeof e.at === 'number') this.entries.set(fp, e);
  }

  /** The earlier identical request still in its window, or null. */
  check(fp: string | null): RepeatEntry | null {
    if (!fp) return null;
    const e = this.entries.get(fp);
    if (!e) return null;
    if (e.aborted || this.now() - e.at > REPEAT_WINDOW_MS) {
      this.entries.delete(fp);
      return null;
    }
    return e;
  }

  record(fp: string | null, e: Omit<RepeatEntry, 'at'>) {
    if (fp) this.entries.set(fp, { ...e, at: this.now() });
  }

  /** signAction gave the reference its txid. */
  signed(reference: string | undefined, txid: string | undefined) {
    if (!reference || !txid) return;
    for (const e of this.entries.values()) if (e.reference === reference) e.txid = txid;
  }

  /** The site's abort really cancelled it: an identical request may go ahead. */
  aborted(reference: string | undefined) {
    if (!reference) return;
    for (const e of this.entries.values()) if (e.reference === reference || e.txid === reference) e.aborted = true;
  }
}

export function repeatRefusal(e: RepeatEntry, now = Date.now()): string {
  const mins = Math.max(1, Math.round((now - e.at) / 60_000));
  return (
    `This exact payment is already on its way (sent ${mins} minute${mins === 1 ? '' : 's'} ago). ` +
    `Your wallet keeps trying until the network accepts it, so you don't need to pay again. ` +
    `Check your History in a few minutes.`
  );
}

/** A send the toolbox queued to retry ('sending'), as opposed to a real failure. */
export function queuedSend(error: unknown): boolean {
  const r = (error as { sendWithResults?: { status?: string }[] } | null)?.sendWithResults;
  return Array.isArray(r) && r.length > 0 && r.every((x) => x?.status === 'sending');
}

export const QUEUED_MESSAGE =
  "Sent. The network is slow to accept it right now, and your wallet will keep trying on its own. Don't pay again: check your History in a few minutes.";

/**
 * A queued send as a BRC-100 answer: { txid, pending: true, message, sendWithResults }. A site that reads txid gets
 * one (and the outpoint it will have), and can show "pending" instead of an error. Null unless the error is a queued
 * send with a txid. `pending` and `message` are extra fields; BRC-100 callers that don't know them ignore them.
 */
export type QueuedResult = {
  txid: string;
  pending: true;
  message: string;
  sendWithResults: { txid: string; status: 'sending' }[];
  tx?: number[];
};

const TXID = /^[0-9a-f]{64}$/i;
const isTxid = (t: unknown): t is string => typeof t === 'string' && TXID.test(t);

/** The txid of an atomic BEEF (BRC-95): 4-byte prefix 0x01010101, then the subject txid, little-endian. */
function atomicBeefTxid(tx: unknown): string | null {
  if (!Array.isArray(tx) && !(tx instanceof Uint8Array)) return null;
  const b = tx as ArrayLike<number>;
  if (b.length < 36 || b[0] !== 1 || b[1] !== 1 || b[2] !== 1 || b[3] !== 1) return null;
  let hex = '';
  for (let i = 35; i >= 4; i--) hex += (b[i] & 0xff).toString(16).padStart(2, '0');
  return hex;
}

/**
 * The txid of a queued send, from wherever the error carries it: its txid, its sendWithResults, its
 * reviewActionResults, or the atomic BEEF in its tx. `fallbackTxid` (e.g. looked up in storage by the action's
 * reference) is used when the error has none.
 */
export function queuedResult(error: unknown, fallbackTxid?: string | null): QueuedResult | null {
  if (!queuedSend(error)) return null;
  const e = error as {
    txid?: unknown;
    tx?: unknown;
    sendWithResults: { txid?: unknown }[];
    reviewActionResults?: { txid?: unknown }[];
  };
  const txid =
    (isTxid(e.txid) ? e.txid : null) ??
    e.sendWithResults.map((r) => r?.txid).find(isTxid) ??
    (Array.isArray(e.reviewActionResults) ? e.reviewActionResults.map((r) => r?.txid).find(isTxid) : undefined) ??
    atomicBeefTxid(e.tx) ??
    (isTxid(fallbackTxid) ? fallbackTxid : null);
  if (!txid) return null;
  const sent = e.sendWithResults.map((r) => r?.txid).filter(isTxid);
  return {
    txid,
    pending: true,
    message: QUEUED_MESSAGE,
    sendWithResults: (sent.length ? sent : [txid]).map((t) => ({ txid: t, status: 'sending' as const })),
    ...(Array.isArray(e.tx) ? { tx: e.tx as number[] } : {}),
  };
}
