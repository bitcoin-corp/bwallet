import { describe, expect, test } from 'bun:test';
import { Beef, P2PKH, PrivateKey, ProtoWallet, PublicKey, Transaction, type InternalizeActionArgs } from '@bsv/sdk';
import { buildOrdinalTransferDelivery, ORDINALS_BASKET, P1SAT_PROTOCOL } from '@1sat/actions';
import {
  deliveriesFor,
  internalizeSealedOrdinal,
  receiptAccepted,
  receiptHidden,
  receiptKey,
  receiptTags,
  ReceiptError,
} from './ordinalReceipt';
import { readAssetIdTag } from '@1sat/types';
import { nftSendButton } from '../media/nftSend';
import { bytesToSealed, sealedToBytes, type SealedOrdinal } from './envelope';

const senderKey = PrivateKey.fromString('a1'.repeat(32), 'hex');
const recipKey = PrivateKey.fromString('b2'.repeat(32), 'hex');
const sender = new ProtoWallet(senderKey);
const sKey = senderKey.toPublicKey().toString();
const rKey = recipKey.toPublicKey().toString();
const sourceOutpoint = `${'cd'.repeat(32)}.0`;

/** What sendOrdinals does for `counterparty`: P1SAT key, keyID = source outpoint, to the recipient. */
const sendToIdentityKey = async (to: string) => {
  const { publicKey } = await sender.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID: sourceOutpoint,
    counterparty: to,
  });
  const parent = new Transaction();
  parent.addOutput({ lockingScript: new P2PKH().lock(senderKey.toPublicKey().toAddress()), satoshis: 1 });
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(senderKey.toPublicKey().toAddress()),
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()), satoshis: 1 });
  const beef = new Beef();
  beef.mergeTransaction(parent);
  beef.mergeTransaction(tx);
  const delivery = buildOrdinalTransferDelivery(
    { outpoint: sourceOutpoint } as Parameters<typeof buildOrdinalTransferDelivery>[0],
    to,
    sKey,
    0,
  )!;
  const ordinal: SealedOrdinal = {
    txid: tx.id('hex'),
    deliveries: [delivery],
    name: 'Birthday card',
    tags: ['type:image/png', `origin:${sourceOutpoint.replace('.', '_')}`, 'evil-tag'],
  };
  return { ordinal, beef: beef.toBinary() };
};

/** Recipient wallet: real key derivation, internalizeAction recorded as the ordinals basket. */
const recipientWallet = () => {
  const pw = new ProtoWallet(recipKey);
  const basket: InternalizeActionArgs[] = [];
  return {
    basket,
    wallet: {
      getPublicKey: pw.getPublicKey.bind(pw),
      internalizeAction: async (a: InternalizeActionArgs) => {
        basket.push(a);
        return { accepted: true as const };
      },
    },
  };
};

describe('NFT sent to an identity key, received by letter', () => {
  test('round trip: send → sealed envelope → quarantine → Keep → internalized into the ordinals basket', async () => {
    const { ordinal, beef } = await sendToIdentityKey(rKey);
    const opened = bytesToSealed(sealedToBytes({ subject: 'An NFT for you', body: 'Happy birthday', ordinal }));
    expect(opened.ordinal).toEqual(ordinal);

    // Unknown sender: in Quarantine, nothing internalized.
    const inbox = { kept: [] as string[], trustedIssuers: [] as string[] };
    expect(receiptAccepted(inbox, ordinal.txid, sKey)).toBe(false);

    // Keep → accepted → internalized.
    inbox.kept.push(receiptKey(ordinal.txid));
    expect(receiptAccepted(inbox, ordinal.txid, sKey)).toBe(true);
    const r = recipientWallet();
    const res = await internalizeSealedOrdinal(r.wallet, opened.ordinal!, sKey, rKey, { getBeef: async () => beef });
    expect(res).toEqual({ txid: ordinal.txid, outputs: 1 });
    expect(r.basket).toHaveLength(1);
    const out = r.basket[0].outputs[0];
    expect(out.protocol).toBe('basket insertion');
    expect(out.insertionRemittance?.basket).toBe(ORDINALS_BASKET);
    const tags = out.insertionRemittance!.tags!;
    expect(tags).toEqual([
      'type:image/png',
      `origin:${sourceOutpoint.replace('.', '_')}`,
      'bmail',
      `id:${ordinal.txid}_0`,
    ]);
    // Sendable onward straight away: NftDetail reads the tracking id and its Send button enables.
    expect(readAssetIdTag(tags)).toBe(`${ordinal.txid}_0`);
    const send = nftSendButton({
      to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      status: 'ready',
      busy: false,
      onChain: true,
      isSelf: false,
      pending: false,
    });
    expect(send.enabled).toBe(true);
    const ci = JSON.parse(out.insertionRemittance!.customInstructions!);
    expect(ci.keyID).toBe(sourceOutpoint);
    expect(ci.counterparty).toBe(sKey);
  });

  test('a trusted sender skips Quarantine', () => {
    expect(receiptAccepted({ kept: [], trustedIssuers: [sKey.toUpperCase()] }, 'ab'.repeat(32), sKey)).toBe(true);
  });

  test('deliveries for someone else, or from another sender, are refused', async () => {
    const { ordinal, beef } = await sendToIdentityKey(rKey);
    expect(deliveriesFor(ordinal, rKey, sKey)).toHaveLength(1);
    expect(deliveriesFor(ordinal, sKey, sKey)).toHaveLength(0);
    expect(deliveriesFor(ordinal, rKey, rKey)).toHaveLength(0);
    const r = recipientWallet();
    await expect(
      internalizeSealedOrdinal(r.wallet, ordinal, rKey, rKey, { getBeef: async () => beef }),
    ).rejects.toThrow(ReceiptError);
    expect(r.basket).toHaveLength(0);
  });

  test('an output not locked to my derived key is refused', async () => {
    const other = PrivateKey.fromString('c3'.repeat(32), 'hex').toPublicKey().toString();
    const { ordinal, beef } = await sendToIdentityKey(other);
    // Claim it was for me.
    const forged: SealedOrdinal = {
      ...ordinal,
      deliveries: [{ ...(ordinal.deliveries[0] as object), recipientIdentityKey: rKey }],
    };
    const r = recipientWallet();
    await expect(internalizeSealedOrdinal(r.wallet, forged, sKey, rKey, { getBeef: async () => beef })).rejects.toThrow(
      "isn't locked to your key",
    );
    expect(r.basket).toHaveLength(0);
  });

  test('Hide is a persisted airdrops-hidden entry', () => {
    expect(receiptHidden({ hidden: [receiptKey('ab'.repeat(32))] }, 'ab'.repeat(32))).toBe(true);
    expect(receiptHidden({ hidden: [] }, 'ab'.repeat(32))).toBe(false);
  });

  test('receiptTags keeps only ordinal identity tags', () => {
    expect(receiptTags(['type:x', 'evil', 'name:a', 3])).toEqual(['type:x', 'name:a', 'bmail']);
  });
});
