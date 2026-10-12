// bChat posting for the official bWalletX account. Builds posts exactly as bChat does
// (bit-sign src/lib/feed/script.ts: B text/markdown | MAP SET app bChat type post | AIP BITCOIN_ECDSA),
// pays from the poster key, broadcasts via WhatsOnChain, then hands the raw tx to the feed indexers.
// Keys come from the environment only (BCHAT_ROOT_WIF, BCHAT_SIGN_WIF), never from code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
function aipSign(script, key, b64 = false) {
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
  // Twetch only indexes a base64 text signature; bChat indexers take raw bytes.
  if (b64) push(out, sig.toCompact(rec, true, 'base64'));
  else out.writeBin(sig.toCompact(rec, true));
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
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function wocGet(url) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e), json: async () => null }));
    if ((r.status !== 429 && r.status !== 0) || i >= 5) return r;
    await sleep(4000 * (i + 1));
  }
}

async function getJson(url) {
  const r = await wocGet(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/** Raw hex of a tx, validated (a 429/HTML body used to reach Transaction.fromHex: "Invalid hex string"). */
async function txHex(txid) {
  const r = await wocGet(`${WOC}/tx/${txid}/hex`);
  const hex = r.ok ? (await r.text()).trim() : '';
  if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) return hex;
  const g = await fetch(`https://junglebus.gorillapool.io/v1/transaction/get/${txid}/bin`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (g?.ok) return Buffer.from(await g.arrayBuffer()).toString('hex');
  throw new Error(`could not fetch tx ${txid} (woc ${r.status})`);
}

// ── UTXO ledger ─────────────────────────────────────────────────────────────
// 7 Oct 2026: WoC /unspent kept listing an output already spent by our own unconfirmed tx, so every
// post reused it (DOUBLE_SPEND_ATTEMPTED). We now chain from our own last change output and remember
// every outpoint we have spent, so WoC's view is only a fallback, and checked.
const LEDGER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bchat-utxo.json');
// One ledger per paying address: the bChat poster keeps bchat-utxo.json; any other payer (the Twetch key) gets its own file.
let ledgerAddr = null;
const ledgerPath = () => (ledgerAddr ? LEDGER.replace(/\.json$/, `-${ledgerAddr}.json`) : LEDGER);
const ledgerLoad = () => { try { return JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')); } catch { return { spent: [], tip: null }; } };
function ledgerSave(l) {
  l.spent = l.spent.slice(-500);
  fs.writeFileSync(ledgerPath() + '.tmp', JSON.stringify(l, null, 2));
  fs.renameSync(ledgerPath() + '.tmp', ledgerPath());
}

export async function balance(k) {
  ledgerAddr = k.ledger ?? null;
  const l = ledgerLoad();
  if (l.tip && !l.spent.includes(`${l.tip.txid}:${l.tip.vout}`)) return { utxos: [l.tip], sats: l.tip.value, source: 'tip' };
  const utxos = await spendable(k, l);
  return { utxos, sats: utxos.reduce((a, u) => a + u.value, 0), source: 'woc' };
}

/** WoC unspent minus: outpoints we spent, outpoints consumed by our unconfirmed txs, and anything WoC says is spent. */
async function spendable(k, l) {
  const list = await getJson(`${WOC}/address/${k.address}/unspent`);
  const spent = new Set(l.spent);
  for (const u of list.filter((u) => !u.height)) {
    try { for (const i of Transaction.fromHex(await txHex(u.tx_hash)).inputs) spent.add(`${i.sourceTXID}:${i.sourceOutputIndex}`); } catch {}
  }
  const out = [];
  for (const u of list) {
    const op = `${u.tx_hash}:${u.tx_pos}`;
    if (spent.has(op)) continue;
    const r = await wocGet(`${WOC}/tx/${u.tx_hash}/${u.tx_pos}/spent`);
    if (r.status === 404) out.push({ txid: u.tx_hash, vout: u.tx_pos, value: u.value });
    else if (!r.ok && r.status !== 200) out.push({ txid: u.tx_hash, vout: u.tx_pos, value: u.value, unchecked: true });
  }
  return out.sort((a, b) => (a.unchecked ? 1 : 0) - (b.unchecked ? 1 : 0) || b.value - a.value);
}

const ARC = 'https://arc.gorillapool.io/v1/tx';

async function txKnown(txid) {
  const a = await fetch(`${ARC}/${txid}`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (a && /SEEN|MINED|STORED|ANNOUNCED|SENT|ACCEPTED/i.test(a.txStatus ?? '') && !/DOUBLE|REJECT|ORPHAN/i.test(a.txStatus)) return true;
  const w = await wocGet(`${WOC}/tx/hash/${txid}`);
  return w.ok;
}

/**
 * Broadcast: WhatsOnChain first, retrying 429s with backoff (7 Oct 2026: a 429 lost the day's bChat post),
 * then GorillaPool ARC. "Already known", or our own txid visible afterwards, counts as success.
 */
async function broadcast(rawTx, txid) {
  const errors = [];
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txhex: rawTx }), signal: AbortSignal.timeout(20_000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    const body = await r.text();
    if (r.ok || /already|known/i.test(body)) return 'woc';
    errors.push(`woc ${r.status} ${body.slice(0, 80)}`);
    if (r.status !== 429 && r.status !== 0 && r.status < 500) break;
    await sleep(5000 * (i + 1));
  }
  const r = await fetch(ARC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawTx }), signal: AbortSignal.timeout(20_000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const body = await r.text();
  let status = '';
  try { status = JSON.parse(body).txStatus ?? ''; } catch {}
  // SEEN_IN_ORPHAN_MEMPOOL is not a broadcast: ARC lacks the parent and the tx never reaches miners (11-12 Oct 2026:
  // ten posts chained off one orphan were logged as posted but never landed).
  if (r.ok && !/REJECTED|DOUBLE_SPEND|INVALID|MALFORMED|ORPHAN/i.test(status) || /already|known/i.test(body)) return 'arc';
  await sleep(3000);
  if (await txKnown(txid)) return 'known';
  throw Object.assign(new Error(`broadcast refused: ${errors.join(', ')}; arc ${r.status} ${(status || body).slice(0, 200)}`), { doubleSpend: /DOUBLE_SPEND/i.test(status + body) });
}

/** Fund, sign and broadcast a tx carrying `scripts` as 0-sat outputs. Returns { txid, rawTx }. dry: build only. */
async function send(k, scripts, { dry = false, ingest = true } = {}) {
  const l = ledgerLoad();
  const { utxos, sats, source } = await balance(k);
  if (sats < MIN_SATS) throw Object.assign(new Error(`unfunded: ${sats} sats at ${k.address}`), { unfunded: true });
  const u = utxos[0]; // one input: balance is ample, and fewer inputs means fewer stale-UTXO collisions
  const tx = new Transaction();
  const src = Transaction.fromHex(u.rawTx ?? await txHex(u.txid));
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: u.vout, unlockingScriptTemplate: new P2PKH().unlock(k.sign) });
  for (const s of scripts) tx.addOutput({ lockingScript: s, satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(k.address), change: true });
  await tx.fee(new SatoshisPerKilobyte(100));
  await tx.sign();
  const rawTx = tx.toHex();
  const txid = tx.id('hex');
  const op = `${u.txid}:${u.vout}`;
  if (dry) return { txid, rawTx, dry: true, input: op, source };
  try {
    await broadcast(rawTx, txid);
  } catch (e) {
    if (e.doubleSpend) { l.spent.push(op); if (l.tip && `${l.tip.txid}:${l.tip.vout}` === op) l.tip = null; ledgerSave(l); }
    throw e;
  }
  const vout = tx.outputs.length - 1;
  l.spent.push(op);
  l.tip = { txid, vout, value: tx.outputs[vout].satoshis, rawTx };
  ledgerSave(l);
  const ingested = !ingest ? [] : await Promise.all(INGEST.map((u) =>
    fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawTx }), signal: AbortSignal.timeout(10_000) })
      .then((x) => x.ok).catch(() => false)));
  return { txid, rawTx, ingested };
}

export const publishProfile = (k, o) => send(k, profileScripts(k), o);
export const publishPost = (k, text, o) => send(k, [postScript(text, k)], o);
/** Any ready-made 0-sat scripts, paid from the bChat poster key (used by twetch.mjs). */
export const publishScripts = (k, scripts, o) => send(k, scripts, o);
export { aipSign, opReturn, push, B_PREFIX, MAP_PREFIX, PIPE };
