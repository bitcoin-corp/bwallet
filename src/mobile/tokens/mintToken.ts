import type { OneSatContext } from '@1sat/actions';
import type { LockingScript } from '@bsv/sdk';
import { deployBsv21, openRoom } from '../tickets/mintTicket';
import type { Curve } from '../../lib/curves';
import { cleanToken, tokenFoundingMessage, type TokenForm } from './token';

/**
 * Mint a token network steps (after SendConfirmation): the icon is inscribed by the caller
 * (inscribeIcon), then the shared BSV-21 deploy (no ticket MAP tag) and the shared room open.
 */

export interface MintedToken {
  tokenId: string;
  ticker: string;
  name: string;
  supply: string;
  decimals: number;
  description: string;
  min: string;
}

export async function deployToken(
  ctx: OneSatContext,
  form: TokenForm,
  opts: {
    icon: string | null;
    feeSats: number;
    map?: { script: LockingScript; description: string };
    curve?: Curve | null;
  },
): Promise<MintedToken> {
  const c = cleanToken(form);
  const tokenId = await deployBsv21(ctx, {
    symbol: c.ticker,
    amount: c.amount,
    decimals: c.decimals,
    icon: opts.icon,
    feeSats: opts.feeSats,
    ...(opts.map ? { map: opts.map } : {}),
    curve: opts.curve ?? null,
  });
  return {
    tokenId,
    ticker: c.ticker,
    name: c.name,
    supply: c.supply,
    decimals: c.decimals,
    description: c.description,
    min: c.min,
  };
}

/** Open the token's holders' room (gate: hold 1 whole token). Returns the room ticker. */
export const openTokenRoom = (ctx: OneSatContext, t: MintedToken) =>
  openRoom(ctx, t.tokenId, { name: t.name, min: t.min, founding: tokenFoundingMessage(t) });
