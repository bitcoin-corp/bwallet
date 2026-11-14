// Exchange › Contracts catalogue (lib/contracts.js; chain checks shared with strategies in lib/strategyKeys.js).
//   GET  /api/contracts                    → { contracts: [{ origin, envelope, sold, createdAt }] }
//   GET  /api/contracts?origin=<origin>    → { contract: { origin, envelope, sold, createdAt } }
//   POST { action:'publish', outpoint, message, pubkey_hex, signature }   the author's freshly minted copy
//        A paid contract must be signed by its author (lib/contracts.js envelopeRefusal), and a contract listed
//        earlier on chain by another author is refused (servedListings).
//   POST { action:'claim',   outpoint, message, pubkey_hex, signature }   a buyer's copy: checked as paid, counted
// Contracts are public (not encrypted): the catalogue only vouches that a copy is genuine and paid for.
// GET and claim serve only listings servedListings keeps: an older paid listing that isn't signed by its author, or a
// later copy of an earlier author's contract, is never shown or counted (fail closed).
// Env (Vercel only): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
const K = require('../lib/strategyKeys');
const { CONTRACT_TYPE, envelopeRefusal, judgeListings, parseContractEnvelope } = require('../lib/contracts');

const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 30;
}
const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};
async function db(path, init = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('unconfigured');
  return fetch(`${base.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}
const rows = async (path) => {
  const r = await db(path);
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.json();
};
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const c of req) raw += c;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}
const at = (origin) => K.envelopeAt(origin, K.chain, CONTRACT_TYPE, parseContractEnvelope);

// Where each origin sits on chain (K.chain.position), asked only when listings of one contract disagree about the
// author. A confirmed position never changes and is kept; "unconfirmed" is asked again after a minute; a lookup that
// failed throws and is never kept as a position.
const positions = new Map();
async function position(origin) {
  const txid = String(origin).split('_')[0];
  const hit = positions.get(txid);
  if (hit && (hit.pos || Date.now() - hit.at < 60_000)) return hit.pos;
  const pos = await K.chain.position(txid);
  if (positions.size > 5000) positions.clear();
  positions.set(txid, { pos, at: Date.now() });
  return pos;
}
const NO_CHAIN = 'Couldn’t check the chain just now. Try again shortly.';
const LISTING = 'bwallet_contracts?select=origin,envelope,created_at';
/** encodeURIComponent that never throws (a lone surrogate in an older row's name would fail the whole catalogue). */
const enc = (s) => {
  try {
    return encodeURIComponent(s);
  } catch {
    return encodeURIComponent(s.replace(/[\ud800-\udfff]/g, '\ufffd'));
  }
};
/** Every listing of a contract with this name (servedListings picks the same contract), earliest first. */
const sameName = (name) => rows(`${LISTING}&envelope->contract->>name=eq.${enc(name)}&order=created_at.asc&limit=500`);
/**
 * Every listing of contracts with these names, so a page of the catalogue is judged against older listings too.
 * Earliest first, so if a name ever has more rows than the limit, the ones cut are the latest, never an original.
 * (A later migration could store a hash of descriptor + description and look up by that instead of by name.)
 */
async function sameNames(names) {
  const quoted = [...new Set(names)].map((n) => `"${n.replace(/["\\]/g, '\\$&')}"`);
  const out = [];
  for (let i = 0; i < quoted.length; i += 25)
    out.push(
      ...(await rows(
        `${LISTING}&envelope->contract->>name=in.${enc(`(${quoted.slice(i, i + 25).join(',')})`)}&order=created_at.asc&limit=2000`,
      )),
    );
  return out;
}
/** Is the listing at `origin` (with envelope `env`) one the catalogue serves? true, false, or 'unchecked'. */
async function served(origin, env) {
  if (typeof env?.contract?.name !== 'string') return false;
  const j = await judgeListings(await sameName(env.contract.name), position);
  return j.unchecked.has(origin) ? 'unchecked' : j.served.has(origin);
}

async function list(req, res) {
  const origin = K.normOutpoint(new URL(req.url, 'http://x').searchParams.get('origin'));
  const [all, copies] = await Promise.all([
    rows(
      `bwallet_contracts?select=origin,envelope,body,created_at${origin ? `&origin=eq.${origin}` : ''}&order=created_at.desc&limit=200`,
    ),
    rows('bwallet_contract_copies?select=contract_origin'),
  ]);
  const sold = new Map();
  for (const c of copies) sold.set(c.contract_origin, (sold.get(c.contract_origin) || 0) + 1);
  let ok;
  if (origin) {
    const is = all[0] ? await served(all[0].origin, all[0].envelope) : false;
    if (is === 'unchecked') return send(res, 503, { error: NO_CHAIN });
    ok = new Set(is ? [all[0].origin] : []);
  } else {
    const names = all.map((c) => c.envelope?.contract?.name).filter((n) => typeof n === 'string');
    ok = (await judgeListings(await sameNames(names), position)).served;
  }
  // `body` = the exact inscribed text: buyers inscribe it byte for byte, so their copy's hash matches.
  const out = all
    .filter((c) => ok.has(c.origin))
    .map((c) => ({
      origin: c.origin,
      envelope: c.envelope,
      body: c.body,
      sold: sold.get(c.origin) || 0,
      createdAt: c.created_at,
    }));
  if (origin) return out[0] ? send(res, 200, { contract: out[0] }) : send(res, 404, { error: 'Not found' });
  return send(res, 200, { contracts: out });
}

async function proven(b, action) {
  const outpoint = K.normOutpoint(b.outpoint);
  if (!K.OUTPOINT.test(outpoint)) return { error: [400, 'Bad outpoint'] };
  const proof = K.verifyProof(action, outpoint, b);
  if (!proof.ok) return { error: [401, proof.error] };
  const own = await K.owns(outpoint, proof.address);
  if (!own.ok) return { error: [403, own.error] };
  return { outpoint, address: proof.address };
}

async function publish(b, res) {
  const p = await proven(b, 'publish');
  if (p.error) return send(res, p.error[0], { error: p.error[1] });
  if (p.outpoint !== ((await K.chain.origin(p.outpoint)) || p.outpoint))
    return send(res, 400, { error: 'Publish from the newly minted copy' });
  const a = await at(p.outpoint);
  if (!a) return send(res, 400, { error: 'That output isn’t a contract inscription' });
  const refused = await envelopeRefusal(a.env);
  if (refused) return send(res, refused[0], { error: refused[1] });
  // The earliest listing on chain stays: refused if an earlier one of this contract is by another author.
  const others = (await sameName(a.env.contract.name)).filter((e) => e.origin !== p.outpoint);
  // Not in the catalogue yet: among unconfirmed (or same-block) listings it ranks last.
  const mine = { origin: p.outpoint, envelope: a.env, created_at: null };
  const j = await judgeListings([...others, mine], position);
  if (j.unchecked.has(p.outpoint))
    return send(res, 503, { error: 'Couldn’t check the chain just now. Nothing was listed; try again shortly.' });
  if (!j.served.has(p.outpoint)) {
    // The wallet mints again on every publish, so say what happened and when trying again can work.
    const confirmed = await position(p.outpoint).catch(() => null);
    return send(res, 409, {
      error: confirmed
        ? 'This contract is already listed by another author'
        : 'Someone listed this text moments before you. Try again in a few minutes, once your contract has confirmed.',
    });
  }
  const r = await db('bwallet_contracts', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      origin: p.outpoint,
      body_hash: a.bodyHash,
      body: a.body,
      envelope: a.env,
      author_address: p.address,
    }),
  });
  if (r.status === 409) return send(res, 409, { error: 'Already published' });
  if (!r.ok) return send(res, 500, { error: 'Could not save' });
  return send(res, 200, { ok: true, origin: p.outpoint });
}

async function claim(b, res) {
  const p = await proven(b, 'unlock');
  if (p.error) return send(res, p.error[0], { error: p.error[1] });
  const origin = (await K.chain.origin(p.outpoint)) || p.outpoint;
  const a = await at(origin);
  if (!a) return send(res, 400, { error: 'That isn’t a contract NFT' });
  const [c] = await rows(`bwallet_contracts?select=origin,envelope&body_hash=eq.${a.bodyHash}`);
  if (!c) return send(res, 404, { error: 'This contract isn’t published (or the copy was altered)' });
  const is = await served(c.origin, c.envelope);
  if (is === 'unchecked') return send(res, 503, { error: NO_CHAIN });
  if (!is) return send(res, 404, { error: 'This contract isn’t listed' });
  if (origin === c.origin) return send(res, 200, { ok: true, contract: c.origin, original: true });
  const [known] = await rows(`bwallet_contract_copies?select=origin&origin=eq.${origin}`);
  if (!known) {
    const sale = c.envelope.sale;
    const paid = K.paidTo(a.tx, sale.payTo);
    if (sale.priceUsd > 0) {
      const rate = await K.chain.bsvUsd();
      if (!(rate > 0)) return send(res, 503, { error: 'No BSV price right now; try again shortly' });
      if (paid < Math.floor((sale.priceUsd / rate) * 1e8 * K.PRICE_TOLERANCE))
        return send(res, 402, { error: 'This copy wasn’t paid for' });
    }
    const sold = (await rows(`bwallet_contract_copies?select=origin&contract_origin=eq.${c.origin}`)).length;
    if (sold >= sale.copies) return send(res, 410, { error: 'Sold out' });
    const r = await db('bwallet_contract_copies', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ origin, contract_origin: c.origin, owner_address: p.address, paid_sats: paid }),
    });
    if (!r.ok && r.status !== 409) return send(res, 500, { error: 'Could not record the copy' });
  }
  return send(res, 200, { ok: true, contract: c.origin, original: false });
}

module.exports = async function handler(req, res) {
  // The web and Desktop wallets call this from their own origins: without these the browser blocks the reply
  // ("Failed to fetch"). Public catalogue; writes are checked by signature, never by cookie.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    if (req.method === 'GET') return await list(req, res);
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const ip =
      String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim() || 'unknown';
    if (limited(ip)) return send(res, 429, { error: 'Too many requests' });
    const b = await readBody(req);
    if (b.action === 'publish') return await publish(b, res);
    if (b.action === 'claim') return await claim(b, res);
    return send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('contracts error', e instanceof Error ? e.message : 'unknown');
    return send(res, 500, { error: 'Something went wrong' });
  }
};
