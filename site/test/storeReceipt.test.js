import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import ptx from '../lib/paidTxids.js';
import tb from '../lib/themeBuys.js';
import sr from '../lib/storeReceipt.js';

const NOW = 1_800_000_000_000;
const PAY = new PrivateKey(7).toPublicKey().toAddress();
const STORE_WIF = new PrivateKey(99).toWif();

const quoteFor = async (env) => {
  const priv = new PrivateKey(42);
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const fields = { pack: 'npg' };
  const all = { ...fields, identityKey, timestamp: String(NOW) };
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(pm.signedMessage('theme-buy-quote', all), 'utf8'),
    protocolID: pm.SIGN_PROTOCOL,
    keyID: pm.SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  const rows = [];
  const h = tb.makeThemeBuyHandlers({
    ledger: ptx.memoryPaidTxids(),
    store: {
      insert: async (r) => (rows.push({ id: 'a', ...r }), rows[0]),
      owned: async () => [],
      getByQuote: async (q) => rows.find((r) => r.quote_id === q) ?? null,
      getByTxid: async () => null,
      update: async (id, p) => Object.assign(rows[0], p),
    },
    rate: async () => 50,
    broadcast: async () => {},
    env,
    now: () => NOW,
  });
  const [status, q] = await h.quote({ identityKey, timestamp: NOW, fields, signature: Utils.toHex(signature) });
  return { status, q, identityKey, h, wallet, priv };
};

describe('store receipts', () => {
  test('canonical JSON sorts keys at every level and drops undefined', () => {
    expect(sr.canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  test('the quote carries a receipt signed by the Store key, naming the order, pack, price, seller and buyer', async () => {
    const { status, q, identityKey } = await quoteFor({ THEME_ORDER_PAY_ADDRESS: PAY, STORE_RECEIPT_WIF: STORE_WIF });
    expect(status).toBe(200);
    const r = q.receipt;
    expect(r).toMatchObject({
      app: 'bwalletx',
      type: 'store-receipt',
      v: 1,
      order: q.quote_id,
      item: { kind: 'theme', id: 'npg', label: 'NPG' },
      usd: 1,
      sats: q.sats,
      seller: PAY,
      buyer: identityKey,
      issuedAt: new Date(NOW).toISOString(),
      signer: new PrivateKey(99).toPublicKey().toString(),
    });
    expect(sr.verifyReceipt(r)).toBe(true);
    expect(sr.storeKey({ STORE_RECEIPT_WIF: STORE_WIF })).toBe(r.signer);
  });

  test('any change to a signed receipt breaks the signature', async () => {
    const { q } = await quoteFor({ THEME_ORDER_PAY_ADDRESS: PAY, STORE_RECEIPT_WIF: STORE_WIF });
    expect(sr.verifyReceipt({ ...q.receipt, sats: q.receipt.sats + 1 })).toBe(false);
    expect(sr.verifyReceipt({ ...q.receipt, item: { ...q.receipt.item, label: 'NPGX' } })).toBe(false);
    const other = new PrivateKey(5);
    expect(sr.verifyReceipt({ ...q.receipt, signer: other.toPublicKey().toString() })).toBe(false);
  });

  test('without STORE_RECEIPT_WIF the receipt is issued unsigned (never a fake signature)', async () => {
    const { q } = await quoteFor({ THEME_ORDER_PAY_ADDRESS: PAY });
    expect(q.receipt.sig).toBeUndefined();
    expect(q.receipt.signer).toBeUndefined();
    expect(sr.verifyReceipt(q.receipt)).toBe(false);
    expect(sr.storeKey({})).toBeNull();
  });

  test('a payment that also carries the 1-sat receipt inscription is still accepted', async () => {
    const { q, h, wallet, identityKey } = await quoteFor({
      THEME_ORDER_PAY_ADDRESS: PAY,
      STORE_RECEIPT_WIF: STORE_WIF,
    });
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(PAY), satoshis: q.sats });
    tx.addOutput({ lockingScript: Script.fromHex(q.memo_hex), satoshis: 0 });
    tx.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(3).toPublicKey().toAddress()), satoshis: 1 });
    const fields = { quote_id: q.quote_id, txid: tx.id('hex') };
    const all = { ...fields, identityKey, timestamp: String(NOW) };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage('theme-buy-claim', all), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    const [status, out] = await h.claim({
      identityKey,
      timestamp: NOW,
      fields,
      signature: Utils.toHex(signature),
      rawtx: tx.toHex(),
    });
    expect(status).toBe(200);
    expect(out.pack).toBe('npg');
  });
});
