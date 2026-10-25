/**
 * The check every Memepool trade template must pass BEFORE the approval sheet and again right before signing. If any
 * rule fails, nothing is signed and the user sees why in plain English. THIS FILE MOVES MONEY (money-paths.txt).
 *
 * Memepool builds the whole transaction (their core/swap.js): pool coins + our coins in, tokens/sats out. We sign only
 * our own inputs with SIGHASH_ALL|FORKID, which commits to every input and output, so what we check here is exactly
 * what can happen. Nothing in the template is trusted: not its quote, not its roles, not its owners.
 *
 *  - Our inputs only: every input marked ours is a coin we offered, with the same script and amount. Every other input
 *    is locked to this coin's pool addresses (pinned from the proof of reserves). Nothing else may be spent.
 *  - SIGHASH_ALL|FORKID only: a template asking for any other signature type is refused; the signer can't make one.
 *  - Final transaction: nLockTime 0 and final sequences, so it can't be held back or replaced.
 *  - Every output is ours, the pool's, Memepool's fee (pinned address, exact amount), the creator's share (exact
 *    total), the coin's indexer fee (its fund address, capped) or a 0-sat memo. Anything else refuses.
 *  - Fees: 1.25% of the trade's BSV side in total, of which 0.30% is the creator's, computed here from the gross.
 *  - Tokens in = tokens out, one token id only, every token output canonical and 1 sat.
 *  - Buy: we spend no more than the sheet's "You pay at most" (itself under the 1 BSV cap) and get at least the
 *    minimum tokens our own curve maths allows at the user's slippage. Sell: exactly the tokens asked leave, and at
 *    least the minimum sats come back to our pay address.
 *  - The quote hasn't expired and the coin's proof of reserves is healthy.
 */
import {
  CAP_SATS,
  INDEX_FEE_PER_OUTPUT,
  MAX_INDEX_FEE,
  MAX_TEMPLATE_INPUTS,
  MAX_TEMPLATE_OUTPUTS,
  NETWORK_ALLOWANCE,
  PLATFORM_ADDRESS,
  SHARE_REBATE_SLACK,
  SIGHASH_ALL_FORKID,
  TEMPLATE_VERSION,
} from './constants';
import { feeSplit } from './curve';
import type { ProofVerdict } from './proof';
import { addressPkh, isOpReturn, parseBsv21Transfer, parseP2pkh } from './script';

export class TradeRefused extends Error {
  constructor(public readonly why: string) {
    super(why);
  }
}
const refuse = (why: string): never => {
  throw new TradeRefused(why);
};

export type TemplateInput = {
  txid: string;
  vout: number;
  satoshis: number;
  script: string;
  owner: string;
  role?: string;
  amt?: string;
  seq?: number;
  [k: string]: unknown;
};
export type TemplateOutput = { script: string; satoshis: number; role?: string; amt?: string; [k: string]: unknown };
export type Template = {
  v: number;
  side: string;
  tokenId: string;
  version?: number;
  lockTime?: number;
  inputs: TemplateInput[];
  outputs: TemplateOutput[];
  quote: Record<string, unknown>;
  [k: string]: unknown;
};

/** A coin we offered: its script and sats as our wallet knows them, and its tokens (token coins). */
export type OurCoin = { satoshis: number; script: string; amt?: bigint };

export type VerifyContext = {
  side: 'buy' | 'sell';
  tokenId: string;
  /** Our ord (tokens) and pay (BSV) addresses for this trade. */
  me: { ord: string; pay: string; coins: Map<string, OurCoin> };
  /** The coin's pool addresses from its proof of reserves row; the verdict itself must be healthy. */
  proof: ProofVerdict;
  /** The coin's indexer fund address (GET /tokens/{id} indexer.fundAddress), or null if it has none. */
  indexAddress: string | null;
  limits: { maxSpendSats: bigint; minTokens: bigint } | { tokens: bigint; minSats: bigint };
  /** When the quote stops being good (ms since epoch). */
  expiresAt: number;
  now: number;
};

export type CheckedTrade = {
  side: 'buy' | 'sell';
  /** Buy: tokens we get. Sell: tokens we give. */
  tokens: bigint;
  /** Buy: sats that leave our wallet in total. Sell: sats that come back to us. */
  sats: bigint;
  gross: bigint;
  fee: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  indexFee: bigint;
  networkFee: bigint;
  /** Indexes of the inputs we sign (and nothing else). */
  ourInputs: number[];
};

const ZERO = BigInt(0);
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const intStr = (v: unknown): bigint | null =>
  typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : isInt(v) ? BigInt(v) : null;
const SIGHASH_KEYS = ['sighash', 'sighashType', 'sigHash', 'scope', 'sighashFlags', 'anyoneCanPay'];

/** Throws TradeRefused (plain English) unless the template is exactly a fair trade for us. */
export function verifyTemplate(t: Template, ctx: VerifyContext): CheckedTrade {
  if (!ctx.proof.healthy) refuse(ctx.proof.why);
  const pool = ctx.proof.healthy ? ctx.proof.row : refuse('no proof');
  if (!(ctx.expiresAt > ctx.now)) refuse('This price has expired. Get a new one.');

  // Shape.
  if (!t || typeof t !== 'object' || t.v !== TEMPLATE_VERSION) refuse("Memepool sent a trade this wallet can't read.");
  if (t.side !== ctx.side) refuse(`Memepool sent a ${String(t.side)} when you asked to ${ctx.side}.`);
  if (t.tokenId !== ctx.tokenId) refuse('Memepool sent a trade for a different coin.');
  if (!Array.isArray(t.inputs) || !Array.isArray(t.outputs) || !t.inputs.length || !t.outputs.length)
    refuse("Memepool sent a trade this wallet can't read.");
  if (t.inputs.length > MAX_TEMPLATE_INPUTS || t.outputs.length > MAX_TEMPLATE_OUTPUTS)
    refuse('Memepool sent an unusually large trade.');
  if ((t.version ?? 1) !== 1) refuse("Memepool sent a trade this wallet can't read.");
  if ((t.lockTime ?? 0) !== 0) refuse('The trade could be held back from the network (it has a lock time).');

  // Signature type: only ever SIGHASH_ALL|FORKID, wherever the template might ask for something else.
  for (const holder of [t as Record<string, unknown>, ...t.inputs])
    for (const k of SIGHASH_KEYS)
      if (k in holder && holder[k] !== undefined && holder[k] !== SIGHASH_ALL_FORKID)
        refuse('Memepool asked for a kind of signature that would let the trade be changed after you sign.');

  const myOrd = addressPkh(ctx.me.ord);
  const myPay = addressPkh(ctx.me.pay);
  const poolOrd = addressPkh(pool.poolOrd);
  const poolPay = addressPkh(pool.poolPay);
  const platform = addressPkh(PLATFORM_ADDRESS);
  const indexer = ctx.indexAddress ? addressPkh(ctx.indexAddress) : null;
  if (!myOrd || !myPay || !poolOrd || !poolPay || !platform) refuse('An address for this trade is missing.');
  if (new Set([myOrd, myPay].filter((p) => p === poolOrd || p === poolPay || p === platform)).size)
    refuse('An address for this trade is mixed up with the pool.');

  // Inputs.
  const seen = new Set<string>();
  const ourInputs: number[] = [];
  let mySatsIn = ZERO;
  let myTokIn = ZERO;
  let poolSatsIn = ZERO;
  let tokIn = ZERO;
  let satIn = ZERO;
  t.inputs.forEach((i, idx) => {
    if (!i || typeof i.txid !== 'string' || !/^[0-9a-f]{64}$/.test(i.txid) || !isInt(i.vout))
      refuse("Memepool sent a trade this wallet can't read.");
    if (!isInt(i.satoshis) || i.satoshis < 1 || typeof i.script !== 'string' || !/^[0-9a-f]*$/.test(i.script))
      refuse("Memepool sent a trade this wallet can't read.");
    if (i.seq !== undefined && i.seq !== null && i.seq !== 0xffffffff)
      refuse('The trade could be held back from the network (an input is not final).');
    const op = `${i.txid}_${i.vout}`;
    if (seen.has(op)) refuse('The trade spends the same coin twice.');
    seen.add(op);
    const tok = parseBsv21Transfer(i.script);
    if (tok) {
      if (tok.id !== ctx.tokenId) refuse('The trade touches a different token.');
      if (i.satoshis !== 1) refuse('A token coin in the trade carries the wrong amount of BSV.');
      if (i.amt !== undefined && intStr(i.amt) !== tok.amt) refuse('A token coin in the trade is mislabelled.');
      tokIn += tok.amt;
    } else if (!parseP2pkh(i.script)) refuse('The trade spends a kind of coin this wallet does not trade.');
    satIn += BigInt(i.satoshis);
    const mine = ctx.me.coins.get(op);
    if (i.owner === 'user') {
      // Ours to sign: only a coin we offered, exactly as we know it.
      if (!mine) refuse('The trade asks you to sign for a coin you did not offer.');
      const m = mine as OurCoin;
      if (m.script !== i.script || m.satoshis !== i.satoshis) refuse('The trade changed one of your coins.');
      if ((m.amt ?? null) !== (tok ? tok.amt : null)) refuse('The trade changed how many tokens your coin holds.');
      ourInputs.push(idx);
      mySatsIn += BigInt(i.satoshis);
      if (tok) myTokIn += tok.amt;
    } else if (i.owner === 'pool') {
      if (mine) refuse('The trade marks one of your coins as the pool’s.');
      const pkh = tok ? tok.pkh : parseP2pkh(i.script);
      if (pkh !== (tok ? poolOrd : poolPay)) refuse('The trade spends a coin that is not this coin’s pool.');
      if (!tok) poolSatsIn += BigInt(i.satoshis);
    } else refuse('The trade spends a coin that is neither yours nor the pool’s.');
  });
  if (!ourInputs.length) refuse('The trade has nothing for you to sign.');

  // Outputs.
  let mySatsOut = ZERO;
  let myTokOut = ZERO;
  let poolSatsOut = ZERO;
  let tokOut = ZERO;
  let satOut = ZERO;
  let platformOut = ZERO;
  let platformCount = 0;
  let creatorOut = ZERO;
  let shareCount = 0;
  let indexOut = ZERO;
  let indexCount = 0;
  let memoCount = 0;
  let tokenOutputs = 0;
  for (const o of t.outputs) {
    if (!o || !isInt(o.satoshis) || typeof o.script !== 'string' || !/^[0-9a-f]*$/.test(o.script))
      refuse("Memepool sent a trade this wallet can't read.");
    const sats = BigInt(o.satoshis);
    satOut += sats;
    const tok = parseBsv21Transfer(o.script);
    if (tok) {
      if (tok.id !== ctx.tokenId) refuse('The trade sends a different token.');
      if (o.satoshis !== 1) refuse('A token output carries the wrong amount of BSV.');
      if (o.amt !== undefined && intStr(o.amt) !== tok.amt) refuse('A token output is mislabelled.');
      tokenOutputs++;
      tokOut += tok.amt;
      if (tok.pkh === myOrd) {
        myTokOut += tok.amt;
        mySatsOut += sats;
      } else if (tok.pkh !== poolOrd) refuse('The trade sends tokens to someone other than you or the pool.');
      continue;
    }
    if (isOpReturn(o.script)) {
      if (o.satoshis !== 0 || ++memoCount > 1) refuse('The trade carries an unexpected data output.');
      continue;
    }
    const pkh = parseP2pkh(o.script);
    if (!pkh) refuse('The trade has an output this wallet does not recognise.');
    if (o.satoshis < 1) refuse('The trade has an empty payment.');
    if (pkh === myPay || pkh === myOrd) mySatsOut += sats;
    else if (pkh === poolPay) poolSatsOut += sats;
    else if (pkh === platform && o.role !== 'creator-fee' && o.role !== 'fee-share') {
      platformOut += sats;
      platformCount++;
    } else if (o.role === 'index-fee' && indexer && pkh === indexer) {
      indexOut += sats;
      indexCount++;
    } else if (o.role === 'creator-fee' || o.role === 'fee-share') {
      creatorOut += sats;
      shareCount++;
    } else refuse('The trade pays someone this wallet does not expect.');
  }

  // Conservation.
  if (tokIn !== tokOut) refuse('Tokens would appear or vanish in this trade.');
  if (satOut > satIn) refuse('The trade pays out more than goes in.');
  const networkFee = satIn - satOut;
  if (networkFee > BigInt(NETWORK_ALLOWANCE)) refuse('The network fee on this trade is unusually high.');

  // Fees: 1.25% of the gross, 0.30% of it to the creator, the rest to Memepool's pinned address, exactly.
  const gross = intStr(t.quote?.grossSats);
  if (gross === null || gross <= ZERO) refuse("Memepool's numbers for this trade don't add up.");
  const g = gross as bigint;
  if (g > CAP_SATS) refuse('This trade is over the 1 BSV limit.');
  const f = feeSplit(g);
  const qFee = intStr(t.quote?.fee);
  if (qFee !== null && qFee !== f.fee) refuse('The fee on this trade is not the 1.25% it should be.');
  if (platformCount !== 1 || platformOut !== f.platform)
    refuse("Memepool's fee on this trade is not exactly its 0.95% share.");
  // The creator's 0.30%: paid out now, or (part of it) left waiting in the pool, never more or less in total.
  const net = g - f.fee;
  const poolDelta = poolSatsOut - poolSatsIn;
  const poolKeeps = ctx.side === 'buy' ? poolDelta - net : poolDelta + g;
  const gap = f.creator - (creatorOut + poolKeeps);
  const slack = ctx.side === 'sell' ? BigInt(SHARE_REBATE_SLACK * shareCount) : ZERO;
  if (gap < ZERO || gap > slack) refuse("The creator's share on this trade is not exactly 0.30%.");
  // Indexer fee: to the coin's own fund address, at most 1,000 sats per token output and 5,000 in all.
  if (indexCount > 1) refuse('The trade pays the indexer twice.');
  const indexCap = BigInt(Math.min(MAX_INDEX_FEE, INDEX_FEE_PER_OUTPUT * Math.max(tokenOutputs, 1)));
  if (indexOut > indexCap) refuse('The indexer fee on this trade is unusually high.');

  if (ctx.side === 'buy') {
    const l = ctx.limits as { maxSpendSats: bigint; minTokens: bigint };
    if (!(l.maxSpendSats > ZERO) || !(l.minTokens > ZERO)) refuse('Missing limits for this buy.');
    if (myTokIn !== ZERO) refuse('A buy must not spend your tokens.');
    const spend = mySatsIn - mySatsOut;
    if (spend > l.maxSpendSats) refuse('The trade would cost you more than the amount shown.');
    if (spend > CAP_SATS + BigInt(MAX_INDEX_FEE + NETWORK_ALLOWANCE)) refuse('This trade is over the 1 BSV limit.');
    if (myTokOut < l.minTokens) refuse('The price moved more than you allowed. You would get too few tokens.');
    return done(myTokOut, spend);
  }
  const l = ctx.limits as { tokens: bigint; minSats: bigint };
  if (!(l.tokens > ZERO) || !(l.minSats > ZERO)) refuse('Missing limits for this sell.');
  const sold = myTokIn - myTokOut;
  if (sold !== l.tokens) refuse('The trade would sell a different number of tokens than you asked.');
  const gets = mySatsOut - mySatsIn;
  if (gets < l.minSats) refuse('The price moved more than you allowed. You would get too little BSV back.');
  return done(sold, gets);

  function done(tokens: bigint, sats: bigint): CheckedTrade {
    return {
      side: ctx.side,
      tokens,
      sats,
      gross: g,
      fee: f.fee,
      platformFee: f.platform,
      creatorFee: f.creator,
      indexFee: indexOut,
      networkFee,
      ourInputs,
    };
  }
}
