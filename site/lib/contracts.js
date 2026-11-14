// Exchange › Contracts (src/mobile/contracts/contractNft.ts): a contract is a PUBLIC 1Sat NFT, so buyers can
// read and audit it. Each copy is the same envelope inscribed again; a buyer's copy is minted in the
// transaction that pays the author. This module parses envelopes; the chain checks are shared with
// strategies (strategyKeys.js).
const { ProtoWallet, Utils } = require('@bsv/sdk');

const CONTRACT_TYPE = 'application/vnd.bwalletx.contract+json';
const CONTRACT_FORMAT = 'bwalletx.contract-nft/1';

function parseContractEnvelope(text) {
  try {
    const o = JSON.parse(text);
    if (o?.format !== CONTRACT_FORMAT || !o.contract || typeof o.contract !== 'object' || !o.sale || !o.author)
      return null;
    if (o.contract.format !== 'bwalletx.contract/1' || typeof o.contract.name !== 'string') return null;
    if (/[\ud800-\udfff]/.test(o.contract.name.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) return null;
    const price = Number(o.sale.priceUsd);
    const copies = Number(o.sale.copies);
    if (!(price >= 0) || !Number.isInteger(copies) || copies < 1 || typeof o.sale.payTo !== 'string') return null;
    if (!['testnet', 'mainnet'].includes(o.contract.network)) return null;
    return o;
  } catch {
    return null;
  }
}

// ---- author signatures (owner, 14 Nov 2026: "paid contract listing need an author's signature"; b-Aware row 115) ----
// Same scheme as the wallet (src/mobile/contracts/contractNft.ts: canonical, contractSigningBytes,
// contractAuthorKey; its contractSign.test.ts checks this file against it): BRC-43 [2,'bwallet contract'], keyID '1',
// counterparty 'anyone', by author.identityKey, over the canonical JSON of the envelope without authorSig. The site
// is deployed on its own (site/ is the Vercel root) and can't import the wallet's TypeScript, so it is mirrored here.
const CONTRACT_SIGN_PROTOCOL = [2, 'bwallet contract'];
const CONTRACT_SIGN_KEY_ID = '1';
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

/** Key-order-independent JSON value (objects with sorted keys; arrays keep their order). */
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;

/** The bytes the author signs: the canonical envelope with authorSig left out. */
const contractSigningBytes = (env) => {
  const { authorSig: _sig, ...rest } = env;
  return Utils.toArray(JSON.stringify(canonical(rest)), 'utf8');
};

/** The author's identity key when authorSig is a valid signature by author.identityKey; null otherwise. */
async function contractAuthorKey(env) {
  const key = env?.author?.identityKey;
  const sig = env?.authorSig;
  if (typeof key !== 'string' || !PUBKEY_RE.test(key) || typeof sig !== 'string' || !/^[0-9a-f]{16,200}$/i.test(sig))
    return null;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: contractSigningBytes(env),
      signature: Utils.toArray(sig, 'hex'),
      protocolID: CONTRACT_SIGN_PROTOCOL,
      keyID: CONTRACT_SIGN_KEY_ID,
      counterparty: key,
    });
    return valid === true ? key : null;
  } catch {
    return null;
  }
}

/** Same contract: the same canonical descriptor and the same description (as the wallet's copiedFrom). */
const contractId = (e) => JSON.stringify([canonical(e.contract), e.description]);

/**
 * Older wallets list paid contracts unsigned. The released wallet shows this text as it is, after it has minted,
 * so it says what to do (owner, 14 Nov 2026).
 */
const UPDATE_TO_SIGN =
  "This contract wasn't listed: paid contracts now carry your signature. Update bWalletX (5.2.57 or later) and publish it again.";

/**
 * Why the catalogue won't list (or serve) `env`, as [status, error], or null. A paid listing must be signed by its
 * author: author.identityKey a compressed key, authorSig valid by it, and the payee the author's own address. A
 * listing that claims a key or carries a signature must verify too (a free one from the wallet's own publish is
 * signed); a free listing with neither is accepted, as before.
 */
async function envelopeRefusal(env) {
  const paid = Number(env.sale.priceUsd) > 0;
  const author = env.author;
  if (paid && author.identityKey === undefined && env.authorSig === undefined) return [400, UPDATE_TO_SIGN];
  if (paid || author.identityKey !== undefined || env.authorSig !== undefined) {
    if (typeof author.identityKey !== 'string' || !PUBKEY_RE.test(author.identityKey))
      return [400, paid ? 'A paid contract must carry its author’s identity key' : 'Bad author identity key'];
    if (!(await contractAuthorKey(env))) return [400, 'This contract isn’t signed by its author'];
  }
  if (paid && env.sale.payTo !== author.address) return [400, 'A paid contract must pay its author’s address'];
  return null;
}

/**
 * May `later` be listed after `earlier` (the same contract)? A signed listing can be listed again only under the
 * same key; an unsigned one blocks only a later unsigned one from another address (review of 2e409da3). `key` is the
 * verified identity key (contractAuthorKey) or null.
 */
const mayFollow = (earlier, later) =>
  earlier.key ? later.key === earlier.key : !!later.key || earlier.env.author.address === later.env.author.address;

/**
 * Chain order of two origins: the earlier block first; unconfirmed ranks after confirmed. In one block (or both
 * unconfirmed) it is the order the catalogue first saw them, never the position in the block: a copier who sees the
 * original in the mempool can get an earlier position in the same block (re-review of f3ff8a37). Negative = `a` first.
 */
function chainOrder(a, b) {
  if (a.pos && b.pos && a.pos.height !== b.pos.height) return a.pos.height - b.pos.height;
  if (!a.pos !== !b.pos) return a.pos ? -1 : 1;
  return a.seen - b.seen || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0);
}

const checked = new Map();
/** envelopeRefusal + contractAuthorKey for a catalogue row. An origin's inscription never changes: kept per origin. */
async function checkRow(origin, env) {
  const memo = `${origin}|${env.authorSig ?? ''}`;
  if (checked.has(memo)) return checked.get(memo);
  const out = { refused: await envelopeRefusal(env), key: await contractAuthorKey(env) };
  if (checked.size > 5000) checked.clear();
  checked.set(memo, out);
  return out;
}

/**
 * The listings the catalogue serves, from rows `{ origin, envelope, created_at }`, as { served, unchecked } (Sets of
 * origins):
 * - a row that fails envelopeRefusal is left out (older unsigned or badly signed paid listings: fail closed);
 * - of the listings of one contract, the earliest ON CHAIN stays (chainOrder, from `position(origin)`, asked only
 *   when listings of a contract disagree about the author) and a later one that may not follow it (mayFollow) is
 *   left out. So listing first in the catalogue is no way to take over an author's contract;
 * - `position` throws when it couldn't find out (null = unconfirmed). Then the order isn't known, so NONE of that
 *   contract's listings is served and all are `unchecked` (re-review of f3ff8a37: a failed lookup for the original
 *   must never serve the copy). A position the caller already holds doesn't fail, so a proven order stays served.
 */
async function judgeListings(rows, position) {
  const groups = new Map();
  for (const r of rows) {
    if (!r?.envelope || typeof r.envelope !== 'object' || !r.envelope.author || !r.envelope.sale) continue;
    const { refused, key } = await checkRow(r.origin, r.envelope);
    if (refused) continue;
    const id = contractId(r.envelope);
    if (!groups.has(id)) groups.set(id, []);
    const seen = Date.parse(r.created_at);
    groups.get(id).push({ origin: r.origin, env: r.envelope, key, seen: seen || Infinity });
  }
  const served = new Set();
  const unchecked = new Set();
  for (const g of groups.values()) {
    const agree = g.every((a) => g.every((b) => a === b || mayFollow(a, b)));
    if (!agree) {
      let failed = false;
      for (const l of g) {
        try {
          l.pos = (await position(l.origin)) ?? null;
        } catch {
          failed = true;
        }
      }
      if (failed) {
        for (const l of g) unchecked.add(l.origin);
        continue;
      }
      g.sort(chainOrder);
    }
    const kept = [];
    for (const l of g) if (kept.every((k) => mayFollow(k, l))) kept.push(l);
    for (const k of kept) served.add(k.origin);
  }
  return { served, unchecked };
}
const servedListings = async (rows, position) => (await judgeListings(rows, position)).served;

module.exports = {
  CONTRACT_TYPE,
  CONTRACT_FORMAT,
  CONTRACT_SIGN_PROTOCOL,
  CONTRACT_SIGN_KEY_ID,
  UPDATE_TO_SIGN,
  canonical,
  chainOrder,
  contractAuthorKey,
  contractId,
  contractSigningBytes,
  envelopeRefusal,
  judgeListings,
  mayFollow,
  parseContractEnvelope,
  servedListings,
};
