/**
 * Test fixtures only (imported by *.test.ts): honest Memepool templates built the way their core/swap.js builds
 * them (buildBuy / buildSell), from a real coin's state read on 25 Oct 2026, so the malicious variants in the tests
 * differ from an honest trade in exactly one way.
 */
import { PrivateKey } from '@bsv/sdk';
import { PLATFORM_ADDRESS } from './constants';
import { buyTokens, feeSplit, sellSats, type CurveParams, type CurveState } from './curve';
import type { ProofVerdict } from './proof';
import { addressPkh, bsv21TransferScript, p2pkhFromAddress } from './script';
import type { Template, VerifyContext } from './validate';

export const TOKEN = '66a4e56a9910f579b85639ebb08eaf98f276b27164cbfa80a7daccce57273933_1';
export const PARAMS: CurveParams = {
  totalSupply: BigInt(1_000_000_000),
  curveSupply: BigInt(793_100_000),
  vSats0: BigInt(500_000_000),
  vTokens0: BigInt(1_073_000_000),
  tailAt: BigInt(206_900_000),
};
export const STATE: CurveState = {
  vSats: BigInt(527_501_346),
  vTokens: BigInt(1_017_059_099),
  realSats: BigInt(27_501_346),
  realTokens: BigInt(944_059_099),
  tail: false,
};

export const keyAddr = () => {
  const k = PrivateKey.fromRandom();
  return { key: k, address: k.toAddress() };
};
export const POOL_PAY = keyAddr().address;
export const POOL_ORD = keyAddr().address;
export const CREATOR = keyAddr().address;
export const INDEXER = keyAddr().address;
export const STRANGER = keyAddr().address;

export const healthy: ProofVerdict = { healthy: true, row: { id: TOKEN, poolPay: POOL_PAY, poolOrd: POOL_ORD } };
const pkh = (a: string) => addressPkh(a)!;
export const tok = (address: string, amt: bigint) => bsv21TransferScript(pkh(address), TOKEN, amt);
export const pay = (address: string) => p2pkhFromAddress(address);
export const txid = (n: number) => n.toString(16).padStart(64, '0');
export const MEMO = '006a086d656d65706f6f6c';
export const NETWORK_FEE = 300;
export const INDEX_FEE = 2_000;
export const NOW = 1_800_000_000_000;

export type Fixture = { t: Template; ctx: VerifyContext; me: { ord: string; pay: string } };

/** An honest buy of `budget` sats (non-tail coin: gross = budget). */
export function honestBuy(
  budget = BigInt(1_000_000),
  me = { ord: keyAddr().address, pay: keyAddr().address },
): Fixture {
  const tokens = buyTokens(PARAMS, STATE, budget);
  const gross = budget;
  const f = feeSplit(gross);
  const net = gross - f.fee;
  const poolTok = STATE.realTokens;
  const maxSpend = gross + BigInt(INDEX_FEE + 4_000);
  const userIn = Number(maxSpend) + 50_000; // a bigger coin than needed: the rest comes back as change
  const outputs: Template['outputs'] = [
    { script: tok(me.ord, tokens), satoshis: 1, role: 'user-token', amt: tokens.toString() },
    { script: tok(POOL_ORD, poolTok - tokens), satoshis: 1, role: 'pool-token', amt: (poolTok - tokens).toString() },
    { script: pay(POOL_PAY), satoshis: Number(net), role: 'pool-sats' },
    { script: pay(PLATFORM_ADDRESS), satoshis: Number(f.platform), role: 'platform-fee' },
    { script: pay(CREATOR), satoshis: Number(f.creator), role: 'creator-fee' },
    { script: pay(INDEXER), satoshis: INDEX_FEE, role: 'index-fee' },
    { script: MEMO, satoshis: 0, role: 'memo' },
  ];
  const fixed = outputs.reduce((a, o) => a + o.satoshis, 0);
  const change = userIn + 1 - fixed - NETWORK_FEE;
  outputs.push({ script: pay(me.pay), satoshis: change, role: 'user-change' });
  const userCoin = { txid: txid(2), vout: 0, satoshis: userIn, script: pay(me.pay) };
  const t: Template = {
    v: 1,
    side: 'buy',
    tokenId: TOKEN,
    version: 1,
    lockTime: 0,
    inputs: [
      {
        txid: txid(1),
        vout: 0,
        satoshis: 1,
        script: tok(POOL_ORD, poolTok),
        owner: 'pool',
        role: 'pool-token',
        amt: poolTok.toString(),
      },
      { ...userCoin, owner: 'user', role: 'user-sats' },
    ],
    outputs,
    quote: {
      tokens: tokens.toString(),
      grossSats: gross.toString(),
      netSats: net.toString(),
      fee: f.fee.toString(),
      creatorFee: f.creator.toString(),
      platformFee: f.platform.toString(),
    },
  };
  const ctx: VerifyContext = {
    side: 'buy',
    tokenId: TOKEN,
    me: { ...me, coins: new Map([[`${userCoin.txid}_0`, { satoshis: userCoin.satoshis, script: userCoin.script }]]) },
    proof: healthy,
    indexAddress: INDEXER,
    limits: { maxSpendSats: maxSpend, minTokens: (tokens * BigInt(9700)) / BigInt(10000) },
    expiresAt: NOW + 30_000,
    now: NOW,
  };
  return { t, ctx, me };
}

/** An honest sell of `tokens` from one token coin of ours holding `held`. */
export function honestSell(
  tokens = BigInt(5_000_000),
  held = BigInt(6_000_000),
  me = { ord: keyAddr().address, pay: keyAddr().address },
): Fixture {
  const s = sellSats(PARAMS, STATE, tokens);
  const f = feeSplit(s.gross);
  const reserveIn = Number(STATE.realSats);
  const outputs: Template['outputs'] = [
    { script: tok(POOL_ORD, tokens), satoshis: 1, role: 'pool-token', amt: tokens.toString() },
    { script: tok(me.ord, held - tokens), satoshis: 1, role: 'user-token', amt: (held - tokens).toString() },
    { script: pay(me.pay), satoshis: 0, role: 'user-payout' },
    { script: pay(PLATFORM_ADDRESS), satoshis: Number(f.platform), role: 'platform-fee' },
    { script: pay(CREATOR), satoshis: Number(f.creator), role: 'creator-fee' },
    { script: pay(INDEXER), satoshis: INDEX_FEE, role: 'index-fee' },
    { script: MEMO, satoshis: 0, role: 'memo' },
    { script: pay(POOL_PAY), satoshis: reserveIn - Number(s.gross), role: 'pool-sats' },
  ];
  // payout = net - index - fee + (user token ins - token outs)
  outputs[2].satoshis = Number(s.net) - INDEX_FEE - NETWORK_FEE + (1 - 2);
  const userCoin = { txid: txid(3), vout: 1, satoshis: 1, script: tok(me.ord, held) };
  const t: Template = {
    v: 1,
    side: 'sell',
    tokenId: TOKEN,
    version: 1,
    lockTime: 0,
    inputs: [
      { ...userCoin, owner: 'user', role: 'user-token', amt: held.toString() },
      { txid: txid(4), vout: 0, satoshis: reserveIn, script: pay(POOL_PAY), owner: 'pool', role: 'pool-sats' },
    ],
    outputs,
    quote: {
      tokens: tokens.toString(),
      grossSats: s.gross.toString(),
      netSats: s.net.toString(),
      fee: f.fee.toString(),
      creatorFee: f.creator.toString(),
      platformFee: f.platform.toString(),
    },
  };
  const minSats = ((s.net - BigInt(INDEX_FEE + 1_500)) * BigInt(9700)) / BigInt(10000);
  const ctx: VerifyContext = {
    side: 'sell',
    tokenId: TOKEN,
    me: { ...me, coins: new Map([[`${userCoin.txid}_1`, { satoshis: 1, script: userCoin.script, amt: held }]]) },
    proof: healthy,
    indexAddress: INDEXER,
    limits: { tokens, minSats },
    expiresAt: NOW + 30_000,
    now: NOW,
  };
  return { t, ctx, me };
}

export const clone = <T>(x: T): T => structuredClone(x);
