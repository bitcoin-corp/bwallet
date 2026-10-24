// Branded wallet deposits (bwalletx.com/themes/custom/orderform): a brand sends its brief and pays a deposit
// for a Branded edition (from $999) or a Native app (by quote). Same quote → one approval → claim flow and the
// same pay address as theme orders (themeOrders.js): the site signs with the visitor's BRC-100 wallet (Sign in
// with bWalletX), the claim checks the outputs + memo, then broadcasts. Nothing is recorded as paid unless the
// tx is accepted.
// Env (Vercel only, never in git): THEME_ORDER_PAY_ADDRESS (shared with theme orders) and THEME_DEPOSIT_USD
// (the deposit in whole US dollars; empty = deposits closed: 503 not_configured). Table: migrations/20261018_theme_deposits.sql.
'use strict';
const crypto = require('crypto');
const { OP, Script, Utils, P2PKH } = require('@bsv/sdk');
const { parseIncoming, verifySigned } = require('./paymail');
const { checkPayment, payAddress, priceSats, publicUrl } = require('./themeOrders');

const MEMO_TAG = 'bwx-theme-deposit';
const QUOTE_MS = 15 * 60 * 1000;
const CLAIM_GRACE_MS = 24 * 60 * 60 * 1000;
const TIERS = new Set(['branded', 'native']);
const HEX_COLOUR_RE = /^#[0-9a-f]{6}$/;
const QUOTE_ID_RE = /^[0-9a-f]{32}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const HANDLE_RE = /^[@$]?[a-z0-9_.-]{2,40}(@[a-z0-9.-]+\.[a-z]{2,24})?$/i;
const MAX_DEPOSIT_USD = 10000;

const clean = (v, max) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

/** The deposit in USD from THEME_DEPOSIT_USD, or 0 when deposits are closed. */
function depositUsd(env = process.env) {
  const n = Number(String(env.THEME_DEPOSIT_USD || '').trim());
  return Number.isInteger(n) && n > 0 && n <= MAX_DEPOSIT_USD ? n : 0;
}

/** The brief (signed `fields`, all strings). Returns { ok: true, brief } or { ok: false, error }. */
function validateBrief(fields) {
  const f = fields || {};
  const tier = clean(f.tier, 20).toLowerCase();
  if (!TIERS.has(tier)) return { ok: false, error: 'tier: branded or native' };
  const brand = clean(f.brand, 80);
  if (brand.length < 2 || brand.length > 60) return { ok: false, error: 'brand: 2–60 characters' };
  const contact = clean(f.contact, 200);
  if (!EMAIL_RE.test(contact) && !HANDLE_RE.test(contact))
    return { ok: false, error: 'contact: an email address or a handle' };
  const link = f.link ? publicUrl(f.link) : null;
  if (f.link && !link) return { ok: false, error: 'link: an https:// website or social link' };
  const logo = f.logo ? publicUrl(f.logo) : null;
  if (f.logo && !logo) return { ok: false, error: 'logo: an https:// link to your logo' };
  let colours = [];
  if (f.colours) {
    try {
      colours = JSON.parse(f.colours);
    } catch {
      colours = null;
    }
    if (
      !Array.isArray(colours) ||
      colours.length > 3 ||
      !colours.every((c) => typeof c === 'string' && HEX_COLOUR_RE.test(c.toLowerCase()))
    )
      return { ok: false, error: 'colours: up to 3 colours' };
  }
  const note = clean(f.note, 1200);
  if (note.length > 1000) return { ok: false, error: 'note: 1000 characters max' };
  return {
    ok: true,
    brief: {
      tier,
      brand,
      contact,
      links: [link, logo].filter(Boolean),
      logo,
      colours: colours.map((c) => c.toLowerCase()),
      note: note || null,
    },
  };
}

/** OP_FALSE OP_RETURN "bwx-theme-deposit" <quote_id>. */
const memoScript = (quoteId) =>
  new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray(MEMO_TAG, 'utf8'))
    .writeBin(Utils.toArray(quoteId, 'utf8'));

/** Supabase store for deposits (PostgREST). */
function themeDepositStore(env = process.env, f = fetch) {
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
    insertDeposit: async (row) =>
      (
        await req('theme_deposits', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        })
      )?.[0] ?? null,
    getByQuote: async (quoteId) => (await req(`theme_deposits?quote_id=eq.${q(quoteId)}&limit=1`))?.[0] ?? null,
    getByTxid: async (txid) => (await req(`theme_deposits?txid=eq.${q(txid)}&limit=1`))?.[0] ?? null,
    updateDeposit: (id, patch) =>
      req(`theme_deposits?id=eq.${q(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      }),
    notify: async (kind, payload) => {
      console.log(`[ops] ${kind}`, JSON.stringify(payload).slice(0, 500));
      try {
        await req('bwallet_ops_events', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ kind, payload }),
        });
      } catch {
        /* logged above */
      }
    },
  };
}

const publicRow = (r) => ({
  id: r.id,
  tier: r.tier,
  brand: r.brand,
  status: r.status,
  usd: r.quote_usd,
  txid: r.txid ?? null,
  paid_at: r.paid_at ?? null,
});

/** Handlers return [status, body]. Deps injected for tests: store, rate() USD per BSV, broadcast(tx, beefHex), env, now(). */
function makeThemeDepositHandlers({ store, ledger, rate, broadcast, env = process.env, now = () => Date.now() }) {
  if (!ledger || typeof ledger.reserve !== 'function') throw new Error('paid-txid ledger required');
  const config = async () => {
    const usd = depositUsd(env);
    return [200, { configured: !!(usd && payAddress(env)), usd: usd || null }];
  };

  const quote = async (body) => {
    const pay = payAddress(env);
    const usd = depositUsd(env);
    if (!pay || !usd) return [503, { error: 'not_configured' }];
    const sigErr = await verifySigned(body || {}, 'theme-deposit-quote', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    const v = validateBrief(body.fields);
    if (!v.ok) return [400, { error: v.error }];
    const r = await Promise.resolve(rate()).catch(() => 0);
    if (!(r > 0)) return [503, { error: 'price_unavailable' }];
    const sats = priceSats(r, usd);
    const quoteId = crypto.randomBytes(16).toString('hex');
    const memoHex = memoScript(quoteId).toHex();
    const expiresAt = new Date(now() + QUOTE_MS).toISOString();
    await store.insertDeposit({
      ...v.brief,
      identity_key: identityKey,
      status: 'quoted',
      quote_id: quoteId,
      quote_usd: usd,
      quote_sats: sats,
      quote_rate: r,
      quote_address: pay,
      quote_memo_hex: memoHex,
      quote_expires_at: expiresAt,
    });
    return [
      200,
      {
        quote_id: quoteId,
        outputs: [{ script: new P2PKH().lock(pay).toHex(), satoshis: sats }],
        memo_hex: memoHex,
        usd,
        sats,
        expires_at: expiresAt,
      },
    ];
  };

  const claim = async (body) => {
    const sigErr = await verifySigned(body || {}, 'theme-deposit-claim', now());
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
      if (row.txid === txid) return [200, { deposit: publicRow(row) }];
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
    if ((await ledger.reserve(txid, 'deposit', row.id)) !== 'ok') return [409, { error: 'tx_used' }];
    try {
      await broadcast(tx, beefHex);
    } catch {
      return [502, { error: 'broadcast_failed' }];
    }
    const patch = { status: 'paid', txid, paid_at: new Date(now()).toISOString() };
    await store.updateDeposit(row.id, patch);
    await store.notify('theme_deposit_paid', {
      id: row.id,
      tier: row.tier,
      brand: row.brand,
      contact: row.contact,
      usd: row.quote_usd,
      sats: row.quote_sats,
      txid,
    });
    return [200, { deposit: publicRow({ ...row, ...patch }) }];
  };

  return { config, quote, claim };
}

module.exports = { MEMO_TAG, depositUsd, validateBrief, memoScript, themeDepositStore, makeThemeDepositHandlers };
