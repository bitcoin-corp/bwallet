import { describe, expect, test } from 'bun:test';
import { BSV21, OrdLockV2 } from '@1sat/templates';
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { buildListingScript } from '../sell/sell';
import { TradeCheckError, verifyCancelArgs, verifyListingArgs, verifyPurchaseArgs, type ArgOutput } from './verify';
import { fundFeeSats, parseFund } from './fundFee';
import { checkedContext } from './checkedWallet';

const ID = 'd5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1';
const OTHER = 'aa'.repeat(32) + '_0';
const addr = () => PrivateKey.fromRandom().toAddress();
const ME = addr();
const SELLER = addr();
const CANCEL = addr();
const FEE = addr();
const FUND = '1DkrzJo487E8LLLupts9iJhK2pAvKPJTLe';
const BASKET = 'bsv21';
const tokenOut = (id: string, amt: bigint, to: string, basket?: string): ArgOutput => ({
  lockingScript: BSV21.transfer(id, amt).lock(new P2PKH().lock(to)).toHex(),
  satoshis: 1,
  basket,
});
const pay = (to: string, sats: number): ArgOutput => ({ lockingScript: new P2PKH().lock(to).toHex(), satoshis: sats });
const bad = (fn: () => void) => expect(fn).toThrow(TradeCheckError);

describe('listing', () => {
  const script = buildListingScript(ID, 100n, CANCEL, ME, 5000).toHex();
  const e = {
    tokenId: ID,
    amount: 100n,
    listingScript: script,
    basket: BASKET,
    ownOutpoints: new Set(['ab'.repeat(32) + '.0']),
    feeAddress: FEE,
    maxOverlayFee: 2000,
  };
  const good = {
    inputs: [{ outpoint: 'ab'.repeat(32) + '.0' }],
    outputs: [{ lockingScript: script, satoshis: 1 }, tokenOut(ID, 50n, ME, BASKET), pay(FEE, 2000)],
  };
  test('accepts the listing we built', () => verifyListingArgs(good, e));
  test('lots: N identical listings', () =>
    verifyListingArgs({ ...good, outputs: [good.outputs[0], good.outputs[0], pay(FEE, 2000)] }, { ...e, count: 2 }));
  test('rejects a foreign input', () =>
    bad(() => verifyListingArgs({ ...good, inputs: [{ outpoint: 'cd'.repeat(32) + '.1' }] }, e)));
  test('rejects a different listing (price/payout swapped)', () => {
    const other = buildListingScript(ID, 100n, CANCEL, SELLER, 5000).toHex();
    bad(() => verifyListingArgs({ ...good, outputs: [{ lockingScript: other, satoshis: 1 }] }, e));
  });
  test('rejects token change leaving the wallet', () =>
    bad(() => verifyListingArgs({ ...good, outputs: [good.outputs[0], tokenOut(ID, 50n, SELLER)] }, e)));
  test('rejects another token', () =>
    bad(() => verifyListingArgs({ ...good, outputs: [good.outputs[0], tokenOut(OTHER, 5n, ME, BASKET)] }, e)));
  test('rejects a payment to someone else', () =>
    bad(() => verifyListingArgs({ ...good, outputs: [good.outputs[0], pay(SELLER, 10)] }, e)));
  test('rejects an overlay fee above the sheet', () =>
    bad(() => verifyListingArgs({ ...good, outputs: [good.outputs[0], pay(FEE, 3000)] }, e)));
});

describe('purchase', () => {
  const price = 10_000;
  const listingScript = BSV21.transfer(ID, 100n).lock(new LockingScript(OrdLockV2.lock(CANCEL, SELLER, price).chunks));
  const src = new Transaction();
  src.addOutput({ lockingScript: listingScript, satoshis: 1 });
  const txid = src.id('hex');
  const beef = new Beef();
  beef.mergeTransaction(src);
  const inputBEEF = beef.toBinary();
  const receive = tokenOut(ID, 100n, ME, BASKET);
  const fundSats = fundFeeSats(price);
  const e = {
    tokenId: ID,
    outpoint: `${txid}.0`,
    amount: 100n,
    priceSats: price,
    receiveScript: receive.lockingScript,
    basket: BASKET,
    marketFee: { address: FUND, sats: fundSats, required: true },
    feeAddress: FEE,
    maxOverlayFee: 1000,
  };
  const good = {
    inputs: [{ outpoint: `${txid}.0` }],
    inputBEEF,
    outputs: [receive, pay(SELLER, price), pay(FUND, fundSats), pay(FEE, 1000)],
  };
  test('accepts the exact purchase', () => verifyPurchaseArgs(good, e));
  test('fund fee is 5% rounded up, min 1', () => {
    expect(fundFeeSats(10_000)).toBe(500);
    expect(fundFeeSats(21)).toBe(2);
    expect(fundFeeSats(1)).toBe(1);
  });
  test('rejects a wrong seller output', () =>
    bad(() => verifyPurchaseArgs({ ...good, outputs: [receive, pay(addr(), price), pay(FUND, fundSats)] }, e)));
  test('rejects underpaying the seller', () =>
    bad(() => verifyPurchaseArgs({ ...good, outputs: [receive, pay(SELLER, price - 1), pay(FUND, fundSats)] }, e)));
  test('rejects a price different from the sheet', () =>
    bad(() => verifyPurchaseArgs(good, { ...e, priceSats: 9000 })));
  test('rejects a wrong token amount', () => bad(() => verifyPurchaseArgs(good, { ...e, amount: 99n })));
  test('rejects tokens sent elsewhere', () =>
    bad(() =>
      verifyPurchaseArgs(
        { ...good, outputs: [tokenOut(ID, 100n, SELLER), pay(SELLER, price), pay(FUND, fundSats)] },
        e,
      ),
    ));
  test('rejects a foreign extra input', () =>
    bad(() => verifyPurchaseArgs({ ...good, inputs: [...good.inputs, { outpoint: 'cd'.repeat(32) + '.0' }] }, e)));
  test('rejects a missing fund fee', () =>
    bad(() => verifyPurchaseArgs({ ...good, outputs: [receive, pay(SELLER, price)] }, e)));
  test('rejects an extra payout', () =>
    bad(() => verifyPurchaseArgs({ ...good, outputs: [...good.outputs, pay(addr(), 5)] }, e)));
  test('rejects a different token in the listing', () => bad(() => verifyPurchaseArgs(good, { ...e, tokenId: OTHER })));
});

describe('cancel', () => {
  const back = tokenOut(ID, 100n, ME, BASKET);
  const e = {
    tokenId: ID,
    outpoint: 'ab'.repeat(32) + '_0',
    amount: 100n,
    backScript: back.lockingScript,
    basket: BASKET,
    feeAddress: FEE,
    maxOverlayFee: 1000,
  };
  const good = { inputs: [{ outpoint: 'ab'.repeat(32) + '.0' }], outputs: [back, pay(FEE, 1000)] };
  test('accepts', () => verifyCancelArgs(good, e));
  test('rejects a foreign input', () =>
    bad(() => verifyCancelArgs({ ...good, inputs: [...good.inputs, { outpoint: 'cd'.repeat(32) + '.0' }] }, e)));
  test('rejects tokens going elsewhere', () =>
    bad(() => verifyCancelArgs({ ...good, outputs: [tokenOut(ID, 100n, SELLER)] }, e)));
  test('rejects a payout to someone', () =>
    bad(() => verifyCancelArgs({ ...good, outputs: [back, pay(SELLER, 1)] }, e)));
});

describe('fund', () => {
  test('accepts the known TERRORNODE fund', () =>
    expect(parseFund(ID, { fundAddress: FUND, fundBalance: 50_000 })).toEqual({
      address: FUND,
      balance: 50_000,
      low: true,
    }));
  test('refuses a different address for a known token', () =>
    expect(parseFund(ID, { fundAddress: addr(), fundBalance: 1 })).toBeNull());
  test('refuses garbage', () => expect(parseFund(ID, { nope: 1 })).toBeNull());
});

describe('checkedContext', () => {
  test('a failed check never reaches the wallet', async () => {
    let called = false;
    const ctx = checkedContext(
      { wallet: { createAction: async () => ((called = true), {}) } },
      () => {
        throw new TradeCheckError('x');
      },
      async () => undefined,
    );
    await expect(ctx.wallet.createAction({} as never)).rejects.toThrow(TradeCheckError);
    expect(called).toBe(false);
  });
  test('spending pause stops it', async () => {
    let called = false;
    const ctx = checkedContext(
      { wallet: { createAction: async () => ((called = true), {}) } },
      () => undefined,
      async () => {
        throw new Error('paused');
      },
    );
    await expect(ctx.wallet.createAction({} as never)).rejects.toThrow('paused');
    expect(called).toBe(false);
  });
});
