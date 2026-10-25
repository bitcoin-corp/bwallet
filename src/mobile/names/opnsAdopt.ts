/**
 * "Add to my Names" (owner, 25 Oct 2026): a name that arrived as a plain NFT (a bMail gift, e.g. "a47") sits in the
 * ordinals basket, so the OpNS actions (registerOpns, sellOpns, sendOpns), which spend from the OpNS basket by its
 * `id:` tag, can't see it. This re-files the same output into the OpNS basket. No transaction, no fee, nothing
 * broadcast: the wallet already holds the coin; only its bookkeeping row moves.
 *
 *   1. load the row (and its BEEF) from the ordinals basket by its id: tag,
 *   2. relinquishOutput from the ordinals basket (the toolbox refuses to move an output that still has a basket),
 *   3. internalizeAction (basket insertion, a merge on a known tx) into the OpNS basket, keeping the spend details
 *      (custom instructions) and adding the name to them.
 * If step 3 fails, the row goes back into the ordinals basket as it was.
 */
import { Beef, type WalletInterface, type WalletOutput } from '@bsv/sdk';
import { loadBasketOutputBeef } from '@1sat/actions';
import { OPNS_BASKET, ORDINALS_BASKET, readAssetIdTag } from '@1sat/types';

type AdoptWallet = Pick<WalletInterface, 'listOutputs' | 'relinquishOutput' | 'internalizeAction'>;

/** The custom instructions with the name added (the OpNS actions read the name from here when there's no tag). */
export const withName = (ci: string | undefined, name: string): string => {
  let o: Record<string, unknown> = {};
  try {
    const p = ci ? JSON.parse(ci) : {};
    if (p && typeof p === 'object' && !Array.isArray(p)) o = p as Record<string, unknown>;
  } catch {
    // Not JSON: rewriting it would lose the key details the coin is spent with, so refuse.
    throw new Error('This NFT’s spend details can’t be read, so it can’t be moved.');
  }
  return JSON.stringify({ ...o, name });
};

/** The ordinals-basket row for this outpoint ("txid.vout" or "txid_vout"), or null. */
export const findOrdinalRow = (outputs: WalletOutput[], outpoint: string) => {
  const op = outpoint.replace(/_(\d+)$/, '.$1');
  return outputs.find((o) => o.outpoint === op) ?? null;
};

export type AdoptResult = { id: string } | { error: string };

export const adoptOpnsNft = async (wallet: AdoptWallet, outpoint: string, name: string): Promise<AdoptResult> => {
  const op = outpoint.replace(/_(\d+)$/, '.$1');
  const [txid, voutS] = op.split('.');
  const vout = Number(voutS);
  if (!/^[0-9a-f]{64}$/i.test(txid ?? '') || !Number.isInteger(vout)) return { error: 'Not a valid outpoint.' };

  // Find the row's id: tag (page through the ordinals basket).
  let row: WalletOutput | null = null;
  for (let offset = 0; !row; offset += 500) {
    const r = await wallet.listOutputs({ basket: ORDINALS_BASKET, includeTags: true, limit: 500, offset });
    row = findOrdinalRow(r.outputs, op);
    if (r.outputs.length < 500) break;
  }
  if (!row) return { error: 'This name isn’t in your NFTs list, so there is nothing to move.' };
  const id = readAssetIdTag(row.tags);
  if (!id) return { error: 'This NFT has no tracking id yet. Try again after the next refresh.' };

  const loaded = await loadBasketOutputBeef(wallet as WalletInterface, ORDINALS_BASKET, id);
  if ('error' in loaded) return { error: loaded.error };
  const ci = loaded.output.customInstructions ?? undefined;
  let newCi: string;
  try {
    newCi = withName(ci, name);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const tx = Beef.fromBinary(loaded.beef).toBinaryAtomic(txid);
  const insert = (basket: string, customInstructions: string | undefined) =>
    wallet.internalizeAction({
      tx,
      outputs: [
        {
          outputIndex: vout,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket,
            // Tags are only written for new rows; the existing id:/type:/origin: tags stay on the row.
            tags: ['opns', `name:${name}`, `id:${id}`],
            ...(customInstructions ? { customInstructions } : {}),
          },
        },
      ],
      description: `Add ${name} to my names`.slice(0, 50),
    });

  await wallet.relinquishOutput({ basket: ORDINALS_BASKET, output: op });
  try {
    await insert(OPNS_BASKET, newCi);
  } catch (e) {
    await insert(ORDINALS_BASKET, ci).catch(() => undefined);
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { id };
};
