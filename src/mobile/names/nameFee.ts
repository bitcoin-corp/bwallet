import { Utils } from '@bsv/sdk';
import { type OneSatContext } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import { fetchExchangeRate } from '../../utils/wallet';
import { usdToSats } from '../money/money';
import type { NameFee } from './paymail';

/**
 * Pay the 1¢ fee for a new paymail name (anti-squatting, owner 10 Oct 2026) with the normal wallet send.
 * Call only after the user confirmed "Claim $name · 1¢". Returns what claimPaymail sends to the server.
 */
export const payNameFee = async (ctx: OneSatContext, fee: NameFee): Promise<{ feeTxid: string; feeTx?: string }> => {
  const sats = usdToSats(fee.usd, await fetchExchangeRate('main'));
  if (!sats) throw new Error("Couldn't get the BSV price. Try again in a minute.");
  const res = await sendBsv.execute(ctx, { requests: [{ address: fee.address, satoshis: sats }] });
  if (res.error || !res.txid) throw new Error(String(res.error ?? 'Payment failed'));
  return { feeTxid: res.txid, feeTx: res.tx ? Utils.toHex(res.tx) : undefined };
};
