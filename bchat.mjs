// bChat posting for the official bWalletX account. Builds posts exactly as bChat does
// (bit-sign src/lib/feed/script.ts: B text/markdown | MAP SET app bChat type post | AIP BITCOIN_ECDSA),
// pays from the poster key, broadcasts via WhatsOnChain, then hands the raw tx to the feed indexers.
// Keys come from the environment only (BCHAT_ROOT_WIF, BCHAT_SIGN_WIF), never from code.
import { BigNumber, BSM, Hash, OP, P2PKH, PrivateKey, SatoshisPerKilobyte, Script, Signature, Transaction, Utils } from '@bsv/sdk';

const B_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut';
const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
const AIP_PREFIX = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva';
const BAP_PREFIX = '1BAPSuaPnfGnSBM3GLV9yhxUdYe4vGbdMT';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const INGEST = ['https://push.bwalletx.com/feed/ingest', 'https://bmap-api-production.up.railway.app/ingest'];
export const PROFILE = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'bWalletX',
  image: 'https://bwalletx.com/icon-512.png',
  url: 'https://bwalletx.com',
};
const MIN_SATS = 200; // enough for one small post at 100 sat/kB with room to spare

const { toArray } = Utils;
const PIPE = 0x7c;
const push = (s, v) => s.writeBin(toArray(v, 'utf8'));
const opReturn = () => new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);

export function keys(env) {
  if (!env.BCHAT_ROOT_WIF || !env.BCHAT_SIGN_WIF) return null;
  const root = PrivateKey.fromWif(env.BCHAT_ROOT_WIF);
  const sign = PrivateKey.fromWif(env.BCHAT_SIGN_WIF);
  const rootAddress = root.toAddress();
  // BAP ID = base58(ripemd160(sha256(identity-0 address))), as @1sat/actions computeBapId.
  const bapId = Utils.toBase58(Hash.ripemd160(Utils.toHex(Hash.sha256(rootAddress, 'utf8')), 'hex'));
  return { root, sign, rootAddress, address: sign.toAddress(), bapId };
}

// AIP: BSM over OP_RETURN + every push after it + trailing '|' (bit-sign aipMessage / @1sat getAipMessageBuffer).
function aipSign(script, key) {
  const msg = [];
  let found = false;
  for (const c of script.chunks) {
    if (c.op === OP.OP_RETURN) { msg.push(OP.OP_RETURN); found = true; continue; }
    if (found && c.data?.length) msg.push(...c.data);
  }
  msg.push(PIPE);
  const sig = BSM.sign(msg, key, 'raw');
  const pub = key.toPublicKey();
  const rec = sig.CalculateRecoveryFactor(pub, new BigNumber(BSM.magicHash(msg)));
  const out = new Script(script.chunks.slice());
  out.writeBin([PIPE]);
  push(out, AIP_PREFIX);
  push(out, 'BITCOIN_ECDSA');
  push(out, pub.toAddress());
  out.writeBin(sig.toCompact(rec, true));
  return out;
}

export function postScript(text, k) {
  const s = opReturn();
  push(s, B_PREFIX); push(s, text.trim()); push(s, 'text/markdown'); push(s, 'UTF-8');
  s.writeBin([PIPE]); push(s, MAP_PREFIX); push(s, 'SET');
  for (const v of ['app', 'bChat', 'type', 'post']) push(s, v);
  return aipSign(s, k.sign);
}

export function profileScripts(k) {
  const id = opReturn();
  push(id, BAP_PREFIX); push(id, 'ID'); push(id, k.bapId); push(id, k.address);
  const alias = opReturn();
  push(alias, BAP_PREFIX); push(alias, 'ALIAS'); push(alias, k.bapId); push(alias, JSON.stringify(PROFILE));
  return [aipSign(id, k.root), aipSign(alias, k.sign)];
}

// WhatsOnChain rate-limits (429) shared server IPs: retry with backoff.
async function wocGet(url) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (r.status !== 429 || i >= 4) return r;
    await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
  }
}

async function getJson(url) {
  const r = await wocGet(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

export async function balance(k) {
  const utxos = await getJson(`${WOC}/address/${k.address}/unspent`);
  return { utxos, sats: utxos.reduce((a, u) => a + u.value, 0) };
}

/** Fund, sign and broadcast a tx carrying `scripts` as 0-sat outputs. Returns { txid, rawTx }. */
async function send(k, scripts) {
  const { utxos, sats } = await balance(k);
  if (sats < MIN_SATS) throw Object.assign(new Error(`unfunded: ${sats} sats at ${k.address}`), { unfunded: true });
  const tx = new Transaction();
  for (const u of utxos.sort((a, b) => b.value - a.value).slice(0, 5)) {
    const hex = await (await wocGet(`${WOC}/tx/${u.tx_hash}/hex`)).text();
    tx.addInput({ sourceTransaction: Transaction.fromHex(hex.trim()), sourceOutputIndex: u.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(k.sign) });
  }
  for (const s of scripts) tx.addOutput({ lockingScript: s, satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(k.address), change: true });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();
  const rawTx = tx.toHex();
  const r = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txhex: rawTx }), signal: AbortSignal.timeout(20_000) });
  const body = await r.text();
  if (!r.ok && !/already|known/i.test(body)) throw new Error(`broadcast refused: ${r.status} ${body.slice(0, 200)}`);
  const txid = tx.id('hex');
  const ingested = await Promise.all(INGEST.map((u) =>
    fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawTx }), signal: AbortSignal.timeout(10_000) })
      .then((x) => x.ok).catch(() => false)));
  return { txid, rawTx, ingested };
}

export const publishProfile = (k) => send(k, profileScripts(k));
export const publishPost = (k, text) => send(k, [postScript(text, k)]);
