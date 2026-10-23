/**
 * One automatic retry after a send the network refused because a coin was already spent (UTXO_SPENT).
 *
 * Owner's iPhone, 17 and 19 Oct 2026 (b_feedback 9, 15, 16): the same seed is used on the iPhone, the extension and
 * web. Coins spent from another device stay spendable in this device's storage (the toolbox's sync only adds
 * outputs), so a send picks one, the broadcaster answers "UTXO_SPENT … utxo already spent by tx …", and the toolbox
 * throws WERR_REVIEW_ACTIONS (status invalidTx). The toolbox has already failed the action and made its inputs
 * spendable again (locks released); invalidSendHeal then clears the inputs proven spent. Before this module the person
 * had to tap Send again, once per dead coin, and saw the raw toolbox text.
 *
 * Here, when the heal cleared at least one coin, the same createAction (same outputs, same amounts, same
 * description: what the person approved) is run ONCE more, which now funds from other coins. Never when:
 *   - the caller is not eligible (the wallet's own fixed-amount send only: no dApp, no explicit inputs, no send-all,
 *     no delayed/noSend/signAndProcess:false, no multi-step chain);
 *   - nothing was cleared (retrying would pick the same coins);
 *   - the rejected transaction may have gone out: the broadcaster names it as the spender, or the network lookup
 *     does not answer "unknown txid" (fail closed: no second payment unless we know the first did not happen).
 */
import type { HealReport } from './invalidSendHeal';
import { isInvalidTxReview, SPENT_ELSEWHERE_MESSAGE } from './invalidSendHeal';

const TXID = /^[0-9a-f]{64}$/i;

export { SPENT_ELSEWHERE_MESSAGE };

/** Pure: the txid of the transaction the network refused (WERR_REVIEW_ACTIONS' invalidTx result). */
export const rejectedTxid = (error: unknown): string | undefined => {
  const r = (error as { reviewActionResults?: { txid?: string; status?: string }[] })?.reviewActionResults;
  const txid = r?.find((x) => x?.status === 'invalidTx')?.txid;
  return typeof txid === 'string' && TXID.test(txid) ? txid.toLowerCase() : undefined;
};

/** Pure: does the broadcaster's reason name this txid as the spender ("already spent by tx <txid>")? */
export const reasonNamesSpender = (reason: string | undefined, txid: string): boolean =>
  !!reason && new RegExp(`spent by (?:tx )?${txid}`, 'i').test(reason);

/** Pure: the wallet's own fixed-amount send, funded by the wallet (the only kind retried). */
export function retryEligible(p: {
  isAdmin: boolean;
  continuing: boolean;
  delayed: boolean;
  sendAll: boolean;
  args: {
    inputs?: unknown[];
    inputBEEF?: unknown;
    options?: { signAndProcess?: boolean; noSend?: boolean; acceptDelayedBroadcast?: boolean };
  };
}): boolean {
  const o = p.args.options ?? {};
  return (
    p.isAdmin &&
    !p.continuing &&
    !p.delayed &&
    !p.sendAll &&
    !(p.args.inputs?.length ?? 0) &&
    !p.args.inputBEEF &&
    o.signAndProcess !== false &&
    o.noSend !== true &&
    o.acceptDelayedBroadcast !== true
  );
}

export interface SpentRetryDeps<R> {
  /** The createAction call, exactly as approved. Called at most twice. */
  create: () => Promise<R>;
  /** invalidSendHeal for this account. Never throws; null when it can't run. */
  heal: (error: unknown) => Promise<HealReport | null>;
  /** Is this txid known to the network? true/false, or null when the lookup can't tell (treated as "maybe sent"). */
  txKnown: (txid: string) => Promise<boolean | null>;
  /** The broadcaster's reason for a refused txid, if recorded. */
  reason?: (txid: string) => string | undefined;
  eligible: boolean;
  log?: (msg: string, data?: unknown) => void;
}

export type SpentRetryOutcome<R> =
  | { ok: true; result: R; retried: boolean; heal: HealReport | null }
  | { ok: false; error: unknown; retried: boolean; heal: HealReport | null };

const addReports = (a: HealReport | null, b: HealReport | null): HealReport | null =>
  !a
    ? b
    : !b
      ? a
      : {
          checked: a.checked + b.checked,
          released: a.released + b.released,
          inputs: [...(a.inputs ?? []), ...(b.inputs ?? [])],
        };

/** Run create; after a UTXO_SPENT refusal heal, and retry once when it is safe. Never throws. */
export async function createWithSpentRetry<R>(d: SpentRetryDeps<R>): Promise<SpentRetryOutcome<R>> {
  let first: unknown;
  try {
    return { ok: true, result: await d.create(), retried: false, heal: null };
  } catch (err) {
    first = err;
  }
  if (!isInvalidTxReview(first)) return { ok: false, error: first, retried: false, heal: null };
  const heal = await d.heal(first).catch(() => null);
  const txid = rejectedTxid(first);
  const why = (() => {
    if (!d.eligible) return 'not eligible';
    if (!heal || heal.released <= 0) return 'nothing cleared';
    if (!txid) return 'no rejected txid';
    if (reasonNamesSpender(d.reason?.(txid), txid)) return 'rejected tx named as spender';
    return null;
  })();
  if (why) {
    d.log?.(`[spentRetry] no retry: ${why}`);
    return { ok: false, error: first, retried: false, heal };
  }
  const known = await d.txKnown(txid!).catch(() => null);
  if (known !== false) {
    d.log?.('[spentRetry] no retry: the refused tx may be on the network', { txid, known });
    return { ok: false, error: first, retried: false, heal };
  }
  d.log?.('[spentRetry] coins cleared; retrying once with fresh inputs', { txid, released: heal!.released });
  try {
    return { ok: true, result: await d.create(), retried: true, heal };
  } catch (second) {
    const heal2 = isInvalidTxReview(second) ? await d.heal(second).catch(() => null) : null;
    return { ok: false, error: second, retried: true, heal: addReports(heal, heal2) };
  }
}
