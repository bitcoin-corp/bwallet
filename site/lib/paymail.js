// bWallet paymail (bsvalias) core. Pure logic + an injectable store, so it's unit-testable.
//
// The server holds NO private keys, of users or of its own:
//   - Users register alias → identity public key (+ ordinal receive address, profile), proving
//     ownership with a BRC-42/43 signature (protocol [2,'bwallet paymail'], keyID '1',
//     counterparty 'anyone') over a canonical message with a timestamp.
//   - P2P destinations use BRC-29 derivation with the "anyone" key (private key 1) as the
//     sender: child = identityKey.deriveChild(anyone, "2-3241645161d8-<prefix> <suffix>").
//     Only the identity private key can spend it; the wallet internalizes the output as a
//     "wallet payment" with senderIdentityKey = anyone's public key.
//   - Received transactions are verified against the reference's outputs and parked in an
//     inbox (beef + derivation) that the wallet collects with a signed request.
'use strict';
const { Beef, KeyDeriver, P2PKH, PrivateKey, PublicKey, ProtoWallet, Random, Transaction, Utils } = require('@bsv/sdk');

const BRC29 = [2, '3241645161d8'];
const SIGN_PROTOCOL = [2, 'bwallet paymail'];
const SIGN_KEY_ID = '1';
const ANYONE_PUB = new PrivateKey(1).toPublicKey().toString();

/** One payment row as the wallet sees it (inbox and history). */
const paymentOut = (r) => ({
  reference: r.reference,
  txid: r.txid,
  beef: r.beef,
  rawTx: r.raw_tx,
  sender: r.sender_handle,
  note: r.note,
  status: r.status,
  outputs: r.outputs.map((o) => ({
    vout: o.vout,
    satoshis: o.satoshis,
    derivationPrefix: o.derivationPrefix,
    derivationSuffix: o.derivationSuffix,
  })),
});
const SIG_WINDOW_MS = 5 * 60 * 1000;
const MAX_SATS = 21e14;
const ALIAS_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
/**
 * Verified social names (bWalletX "Continue with X / Google", owner 4 Oct 2026): `b0asex.x`,
 * `theirname.gmail`. Registering one needs bit-sign to confirm the caller's key belongs to the
 * account that proved that X username / Gmail address (socialCheck), so nobody else can take it.
 */
const SOCIAL_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?\.(x|gmail)$/;
const aliasOk = (a) => ALIAS_RE.test(a) || SOCIAL_RE.test(a);
/**
 * Social names are bWalletX's own record (lib/social.js): `<name>.x` / `<name>.gmail` registers only
 * with a Continue with X / Google ticket + secret proving that name. Aliases are unique, so one X
 * name or Gmail address = one wallet.
 */
const { openTicket, socialAliasFor } = require('./social');
const { makeOpnsResolver } = require('./opnsResolve');
const { cleanDisplayName, defaultDisplayName, shownDisplayName } = require('./displayName');
async function ticketSocialCheck(alias, proof, env = process.env) {
  if (!proof || !proof.ticket || !proof.secret) return 'Continue with X or Google first';
  const p = openTicket(proof.ticket, proof.secret, env);
  if (!p) return 'That sign-in has expired. Please sign in again.';
  return p.alias === alias ? null : 'That name does not match your sign-in';
}
/** A renamed name keeps forwarding to the new one this long, then is released (owner, 9 Oct 2026). */
const FORWARD_MS = 90 * 24 * 60 * 60 * 1000;
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
/** Anti-squatting (owner, 10 Oct 2026): one name change per 30 days per wallet (the first claim is free
 * of it), and at most NAME_IP_DAILY new names per client IP per day (env PAYMAIL_NAMES_PER_IP_DAY). */
const CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_IP_DAILY = 5;
const nameFee = require('./nameFee');
const offers = require('./offerReceipts');
const crypto = require('crypto');
const hashIp = (ip, env = process.env) =>
  ip
    ? crypto
        .createHash('sha256')
        .update(`bwallet-paymail|${env.PAYMAIL_IP_SALT || ''}|${ip}`)
        .digest('hex')
        .slice(0, 32)
    : null;
const dayText = (ms) =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const RESERVED = new Set([
  // Impersonation and technical names.
  'admin',
  'administrator',
  'root',
  'support',
  'help',
  'helpdesk',
  'security',
  'system',
  'staff',
  'team',
  'official',
  'billing',
  'payments',
  'legal',
  'abuse',
  'moderator',
  'mod',
  'postmaster',
  'webmaster',
  'noreply',
  'no-reply',
  'notifications',
  'paymail',
  'api',
  'www',
  'info',
  // Our companies and products (owner, 9 Oct 2026). Kept in step with bit-sign's reserved handles.
  'bwallet',
  'bwalletx',
  'bcorp',
  'bitcoincorp',
  'bitcoin-corp',
  'thebitcoincorp',
  'bitsign',
  'bit-sign',
  'bchat',
  'bchatx',
  'bspaces',
  'bmail',
  'bmovies',
  'bvault',
  'btrust',
  'bapps',
  'bitcoinos',
  'npg',
  'ninjapunkgirls',
  'kintsugi',
  'moneybutton',
  'divvy',
  'path401',
  'path402',
  'path403',
  // Bitcoin itself, its people and companies: full names only, so a real Craig keeps `craig`.
  'bitcoin',
  'bsv',
  'btc',
  'bitcoinsv',
  'bitcoin-sv',
  'satoshi',
  'satoshinakamoto',
  'nakamoto',
  'craigwright',
  'drcraigwright',
  'csw',
  'nchain',
  'bsvassociation',
  'bsva',
  'metanet',
  'teranode',
  'handcash',
  'relayx',
  'twetch',
  'centbee',
  // Held for the owner (10 Oct 2026); assign it to his wallet by hand when he wants it.
  'richard',
]);
/**
 * ⚠ A SOCIAL ALIAS IS RESERVED BY ITS BASE NAME. `bcorp.x` is proven by whoever holds X @bcorp,
 * which need not be us, so the suffix must not let a reserved name back in: `bcorp.x`,
 * `bcorp.gmail` and `bcorp` all refuse. Existing records are untouched (this runs at register).
 */
const reservedBase = (alias) => RESERVED.has(String(alias).replace(/\.(x|gmail)$/, ''));

const cleanDomain = (d) =>
  String(d || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
/** Primary paymail domain: PAYMAIL_DOMAIN, else the first of PAYMAIL_DOMAINS. */
const domain = (env = process.env) => domains(env)[0];
/**
 * Every domain we answer for: PAYMAIL_DOMAIN (primary) + the comma-separated PAYMAIL_DOMAINS.
 * An alias is one record whatever the domain, so switching the primary keeps old addresses working.
 */
function domains(env = process.env) {
  const list = [env.PAYMAIL_DOMAIN, ...String(env.PAYMAIL_DOMAINS || '').split(',')].map(cleanDomain).filter(Boolean);
  const out = [...new Set(list)];
  return out.length ? out : ['bwallet-nine.vercel.app'];
}
/** Public base URL for capability endpoints (defaults to https://<primary domain>). */
const baseUrl = (env = process.env) => String(env.PAYMAIL_BASE_URL || `https://${domain(env)}`).replace(/\/$/, '');

function capabilities(env = process.env) {
  const b = `${baseUrl(env)}/api/paymail`;
  return {
    bsvalias: '1.0',
    capabilities: {
      pki: `${b}/id/{alias}@{domain.tld}`,
      f12f968c92d6: `${b}/profile/{alias}@{domain.tld}`,
      a9f510c16bde: `${b}/verify/{alias}@{domain.tld}/{pubkey}`,
      '2a40af698840': `${b}/p2p-destination/{alias}@{domain.tld}`,
      '5f1323cddf31': `${b}/receive-tx/{alias}@{domain.tld}`,
      '5c55a7fdb7bb': `${b}/receive-beef/{alias}@{domain.tld}`,
      ordAddress: `${b}/ord/{alias}@{domain.tld}`,
    },
  };
}

/** "alice@domain" → { alias, domain } when the domain is one of ours and the alias is well-formed. */
function parseHandleParts(handle, env = process.env) {
  const s = decodeURIComponent(String(handle || ''))
    .trim()
    .toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return null;
  const alias = s.slice(0, at);
  const d = s.slice(at + 1);
  if (!domains(env).includes(d) || !aliasOk(alias)) return null;
  return { alias, domain: d };
}

/** "alice@domain" → "alice" when the domain is one of ours and the alias is well-formed. */
function parseHandle(handle, env = process.env) {
  const p = parseHandleParts(handle, env);
  return p ? p.alias : null;
}

const RESERVED_MSG = 'That alias is reserved';
/**
 * Everything after a dot is the system's (owner, 12 Oct 2026; same rule as bit-sign lib/handle-tld.ts).
 * A person never claims a dotted name. The only dotted aliases here are `.x` / `.gmail`, issued by the
 * Continue with X / Google path (ticket-gated below). `.agent` (token agents) and `.bot` (system bots)
 * are never issued by this registry. Unicode dot look-alikes and zero-width characters count.
 */
const SYSTEM_TLDS = ['agent', 'bot', 'x', 'gmail'];
const DOT_LIKE = /[.\u00B7\u0387\u2024\u2027\u2219\u22C5\u30FB\u3002\uFE52\uFF0E\uFF61\uFF65\u02D9\u0701\u0702\u2E33]/;
const DOT_MSG = "Names can't contain a dot. Names after a dot are kept for agents and system accounts.";
const foldAlias = (a) =>
  String(a || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .toLowerCase();
function dotRefusal(alias) {
  const f = foldAlias(alias);
  if (!DOT_LIKE.test(f)) return null;
  // The one system path that issues dotted names here: a proven X / Gmail name.
  return SOCIAL_RE.test(f) ? null : DOT_MSG;
}
/** A removed extra name is renamed to this (it keeps its payment history; never resolvable or claimable). */
const TOMB_RE = /^rm-[0-9a-f]{28}$/;
function validAlias(alias) {
  if (TOMB_RE.test(String(alias))) return 'That name is not available';
  const dot = dotRefusal(alias);
  if (dot) return dot;
  if (!aliasOk(alias)) return 'Alias must be 1-32 chars: a-z, 0-9, - or _ (not at the ends)';
  if (reservedBase(alias)) return RESERVED_MSG;
  return null;
}

/** Canonical message the wallet signs. Field order is fixed; values are stringified. */
function signedMessage(action, fields) {
  const keys = Object.keys(fields).sort();
  return ['bwallet-paymail', 'v1', action, ...keys.map((k) => `${k}=${fields[k] ?? ''}`)].join('|');
}

/** Verify a BRC-43 signature by `identityKey` (counterparty 'anyone' on the signer side). */
async function verifySigned(body, action, now = Date.now()) {
  const identityKey = String(body.identityKey || '').toLowerCase();
  if (!PUBKEY_RE.test(identityKey)) return 'Invalid identity key';
  const ts = Number(body.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIG_WINDOW_MS) return 'Signature expired; check your clock';
  if (!/^[0-9a-f]{16,200}$/i.test(String(body.signature || ''))) return 'Missing signature';
  const fields = { ...(body.fields || {}), identityKey, timestamp: String(ts) };
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(signedMessage(action, fields), 'utf8'),
      signature: Utils.toArray(body.signature, 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: SIGN_KEY_ID,
      counterparty: identityKey,
    });
    return valid ? null : 'Bad signature';
  } catch {
    return 'Bad signature';
  }
}

/** A binding as served publicly: everything a verifier needs to rebuild the signed message. */
const bindingOut = (b) => ({
  alias: b.alias,
  identityKey: b.identity_key,
  seq: Number(b.seq),
  timestamp: String(Date.parse(b.signed_at)),
  signature: b.signature,
  ...(b.from_key
    ? { handover: { from: b.from_key, releaseSignature: b.release_sig, releaseTimestamp: String(b.release_ts) } }
    : {}),
  scheme: 'bwallet-paymail/v1 bind; BRC-43 protocol [2,"bwallet paymail"] keyID "1", counterparty anyone',
});

const deriver = new KeyDeriver(new PrivateKey(1));
/** BRC-29 P2PKH destination for `identityKey`; returns script + derivation the wallet needs. */
function deriveDestination(identityKey, satoshis) {
  const derivationPrefix = Utils.toBase64(Random(16));
  const derivationSuffix = Utils.toBase64(Random(16));
  const pub = deriver.derivePublicKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, identityKey, false);
  const script = new P2PKH().lock(pub.toAddress()).toHex();
  return { script, satoshis, derivationPrefix, derivationSuffix };
}

/** Parse a raw tx hex or BEEF hex. Returns { tx, beefHex|null }. */
function parseIncoming(hexOrBeef) {
  const hex = String(hexOrBeef || '').trim();
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 20) throw new Error('Not hex');
  try {
    const beef = Beef.fromString(hex, 'hex');
    const last = beef.txs[beef.txs.length - 1];
    const tx = last && beef.findAtomicTransaction(last.txid);
    if (tx) return { tx, beefHex: hex };
  } catch {
    /* not BEEF */
  }
  return { tx: Transaction.fromHex(hex), beefHex: null };
}

/** Each expected output must appear in the tx with the same script and ≥ satoshis. Returns vouts or null. */
function matchOutputs(tx, expected) {
  const used = new Set();
  const vouts = [];
  for (const e of expected) {
    const i = tx.outputs.findIndex(
      (o, idx) => !used.has(idx) && o.lockingScript.toHex() === e.script && Number(o.satoshis) >= Number(e.satoshis),
    );
    if (i < 0) return null;
    used.add(i);
    vouts.push(i);
  }
  return vouts;
}

/**
 * Request handlers. `store` implements:
 *   getAlias(alias) → row|null            getAliasByKey(identityKey) → row|null
 *   upsertAlias(row) → row                renameAlias(from, to)
 *   insertPayment(row)                    getPayment(reference) → row|null
 *   updatePayment(reference, patch)       listInbox(identityKey) → rows (status 'received')
 *   countRecentPayments(alias, sinceIso) → number
 *   deleteByKey(identityKey) → { aliases, payments } (counts)
 * `broadcast(tx, beefHex)` is optional (best-effort).
 */
/**
 * A renamed handle (bit-sign self-serve rename, PR #102): bit-sign's public profile API answers an old
 * name with the current handle for 90 days, so `$old@ourdomain` keeps receiving for the new name.
 * Public, read-only, no credentials. Env: BITSIGN_PUBLIC_URL (optional, default https://www.bchatx.com).
 * Returns the new alias, or null (unknown, not renamed, or bit-sign unreachable).
 */
async function bitsignRenamed(alias, env = process.env, f = fetch) {
  if (!ALIAS_RE.test(alias)) return null;
  const base = String(env.BITSIGN_PUBLIC_URL || 'https://www.bchatx.com').replace(/\/$/, '');
  try {
    const r = await f(`${base}/api/public/profile/${encodeURIComponent(alias)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const to = String((await r.json())?.handle || '')
      .replace(/^\$/, '')
      .toLowerCase();
    return to && to !== alias && ALIAS_RE.test(to) ? to : null;
  } catch {
    return null;
  }
}

const MAX_PLAIN_NAMES = 5;
/**
 * Does `identityKey` own the bit-sign name `alias`? Public GET
 * /api/public/handles/owner?handle=<name>&key=<pubkey> → {handle, matches, active, primary}; it never
 * returns the key. Env: BITSIGN_PUBLIC_URL (optional, default https://www.bchatx.com).
 * Returns { matches, active } (both false for a JSON 404 = no such name). Throws on anything else
 * (unreachable, 400, 5xx, an HTML 404 while the route isn't shipped, a wrong answer): callers fail closed.
 */
async function bitsignHandleOwner(alias, identityKey, env = process.env, f = fetch) {
  const base = String(env.BITSIGN_PUBLIC_URL || 'https://www.bchatx.com').replace(/\/$/, '');
  const r = await f(
    `${base}/api/public/handles/owner?handle=${encodeURIComponent(alias)}&key=${encodeURIComponent(identityKey)}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) },
  );
  if (r.status === 404) {
    const j404 = await r.json().catch(() => null);
    if (j404 && typeof j404 === 'object') return { matches: false, active: false };
    throw new Error('bit-sign: owner lookup unavailable');
  }
  if (!r.ok) throw new Error(`bit-sign ${r.status}`);
  const j = await r.json();
  const handle = String(j?.handle || '')
    .replace(/^\$/, '')
    .toLowerCase();
  if (handle !== alias || typeof j?.matches !== 'boolean') throw new Error('bit-sign: bad owner answer');
  return { matches: j.matches === true, active: j.active === true };
}

function makeHandlers({
  store,
  env = process.env,
  broadcast,
  now = () => Date.now(),
  socialCheck = ticketSocialCheck,
  // Off under `bun test` (NODE_ENV=test) so unit tests never call the network; tests inject their own.
  renamed = env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test'
    ? async () => null
    : (alias) => bitsignRenamed(alias, env),
  // OpNS names (lib/opnsResolve.js) for pki / profile / verify only. Off under tests unless injected.
  opns = env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test' ? async () => null : makeOpnsResolver(),
  // Chain access for the 1 cent name fee (lib/nameFee.js); tests inject a mock.
  feeChain = nameFee.chain,
  // Owner of a bit-sign name (lib: bitsignHandleOwner). Tests inject their own.
  handleOwner = (alias, identityKey) => bitsignHandleOwner(alias, identityKey, env),
  // Company offers (lib/offerReceipts.js): USD/BSV at receipt and the director's push. Off under tests unless injected.
  offerRate = env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test'
    ? async () => null
    : () => offers.coingeckoRate(),
  notifyOffer = env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test'
    ? async () => false
    : (handle, receipt) => offers.notifyDirector(handle, receipt, env),
}) {
  // Company paymails (PAYMAIL_COMPANIES): the alias row (identity key) is provisioned in the DB by the owner;
  // the env only says which aliases are companies, their registered name + number, and their directors.
  const companyOf = (alias) => offers.companies(env).get(String(alias || '').toLowerCase()) || null;
  const companyOut = (c) => ({ name: c.name, number: c.number, directors: c.directors });
  // Aliases are unique across all our domains (the store is keyed by alias alone).
  const handleOf = (alias, d = domain(env)) => `${alias}@${d}`;
  // A live forward (rename within 90 days, or a permanent extra name). Expired ones are released.
  const liveForward = async (alias) => {
    const fw = store.getForward ? await store.getForward(alias).catch(() => null) : null;
    if (!fw) return null;
    if (fw.expires_at && Date.parse(fw.expires_at) <= now()) {
      await store.deleteForward?.(alias).catch(() => {});
      return null;
    }
    return fw;
  };
  const publicAlias = async (handle) => {
    const p = parseHandleParts(handle, env);
    if (!p || TOMB_RE.test(p.alias)) return [404, { error: 'not-found' }];
    let row = await store.getAlias(p.alias);
    // An old (or extra) name forwards to the wallet's name (one hop), so payments to it still arrive.
    if (!row) {
      const fw = await liveForward(p.alias);
      if (fw) {
        row = await store.getAlias(fw.to_alias);
        if (row && row.identity_key !== fw.identity_key) row = null;
      }
    }
    if (!row) {
      const to = await renamed(p.alias).catch(() => null);
      if (to) row = await store.getAlias(to);
    }
    if (!row) return [404, { error: 'not-found' }];
    return [200, { ...row, _domain: p.domain }];
  };
  // A claimed alias (or its forward / rename) always wins; only then is the handle tried as an OpNS
  // name bound on chain to an identity key. Read-only answers: no payments, inbox or ord address.
  const publicIdentity = async (handle) => {
    const [s, row] = await publicAlias(handle);
    if (s === 200) return [s, row];
    const p = parseHandleParts(handle, env);
    if (!p) return [s, row];
    const o = await opns(p.alias, domains(env)).catch(() => null);
    if (!o) return [s, row];
    return [
      200,
      { alias: p.alias, identity_key: o.identityKey, display_name: o.displayName, _domain: p.domain, _opns: true },
    ];
  };

  // Receipt for a payment to a company paymail carrying the offer OP_RETURN (template §B). allotment: null, always.
  const recordOfferReceipt = async (co, row, tx, txid, vouts, body) => {
    if (!store.getOffer || !store.insertReceipt) return null;
    const op = offers.parseOfferOpReturn(tx);
    if (!op) return null;
    const offer = await store.getOffer(op.ref);
    if (!offer || offer.alias !== row.alias) return null;
    if (store.getReceipt && (await store.getReceipt(txid))) return null;
    const meta = (body && body.metadata && body.metadata.offer) || {};
    const subscriberKey = String(meta.identityKey || '').toLowerCase();
    const subscriberSig = /^[0-9a-f]{16,200}$/i.test(String(meta.signature || '')) ? String(meta.signature) : null;
    const sigOk = subscriberSig
      ? await offers.verifyOfferSig({
          key: subscriberKey,
          ref: op.ref,
          role: 'subscriber',
          hash: op.completedHash,
          sig: subscriberSig,
        })
      : false;
    const sats = vouts.reduce((a, v) => a + Number(tx.outputs[v].satoshis), 0);
    const picked = offers.pickRate(meta.rateUsdPerBsv, await offerRate().catch(() => null));
    const firstSeen = new Date(now()).toISOString();
    const receipt = offers.buildReceipt({
      company: co,
      offer,
      payment: {
        txid,
        vout: vouts,
        satoshis: sats,
        rate: picked ? picked.rate : 0,
        rateSource: picked ? picked.source : 'none',
        rateAt:
          picked && picked.source.startsWith('payer') && meta.rateAt ? String(meta.rateAt).slice(0, 40) : firstSeen,
        usdValue: picked ? offers.usdValueOf(sats, picked.rate) : '0.00',
        firstSeen,
      },
      completedHash: op.completedHash,
      subscriberSig,
      checks: {
        offereeKeyMatches: subscriberKey === offer.offeree_key,
        subscriberSigValid: sigOk && subscriberKey === offer.offeree_key,
        completedHashFromChain: true,
      },
      alias: row.alias,
      domain: row._domain || domain(env),
      now: now(),
    });
    await store.insertReceipt({ txid, ref: op.ref, alias: row.alias, status: receipt.status, record: receipt });
    await notifyOffer(offer.director_handle, receipt).catch(() => false);
    return receipt;
  };

  return {
    caps: async () => [200, capabilities(env)],

    // What the app needs before claiming a name: where the 1 cent fee goes (null = no fee).
    config: async () => {
      const address = nameFee.feeAddress(env);
      return [
        200,
        {
          nameFee: address ? { address, usd: nameFee.FEE_USD } : null,
          nameChangeDays: CHANGE_COOLDOWN_MS / 86_400_000,
        },
      ];
    },

    pki: async ({ handle }) => {
      const [s, row] = await publicIdentity(handle);
      if (s !== 200) return [s, row];
      const out = { bsvalias: '1.0', handle: handleOf(row.alias, row._domain), pubkey: row.identity_key };
      // A company paymail says whose it is (name, number, directors); the payer's wallet checks the seal against it.
      const co = !row._opns && companyOf(row.alias);
      if (co) out.company = companyOut(co);
      // The owner's signed binding (docs/NAME-BINDINGS.md): lets any wallet check, without trusting us, that the
      // key's holder put this name on this key. Only a binding signed by the key now served is returned.
      const b = row.alias && store.getBinding ? await store.getBinding(row.alias).catch(() => null) : null;
      if (b && String(b.identity_key).toLowerCase() === String(row.identity_key).toLowerCase())
        out.binding = bindingOut(b);
      return [200, out];
    },

    // Signed name binding: the name's current owner signs "alias -> my key, version seq" (seq must go up).
    bind: async (_q, body) => {
      body = body || {};
      const sigErr = await verifySigned(body, 'bind', now());
      if (sigErr) return [401, { error: sigErr }];
      const identityKey = String(body.identityKey).toLowerCase();
      const f = body.fields || {};
      const alias = String(f.alias || '').toLowerCase();
      const seq = Number(f.seq);
      if (!alias || !Number.isInteger(seq) || seq < 1) return [400, { error: 'alias and seq' }];
      const row = await store.getAlias(alias);
      if (!row || String(row.identity_key).toLowerCase() !== identityKey)
        return [403, { error: 'Only the wallet the name points to can sign its binding' }];
      const prev = await store.getBinding(alias);
      // Once another key has signed this name, only a two-party handover (its release + this key's accept) can
      // rebind it: a name moved any other way stays unsigned for its new key, and payers see that.
      if (prev && String(prev.identity_key).toLowerCase() !== identityKey)
        return [409, { error: 'This name was signed by another wallet; it can only move by a signed handover' }];
      if (prev && Number(prev.seq) >= seq) return [409, { error: 'seq must go up', seq: Number(prev.seq) }];
      const b = {
        alias,
        identity_key: identityKey,
        seq,
        signature: String(body.signature).toLowerCase(),
        signed_at: new Date(Number(body.timestamp)).toISOString(),
      };
      await store.putBinding(b);
      await store.logName({
        alias,
        identity_key: identityKey,
        action: 'bind',
        actor: 'owner',
        seq,
        signature: b.signature,
        note: String(body.timestamp),
      });
      return [200, { binding: bindingOut(b) }];
    },

    // Two-party handover, step 1: the name's current owner signs "alias -> key B, version seq". Nothing moves yet.
    'handover-release': async (_q, body) => {
      body = body || {};
      const sigErr = await verifySigned(body, 'release', now());
      if (sigErr) return [401, { error: sigErr }];
      const from = String(body.identityKey).toLowerCase();
      const f = body.fields || {};
      const alias = String(f.alias || '').toLowerCase();
      const to = String(f.to || '').toLowerCase();
      const seq = Number(f.seq);
      if (!alias || !PUBKEY_RE.test(to) || to === from || !Number.isInteger(seq) || seq < 1)
        return [400, { error: 'alias, to and seq' }];
      const row = await store.getAlias(alias);
      if (!row || String(row.identity_key).toLowerCase() !== from)
        return [403, { error: 'Only the wallet the name points to can hand it over' }];
      const b = await store.getBinding(alias);
      const floor = b && String(b.identity_key).toLowerCase() === from ? Number(b.seq) : 0;
      if (seq <= floor) return [409, { error: 'seq must go up', seq: floor }];
      await store.putHandover({
        alias,
        from_key: from,
        to_key: to,
        seq,
        release_sig: String(body.signature).toLowerCase(),
        release_ts: Number(body.timestamp),
      });
      return [200, { pending: { alias, to, seq } }];
    },

    // The owner takes back a release that hasn't been accepted.
    'handover-cancel': async (_q, body) => {
      body = body || {};
      const sigErr = await verifySigned(body, 'release-cancel', now());
      if (sigErr) return [401, { error: sigErr }];
      const alias = String(body.fields?.alias || '').toLowerCase();
      const h = await store.getHandover(alias);
      if (!h || h.from_key !== String(body.identityKey).toLowerCase()) return [404, { error: 'No handover to cancel' }];
      await store.deleteHandover(alias);
      return [200, { cancelled: alias }];
    },

    // Names offered to this key, waiting for it to accept (public: keys and names are public).
    'handovers-for': async (q) => {
      const key = String(q.key || '').toLowerCase();
      if (!PUBKEY_RE.test(key)) return [400, { error: 'key' }];
      return [200, { handovers: await store.handoversFor(key) }];
    },

    // Step 2: the new owner signs the binding for the same seq. Only then does the name move. The release travels
    // with the binding, so any wallet can check both signatures.
    'handover-accept': async (_q, body) => {
      body = body || {};
      const sigErr = await verifySigned(body, 'bind', now());
      if (sigErr) return [401, { error: sigErr }];
      const to = String(body.identityKey).toLowerCase();
      const alias = String(body.fields?.alias || '').toLowerCase();
      const seq = Number(body.fields?.seq);
      const h = await store.getHandover(alias);
      if (!h || h.to_key !== to || Number(h.seq) !== seq) return [404, { error: 'No handover of that name to you' }];
      const row = await store.getAlias(alias);
      if (!row || String(row.identity_key).toLowerCase() !== h.from_key)
        return [409, { error: 'The name changed hands since the release' }];
      await store.moveAlias(alias, to);
      const b = {
        alias,
        identity_key: to,
        seq,
        signature: String(body.signature).toLowerCase(),
        signed_at: new Date(Number(body.timestamp)).toISOString(),
        from_key: h.from_key,
        release_sig: h.release_sig,
        release_ts: Number(h.release_ts),
      };
      await store.putBinding(b);
      await store.logName({
        alias,
        identity_key: to,
        prev_identity_key: h.from_key,
        action: 'bind',
        actor: 'owner',
        seq,
        signature: b.signature,
        note: `handover: release ${h.release_sig} at ${h.release_ts}; accept at ${body.timestamp}`,
      });
      await store.deleteHandover(alias);
      return [200, { binding: bindingOut(b) }];
    },

    // The public name log, newest first: every change of who a name points to, hash-chained.
    'name-log': async (q) => {
      const alias = String(q.alias || '').toLowerCase();
      const rows = await store.nameLog(alias || null, Math.min(Number(q.limit) || 200, 1000));
      return [200, { log: rows }];
    },

    profile: async ({ handle }) => {
      const [s, row] = await publicIdentity(handle);
      if (s !== 200) return [s, row];
      // No picture of their own: their generated bAvatar, drawn from the identity key (bChatX
      // /api/bavatar, the same picture the wallet draws), so other BSV apps show one too.
      const avatar =
        row.avatar ||
        (/^0[23][0-9a-f]{64}$/.test(row.identity_key || '')
          ? `https://www.bchatx.com/api/bavatar/${row.identity_key}.png`
          : '');
      const co = !row._opns && companyOf(row.alias);
      if (co) return [200, { name: co.name, avatar, company: companyOut(co) }];
      return [200, { name: shownDisplayName(row.display_name, row.alias), avatar }];
    },

    verify: async ({ handle, pubkey }) => {
      const [s, row] = await publicIdentity(handle);
      if (s !== 200) return [s, row];
      const pk = String(pubkey || '').toLowerCase();
      return [
        200,
        { bsvalias: '1.0', handle: handleOf(row.alias, row._domain), pubkey: pk, match: pk === row.identity_key },
      ];
    },

    ord: async ({ handle }) => {
      const [s, row] = await publicAlias(handle);
      if (s !== 200) return [s, row];
      if (!row.ord_address) return [404, { error: 'no-ord-address' }];
      return [200, { address: row.ord_address }];
    },

    p2pDestination: async ({ handle }, body) => {
      const [s, row] = await publicAlias(handle);
      if (s !== 200) return [s, row];
      const satoshis = Math.floor(Number(body && body.satoshis));
      if (!Number.isFinite(satoshis) || satoshis < 1 || satoshis > MAX_SATS)
        return [400, { error: 'invalid-satoshis' }];
      const since = new Date(now() - 60 * 60 * 1000).toISOString();
      if ((await store.countRecentPayments(row.alias, since)) > 200) return [429, { error: 'rate-limited' }];
      const out = deriveDestination(row.identity_key, satoshis);
      const reference = Utils.toHex(Random(16));
      await store.insertPayment({
        reference,
        alias: row.alias,
        identity_key: row.identity_key,
        satoshis,
        outputs: [out],
        status: 'pending',
      });
      return [200, { outputs: [{ script: out.script, satoshis }], reference }];
    },

    receive: async ({ handle }, body) => {
      const [s, row] = await publicAlias(handle);
      if (s !== 200) return [s, row];
      const reference = String((body && body.reference) || '');
      const pay = reference && (await store.getPayment(reference));
      if (!pay || pay.alias !== row.alias) return [404, { error: 'unknown-reference' }];
      let parsed;
      try {
        parsed = parseIncoming(body.beef || body.hex);
      } catch {
        return [400, { error: 'invalid-transaction' }];
      }
      const txid = parsed.tx.id('hex');
      if (pay.status !== 'pending') {
        if (pay.txid === txid) return [200, { txid, note: 'already received' }];
        return [409, { error: 'reference-already-used' }];
      }
      const vouts = matchOutputs(parsed.tx, pay.outputs);
      if (!vouts) return [400, { error: 'outputs-do-not-match-reference' }];
      if (broadcast) {
        try {
          await broadcast(parsed.tx, parsed.beefHex);
        } catch (e) {
          // The sender normally broadcasts first (1Sat sendBsv does); log and keep going.
          console.error('paymail broadcast failed', String(e && e.message ? e.message : e).slice(0, 200));
        }
      }
      const outputs = pay.outputs.map((o, i) => ({ ...o, vout: vouts[i] }));
      await store.updatePayment(reference, {
        status: 'received',
        txid,
        beef: parsed.beefHex,
        raw_tx: parsed.beefHex ? null : parsed.tx.toHex(),
        outputs,
        sender_handle: String((body.metadata && body.metadata.sender) || '').slice(0, 128) || null,
        note: String((body.metadata && body.metadata.note) || '').slice(0, 256) || null,
        received_at: new Date(now()).toISOString(),
      });
      // A company offer payment: write the subscription receipt. Never fails the receive (the payment is in).
      const co = companyOf(row.alias);
      if (co)
        await recordOfferReceipt(co, row, parsed.tx, txid, vouts, body).catch((e) => {
          console.error('offer receipt failed', String(e && e.message ? e.message : e).slice(0, 200));
        });
      return [200, { txid, note: `Received by ${handleOf(row.alias, row._domain)}` }];
    },

    // ---- company offers (lib/offerReceipts.js) --------------------------------
    // The company account registers a sealed offer so its payment can be matched. Signed by the company key.
    'offer-register': async (_q, body) => {
      body = body || {};
      const sigErr = await verifySigned(body, 'offer-register', now());
      if (sigErr) return [401, { error: sigErr }];
      const key = String(body.identityKey).toLowerCase();
      const alias = String(body.fields?.alias || '').toLowerCase();
      const co = companyOf(alias);
      const row = co && (await store.getAlias(alias));
      if (!co || !row || String(row.identity_key).toLowerCase() !== key)
        return [403, { error: "Only the company paymail's own key can register its offers" }];
      if (!store.putOffer) return [501, { error: 'offers not available' }];
      const o = offers.offerRow(body.fields, key, co);
      if (typeof o === 'string') return [400, { error: `Bad offer: ${o}` }];
      const prev = await store.getOffer(o.ref);
      if (prev && prev.seal_hash !== o.seal_hash)
        return [409, { error: 'That reference is already a different offer' }];
      await store.putOffer({ ...o, alias });
      return [200, { ref: o.ref }];
    },

    // Receipts for the director (or the company key): newest first. Signed.
    'offer-receipts': async (_q, body) => {
      body = body || {};
      const sigErr = await verifySigned(body, 'offer-receipts', now());
      if (sigErr) return [401, { error: sigErr }];
      if (!store.listReceipts) return [501, { error: 'offers not available' }];
      const key = String(body.identityKey).toLowerCase();
      const alias = String(body.fields?.alias || '').toLowerCase();
      const co = companyOf(alias);
      const row = co && (await store.getAlias(alias));
      const isCompany = !!row && String(row.identity_key).toLowerCase() === key;
      if (!co || !(isCompany || co.directors.includes(key))) return [403, { error: 'Directors only' }];
      const rows = await store.listReceipts(alias);
      return [200, { receipts: rows.map((r) => r.record) }];
    },

    // ---- wallet-authenticated ------------------------------------------------
    register: async (_q, body, ctx = {}) => {
      body = body || {};
      const f = body.fields || {};
      const alias = String(f.alias || '').toLowerCase();
      const bad = validAlias(alias);
      // Reserved names refuse NEW claims only: whoever already holds one (us) can still update it.
      if (bad && bad !== RESERVED_MSG) return [400, { error: bad }];
      if (f.ordAddress && !/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(f.ordAddress)))
        return [400, { error: 'Invalid ordAddress' }];
      const sigErr = await verifySigned(body, 'register', now());
      if (sigErr) return [401, { error: sigErr }];
      const identityKey = String(body.identityKey).toLowerCase();
      const taken = await store.getAlias(alias);
      if (bad === RESERVED_MSG && !(taken && String(taken.identity_key).toLowerCase() === identityKey))
        return [400, { error: bad }];
      // A verified name needs proof only to claim it; its owner can update the profile without signing in again.
      const ownsIt = taken && String(taken.identity_key).toLowerCase() === identityKey;
      if (SOCIAL_RE.test(alias) && !ownsIt) {
        const refused = await socialCheck(alias, body.social, env);
        if (refused) return [403, { error: refused }];
      }
      if (taken && taken.identity_key !== identityKey) return [409, { error: 'That name is taken' }];
      // A name still forwarding (renamed < 90 days ago, or an extra name) belongs to its wallet.
      const fwd = taken ? null : await liveForward(alias);
      if (fwd && fwd.identity_key !== identityKey) return [409, { error: 'That name is taken' }];
      // Verified social names sit beside the plain name (one of each kind per wallet): b0asex.x is
      // added, boase stays. A plain name still renames, keeping the inbox.
      const kind = SOCIAL_RE.test(alias) ? (alias.endsWith('.x') ? 'x' : 'gmail') : 'plain';
      // One identity per wallet (owner, 4 Oct 2026): a verified X / Google name always wins, so a
      // wallet that has one can't also take a plain name. Plain-name identities are separate accounts.
      // Owner, 9 Oct 2026 (handle rule): users choose their handle. A wallet with a verified .x / .gmail
      // name may take ONE plain handle of its choosing (it becomes the main name); the social name keeps
      // receiving. New .gmail names are no longer issued (they published the address); existing ones work.
      if (kind === 'gmail' && !ownsIt) return [403, { error: 'Choose a handle instead of your email name.' }];
      const mine =
        kind === 'plain' ? await store.getAliasByKey(identityKey) : await store.getAliasByKeyKind?.(identityKey, kind);
      // A new plain name for this wallet (first claim or rename; not a profile update of its own name).
      const newName = kind === 'plain' && !ownsIt;
      const isRename = newName && !!mine && (mine.kind ?? 'plain') === 'plain' && mine.alias !== alias;
      const ipHash = hashIp(ctx.ip, env);
      let fee = null;
      if (newName) {
        store.deleteExpiredForwards?.(new Date(now()).toISOString()).catch(() => {});
        if (isRename && store.lastRename) {
          const last = await store.lastRename(identityKey);
          const next = last ? Date.parse(last) + CHANGE_COOLDOWN_MS : 0;
          if (next > now())
            return [
              429,
              { error: `You can change your name again on ${dayText(next)}.`, retryAt: new Date(next).toISOString() },
            ];
        }
        if (ipHash && store.countIpClaims) {
          const max = Number(env.PAYMAIL_NAMES_PER_IP_DAY) || NAME_IP_DAILY;
          const since = new Date(now() - 86_400_000).toISOString();
          if ((await store.countIpClaims(ipHash, since)) >= max)
            return [429, { error: 'Too many new names from this network today. Try again tomorrow.' }];
        }
        const address = nameFee.feeAddress(env);
        if (address) {
          const txid = String(f.feeTxid || '').toLowerCase();
          const chk = await nameFee.checkFeeTx({
            txid,
            txHex: body.feeTx,
            address,
            c: feeChain,
            broadcast,
            parse: parseIncoming,
          });
          if (!chk.ok) return [402, { error: chk.error, nameFee: { address, usd: nameFee.FEE_USD } }];
          if (
            store.useFeeTx &&
            !(await store.useFeeTx({ txid, identity_key: identityKey, alias, satoshis: chk.satoshis }))
          )
            return [409, { error: 'That payment already paid for a name' }];
          fee = txid;
        }
      }
      if (mine && mine.alias !== alias && (mine.kind ?? 'plain') === kind) {
        await store.renameAlias(mine.alias, alias);
        // The old name keeps receiving for 90 days, then is released.
        if (store.putForward) {
          if (fwd) await store.deleteForward(alias);
          await store.retargetForwards?.(mine.alias, alias);
          await store.putForward({
            from_alias: mine.alias,
            to_alias: alias,
            identity_key: identityKey,
            expires_at: new Date(now() + FORWARD_MS).toISOString(),
          });
        }
      }
      const row = await store.upsertAlias({
        kind,
        alias,
        identity_key: identityKey,
        ord_address: f.ordAddress || null,
        // Keep what's there when an update leaves a field out.
        // A display name is never blank (owner, 15 Oct 2026): what they typed, else the wallet's
        // current name (every name on one key shares it), else the alias as typed ("mike" → "Mike").
        display_name:
          cleanDisplayName(f.name) ||
          cleanDisplayName(ownsIt ? taken.display_name : '') ||
          cleanDisplayName((await store.getAliasByKey(identityKey))?.display_name) ||
          defaultDisplayName(alias),
        avatar: String(f.avatar || '').slice(0, 512) || (ownsIt ? taken.avatar : null) || null,
      });
      // A name they typed is the wallet's name on every one of its paymails.
      if (cleanDisplayName(f.name) && store.setDisplayNameByKey)
        await store.setDisplayNameByKey(identityKey, row.display_name);
      if (newName) {
        // Legacy .gmail names published the owner's email: once the wallet has a plain name, the
        // .gmail one forwards to it for 90 days, then is released (migrations/20261010_retire_gmail_names.sql).
        const gmail = await store.getAliasByKeyKind?.(identityKey, 'gmail');
        if (gmail && store.retireToForward)
          await store.retireToForward(gmail.alias, alias, identityKey, new Date(now() + FORWARD_MS).toISOString());
        await store.recordNameEvent?.({
          identity_key: identityKey,
          alias,
          kind: isRename ? 'rename' : 'claim',
          ip_hash: ipHash,
        });
      }
      return [200, { paymail: handleOf(row.alias), pubkey: identityKey, ...(fee ? { feeTxid: fee } : {}) }];
    },

    // Settings › Identity › Your name: one display name per wallet, written to every name on the key.
    'set-name': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'set-name', now());
      if (sigErr) return [401, { error: sigErr }];
      const key = String(body.identityKey).toLowerCase();
      const row = await store.getAliasByKey(key);
      if (!row) return [404, { error: 'Claim a name first' }];
      const name = cleanDisplayName(body.fields?.name) || defaultDisplayName(row.alias);
      await store.setDisplayNameByKey(key, name);
      return [200, { name }];
    },

    // Market › Social: names whose owners may have a personal token. provider=all → every kind.
    social: async (q) => {
      const kinds = q.provider === 'all' ? ['x', 'gmail', 'plain'] : [q.provider === 'google' ? 'gmail' : 'x'];
      const rows = [];
      for (const k of kinds)
        for (const r of store.listSocial ? await store.listSocial(k) : []) rows.push({ ...r, kind: k });
      return [200, { accounts: rows.map((r) => ({ alias: r.alias, name: r.display_name || null, kind: r.kind })) }];
    },

    lookup: async (q) => {
      const key = String(q.key || '').toLowerCase();
      if (!PUBKEY_RE.test(key)) return [400, { error: 'invalid-key' }];
      // The wallet's identity: the handle its owner chose (plain) first (owner, 9 Oct 2026), else a
      // verified .x / .gmail name. getAliasByKey already prefers plain and falls back to any kind.
      const row = await store.getAliasByKey(key);
      if (!row) return [404, { error: 'not-found' }];
      // All names that receive for this wallet, so none is invisible (owner, 4 Oct 2026).
      const all = store.listByKey ? await store.listByKey(key) : [row];
      const names = all.map((r) => ({
        paymail: handleOf(r.alias),
        kind: r.kind || 'plain',
        main: r.alias === row.alias,
      }));
      return [200, { paymail: handleOf(row.alias), alias: row.alias, names }];
    },

    inbox: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'inbox', now());
      if (sigErr) return [401, { error: sigErr }];
      const rows = await store.listInbox(String(body.identityKey).toLowerCase());
      return [200, { senderIdentityKey: ANYONE_PUB, payments: rows.map(paymentOut) }];
    },

    // Restore from seed (incident 14 Oct 2026): every payment ever received for this key, collected ones too,
    // so a new device can re-internalize receipts whose derivation lives only here. Read-only; no ack.
    history: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'history', now());
      if (sigErr) return [401, { error: sigErr }];
      if (!store.listHistory) return [501, { error: 'history not available' }];
      const rows = await store.listHistory(String(body.identityKey).toLowerCase());
      return [200, { senderIdentityKey: ANYONE_PUB, payments: rows.map(paymentOut) }];
    },

    ack: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'ack', now());
      if (sigErr) return [401, { error: sigErr }];
      const key = String(body.identityKey).toLowerCase();
      const refs = String((body.fields && body.fields.references) || '')
        .split(',')
        .filter(Boolean)
        .slice(0, 100);
      let done = 0;
      for (const ref of refs) {
        const p = await store.getPayment(ref);
        if (p && p.identity_key === key && p.status === 'received') {
          await store.updatePayment(ref, { status: 'collected', collected_at: new Date(now()).toISOString() });
          done++;
        }
      }
      return [200, { collected: done }];
    },

    // Account deletion (Apple 5.1.1(v), Google Play): removes the alias and every inbox row for
    // this identity key. The wallet collects the inbox first, so no uncollected payment's
    // derivation data is lost. On-chain payments themselves are unaffected.
    // Apps › Add app (owner, 5 Oct 2026): the wallet's own list, so a 12-word restore brings it back.
    // Signed by the identity key both ways; the list is private to that wallet.
    appsGet: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'apps-get', now());
      if (sigErr) return [401, { error: sigErr }];
      return [200, { apps: (await store.getApps?.(String(body.identityKey).toLowerCase())) ?? [] }];
    },
    appsPut: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'apps-put', now());
      if (sigErr) return [401, { error: sigErr }];
      let apps;
      try {
        apps = JSON.parse(String(body.fields?.apps || '[]'));
      } catch {
        return [400, { error: 'apps must be JSON' }];
      }
      if (!Array.isArray(apps) || apps.length > 200) return [400, { error: 'Up to 200 apps' }];
      const clean = [];
      for (const a of apps) {
        let u;
        try {
          u = new URL(String(a?.url || ''));
        } catch {
          return [400, { error: 'Each app needs a valid https link' }];
        }
        if (u.protocol !== 'https:') return [400, { error: 'Apps must use https' }];
        clean.push({ url: u.href.slice(0, 300), name: String(a?.name || u.hostname).slice(0, 40) });
      }
      await store.setApps(String(body.identityKey).toLowerCase(), clean);
      return [200, { apps: clean }];
    },

    // Unlink one of this wallet's names (Settings › Identity). The name becomes free for anyone.
    unlink: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'unlink', now());
      if (sigErr) return [401, { error: sigErr }];
      const alias = String(body.fields?.alias || '').toLowerCase();
      const key = String(body.identityKey).toLowerCase();
      const row = alias ? await store.getAlias(alias) : null;
      if (!row || String(row.identity_key).toLowerCase() !== key)
        return [404, { error: 'That name is not on this wallet' }];
      if (store.countUncollected && (await store.countUncollected(alias)) > 0)
        return [
          409,
          { error: 'A payment to this name is still arriving. Open the wallet to collect it, then try again.' },
        ];
      await store.deleteAlias(alias);
      return [200, { unlinked: handleOf(alias) }];
    },

    // ---- several plain names per wallet, one primary (owner, 15 Oct 2026) ---------------------
    // Needs migration STEP A (is_primary + partial unique index). Adding a second plain name also
    // needs STEP B (drop UNIQUE(identity_key, kind)); until then the insert clashes and is refused.
    'names-list': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'names-list', now());
      if (sigErr) return [401, { error: sigErr }];
      const key = String(body.identityKey).toLowerCase();
      const main = await store.getAliasByKey(key);
      const all = main && store.listByKey ? await store.listByKey(key) : main ? [main] : [];
      return [
        200,
        {
          names: all.map((r) => ({
            paymail: handleOf(r.alias),
            kind: r.kind || 'plain',
            main: !!main && r.alias === main.alias,
          })),
        },
      ];
    },

    'names-add': async (_q, body, ctx = {}) => {
      body = body || {};
      const alias = String(body.fields?.alias || '').toLowerCase();
      if (SOCIAL_RE.test(alias)) return [400, { error: 'Extra names are plain names (a-z, 0-9, - or _)' }];
      const bad = validAlias(alias);
      if (bad) return [400, { error: bad }];
      const sigErr = await verifySigned(body, 'names-add', now());
      if (sigErr) return [401, { error: sigErr }];
      const key = String(body.identityKey).toLowerCase();
      const main = await store.getAliasByKeyKind?.(key, 'plain');
      if (!main) return [409, { error: 'Claim your main name first' }];
      if (await store.getAlias(alias)) return [409, { error: 'That name is taken' }];
      // A held name (renamed or removed < 90 days ago) is taken unless it is this wallet's own.
      const fwd = await liveForward(alias);
      if (fwd && fwd.identity_key !== key) return [409, { error: 'That name is taken' }];
      const ipHash = hashIp(ctx.ip, env);
      if (ipHash && store.countIpClaims) {
        const max = Number(env.PAYMAIL_NAMES_PER_IP_DAY) || NAME_IP_DAILY;
        const since = new Date(now() - 86_400_000).toISOString();
        if ((await store.countIpClaims(ipHash, since)) >= max)
          return [429, { error: 'Too many new names from this network today. Try again tomorrow.' }];
      }
      // Max 5 plain names per wallet (mirrors bit-sign's /me/handles max).
      const plain = (store.listByKey ? await store.listByKey(key) : []).filter((r) => (r.kind ?? 'plain') === 'plain');
      if (plain.length >= MAX_PLAIN_NAMES) return [409, { error: `A wallet can have up to ${MAX_PLAIN_NAMES} names` }];
      // Paid once, on bit-sign (owner, 15 Oct 2026: 1p per extra name through its 402 flow). Here we only
      // accept a name bit-sign says this same identity key owns. Fails closed when bit-sign can't answer.
      const owner = await handleOwner(alias, key).catch(() => undefined);
      if (!owner) return [503, { error: "Couldn't check your bChatX names. Try again in a minute." }];
      if (!owner.matches || !owner.active) return [402, { error: 'Add (and pay for) the name in bChatX first' }];
      let row;
      try {
        row = await store.insertExtraAlias({ alias, identity_key: key });
      } catch (e) {
        if (/supabase 409/.test(String(e && e.message))) return [409, { error: 'Could not add that name yet' }];
        throw e;
      }
      if (!row) return [500, { error: 'server-error' }];
      if (fwd) await store.deleteForward?.(alias);
      await store.recordNameEvent?.({ identity_key: key, alias, kind: 'claim', ip_hash: ipHash });
      return [200, { added: handleOf(alias) }];
    },

    'names-primary': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'names-primary', now());
      if (sigErr) return [401, { error: sigErr }];
      const alias = String(body.fields?.alias || '').toLowerCase();
      const key = String(body.identityKey).toLowerCase();
      const row = alias && !TOMB_RE.test(alias) ? await store.getAlias(alias) : null;
      if (!row || String(row.identity_key).toLowerCase() !== key || (row.kind ?? 'plain') !== 'plain')
        return [404, { error: 'That name is not on this wallet' }];
      const main = await store.getAliasByKeyKind?.(key, 'plain');
      if (main && main.alias === alias) return [200, { main: handleOf(alias) }];
      await store.setPrimary(key, main ? main.alias : null, alias);
      return [200, { main: handleOf(alias) }];
    },

    // Remove an extra name. Never a DELETE (payments reference the alias, ON DELETE RESTRICT): the
    // name forwards to the main name for 90 days (the rename hold), and the row is renamed to an
    // rm-… tombstone so its payment history stays with the wallet.
    'names-remove': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'names-remove', now());
      if (sigErr) return [401, { error: sigErr }];
      const alias = String(body.fields?.alias || '').toLowerCase();
      const key = String(body.identityKey).toLowerCase();
      const row = alias && !TOMB_RE.test(alias) ? await store.getAlias(alias) : null;
      if (!row || String(row.identity_key).toLowerCase() !== key || (row.kind ?? 'plain') !== 'plain')
        return [404, { error: 'That name is not on this wallet' }];
      const main = await store.getAliasByKeyKind?.(key, 'plain');
      if (!main || main.alias === alias) return [409, { error: 'Make another name main first' }];
      // Forward first, so there is no moment when the name answers nothing.
      await store.retargetForwards?.(alias, main.alias);
      await store.putForward({
        from_alias: alias,
        to_alias: main.alias,
        identity_key: key,
        expires_at: new Date(now() + FORWARD_MS).toISOString(),
      });
      await store.renameAlias(alias, `rm-${Utils.toHex(Random(14))}`);
      return [200, { removed: handleOf(alias), forwardsTo: handleOf(main.alias) }];
    },

    delete: async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'delete', now());
      if (sigErr) return [401, { error: sigErr }];
      if (!body.fields || body.fields.confirm !== 'DELETE') return [400, { error: 'confirm must be DELETE' }];
      const key = String(body.identityKey).toLowerCase();
      const row = await store.getAliasByKey(key);
      const removed = await store.deleteByKey(key);
      await store.deleteBphone?.(key);
      return [200, { deleted: true, alias: row ? row.alias : null, ...removed }];
    },

    // ---- bPhone: charge to receive calls (docs/BPHONE-PLAN.md) --------------------------------
    // The rate card + listing are public (a caller reads them before dialling); writes are signed.
    // Bookings are between two identity keys; each side reads its own with a signed request.
    'bphone-get': async (q) => {
      const key = String(q.key || '').toLowerCase();
      if (!PUBKEY_RE.test(key)) return [400, { error: 'invalid-key' }];
      const row = await store.getBphone?.(key);
      if (!row) return [404, { error: 'not-found' }];
      return [200, { key, profile: row.profile, ...(await nameOf(key)) }];
    },
    'bphone-put': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'bphone-put', now());
      if (sigErr) return [401, { error: sigErr }];
      let raw;
      try {
        raw = JSON.parse(String(body.fields?.profile || ''));
      } catch {
        return [400, { error: 'profile must be JSON' }];
      }
      const profile = cleanProfile(raw);
      if (typeof profile === 'string') return [400, { error: profile }];
      profile.updatedAt = now();
      const key = String(body.identityKey).toLowerCase();
      await store.setBphone(key, profile);
      return [200, { profile }];
    },
    // Who is listed, newest first; ?category= narrows. Only listed profiles, never the unlisted rate cards.
    'bphone-directory': async (q) => {
      const category = BPHONE_CATEGORIES.includes(q.category) ? q.category : null;
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const rows = (await store.listBphone?.(category, limit)) ?? [];
      const listings = [];
      for (const r of rows)
        listings.push({ key: r.identity_key, profile: r.profile, ...(await nameOf(r.identity_key)) });
      return [200, { listings }];
    },
    // Ask for a call at a time (the callee's listing must take bookings).
    'bphone-book': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'bphone-book', now());
      if (sigErr) return [401, { error: sigErr }];
      const f = body.fields || {};
      const callee = String(f.calleeKey || '').toLowerCase();
      const caller = String(body.identityKey).toLowerCase();
      if (!PUBKEY_RE.test(callee)) return [400, { error: 'invalid callee' }];
      if (callee === caller) return [400, { error: 'You cannot book yourself' }];
      const prof = await store.getBphone?.(callee);
      if (!prof || prof.profile?.listing?.booking === false)
        return [404, { error: 'This person does not take bookings' }];
      const req = cleanBookingRequest(f, now());
      if (typeof req === 'string') return [400, { error: req }];
      const open = (await store.listBookings(caller)).filter(
        (b) => b.status === 'requested' && b.caller_key === caller,
      );
      if (open.length >= 20) return [429, { error: 'Too many open requests' }];
      const calleeName = await nameOf(callee);
      const row = {
        id: Utils.toHex(Random(16)),
        callee_key: callee,
        caller_key: caller,
        caller_label: req.callerLabel,
        callee_label: calleeName.paymail || '',
        at: req.at,
        minutes: req.minutes,
        note: req.note,
        status: 'requested',
        rate: prof.profile?.rate ?? null,
        created_at: new Date(now()).toISOString(),
        updated_at: new Date(now()).toISOString(),
      };
      await store.insertBooking(row);
      return [200, { booking: bookingOut(row) }];
    },
    // Every booking this identity is part of, soonest first.
    'bphone-bookings': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'bphone-bookings', now());
      if (sigErr) return [401, { error: sigErr }];
      const key = String(body.identityKey).toLowerCase();
      const rows = await store.listBookings(key);
      return [200, { bookings: rows.map(bookingOut).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) }];
    },
    // Callee: confirm / decline / cancel. Caller: cancel. Nothing else moves.
    'bphone-book-act': async (_q, body) => {
      const sigErr = await verifySigned(body || {}, 'bphone-book-act', now());
      if (sigErr) return [401, { error: sigErr }];
      const f = body.fields || {};
      const key = String(body.identityKey).toLowerCase();
      const id = String(f.id || '');
      const action = String(f.action || '');
      if (!/^[0-9a-f]{32}$/.test(id)) return [400, { error: 'invalid booking' }];
      const row = await store.getBooking(id);
      if (!row) return [404, { error: 'not-found' }];
      const isCallee = row.callee_key === key;
      const isCaller = row.caller_key === key;
      if (!isCallee && !isCaller) return [403, { error: 'Not your booking' }];
      let status;
      if (action === 'cancel') status = 'cancelled';
      else if (isCallee && action === 'confirm' && row.status === 'requested') status = 'confirmed';
      else if (isCallee && action === 'decline' && row.status === 'requested') status = 'declined';
      else return [400, { error: `Cannot ${action} a ${row.status} booking` }];
      if (row.status === 'declined' || row.status === 'cancelled') return [400, { error: `Already ${row.status}` }];
      const patch = { status, updated_at: new Date(now()).toISOString() };
      await store.updateBooking(id, patch);
      return [200, { booking: bookingOut({ ...row, ...patch }) }];
    },
  };

  /** The paymail + profile name / avatar for a key, for directory rows and bookings ('' when it has none). */
  async function nameOf(key) {
    const row =
      (await store.getAliasByKeyKind?.(key, 'x')) ||
      (await store.getAliasByKeyKind?.(key, 'gmail')) ||
      (await store.getAliasByKey(key));
    return row
      ? {
          paymail: handleOf(row.alias),
          name: shownDisplayName(row.display_name, row.alias),
          avatar: row.avatar || null,
        }
      : { paymail: null, name: null, avatar: null };
  }
}

const BPHONE_CATEGORIES = require('./bphone').CATEGORIES;
const { cleanProfile, cleanBookingRequest } = require('./bphone');

/** A booking row as the wallet reads it (src/mobile/calls/rateCard.ts parseBooking). */
const bookingOut = (r) => ({
  id: r.id,
  calleeKey: r.callee_key,
  callerKey: r.caller_key,
  callerLabel: r.caller_label || '',
  calleeLabel: r.callee_label || '',
  at: new Date(r.at).toISOString(),
  minutes: r.minutes,
  note: r.note || '',
  status: r.status,
  rate: r.rate ?? null,
  createdAt: new Date(r.created_at).toISOString(),
});

module.exports = {
  FORWARD_MS,
  CHANGE_COOLDOWN_MS,
  hashIp,
  bitsignRenamed,
  socialAliasFor,
  ANYONE_PUB,
  BRC29,
  SIGN_PROTOCOL,
  SIGN_KEY_ID,
  capabilities,
  parseHandle,
  parseHandleParts,
  validAlias,
  TOMB_RE,
  MAX_PLAIN_NAMES,
  bitsignHandleOwner,
  dotRefusal,
  SYSTEM_TLDS,
  signedMessage,
  verifySigned,
  deriveDestination,
  parseIncoming,
  matchOutputs,
  makeHandlers,
  domain,
  domains,
  baseUrl,
  PublicKey,
};
