import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import ptx from '../lib/paidTxids.js';
import td from '../lib/themeDeposits.js';

const NOW = 1_800_000_000_000;
const PAY = new PrivateKey(7).toPublicKey().toAddress();
const ENV = { THEME_ORDER_PAY_ADDRESS: PAY, THEME_DEPOSIT_USD: '250' };

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
    events: [],
    insertDeposit: async (r) => (rows.push({ id: `d${rows.length}`, ...r }), rows.at(-1)),
    getByQuote: async (q) => rows.find((r) => r.quote_id === q) ?? null,
    getByTxid: async (t) => rows.find((r) => r.txid === t) ?? null,
    updateDeposit: async (id, p) =>
      Object.assign(
        rows.find((r) => r.id === id),
        p,
      ),
    notify: async function (kind, payload) {
      this.events.push({ kind, payload });
    },
  };
};

const setup = (env = ENV, ledger = ptx.memoryPaidTxids()) => {
  const store = memStore();
  const broadcasts = [];
  const h = td.makeThemeDepositHandlers({
    store,
    ledger,
    rate: async () => 50,
    broadcast: async (tx) => broadcasts.push(tx.id('hex')),
    env,
    now: () => NOW,
  });
  return { store, h, broadcasts };
};

const brief = (over = {}) => ({
  tier: 'branded',
  brand: 'Frog Coin',
  contact: 'team@frog.example.com',
  link: 'https://frog.example.com',
  logo: 'https://frog.example.com/logo.png',
  colours: JSON.stringify(['#7FD14A', '#0b2e12']),
  note: 'A frog wallet for our holders.',
  ...over,
});

describe('validateBrief', () => {
  test('accepts a full brief and lowercases colours', () => {
    const v = td.validateBrief(brief());
    expect(v.ok).toBe(true);
    expect(v.brief.colours).toEqual(['#7fd14a', '#0b2e12']);
    expect(v.brief.links).toEqual(['https://frog.example.com/', 'https://frog.example.com/logo.png']);
  });
  test('handles as contact, optional fields', () => {
    expect(td.validateBrief(brief({ contact: '$frog', link: '', logo: '', colours: '', note: '' })).ok).toBe(true);
    expect(td.validateBrief(brief({ contact: 'frog@bwalletx.com' })).ok).toBe(true);
  });
  test('rejects bad input', () => {
    expect(td.validateBrief(brief({ tier: 'theme' })).ok).toBe(false);
    expect(td.validateBrief(brief({ brand: 'x' })).ok).toBe(false);
    expect(td.validateBrief(brief({ contact: 'not an email' })).ok).toBe(false);
    expect(td.validateBrief(brief({ link: 'http://127.0.0.1' })).ok).toBe(false);
    expect(td.validateBrief(brief({ colours: '["red"]' })).ok).toBe(false);
    expect(td.validateBrief(brief({ note: 'x'.repeat(1100) })).ok).toBe(false);
  });
});

describe('deposits', () => {
  test('closed without THEME_DEPOSIT_USD or a pay address', async () => {
    const u = user();
    expect(
      (await setup({ THEME_ORDER_PAY_ADDRESS: PAY }).h.quote(await u.sign('theme-deposit-quote', brief())))[0],
    ).toBe(503);
    expect((await setup({ THEME_DEPOSIT_USD: '250' }).h.quote(await u.sign('theme-deposit-quote', brief())))[0]).toBe(
      503,
    );
    expect(await setup({ THEME_ORDER_PAY_ADDRESS: PAY }).h.config()).toEqual([200, { configured: false, usd: null }]);
    expect(await setup().h.config()).toEqual([200, { configured: true, usd: 250 }]);
    expect(td.depositUsd({ THEME_DEPOSIT_USD: '12.5' })).toBe(0);
  });

  test('quote → pay → claim records the deposit and broadcasts', async () => {
    const u = user();
    const { h, store, broadcasts } = setup();
    const [s, q] = await h.quote(await u.sign('theme-deposit-quote', brief()));
    expect(s).toBe(200);
    expect(q.usd).toBe(250);
    expect(q.sats).toBe(500_000_000);
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new P2PKH().lock(PAY), satoshis: q.sats });
    tx.addOutput({ lockingScript: Script.fromHex(td.memoScript(q.quote_id).toHex()), satoshis: 0 });
    const txid = tx.id('hex');
    const [cs, out] = await h.claim(
      await u.sign('theme-deposit-claim', { quote_id: q.quote_id, txid }, { rawtx: tx.toHex() }),
    );
    expect(cs).toBe(200);
    expect(out.deposit.status).toBe('paid');
    expect(broadcasts).toEqual([txid]);
    expect(store.events[0].kind).toBe('theme_deposit_paid');
    // a retry of the same claim is fine
    expect(
      (await h.claim(await u.sign('theme-deposit-claim', { quote_id: q.quote_id, txid }, { rawtx: tx.toHex() })))[0],
    ).toBe(200);
  });

  test('underpaid, wrong memo, other payer and bad signatures are refused', async () => {
    const u = user();
    const { h, broadcasts } = setup();
    const [, q] = await h.quote(await u.sign('theme-deposit-quote', brief()));
    const under = new Transaction();
    under.addOutput({ lockingScript: new P2PKH().lock(PAY), satoshis: q.sats - 1 });
    under.addOutput({ lockingScript: Script.fromHex(td.memoScript(q.quote_id).toHex()), satoshis: 0 });
    const c1 = await h.claim(
      await u.sign('theme-deposit-claim', { quote_id: q.quote_id, txid: under.id('hex') }, { rawtx: under.toHex() }),
    );
    expect(c1).toEqual([402, { error: 'underpaid' }]);
    const nomemo = new Transaction();
    nomemo.addOutput({ lockingScript: new P2PKH().lock(PAY), satoshis: q.sats });
    nomemo.addOutput({ lockingScript: Script.fromHex(td.memoScript('0'.repeat(32)).toHex()), satoshis: 0 });
    const c2 = await h.claim(
      await u.sign('theme-deposit-claim', { quote_id: q.quote_id, txid: nomemo.id('hex') }, { rawtx: nomemo.toHex() }),
    );
    expect(c2).toEqual([402, { error: 'memo_missing' }]);
    const other = user(43);
    const c3 = await h.claim(
      await other.sign(
        'theme-deposit-claim',
        { quote_id: q.quote_id, txid: nomemo.id('hex') },
        { rawtx: nomemo.toHex() },
      ),
    );
    expect(c3[0]).toBe(404);
    const forged = await u.sign('theme-deposit-quote', brief());
    forged.fields = brief({ brand: 'Someone Else' });
    expect((await h.quote(forged))[0]).toBe(401);
    // a theme-order signature can't be replayed as a deposit
    expect((await h.quote(await u.sign('theme-orders-quote', brief())))[0]).toBe(401);
    expect(broadcasts).toEqual([]);
  });
});

describe('one payment, one paid record (shared pay address)', () => {
  const payFor = (q, { sats = q.sats, extraMemo = null } = {}) => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new P2PKH().lock(PAY), satoshis: sats });
    tx.addOutput({ lockingScript: Script.fromHex(td.memoScript(q.quote_id).toHex()), satoshis: 0 });
    if (extraMemo) tx.addOutput({ lockingScript: Script.fromHex(extraMemo), satoshis: 0 });
    return tx;
  };
  const claim = async (h, u, q, tx) =>
    h.claim(await u.sign('theme-deposit-claim', { quote_id: q.quote_id, txid: tx.id('hex') }, { rawtx: tx.toHex() }));

  test('a txid already recorded by an order or a purchase is refused, nothing broadcast', async () => {
    const ledger = ptx.memoryPaidTxids();
    const u = user();
    const { h, broadcasts, store } = setup(ENV, ledger);
    const [, q] = await h.quote(await u.sign('theme-deposit-quote', brief()));
    const tx = payFor(q);
    expect(await ledger.reserve(tx.id('hex'), 'buy', 'p0')).toBe('ok');
    expect(await claim(h, u, q, tx)).toEqual([409, { error: 'tx_used' }]);
    expect(broadcasts).toEqual([]);
    expect(store.rows[0].status).toBe('quoted');
  });

  test('a tx carrying a second memo, or paying a different amount, is refused', async () => {
    const u = user();
    const { h, broadcasts } = setup();
    const [, q] = await h.quote(await u.sign('theme-deposit-quote', brief()));
    const otherMemo = td.memoScript('f'.repeat(32)).toHex();
    expect(await claim(h, u, q, payFor(q, { extraMemo: otherMemo }))).toEqual([402, { error: 'extra_memo' }]);
    expect(await claim(h, u, q, payFor(q, { sats: q.sats + 1 }))).toEqual([402, { error: 'amount_mismatch' }]);
    expect(broadcasts).toEqual([]);
  });

  test('the ledger lets the same kind + row retry and refuses everyone else', async () => {
    const l = ptx.memoryPaidTxids();
    const t = 'a'.repeat(64);
    expect(await l.reserve(t, 'order', 'o1')).toBe('ok');
    expect(await l.reserve(t, 'order', 'o1')).toBe('ok');
    expect(await l.reserve(t, 'order', 'o2')).toBe('used');
    expect(await l.reserve(t, 'deposit', 'o1')).toBe('used');
    expect(await l.reserve(t, 'buy', 'b1')).toBe('used');
  });
});
