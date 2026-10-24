// bWallet paymail (bsvalias) endpoint. Routed by site/vercel.json rewrites:
//   /.well-known/bsvalias                     → ?op=caps
//   /api/paymail/<op>/<handle>[/<pubkey>]     → ?op=<op>&handle=…&pubkey=…
//   /api/paymail/<op>                         → ?op=<op>   (register, lookup, inbox, ack, delete)
// Env: PAYMAIL_DOMAIN (primary, default bwallet-nine.vercel.app), PAYMAIL_DOMAINS (optional,
//      comma-separated extra domains served with the same aliases), PAYMAIL_BASE_URL (optional),
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ARC_URL / ARC_API_KEY (optional).
'use strict';
const { makeHandlers } = require('../lib/paymail');
const { supabaseStore, arcBroadcast } = require('../lib/paymailStore');

const ROUTES = {
  caps: ['GET', 'caps'],
  config: ['GET', 'config'],
  id: ['GET', 'pki'],
  profile: ['GET', 'profile'],
  verify: ['GET', 'verify'],
  ord: ['GET', 'ord'],
  'p2p-destination': ['POST', 'p2pDestination'],
  'receive-tx': ['POST', 'receive'],
  'receive-beef': ['POST', 'receive'],
  register: ['POST', 'register'],
  lookup: ['GET', 'lookup'],
  social: ['GET', 'social'],
  inbox: ['POST', 'inbox'],
  ack: ['POST', 'ack'],
  history: ['POST', 'history'],
  delete: ['POST', 'delete'],
  unlink: ['POST', 'unlink'],
  // Several names per wallet, one main (signed like unlink; tighter rate limit below).
  'names-list': ['POST', 'names-list'],
  'names-add': ['POST', 'names-add'],
  'names-remove': ['POST', 'names-remove'],
  'names-primary': ['POST', 'names-primary'],
  'apps-get': ['POST', 'appsGet'],
  'apps-put': ['POST', 'appsPut'],
  // bPhone (docs/BPHONE-PLAN.md): public rate card + directory, signed writes and bookings.
  'bphone-get': ['GET', 'bphone-get'],
  'bphone-put': ['POST', 'bphone-put'],
  'bphone-directory': ['GET', 'bphone-directory'],
  'bphone-book': ['POST', 'bphone-book'],
  'bphone-bookings': ['POST', 'bphone-bookings'],
  'bphone-book-act': ['POST', 'bphone-book-act'],
  // Settings › Identity › Your name (signed): one display name for every paymail on the key.
  'set-name': ['POST', 'set-name'],
  // Company offers (lib/offerReceipts.js): the company key registers a sealed offer; directors list receipts.
  'offer-register': ['POST', 'offer-register'],
  'offer-receipts': ['POST', 'offer-receipts'],
  // Signed name bindings + public log (docs/NAME-BINDINGS.md).
  bind: ['POST', 'bind'],
  'name-log': ['GET', 'name-log'],
  // Two-party handovers: the owner releases, the recipient accepts; no operator recovery.
  'handover-release': ['POST', 'handover-release'],
  'handover-cancel': ['POST', 'handover-cancel'],
  'handover-accept': ['POST', 'handover-accept'],
  'handovers-for': ['GET', 'handovers-for'],
};

const hits = new Map();
const nameHits = new Map();
function limited(ip, max = 120, map = hits) {
  const now = Date.now();
  const list = (map.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  map.set(ip, list);
  if (map.size > 5000) map.clear();
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
  res.end(JSON.stringify(body));
}

let handlers;
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  const route = ROUTES[q.op || 'caps'];
  if (!route) return send(res, 404, { error: 'not-found' });
  if (req.method !== route[0]) return send(res, 405, { error: 'method-not-allowed' });
  res.setHeader(
    'Cache-Control',
    route[1] === 'caps'
      ? 'public, max-age=300'
      : route[1] === 'bphone-get' || route[1] === 'bphone-directory' || route[1] === 'name-log'
        ? 'public, max-age=30'
        : 'no-store',
  );
  // Vercel sets x-real-ip / x-vercel-forwarded-for; x-forwarded-for's first hop is the client.
  const ip =
    String(req.headers['x-real-ip'] || req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown';
  if (limited(ip)) return send(res, 429, { error: 'rate-limited' });
  if (route[1].startsWith('names-') && limited(ip, 20, nameHits)) return send(res, 429, { error: 'rate-limited' });

  if (!handlers) {
    const store = supabaseStore();
    if (!store && route[1] !== 'caps') return send(res, 503, { error: 'paymail-not-configured' });
    handlers = store ? makeHandlers({ store, broadcast: arcBroadcast() }) : null;
  }
  if (!handlers) return send(res, 200, require('../lib/paymail').capabilities());

  const body = req.method === 'POST' ? await readJson(req) : {};
  if (body === null) return send(res, 400, { error: 'invalid-json' });
  try {
    const [status, out] = await handlers[route[1]](q, body, { ip: ip === 'unknown' ? null : ip });
    return send(res, status, out);
  } catch (e) {
    console.error('paymail error', route[1], String(e && e.message ? e.message : e).slice(0, 200));
    return send(res, 500, { error: 'server-error' });
  }
};
