/**
 * Never drop a payment the network may have (P0, 25 Oct 2026).
 *
 * tx 877d2505… (block 972621): a Store theme purchase was signed with noSend and its rawtx posted to our server
 * ('buy-claim'). The server broadcast it and then answered with an error, so the client called abortAction. The
 * toolbox's own chain check ran seconds after the broadcast, found nothing yet, and marked the action 'failed'
 * (its ProvenTxReq 'invalid'). The change output, 28.66670816 BSV, is unspent on chain, but the wallet lost it.
 *
 * Rule for every flow that hands an unsent (noSend) transaction to a server or third party:
 *  - once the rawtx has left the device, abort ONLY when the server gave an explicit "not broadcast" answer (a
 *    refusal it makes before broadcasting: HTTP 4xx) AND the chain still says unknown after ~30 s of retries
 *    (WhatsOnChain + 1Sat, every answer a clean 404);
 *  - otherwise keep the action as it is (nosend: its change stays spendable) and watch for it on chain; when the
 *    network has it, hand it to the wallet's normal sending path (createAction sendWith) so storage marks it sent
 *    and the monitor completes it with its proof.
 * Every decision is logged as a [bwx-unsent] line.
 */

export type Sighting = 'seen' | 'missing' | 'unclear';
export type ChainLookup = (txid: string) => Promise<Sighting>;

const TXID = /^[0-9a-f]{64}$/i;

/** ~30 s in total: the network can take seconds to show a transaction someone else just broadcast. */
export const RELEASE_CHECK_DELAYS_MS = [0, 3_000, 5_000, 7_000, 7_000, 8_000];
/** After keeping an action: look for it on chain for ~20 minutes, then leave it to the wallet's own review. */
export const SETTLE_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 480_000];

type F = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: F = (u, i) => fetch(u, i);

/** WhatsOnChain: 200 seen (mempool or mined), 404 missing, anything else unclear. */
export const wocLookup =
  (f: F = defaultFetch): ChainLookup =>
  async (txid) => {
    try {
      const r = await f(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`);
      if (r.status === 404) return 'missing';
      return r.ok ? 'seen' : 'unclear';
    } catch {
      return 'unclear';
    }
  };

/** 1Sat: the BEEF of a transaction the indexer has. 200 seen, 404 missing, anything else unclear. */
export const oneSatLookup =
  (f: F = defaultFetch): ChainLookup =>
  async (txid) => {
    try {
      const r = await f(`https://api.1sat.app/1sat/beef/${txid}`);
      if (r.status === 404) return 'missing';
      return r.ok ? 'seen' : 'unclear';
    } catch {
      return 'unclear';
    }
  };

export const defaultLookups = (f?: F): ChainLookup[] => [wocLookup(f), oneSatLookup(f)];

const sleepMs = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * True only when every lookup, on every retry, gave a clean "missing". Any sighting, error or unclear answer is
 * false (do not abort). Fails closed.
 */
export async function chainSaysUnknown(
  txid: string,
  o: { lookups?: ChainLookup[]; delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  if (!TXID.test(txid)) return false;
  const lookups = o.lookups ?? defaultLookups();
  if (!lookups.length) return false;
  const sleep = o.sleep ?? sleepMs;
  for (const d of o.delaysMs ?? RELEASE_CHECK_DELAYS_MS) {
    if (d > 0) await sleep(d);
    for (const look of lookups) {
      const r = await look(txid).catch((): Sighting => 'unclear');
      if (r !== 'missing') return false;
    }
  }
  return true;
}

/**
 * Did the server say, explicitly, that it did not broadcast? Our servers (theme orders, bit-sign, NPG melt, the
 * bMail relay) only refuse with a 4xx BEFORE broadcasting; a broadcast failure is a 502 ('broadcast_failed'), and
 * a 502 can come back after the network already took it (the 16:17 case). So: a 4xx is "not broadcast"; anything
 * else (5xx, network error, timeout, a thrown non-HTTP error) is not.
 */
export function refusedBeforeBroadcast(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export type UnsentWallet = {
  abortAction: (args: { reference: string }) => Promise<unknown>;
  createAction?: (args: {
    description: string;
    options: { sendWith: string[]; acceptDelayedBroadcast?: boolean };
  }) => Promise<{ sendWithResults?: { txid: string; status: string }[] } | unknown>;
};

export type ReleaseOpts = {
  /** The server's explicit answer: true only for a refusal made before broadcast (refusedBeforeBroadcast). */
  notBroadcast: boolean;
  lookups?: ChainLookup[];
  delaysMs?: number[];
  settleDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  /** Settle in the background (default). Tests await it instead. */
  background?: boolean;
};

export type ReleaseOutcome =
  | { kind: 'aborted' }
  | { kind: 'kept'; reason: 'server-may-have-broadcast' | 'chain-has-it-or-unclear' | 'not-a-txid' };

/**
 * The one way to release an unsent transaction after its rawtx left the device. Returns what it did; never
 * throws. A kept action is watched and, once the chain has it, sent through the wallet's normal path.
 */
export async function releaseAfterHandoff(
  wallet: UnsentWallet,
  txid: string,
  o: ReleaseOpts,
): Promise<ReleaseOutcome & { settled?: Promise<SettleResult> }> {
  const log = o.log ?? ((m: string) => console.warn(m));
  if (!TXID.test(txid)) {
    log(`[bwx-unsent] ${txid}: not a txid; kept (no abort)`);
    return { kind: 'kept', reason: 'not-a-txid' };
  }
  const keep = (reason: 'server-may-have-broadcast' | 'chain-has-it-or-unclear') => {
    log(`[bwx-unsent] ${txid}: kept, not aborted (${reason}); watching the chain`);
    const settled = settleWhenSeen(wallet, txid, o);
    if (o.background !== false) void settled;
    return { kind: 'kept' as const, reason, settled };
  };
  if (!o.notBroadcast) return keep('server-may-have-broadcast');
  if (!(await chainSaysUnknown(txid, o))) return keep('chain-has-it-or-unclear');
  try {
    await wallet.abortAction({ reference: txid });
    log(`[bwx-unsent] ${txid}: server refused before broadcast and the chain has no copy after retries; aborted`);
  } catch (e) {
    log(`[bwx-unsent] ${txid}: abort refused by the wallet (${e instanceof Error ? e.message : String(e)})`);
  }
  return { kind: 'aborted' };
}

export type SettleResult = 'sent' | 'not-seen' | 'send-failed' | 'no-wallet-send';

/**
 * Watch a kept action; when the chain has it, ask the wallet to send it (createAction sendWith). The network
 * already holds it, so this only moves storage from 'nosend' to sent: the monitor then fetches the proof and the
 * change counts as settled. If it is never seen the action stays nosend (change still spendable) for the
 * wallet's background review and Settings › Find missing coins.
 */
export async function settleWhenSeen(
  wallet: UnsentWallet,
  txid: string,
  o: Pick<ReleaseOpts, 'lookups' | 'settleDelaysMs' | 'sleep' | 'log'> = {},
): Promise<SettleResult> {
  const log = o.log ?? ((m: string) => console.warn(m));
  const lookups = o.lookups ?? defaultLookups();
  const sleep = o.sleep ?? sleepMs;
  if (!wallet.createAction) return 'no-wallet-send';
  for (const d of o.settleDelaysMs ?? SETTLE_DELAYS_MS) {
    await sleep(d);
    let seen = false;
    for (const look of lookups) if (!seen) seen = (await look(txid).catch((): Sighting => 'unclear')) === 'seen';
    if (!seen) continue;
    try {
      const r = (await wallet.createAction({
        description: 'Payment the network has',
        options: { sendWith: [txid], acceptDelayedBroadcast: false },
      })) as { sendWithResults?: { txid: string; status: string }[] } | undefined;
      const mine = r?.sendWithResults?.find((x) => x.txid === txid);
      log(`[bwx-unsent] ${txid}: on chain; handed to the wallet's send path (${mine?.status ?? 'no result'})`);
      return mine && mine.status === 'failed' ? 'send-failed' : 'sent';
    } catch (e) {
      log(
        `[bwx-unsent] ${txid}: on chain but the wallet's send failed (${e instanceof Error ? e.message : String(e)})`,
      );
      return 'send-failed';
    }
  }
  log(`[bwx-unsent] ${txid}: not seen on chain yet; left pending for the wallet's review`);
  return 'not-seen';
}
