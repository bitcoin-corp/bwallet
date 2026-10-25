// Store theme purchases ($1 each, owner 17 Oct 2026): VexVoid, NPG and NPGX in Store › Themes.
// Routes (site/api/theme-orders.js): buy-quote, buy-claim, owned. Signed by the identity key like the theme
// orders (themeOrders.js), paid to THEME_ORDER_PAY_ADDRESS with an OP_RETURN memo that ties the payment to
// one quote. Table: migrations/20261017_theme_purchases.sql. Env (Vercel only): as themeOrders.js.
'use strict';
const crypto = require('crypto');
const { OP, P2PKH, Script, Utils } = require('@bsv/sdk');
const { parseIncoming, verifySigned } = require('./paymail');
const { checkPayment, payAddress, priceSats, QUOTE_MS, CLAIM_GRACE_MS } = require('./themeOrders');
const { signReceipt } = require('./storeReceipt');

const FEE_ROOM_SATS = 500;

/** Emoji themes (owner 18 Oct 2026, src/mobile/theme/emojiThemes.ts): $1 each, Twemoji art. */
const EMOJI_LABELS = {
  'emoji-frog': 'Frog',
  'emoji-fire': 'Fire',
  'emoji-wave': 'Wave',
  'emoji-blossom': 'Blossom',
  'emoji-spark': 'Spark',
  'emoji-moon': 'Moon',
  'emoji-pizza': 'Pizza',
  'emoji-headphones': 'Headphones',
  'emoji-pup': 'Pup',
  'emoji-rainbow': 'Rainbow',
  'emoji-clover': 'Clover',
  'emoji-cool': 'Cool',
};
/** Packs for sale and their price in USD. Only these can be bought. */
const PACKS = {
  vexvoid: 1,
  npg: 1,
  npgx: 1,
  scammerscartel: 1,
  tokenblaster: 1,
  terrornode: 1,
  ...Object.fromEntries(Object.keys(EMOJI_LABELS).map((id) => [id, 1])),
};
/** Names printed on receipts. */
const PACK_LABELS = {
  vexvoid: 'VexVoid',
  npg: 'NPG',
  npgx: 'NPGX',
  scammerscartel: 'Scammers Cartel',
  tokenblaster: 'TokenBlaster',
  terrornode: 'Assault on Terrornode (TokenBlaster)',
  ...Object.fromEntries(Object.entries(EMOJI_LABELS).map(([id, l]) => [id, `${l} (Emoji)`])),
};
const MEMO_TAG = 'bwx-theme-buy';
const QUOTE_ID_RE = /^[0-9a-f]{32}$/;

/** OP_FALSE OP_RETURN "bwx-theme-buy" <quote_id>. */
const memoScript = (quoteId) =>
  new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray(MEMO_TAG, 'utf8'))
    .writeBin(Utils.toArray(quoteId, 'utf8'));

/** Supabase (PostgREST) store for theme purchases. */
function themeBuyStore(env = process.env, f = fetch) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const q = encodeURIComponent;
  const req = async (path, init = {}) => {
    const r = await f(`${url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`supabase ${r.status}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  return {
    insert: async (row) =>
      (
        await req('theme_purchases', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        })
      )?.[0] ?? null,
    getByQuote: async (quoteId) => (await req(`theme_purchases?quote_id=eq.${q(quoteId)}&limit=1`))?.[0] ?? null,
    getByTxid: async (txid) => (await req(`theme_purchases?txid=eq.${q(txid)}&limit=1`))?.[0] ?? null,
    update: (id, patch) =>
      req(`theme_purchases?id=eq.${q(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      }),
    owned: async (identityKey) =>
      (await req(
        `theme_purchases?identity_key=eq.${q(identityKey)}&status=eq.paid&select=pack_id,txid,paid_at&limit=200`,
      )) || [],
  };
}

/**
 * Handlers: each returns [status, body]. Deps injected so tests run without a network:
 * store (themeBuyStore shape), rate() → USD per BSV, broadcast(tx, beefHex) (throws if rejected), env, now().
 */
function makeThemeBuyHandlers({ store, ledger, rate, broadcast, env = process.env, now = () => Date.now() }) {
  if (!ledger || typeof ledger.reserve !== 'function') throw new Error('paid-txid ledger required');
  const quote = async (body) => {
    const pay = payAddress(env);
    if (!pay) return [503, { error: 'not_configured' }];
    const sigErr = await verifySigned(body || {}, 'theme-buy-quote', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    const packId = String((body.fields || {}).pack || '');
    if (!Object.prototype.hasOwnProperty.call(PACKS, packId)) return [404, { error: 'pack_not_for_sale' }];
    if ((await store.owned(identityKey)).some((r) => r.pack_id === packId)) return [409, { error: 'already_owned' }];
    const r = await Promise.resolve(rate()).catch(() => 0);
    if (!(r > 0)) return [503, { error: 'price_unavailable' }];
    const usd = PACKS[packId];
    // "$1" is the most it costs: leave room for the network fee inside the price, so a wallet holding exactly
    // $1 can buy (owner, 17 Oct 2026: $1 in the wallet, refused 25 sats short). ~500 sats is a hundredth of a cent.
    const sats = Math.max(1, priceSats(r, usd) - FEE_ROOM_SATS);
    const quoteId = crypto.randomBytes(16).toString('hex');
    const memoHex = memoScript(quoteId).toHex();
    const expiresAt = new Date(now() + QUOTE_MS).toISOString();
    await store.insert({
      identity_key: identityKey,
      pack_id: packId,
      status: 'quoted',
      quote_id: quoteId,
      quote_usd: usd,
      quote_sats: sats,
      quote_rate: r,
      quote_address: pay,
      quote_memo_hex: memoHex,
      quote_expires_at: expiresAt,
    });
    // The receipt the buyer's wallet inscribes in the paying transaction (storeReceipt.js).
    const receipt = signReceipt(
      {
        app: 'bwalletx',
        type: 'store-receipt',
        v: 1,
        order: quoteId,
        item: { kind: 'theme', id: packId, label: PACK_LABELS[packId] || packId },
        usd,
        sats,
        seller: pay,
        buyer: identityKey,
        issuedAt: new Date(now()).toISOString(),
      },
      env,
    );
    return [
      200,
      {
        quote_id: quoteId,
        pack: packId,
        receipt,
        outputs: [{ script: new P2PKH().lock(pay).toHex(), satoshis: sats }],
        memo_hex: memoHex,
        usd,
        sats,
        expires_at: expiresAt,
      },
    ];
  };

  const claim = async (body) => {
    const sigErr = await verifySigned(body || {}, 'theme-buy-claim', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    const f = body.fields || {};
    const quoteId = String(f.quote_id || '');
    const txid = String(f.txid || '').toLowerCase();
    if (!QUOTE_ID_RE.test(quoteId)) return [400, { error: 'quote_id' }];
    if (!/^[0-9a-f]{64}$/.test(txid)) return [400, { error: 'txid' }];
    const row = await store.getByQuote(quoteId);
    if (!row || row.identity_key !== identityKey) return [404, { error: 'quote_not_found' }];
    if (row.status !== 'quoted') {
      if (row.txid === txid) return [200, { pack: row.pack_id, txid }]; // a retry of a claim that went through
      return [409, { error: 'quote_used' }];
    }
    if (now() > Date.parse(row.quote_expires_at) + CLAIM_GRACE_MS) return [410, { error: 'quote_expired' }];
    let tx;
    let beefHex = null;
    try {
      ({ tx, beefHex } = parseIncoming(body.rawtx));
    } catch {
      return [400, { error: 'rawtx' }];
    }
    if (tx.id('hex') !== txid) return [400, { error: 'txid_mismatch' }];
    const bad = checkPayment(tx, { address: row.quote_address, sats: row.quote_sats, memoHex: row.quote_memo_hex });
    if (bad) return [402, { error: bad }];
    const other = await store.getByTxid(txid);
    if (other && other.id !== row.id) return [409, { error: 'tx_used' }];
    // One txid, one paid record across orders, purchases and deposits (site/lib/paidTxids.js).
    if ((await ledger.reserve(txid, 'buy', row.id)) !== 'ok') return [409, { error: 'tx_used' }];
    try {
      await broadcast(tx, beefHex);
    } catch {
      return [502, { error: 'broadcast_failed' }];
    }
    await store.update(row.id, { status: 'paid', txid, paid_at: new Date(now()).toISOString() });
    return [200, { pack: row.pack_id, txid }];
  };

  const owned = async (body) => {
    const sigErr = await verifySigned(body || {}, 'theme-buy-owned', now());
    if (sigErr) return [401, { error: sigErr }];
    const rows = await store.owned(String(body.identityKey).toLowerCase());
    return [200, { packs: [...new Set(rows.map((r) => r.pack_id))], configured: !!payAddress(env) }];
  };

  return { quote, claim, owned };
}

module.exports = { PACKS, PACK_LABELS, MEMO_TAG, memoScript, themeBuyStore, makeThemeBuyHandlers };
