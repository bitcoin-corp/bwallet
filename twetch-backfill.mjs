// Register already-broadcast Twetch post txs with Twetch (POST /v1/posts), for posts broadcast before
// registerTwetch() existed (11–13 Oct 2026). Reads the post text back out of the tx, so content matches exactly.
//   node twetch-backfill.mjs <txid> [<txid> ...]          dry run: prints each post's text
//   node twetch-backfill.mjs --post [--gap <sec>] <txid>...  registers them in the order given (newest last)
// Key: TWETCH_SIGN_WIF from .env.local, $BWX_POSTER_ENV or ~/Secrets/bwalletx-poster/poster.env, never from code.
import fs from 'fs'; import os from 'os'; import path from 'path';
import { Transaction } from '@bsv/sdk';
import { registerTwetch, twetchKey } from './twetch.mjs';

const args = process.argv.slice(2);
const live = args.includes('--post');
const gi = args.indexOf('--gap'); const gap = gi >= 0 ? Number(args[gi + 1]) : 20;
const txids = args.filter((a, i) => /^[0-9a-f]{64}$/.test(a) && args[i - 1] !== '--gap');
const envFile = process.env.BWX_POSTER_ENV || path.join(os.homedir(), 'Secrets/bwalletx-poster/poster.env');
const env = { ...process.env };
for (const f of [path.join(path.dirname(new URL(import.meta.url).pathname), '.env.local'), envFile]) if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, ''); }

/** Pushes of an OP_FALSE OP_RETURN script, as Buffers. */
function pushes(script) {
  const b = Buffer.from(script.toBinary()); const out = []; let p = 0;
  while (p < b.length) { const op = b[p++]; let n = -1;
    if (op > 0 && op < 76) n = op; else if (op === 76) n = b[p++]; else if (op === 77) { n = b.readUInt16LE(p); p += 2; } else if (op === 78) { n = b.readUInt32LE(p); p += 4; }
    if (n < 0) continue; out.push(b.subarray(p, p + n)); p += n; }
  return out;
}

const key = live ? twetchKey(env) : null;
if (live && !key) { console.error('no TWETCH_SIGN_WIF'); process.exit(2); }
for (const [i, txid] of txids.entries()) {
  const listed = await fetch(`https://api.twetch.com/v1/posts/by-txid/${txid}`).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (listed?.post?.id ?? listed?.id) { console.log(txid, 'already listed as', listed?.post?.id ?? listed?.id); continue; }
  let raw = '';
  for (let a = 0; a < 8 && !/^[0-9a-f]+$/.test(raw); a++) {
    if (a) await new Promise((ok) => setTimeout(ok, 3000 * a)); // WhatsOnChain 429s
    raw = (await (await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)).text()).trim();
  }
  if (!/^[0-9a-f]+$/.test(raw)) { console.log(txid, 'not on chain (never landed), skipped'); continue; }
  const tx = Transaction.fromHex(raw);
  const p = pushes(tx.outputs[0].lockingScript);
  const text = p[1].toString('utf8');
  console.log(`\n${txid}\n${text}`);
  if (!live) continue;
  try { const r = await registerTwetch(key, text, raw); console.log('-> twetch post', r.id ?? JSON.stringify(r).slice(0, 200)); }
  catch (e) { console.log('-> FAILED', e.message); }
  if (i < txids.length - 1) await new Promise((ok) => setTimeout(ok, gap * 1000));
}
