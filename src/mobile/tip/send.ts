import { type OneSatContext } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import type { WalletInterface } from '@bsv/sdk';
import { sendMail } from '../bmail/client';
import { destinationFor, parseRecipient, resolveRecipient } from '../names/names';
import { queuedResult } from '../../services/repeatGuard';
import { cleanNote, type TipRoute } from './tip';

export type TipSent = { txid: string; pending: boolean };

/**
 * Send one tip through the wallet's normal send path (one approval: the sheet's Send button). Throws on failure.
 * Never retries: a queued send (slow network) comes back as `pending`, so the caller says "don't pay again".
 */
export async function sendTip(
  ctx: OneSatContext,
  route: TipRoute,
  sats: number,
  label: string,
  note = '',
): Promise<TipSent> {
  const memo = cleanNote(note);
  try {
    if (route.kind === 'identity') {
      // BRC-29 to the identity key, delivered as a bMail (subject "Tip"), so the note travels with it.
      const sent = await sendMail(ctx.wallet as unknown as WalletInterface, {
        to: route.to,
        toLabel: label,
        sealed: { subject: 'Tip', body: memo || `A tip for ${label}` },
        sats,
        replyPaidSats: 0,
      });
      if (!sent.txid) throw new Error('The wallet did not send the tip.');
      return { txid: sent.txid, pending: false };
    }
    let to = route.to;
    let paymail = route.kind === 'paymail';
    if (paymail) {
      const r = await resolveRecipient((u, i) => fetch(u, i), parseRecipient(route.to));
      const d = destinationFor(r, 'bsv');
      if (!d.ok) throw new Error(d.error);
      to = d.to;
      paymail = r.targetKind === 'paymail';
    }
    const res = await sendBsv.execute(ctx, {
      requests: [
        paymail ? { paymail: to, satoshis: sats, ...(memo ? { memo } : {}) } : { address: to, satoshis: sats },
      ],
    });
    if (res.error || !res.txid) throw new Error(String(res.error ?? 'The tip did not send.'));
    return { txid: res.txid, pending: false };
  } catch (e) {
    const q = queuedResult(e);
    if (q) return { txid: q.txid, pending: true };
    throw e;
  }
}
