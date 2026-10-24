import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import ptx from '../lib/paidTxids.js';
import tb from '../lib/themeBuys.js';

const NOW = 1_800_000_000_000;
const PAY = new PrivateKey(7).toPublicKey().toAddress();

const user = (n = 42) => {
  const priv = new PrivateKey(n);
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields = {}, extra = {}) => {
    const all = { ...fields, identityKey, timestamp: String(NOW) };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage(action, all), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return { identityKey, timestamp: NOW, fields, signature: Utils.toHex(signature), ...extra };
  };
  return { identityKey, sign };
};

const memStore = () => {
  const rows = [];
  return {
    rows,
    insert: async (r) => (rows.push({ id: `id${rows.length}`, ...r }), rows.at(-1)),
    getByQuote: async (q) => rows.find((r) => r.quote_id === q) ?? null,
    getByTxid: async (t) => rows.find((r) => r.txid === t) ?? null,
    update: async (id, p) =>
      Object.assign(
        rows.find((r) => r.id === id),
        p,
      ),
    owned: async (k) => rows.filter((r) => r.identity_key === k && r.status === 'paid'),
  };
};

const setup = (env = { THEME_ORDER_PAY_ADDRESS: PAY }) => {
  const store = memStore();
  const broadcasts = [];
  const h = tb.makeThemeBuyHandlers({
    store,
    ledger: ptx.memoryPaidTxids(),
    rate: async () => 50,
    broadcast: async (tx) => broadcasts.push(tx.id('hex')),
    env,
    now: () => NOW,
  });
  return { store, h, broadcasts };
};

const payTx = (q, { sats = q.sats, memo = q.memo_hex, to: addr = PAY } = {}) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: sats });
  if (memo) tx.addOutput({ lockingScript: Script.fromHex(memo), satoshis: 0 });
  return tx;
};

const claimBody = (u, q, tx) =>
  u.sign('theme-buy-claim', { quote_id: q.quote_id, txid: tx.id('hex') }, { rawtx: tx.toHex() });

describe('theme buys', () => {
  test('503 not_configured without a pay address (no fake payment)', async () => {
    const { h } = setup({});
    const u = user();
    expect(await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' }))).toEqual([
      503,
      { error: 'not_configured' },
    ]);
  });

  test('only the listed packs are for sale, at $1', async () => {
    const { h } = setup();
    const u = user();
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'gold' })))[0]).toBe(404);
    const [s, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npgx' }));
    expect(s).toBe(200);
    expect(q.usd).toBe(1);
    expect(q.sats).toBe(2_000_000 - 500); // $1 at $50/BSV, less room for the network fee
  });

  test('a matching payment is broadcast and the pack is owned; a retry is idempotent', async () => {
    const { h, broadcasts } = setup();
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' }));
    const tx = payTx(q);
    expect(await h.claim(await claimBody(u, q, tx))).toEqual([200, { pack: 'vexvoid', txid: tx.id('hex') }]);
    expect(broadcasts).toEqual([tx.id('hex')]);
    expect((await h.claim(await claimBody(u, q, tx)))[0]).toBe(200);
    expect(broadcasts.length).toBe(1);
    const [, o] = await h.owned(await u.sign('theme-buy-owned'));
    expect(o.packs).toEqual(['vexvoid']);
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' })))[1]).toEqual({
      error: 'already_owned',
    });
  });

  test('underpaid, wrong address or missing memo: nothing recorded, nothing broadcast', async () => {
    const { h, broadcasts } = setup();
    const u = user();
    for (const bad of [{ sats: 1 }, { to: new PrivateKey(9).toPublicKey().toAddress() }, { memo: null }]) {
      const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
      const [s] = await h.claim(await claimBody(u, q, payTx(q, bad)));
      expect(s).toBe(402);
    }
    expect(broadcasts).toEqual([]);
    expect((await h.owned(await u.sign('theme-buy-owned')))[1].packs).toEqual([]);
  });

  test("someone else's quote is not found", async () => {
    const { h } = setup();
    const a = user(1);
    const b = user(2);
    const [, q] = await h.quote(await a.sign('theme-buy-quote', { pack: 'npg' }));
    expect((await h.claim(await claimBody(b, q, payTx(q))))[0]).toBe(404);
  });
});
