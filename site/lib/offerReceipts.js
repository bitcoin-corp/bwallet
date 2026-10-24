// Company offers paid by signature (phase 1; wallet side: src/mobile/offer/).
//
// The wallet pays a company paymail (e.g. bcorp@<domain>) with one extra OP_RETURN output:
//   OP_FALSE OP_RETURN "bcorp-offer" <reference> <completedHash hex>
// When that payment reaches `receive`, this module writes a subscription_receipt for the company:
// received_pending_allotment, received_shortfall or received_after_lapse. It NEVER allots or issues
// anything: `allotment` is always null here; the company's records fill it after a board minute.
//
// Generic: no company, offeree, figure or key lives in this file. Companies come from the
// PAYMAIL_COMPANIES env (JSON), offers from the signed `offer-register` call.
'use strict';
const { ProtoWallet, Script, Utils } = require('@bsv/sdk');

const OFFER_TAG = 'bcorp-offer';
const OFFER_SIG_PROTOCOL = [2, 'bcorp offer'];
const REF_RE = /^[A-Z0-9][A-Z0-9-]{3,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_RE = /^0[23][0-9a-f]{64}$/;
const USD_RE = /^\d{1,9}(\.\d{1,2})?$/;
const STATUSES = ['received_pending_allotment', 'received_shortfall', 'received_after_lapse'];

/** The exact text each party's identity key signs (same string in the wallet: src/mobile/offer/sign.ts). */
const sigRecord = (ref, role, hash) => `bcorp-offer|v1|ref=${ref}|role=${role}|hash=${hash}`;

async function verifyOfferSig({ key, ref, role, hash, sig }) {
  if (!KEY_RE.test(String(key)) || !/^[0-9a-f]{16,200}$/i.test(String(sig || ''))) return false;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(sigRecord(ref, role, hash), 'utf8'),
      signature: Utils.toArray(sig, 'hex'),
      protocolID: OFFER_SIG_PROTOCOL,
      keyID: ref,
      counterparty: key,
    });
    return valid === true;
  } catch {
    return false;
  }
}

/**
 * PAYMAIL_COMPANIES = {"<alias>": {"name": "...", "number": "...", "directors": ["<identity key>", ...]}}.
 * Bad JSON or bad entries are dropped (fail closed: no company, no offers).
 */
function companies(env = process.env) {
  let raw;
  try {
    raw = JSON.parse(String(env.PAYMAIL_COMPANIES || '{}'));
  } catch {
    return new Map();
  }
  const out = new Map();
  if (!raw || typeof raw !== 'object') return out;
  for (const [alias, c] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(alias) || !c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 120) : '';
    const number = typeof c.number === 'string' ? c.number.trim().slice(0, 32) : '';
    const directors = (Array.isArray(c.directors) ? c.directors : [])
      .map((k) => String(k).toLowerCase())
      .filter((k) => KEY_RE.test(k));
    if (name && number) out.set(alias, { name, number, directors });
  }
  return out;
}

/** The offer OP_RETURN in a tx: { vout, ref, completedHash } or null. Pushes are UTF-8 text. */
function parseOfferOpReturn(tx) {
  for (let vout = 0; vout < tx.outputs.length; vout++) {
    const chunks = tx.outputs[vout].lockingScript.chunks || [];
    const at = chunks.findIndex((c) => c.op === 0x6a);
    if (at < 0) continue;
    // @bsv/sdk keeps everything after a top-level OP_RETURN as that chunk's data: re-read it as pushes.
    let rest = chunks.slice(at + 1);
    if (!rest.length && chunks[at].data && chunks[at].data.length) {
      try {
        rest = Script.fromBinary(chunks[at].data).chunks;
      } catch {
        continue;
      }
    }
    const data = rest.map((c) => (c.data ? Utils.toUTF8(c.data) : null));
    if (data.length < 3 || data[0] !== OFFER_TAG) continue;
    const ref = data[1];
    const completedHash = String(data[2] || '').toLowerCase();
    if (!REF_RE.test(String(ref)) || !HEX64.test(completedHash)) continue;
    return { vout, ref, completedHash };
  }
  return null;
}

/** USD string → integer cents (no floats). */
const cents = (usd) => {
  const s = String(usd);
  if (!USD_RE.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
};
const usdText = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

/**
 * Status rules (offer template §B):
 *   paid after the offer's expiry → received_after_lapse (held, not applied), whatever the amount;
 *   else USD value below the amount asked → received_shortfall;
 *   else → received_pending_allotment.
 */
function receiptStatus({ amountUsd, usdValue, expires, firstSeen }) {
  const exp = Date.parse(expires);
  const seen = Date.parse(firstSeen);
  if (Number.isFinite(exp) && Number.isFinite(seen) && seen > exp) return 'received_after_lapse';
  const want = cents(amountUsd);
  const got = cents(usdValue);
  if (want === null || got === null || got < want) return 'received_shortfall';
  return 'received_pending_allotment';
}

/** USD value of `sats` at `rate` USD/BSV, rounded down to the cent. */
function usdValueOf(sats, rate) {
  const r = Math.round(Number(rate) * 100); // cents per BSV
  if (!Number.isFinite(r) || r <= 0) return null;
  return usdText(Math.floor((Number(sats) * r) / 1e8));
}

/**
 * Which rate to value the payment at: the payer's build-time rate when it is within 5% of ours at receipt
 * (so a payer who paid exactly the quoted amount is not short by a cent of drift), else ours.
 */
function pickRate(payerRate, serverRate) {
  const p = Number(payerRate);
  const s = Number(serverRate);
  if (Number.isFinite(s) && s > 0) {
    if (Number.isFinite(p) && p > 0 && Math.abs(p - s) / s <= 0.05) return { rate: p, source: 'payer-build' };
    return { rate: s, source: 'coingecko' };
  }
  if (Number.isFinite(p) && p > 0) return { rate: p, source: 'payer-build-unchecked' };
  return null;
}

/** The record (template §B). `allotment` is null and nothing here can set it. */
function buildReceipt({ company, offer, payment, completedHash, subscriberSig, checks, alias, domain, now }) {
  const usdValue = payment.usdValue;
  const want = cents(offer.amount_usd);
  const got = cents(usdValue) ?? 0;
  const status = receiptStatus({
    amountUsd: offer.amount_usd,
    usdValue,
    expires: offer.expires,
    firstSeen: payment.firstSeen,
  });
  return {
    type: 'subscription_receipt',
    status,
    company: { name: company.name, number: company.number },
    offerRef: offer.ref,
    offeree: { handle: offer.offeree_handle || null, identityKey: offer.offeree_key },
    sealTxid: offer.seal_txid,
    sealHash: offer.seal_hash,
    completedHash,
    subscriberSigOverCompletedHash: subscriberSig || null,
    payment: {
      txid: payment.txid,
      vout: payment.vout,
      satoshis: payment.satoshis,
      bsv: (payment.satoshis / 1e8).toFixed(8),
      rateUsdPerBsv: Number(payment.rate).toFixed(2),
      rateSource: payment.rateSource,
      rateAt: payment.rateAt,
      usdValue: usdValue ?? '0.00',
      shortfallUsd: want !== null && got < want ? usdText(want - got) : '0.00',
      excessUsd: want !== null && got > want ? usdText(got - want) : '0.00',
      firstSeen: payment.firstSeen,
      confirmedBlock: null,
    },
    checks,
    receivedBy: `${alias}@${domain}`,
    createdAt: new Date(now).toISOString(),
    allotment: null,
  };
}

/** Validate a signed offer-register body's fields. Returns the row or an error string. */
function offerRow(fields, companyKey, company) {
  const f = fields || {};
  const ref = String(f.ref || '');
  if (!REF_RE.test(ref)) return 'ref';
  if (cents(f.amountUsd) === null || cents(f.amountUsd) <= 0) return 'amountUsd';
  if (!Number.isFinite(Date.parse(String(f.expires)))) return 'expires';
  const sealHash = String(f.sealHash || '').toLowerCase();
  if (!HEX64.test(sealHash)) return 'sealHash';
  const sealTxid = String(f.sealTxid || '').toLowerCase();
  if (!HEX64.test(sealTxid)) return 'sealTxid';
  const offereeKey = String(f.offereeKey || '').toLowerCase();
  if (!KEY_RE.test(offereeKey)) return 'offereeKey';
  const directorKey = String(f.directorKey || '').toLowerCase();
  if (!company.directors.includes(directorKey)) return 'directorKey is not a director of this company';
  return {
    ref,
    company_key: companyKey,
    amount_usd: String(f.amountUsd),
    expires: new Date(Date.parse(String(f.expires))).toISOString(),
    seal_hash: sealHash,
    seal_txid: sealTxid,
    offeree_key: offereeKey,
    offeree_handle: String(f.offereeHandle || '').slice(0, 64) || null,
    director_key: directorKey,
    director_handle: String(f.directorHandle || '').slice(0, 64) || null,
  };
}

/** USD/BSV from CoinGecko (bitcoin-cash-sv), or null. */
async function coingeckoRate(f = fetch) {
  try {
    const r = await f('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=usd', {
      signal: AbortSignal.timeout(4000),
    });
    const j = r.ok ? await r.json() : null;
    const v = Number(j && j['bitcoin-cash-sv'] && j['bitcoin-cash-sv'].usd);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Tell the director a payment arrived: a bwalletx-push event (HMAC, same scheme as bit-sign's). The text is
 * generic on purpose (lock screens): figures and the txid are in the wallet's receipts list. Best-effort.
 * Env: PUSH_EVENTS_URL (e.g. https://push.bwalletx.com/v1/push/events), PUSH_EVENTS_SECRET.
 */
async function notifyDirector(handle, receipt, env = process.env, f = fetch) {
  const url = env.PUSH_EVENTS_URL;
  const secret = env.PUSH_EVENTS_SECRET;
  if (!url || !secret || !handle) return false;
  const { createHmac } = require('node:crypto');
  const body = JSON.stringify({
    handles: [String(handle).replace(/^\$/, '')],
    payload: {
      title: 'Offer payment received',
      body: `A payment for offer ${receipt.offerRef} has arrived. Open bWalletX › bMail › Agreements.`,
      data: { kind: 'offer_receipt', offerRef: receipt.offerRef, url: '/m/bmail/agreements' },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  try {
    const r = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-b-signature': `t=${t},v1=${v1}` },
      body,
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

module.exports = {
  OFFER_TAG,
  OFFER_SIG_PROTOCOL,
  STATUSES,
  sigRecord,
  verifyOfferSig,
  companies,
  parseOfferOpReturn,
  receiptStatus,
  usdValueOf,
  pickRate,
  buildReceipt,
  offerRow,
  coingeckoRate,
  notifyDirector,
  cents,
};
