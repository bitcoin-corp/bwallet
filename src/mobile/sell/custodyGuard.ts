/**
 * Custody guard (market plan §2.4 "House vs creator", 23 Oct 2026): the wallet must never list tokens it holds
 * for someone else. Listings go through sendBsv21, which picks ANY spendable output of the token id in the
 * BSV-21 basket (it can't exclude single outputs), so the guard is per token id and fails closed.
 *
 * What is already outside the listable set by construction:
 *  - vesting tranches (basket `vesting`, vesting.ts), token time-locks (no basket, tokenLockApi.ts), ordinals:
 *    sendBsv21 only spends the `bsv21` basket;
 *  - Quarantined airdrops (quarantine.ts): left out of heldBsv21Balances, and refused again here.
 *
 * Markers checked here (refuse the whole token if any output carries one):
 *  - an output tag in FOR_OTHERS_TAGS, or starting with `held-for:` (custody, escrow, claim pools, agent pots).
 *
 * Gaps (documented in the PR): no wallet path writes these tags yet; house-side custody (the NPG avatar claim
 * key, bit-sign treasuries, the planned 2-of-2 escrow) lives outside this wallet and is not visible to it. Any
 * new flow that holds tokens for others in this wallet must tag its outputs `held-for:<who>`.
 */
import { bsv21FilterTags } from '@1sat/actions';
import type { WalletInterface } from '@bsv/sdk';
import { activeQuarantine } from '../airdrops/inbox';
import { normId } from '../airdrops/quarantine';

export const FOR_OTHERS_TAGS: readonly string[] = ['custody', 'custodial', 'escrow', 'claim-pool', 'held-for-others'];
export const HELD_FOR_PREFIX = 'held-for:';

export const isForOthersTag = (tag: string): boolean => {
  const t = tag.trim().toLowerCase();
  return FOR_OTHERS_TAGS.includes(t) || t.startsWith(HELD_FOR_PREFIX);
};

export type CustodyVerdict = { ok: true } | { ok: false; reason: string };

export const QUARANTINE_REASON =
  "These tokens are in Quarantine (an airdrop you haven't accepted), so they can't be listed.";
export const FOR_OTHERS_REASON =
  'Some of these tokens are held for someone else (custody, escrow or a claim pool), so this wallet won’t list them.';

/** Pure verdict from the token id, the quarantine set and the tags on the token's wallet outputs. */
export const custodyVerdict = (
  tokenId: string,
  quarantined: ReadonlySet<string>,
  outputTags: readonly (readonly string[])[],
): CustodyVerdict => {
  if (quarantined.has(normId(tokenId))) return { ok: false, reason: QUARANTINE_REASON };
  if (outputTags.some((tags) => tags.some(isForOthersTag))) return { ok: false, reason: FOR_OTHERS_REASON };
  return { ok: true };
};

/** Read the token's BSV-21 outputs' tags from the wallet, then decide. Unreadable outputs fail closed. */
export async function checkListable(
  wallet: Pick<WalletInterface, 'listOutputs'>,
  tokenId: string,
  quarantined: ReadonlySet<string> = activeQuarantine(),
): Promise<CustodyVerdict> {
  const id = normId(tokenId);
  if (quarantined.has(id)) return { ok: false, reason: QUARANTINE_REASON };
  try {
    const r = await wallet.listOutputs({
      basket: 'bsv21',
      tags: bsv21FilterTags({ tokenId: id }),
      tagQueryMode: 'any',
      includeTags: true,
      limit: 1000,
    });
    return custodyVerdict(
      id,
      quarantined,
      r.outputs.map((o) => o.tags ?? []),
    );
  } catch {
    return { ok: false, reason: "Couldn't check these tokens' outputs. Try again in a moment." };
  }
}
