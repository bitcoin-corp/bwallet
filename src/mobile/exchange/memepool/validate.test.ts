import { describe, expect, test } from 'bun:test';
import { PLATFORM_ADDRESS } from './constants';
import { TradeRefused, verifyTemplate, type Template, type VerifyContext } from './validate';
import {
  CREATOR,
  INDEXER,
  MEMO,
  NOW,
  POOL_ORD,
  POOL_PAY,
  STRANGER,
  TOKEN,
  clone,
  honestBuy,
  honestSell,
  keyAddr,
  pay,
  tok,
  txid,
  type Fixture,
} from './testkit';
import { bsv21TransferScript, addressPkh } from './script';

/** Run the verifier and return the refusal (plain English), or '' if it passed. */
const why = (t: Template, ctx: VerifyContext): string => {
  try {
    verifyTemplate(t, ctx);
    return '';
  } catch (e) {
    expect(e).toBeInstanceOf(TradeRefused);
    return (e as Error).message;
  }
};
const out = (f: Fixture, role: string) => f.t.outputs.find((o) => o.role === role)!;

describe('honest templates pass', () => {
  test('buy: tokens to our ord, spend within the sheet, our input only', () => {
    const f = honestBuy();
    const c = verifyTemplate(f.t, f.ctx);
    expect(c.ourInputs).toEqual([1]);
    expect(c.tokens).toBe(BigInt(1_900_410)); // matches Memepool's live /quote for this state, 25 Oct 2026
    expect(c.platformFee).toBe(BigInt(9_500));
    expect(c.creatorFee).toBe(BigInt(3_000));
    expect(c.fee).toBe(BigInt(12_500)); // exactly 1.25%
    expect(c.sats).toBe(BigInt(1_000_000 + 2_000 + 300)); // gross + indexer fee + network fee
    expect(c.networkFee).toBe(BigInt(300));
  });
  test('sell: exactly the tokens asked leave, payout to our pay address', () => {
    const f = honestSell();
    const c = verifyTemplate(f.t, f.ctx);
    expect(c.ourInputs).toEqual([0]);
    expect(c.tokens).toBe(BigInt(5_000_000));
    expect(c.gross).toBe(BigInt(2_580_581)); // Memepool's live /quote, 25 Oct 2026
    expect(c.creatorFee).toBe(BigInt(7_741));
  });
  test("buy: the creator's share waiting in the pool (poolKeeps) still adds up to 0.30%", () => {
    const f = honestBuy();
    const creator = out(f, 'creator-fee');
    out(f, 'pool-sats').satoshis += creator.satoshis;
    f.t.outputs = f.t.outputs.filter((o) => o !== creator);
    expect(why(f.t, f.ctx)).toBe('');
  });
  test('buy: creator share split into fee-share outputs', () => {
    const f = honestBuy();
    const creator = out(f, 'creator-fee');
    f.t.outputs.splice(
      f.t.outputs.indexOf(creator),
      1,
      { script: pay(CREATOR), satoshis: 1000, role: 'fee-share' },
      { script: pay(keyAddr().address), satoshis: creator.satoshis - 1000, role: 'fee-share' },
    );
    expect(why(f.t, f.ctx)).toBe('');
  });
});

describe('malicious templates are refused', () => {
  test('extra output to a stranger', () => {
    const f = honestBuy();
    out(f, 'user-change').satoshis -= 500;
    f.t.outputs.push({ script: pay(STRANGER), satoshis: 500 });
    expect(why(f.t, f.ctx)).toMatch(/pays someone this wallet does not expect/);
  });
  test('wrong platform fee address', () => {
    const f = honestBuy();
    out(f, 'platform-fee').script = pay(STRANGER);
    expect(why(f.t, f.ctx)).toMatch(/does not expect|0\.95%/);
  });
  test('platform fee one sat too high', () => {
    const f = honestBuy();
    out(f, 'platform-fee').satoshis += 1;
    out(f, 'user-change').satoshis -= 1;
    expect(why(f.t, f.ctx)).toMatch(/0\.95%/);
  });
  test('platform fee paid twice', () => {
    const f = honestBuy();
    f.t.outputs.push({ ...out(f, 'platform-fee') });
    out(f, 'user-change').satoshis -= out(f, 'platform-fee').satoshis;
    expect(why(f.t, f.ctx)).toMatch(/0\.95%/);
  });
  test('creator share above 0.30%', () => {
    const f = honestBuy();
    out(f, 'creator-fee').satoshis += 100;
    out(f, 'user-change').satoshis -= 100;
    expect(why(f.t, f.ctx)).toMatch(/0\.30%/);
  });
  test('quote claims a different fee than 1.25%', () => {
    const f = honestBuy();
    f.t.quote.fee = '20000';
    expect(why(f.t, f.ctx)).toMatch(/1\.25%/);
  });
  test('short tokens: fewer than our minimum (the rest kept by the pool)', () => {
    const f = honestBuy();
    const mine = out(f, 'user-token');
    const poolT = out(f, 'pool-token');
    const minTokens = (f.ctx.limits as { minTokens: bigint }).minTokens;
    const give = minTokens - BigInt(1);
    const taken = BigInt(mine.amt!) - give;
    mine.script = tok(f.me.ord, give);
    mine.amt = give.toString();
    poolT.script = tok(POOL_ORD, BigInt(poolT.amt!) + taken);
    poolT.amt = (BigInt(poolT.amt!) + taken).toString();
    expect(why(f.t, f.ctx)).toMatch(/too few tokens/);
  });
  test('tokens to someone else', () => {
    const f = honestBuy();
    const mine = out(f, 'user-token');
    mine.script = tok(STRANGER, BigInt(mine.amt!));
    expect(why(f.t, f.ctx)).toMatch(/sends tokens to someone other/);
  });
  test('foreign input to sign: a coin we did not offer marked ours', () => {
    const f = honestBuy();
    f.t.inputs.push({ txid: txid(99), vout: 0, satoshis: 5000, script: pay(f.me.pay), owner: 'user' });
    expect(why(f.t, f.ctx)).toMatch(/did not offer/);
  });
  test('an input that is neither ours nor the pool’s', () => {
    const f = honestBuy();
    f.t.inputs.push({ txid: txid(98), vout: 0, satoshis: 5000, script: pay(STRANGER), owner: 'pool' });
    expect(why(f.t, f.ctx)).toMatch(/not this coin’s pool/);
  });
  test('an input with an unknown owner', () => {
    const f = honestBuy();
    f.t.inputs[0].owner = 'house';
    expect(why(f.t, f.ctx)).toMatch(/neither yours nor the pool’s/);
  });
  test('our coin altered (different amount)', () => {
    const f = honestBuy();
    f.t.inputs[1].satoshis += 1;
    expect(why(f.t, f.ctx)).toMatch(/changed one of your coins/);
  });
  test('our coin relabelled as the pool’s', () => {
    const f = honestBuy();
    f.t.inputs[1].owner = 'pool';
    expect(why(f.t, f.ctx)).toMatch(/marks one of your coins/);
  });
  test('wrong sighash on an input (ANYONECANPAY)', () => {
    const f = honestBuy();
    f.t.inputs[1].sighash = 0xc1;
    expect(why(f.t, f.ctx)).toMatch(/kind of signature/);
  });
  test('wrong sighash on the template (SIGHASH_NONE)', () => {
    const f = honestBuy();
    f.t.sighashType = 0x42;
    expect(why(f.t, f.ctx)).toMatch(/kind of signature/);
  });
  test('explicit SIGHASH_ALL|FORKID is fine', () => {
    const f = honestBuy();
    f.t.inputs[1].sighash = 0x41;
    expect(why(f.t, f.ctx)).toBe('');
  });
  test('expired quote', () => {
    const f = honestBuy();
    expect(why(f.t, { ...f.ctx, now: f.ctx.expiresAt })).toMatch(/expired/);
  });
  test('cap exceeded: gross over 1 BSV', () => {
    const f = honestBuy();
    f.t.quote.grossSats = '100000001';
    expect(why(f.t, f.ctx)).toMatch(/1 BSV/);
  });
  test('spend above what the sheet shows', () => {
    const f = honestBuy();
    expect(why(f.t, { ...f.ctx, limits: { maxSpendSats: BigInt(1_000_000), minTokens: BigInt(1) } })).toMatch(
      /more than the amount shown/,
    );
  });
  test('unhealthy proof of reserves', () => {
    const f = honestBuy();
    const r = why(f.t, {
      ...f.ctx,
      proof: { healthy: false, why: "Memepool's own check shows this coin's pool holding less than it should." },
    });
    expect(r).toMatch(/holding less/);
  });
  test('tokens created from nothing (conservation)', () => {
    const f = honestBuy();
    const mine = out(f, 'user-token');
    const more = BigInt(mine.amt!) + BigInt(1000);
    mine.script = tok(f.me.ord, more);
    mine.amt = more.toString();
    expect(why(f.t, f.ctx)).toMatch(/appear or vanish/);
  });
  test('a different token id', () => {
    const f = honestBuy();
    const mine = out(f, 'user-token');
    mine.script = bsv21TransferScript(addressPkh(f.me.ord)!, `${'cd'.repeat(32)}_0`, BigInt(mine.amt!));
    expect(why(f.t, f.ctx)).toMatch(/different token/);
  });
  test('non-canonical token script (extra data after the lock)', () => {
    const f = honestBuy();
    out(f, 'user-token').script += '6a00';
    expect(why(f.t, f.ctx)).toMatch(/does not recognise/);
  });
  test('lock time set', () => {
    const f = honestBuy();
    f.t.lockTime = 900000;
    expect(why(f.t, f.ctx)).toMatch(/lock time/);
  });
  test('non-final input sequence', () => {
    const f = honestBuy();
    f.t.inputs[0].seq = 0;
    expect(why(f.t, f.ctx)).toMatch(/not final/);
  });
  test('side and coin mismatch', () => {
    const f = honestBuy();
    expect(why({ ...f.t, side: 'sell' }, f.ctx)).toMatch(/when you asked to buy/);
    expect(why({ ...f.t, tokenId: `${'ef'.repeat(32)}_0` }, f.ctx)).toMatch(/different coin/);
  });
  test('two memos, or a memo carrying sats', () => {
    const f = honestBuy();
    f.t.outputs.push({ script: MEMO, satoshis: 0 });
    expect(why(f.t, f.ctx)).toMatch(/data output/);
    const g = honestBuy();
    out(g, 'memo').satoshis = 10;
    out(g, 'user-change').satoshis -= 10;
    expect(why(g.t, g.ctx)).toMatch(/data output/);
  });
  test('indexer fee too high, or to the wrong address', () => {
    const f = honestBuy();
    out(f, 'index-fee').satoshis = 9000;
    out(f, 'user-change').satoshis -= 7000;
    expect(why(f.t, f.ctx)).toMatch(/indexer fee/);
    const g = honestBuy();
    out(g, 'index-fee').script = pay(STRANGER);
    expect(why(g.t, g.ctx)).toMatch(/does not expect/);
  });
  test('network fee unusually high', () => {
    const f = honestBuy();
    out(f, 'user-change').satoshis -= 10_000;
    expect(why(f.t, f.ctx)).toMatch(/network fee/);
  });
  test('pool output paid to a fake pool', () => {
    const f = honestBuy();
    out(f, 'pool-sats').script = pay(STRANGER);
    expect(why(f.t, f.ctx)).toMatch(/does not expect/);
  });
  test('a bare 1-sat inscription that is not a token', () => {
    const f = honestBuy();
    f.t.outputs.push({ script: `0063036f726451${'00'}68${pay(f.me.ord)}`, satoshis: 1 });
    out(f, 'user-change').satoshis -= 1;
    expect(why(f.t, f.ctx)).toMatch(/does not recognise/);
  });
  test('sell: more tokens leave than asked', () => {
    const f = honestSell();
    const left = out(f, 'user-token');
    const poolT = out(f, 'pool-token');
    left.script = tok(f.me.ord, BigInt(left.amt!) - BigInt(10));
    left.amt = (BigInt(left.amt!) - BigInt(10)).toString();
    poolT.script = tok(POOL_ORD, BigInt(poolT.amt!) + BigInt(10));
    poolT.amt = (BigInt(poolT.amt!) + BigInt(10)).toString();
    expect(why(f.t, f.ctx)).toMatch(/different number of tokens/);
  });
  test('sell: payout below the minimum', () => {
    const f = honestSell();
    const p = out(f, 'user-payout');
    const minSats = Number((f.ctx.limits as { minSats: bigint }).minSats);
    const cut = p.satoshis - minSats + 1;
    p.satoshis -= cut;
    out(f, 'pool-sats').satoshis += cut;
    expect(why(f.t, f.ctx)).not.toBe('');
  });
  test('sell: payout to a stranger instead of our pay address', () => {
    const f = honestSell();
    out(f, 'user-payout').script = pay(STRANGER);
    expect(why(f.t, f.ctx)).toMatch(/does not expect/);
  });
  test('sell: our token coin with a changed amount', () => {
    const f = honestSell();
    f.t.inputs[0].script = tok(f.me.ord, BigInt(7_000_000));
    f.t.inputs[0].amt = '7000000';
    expect(why(f.t, f.ctx)).toMatch(/changed one of your coins/);
  });
  test('the pool coin claimed to hold more tokens than its script says', () => {
    const f = honestBuy();
    f.t.inputs[0].amt = '999999999';
    expect(why(f.t, f.ctx)).toMatch(/mislabelled/);
  });
  test('nothing for us to sign', () => {
    const f = honestBuy();
    f.ctx.me.coins.clear();
    f.t.inputs = f.t.inputs.filter((i) => i.owner !== 'user');
    expect(why(f.t, f.ctx)).not.toBe('');
  });
  test('unreadable templates', () => {
    const f = honestBuy();
    expect(why({ ...f.t, v: 2 }, f.ctx)).toMatch(/can't read/);
    expect(why({ ...f.t, outputs: [] }, f.ctx)).toMatch(/can't read/);
    const g = clone(f.t);
    g.inputs[0].txid = 'zz';
    expect(why(g, f.ctx)).toMatch(/can't read/);
  });
});

test('fixtures are well formed', () => {
  expect(NOW).toBeGreaterThan(0);
  expect(PLATFORM_ADDRESS).toBe('1JhfTxnm8YeYHPdXHFYZFaw2aSQrRtB6aa');
  expect([POOL_PAY, INDEXER, TOKEN].every(Boolean)).toBe(true);
});
