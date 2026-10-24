// "Get your own theme" orders (tier 1, $99 a year). Routed by site/vercel.json:
//   POST /api/theme-orders/upload | quote | claim | mine   → ?op=<op>
// All four are signed by the wallet's identity key (site/lib/themeOrders.js).
// Env (Vercel only): THEME_ORDER_PAY_ADDRESS (empty = 503 not_configured), SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, ARC_URL / ARC_API_KEY (optional).
'use strict';
const { makeThemeOrderHandlers, payAddress, themeOrderStore } = require('../lib/themeOrders');
const { makeThemeBuyHandlers, themeBuyStore } = require('../lib/themeBuys');
const { depositUsd, makeThemeDepositHandlers, themeDepositStore } = require('../lib/themeDeposits');
const { arcBroadcast } = require('../lib/paymailStore');
const { chain } = require('../lib/nameFee');
const { storeKey } = require('../lib/storeReceipt');
const { paidTxidStore } = require('../lib/paidTxids');

// buy-quote / buy-claim / owned: Store theme purchases, $1 each (site/lib/themeBuys.js).
// store-key (GET): the public key Store receipts are signed with (site/lib/storeReceipt.js), null if unsigned.
// deposit-config (GET) / deposit-quote / deposit-claim: branded wallet deposits from the site order form
// (site/lib/themeDeposits.js; closed until THEME_DEPOSIT_USD is set).
const OPS = new Set([
  'upload',
  'quote',
  'claim',
  'mine',
  'buy-quote',
  'buy-claim',
  'owned',
  'store-key',
  'deposit-config',
  'deposit-quote',
  'deposit-claim',
]);
const DEPOSIT = { 'deposit-quote': 'quote', 'deposit-claim': 'claim' };
const BUY = { 'buy-quote': 'quote', 'buy-claim': 'claim', owned: 'owned' };
const hits = new Map();
function limited(ip, max) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const c of req) raw += c;
  if (raw.length > 4_000_000) return null;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

let handlers;
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const op = new URL(req.url, 'http://x').searchParams.get('op') || '';
  if (!OPS.has(op)) return send(res, 404, { error: 'not-found' });
  if (op === 'store-key') return send(res, 200, { signer: storeKey() });
  if (op === 'deposit-config') {
    const usd = depositUsd();
    return send(res, 200, { configured: !!(usd && payAddress()), usd: usd || null });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
  const ip =
    String(req.headers['x-real-ip'] || req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown';
  if (limited(ip, 30)) return send(res, 429, { error: 'rate-limited' });
  if (!handlers) {
    const store = themeOrderStore();
    const buyStore = themeBuyStore();
    const depositStore = themeDepositStore();
    const ledger = paidTxidStore();
    if (!store || !buyStore || !depositStore || !ledger) return send(res, 503, { error: 'not_configured' });
    const deps = { ledger, rate: () => chain.bsvUsd(), broadcast: arcBroadcast() };
    handlers = {
      ...makeThemeOrderHandlers({ store, ...deps }),
      buy: makeThemeBuyHandlers({ store: buyStore, ...deps }),
      deposit: makeThemeDepositHandlers({ store: depositStore, ...deps }),
    };
  }
  const body = await readJson(req);
  if (body === null) return send(res, 400, { error: 'invalid-json' });
  try {
    const [status, out] = DEPOSIT[op]
      ? await handlers.deposit[DEPOSIT[op]](body)
      : BUY[op]
        ? await handlers.buy[BUY[op]](body)
        : await handlers[op](body);
    return send(res, status, out);
  } catch (e) {
    console.error('theme-orders error', op, String(e && e.message ? e.message : e).slice(0, 200));
    return send(res, 500, { error: 'server-error' });
  }
};
