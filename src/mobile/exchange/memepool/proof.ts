/**
 * Memepool's proof of reserves (GET /proof): every coin's pool, as their ledger records it and as the chain shows it.
 * Owner, 25 Oct 2026: refuse to trade a coin whose row isn't healthy, and say why in plain English.
 *
 * Healthy = the row exists, is `live`, its own `ok` is true and the chain reading's verdict is `ok`. Anything else,
 * including a row we can't read, refuses. The row also gives the coin's two pool addresses, which the trade
 * verifier pins (a template paying a "pool" anywhere else is refused).
 */
import { isAddress } from './script';

export type ProofRow = { id: string; poolPay: string; poolOrd: string };
export type ProofVerdict = { healthy: true; row: ProofRow } | { healthy: false; why: string };

export function proofVerdict(body: unknown, tokenId: string): ProofVerdict {
  const coins = (body as { coins?: unknown } | null)?.coins;
  if (!Array.isArray(coins))
    return { healthy: false, why: "Memepool's proof of reserves isn't answering, so we won't trade right now." };
  const r = coins.find((c) => (c as { id?: unknown })?.id === tokenId) as Record<string, unknown> | undefined;
  if (!r) return { healthy: false, why: "This coin isn't in Memepool's proof of reserves, so we won't trade it." };
  const chain = (r.chain ?? {}) as { verdict?: unknown };
  if (r.status !== 'live')
    return {
      healthy: false,
      why:
        r.status === 'awaiting'
          ? "Memepool hasn't finished checking this coin's pool yet. Try again in a few minutes."
          : 'Memepool has stopped trading this coin for now.',
    };
  if (chain.verdict === 'short')
    return { healthy: false, why: "Memepool's own check shows this coin's pool holding less than it should." };
  if (chain.verdict === 'watch')
    return { healthy: false, why: "Memepool is double-checking this coin's pool. Try again in a few minutes." };
  if (r.ok !== true || chain.verdict !== 'ok')
    return { healthy: false, why: "Memepool's proof of reserves doesn't show this coin's pool as healthy." };
  if (!isAddress(r.poolPay) || !isAddress(r.poolOrd))
    return { healthy: false, why: "Memepool's proof of reserves doesn't list this coin's pool properly." };
  return { healthy: true, row: { id: tokenId, poolPay: r.poolPay, poolOrd: r.poolOrd } };
}
