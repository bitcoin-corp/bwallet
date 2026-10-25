/**
 * Indexing fee on player-to-player resales of reward tokens (owner, 25 Oct 2026): the BUYER pays 5% of the listed
 * price on top (min 1 sat, rounded up) to the token's GorillaPool index fund, which pays for indexing so the token
 * stays tradeable. The seller receives their full price. Never to the creator; no royalty.
 *
 * The fund address is read from GorillaPool at trade time. If the API is unreachable, or returns an address that
 * doesn't match the one we expect for a known token, we refuse to list or buy (fail closed).
 *
 * Note: OrdLock v2 commits to ONE payout, so the fee is added by the buyer's wallet (as the purchase's fee output),
 * not enforced by the listing script. bWalletX buyers always pay it.
 */
import { NO_CURVE_IDS } from '../market/launchpad/noCurve';

export const FUND_FEE_RATE = 0.05;
/** Below this the fund is "low": warn on the sheets. */
export const FUND_LOW_SATS = 100_000;

/** Fund addresses we already know; GorillaPool must agree or we refuse. */
export const KNOWN_FUNDS: Readonly<Record<string, string>> = {
  d5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1: '1DkrzJo487E8LLLupts9iJhK2pAvKPJTLe',
};

const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const norm = (id: string) => id.trim().toLowerCase().replace('.', '_');

/** ceil(5% × price), at least 1 sat; 0 for no price. */
export const fundFeeSats = (priceSats: number): number =>
  Number.isFinite(priceSats) && priceSats > 0 ? Math.max(1, Math.ceil(priceSats * FUND_FEE_RATE)) : 0;

/** Tokens whose resales carry the fund fee: reward tokens (no curve) only, for now. */
export const hasFundFee = (tokenId: string, coin?: { trading?: unknown } | null): boolean =>
  coin?.trading === false || Object.prototype.hasOwnProperty.call(NO_CURVE_IDS, norm(tokenId));

export type Fund = { address: string; balance: number | null; low: boolean };

/** Parse GorillaPool's /api/bsv20/id/<id> body. null when it isn't a usable fund for this token. */
export function parseFund(tokenId: string, body: unknown): Fund | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { fundAddress?: unknown; fundBalance?: unknown };
  const address = typeof b.fundAddress === 'string' ? b.fundAddress.trim() : '';
  if (!ADDRESS_RE.test(address)) return null;
  const known = KNOWN_FUNDS[norm(tokenId)];
  if (known && known !== address) return null;
  const n = Number(b.fundBalance);
  const balance = Number.isFinite(n) ? n : null;
  return { address, balance, low: balance !== null && balance < FUND_LOW_SATS };
}

/** The token's index fund from GorillaPool, or null (unreachable / unexpected): then don't trade. */
export async function fetchFund(
  tokenId: string,
  f: (url: string) => Promise<Response> = (u) => fetch(u, { cache: 'no-store' }),
): Promise<Fund | null> {
  try {
    const r = await f(`https://ordinals.gorillapool.io/api/bsv20/id/${encodeURIComponent(norm(tokenId))}`);
    if (!r.ok) return null;
    return parseFund(tokenId, await r.json());
  } catch {
    return null;
  }
}

/** Options for buyBsv21: the fund fee as its fee output (replaces the general market fee for these tokens). */
export const fundFeeOptions = (fund: Fund) => ({ marketplaceAddress: fund.address, marketplaceRate: FUND_FEE_RATE });
