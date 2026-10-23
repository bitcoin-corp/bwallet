// Token ESCROW for room commissions (ROOM-TRADING-FLOOR-PLAN.md §2). Beside tokenLocks.ts: the same trick (a
// BSV-21 transfer inscription with a custom suffix), with a bare multisig in place of the time lock.
//
// Escrow output (1 sat):
//   <BSV-21 transfer inscription {p:"bsv-20",op:"transfer",id,amt}>
//   <sha256(escrowId)> OP_DROP                      binds the script to one escrow (data only)
//   OP_2 <k1> … <kn> OP_n OP_CHECKMULTISIG          keys sorted
// open race → 2-of-2 (poster, room arbiter); directed → 2-of-3 (poster, deliverer, room arbiter).
//
// The funding also leaves a FEE RESERVE (P2PKH on a seed-derived key, RESERVE_SATS, no basket so nothing else
// spends it). Release and refund both spend exactly [escrow, reserve]:
//   release: lockTime 0, out[0] = full amount to the deliverer's address, optional out[1] = OP_RETURN memo
//            "bwx-escrow" <escrowId> <content sha256> so the payment points at the exact clip
//   refund : lockTime = refundAfterHeight, sequences 0xfffffffe, out[0] = full amount back to the poster
// The refund is signed by the poster and co-signed by the arbiter right after funding, so after the deadline the
// poster broadcasts it alone. Mining a release first makes the refund invalid (same inputs), and vice versa.
//
// Signing reuses the partnership M-of-N engine (placement/partnership/multisig.ts): SIGHASH_ALL over the final
// transaction; finalize() refuses with too few signatures and runs the script interpreter locally.
//
// KEEP IN STEP with bit-sign src/lib/escrow-mailbox.ts (the mailbox checks what this builds).
// Pure: no network, no keys held. Tests: tokenEscrow.test.ts.
import { BSV21 } from '@1sat/templates';
import { Hash, LockingScript, OP, P2PKH, PublicKey, Script, Transaction, UnlockingScript, Utils } from '@bsv/sdk';
import {
  addSignatures,
  finalize,
  isReady,
  proposalTx,
  sighash,
  type Signable,
} from '../placement/partnership/multisig';

export { addSignatures, finalize, isReady, proposalTx, sighash, toChecksig } from '../placement/partnership/multisig';

/** BRC-100 protocol for the poster's / deliverer's escrow key (keyID = escrow id) and fee reserve key. */
export const ESCROW_PROTOCOL: [2, string] = [2, 'bwx escrow'];
export const escrowKeyId = (escrowId: string) => escrowId.slice(0, 200);
export const reserveKeyId = (escrowId: string) => `${escrowId}:reserve`.slice(0, 200);
/** Identity-key signature over the commission terms. KEEP IN STEP with bit-sign commission-rules.ts. */
export const COMMISSION_TERMS_PROTOCOL: [2, string] = [2, 'bwx commission terms'];
export const termsKeyId = (roomId: string, no: number) => `${roomId}:B${no}`;
export const termsMessage = (o: {
  ticker: string;
  no: number;
  docHash: string;
  handle: string;
  role: 'poster' | 'deliverer';
}) =>
  `Commission #B${o.no} · $${o.ticker}\nI, $${o.handle}, agree to these terms as ${o.role}.\nTerms sha256 ${o.docHash}`;

export const RESERVE_SATS = 200;
export const REFUND_SEQUENCE = 0xfffffffe;

export type Role = 'poster' | 'deliverer' | 'arbiter';
export type RoleKey = { role: Role; pubkey: string };
export type Escrow = { escrowId: string; tokenId: string; amt: bigint; keys: RoleKey[] };

const isPub = (k: string) => /^0[23][0-9a-f]{64}$/.test(k);
const readSmallInt = (op: number) => (op >= OP.OP_1 && op <= OP.OP_16 ? op - OP.OP_1 + 1 : -1);

/** Open race: poster + arbiter. Directed: poster + deliverer + arbiter. Always 2 signatures. */
export function checkKeys(keys: RoleKey[]): { m: 2; pubKeys: string[] } {
  const roles = keys
    .map((k) => k.role)
    .sort()
    .join();
  if (roles !== 'arbiter,poster' && roles !== 'arbiter,deliverer,poster')
    throw new Error('An escrow is poster + arbiter, or poster + deliverer + arbiter');
  const pubKeys = keys.map((k) => k.pubkey.toLowerCase()).sort();
  if (!pubKeys.every(isPub)) throw new Error('Every escrow key must be a compressed public key');
  if (new Set(pubKeys).size !== pubKeys.length) throw new Error('Escrow keys must be distinct');
  return { m: 2, pubKeys };
}

export const escrowTag = (escrowId: string) => Hash.sha256(Utils.toArray(escrowId, 'utf8'));

export function escrowBody(escrowId: string, pubKeys: string[]): Script {
  const keys = [...pubKeys].map((k) => k.toLowerCase()).sort();
  const s = new Script().writeBin(escrowTag(escrowId)).writeOpCode(OP.OP_DROP).writeOpCode(OP.OP_2);
  for (const k of keys) s.writeBin(Utils.toArray(k, 'hex'));
  return s.writeOpCode(OP.OP_1 + keys.length - 1).writeOpCode(OP.OP_CHECKMULTISIG);
}

/** The escrow output's locking script. */
export function escrowScript(e: Escrow): LockingScript {
  if (e.amt <= 0n) throw new Error('An escrow must hold more than 0 tokens');
  const { pubKeys } = checkKeys(e.keys);
  return BSV21.transfer(e.tokenId, e.amt).lock(new LockingScript(escrowBody(e.escrowId, pubKeys).chunks));
}

export type ParsedEscrow = { tokenId: string; amt: bigint; tag: string; m: number; pubKeys: string[] };

/** Reads an escrow back (null when the script isn't one). Send / Sell / Exchange never select these. */
export function parseEscrow(script: Script): ParsedEscrow | null {
  const c = script.chunks;
  const j = c.length - 1;
  if (c[j]?.op !== OP.OP_CHECKMULTISIG) return null;
  const n = readSmallInt(c[j - 1]?.op ?? -1);
  if (n !== 2 && n !== 3) return null;
  const keys: string[] = [];
  for (let k = j - 1 - n; k < j - 1; k++) {
    const d = c[k]?.data;
    if (!d || d.length !== 33) return null;
    keys.push(Utils.toHex(d));
  }
  const m = readSmallInt(c[j - 2 - n]?.op ?? -1);
  const drop = c[j - 3 - n];
  const tag = c[j - 4 - n]?.data;
  if (m !== 2 || drop?.op !== OP.OP_DROP || !tag || tag.length !== 32) return null;
  const token = BSV21.decode(script);
  const tokenId = token?.getTokenId();
  if (!token || token.getOperation() !== 'transfer' || !tokenId) return null;
  return { tokenId, amt: token.getAmount(), tag: Utils.toHex(tag), m, pubKeys: keys };
}
export const isEscrowed = (script: Script) => parseEscrow(script) !== null;

/** The OP_RETURN memo on a release: which escrow, which delivery. */
export const releaseMemo = (escrowId: string, contentSha256: string | null) =>
  new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray('bwx-escrow', 'utf8'))
    .writeBin(Utils.toArray(escrowId, 'utf8'))
    .writeBin(contentSha256 ? Utils.toArray(contentSha256, 'hex') : []);

// ── settlement proposals ─────────────────────────────────────────────────────

/** Wire shape for bit-sign (single locked input, sigs keyed by pubkey). */
export type WireProposal = {
  v: 1;
  escrowId: string;
  kind: 'release' | 'refund';
  txEF: string;
  locked: { index: 0; m: number; pubKeys: string[] };
  fee: { index: 1; pubKey: string; sig: string };
  sigs: Record<string, string>;
};

export type Funding = { fundTx: Transaction; vout: number; reserveVout: number; reservePubKey: string };

export type SettlementPlan =
  | { kind: 'release'; escrow: Escrow; funding: Funding; payTo: string; contentSha256?: string | null }
  | { kind: 'refund'; escrow: Escrow; funding: Funding; posterAddress: string; refundAfterHeight: number };

/**
 * Build a release or refund and sign the fee-reserve input (wallet: createSignature with hashToDirectlySign under
 * reserveKeyId). Escrow-key signatures are added afterwards with signAs / addSignatures.
 */
export async function buildSettlement(
  plan: SettlementPlan,
  signReserve: (digest: number[]) => Promise<number[]>,
): Promise<WireProposal> {
  const { escrow, funding } = plan;
  const lock = funding.fundTx.outputs[funding.vout];
  if (!lock || lock.lockingScript.toHex() !== escrowScript(escrow).toHex())
    throw new Error('That output is not this escrow');
  const reserve = funding.fundTx.outputs[funding.reserveVout];
  const reserveScript = new P2PKH().lock(PublicKey.fromString(funding.reservePubKey).toAddress());
  if (!reserve || reserve.lockingScript.toHex() !== reserveScript.toHex())
    throw new Error('Fee reserve does not belong to the reserve key');
  const refund = plan.kind === 'refund';
  if (refund && !(plan.refundAfterHeight > 0)) throw new Error('A refund needs its unlock height');
  const seq = refund ? REFUND_SEQUENCE : 0xffffffff;
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: funding.fundTx, sourceOutputIndex: funding.vout, sequence: seq });
  tx.addInput({ sourceTransaction: funding.fundTx, sourceOutputIndex: funding.reserveVout, sequence: seq });
  const to = refund ? plan.posterAddress : plan.payTo;
  tx.addOutput({ lockingScript: BSV21.transfer(escrow.tokenId, escrow.amt).lock(new P2PKH().lock(to)), satoshis: 1 });
  if (!refund && plan.contentSha256 !== undefined)
    tx.addOutput({
      lockingScript: new LockingScript(releaseMemo(escrow.escrowId, plan.contentSha256 ?? null).chunks),
      satoshis: 0,
    });
  tx.lockTime = refund ? plan.refundAfterHeight : 0;
  for (const i of tx.inputs) i.unlockingScript = new UnlockingScript();
  const sig = await signReserve(sighash(tx, 1));
  const { m, pubKeys } = checkKeys(escrow.keys);
  return {
    v: 1,
    escrowId: escrow.escrowId,
    kind: plan.kind,
    txEF: tx.toHexEF(),
    locked: { index: 0, m, pubKeys },
    fee: { index: 1, pubKey: funding.reservePubKey.toLowerCase(), sig: Utils.toHex(sig) },
    sigs: {},
  };
}

/** Wire ↔ engine shape (multisig.ts keeps sigs as input index → pubkey → sig). */
export const toSignable = (p: WireProposal): Signable => ({
  txEF: p.txEF,
  locked: [p.locked],
  fee: p.fee,
  sigs: { '0': { ...p.sigs } },
});

/** Add one escrow-key signature (verified; throws on a bad one). */
export function addEscrowSignature(p: WireProposal, pubKey: string, sig: string): WireProposal {
  const s = addSignatures(toSignable(p), pubKey, { 0: sig });
  return { ...p, sigs: { ...s.sigs['0'] } };
}
export const escrowReady = (p: WireProposal) => isReady(toSignable(p));

/** The broadcastable settlement; refuses with too few signatures and checks every input locally. */
export function finalizeSettlement(p: WireProposal): { rawTx: string; txid: string } {
  return finalize(toSignable(p));
}

/** Can a refund go out yet? (nLockTime is a height; the next block must be at or past it.) */
export const refundOpen = (p: WireProposal, height: number) => p.kind === 'refund' && height >= proposalTx(p).lockTime;

/** Before the poster signs: is this proposal really the settlement we expect? */
export function settlementProblem(
  p: WireProposal,
  expect: { kind: 'release' | 'refund'; escrow: Escrow; to: string; refundAfterHeight?: number },
): string | null {
  if (p.v !== 1 || p.kind !== expect.kind || p.escrowId !== expect.escrow.escrowId)
    return 'This is not that escrow’s settlement.';
  const tx = proposalTx(p);
  const src = tx.inputs[0]?.sourceTransaction?.outputs[tx.inputs[0].sourceOutputIndex];
  if (!src || src.lockingScript.toHex() !== escrowScript(expect.escrow).toHex())
    return 'It does not spend this escrow.';
  if (tx.inputs.length !== 2) return 'It spends something other than the escrow and its fee reserve.';
  const want = BSV21.transfer(expect.escrow.tokenId, expect.escrow.amt).lock(new P2PKH().lock(expect.to)).toHex();
  if (tx.outputs[0]?.lockingScript.toHex() !== want) return `It does not pay the full amount to ${expect.to}.`;
  if (expect.kind === 'refund' && tx.lockTime !== expect.refundAfterHeight) return 'The refund unlock height is wrong.';
  if (expect.kind === 'release' && (tx.lockTime !== 0 || tx.outputs.length > 2)) return 'Unexpected release shape.';
  return null;
}
