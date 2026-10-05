#!/usr/bin/env node
// Post the next bWalletX page to X (one per run, rotating). Keys come from .env.local (gitignored), never from code.
// Usage: node xpost.mjs            -> dry run (prints what it would post)
//        node xpost.mjs --post     -> posts for real and advances the rotation
//        node xpost.mjs --text "..." --post   -> one-off post
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const env = Object.fromEntries(
  (fs.existsSync(path.join(dir, '.env.local')) ? fs.readFileSync(path.join(dir, '.env.local'), 'utf8') : '')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const args = process.argv.slice(2);
const live = args.includes('--post');
const oneOff = args.includes('--text') ? args[args.indexOf('--text') + 1] : null;

const statePath = path.join(dir, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { next: 0, line: {}, history: [] };
const posts = JSON.parse(fs.readFileSync(path.join(dir, 'posts.json'), 'utf8'));

let text, pick;
if (oneOff) text = oneOff;
else {
  pick = posts[state.next % posts.length];
  const li = (state.line[pick.url] ?? 0) % pick.lines.length;
  text = `${pick.lines[li]}\n\n${pick.url}`;
}
if (text.length > 280) throw new Error(`too long (${text.length})`);

if (!live) {
  console.log('DRY RUN (add --post to publish):\n\n' + text);
  process.exit(0);
}
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

const r = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
const j = await r.json().catch(() => ({}));
if (!r.ok) {
  console.error('X refused:', r.status, JSON.stringify(j).slice(0, 400));
  process.exit(1);
}
console.log('posted:', `https://x.com/i/web/status/${j.data?.id}`);
if (pick) {
  state.line[pick.url] = (state.line[pick.url] ?? 0) + 1;
  state.next = (state.next + 1) % posts.length;
}
state.history.push({ at: new Date().toISOString(), id: j.data?.id, text });
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
