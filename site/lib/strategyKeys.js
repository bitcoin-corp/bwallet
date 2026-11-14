// Key service for Exchange › Strategies (src/mobile/strategies/strategyNft.ts). A strategy NFT carries
// its program encrypted; this service holds each content key and releases it only to someone who proves
// they own a copy that is the author's own or was paid for (up to the edition size). Nothing here is
// trusted from the client: ownership comes from the chain (the outpoint's script + spend status), the
// envelope from the origin inscription, and the key is checked against the envelope's keyHash.
const crypto = require('node:crypto');
const { PublicKey, Signature, Transaction, Utils } = require('@bsv/sdk');

const ONESAT = 'https://api.1sat.app/1sat';
const CONTENT_TYPE = 'application/vnd.bwalletx.strategy+json';
const ENVELOPE_FORMAT = 'bwalletx.strategy-nft/1';
const PROOF_WINDOW_MS = 5 * 60 * 1000;
/** A buyer's payment may be checked a little after they paid: accept 15% below today's dollar price. */
const PRICE_TOLERANCE = 0.85;
const OUTPOINT = /^[0-9a-f]{64}_\d{1,6}$/;

const proofMessage = (action, outpoint, ts) => `bwalletx strategy ${action}: ${outpoint}: ${ts}`;
const normOutpoint = (s) =>
  String(s || '')
    .trim()
    .replace('.', '_')
    .toLowerCase();

/** Address of a valid signature over `message`, or an error. */
function verifyProof(action, outpoint, p, now = Date.now()) {
  const prefix = `bwalletx strategy ${action}: ${outpoint}: `;
  if (typeof p.message !== 'string' || !p.message.startsWith(prefix))
    return { ok: false, error: 'Proof does not match this request' };
  const ts = Number(p.message.slice(prefix.length));
  if (!Number.isFinite(ts) || Math.abs(now - ts) > PROOF_WINDOW_MS)
    return { ok: false, error: 'Proof expired; try again' };
  try {
    const pub = PublicKey.fromString(String(p.pubkey_hex || '').trim());
    const sig = Signature.fromDER(String(p.signature || '').trim(), 'hex');
    if (!pub.verify(Utils.toArray(p.message, 'utf8'), sig)) return { ok: false, error: 'Signature does not verify' };
    return { ok: true, address: pub.toAddress() };
  } catch {
    return { ok: false, error: 'Bad proof' };
  }
}

function p2pkhAddress(script) {
  const c = script.chunks;
  for (let i = 0; i + 4 < c.length; i++) {
    if (
      c[i].op === 0x76 &&
      c[i + 1].op === 0xa9 &&
      c[i + 2].data?.length === 20 &&
      c[i + 3].op === 0x88 &&
      c[i + 4].op === 0xac
    )
      return Utils.toBase58Check(c[i + 2].data);
  }
  return null;
}

/** 1Sat inscription in a locking script: OP_FALSE OP_IF "ord" OP_1 <type> OP_0 <data…> OP_ENDIF. */
function inscriptionOf(script) {
  const c = script.chunks;
  for (let i = 0; i < c.length; i++) {
    if (!c[i].data || Utils.toUTF8(c[i].data) !== 'ord') continue;
    let type = '';
    let j = i + 1;
    for (; j + 1 < c.length && c[j].op !== 0; j += 2)
      if (c[j].op === 0x51) type = c[j + 1].data ? Utils.toUTF8(c[j + 1].data) : '';
    const body = [];
    for (j += 1; j < c.length && c[j].op !== 0x68; j++) if (c[j].data) body.push(...c[j].data);
    return { type, body: Utils.toUTF8(body) };
  }
  return null;
}

function parseEnvelope(text) {
  try {
    const o = JSON.parse(text);
    if (o?.format !== ENVELOPE_FORMAT || !/^[0-9a-f]{64}$/.test(o.keyHash || '') || !o.sale || !o.author) return null;
    const price = Number(o.sale.priceUsd);
    const copies = Number(o.sale.copies);
    if (!(price > 0) || !Number.isInteger(copies) || copies < 1 || typeof o.sale.payTo !== 'string') return null;
    return o;
  } catch {
    return null;
  }
}

/** Public part of an envelope (no ciphertext) for listings. */
const publicEnvelope = (e) => ({
  name: e.name,
  version: e.version,
  description: e.description,
  spec: e.spec,
  author: e.author,
  sale: e.sale,
  keyHash: e.keyHash,
});

// ---- content-key encryption at rest (STRATEGY_KEY_SECRET, Vercel env only) ----
const secretKey = () => {
  const s = process.env.STRATEGY_KEY_SECRET;
  if (!s) throw new Error('STRATEGY_KEY_SECRET is not set');
  return crypto.createHash('sha256').update(s).digest();
};
function sealKey(keyB64) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const ct = Buffer.concat([c.update(Buffer.from(keyB64, 'base64')), c.final(), c.getAuthTag()]);
  return `${iv.toString('base64')}.${ct.toString('base64')}`;
}
function openKey(sealed) {
  const [iv, ct] = sealed.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('base64');
}

// ---- chain access (injectable for tests) ----
const chain = {
  async tx(txid) {
    for (const url of [
      `${ONESAT}/beef/${txid}/tx`,
      `https://junglebus.gorillapool.io/v1/transaction/get/${txid}/bin`,
    ]) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) continue;
        const tx = Transaction.fromBinary(Array.from(new Uint8Array(await r.arrayBuffer())));
        if (tx.id('hex') === txid) return tx;
      } catch {
        /* next source */
      }
    }
    return null;
  },
  async spent(outpoint) {
    const r = await fetch(`${ONESAT}/txo/spends`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([outpoint.replace('_', '.')]),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error('Spend check unavailable');
    const rows = await r.json();
    return !!rows?.[0]?.spendTxid;
  },
  async origin(outpoint) {
    const r = await fetch(`${ONESAT}/ordfs/metadata/${outpoint.replace('_', '.')}:-2`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const m = await r.json().catch(() => null);
    return m?.origin ? normOutpoint(m.origin) : null;
  },
  /**
   * Where a transaction sits on chain: { height, index } once mined (index = its position in the block, when known),
   * null when a source says it is known and unconfirmed, and it THROWS when that couldn't be found out (a source
   * failed and none showed a block, or no source knows the transaction): "unconfirmed" and "couldn't check" must
   * never look the same (re-review of f3ff8a37). From the 1Sat BEEF's merkle path (the leaf offset is the
   * position), and JungleBus. Not checked against block headers: it ranks listings (lib/contracts.js).
   */
  async position(txid) {
    let failed = false;
    let unconfirmed = false;
    try {
      const r = await fetch(`${ONESAT}/beef/${txid}`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const tx = Transaction.fromBEEF(Array.from(new Uint8Array(await r.arrayBuffer())));
        if (tx.id('hex') !== txid) throw new Error('wrong transaction');
        const mp = tx.merklePath;
        const leaf = mp?.path[0]?.find((l) => l.hash === txid);
        if (mp && Number.isInteger(mp.blockHeight) && mp.blockHeight > 0)
          return { height: mp.blockHeight, index: Number.isInteger(leaf?.offset) ? leaf.offset : null };
        unconfirmed = true;
      } else if (r.status !== 404) failed = true;
    } catch {
      failed = true;
    }
    try {
      const r = await fetch(`https://junglebus.gorillapool.io/v1/transaction/get/${txid}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.id !== txid) throw new Error('wrong transaction');
        if (Number.isInteger(j.block_height) && j.block_height > 0)
          return { height: j.block_height, index: Number.isInteger(j.block_index) ? j.block_index : null };
        unconfirmed = true;
      } else if (r.status !== 404) failed = true;
    } catch {
      failed = true;
    }
    if (failed || !unconfirmed) throw new Error('Chain position unavailable');
    return null;
  },
  async bsvUsd() {
    const r = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate', {
      signal: AbortSignal.timeout(8_000),
    });
    const j = await r.json();
    return Number(j.rate) || 0;
  },
};

/** The 1-sat output at `outpoint`: still unspent and locked to `address`? */
async function owns(outpoint, address, c = chain) {
  const [txid, vout] = outpoint.split('_');
  const tx = await c.tx(txid);
  const out = tx?.outputs[Number(vout)];
  if (!out) return { ok: false, error: 'Outpoint not found' };
  if (out.satoshis !== 1) return { ok: false, error: 'Not an ordinal' };
  if (p2pkhAddress(out.lockingScript) !== address) return { ok: false, error: 'You don’t own that copy' };
  if (await c.spent(outpoint)) return { ok: false, error: 'That copy has moved' };
  return { ok: true, tx, out };
}

/** The envelope inscribed at an origin (strategies by default; contracts pass their own type + parser). */
async function envelopeAt(origin, c = chain, type = CONTENT_TYPE, parse = parseEnvelope) {
  const [txid, vout] = origin.split('_');
  const tx = await c.tx(txid);
  const out = tx?.outputs[Number(vout)];
  const ins = out && inscriptionOf(out.lockingScript);
  if (!ins || ins.type !== type) return null;
  const env = parse(ins.body);
  return env
    ? { env, tx, body: ins.body, bodyHash: require('node:crypto').createHash('sha256').update(ins.body).digest('hex') }
    : null;
}

/** Sats the origin transaction paid to `address`. */
const paidTo = (tx, address) =>
  tx.outputs.reduce((s, o) => s + (p2pkhAddress(o.lockingScript) === address && o.satoshis > 1 ? o.satoshis : 0), 0);

module.exports = {
  CONTENT_TYPE,
  PRICE_TOLERANCE,
  OUTPOINT,
  chain,
  envelopeAt,
  inscriptionOf,
  normOutpoint,
  openKey,
  owns,
  paidTo,
  parseEnvelope,
  proofMessage,
  publicEnvelope,
  sealKey,
  verifyProof,
};
