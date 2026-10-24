// Partnership shares PARTNER LOCK (owner, 15 Oct 2026): a partner's Partnership shares (the room's BSV-21 tokens
// allocated to them) sit in an on-chain M-of-N multisig over every partner's key, so they only move with the
// partners' agreed signatures. That is what keeps them a private partnership and not a public offer.
//
// Output script (1 sat, one per holding):
//   <BSV-21 transfer inscription {p:"bsv-20",op:"transfer",id,amt}>
//   <holderKey> OP_DROP                         who the holding belongs to (data only, not a spend condition)
//   OP_m <k1> … <kn> OP_n OP_CHECKMULTISIG      the partners' keys, sorted, m from the agreement's transfer rule
//
// unanimous → m = n; majority → the agreed M. Keys: each partner's wallet derives a key from its own seed
// (BRC-42 'self', protocol PARTNER_LOCK_PROTOCOL, keyID = partnership id). Nobody else holds it, we never see it.
//
// Recovery, no server: seed → this partnership's key; the agreement record (partners' public keys + rule) →
// the exact script; any BSV-21 indexer lists the token's unspent outputs → filter by parsePartnerLock(). The
// partners then sign the same way with the record alone (exportProposal / importProposal travel by any channel).
//
// Locked holdings are not P2PKH, so they never enter the wallet's BSV-21 basket: Send, Sell and the Exchange
// cannot select them; isPartnerLocked() is the explicit guard.
//
// Spending: a proposal is a fully built transaction (locked inputs + one exact-fee input from the proposer's
// seed-derived key, no change), so every signature is SIGHASH_ALL over the final transaction and nothing about
// it can change after the first partner signs. finalize() refuses to produce a broadcastable transaction until
// every locked input has m valid signatures, and runs the script interpreter locally before returning.
//
// Pure: no network, no keys held (signers are passed in). Tests: partnerLock.test.ts.
import { BSV21 } from '@1sat/templates';
import { LockingScript, OP, P2PKH, PublicKey, Script, Transaction, UnlockingScript, Utils } from '@bsv/sdk';
import { proposalTx, sighash } from './multisig';

// The signing engine lives in multisig.ts (shared with the partnership's shared account); re-exported here so
// Partnership shares callers keep one import.
export {
  SCOPE,
  addSignatures,
  finalize,
  inputsFor,
  isReady,
  mergeSignatures,
  progress,
  proposalTx,
  sighash,
  signedBy,
  toChecksig,
  waitingOn,
} from './multisig';

/** BRC-100 protocol for partner lock keys: getPublicKey/createSignature, keyID = partnership id, counterparty 'self'. */
export const PARTNER_LOCK_PROTOCOL: [2, string] = [2, 'bwx partnership'];
export const MAX_PARTNER_KEYS = 16;
/** Fee rate for proposals (sats per kB). The fee input is exact; no change output. */
export const FEE_RATE_SATS_PER_KB = 100;
export const MIN_FEE_SATS = 50;

export type TransferRule = { kind: 'unanimous' } | { kind: 'majority'; m: number };
/** Owner default (15 Oct): MAJORITY, the smallest true majority (2-of-3, 3-of-4, 3-of-5). Unanimous stays selectable. */
export const defaultRule = (partners: number): TransferRule => ({ kind: 'majority', m: Math.floor(partners / 2) + 1 });
/** Plain warnings for the setup screen. KEEP IN STEP with bit-sign partnership.ts RULE_WARNING (agreement text). */
export const RULE_WARNING = {
  majority:
    'Majority: if most partners agree, shares can move even without one partner — and a lost phone never freezes the business.',
  unanimous: 'Unanimous: every partner must sign; if one partner loses their 12 words, the shares are stuck for good.',
} as const;

/** Signatures a move needs. Same rule as bit-sign src/lib/partnership.ts signaturesForTransfer. */
export const signaturesNeeded = (rule: TransferRule, partners: number) =>
  rule.kind === 'unanimous' ? partners : Math.min(Math.max(1, rule.m), partners);

/** The partner key the wallet derives for one partnership (keyID). */
export const partnerKeyId = (partnershipId: string) => partnershipId.slice(0, 200);
/** The proposer's one-off fee key for one proposal (recoverable from the seed with the proposal id). */
export const feeKeyId = (partnershipId: string, proposalId: string) =>
  `${partnershipId}:fee:${proposalId}`.slice(0, 200);

const isPub = (k: string) => /^0[23][0-9a-f]{64}$/.test(k);
const smallInt = (n: number) => OP.OP_1 + n - 1;
const readSmallInt = (op: number) => (op >= OP.OP_1 && op <= OP.OP_16 ? op - OP.OP_1 + 1 : -1);

export type Keyset = { m: number; pubKeys: string[] };

/** Canonical keyset: keys sorted, checked. Every partner builds the identical script from the record. */
export function keysetFor(rule: TransferRule, pubKeys: string[]): Keyset {
  const keys = [...pubKeys].map((k) => k.toLowerCase()).sort();
  if (keys.length < 2) throw new Error('A partner lock needs at least two partners');
  if (keys.length > MAX_PARTNER_KEYS) throw new Error(`At most ${MAX_PARTNER_KEYS} partners can share a lock`);
  if (!keys.every(isPub)) throw new Error('Every partner key must be a compressed public key');
  if (new Set(keys).size !== keys.length) throw new Error('Partner keys must be distinct');
  const m = signaturesNeeded(rule, keys.length);
  if (rule.kind === 'majority' && m < Math.floor(keys.length / 2) + 1)
    throw new Error(`Majority means at least ${Math.floor(keys.length / 2) + 1} of ${keys.length}`);
  return { m, pubKeys: keys };
}

/** The multisig part on its own (holder tag + m-of-n). */
export function lockBody(keyset: Keyset, holder: string): Script {
  const h = holder.toLowerCase();
  if (!keyset.pubKeys.includes(h)) throw new Error('The holder must be one of the partners');
  const s = new Script().writeBin(Utils.toArray(h, 'hex')).writeOpCode(OP.OP_DROP).writeOpCode(smallInt(keyset.m));
  for (const k of keyset.pubKeys) s.writeBin(Utils.toArray(k, 'hex'));
  return s.writeOpCode(smallInt(keyset.pubKeys.length)).writeOpCode(OP.OP_CHECKMULTISIG);
}

export type Holding = { tokenId: string; amt: bigint; holder: string };

/** The locked BSV-21 output script for one partner's holding. */
export function partnerLockScript(h: Holding, keyset: Keyset): LockingScript {
  if (h.amt <= 0n) throw new Error('A holding must be more than 0 shares');
  const body = new LockingScript(lockBody(keyset, h.holder).chunks);
  return BSV21.transfer(h.tokenId, h.amt).lock(body);
}

export type ParsedPartnerLock = Holding & Keyset;

/** Reads a partner lock back (null when the script isn't one). Used for recovery scans and the Exchange guard. */
export function parsePartnerLock(script: Script): ParsedPartnerLock | null {
  const c = script.chunks;
  for (let j = c.length - 1; j >= 0; j--) {
    if (c[j].op !== OP.OP_CHECKMULTISIG) continue;
    const n = readSmallInt(c[j - 1]?.op ?? -1);
    if (n < 2) continue;
    const keys: string[] = [];
    for (let k = j - 1 - n; k < j - 1; k++) {
      const d = c[k]?.data;
      if (!d || d.length !== 33) break;
      keys.push(Utils.toHex(d));
    }
    if (keys.length !== n) continue;
    const m = readSmallInt(c[j - 2 - n]?.op ?? -1);
    const drop = c[j - 3 - n];
    const tag = c[j - 4 - n]?.data;
    if (m < 1 || m > n || drop?.op !== OP.OP_DROP || !tag || tag.length !== 33) continue;
    const holder = Utils.toHex(tag);
    if (!keys.includes(holder)) return null;
    const token = BSV21.decode(script);
    const tokenId = token?.getTokenId();
    if (!token || token.getOperation() !== 'transfer' || !tokenId) return null;
    return { tokenId, amt: token.getAmount(), holder, m, pubKeys: keys };
  }
  return null;
}

/** True when an output is a locked partnership holding. The Exchange and Sell never list these. */
export const isPartnerLocked = (script: Script) => parsePartnerLock(script) !== null;

/** Wallet/Exchange label (owner term). */
export const partnershipLabel = (shares: bigint | number) =>
  `Partnership shares · ${BigInt(shares).toLocaleString('en-GB')} · locked`;

// ── proposals ────────────────────────────────────────────────────────────────

export type LockedUtxo = { sourceTx: Transaction; vout: number };
export type FeeUtxo = { sourceTx: Transaction; vout: number; pubKey: string };
export type ProposalKind = 'transfer' | 'admit' | 'remove';

export type PartnerProposal = {
  v: 1;
  partnershipId: string;
  /** Agreement version whose keyset signs (the CURRENT one; an admission's new keyset is in the outputs). */
  agreementVersion: number;
  proposalId: string;
  kind: ProposalKind;
  /** Plain words: "Send 1,000 shares from $ann to $ben". */
  summary: string;
  /** Extended-format tx (carries each input's source amount + script), unlocking scripts empty. */
  txEF: string;
  /** Locked inputs and the keyset each was locked under. */
  locked: { index: number; m: number; pubKeys: string[] }[];
  fee: { index: number; pubKey: string; sig: string };
  /** input index → partner pubkey → checksig signature hex. */
  sigs: Record<string, Record<string, string>>;
};

export type MovePlan = {
  partnershipId: string;
  agreementVersion: number;
  proposalId: string;
  kind: ProposalKind;
  summary: string;
  inputs: LockedUtxo[];
  /** New holdings; every one is locked under `keyset` (the new keyset for an admission). */
  outputs: Holding[];
  keyset: Keyset;
};

const outOf = (u: LockedUtxo) => {
  const o = u.sourceTx.outputs[u.vout];
  if (!o) throw new Error('Locked input is missing its source output');
  return o;
};

/** Estimated size of a move transaction (bytes), for the exact fee input. */
export function moveTxBytes(inputs: { m: number }[], outputScripts: Script[]): number {
  const ins = inputs.reduce((t, i) => t + 41 + 3 + i.m * 73, 0) + 148;
  const outs = outputScripts.reduce((t, s) => t + 9 + 3 + s.toBinary().length, 0);
  return 10 + ins + outs;
}

/** Sats the proposer's fee output must hold for a plan: the miner fee plus any extra 1-sat token outputs. */
export function feeFor(plan: Omit<MovePlan, 'proposalId'> & { proposalId?: string }): number {
  const scripts = plan.outputs.map((h) => partnerLockScript(h, plan.keyset));
  const ins = plan.inputs.map((u) => {
    const p = parsePartnerLock(outOf(u).lockingScript);
    if (!p) throw new Error('Every input must be a partner-locked holding');
    return { m: p.m };
  });
  const miner = Math.max(MIN_FEE_SATS, Math.ceil((moveTxBytes(ins, scripts) * FEE_RATE_SATS_PER_KB) / 1000));
  const inSats = plan.inputs.reduce((t, u) => t + (outOf(u).satoshis ?? 0), 0);
  return miner + Math.max(0, scripts.length - inSats);
}

/** Checks a plan: same token throughout, shares conserved exactly, no empty outputs. */
export function checkPlan(plan: MovePlan): void {
  if (!plan.inputs.length) throw new Error('Nothing to move');
  if (!plan.outputs.length) throw new Error('Say where the shares go');
  const parsed = plan.inputs.map((u) => parsePartnerLock(outOf(u).lockingScript));
  if (parsed.some((p) => !p)) throw new Error('Every input must be a partner-locked holding');
  const tokenId = parsed[0]!.tokenId;
  if (parsed.some((p) => p!.tokenId !== tokenId) || plan.outputs.some((o) => o.tokenId !== tokenId))
    throw new Error('A move carries one token only');
  const inAmt = parsed.reduce((t, p) => t + p!.amt, 0n);
  const outAmt = plan.outputs.reduce((t, o) => t + o.amt, 0n);
  if (inAmt !== outAmt) throw new Error(`Shares must balance: ${inAmt} in, ${outAmt} out`);
}

/**
 * Builds the proposal and the proposer's fee signature. `signFee` signs the fee input (wallet: createSignature with
 * hashToDirectlySign, feeKeyId). The proposer's own partner signature is added afterwards like everyone else's.
 */
export async function propose(
  plan: MovePlan,
  fee: FeeUtxo,
  signFee: (sighash: number[]) => Promise<number[]>,
): Promise<PartnerProposal> {
  checkPlan(plan);
  const feeOut = fee.sourceTx.outputs[fee.vout];
  if (!feeOut) throw new Error('Fee input is missing its source output');
  const feeScript = new P2PKH().lock(PublicKey.fromString(fee.pubKey).toAddress());
  if (feeOut.lockingScript.toHex() !== feeScript.toHex()) throw new Error('Fee input does not belong to the fee key');
  if ((feeOut.satoshis ?? 0) < feeFor(plan)) throw new Error('Fee input is too small for this move');
  const tx = new Transaction();
  for (const u of plan.inputs)
    tx.addInput({ sourceTransaction: u.sourceTx, sourceOutputIndex: u.vout, sequence: 0xffffffff });
  tx.addInput({ sourceTransaction: fee.sourceTx, sourceOutputIndex: fee.vout, sequence: 0xffffffff });
  for (const h of plan.outputs) tx.addOutput({ lockingScript: partnerLockScript(h, plan.keyset), satoshis: 1 });
  for (const i of tx.inputs) i.unlockingScript = new UnlockingScript(); // empty until signed (EF needs a value)
  const feeIndex = plan.inputs.length;
  const feeSig = await signFee(sighash(tx, feeIndex));
  return {
    v: 1,
    partnershipId: plan.partnershipId,
    agreementVersion: plan.agreementVersion,
    proposalId: plan.proposalId,
    kind: plan.kind,
    summary: plan.summary,
    txEF: tx.toHexEF(),
    locked: plan.inputs.map((u, index) => {
      const p = parsePartnerLock(outOf(u).lockingScript)!;
      return { index, m: p.m, pubKeys: p.pubKeys };
    }),
    fee: { index: feeIndex, pubKey: fee.pubKey.toLowerCase(), sig: Utils.toHex(feeSig) },
    sigs: {},
  };
}

/** Proposals travel as JSON (bit-sign pending approvals, or any channel if our server is down). */
export const exportProposal = (p: PartnerProposal) => JSON.stringify(p);
export function importProposal(json: string): PartnerProposal {
  const p = JSON.parse(json) as PartnerProposal;
  if (p?.v !== 1 || typeof p.txEF !== 'string' || !Array.isArray(p.locked) || !p.fee)
    throw new Error('Not a partner proposal');
  const tx = proposalTx(p);
  for (const l of p.locked) {
    const src = tx.inputs[l.index]?.sourceTransaction?.outputs[tx.inputs[l.index].sourceOutputIndex];
    const parsed = src && parsePartnerLock(src.lockingScript);
    if (!parsed || parsed.m !== l.m || parsed.pubKeys.join() !== [...l.pubKeys].join())
      throw new Error('Proposal inputs do not match their locks');
  }
  return p;
}

// ── recovery ─────────────────────────────────────────────────────────────────

/** From any indexer's list of the token's unspent outputs: the ones locked to this partner as holder. */
export function findMyHoldings<T extends { lockingScript: Script }>(
  outputs: T[],
  myKey: string,
): (T & { lock: ParsedPartnerLock })[] {
  const k = myKey.toLowerCase();
  return outputs.flatMap((o) => {
    const lock = parsePartnerLock(o.lockingScript);
    return lock && lock.holder === k ? [{ ...o, lock }] : [];
  });
}

export type ProposalMoves = {
  /** The holdings the transaction really creates, decoded from its outputs (not the proposer's summary). */
  moves: { holder: string; amt: bigint; tokenId: string; m: number; pubKeys: string[] }[];
  /** Outputs that are not partner locks. propose() never makes any, so any here is a reason to refuse. */
  unexpected: { index: number; satoshis: number }[];
  /** Shares in vs out across the partner-locked inputs and outputs. */
  sharesIn: bigint;
  sharesOut: bigint;
};

/**
 * What a proposal's transaction actually does, read from its own outputs. The approval card shows this, and
 * signing is refused when `proposalMoveProblem` returns a reason: the summary is only the proposer's note.
 */
export function describeProposalMoves(p: Pick<PartnerProposal, 'txEF' | 'locked'>): ProposalMoves {
  const tx = Transaction.fromHexEF(p.txEF);
  const moves: ProposalMoves['moves'] = [];
  const unexpected: ProposalMoves['unexpected'] = [];
  tx.outputs.forEach((o, index) => {
    const parsed = parsePartnerLock(o.lockingScript);
    if (parsed) moves.push({ ...parsed });
    else unexpected.push({ index, satoshis: o.satoshis ?? 0 });
  });
  let sharesIn = 0n;
  for (const l of p.locked) {
    const i = tx.inputs[l.index];
    const src = i?.sourceTransaction?.outputs[i.sourceOutputIndex];
    const parsed = src ? parsePartnerLock(src.lockingScript) : null;
    if (parsed) sharesIn += parsed.amt;
  }
  const sharesOut = moves.reduce((t, m) => t + m.amt, 0n);
  return { moves, unexpected, sharesIn, sharesOut };
}

/** Why a partner must not sign this proposal, or null when its outputs are only balanced partner locks. */
export function proposalMoveProblem(d: ProposalMoves): string | null {
  if (d.unexpected.length) return 'This move pays something outside the partnership. Not signed.';
  if (!d.moves.length) return 'This move creates no holdings. Not signed.';
  if (d.sharesIn !== d.sharesOut) return `Shares don't balance (${d.sharesIn} in, ${d.sharesOut} out). Not signed.`;
  if (new Set(d.moves.map((m) => m.tokenId)).size > 1) return 'This move mixes tokens. Not signed.';
  return null;
}
