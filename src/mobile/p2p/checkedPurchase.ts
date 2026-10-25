/**
 * Buying a player's listing: a context for buyBsv21 whose createAction is checked (verify.ts verifyPurchaseArgs)
 * against what the buy sheet showed: the exact price to the seller, the token amount to our key, and fees no more
 * than shown. Pass the SAME tokenId and outpoint strings to buyBsv21 (its receive key is derived from them).
 */
import { BSV21_BASKET, P1SAT_PROTOCOL, type OneSatContext } from '@1sat/actions';
import { BSV21 } from '@1sat/templates';
import { P2PKH, PublicKey } from '@bsv/sdk';
import { marketFeeOptions, marketFeeSats } from '../market/fee';
import { checkedContext } from './checkedWallet';
import { verifyPurchaseArgs } from './verify';

export type PurchaseShown = {
  tokenId: string;
  outpoint: string;
  amount: bigint;
  priceSats: number;
  /** Indexing fee shown on the sheet (sats). */
  maxOverlayFee: number;
  /** The fee output the sheet showed (e.g. the 5% index-fund fee); default = the general market fee. */
  fee?: { address: string; sats: number; required?: boolean } | null;
};

type Details = { status?: { fee_address?: string } };

export async function checkedPurchaseContext<C extends OneSatContext>(ctx: C, shown: PurchaseShown): Promise<C> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID: `${shown.tokenId}-${shown.outpoint}`,
    counterparty: 'self',
    forSelf: true,
  });
  const receiveScript = BSV21.transfer(shown.tokenId, shown.amount)
    .lock(new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()))
    .toHex();
  const bsv21 = (ctx.services as unknown as { bsv21?: { getTokenDetails(id: string): Promise<unknown> } } | undefined)
    ?.bsv21;
  const details = bsv21 ? ((await bsv21.getTokenDetails(shown.tokenId).catch(() => null)) as Details | null) : null;
  const mf = marketFeeOptions();
  return checkedContext(ctx, (args) =>
    verifyPurchaseArgs(args, {
      tokenId: shown.tokenId,
      outpoint: shown.outpoint,
      amount: shown.amount,
      priceSats: shown.priceSats,
      receiveScript,
      basket: BSV21_BASKET,
      marketFee:
        shown.fee !== undefined
          ? shown.fee
          : mf.marketplaceAddress
            ? { address: mf.marketplaceAddress, sats: marketFeeSats(shown.priceSats) }
            : null,
      feeAddress: details?.status?.fee_address ?? null,
      maxOverlayFee: shown.maxOverlayFee,
    }),
  );
}
