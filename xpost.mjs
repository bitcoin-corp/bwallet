#!/usr/bin/env node
// Post the next bWalletX queue item to X (@bWalletX) and to the bChat feed (official bWalletX poster).
// The queue is posts.json, in order. Each item posts ONCE per channel; when the queue ends, nothing more posts.
// Keys come from .env.local (X) and $BWX_POSTER_ENV or ~/Secrets/bwalletx-poster/poster.env (bChat), never from code.
//
//   node xpost.mjs                  dry run: show what each channel would post next
//   node xpost.mjs --post           post the next item on each channel
//   node xpost.mjs --post --daily   scheduler mode: only acts at 10:xx Europe/London, once per London day
//   --x-only / --bchat-only         limit to one channel
//   node xpost.mjs --text "..." --post   one-off X post (not part of the queue)
//   node xpost.mjs --profile --post publish the bChat posting profile now (normally automatic before the first post)
// Pause: create a file named PAUSED next to this script (touch PAUSED). Remove it to resume.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const readEnv = (f) => Object.fromEntries(
  (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const env = {
  ...readEnv(process.env.BWX_POSTER_ENV || path.join(os.homedir(), 'Secrets/bwalletx-poster/poster.env')),
  ...readEnv(path.join(dir, '.env.local')),
};
const args = process.argv.slice(2);
const live = args.includes('--post');
const daily = args.includes('--daily');
const oneOff = args.includes('--text') ? args[args.indexOf('--text') + 1] : null;
const doX = !args.includes('--bchat-only');
const doBchat = !args.includes('--x-only') && !oneOff;
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (fs.existsSync(path.join(dir, 'PAUSED'))) { log('PAUSED file present: nothing posted'); process.exit(0); }

// ── state ────────────────────────────────────────────────────────────────────
const statePath = path.join(dir, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
state.x ??= { posted: {} };
state.bchat ??= { profile: null, posted: {} };
state.history ??= [];
// Migrate the old rotation format: anything already in history counts as posted to X.
for (const h of state.history) {
  const url = h.url ?? h.text?.match(/https:\/\/\S+$/)?.[0];
  if (url && h.id && (h.channel ?? 'x') === 'x' && !state.x.posted[url]) state.x.posted[url] = { at: h.at, id: h.id };
}
delete state.next; delete state.line;
const save = () => {
  fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(statePath + '.tmp', statePath);
};

const posts = JSON.parse(fs.readFileSync(path.join(dir, 'posts.json'), 'utf8'));
const textOf = (p) => `${p.lines[0]}\n\n${p.url}`;
for (const p of posts) if (textOf(p).length > 280) throw new Error(`too long (${textOf(p).length}): ${p.url}`);
const nextFor = (ch) => posts.find((p) => !state[ch].posted[p.url]) ?? null;

// ── scheduler gate ───────────────────────────────────────────────────────────
if (daily) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (parts.hour !== '10') process.exit(0); // cron fires at 09:00 and 10:00 UTC; only the London-10:00 one acts
  if (live && state.lastDaily === today) { log('already ran today', today); process.exit(0); }
  if (live) { state.lastDaily = today; save(); }
}

// ── X ────────────────────────────────────────────────────────────────────────
async function postToX(text) {
  for (const k of ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'])
    if (!env[k] || env[k] === 'your-key-here') throw new Error(`missing ${k} in .env.local`);
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const url = 'https://api.x.com/2/tweets';
  const oauth = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const base = ['POST', enc(url), enc(Object.keys(oauth).sort().map((k) => `${enc(k)}=${enc(oauth[k])}`).join('&'))].join('&');
  oauth.oauth_signature = crypto.createHmac('sha1', `${enc(env.X_API_SECRET)}&${enc(env.X_ACCESS_SECRET)}`).update(base).digest('base64');
  const auth = 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`X refused: ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return j.data?.id;
}

let failed = false;

if (oneOff) {
  if (oneOff.length > 280) throw new Error(`too long (${oneOff.length})`);
  if (!live) { console.log('DRY RUN one-off X post:\n\n' + oneOff); process.exit(0); }
  const id = await postToX(oneOff);
  state.history.push({ at: new Date().toISOString(), channel: 'x', id, text: oneOff, oneOff: true });
  save();
  log('X one-off posted:', `https://x.com/i/web/status/${id}`);
  process.exit(0);
}

if (doX) {
  const p = nextFor('x');
  if (!p) log('X: queue finished, nothing to post');
  else if (!live) console.log(`X next (${posts.indexOf(p) + 1}/${posts.length}):\n\n${textOf(p)}\n`);
  else {
    try {
      const id = await postToX(textOf(p));
      const at = new Date().toISOString();
      state.x.posted[p.url] = { at, id };
      state.history.push({ at, channel: 'x', url: p.url, id, text: textOf(p) });
      save();
      log('X posted:', p.url, `https://x.com/i/web/status/${id}`);
      if (!nextFor('x')) log('X: that was the last item, queue finished');
    } catch (e) { failed = true; log('X FAILED:', e.message); }
  }
}

// ── bChat ────────────────────────────────────────────────────────────────────
if (doBchat) {
  let bchat = null, k = null;
  try { bchat = await import('./bchat.mjs'); k = bchat.keys(env); } catch (e) { failed = true; log('bChat: could not load poster:', e.message); }
  const p = nextFor('bchat');
  if (!bchat) { /* load error logged above */ }
  else if (!k) log('bChat: no poster keys (BCHAT_ROOT_WIF / BCHAT_SIGN_WIF), skipped');
  else if (!p && !args.includes('--profile')) log('bChat: queue finished, nothing to post');
  else {
    let funded = 0;
    try { funded = (await bchat.balance(k)).sats; } catch (e) { log('bChat: balance check failed:', e.message); }
    if (!live) {
      console.log(`bChat poster ${k.address} (BAP ${k.bapId}), balance ${funded} sats, profile ${state.bchat.profile ? 'published ' + state.bchat.profile.txid : 'NOT yet published'}`);
      if (p) console.log(`bChat next (${posts.indexOf(p) + 1}/${posts.length}):\n\n${textOf(p)}\n`);
    } else if (funded < 200) {
      log(`bChat: poster unfunded (${funded} sats). Send BSV to ${k.address}. Skipped.`);
    } else {
      try {
        if (!state.bchat.profile) {
          const r = await bchat.publishProfile(k);
          state.bchat.profile = { at: new Date().toISOString(), txid: r.txid, bapId: k.bapId, address: k.address };
          save();
          log('bChat profile published:', r.txid, 'ingested', r.ingested);
        }
        if (p && !args.includes('--profile')) {
          const r = await bchat.publishPost(k, textOf(p));
          const at = new Date().toISOString();
          state.bchat.posted[p.url] = { at, txid: r.txid };
          state.history.push({ at, channel: 'bchat', url: p.url, txid: r.txid });
          save();
          log('bChat posted:', p.url, r.txid, 'ingested', r.ingested);
          if (!nextFor('bchat')) log('bChat: that was the last item, queue finished');
        }
      } catch (e) { failed = true; log('bChat FAILED:', e.message); }
    }
  }
}

if (!live) console.log('(dry run: add --post to publish)');
process.exit(failed ? 1 : 0);
