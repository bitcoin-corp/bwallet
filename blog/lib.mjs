// Pure pieces of the nightly blog (blog.mjs): London day, commit filtering, numbering, reply parsing,
// the HMAC scheme shared with bit-sign, and HTML rendering/editing. No I/O here, so test/ imports it directly.
import crypto from 'node:crypto';

// ── London day ───────────────────────────────────────────────────────────────
const londonParts = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(d).map((x) => [x.type, x.value]));

/** London wall-clock date and hour for an instant. */
export function londonNow(d = new Date()) {
  const p = londonParts(d);
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** The UTC instant of London midnight starting `day` (YYYY-MM-DD). */
function londonMidnight(day) {
  const [y, m, d] = day.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  // London is UTC or UTC+1: try both, keep the one that reads 00:00 on `day` in London.
  for (const off of [0, -3600_000]) {
    const c = new Date(t + off);
    const p = londonParts(c);
    if (`${p.year}-${p.month}-${p.day}` === day && p.hour === '00' && p.minute === '00') return c;
  }
  return new Date(t);
}

/** [since, until) of a London day, as ISO strings for the GitHub API. */
export function londonDayBounds(day) {
  const since = londonMidnight(day);
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { since: since.toISOString(), until: londonMidnight(next).toISOString() };
}

/** "6 Oct 2026" */
export function londonLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

// ── commits ──────────────────────────────────────────────────────────────────
// Housekeeping that never makes a post on its own: version bumps, publishes of a build, merges, ignores, typos.
const CHORE = [
  /^merge\b/i, /^bump\b/i, /^publish \d/i, /^release \d/i, /^v?\d+\.\d+(\.\d+)?$/i, /^chore\b/i, /^wip\b/i,
  /^ignore\b/i, /^(fix(ed)? )?typos?\b/i, /^format(ting)?\b/i, /^lint\b/i, /^prettier\b/i, /^deps?\b/i,
  /^update (lock|pnpm-lock|package-lock)/i, /^\.?gitignore\b/i, /^initial commit$/i,
];

export function isChore(message) {
  const first = String(message ?? '').split('\n')[0].trim();
  if (!first) return true;
  return CHORE.some((r) => r.test(first));
}

/**
 * GitHub commit objects → the ones worth writing about: no merges, no chores, no duplicates (the same commit
 * pushed to two repos, e.g. bwallet branch and bitcoin-corp/bwallet main).
 */
export function filterCommits(commits) {
  const seen = new Set();
  const out = [];
  for (const c of commits) {
    if ((c.parents?.length ?? 1) > 1) continue;
    const msg = c.commit?.message ?? c.message ?? '';
    if (isChore(msg)) continue;
    const key = c.sha ?? msg;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ── numbering ────────────────────────────────────────────────────────────────
/**
 * Next post number from the blog file names. 014 is reserved for a hand-written draft (owner, 6 Oct 2026):
 * skip it unless it is already published.
 */
export function nextNumber(fileNames, reserved = [14]) {
  const nums = fileNames.map((f) => /^(\d{3})-.+\.html$/.exec(f)?.[1]).filter(Boolean).map(Number);
  let n = (nums.length ? Math.max(...nums) : 0) + 1;
  while (reserved.includes(n) && !nums.includes(n)) n++;
  return n;
}

export const pad3 = (n) => String(n).padStart(3, '0');

export function slugify(title) {
  return String(title).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .split(/[\s_-]+/).filter(Boolean).slice(0, 6).join('-').slice(0, 48).replace(/-+$/, '') || 'today';
}

// ── the owner's reply ────────────────────────────────────────────────────────
/** "go" → publish, "skip" → drop, anything else → revise with it as instructions. */
export function parseReply(text) {
  const t = String(text ?? '').trim();
  const w = t.toLowerCase().replace(/[.!\s]+$/g, '').trim();
  if (/^(go|go ahead|publish|ship it|yes|approve|approved|ok go|post it)$/.test(w)) return { action: 'publish' };
  if (/^(skip|drop|no|cancel|kill it|don'?t publish)$/.test(w)) return { action: 'skip' };
  if (!t) return { action: 'ignore' };
  return { action: 'revise', instructions: t };
}

// ── HMAC (same as bit-sign src/lib/b-agent-rules.ts and bwalletx-push src/b/sign.ts) ───────────────────
export function bSign(body, secret, now = Math.floor(Date.now() / 1000)) {
  return `t=${now},v1=${crypto.createHmac('sha256', secret).update(`${now}.${body}`).digest('hex')}`;
}

export function bVerify(body, header, secret, now = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now - t) > 300 || !parts.v1) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'), 'hex');
  const got = Buffer.from(parts.v1, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ── drafts ───────────────────────────────────────────────────────────────────
export const wordCount = (s) => (String(s).match(/\S+/g) ?? []).length;

export function draftWords(d) {
  return wordCount([d.lede, ...d.sections.flatMap((s) => [s.heading, ...s.paragraphs]), ...(d.notDone ?? [])].join(' '));
}

/** Problems with a model draft, or [] when it is usable. */
export function validateDraft(d, { maxWords = 350, url = '' } = {}) {
  const p = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!d.title || d.title.length > 70) p.push('title missing or over 70 chars');
  if (!d.lede || d.lede.length > 220) p.push('lede missing or over 220 chars');
  if (!Array.isArray(d.sections) || !d.sections.length) p.push('no sections');
  else if (d.sections.some((s) => !s.heading || !Array.isArray(s.paragraphs) || !s.paragraphs.length)) p.push('a section lacks heading or paragraphs');
  if (d.notDone && !Array.isArray(d.notDone)) p.push('notDone must be a list');
  if (!p.length && draftWords(d) > maxWords) p.push(`too long: ${draftWords(d)} words (max ${maxWords})`);
  const x = `${d.xLine ?? ''}\n\n${url}`;
  if (!d.xLine) p.push('xLine missing');
  else if (x.length > 280) p.push(`xLine too long with the link: ${x.length} > 280`);
  return p;
}

// ── HTML ─────────────────────────────────────────────────────────────────────
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Paragraph text: escape, then allow `code` spans (the existing posts use <code>). */
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

/**
 * The post page, in the structure of blog/013. `prev` is the post before ({ num, slug, title }).
 * Preview mode: absolute asset URLs, noindex, a DRAFT strip, share image shown inline.
 */
export function renderPost(template, d, { num, slug, dateLabel, prev, preview = false, imageUrl }) {
  const n = pad3(num);
  const url = `https://bwalletx.com/blog/${n}-${slug}`;
  const og = imageUrl ?? `https://bwalletx.com/og/og-blog-${n}.png`;
  const body = [
    `      <p class="meta"><a href="/blog">Development blog</a> · <span class="num">${n}</span> · ${esc(dateLabel)}</p>`,
    `      <h1>${esc(d.title)}</h1>`,
    `      <p class="lede">${inline(d.lede)}</p>`,
    ...d.sections.flatMap((s) => ['', `      <h2>${esc(s.heading)}</h2>`, ...s.paragraphs.map((p) => `      <p>${inline(p)}</p>`)]),
    '',
    d.notDone?.length ? `      <div class="box"><h2>What's not done</h2><ul>${d.notDone.map((x) => `<li>${inline(x)}</li>`).join('')}</ul></div>` : '',
    `      <p class="related">Related: <a href="/">Home</a> · <a href="/features">Features</a> · <a href="/developers">Developers</a></p>`,
    `      <div class="pn">${prev ? `<a href="/blog/${pad3(prev.num)}-${prev.slug}">&larr; ${pad3(prev.num)} ${esc(prev.title)}</a>` : '<span></span>'}<a href="/blog">All posts &rarr;</a></div>`,
  ].filter((l) => l !== '').join('\n');
  let html = template
    .replaceAll('{{TITLE}}', esc(d.title)).replaceAll('{{NUM}}', n).replaceAll('{{DESC}}', esc(d.lede))
    .replaceAll('{{URL}}', url).replaceAll('{{IMAGE}}', og).replace('{{BODY}}', body);
  if (preview) {
    html = html
      .replace('<head>', '<head>\n    <meta name="robots" content="noindex,nofollow" />')
      .replace(/(href|src)="\/(?!\/)/g, '$1="https://bwalletx.com/')
      .replace('<main class="ext">', `<main class="ext">\n      <p style="background:#F5B800;color:#000;padding:8px 14px;border-radius:10px;font-weight:700">DRAFT preview: not published. Reply "go", "skip" or edits in your bChat DM.</p>\n      <p><img src="${esc(og)}" alt="share image" style="width:100%;border-radius:12px" /></p>`);
  }
  return html;
}

/** Add a post to the top of blog/index.html's list. */
export function addToIndex(indexHtml, { num, slug, title, lede, dateLabel }) {
  const n = pad3(num);
  if (indexHtml.includes(`href="/blog/${n}-`)) return indexHtml;
  const li = `<li><span class="meta"><span class="num">${n}</span> · ${esc(dateLabel)}</span><br /><a href="/blog/${n}-${slug}">${esc(title)}</a><p>${esc(lede)}</p></li>`;
  if (!indexHtml.includes('<ul class="posts">')) throw new Error('blog/index.html: no <ul class="posts">');
  return indexHtml.replace('<ul class="posts">', `<ul class="posts">${li}`);
}

/** Point the previous post's "All posts →" at the new one, as 012 → 013 does. */
export function linkNext(prevHtml, { num, slug, title }) {
  const n = pad3(num);
  return prevHtml.replace(/(<div class="pn">[\s\S]*?)<a href="\/blog">All posts &rarr;<\/a>/, `$1<a href="/blog/${n}-${slug}">${n} ${esc(title)} &rarr;</a>`);
}

/** The bChat DM for a draft (plain text: the chat shows no markdown). */
export function dmText(d, { num, previewUrl, test = false, revision = 0 }) {
  const body = [d.lede, ...d.sections.flatMap((s) => [`\n${s.heading}`, ...s.paragraphs]), ...(d.notDone?.length ? ['\nWhat\'s not done', ...d.notDone.map((x) => `- ${x}`)] : [])].join('\n');
  return [
    test ? 'TEST — ignore. (Pipeline dry run: "go" on this one will not publish.)\n' : '',
    `Tonight's blog draft${revision ? ` (revision ${revision})` : ''}: ${pad3(num)} ${d.title}`,
    '',
    body,
    '',
    `X: ${d.xLine}`,
    '',
    `Preview: ${previewUrl}`,
    '',
    'Reply "go" to publish, "skip" to drop it, or reply with edits or instructions and I\'ll revise and send it again.',
  ].filter((l, i) => !(i === 0 && l === '')).join('\n').slice(0, 3990);
}

/** Posts listed on a blog index page: [{ num, slug, title }], newest first as listed. */
export function parseIndex(html) {
  const out = [];
  for (const m of String(html).matchAll(/href="\/blog\/(\d{3})-([a-z0-9-]+)">([^<]+)<\/a>/g)) {
    out.push({ num: Number(m[1]), slug: m[2], title: m[3].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"') });
  }
  return out;
}
