import type { PrivateKey } from '@bsv/sdk';
import { StreamHttpError, type KeyResponse, type PayTo } from './api';
import { buildSegmentTx, coinSats, InsufficientBudget, SEGMENT_FEE, signSegment, type Coin } from './tx';

/**
 * Session-key payer: one signed tx per second, chained on unconfirmed change. Only a 200 from the server
 * advances the chain. Any failure stops the payer ('error', with the server's real status) until resync(),
 * which goes back to the last accepted change. A failure with no HTTP status (network dropped) leaves the
 * pending tx as "maybe broadcast", so sweeping tries its change first.
 */
export type PayerStatus = 'ready' | 'paying' | 'error' | 'out' | 'closed';
export type PayerStats = {
  artistSats: number;
  feeSats: number;
  payments: number;
  lastTxid: string | null;
  /** ms timestamps of recent accepted payments, for payments/second. */
  recent: number[];
};
export type PayerSnapshot = { status: PayerStatus; error: string | null; stats: PayerStats; balance: number };

export type PayerDeps = {
  key: PrivateKey;
  coin: Coin;
  getPayTo: (trackId: string, segment: number) => Promise<PayTo>;
  post: (body: {
    trackId: string;
    segment: number;
    rawTx: string;
    listener: string;
    sig: string;
  }) => Promise<KeyResponse>;
  now?: () => number;
  onChange?: (s: PayerSnapshot) => void;
  /** Throws while spending is paused (killSwitch assertNotPaused): checked before every segment payment. */
  checkSpending: () => Promise<void>;
};

export class SessionPayer {
  status: PayerStatus = 'ready';
  error: string | null = null;
  lastAccepted: Coin;
  /** Built and sent but not confirmed by a 200 (kept only when the outcome is unknown). */
  uncertain: Coin | null = null;
  stats: PayerStats = { artistSats: 0, feeSats: 0, payments: 0, lastTxid: null, recent: [] };
  private next = new Map<string, PayTo>();
  private readonly listener: string;

  constructor(private deps: PayerDeps) {
    this.lastAccepted = deps.coin;
    this.listener = deps.key.toPublicKey().toString();
  }

  get balance() {
    return coinSats(this.lastAccepted);
  }

  snapshot(): PayerSnapshot {
    return { status: this.status, error: this.error, stats: { ...this.stats }, balance: this.balance };
  }

  private emit() {
    this.deps.onChange?.(this.snapshot());
  }

  /** Pay for one segment and return the server's key response. Serialised by the caller (one at a time). */
  async pay(trackId: string, segment: number): Promise<KeyResponse> {
    if (this.status !== 'ready') throw new Error(this.error ?? `Payer ${this.status}`);
    this.status = 'paying';
    const tag = `${trackId}:${segment}`;
    let built: Coin | null = null;
    try {
      // Session-key payments never pass through createAction: the spending pause is checked here, every segment.
      await this.deps.checkSpending();
      const payTo = this.next.get(tag) ?? (await this.deps.getPayTo(trackId, segment));
      this.next.delete(tag);
      built = await buildSegmentTx(this.deps.key, this.lastAccepted, payTo.lockingScript, payTo.sats);
      const txid = built.tx.id('hex');
      const res = await this.deps.post({
        trackId,
        segment,
        rawTx: built.tx.toHex(),
        listener: this.listener,
        sig: signSegment(this.deps.key, trackId, segment, txid),
      });
      this.lastAccepted = built;
      this.uncertain = null;
      const now = (this.deps.now ?? Date.now)();
      this.stats = {
        artistSats: this.stats.artistSats + payTo.sats,
        feeSats: this.stats.feeSats + SEGMENT_FEE,
        payments: this.stats.payments + 1,
        lastTxid: txid,
        recent: [...this.stats.recent.filter((t) => now - t < 10_000), now],
      };
      if (res.next) this.next.set(`${trackId}:${segment + 1}`, res.next);
      this.status = 'ready';
      this.emit();
      return res;
    } catch (e) {
      if (e instanceof InsufficientBudget) {
        this.status = 'out';
        this.error = e.message;
      } else {
        this.status = 'error';
        this.error = e instanceof Error ? e.message : String(e);
        // HTTP status = the server answered, so the tx is known not to be accepted. No status = unknown.
        this.uncertain = built && !(e instanceof StreamHttpError) ? built : null;
      }
      this.emit();
      throw e;
    }
  }

  /** Back to the last accepted change after an error. */
  resync() {
    if (this.status !== 'error') return;
    this.status = 'ready';
    this.error = null;
    this.next.clear();
    this.emit();
  }

  /** Coins to try when sweeping, newest first. */
  sweepCandidates(): Coin[] {
    return this.uncertain ? [this.uncertain, this.lastAccepted] : [this.lastAccepted];
  }

  close() {
    this.status = 'closed';
    this.emit();
  }
}

/** Payments per second over the last 10 s. */
export const paymentsPerSecond = (recent: number[], now = Date.now()) => {
  const r = recent.filter((t) => now - t < 10_000);
  if (r.length < 2) return r.length;
  return (r.length - 1) / Math.max(1, (r[r.length - 1] - r[0]) / 1000);
};
