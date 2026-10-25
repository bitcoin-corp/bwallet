/**
 * Player-to-player token trades (listings): check every transaction BEFORE the wallet signs it.
 *
 * The 1Sat actions (sendBsv21, buyBsv21) and our cancel build their own createAction args. checkedContext
 * (checkedWallet.ts) hands those args to one of the checks below first; any surprise throws and nothing is signed.
 *
 * - Listing: exactly one listing output with the script we built (token, amount, price, payout to us, cancel key
 *   ours); every other token output is change of the SAME token back into our basket; the only other output is the
 *   token's overlay fee, at most what the sheet showed. Every input is one of our own token outputs.
 * - Purchase: one input, the listing the buyer picked; its script (in inputBEEF) is an OrdLock v2 of that token,
 *   amount and price; one output pays the seller exactly that price; one output gives the tokens to our key; the
 *   only extras are the marketplace fee and overlay fee, each at most what the sheet showed.
 * - Cancel: one input, our listing; the tokens go back to our key; the only extra is the overlay fee.
 *
 * BSV funding inputs and BSV change are added by the wallet itself (they never appear in these args).
 * Pure: unit-tested in verify.test.ts with crafted bad args.
 */
import { BSV21, OrdLock, OrdLockV2 } from '@1sat/templates';
import { Beef, LockingScript, P2PKH, Utils } from '@bsv/sdk';
import { decodeListing } from '../sell/sell';

export type ArgOutput = {
  lockingScript: string;
  satoshis: number;
  basket?: string;
  tags?: string[];
};
export type ArgInput = { outpoint: string };
export type CheckArgs = {
  inputs?: readonly ArgInput[];
  outputs?: readonly ArgOutput[];
  inputBEEF?: number[] | Uint8Array;
};

export class TradeCheckError extends Error {
  constructor(reason: string) {
    super(`Stopped before signing: ${reason}`);
    this.name = 'TradeCheckError';
  }
}
const fail = (reason: string): never => {
  throw new TradeCheckError(reason);
};

const norm = (id: string) => id.trim().toLowerCase().replace('.', '_');
const dotted = (op: string) => norm(op).replace('_', '.');
const p2pkhHex = (address: string) => new P2PKH().lock(address).toHex();

type Tok = { id: string; amount: bigint };
/** The BSV-21 transfer an output carries, or null. */
const tokenOf = (hex: string): Tok | null => {
  try {
    const t = BSV21.decode(LockingScript.fromHex(hex));
    const id = t?.getTokenId();
    if (!t || !id || t.getOperation() !== 'transfer') return null;
    return { id: norm(id), amount: t.getAmount() };
  } catch {
    return null;
  }
};

/** Overlay fee: P2PKH to the token's fee address. Returns the sats, or null when the output is not that. */
const overlayFeeOf = (o: ArgOutput, feeAddress: string | null): number | null =>
  feeAddress && o.lockingScript === p2pkhHex(feeAddress) ? o.satoshis : null;

const positive = (n: number) => Number.isSafeInteger(n) && n > 0;

// ── listing ──

export type ListingExpect = {
  tokenId: string;
  amount: bigint;
  /** The exact listing script we built (buildListingScript) as hex. */
  listingScript: string;
  /** How many identical listing outputs ("Sell in lots"); default 1. */
  count?: number;
  basket: string;
  /** Our own unspent token outputs of this token ("txid.vout"). */
  ownOutpoints: ReadonlySet<string>;
  feeAddress: string | null;
  /** Most the overlay fee may total (what the sheet showed). */
  maxOverlayFee: number;
};

export function verifyListingArgs(args: CheckArgs, e: ListingExpect): void {
  const id = norm(e.tokenId);
  const inputs = args.inputs ?? [];
  if (!inputs.length) fail('no token inputs');
  const own = new Set([...e.ownOutpoints].map(dotted));
  for (const i of inputs) if (!own.has(dotted(i.outpoint))) fail(`input ${i.outpoint} is not one of your tokens`);

  let listings = 0;
  let overlay = 0;
  for (const o of args.outputs ?? []) {
    if (o.lockingScript === e.listingScript) {
      listings += 1;
      if (o.satoshis !== 1) fail('listing output must carry 1 sat');
      continue;
    }
    const tok = tokenOf(o.lockingScript);
    if (tok) {
      if (tok.id !== id) fail('an output carries a different token');
      if (o.basket !== e.basket) fail('token change is not coming back to your wallet');
      if (o.satoshis !== 1) fail('token change must carry 1 sat');
      continue;
    }
    if (decodeListing(LockingScript.fromHex(o.lockingScript))) fail('an unexpected listing output');
    const fee = overlayFeeOf(o, e.feeAddress);
    if (fee === null) fail('an output pays someone unexpected');
    overlay += fee as number;
  }
  const want = e.count ?? 1;
  if (listings !== want)
    fail(listings ? `expected ${want} listing outputs, found ${listings}` : 'the listing output is missing');
  const listing = decodeListing(LockingScript.fromHex(e.listingScript));
  if (!listing || listing.tokenId !== id || listing.amount !== e.amount) fail('listing does not match the sheet');
  if (overlay > e.maxOverlayFee) fail(`indexing fee ${overlay} sats is more than the ${e.maxOverlayFee} shown`);
}

// ── purchase ──

export type PurchaseExpect = {
  tokenId: string;
  /** "txid.vout" or "txid_vout" of the listing the buyer picked. */
  outpoint: string;
  amount: bigint;
  /** The price the sheet showed, in sats (paid to the seller). */
  priceSats: number;
  /** Our receive script (BSV21 transfer of amount to our derived key). */
  receiveScript: string;
  basket: string;
  /** Fee output shown on the sheet. `required`: it must be there, for exactly `sats` (the 5% index-fund fee). */
  marketFee: { address: string; sats: number; required?: boolean } | null;
  feeAddress: string | null;
  maxOverlayFee: number;
};

export function verifyPurchaseArgs(args: CheckArgs, e: PurchaseExpect): void {
  const id = norm(e.tokenId);
  const op = dotted(e.outpoint);
  const inputs = args.inputs ?? [];
  if (inputs.length !== 1 || dotted(inputs[0].outpoint) !== op)
    fail('the purchase spends something other than the listing');
  if (!positive(e.priceSats)) fail('no price');

  // The listing itself, from the tx the wallet will spend.
  if (!args.inputBEEF) fail('listing transaction missing');
  const [txid, vout] = op.split('.');
  let script: LockingScript | undefined;
  try {
    script = Beef.fromBinary(Array.from(args.inputBEEF as number[])).findTxid(txid)?.tx?.outputs[Number(vout)]
      ?.lockingScript;
  } catch {
    script = undefined;
  }
  if (!script) fail('listing output not found');
  const listing = decodeListing(script as LockingScript);
  if (!listing || !listing.v2) fail('not an OrdLock v2 token listing');
  const l = listing!;
  if (l.tokenId !== id) fail('the listing is a different token');
  if (l.amount !== e.amount) fail(`the listing holds ${l.amount} not ${e.amount}`);
  if (l.priceSats !== e.priceSats) fail(`the listing asks ${l.priceSats} sats, not the ${e.priceSats} shown`);

  // The seller's payout as the OrdLock commits to it.
  const payout = ordLockPayout(script as LockingScript);
  let receive = 0;
  let paid = 0;
  let overlay = 0;
  let market = 0;
  for (const o of args.outputs ?? []) {
    if (o.lockingScript === e.receiveScript) {
      receive += 1;
      if (o.satoshis !== 1 || o.basket !== e.basket) fail('tokens are not going to your wallet');
      continue;
    }
    if (payout && o.lockingScript === payout.script && paid === 0) {
      if (o.satoshis !== e.priceSats) fail(`seller payout is ${o.satoshis} sats, not ${e.priceSats}`);
      paid += 1;
      continue;
    }
    if (tokenOf(o.lockingScript)) fail('tokens go somewhere other than your wallet');
    if (e.marketFee && o.lockingScript === p2pkhHex(e.marketFee.address) && market === 0) {
      if (o.satoshis > e.marketFee.sats) fail('marketplace fee is more than shown');
      if (e.marketFee.required && o.satoshis !== e.marketFee.sats) fail('indexing fee does not match the sheet');
      market += 1;
      continue;
    }
    const fee = overlayFeeOf(o, e.feeAddress);
    if (fee === null) fail('an output pays someone unexpected');
    overlay += fee as number;
  }
  if (!payout || payout.sats !== e.priceSats) fail('the listing payout does not match its price');
  if (paid !== 1) fail('the seller is not paid');
  if (e.marketFee?.required && market !== 1) fail('the index-fund fee is missing');
  if (receive !== 1) fail('the tokens are not coming to you');
  if (overlay > e.maxOverlayFee) fail(`indexing fee ${overlay} sats is more than the ${e.maxOverlayFee} shown`);
}

/** The OrdLock's committed payout (sats + script hex), or null. */
function ordLockPayout(script: LockingScript): { sats: number; script: string } | null {
  try {
    const d = OrdLockV2.decode(script) ?? OrdLock.decode(script);
    if (!d) return null;
    const r = new Utils.Reader(d.payout);
    const sats = r.readUInt64LEBn().toNumber();
    const len = r.readVarIntNum();
    return { sats, script: Utils.toHex(r.read(len)) };
  } catch {
    return null;
  }
}

// ── cancel ──

export type CancelExpect = {
  tokenId: string;
  outpoint: string;
  amount: bigint;
  /** Where the tokens come back (BSV21 transfer of amount to our fresh key). */
  backScript: string;
  basket: string;
  feeAddress: string | null;
  maxOverlayFee: number;
};

export function verifyCancelArgs(args: CheckArgs, e: CancelExpect): void {
  const inputs = args.inputs ?? [];
  if (inputs.length !== 1 || dotted(inputs[0].outpoint) !== dotted(e.outpoint))
    fail('the cancel spends something other than your listing');
  let back = 0;
  let overlay = 0;
  for (const o of args.outputs ?? []) {
    if (o.lockingScript === e.backScript) {
      if (o.satoshis !== 1 || o.basket !== e.basket) fail('tokens are not coming back to your wallet');
      back += 1;
      continue;
    }
    if (tokenOf(o.lockingScript)) fail('tokens go somewhere other than your wallet');
    const fee = overlayFeeOf(o, e.feeAddress);
    if (fee === null) fail('an output pays someone unexpected');
    overlay += fee as number;
  }
  const tok = tokenOf(e.backScript);
  if (!tok || tok.id !== norm(e.tokenId) || tok.amount !== e.amount) fail('returned tokens do not match the listing');
  if (back !== 1) fail('the tokens are not coming back to you');
  if (overlay > e.maxOverlayFee) fail(`indexing fee ${overlay} sats is more than the ${e.maxOverlayFee} shown`);
}
