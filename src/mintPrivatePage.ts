/**
 * Page side of `wallet.mintPrivate` (services/mintPrivateSite.ts): a non-standard method added next to the BRC-100
 * ones on window.CWI. It travels like a CWI call through the provider's own transport; the wallet takes the
 * originator from the browser, so nothing the page sends can name another site.
 *
 *   await wallet.mintPrivate({ source: 'x', requestId, items, sequence? })
 *   → { records: [{ x_id, outpoint }], txids, complete, stoppedAt? }
 *   rejects with an Error carrying `code`: USER_REFUSED | REQUEST_ID_REUSED | TOO_MANY_ITEMS | BAD_REQUEST
 */
import { MINT_PRIVATE_ACTION, MINT_PRIVATE_CAPS } from './services/mintPrivateAction';

export const attachMintPrivate = (
  target: Record<string, unknown>,
  transport: (action: string, params: unknown) => Promise<unknown>,
) => {
  target.mintPrivateCaps = MINT_PRIVATE_CAPS;
  target.mintPrivate = (args: unknown) => transport(MINT_PRIVATE_ACTION, args ?? {});
};
