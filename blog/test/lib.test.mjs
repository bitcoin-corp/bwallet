import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  addToIndex, bSign, bVerify, dmText, filterCommits, isChore, linkNext, londonDayBounds, londonLabel, londonNow,
  nextNumber, parseIndex, parseReply, renderPost, slugify, validateDraft,
} from '../lib.mjs';
import { tokenFor } from '../github.mjs';
import { shareSvg } from '../image.mjs';

const c = (message, parents = 1, sha = Math.random().toString(16).slice(2)) => ({ sha, parents: Array(parents).fill({}), commit: { message } });

test('London day bounds: BST and GMT', () => {
  assert.deepEqual(londonDayBounds('2026-10-06'), { since: '2026-10-05T23:00:00.000Z', until: '2026-10-06T23:00:00.000Z' });
  assert.deepEqual(londonDayBounds('2026-12-01'), { since: '2026-12-01T00:00:00.000Z', until: '2026-12-02T00:00:00.000Z' });
  // clocks go back 25 Oct 2026: a 25-hour day
  assert.deepEqual(londonDayBounds('2026-10-25'), { since: '2026-10-24T23:00:00.000Z', until: '2026-10-26T00:00:00.000Z' });
  assert.equal(londonLabel('2026-10-06'), '6 Oct 2026');
  assert.deepEqual(londonNow(new Date('2026-10-06T21:30:00Z')), { day: '2026-10-06', hour: 22 });
  assert.deepEqual(londonNow(new Date('2026-12-06T21:30:00Z')), { day: '2026-12-06', hour: 21 });
});

test('collector filtering: merges, chores and duplicates out', () => {
  for (const m of ['Bump to 5.1.80 (iOS 90 / Android 91)', 'Publish 5.1.80', 'Merge branch main', 'Ignore .vscode/', 'chore: deps', 'typo', 'Fix typo in README', '']) assert.ok(isChore(m), m);
  for (const m of ['Wallet: show fiat on send', 'Push notifications, phase A: devices/prefs API', 'Revert "Exchange: new fee"', 'Bumper sticker page']) assert.ok(!isChore(m), m);
  const same = c('Feed: link cards', 1, 'abc');
  const kept = filterCommits([c('Merge pull request #3', 2), c('Bump to 1.2.3'), same, { ...same }, c('Rooms: mute button')]);
  assert.deepEqual(kept.map((k) => k.commit.message), ['Feed: link cards', 'Rooms: mute button']);
  assert.equal(filterCommits([c('Bump to 1'), c('Publish 1.0.1'), c('Merge x', 2)]).length, 0, 'chores-only day → no draft');
});

test('numbering: 014 reserved unless published', () => {
  const upTo13 = Array.from({ length: 13 }, (_, i) => `${String(i + 1).padStart(3, '0')}-x.html`);
  assert.equal(nextNumber([...upTo13, 'index.html']), 15);
  assert.equal(nextNumber([...upTo13, '014-hand-written.html']), 15);
  assert.equal(nextNumber([...upTo13, '014-a.html', '015-b.html']), 16);
  assert.equal(nextNumber([...upTo13, '015-b.html']), 16);
  assert.equal(nextNumber([]), 1);
});

test('approval parsing', () => {
  for (const t of ['go', 'Go', 'GO!', ' go. ', 'publish', 'ship it', 'yes']) assert.deepEqual(parseReply(t), { action: 'publish' }, t);
  for (const t of ['skip', 'Skip.', 'drop', 'no', "don't publish"]) assert.deepEqual(parseReply(t), { action: 'skip' }, t);
  assert.deepEqual(parseReply('go with a shorter title'), { action: 'revise', instructions: 'go with a shorter title' });
  assert.deepEqual(parseReply('no hype in para 2'), { action: 'revise', instructions: 'no hype in para 2' });
  assert.deepEqual(parseReply('   '), { action: 'ignore' });
});

test('HMAC matches the bit-sign scheme', async () => {
  const body = '{"type":"dm.reply","from":"boase","text":"go"}', now = 1_800_000_000;
  const sig = bSign(body, 's3cret', now);
  assert.match(sig, /^t=1800000000,v1=[0-9a-f]{64}$/);
  assert.ok(bVerify(body, sig, 's3cret', now));
  assert.ok(!bVerify(body, sig, 'other', now));
  assert.ok(!bVerify(body.replace('boase', 'mallory'), sig, 's3cret', now));
  assert.ok(!bVerify(body, sig, 's3cret', now + 301));
  assert.ok(!bVerify(body, null, 's3cret', now));
  assert.ok(!bVerify(body, bSign(body, '', now), '', now));
  // Known vector: same as bit-sign/bwalletx-push (HMAC-SHA256 over "<t>.<body>")
  assert.equal(bSign("{}", "k", 1), "t=1,v1=" + (await import("node:crypto")).createHmac("sha256", "k").update("1.{}").digest("hex"));
});

const draft = {
  title: 'Push notifications', lede: 'Your phone now buzzes for DMs.',
  sections: [{ heading: 'What changed', paragraphs: ['We added `push` for <DMs>.'] }], notDone: ['iOS sandbox only'],
  xLine: '015 · Push notifications: your phone now buzzes for DMs.',
};

test('draft validation', () => {
  assert.deepEqual(validateDraft(draft, { url: 'https://bwalletx.com/blog/015-push' }), []);
  const long = { ...draft, sections: [{ heading: 'x', paragraphs: ['word '.repeat(400)] }] };
  assert.match(validateDraft(long).join(), /too long/);
  assert.match(validateDraft({ ...draft, xLine: 'y'.repeat(260) }, { url: 'https://bwalletx.com/blog/015-' + 'x'.repeat(48) }).join(), /xLine too long/);
  assert.match(validateDraft({ ...draft, title: '' }).join(), /title/);
});

test('render: structure of 013, escaping, preview noindex', () => {
  const tpl = fs.readFileSync(new URL('../post-template.html', import.meta.url), 'utf8');
  const opts = { num: 15, slug: 'push-notifications', dateLabel: '6 Oct 2026', prev: { num: 13, slug: 'sites-and-navigation', title: 'Two sites from one' } };
  const html = renderPost(tpl, draft, opts);
  assert.match(html, /<title>015 Push notifications · bWalletX blog<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/bwalletx.com\/blog\/015-push-notifications" \/>/);
  assert.match(html, /og-blog-015\.png/);
  assert.match(html, /<span class="num">015<\/span> · 6 Oct 2026/);
  assert.match(html, /<code>push<\/code> for &lt;DMs&gt;/);
  assert.match(html, /&larr; 013 Two sites from one/);
  assert.ok(!html.includes('{{'));
  assert.ok(!html.includes('noindex'));
  const pv = renderPost(tpl, draft, { ...opts, preview: true, imageUrl: 'https://push.bwalletx.com/drafts/abc/og.png' });
  assert.match(pv, /noindex,nofollow/);
  assert.match(pv, /href="https:\/\/bwalletx.com\/styles.css"/);
  assert.match(pv, /DRAFT preview/);
});

test('index, prev/next and index parsing', () => {
  const idx = '<ul class="posts"><li><a href="/blog/013-sites-and-navigation">Two sites from one</a></li></ul>';
  const out = addToIndex(idx, { num: 15, slug: 'push', title: 'Push & more', lede: 'L', dateLabel: '6 Oct 2026' });
  assert.ok(out.indexOf('015-push') < out.indexOf('013-sites'));
  assert.equal(addToIndex(out, { num: 15, slug: 'push', title: 'Push & more', lede: 'L', dateLabel: '6 Oct 2026' }), out, 'idempotent');
  assert.deepEqual(parseIndex(out).map((p) => p.num), [15, 13]);
  assert.equal(parseIndex(out)[0].title, 'Push & more');
  const prev = '<div class="pn"><a href="/blog/012-x">&larr; 012 X</a><a href="/blog">All posts &rarr;</a></div>';
  assert.equal(linkNext(prev, { num: 15, slug: 'push', title: 'Push' }), '<div class="pn"><a href="/blog/012-x">&larr; 012 X</a><a href="/blog/015-push">015 Push &rarr;</a></div>');
});

test('DM text: test label, instructions, length', () => {
  const t = dmText(draft, { num: 15, previewUrl: 'https://push.bwalletx.com/drafts/abc', test: true });
  assert.match(t, /^TEST — ignore/);
  assert.match(t, /Reply "go" to publish, "skip" to drop it/);
  assert.match(t, /Preview: https:\/\/push.bwalletx.com\/drafts\/abc/);
  assert.ok(!dmText(draft, { num: 15, previewUrl: 'u' }).includes('TEST'));
  assert.ok(dmText({ ...draft, lede: 'x'.repeat(9000) }, { num: 15, previewUrl: 'u' }).length < 4000);
});

test('tokens per owner, slug, share image', () => {
  assert.equal(tokenFor('b0ase/bit-sign', { GITHUB_TOKEN_B0ASE: 'a', GITHUB_TOKEN_BCORP: 'b' }), 'a');
  assert.equal(tokenFor('bitcoin-corp/bagents', { GITHUB_TOKEN_B0ASE: 'a', GITHUB_TOKEN_BCORP: 'b' }), 'b');
  assert.equal(tokenFor('bitcoin-corp/bagents', { GITHUB_TOKEN: 'g' }), 'g');
  assert.equal(tokenFor('b0ase/x', {}), '');
  assert.equal(slugify("The b agent: paid, or your own key!"), 'the-b-agent-paid-or-your');
  assert.ok(slugify('x'.repeat(100)).length <= 48);
  const svg = shareSvg({ num: 15, title: 'A <title> & more', lede: 'l', dateLabel: '6 Oct 2026' });
  assert.match(svg, /A &lt;title&gt; &amp; more/);
  assert.match(svg, />015</);
});
