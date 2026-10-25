import { P2PKH, Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { ChatApiError, saveSession, type BchatClient, type HandlesInfo } from '../chat/api';
import { commitmentScript, NO_SEND, releasePayment, type Commitment } from '../chat/roomSpend';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { addPaymail, makeMainPaymail, removePaymail } from './paymail';
import type { Fetch } from './names';

/**
 * Several names per wallet, one main (owner, 15 Oct 2026). bit-sign is where a name is paid for
 * (1p per extra name, its 402 flow, PR #272); the paymail server then adds the matching alias after
 * checking with bit-sign's public owner lookup that the same identity key owns it. Paid ONCE, on bit-sign.
 */

/** bit-sign's 402 `payment_required` body. Pure. */
export type HandlePayment = { pence: number; sats: number; to: string; commitment: Commitment };
export function parsePaymentRequired(data: unknown): HandlePayment | null {
  const d = data as { code?: unknown; pay?: Record<string, unknown> } | null;
  if (d?.code !== 'payment_required' || !d.pay) return null;
  const p = d.pay;
  const c = p.commitment as Record<string, unknown> | undefined;
  const sats = Math.ceil(Number(p.sats));
  if (!(sats > 0) || typeof p.to !== 'string' || !p.to || !c) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    pence: Number(p.pence) || 0,
    sats,
    to: p.to,
    commitment: { room: str(c.room), author: str(c.author), body: str(c.body), rule: str(c.rule) },
  };
}

/** The outputs that pay for a name: sats to bit-sign's address + the room_pay commitment. Pure. */
export const handlePaymentOutputs = (pay: HandlePayment) => [
  { lockingScript: new P2PKH().lock(pay.to).toHex(), satoshis: pay.sats, outputDescription: 'Name fee' },
  { lockingScript: commitmentScript(pay.commitment).toHex(), satoshis: 0, outputDescription: 'Name fee record' },
];

const client = (ctx: OneSatContext): Promise<BchatClient> => signedInClient(ctx, kycClient());

/** bit-sign's names, max and the next name's fee (shown before the user confirms). */
export const loadHandles = async (ctx: OneSatContext): Promise<HandlesInfo> => (await client(ctx)).listHandles();

/**
 * Add an extra name. Call only after the user confirmed the fee (HandlesInfo.nextFee). Pays bit-sign
 * through its 402 flow (signed, never broadcast by us: bit-sign verifies and broadcasts), then adds the
 * paymail alias. Returns the new paymail.
 */
/** A name costs 1p; nothing near this is ever a real name fee. */
export const MAX_NAME_FEE_SATS = 50_000;

/**
 * The 402 must ask for no more than the fee the user confirmed, to the same address (b-Aware 25 Oct 2026: the
 * server's amount and address were paid as sent, with no sheet). Pure; throws with "Nothing was paid".
 */
export function checkNamePayment(pay: HandlePayment, approved: { sats: number; to: string } | null): void {
  if (!approved) throw new Error('This name now has a fee you have not seen. Nothing was paid. Close and try again.');
  if (pay.to !== approved.to) throw new Error('The name fee address changed. Nothing was paid. Try again.');
  if (pay.sats > approved.sats || pay.sats > MAX_NAME_FEE_SATS)
    throw new Error('The name fee is higher than the one you confirmed. Nothing was paid.');
}

export async function addExtraName(
  ctx: OneSatContext,
  f: Fetch,
  alias: string,
  approved: { sats: number; to: string } | null,
): Promise<string> {
  const c = await client(ctx);
  try {
    await c.addHandle(alias);
  } catch (e) {
    const pay = e instanceof ChatApiError && e.status === 402 ? parsePaymentRequired(e.data) : null;
    if (!pay) throw e;
    checkNamePayment(pay, approved);
    const r = await ctx.wallet.createAction({
      description: `Name ${alias}`,
      outputs: handlePaymentOutputs(pay),
      options: NO_SEND,
    });
    if (!r.tx || !r.txid) throw new Error('The wallet did not return the payment');
    try {
      await c.addHandle(alias, Utils.toHex(r.tx));
    } catch (err) {
      // Only a refusal before broadcast that the chain confirms frees it (services/unsentGuard.ts).
      await releasePayment(ctx, r.txid, err);
      throw err;
    }
  }
  return addPaymail(f, ctx.wallet, alias);
}

/** Make a name main on bit-sign (30-day cooldown; new session kept) and on the paymail server. */
export async function makeMainName(ctx: OneSatContext, f: Fetch, paymail: string): Promise<string> {
  const alias = paymail.split('@')[0].toLowerCase();
  const c = await client(ctx);
  try {
    saveSession(await c.setPrimaryHandle(alias));
  } catch (e) {
    // bit-sign already has this name as the handle (code 'same', owner 25 Oct 2026: b0asex stayed the bChatX
    // handle while the paymail main moved to b0ase). Only the paymail server needs the change, so carry on.
    const code = e instanceof ChatApiError ? (e.data as { code?: string } | null)?.code : undefined;
    if (!(e instanceof ChatApiError && e.status === 400 && (code === 'same' || /^You are already \$/.test(e.message))))
      throw e;
  }
  return makeMainPaymail(f, ctx.wallet, paymail);
}

/** Remove an extra name on bit-sign (held 90 days) and on the paymail server (forwards 90 days). */
export async function removeName(ctx: OneSatContext, f: Fetch, paymail: string): Promise<void> {
  const alias = paymail.split('@')[0].toLowerCase();
  const c = await client(ctx);
  try {
    await c.removeHandle(alias);
  } catch (e) {
    // A paymail-only name bit-sign never had: still remove it here.
    if (!(e instanceof ChatApiError && e.status === 404)) throw e;
  }
  await removePaymail(f, ctx.wallet, paymail);
}
