#!/usr/bin/env node
// Nightly "what we built today" blog (owner, 6 Oct 2026): at 22:00 Europe/London, read the day's commits; if
// anything user-facing shipped, draft a post with Claude, render a private preview and a share image, and DM it
// to the owner ($boase) from $bwalletx in bChat. His reply decides: "go" publishes to bwalletx.com and posts it
// to X and bChat at once; "skip" drops it; anything else is treated as edits, and a revised draft comes back.
//
//   node blog.mjs --nightly          cron mode: only acts at 22:xx London, once per London day
//   node blog.mjs --nightly --force  run now for today (still once per day unless --again)
//   node blog.mjs --draft-only       collect + draft + preview, print, no DM, no state change
//   node blog.mjs --test-dm          send a TEST draft DM (labelled; "go" on it never publishes)
//   node blog.mjs --reply            read one forwarded DM reply (JSON) on stdin; called by the push server
//   node blog.mjs --status           show the current draft and settings
// Secrets: .env.blog next to this script (ANTHROPIC_API_KEY, BWALLETX_AGENT_SECRET, GITHUB_TOKEN_*), never git.
// Pause: touch PAUSED-BLOG next to this script.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  addToIndex, dmText, filterCommits, linkNext, londonDayBounds, londonLabel, londonNow, nextNumber, pad3,
  parseIndex, parseReply, renderPost, slugify,
} from './blog/lib.mjs';
import { collect, siteCheckout } from './blog/github.mjs';
import { writeDraft, reviseDraft } from './blog/draft.mjs';
import { sharePng } from './blog/image.mjs';
import { sendDm } from './blog/bitsign.mjs';

const dir = path.dirname(new URL(import.meta.url).pathname);
const readEnv = (f) => Object.fromEntries(
  (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const env = { ...readEnv(path.join(dir, '.env.blog')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('BLOG_'))) };
const args = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString(), '[blog]', ...a);
const STATE_DIR = env.BLOG_STATE_DIR || path.join(dir, 'blog-state');
const DRAFTS = path.join(STATE_DIR, 'drafts');
const PREVIEW_BASE = env.BLOG_PREVIEW_BASE || 'https://push.bwalletx.com';
const TEMPLATE = fs.readFileSync(path.join(dir, 'blog/post-template.html'), 'utf8');
const SAMPLES = fs.readFileSync(path.join(dir, 'blog/style-samples.txt'), 'utf8');
fs.mkdirSync(DRAFTS, { recursive: true });

// ── state + lock ─────────────────────────────────────────────────────────────
const statePath = path.join(STATE_DIR, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { current: null, nights: {} };
const save = () => { fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(statePath + '.tmp', statePath); };
const lockPath = path.join(STATE_DIR, 'lock');
function lock() {
  for (let i = 0; i < 120; i++) {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return; } catch {
      const pid = Number(fs.readFileSync(lockPath, 'utf8'));
      try { process.kill(pid, 0); } catch { fs.rmSync(lockPath, { force: true }); continue; }
      execFileSync('sleep', ['1']);
    }
  }
  throw new Error('blog lock busy');
}
lock();
process.on('exit', () => fs.rmSync(lockPath, { force: true }));

const draftDir = (id) => path.join(DRAFTS, id);
const loadDraft = (id) => JSON.parse(fs.readFileSync(path.join(draftDir(id), 'draft.json'), 'utf8'));
const saveDraft = (rec) => fs.writeFileSync(path.join(draftDir(rec.id), 'draft.json'), JSON.stringify(rec, null, 2));

// ── pieces ───────────────────────────────────────────────────────────────────
/** Published posts from the live site (public), so numbering needs no GitHub token. */
async function published() {
  const r = await fetch('https://bwalletx.com/blog/', { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`bwalletx.com/blog: ${r.status}`);
  return parseIndex(await r.text());
}

function numbering(posts) {
  const num = nextNumber(posts.map((p) => `${pad3(p.num)}-${p.slug}.html`));
  const prev = [...posts].sort((a, b) => b.num - a.num)[0] ?? null;
  return { num, prev };
}

/** Write draft.json, preview.html and og.png for a draft record. */
function materialise(rec) {
  fs.mkdirSync(draftDir(rec.id), { recursive: true });
  const n = pad3(rec.num);
  const png = sharePng({ num: rec.num, title: rec.draft.title, lede: rec.draft.lede, dateLabel: rec.dateLabel });
  fs.writeFileSync(path.join(draftDir(rec.id), 'og.png'), png);
  const html = renderPost(TEMPLATE, rec.draft, {
    num: rec.num, slug: rec.slug, dateLabel: rec.dateLabel, prev: rec.prev, preview: true,
    imageUrl: `${PREVIEW_BASE}/drafts/${rec.id}/og.png`,
  });
  fs.writeFileSync(path.join(draftDir(rec.id), 'preview.html'), html);
  saveDraft(rec);
  log(`draft ${rec.id} ${n} "${rec.draft.title}" materialised`);
}

const previewUrl = (rec) => `${PREVIEW_BASE}/drafts/${rec.id}`;
const postUrl = (rec) => `https://bwalletx.com/blog/${pad3(rec.num)}-${rec.slug}`;

async function dm(rec) {
  const text = dmText(rec.draft, { num: rec.num, previewUrl: previewUrl(rec), test: rec.test, revision: rec.revision });
  const r = await sendDm(env, text, `blog:${rec.id}`);
  rec.dms = [...(rec.dms ?? []), { at: new Date().toISOString(), messageId: r.messageId }];
  saveDraft(rec);
  log(`DM sent for ${rec.id} (room $${r.ticker})`);
}

async function nightly({ force, again, draftOnly, test }) {
  const now = londonNow();
  if (!force && !draftOnly && !test && now.hour !== 22) process.exit(0); // cron fires 21:00 and 22:00 UTC; only London-22:xx acts
  const day = env.BLOG_DAY || now.day;
  if (!draftOnly && !test && state.nights[day] && !again) { log('already ran for', day, state.nights[day].result); return; }
  if (!draftOnly && !test && state.current) {
    const cur = loadDraft(state.current);
    if (cur.status === 'awaiting') log(`draft ${cur.id} (${cur.day}) still awaiting a reply; it is superseded by tonight's run`);
    cur.status = 'superseded'; saveDraft(cur); state.current = null; save();
  }
  const record = (result) => { if (!draftOnly && !test) { state.nights[day] = { at: new Date().toISOString(), result }; save(); } };

  const { commits: all, problems } = await collect(londonDayBounds(day), env);
  for (const p of problems) log('collector:', p);
  const commits = filterCommits(all).sort((a, b) => b.commit.author.date.localeCompare(a.commit.author.date)).slice(0, 150);
  log(`${day}: ${all.length} commits, ${commits.length} after filtering`);
  if (!commits.length) { log('nothing shipped today: no post'); record('nothing shipped'); return; }

  const { num, prev } = numbering(await published());
  const dateLabel = londonLabel(day);
  const placeholderUrl = `https://bwalletx.com/blog/${pad3(num)}-${'x'.repeat(48)}`; // worst-case link length for the X line
  const draft = await writeDraft(env, { num: pad3(num), url: placeholderUrl, dateLabel, commits, samples: SAMPLES });
  if (draft.skip) { log('model: nothing worth a post:', draft.reason); record(`skipped by model: ${draft.reason}`); return; }

  const rec = {
    id: crypto.randomBytes(16).toString('hex'), day, num, slug: slugify(draft.title), dateLabel, prev, draft, test: !!test,
    status: 'awaiting', revision: 0, createdAt: new Date().toISOString(), problems,
    commits: commits.map((c) => ({ repo: c.repo, sha: c.sha.slice(0, 7), msg: c.commit.message.split('\n')[0] })),
  };
  materialise(rec);
  if (draftOnly) { console.log(dmText(draft, { num, previewUrl: previewUrl(rec) })); return; }
  if (!test) { state.current = rec.id; save(); }
  else { state.tests = [...(state.tests ?? []), rec.id]; save(); }
  await dm(rec);
  record(test ? 'test draft sent' : `draft ${rec.id} sent`);
}

async function reply() {
  const raw = fs.readFileSync(0, 'utf8');
  const ev = JSON.parse(raw);
  if (ev.type !== 'dm.reply' || String(ev.from).toLowerCase().replace(/^\$/, '') !== 'boase') { log('ignored reply from', ev.from); return; }
  // The newest awaiting draft: the nightly one, or else the latest TEST draft.
  const candidates = [state.current, ...[...(state.tests ?? [])].reverse()].filter(Boolean).map(loadDraft).filter((r) => r.status === 'awaiting');
  const rec = candidates[0];
  if (!rec) { log('reply with no draft waiting:', JSON.stringify(ev.text).slice(0, 80)); return; }
  const r = parseReply(ev.text);
  log(`reply on ${rec.id}${rec.test ? ' (TEST)' : ''}: ${r.action}`);
  rec.replies = [...(rec.replies ?? []), { at: ev.at, text: String(ev.text).slice(0, 2000), action: r.action }];
  if (r.action === 'ignore') return saveDraft(rec);
  if (r.action === 'skip') {
    rec.status = 'skipped'; saveDraft(rec);
    if (state.current === rec.id) { state.current = null; save(); }
    await sendDm(env, `Dropped ${pad3(rec.num)} "${rec.draft.title}". Nothing was published.`, `blog:${rec.id}`);
    return;
  }
  if (r.action === 'revise') {
    const draft = await reviseDraft(env, { num: pad3(rec.num), url: postUrl({ ...rec, slug: 'x'.repeat(48) }), draft: rec.draft, instructions: r.instructions, samples: SAMPLES });
    rec.draft = draft; rec.slug = slugify(draft.title); rec.revision += 1;
    materialise(rec);
    await dm(rec);
    return;
  }
  // publish
  if (rec.test) {
    rec.status = 'test-approved'; saveDraft(rec);
    await sendDm(env, `TEST — "go" received and understood. This was a test draft, so nothing was published. The pipeline works end to end up to publishing.`, `blog:${rec.id}`);
    return;
  }
  try {
    const url = await publish(rec);
    await sendDm(env, `Published: ${url}\nPosted to X and bChat: ${rec.posted ?? 'see log'}`, `blog:${rec.id}`);
  } catch (e) {
    log('publish FAILED:', e.message);
    await sendDm(env, `Couldn't publish ${pad3(rec.num)}: ${e.needsToken ? 'the server has no GitHub write token for b0ase/bwalletx-site yet (GITHUB_TOKEN_B0ASE).' : e.message.slice(0, 300)}\nThe draft is kept; reply "go" again once it's fixed.`, `blog:${rec.id}`).catch(() => {});
  }
}

/** Commit the post to b0ase/bwalletx-site main (Vercel deploys it), then post it to X and bChat at once. */
async function publish(rec) {
  const site = path.join(STATE_DIR, 'site');
  const { git } = siteCheckout(site, env);
  // Renumber if a post took this number since the draft (e.g. 014 was published by hand).
  const files = fs.readdirSync(path.join(site, 'blog'));
  const posts = parseIndex(fs.readFileSync(path.join(site, 'blog/index.html'), 'utf8'));
  const { num, prev } = numbering(posts.length ? posts : files.filter((f) => /^\d{3}-/.test(f)).map((f) => ({ num: Number(f.slice(0, 3)), slug: f.slice(4, -5), title: '' })));
  if (num !== rec.num) { log(`renumbered ${rec.num} → ${num}`); rec.num = num; }
  rec.prev = prev;
  const n = pad3(rec.num);
  const file = `blog/${n}-${rec.slug}.html`;
  fs.writeFileSync(path.join(site, file), renderPost(TEMPLATE, rec.draft, { num: rec.num, slug: rec.slug, dateLabel: rec.dateLabel, prev }));
  fs.writeFileSync(path.join(site, `og/og-blog-${n}.png`), sharePng({ num: rec.num, title: rec.draft.title, lede: rec.draft.lede, dateLabel: rec.dateLabel, postOf: `post ${rec.num}` }));
  const indexPath = path.join(site, 'blog/index.html');
  fs.writeFileSync(indexPath, addToIndex(fs.readFileSync(indexPath, 'utf8'), { num: rec.num, slug: rec.slug, title: rec.draft.title, lede: rec.draft.lede, dateLabel: rec.dateLabel }));
  if (prev) {
    const prevPath = path.join(site, `blog/${pad3(prev.num)}-${prev.slug}.html`);
    if (fs.existsSync(prevPath)) fs.writeFileSync(prevPath, linkNext(fs.readFileSync(prevPath, 'utf8'), { num: rec.num, slug: rec.slug, title: rec.draft.title }));
  }
  execFileSync('python3', ['scripts/gen-llms.py'], { cwd: site, stdio: 'ignore' }); // llms.txt, llms-full.txt, sitemap.xml
  git(['add', '-A']);
  git(['-c', 'user.name=bWalletX blog', '-c', 'user.email=blog@bwalletx.com', 'commit', '-q', '-m', `Blog ${n}: ${rec.draft.title}\n\nNightly post for ${rec.dateLabel}, approved by the owner in bChat.`]);
  git(['push', '-q', 'origin', 'HEAD:main']);
  rec.status = 'published'; rec.publishedAt = new Date().toISOString(); rec.url = `https://bwalletx.com/blog/${n}-${rec.slug}`;
  saveDraft(rec);
  if (state.current === rec.id) { state.current = null; save(); }
  log('published', rec.url);

  // Into the X/bChat queue as already-posted, then post it now (xpost --url posts just this item).
  const queuePath = path.join(dir, 'posts-blog.json');
  const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
  if (!queue.some((p) => p.url === rec.url)) queue.push({ url: rec.url, lines: [rec.draft.xLine] });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 1));
  try {
    const out = execFileSync(process.execPath, [path.join(dir, 'xpost.mjs'), '--post', '--url', rec.url], { cwd: dir, encoding: 'utf8', timeout: 180_000 });
    log(out.trim());
    rec.posted = out.split('\n').filter((l) => /posted:/.test(l)).map((l) => l.replace(/^\S+\s/, '')).join('; ') || 'nothing posted (see log)';
  } catch (e) {
    rec.posted = `failed: ${(e.stdout || e.message).toString().slice(-300)}`;
    log('xpost failed', rec.posted);
  }
  saveDraft(rec);
  return rec.url;
}

// ── main ─────────────────────────────────────────────────────────────────────
if (fs.existsSync(path.join(dir, 'PAUSED-BLOG')) && !args.includes('--reply') && !args.includes('--status')) { log('PAUSED-BLOG present: nothing done'); process.exit(0); }
try {
  if (args.includes('--reply')) await reply();
  else if (args.includes('--status')) console.log(JSON.stringify({ current: state.current && loadDraft(state.current), nights: state.nights, tests: state.tests }, null, 2));
  else if (args.includes('--nightly') || args.includes('--draft-only') || args.includes('--test-dm')) {
    await nightly({ force: args.includes('--force'), again: args.includes('--again'), draftOnly: args.includes('--draft-only'), test: args.includes('--test-dm') });
  } else { console.log('usage: see the top of blog.mjs'); process.exit(2); }
} catch (e) {
  log('FAILED:', e.stack || e.message);
  process.exit(1);
}
