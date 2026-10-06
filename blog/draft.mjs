// Draft (and revise) tonight's post with Claude. ANTHROPIC_API_KEY comes from the job's env file only.
import Anthropic from '@anthropic-ai/sdk';
import { validateDraft } from './lib.mjs';

const RULES = `You write short posts for the bWalletX development blog (bwalletx.com/blog). bWalletX is a non-custodial BSV wallet (Android app, iPhone web app, Chrome/Brave extension, web app) from The Bitcoin Corporation Ltd, forked from Yours Wallet. bChat (bitcoinchat.online, the bit-sign codebase) is its chat and social server.

Write tonight's post from the day's commits, in the voice of the sample posts:
- First person plural ("we"), plain words, short sentences, past tense for what changed. No hype, no marketing, no exclamation marks.
- No AI clichés: never "delve", "seamless", "robust", "leverage", "game-changer", "exciting", "we're thrilled", "in today's", "elevate", "unlock", "journey", "landscape", "under the hood", em-dash pile-ups, or a closing moral.
- Lead with what a user notices and why we changed it. Skip internal refactors, tests and tooling unless they change what people see. Group related commits; don't list commits.
- Only say what the commits support. Never invent numbers, dates, prices or features. If a commit is unclear, leave it out.
- Name things the way the app does (button and screen names in quotes).
- At most 350 words in total (lede + headings + paragraphs + not-done items). 2 to 4 sections. A "What's not done" list only if the commits show something unfinished.
- The lede is one or two sentences (max 220 characters) and is also the page description.
- Title: max 60 characters, plain, no colon-subtitle formula.
- xLine: one line for X that starts with "{NUM} · " then the title, a colon and a short summary, max {XMAX} characters. Plain, no hashtags, no emoji.
- If nothing in the commits is worth a post (only chores, CI, typos, internal plumbing), return {"skip": true, "reason": "..."}.

Return ONLY a JSON object:
{"skip": false, "title": "...", "lede": "...", "sections": [{"heading": "...", "paragraphs": ["..."]}], "notDone": ["..."], "xLine": "..."}`;

function client(env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing from the blog env file');
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } } : {}),
  });
}

function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('no JSON in model reply');
  return JSON.parse(text.slice(s, e + 1));
}

async function ask(env, system, messages) {
  const r = await client(env).beta.messages.create({
    model: env.BLOG_MODEL || 'claude-opus-5-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system,
    messages,
  });
  if (r.stop_reason === 'refusal') throw new Error('model refused');
  const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  console.log(new Date().toISOString(), `blog model: in=${r.usage.input_tokens} out=${r.usage.output_tokens}`);
  return text;
}

const commitsText = (commits) => commits.map((c) =>
  `[${c.repoName}] ${c.commit.author?.date?.slice(11, 16) ?? ''} ${c.commit.message.trim().slice(0, 1200)}`).join('\n\n---\n\n');

/**
 * Draft a post. `samples` = text of two existing posts (style only). Retries once with the validation
 * problems if the first draft breaks a limit. Returns { skip, reason } or the draft object.
 */
export async function writeDraft(env, { num, url, dateLabel, commits, samples }) {
  const system = RULES.replaceAll('{NUM}', num).replace('{XMAX}', String(280 - url.length - 2));
  const messages = [{
    role: 'user',
    content: `<style_samples>\n${samples}\n</style_samples>\n\nPost number ${num}, dated ${dateLabel}. Today's commits (London day), newest first:\n\n<commits>\n${commitsText(commits)}\n</commits>`,
  }];
  return attempt(env, system, messages, url);
}

/** Revise a draft with the owner's instructions. */
export async function reviseDraft(env, { num, url, draft, instructions, samples }) {
  const system = RULES.replaceAll('{NUM}', num).replace('{XMAX}', String(280 - url.length - 2));
  const messages = [{
    role: 'user',
    content: `<style_samples>\n${samples}\n</style_samples>\n\nHere is draft ${num}:\n<draft>\n${JSON.stringify(draft)}\n</draft>\n\nThe owner replied with these edits or instructions. Apply them; keep everything else unless they say otherwise. Same JSON shape, same limits. Never return skip.\n<owner_reply>\n${instructions}\n</owner_reply>`,
  }];
  return attempt(env, system, messages, url);
}

async function attempt(env, system, messages, url) {
  let text = await ask(env, system, messages);
  let d = parseJson(text);
  if (d.skip) return d;
  let problems = validateDraft(d, { url });
  if (problems.length) {
    console.log(new Date().toISOString(), '[blog] first draft needs fixing:', problems.join('; '));
    text = await ask(env, system, [...messages, { role: 'assistant', content: text }, { role: 'user', content: `Fix these and return the whole JSON again: ${problems.join('; ')}` }]);
    d = parseJson(text);
    problems = validateDraft(d, { url });
    if (problems.length) throw new Error(`draft still invalid: ${problems.join('; ')}`);
  }
  return d;
}
