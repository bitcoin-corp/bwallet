// Token escrow, the wallet half (tokenEscrow.ts is the pure script + settlement builder). Every function is one
// approval sheet and runs only when the person taps a button. Keys stay in the BRC-100 wallet: the escrow key and
// the fee-reserve key are seed-derived (ESCROW_PROTOCOL, keyID = escrow id), so a restore recovers both.
// bit-sign is only the mailbox (src/lib/commission-store.ts); nothing here is custodial.
import { sendBsv21, type OneSatContext } from '@1sat/actions';
import { P2PKH, PublicKey, Transaction } from '@bsv/sdk';
import { withExtraOutput } from '../airdrops/note';
import { broadcastRaw } from '../pots/potSend';
import { guardedSendBsv21 } from '../../services/tokenSpendGuard';
import {
  COMMISSION_TERMS_PROTOCOL,
  ESCROW_PROTOCOL,
  RESERVE_SATS,
  addEscrowSignature,
  buildSettlement,
  escrowKeyId,
  escrowScript,
  finalizeSettlement,
  proposalTx,
  reserveKeyId,
  settlementProblem,
  sighash,
  termsKeyId,
  termsMessage,
  toChecksig,
  type Escrow,
  type Funding,
  type RoleKey,
  type WireProposal,
} from './tokenEscrow';

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

/** Blocks after the deadline before the refund unlocks (≈ 1 day). KEEP IN STEP with bit-sign REFUND_GRACE_BLOCKS. */
export const REFUND_GRACE_BLOCKS = 144;
export const refundHeightFor = (deadline: Date, now: Date, height: number) =>
  height + Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 600_000)) + REFUND_GRACE_BLOCKS;

export async function escrowPubKey(ctx: OneSatContext, escrowId: string): Promise<string> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: ESCROW_PROTOCOL,
    keyID: escrowKeyId(escrowId),
    counterparty: 'self',
  });
  return publicKey.toLowerCase();
}

async function reservePubKey(ctx: OneSatContext, escrowId: string): Promise<string> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: ESCROW_PROTOCOL,
    keyID: reserveKeyId(escrowId),
    counterparty: 'self',
  });
  return publicKey.toLowerCase();
}

/** Sign the commission terms (sha256 of the text) with the identity key. The caller has shown the text. */
export async function signTerms(
  ctx: OneSatContext,
  t: { roomId: string; ticker: string; no: number; docHash: string; handle: string; role: 'poster' | 'deliverer' },
): Promise<{ identityKey: string; signature: string }> {
  const message = termsMessage({ ticker: t.ticker, no: t.no, docHash: t.docHash, handle: t.handle, role: t.role });
  const [{ publicKey }, { signature }] = await Promise.all([
    ctx.wallet.getPublicKey({ identityKey: true }),
    ctx.wallet.createSignature({
      protocolID: COMMISSION_TERMS_PROTOCOL,
      keyID: termsKeyId(t.roomId, t.no),
      counterparty: 'anyone',
      data: Array.from(new TextEncoder().encode(message)),
    }),
  ]);
  return { identityKey: publicKey, signature: hex(signature) };
}

async function signEscrowInput(ctx: OneSatContext, p: WireProposal): Promise<WireProposal> {
  const myKey = await escrowPubKey(ctx, p.escrowId);
  const { signature } = await ctx.wallet.createSignature({
    hashToDirectlySign: sighash(proposalTx(p), 0),
    protocolID: ESCROW_PROTOCOL,
    keyID: escrowKeyId(p.escrowId),
    counterparty: 'self',
  });
  return addEscrowSignature(p, myKey, hex(toChecksig(signature)));
}

const reserveSigner = (ctx: OneSatContext, escrowId: string) => async (digest: number[]) => {
  const { signature } = await ctx.wallet.createSignature({
    hashToDirectlySign: digest,
    protocolID: ESCROW_PROTOCOL,
    keyID: reserveKeyId(escrowId),
    counterparty: 'self',
  });
  return toChecksig(signature);
};

/**
 * Poster: lock the reward. ONE token send (the escrow output plus the fee reserve), then the time-locked refund
 * signed by this wallet. Returns the body for bit-sign POST {action:'fund'}. Irreversible once broadcast except by
 * the release or the refund: the caller must have shown the confirmation step.
 */
export async function fundEscrow(
  ctx: OneSatContext,
  a: {
    escrowId: string;
    tokenId: string;
    amt: bigint;
    arbiterKey: string;
    delivererKey?: string | null;
    deadline: Date;
    /** This wallet's token receive address (where a refund lands). */
    posterAddress: string;
  },
): Promise<{ body: Record<string, unknown>; escrow: Escrow; funding: Funding; refund: WireProposal }> {
  const posterKey = await escrowPubKey(ctx, a.escrowId);
  const reserveKey = await reservePubKey(ctx, a.escrowId);
  const keys: RoleKey[] = [
    { role: 'poster', pubkey: posterKey },
    { role: 'arbiter', pubkey: a.arbiterKey.toLowerCase() },
    ...(a.delivererKey ? [{ role: 'deliverer' as const, pubkey: a.delivererKey.toLowerCase() }] : []),
  ];
  const escrow: Escrow = { escrowId: a.escrowId, tokenId: a.tokenId, amt: a.amt, keys };
  const script = escrowScript(escrow);
  const reserveScript = new P2PKH().lock(PublicKey.fromString(reserveKey).toAddress());
  const height = await ctx.services?.chaintracks.currentHeight();
  if (!height) throw new Error('Could not read the block height; nothing was locked.');
  const refundAfterHeight = refundHeightFor(a.deadline, new Date(), height);
  const wallet = withExtraOutput(ctx.wallet, {
    lockingScript: reserveScript.toHex(),
    satoshis: RESERVE_SATS,
    outputDescription: 'Network fee reserve for a commission escrow',
  });
  const res = await guardedSendBsv21.execute({ ...ctx, wallet }, {
    tokenId: a.tokenId,
    recipients: [{ amount: a.amt.toString(), destination: { lockingScript: script.toHex() } }],
  } as Parameters<typeof sendBsv21.execute>[1]);
  if (!res.txid || res.error) throw new Error(res.error ?? 'The reward was not locked');
  const fundTx = parseTx(res.tx);
  const vout = fundTx.outputs.findIndex((o) => o.lockingScript.toHex() === script.toHex());
  const reserveVout = fundTx.outputs.findIndex((o) => o.lockingScript.toHex() === reserveScript.toHex());
  if (vout < 0 || reserveVout < 0) throw new Error('Escrow outputs not found in the transaction');
  const funding: Funding = { fundTx, vout, reserveVout, reservePubKey: reserveKey };
  const unsigned = await buildSettlement(
    { kind: 'refund', escrow, funding, posterAddress: a.posterAddress, refundAfterHeight },
    reserveSigner(ctx, a.escrowId),
  );
  const refund = await signEscrowInput(ctx, unsigned);
  return {
    escrow,
    funding,
    refund,
    body: {
      action: 'fund',
      posterKey,
      posterAddress: a.posterAddress,
      refundAfterHeight,
      rawTx: fundTx.toHex(),
      vout,
      reserveVout,
      refundProposal: refund,
    },
  };
}

/** Rebuild the escrow + funding from bit-sign's escrow row (works on any device after a restore). */
export function escrowFromRow(
  row: {
    id: string;
    token_id: string;
    amount: string;
    pubkeys: RoleKey[];
    fund_raw_tx: string;
    vout: number;
    reserve_vout: number;
  },
  reservePub: string,
): { escrow: Escrow; funding: Funding } {
  const escrow: Escrow = { escrowId: row.id, tokenId: row.token_id, amt: BigInt(row.amount), keys: row.pubkeys };
  return {
    escrow,
    funding: {
      fundTx: Transaction.fromHex(row.fund_raw_tx),
      vout: row.vout,
      reserveVout: row.reserve_vout,
      reservePubKey: reservePub,
    },
  };
}

/** Poster accepts an entry: build + sign the release to the entrant's payout address. Body for POST {accept}. */
export async function acceptRelease(
  ctx: OneSatContext,
  row: Parameters<typeof escrowFromRow>[0],
  entry: { id: string; payout_address: string; content_sha256: string | null },
): Promise<Record<string, unknown>> {
  const { escrow, funding } = escrowFromRow(row, await reservePubKey(ctx, row.id));
  const unsigned = await buildSettlement(
    { kind: 'release', escrow, funding, payTo: entry.payout_address, contentSha256: entry.content_sha256 },
    reserveSigner(ctx, row.id),
  );
  const problem = settlementProblem(unsigned, { kind: 'release', escrow, to: entry.payout_address });
  if (problem) throw new Error(problem);
  return { action: 'accept', entryId: entry.id, releaseProposal: await signEscrowInput(ctx, unsigned) };
}

/** Any party: broadcast a fully signed settlement (finalize refuses short of 2 signatures). */
export async function broadcastSettlement(p: WireProposal): Promise<{ txid: string }> {
  const { rawTx, txid } = finalizeSettlement(p);
  await broadcastRaw(rawTx);
  return { txid };
}
