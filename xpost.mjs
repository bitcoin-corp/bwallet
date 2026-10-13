#!/usr/bin/env node
// Post the next bWalletX queue item to X (@bWalletX), the bChat feed (official bWalletX poster) and Twetch (@bWalletX).
// The queue is posts.json, in order. Each item posts ONCE per channel; when the queue ends, nothing more posts.
// Keys come from .env.local (X) and $BWX_POSTER_ENV or ~/Secrets/bwalletx-poster/poster.env (bChat; Twetch's
// TWETCH_SIGN_WIF too), never from code.
//
//   node xpost.mjs                  dry run: show what each channel would post next
//   node xpost.mjs --post           post the next item on each channel
//   node xpost.mjs --post --daily   scheduler mode: only acts at 10:xx Europe/London, once per London day
//   --x-only / --bchat-only / --twetch-only   limit to one channel
//   node xpost.mjs --twetch-pace 3|off   pace Twetch to one post per N hours (owner, 11 Oct 2026: a small community,
//                                  don't flood it). While paced, the daily run skips Twetch and a separate cron runs
//                                  `xpost.mjs --post --twetch-only --paced`, which posts only if N hours have passed.
//   node xpost.mjs --post --url U   post just the queue item with url U (blog.mjs uses this at publish time)
//   node xpost.mjs --text "..." --post   one-off X post (not part of the queue)
//   node xpost.mjs --profile --post publish the bChat posting profile now (normally automatic before the first post)
//   node xpost.mjs --recycle on|off|status   recycle mode (default off): once the queue is finished, repost ONE
//                                  already-posted item a day, oldest-posted first, using its next alternative line;
//                                  never the same URL twice within 30 days. Off: queue finished, nothing posts.
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
const only = ['--x-only', '--bchat-only', '--twetch-only'].find((f) => args.includes(f));
const doX = !only || only === '--x-only';
const doBchat = (!only || only === '--bchat-only') && !oneOff;
const doTwetch = (!only || only === '--twetch-only') && !oneOff;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const paceArg = args.indexOf('--twetch-pace');
if (fs.existsSync(path.join(dir, 'PAUSED'))) { log('PAUSED file present: nothing posted'); process.exit(0); }

// ── state ────────────────────────────────────────────────────────────────────
const statePath = path.join(dir, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
state.x ??= { posted: {} };
state.bchat ??= { profile: null, posted: {} };
if (!state.twetch) {
  // First run: start Twetch level with bChat instead of replaying the whole backlog one a day.
  state.twetch = { posted: Object.fromEntries(Object.keys(state.bchat.posted).map((u) => [u, { at: new Date().toISOString(), skipped: 'already posted elsewhere before Twetch was added' }])) };
}
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

state.recycle ??= { enabled: false };

if (paceArg >= 0) {
  const v = args[paceArg + 1];
  if (v === 'off') delete state.twetch.paceHours;
  else if (Number(v) > 0) state.twetch.paceHours = Number(v);
  else { console.log('usage: --twetch-pace <hours>|off'); process.exit(1); }
  save();
  console.log(state.twetch.paceHours ? `Twetch paced: one post every ${state.twetch.paceHours} h (daily run skips Twetch)` : 'Twetch pacing off: Twetch posts with the daily run');
  process.exit(0);
}

if (args.includes('--recycle')) {
  const v = args[args.indexOf('--recycle') + 1];
  if (v === 'on' || v === 'off') { state.recycle.enabled = v === 'on'; save(); }
  else if (v !== 'status') { console.error('usage: node xpost.mjs --recycle on|off|status'); process.exit(2); }
  console.log(`recycle: ${state.recycle.enabled ? 'ON' : 'OFF'}`);
  process.exit(0);
}

const posts = JSON.parse(fs.readFileSync(path.join(dir, 'posts.json'), 'utf8'));
// Published nightly blog posts (blog.mjs, server-only file): posted at publish time with --url, so they are
// already marked posted here and the daily queue never repeats them.
const blogQueue = path.join(dir, 'posts-blog.json');
if (fs.existsSync(blogQueue)) posts.push(...JSON.parse(fs.readFileSync(blogQueue, 'utf8')).filter((b) => !posts.some((p) => p.url === b.url)));
const onlyUrl = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const textOf = (p) => `${p.lines[0]}\n\n${p.url}`;
for (const p of posts) if (textOf(p).length > 280) throw new Error(`too long (${textOf(p).length}): ${p.url}`);
for (const p of posts) for (const l of p.lines) if (`${l}\n\n${p.url}`.length > 280) throw new Error(`too long: ${p.url}`);
const nextFor = (ch) => posts.find((p) => !state[ch].posted[p.url] && (!onlyUrl || p.url === onlyUrl)) ?? null;

// Twetch order (owner, 13 Oct 2026: "not very impressed with our Twetch feed"): newest blog posts first, then
// pages in queue order. Near-duplicates are skipped for good: the same page under another ?v= or a trailing
// slash, or a /releases link (versions go stale; the releases post is made by hand).
const normUrl = (u) => { try { const x = new URL(u); return (x.host + x.pathname).replace(/\/+$/, '').toLowerCase(); } catch { return u; } };
const blogNo = (u) => Number(u.match(/\/blog\/(\d{3})-/)?.[1] ?? -1);
function nextTwetch() {
  const done = new Set(Object.keys(state.twetch.posted).filter((u) => !state.twetch.posted[u].skipped?.startsWith('near-duplicate')).map(normUrl));
  const pending = [];
  for (const p of posts) {
    if (state.twetch.posted[p.url] || (onlyUrl && p.url !== onlyUrl)) continue;
    if (!onlyUrl && (done.has(normUrl(p.url)) || /\/releases\b/.test(p.url))) {
      if (live) state.twetch.posted[p.url] = { at: new Date().toISOString(), skipped: 'near-duplicate or stale' };
      continue;
    }
    done.add(normUrl(p.url));
    pending.push(p);
  }
  return pending.filter((p) => blogNo(p.url) >= 0).sort((a, b) => blogNo(b.url) - blogNo(a.url))[0] ?? pending[0] ?? null;
}

// Recycle: when the queue is finished and recycle is on, pick the posted item whose most recent post (first or
// recycled) is oldest, skipping anything posted within 30 days. Alternate lines rotate: lines[1], lines[2], ... then lines[0].
const DAY = 86_400_000;
const lastAt = (ch, url) => {
  const ts = [state[ch].posted[url]?.at, ...state.history.filter((h) => h.channel === ch && h.url === url).map((h) => h.at)];
  return Math.max(...ts.filter(Boolean).map((t) => Date.parse(t)));
};
const recycleFor = (ch) => {
  if (!state.recycle.enabled || onlyUrl) return null;
  const now = Date.now();
  const p = posts.filter((p) => state[ch].posted[p.url] && now - lastAt(ch, p.url) >= 30 * DAY)
    .sort((a, b) => lastAt(ch, a.url) - lastAt(ch, b.url))[0];
  if (!p) return null;
  const n = state.history.filter((h) => h.channel === ch && h.url === p.url && h.recycled).length;
  const line = p.lines.length > 1 ? p.lines[1 + (n % p.lines.length)] ?? p.lines[0] : p.lines[0];
  return { p, text: `${line}\n\n${p.url}` };
};

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
  const rc = p ? null : recycleFor('x');
  if (!p && rc && !live) console.log(`X recycle next:\n\n${rc.text}\n`);
  else if (!p && rc) {
    try {
      const id = await postToX(rc.text);
      const at = new Date().toISOString();
      state.history.push({ at, channel: 'x', url: rc.p.url, id, text: rc.text, recycled: true });
      save();
      log('X recycled:', rc.p.url, `https://x.com/i/web/status/${id}`);
    } catch (e) { failed = true; log('X FAILED:', e.message); }
  }
  else if (!p) log(state.recycle.enabled ? 'X: queue finished, nothing eligible to recycle (30-day rule)' : 'X: queue finished');
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
  const p0 = nextFor('bchat');
  const rc = p0 ? null : recycleFor('bchat');
  const p = p0 ?? rc?.p ?? null;
  const text = rc ? rc.text : p && textOf(p);
  if (!bchat) { /* load error logged above */ }
  else if (!k) log('bChat: no poster keys (BCHAT_ROOT_WIF / BCHAT_SIGN_WIF), skipped');
  else if (!p && !args.includes('--profile')) log(state.recycle.enabled ? 'bChat: queue finished, nothing eligible to recycle (30-day rule)' : 'bChat: queue finished');
  else {
    let funded = 0;
    try { funded = (await bchat.balance(k)).sats; } catch (e) { log('bChat: balance check failed:', e.message); }
    if (!live) {
      console.log(`bChat poster ${k.address} (BAP ${k.bapId}), balance ${funded} sats, profile ${state.bchat.profile ? 'published ' + state.bchat.profile.txid : 'NOT yet published'}`);
      if (p) console.log(`bChat ${rc ? 'recycle next' : `next (${posts.indexOf(p) + 1}/${posts.length})`}:\n\n${text}\n`);
      if (p) {
        try { const d = await bchat.publishPost(k, text, { dry: true }); console.log(`bChat dry tx ${d.txid} spends ${d.input} (from ${d.source}), ${d.rawTx.length / 2} bytes`); }
        catch (e) { log('bChat dry build failed:', e.message); }
      }
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
          const r = await bchat.publishPost(k, text);
          const at = new Date().toISOString();
          if (!rc) state.bchat.posted[p.url] = { at, txid: r.txid };
          state.history.push({ at, channel: 'bchat', url: p.url, txid: r.txid, ...(rc && { text, recycled: true }) });
          save();
          log('bChat posted:', p.url, r.txid, 'ingested', r.ingested);
          if (!rc && !nextFor('bchat')) log('bChat: that was the last item, queue finished');
        }
      } catch (e) { failed = true; log('bChat FAILED:', e.message); }
    }
  }
}

// ── Twetch ───────────────────────────────────────────────────────────────────
// Same queue, posted once per item, signed by the bWalletX Twetch key (twetch.mjs), fee from the bChat poster.
// Runs after bChat so the two share the poster's UTXO ledger one transaction at a time.
const pace = state.twetch.paceHours;
const lastTwetch = Math.max(0, ...state.history.filter((h) => h.channel === 'twetch').map((h) => Date.parse(h.at) || 0));
const paceWait = pace ? lastTwetch + pace * 3600_000 - 10 * 60_000 - Date.now() : 0; // 10 min slack for cron timing
if (doTwetch && pace && live && !onlyUrl && !args.includes('--paced')) log(`Twetch: paced (one every ${pace} h), left to its own cron`);
else if (doTwetch && pace && live && !onlyUrl && paceWait > 0) log(`Twetch: paced, next post in ${Math.ceil(paceWait / 60_000)} min`);
else if (doTwetch) {
  let tw = null, bchatMod = null, k = null, key = null;
  try {
    bchatMod = await import('./bchat.mjs'); tw = await import('./twetch.mjs');
    k = bchatMod.keys(env); key = tw.twetchKey(env);
  } catch (e) { failed = true; log('Twetch: could not load poster:', e.message); }
  const p0 = nextTwetch();
  const rc = p0 ? null : recycleFor('twetch');
  const p = p0 ?? rc?.p ?? null;
  const text = rc ? rc.text : p && textOf(p);
  if (!tw) { /* load error logged above */ }
  else if (!key) log('Twetch: no TWETCH_SIGN_WIF in the poster env, skipped');
  else if (!k) log('Twetch: no bChat poster keys to pay the fee (BCHAT_ROOT_WIF / BCHAT_SIGN_WIF), skipped');
  else if (!p) log(state.recycle.enabled ? 'Twetch: queue finished, nothing eligible to recycle (30-day rule)' : 'Twetch: queue finished');
  else if (!live) {
    console.log(`Twetch as @bWalletX (${tw.TWETCH_ADDRESS}), fee from ${k.address}`);
    console.log(`Twetch ${rc ? 'recycle next' : `next (${posts.indexOf(p) + 1}/${posts.length})`}:\n\n${text}\n`);
    const image = await tw.ogImage(p.url);
    console.log(image ? `Twetch image: ${image.src} -> ${image.mime} ${image.bytes.length} bytes` : 'Twetch image: none (text + link card only)');
    try { const d = await tw.publishTwetch(k, key, text, { dry: true, image }); console.log(`Twetch dry tx ${d.txid} spends ${d.input} (from ${d.source}), ${d.rawTx.length / 2} bytes`); }
    catch (e) { log('Twetch dry build failed:', e.message); }
  } else {
    try {
      const image = await tw.ogImage(p.url);
      const r = await tw.publishTwetch(k, key, text, { image });
      const at = new Date().toISOString();
      if (!rc) state.twetch.posted[p.url] = { at, txid: r.txid, ...(r.twetch?.id && { twetchId: r.twetch.id }), ...(image && { image: image.src }) };
      state.history.push({ at, channel: 'twetch', url: p.url, txid: r.txid, ...(rc && { text, recycled: true }) });
      save();
      log('Twetch posted:', p.url, r.txid, r.twetch?.id ? `twetch post ${r.twetch.id}` : `NOT registered with Twetch: ${r.twetchError}`);
      if (r.twetchError) failed = true;
      if (!rc && !onlyUrl && !nextTwetch()) log('Twetch: that was the last item, queue finished');
    } catch (e) { failed = true; log('Twetch FAILED:', e.message); }
  }
}

if (!live) console.log('(dry run: add --post to publish)');
process.exit(failed ? 1 : 0);
