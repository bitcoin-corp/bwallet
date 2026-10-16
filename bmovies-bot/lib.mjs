// Shared pieces for the @bmovies_app bot: OAuth 1.0a signing (same scheme as xpost.mjs), Keychain token
// storage, and the pure selection / dedupe logic the tests cover.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const KEYCHAIN = { service: 'bmovies-x', account: 'bmovies_app' };
export const BOT_HANDLE = 'bmovies_app';
export const OWNER_HANDLES = ['b0asex', 'b0ase'];

// App (consumer) key/secret: the same poster.env xpost.mjs reads. Never printed.
export function readEnv(f) {
  return Object.fromEntries((fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
}
export function appKeys(repoDir) {
  const env = { ...readEnv(process.env.BWX_POSTER_ENV || path.join(os.homedir(), 'Secrets/bwalletx-poster/poster.env')), ...readEnv(path.join(repoDir, '.env.local')) };
  const key = process.env.BMOVIES_X_API_KEY || env.BMOVIES_X_API_KEY || env.X_API_KEY;
  const secret = process.env.BMOVIES_X_API_SECRET || env.BMOVIES_X_API_SECRET || env.X_API_SECRET;
  if (!key || !secret) throw new Error('X app key/secret not found (poster.env X_API_KEY / X_API_SECRET)');
  return { key, secret };
}

export function loadUserTokens() {
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw.trim());
  } catch { return null; }
}

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** OAuth 1.0a header. `params` = query/form params that must be signed (not JSON bodies). */
export function oauthHeader({ method, url, params = {}, consumer, token, extra = {} }) {
  const o = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(token?.token && { oauth_token: token.token }),
    ...extra,
  };
  const all = { ...o, ...params };
  const base = [method.toUpperCase(), enc(url), enc(Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&'))].join('&');
  o.oauth_signature = crypto.createHmac('sha1', `${enc(consumer.secret)}&${enc(token?.secret ?? '')}`).update(base).digest('base64');
  return 'OAuth ' + Object.keys(o).sort().map((k) => `${enc(k)}="${enc(o[k])}"`).join(', ');
}

// ── pure logic ───────────────────────────────────────────────────────────────
const lc = (s) => String(s ?? '').toLowerCase();
export const mentionsHandle = (t, handle) =>
  (t.entities?.mentions ?? []).some((m) => lc(m.username) === lc(handle)) || new RegExp(`@${handle}\\b`, 'i').test(t.text ?? '');
const isRetweet = (t) => (t.referenced_tweets ?? []).some((r) => r.type === 'retweeted');

/** Owner posts to like + repost from the bot: mention the bot, not done before, no retweets, no replies to the bot. */
export function selectBoosts(tweets, { botId, done = {} }) {
  const seen = new Set();
  return tweets.filter((t) => {
    if (!t?.id || seen.has(t.id) || done[t.id]) return false;
    seen.add(t.id);
    if (t.author_id === botId) return false;
    if (isRetweet(t)) return false;
    if (t.in_reply_to_user_id && t.in_reply_to_user_id === botId) return false; // reply-to-bot loop
    return mentionsHandle(t, BOT_HANDLE);
  });
}

/** Mentions → feed queue items. Allowlisted authors auto-approved; everyone else pending for b. Text snippet only, no media. */
export function classifyMentions(tweets, { users = [], botId, allowlist = [], queue = {} }) {
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const allow = new Set([...OWNER_HANDLES, ...allowlist].map(lc));
  const out = [];
  for (const t of tweets) {
    if (!t?.id || queue[t.id] || out.some((o) => o.id === t.id)) continue;
    if (t.author_id === botId || isRetweet(t)) continue;
    const handle = byId[t.author_id]?.username ?? null;
    out.push({
      id: t.id,
      url: `https://x.com/${handle ?? 'i/web'}/status/${t.id}`,
      author: handle, author_id: t.author_id,
      text: (t.text ?? '').slice(0, 280),
      created_at: t.created_at ?? null,
      status: handle && allow.has(lc(handle)) ? 'approved' : 'pending',
      queued_at: new Date().toISOString(),
    });
  }
  return out;
}

export const maxId = (a, b) => (!a ? b : !b ? a : BigInt(a) >= BigInt(b) ? a : b);
