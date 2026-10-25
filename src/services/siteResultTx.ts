/**
 * BRC-100 createAction / signAction answers carry the signed transaction as AtomicBEEF (`tx`) next to its txid.
 * @bsv/sdk WalletInterface: `tx` is "absent only when options.returnTXIDOnly === true", whatever the broadcast
 * outcome (acceptDelayedBroadcast only decides when it goes out). A queued or pending send is still signed, so its
 * answer still carries `tx` (tokenblaster.lol/arcade/terrornode, 25 Oct 2026: {txid, pending} with no tx read as
 * "your wallet said no" although the coins arrived).
 */

type TxOptions = { returnTXIDOnly?: boolean; signAndProcess?: boolean } | undefined;
type ResultWithTx = { txid?: string; tx?: unknown };

/** AtomicBEEF bytes as a plain number[] (what BRC-100 callers and the page relay expect), or null. */
export function atomicBytes(tx: unknown): number[] | null {
  if (Array.isArray(tx)) return tx.length ? (tx as number[]) : null;
  if (tx instanceof Uint8Array) return tx.length ? Array.from(tx) : null;
  return null;
}

/** Does the caller get `tx` back? Yes, unless it asked for the txid only or for an unsigned (signable) action. */
export function wantsTx(options: TxOptions): boolean {
  if (options?.returnTXIDOnly === true) return false;
  if (options?.signAndProcess === false) return false;
  return true;
}

/**
 * The answer with `tx` as the spec wants it: normalised to number[], loaded by txid when missing (storage), dropped
 * only for returnTXIDOnly. Never throws; a failed load leaves the answer as it was.
 */
export async function withSignedTx<R extends ResultWithTx>(
  result: R,
  options: TxOptions,
  load: (txid: string) => Promise<number[] | Uint8Array | null | undefined>,
): Promise<R> {
  if (options?.returnTXIDOnly === true) {
    if (result.tx === undefined) return result;
    const { tx: _drop, ...rest } = result;
    return rest as R;
  }
  if (!wantsTx(options) || !result.txid) return result;
  const have = atomicBytes(result.tx);
  if (have) return have === result.tx ? result : { ...result, tx: have };
  const loaded = atomicBytes(await load(result.txid).catch(() => null));
  return loaded ? { ...result, tx: loaded } : result;
}
