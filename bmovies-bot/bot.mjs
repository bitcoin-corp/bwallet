// @bmovies_app bot. Every run (launchd, 5 min):
//  a) owner posts (@b0aseX, @b0ase) that mention @bmovies_app → like + repost from @bmovies_app, once each.
//  b) mentions of @bmovies_app → feed queue (queue.json): allowlisted authors 'approved', others 'pending' for b.
//  c) --ingest: send approved, not-yet-sent items to bmovies.app POST /api/featured-tweets/nominate (OFF by default:
//     rows there are picked up by the mint-scouted-tweets cron, which tokenises tweets that have media).
// Flags: --dry-run (read X, log actions, write nothing), --ingest. PAUSED file in this folder = do nothing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appKeys, loadUserTokens, oauthHeader, selectBoosts, classifyMentions, maxId, BOT_HANDLE, OWNER_HANDLES } from './lib.mjs';

const dir = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const ingest = args.includes('--ingest');
const log = (...a) => console.log(new Date().toISOString(), dry ? '[dry]' : '', ...a);
if (fs.existsSync(path.join(dir, 'PAUSED'))) { log('PAUSED: nothing done'); process.exit(0); }

// ── lock (same pattern as xpost.mjs state.lock, own file) ────────────────────
const lockPath = path.join(dir, 'state.lock');
try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); } catch {
  const pid = Number(fs.readFileSync(lockPath, 'utf8'));
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  if (alive) { log('previous run still going; skip'); process.exit(0); }
  fs.writeFileSync(lockPath, String(process.pid));
}
process.on('exit', () => { try { if (fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.rmSync(lockPath); } catch {} });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { if (dry) return; const p = path.join(dir, f); fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(p + '.tmp', p); };
const state = readJson('state.json', {});
state.ids ??= {}; state.since ??= {}; state.boosted ??= {};
const queue = readJson('queue.json', {});
const allowlist = readJson('allowlist.json', []);

if (state.backoffUntil && Date.now() < state.backoffUntil) { log('rate-limited until', new Date(state.backoffUntil).toISOString()); process.exit(0); }

const user = loadUserTokens();
if (!user) { log('no @bmovies_app tokens in Keychain: run ~/Desktop/bmovies-x-auth.sh'); process.exit(dry ? 0 : 1); }
const consumer = appKeys(path.resolve(dir, '..'));
const token = { token: user.token, secret: user.secret };
const botId = user.user_id;

class RateLimited extends Error {}
async function x(method, url, { query = {}, body } = {}) {
  const qs = new URLSearchParams(query).toString();
  const r = await fetch(qs ? `${url}?${qs}` : url, {
    method, signal: AbortSignal.timeout(30_000),
    headers: { Authorization: oauthHeader({ method, url, params: query, consumer, token }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) {
    const reset = Number(r.headers.get('x-rate-limit-reset')) * 1000 || Date.now() + 15 * 60_000;
    state.backoffUntil = reset; writeJson('state.json', state);
    throw new RateLimited(`429 on ${url}; backing off until ${new Date(reset).toISOString()}`);
  }
  if (!r.ok) throw new Error(`X ${method} ${url} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const API = 'https://api.x.com/2';
const fields = { 'tweet.fields': 'author_id,created_at,entities,in_reply_to_user_id,referenced_tweets', expansions: 'author_id', 'user.fields': 'username', max_results: '100' };

try {
  // Owner ids: one lookup, cached.
  const missing = OWNER_HANDLES.filter((h) => !state.ids[h]);
  if (missing.length) {
    const j = await x('GET', `${API}/users/by`, { query: { usernames: missing.join(',') } });
    for (const u of j.data ?? []) state.ids[u.username.toLowerCase()] = u.id;
  }

  // a) boost owner posts
  for (const h of OWNER_HANDLES) {
    const id = state.ids[h]; if (!id) { log('unknown owner account', h); continue; }
    const query = { ...fields, exclude: 'retweets' };
    if (state.since[h]) query.since_id = state.since[h]; else query.max_results = '5'; // first run: only the latest few
    const j = await x('GET', `${API}/users/${id}/tweets`, { query });
    const picks = selectBoosts(j.data ?? [], { botId, done: state.boosted });
    for (const t of picks) {
      log(`boost @${h} ${t.id}: like + repost`);
      if (!dry) {
        await x('POST', `${API}/users/${botId}/likes`, { body: { tweet_id: t.id } });
        await x('POST', `${API}/users/${botId}/retweets`, { body: { tweet_id: t.id } });
        state.boosted[t.id] = { at: new Date().toISOString(), by: h };
        writeJson('state.json', state);
      }
    }
    if (j.meta?.newest_id) state.since[h] = maxId(state.since[h], j.meta.newest_id);
  }

  // b) mentions → queue
  const mq = { ...fields };
  if (state.since.mentions) mq.since_id = state.since.mentions;
  const mj = await x('GET', `${API}/users/${botId}/mentions`, { query: mq });
  const items = classifyMentions(mj.data ?? [], { users: mj.includes?.users ?? [], botId, allowlist, queue });
  for (const it of items) { queue[it.id] = it; log(`queue ${it.status}: @${it.author} ${it.url}`); }
  if (mj.meta?.newest_id) state.since.mentions = maxId(state.since.mentions, mj.meta.newest_id);

  // c) optional ingest into bmovies.app
  if (ingest) {
    for (const it of Object.values(queue).filter((i) => i.status === 'approved' && !i.ingested)) {
      log('ingest', it.url);
      if (dry) continue;
      const r = await fetch('https://www.bmovies.app/api/featured-tweets/nominate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ tweetUrl: it.url, note: 'via @bmovies_app bot', nominatorHandle: BOT_HANDLE }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) it.ingested = { at: new Date().toISOString(), status: j.status };
      else { log('ingest failed', r.status, JSON.stringify(j).slice(0, 200)); if (r.status === 429) break; }
    }
  }

  delete state.backoffUntil;
  writeJson('state.json', state);
  writeJson('queue.json', queue);
  // Moderation list for b / the owner: pending items, newest first.
  const pending = Object.values(queue).filter((i) => i.status === 'pending').sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  if (!dry) fs.writeFileSync(path.join(dir, 'pending.md'), `# @bmovies_app mentions awaiting approval (${pending.length})\n\nApprove: node bmovies-bot/moderate.mjs approve <id>  ·  reject: … reject <id>\n\n` +
    pending.map((i) => `- ${i.id}  @${i.author}  ${i.url}\n  > ${i.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n') + '\n');
  log(`done: ${items.length} new mentions, ${pending.length} pending`);
} catch (e) {
  if (e instanceof RateLimited) { log(e.message); process.exit(0); }
  writeJson('state.json', state);
  log('error:', e.message);
  process.exit(1);
}
