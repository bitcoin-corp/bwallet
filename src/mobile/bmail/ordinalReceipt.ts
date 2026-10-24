import { Beef, Hash, PublicKey, Utils, type WalletInterface } from '@bsv/sdk';
import { buildOrdinalCustomInstructions, ORDINALS_BASKET } from '@1sat/actions';
import type { SealedOrdinal } from './envelope';
import { loadInbox, saveInbox, type InboxState } from '../airdrops/inbox';

/**
 * Receive an NFT sent to my identity key (send to a public key, 24 Oct 2026). The sender's sendOrdinals paid a
 * BRC-29-style key (P1SAT protocol, keyID = source outpoint, counterparty = sender) and the bMail letter carries
 * its delivery details (`Sealed.ordinal`). Here the recipient:
 *   1. checks every delivery is for me and from the letter's sender,
 *   2. gets the transaction as BEEF (SPV: the wallet's internalizeAction validates it),
 *   3. derives the key and checks the output really locks to it,
 *   4. internalizes the output into the ordinals basket, with custom instructions so it can be spent later.
 *
 * Quarantine (airdrops rules): an NFT from a sender that isn't trusted waits, out of Wallet › NFTs, until Keep.
 * Keep marks it kept in the airdrops inbox state; Trust (airdrops trustIssuer, keyed by the sender's identity
 * key) lets later ones straight in.
 */

export type Delivery = {
  outputIndex: number;
  keyID: string;
  protocolID: [0 | 1 | 2, string];
  senderIdentityKey: string;
  counterparty: string;
  recipientIdentityKey: string;
};

const isDelivery = (d: unknown): d is Delivery => {
  const x = d as Delivery;
  return (
    !!x &&
    Number.isInteger(x.outputIndex) &&
    x.outputIndex >= 0 &&
    typeof x.keyID === 'string' &&
    x.keyID.length <= 200 &&
    Array.isArray(x.protocolID) &&
    x.protocolID.length === 2 &&
    typeof x.protocolID[1] === 'string' &&
    typeof x.senderIdentityKey === 'string' &&
    typeof x.counterparty === 'string' &&
    typeof x.recipientIdentityKey === 'string'
  );
};

/** The deliveries in a letter that are really for me and from its sender; [] when anything is off. */
export const deliveriesFor = (o: SealedOrdinal | undefined, me: string, from: string): Delivery[] => {
  if (!o || !/^[0-9a-f]{64}$/i.test(o.txid)) return [];
  const ds = o.deliveries.filter(isDelivery);
  if (ds.length !== o.deliveries.length) return [];
  const lc = (s: string) => s.toLowerCase();
  return ds.every(
    (d) =>
      lc(d.recipientIdentityKey) === lc(me) && lc(d.senderIdentityKey) === lc(from) && lc(d.counterparty) === lc(from),
  )
    ? ds
    : [];
};

/** Airdrops inbox key for an NFT that came by letter. */
export const receiptKey = (txid: string) => `${txid}:nft`;

/** Quarantine rule (airdrops): kept, or from a trusted sender (identity key in trustedIssuers). */
export const receiptAccepted = (
  s: Pick<InboxState, 'kept'> & { trustedIssuers?: string[] },
  txid: string,
  from: string,
) =>
  s.kept.includes(receiptKey(txid)) ||
  (s.trustedIssuers ?? []).map((x) => x.toLowerCase()).includes(from.toLowerCase());

export const keepReceipt = (account: string, txid: string) => {
  const s = loadInbox(account);
  if (!s.kept.includes(receiptKey(txid))) saveInbox(account, { ...s, kept: [...s.kept, receiptKey(txid)] });
};

/** Only the ordinal identity tags a sender may set (BRC-147 seed tags), plus a bmail marker. */
export const receiptTags = (t: unknown): string[] => [
  ...new Set([
    ...(Array.isArray(t) ? t : [])
      .filter((x): x is string => typeof x === 'string' && x.length <= 300)
      .filter((x) => /^(type|origin|collection|content|app|name):/.test(x) || x === 'origin')
      .slice(0, 12),
    'bmail',
  ]),
];

/**
 * The per-output tracking id (`id:` tag, read by @1sat/types readAssetIdTag) that sendOrdinals needs to spend it
 * again. Derived from the outpoint, so it is stable across re-opens of the same letter.
 */
export const receiptIdTag = (txid: string, vout: number) => `id:${txid.toLowerCase()}_${vout}`;

/** Hide a letter's NFT (persisted in the airdrops hidden list, like other Quarantine items). */
export const hideReceipt = (account: string, txid: string) => {
  const s = loadInbox(account);
  if (!s.hidden.includes(receiptKey(txid))) saveInbox(account, { ...s, hidden: [...s.hidden, receiptKey(txid)] });
};
export const receiptHidden = (s: Pick<InboxState, 'hidden'>, txid: string) => s.hidden.includes(receiptKey(txid));

export type ReceiveDeps = { getBeef: (txid: string) => Promise<number[]> };

export class ReceiptError extends Error {}

/** Internalize the NFT(s). Throws ReceiptError when the letter or transaction doesn't check out. */
export const internalizeSealedOrdinal = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'internalizeAction'>,
  o: SealedOrdinal,
  from: string,
  me: string,
  deps: ReceiveDeps,
): Promise<{ txid: string; outputs: number }> => {
  const ds = deliveriesFor(o, me, from);
  if (!ds.length) throw new ReceiptError("This letter's NFT details aren't addressed to you.");
  const beef = Beef.fromBinary(await deps.getBeef(o.txid));
  const tx = beef.findAtomicTransaction(o.txid);
  if (!tx) throw new ReceiptError("Couldn't find the NFT's transaction yet. Try again in a minute.");
  for (const d of ds) {
    const out = tx.outputs[d.outputIndex];
    if (!out || out.satoshis !== 1) throw new ReceiptError("The NFT output isn't in that transaction.");
    const { publicKey } = await wallet.getPublicKey({
      protocolID: d.protocolID,
      keyID: d.keyID,
      counterparty: d.counterparty,
      forSelf: true,
    });
    const p2pkh = `76a914${Utils.toHex(Hash.hash160(PublicKey.fromString(publicKey).encode(true) as number[]) as number[])}88ac`;
    if (!out.lockingScript.toHex().includes(p2pkh)) throw new ReceiptError("That NFT isn't locked to your key.");
  }
  const name = (o.name || 'NFT').slice(0, 80);
  const tags = receiptTags(o.tags);
  try {
    await wallet.internalizeAction({
      tx: beef.toBinaryAtomic(o.txid),
      outputs: ds.map((d) => ({
        outputIndex: d.outputIndex,
        protocol: 'basket insertion' as const,
        insertionRemittance: {
          basket: ORDINALS_BASKET,
          tags: [...tags, receiptIdTag(o.txid, d.outputIndex)],
          customInstructions: buildOrdinalCustomInstructions({
            protocolID: d.protocolID,
            keyID: d.keyID,
            counterparty: d.counterparty,
            tags,
            name,
          }),
        },
      })),
      description: `NFT received: ${name}`.slice(0, 50),
      labels: ['bmail'],
    });
  } catch (e) {
    if (!/already|duplicate|exists/i.test(String(e))) throw e;
  }
  return { txid: o.txid, outputs: ds.length };
};
