// Partner lock wallet actions, all through the BRC-100 wallet (keys never leave it; nothing custodial).
// Each function is one approval sheet and runs only when the partner taps a button. Tests never broadcast.
import { sendBsv21, type OneSatContext } from '@1sat/actions';
import { P2PKH, PublicKey, Transaction } from '@bsv/sdk';
import type { MessageCharge } from '../../chat/roomSpend';
import { broadcastRaw, payeeAddress } from '../../pots/potSend';
import { PARTNER_SIGN_PROTOCOL } from './lockState';
import {
  agreementProblem,
  signKeyId,
  signMessage,
  splitCharges,
  type AgreementVersion,
  type Partner,
} from './partnership';
import {
  PARTNER_LOCK_PROTOCOL,
  addSignatures,
  feeFor,
  feeKeyId,
  finalize,
  inputsFor,
  partnerKeyId,
  partnerLockScript,
  propose,
  proposalTx,
  sighash,
  toChecksig,
  type FeeUtxo,
  type Keyset,
  type MovePlan,
  type PartnerProposal,
  describeProposalMoves,
  proposalMoveProblem,
} from './partnerLock';
import { guardedSendBsv21 } from '../../../services/tokenSpendGuard';

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
const parseTx = (raw: number[] | Uint8Array | undefined): Transaction => {
  if (!raw?.length) throw new Error('The wallet did not return a transaction');
  const tx = Array.from(raw);
  try {
    return Transaction.fromAtomicBEEF(tx);
  } catch {
    return Transaction.fromBinary(tx);
  }
};

/** This wallet's partner key for one partnership: seed-derived, the same on every restore. */
export async function partnerKey(ctx: OneSatContext, partnershipId: string): Promise<string> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: PARTNER_LOCK_PROTOCOL,
    keyID: partnerKeyId(partnershipId),
    counterparty: 'self',
  });
  return publicKey;
}

/**
 * Lock up: move this partner's allocation (ordinary BSV-21 tokens in the wallet) into the partner lock. One sheet.
 * Returns the outpoint and the raw tx (the record keeps it so partners can build proposals without an indexer).
 */
export async function lockUp(
  ctx: OneSatContext,
  a: { tokenId: string; amt: bigint; keyset: Keyset; myKey: string },
): Promise<{ outpoint: string; rawTx: string }> {
  const script = partnerLockScript({ tokenId: a.tokenId, amt: a.amt, holder: a.myKey }, a.keyset);
  const res = await guardedSendBsv21.execute(ctx, {
    tokenId: a.tokenId,
    recipients: [{ amount: a.amt.toString(), destination: { lockingScript: script.toHex() } }],
  } as Parameters<typeof sendBsv21.execute>[1]);
  if (!res.txid || res.error) throw new Error(res.error ?? 'Your shares were not locked');
  const tx = parseTx(res.tx);
  const vout = tx.outputs.findIndex((o) => o.lockingScript.toHex() === script.toHex());
  if (vout < 0) throw new Error('Locked output not found in the transaction');
  return { outpoint: `${res.txid}.${vout}`, rawTx: tx.toHex() };
}

/** Proposer's sheet: put the exact network fee on a one-off seed-derived key, then build + fee-sign the proposal. */
export async function proposeMove(ctx: OneSatContext, plan: MovePlan): Promise<PartnerProposal> {
  const keyID = feeKeyId(plan.partnershipId, plan.proposalId);
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: PARTNER_LOCK_PROTOCOL,
    keyID,
    counterparty: 'self',
  });
  const sats = feeFor(plan);
  const r = await ctx.wallet.createAction({
    description: `Partnership shares: fee for "${plan.summary}"`.slice(0, 50),
    outputs: [
      {
        lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex(),
        satoshis: sats,
        outputDescription: 'Network fee for a partner-approved move',
      },
    ],
    labels: ['bwx-partnership'],
    options: { randomizeOutputs: false },
  });
  const tx = parseTx(r.tx);
  const fee: FeeUtxo = { sourceTx: tx, vout: 0, pubKey: publicKey };
  return propose(plan, fee, async (digest) => {
    const { signature } = await ctx.wallet.createSignature({
      hashToDirectlySign: digest,
      protocolID: PARTNER_LOCK_PROTOCOL,
      keyID,
      counterparty: 'self',
    });
    return toChecksig(signature);
  });
}

/** "Signature needed" sheet: sign every locked input this partner can sign. Returns the updated proposal. */
export async function signProposal(ctx: OneSatContext, p: PartnerProposal): Promise<PartnerProposal> {
  // Sign only what the transaction itself does, never on the strength of the proposer's summary (b-Aware report).
  const problem = proposalMoveProblem(describeProposalMoves(p));
  if (problem) throw new Error(problem);
  const myKey = await partnerKey(ctx, p.partnershipId);
  const mine = inputsFor(p, myKey);
  if (!mine.length) throw new Error('Your key is not on this partnership lock');
  const tx = proposalTx(p);
  const sigs: Record<number, string> = {};
  for (const i of mine) {
    const { signature } = await ctx.wallet.createSignature({
      hashToDirectlySign: sighash(tx, i),
      protocolID: PARTNER_LOCK_PROTOCOL,
      keyID: partnerKeyId(p.partnershipId),
      counterparty: 'self',
    });
    sigs[i] = hex(toChecksig(signature));
  }
  return addSignatures(p, myKey, sigs);
}

/** Once enough partners have signed: finalize (refuses otherwise) and broadcast. Any partner may do this. */
export async function broadcastProposal(p: PartnerProposal): Promise<{ txid: string; rawTx: string }> {
  const { rawTx, txid } = finalize(p);
  await broadcastRaw(rawTx);
  return { txid, rawTx };
}

// ── agreement + payments (partnership.ts) ────────────────────────────────────

/**
 * Sign the open agreement draft with this wallet's identity key. Refuses (no sheet) unless the text regenerates
 * exactly from the draft's partners and rule and matches its sha256 (agreementProblem).
 */
export async function signAgreement(
  ctx: OneSatContext,
  a: { roomId: string; handle: string; draft: AgreementVersion; ticker?: string },
): Promise<{ identityKey: string; at: string; signature: string }> {
  const problem = agreementProblem(a.draft, a.ticker);
  if (problem) throw new Error(`Not signed: ${problem}`);
  const at = new Date().toISOString();
  const message = signMessage({
    roomId: a.roomId,
    version: a.draft.version,
    sha256: a.draft.agreementSha256.toLowerCase(),
    handle: a.handle,
    at,
  });
  const [{ publicKey }, { signature }] = await Promise.all([
    ctx.wallet.getPublicKey({ identityKey: true }),
    ctx.wallet.createSignature({
      protocolID: PARTNER_SIGN_PROTOCOL,
      keyID: signKeyId(a.roomId, a.draft.version),
      counterparty: 'anyone',
      data: Array.from(new TextEncoder().encode(message)),
    }),
  ]);
  return { identityKey: publicKey, at, signature: hex(signature) };
}

/** A partner's own wallet address ($name = name@bwalletx.com). */
export const partnerAddress = (handle: string) =>
  payeeAddress({ paymail: `${handle}@bwalletx.com`, name: `$${handle}` });

/**
 * Pay the partnership: ONE transaction, one output per partner by share, straight to each partner's wallet.
 * One approval sheet. Nothing is pooled or held by us.
 */
export async function payPartnership(
  ctx: OneSatContext,
  a: { ticker: string; totalSats: number; partners: Partner[]; resolve?: (handle: string) => Promise<string> },
): Promise<{ txid: string; charges: MessageCharge[] }> {
  const resolve = a.resolve ?? partnerAddress;
  const addressOf: Record<string, string> = {};
  for (const p of a.partners) addressOf[p.handle] = await resolve(p.handle);
  const charges = splitCharges(a.totalSats, a.partners, addressOf);
  const r = await ctx.wallet.createAction({
    description: `Pay the $${a.ticker} partnership`.slice(0, 50),
    outputs: charges.map((c) => ({
      lockingScript: new P2PKH().lock(c.to).toHex(),
      satoshis: Number(c.amount),
      outputDescription: 'Partner share of a payment',
    })),
    labels: ['bwx-partnership'],
    options: { randomizeOutputs: false },
  });
  if (!r.txid) throw new Error('The payment was not sent');
  return { txid: r.txid, charges };
}
