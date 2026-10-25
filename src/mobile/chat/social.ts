import type { ChatMessage } from './messages';
import type { ReplyRef } from './api';

/**
 * Facebook / WhatsApp-style room chat, matching bChat on the web (bit-sign room page):
 * reactions, reply quotes, $mentions, typing, and private $b answers. Pure; unit-tested.
 *
 * Server facts (bit-sign):
 *  - a reaction is an appended `reaction` event: { target, emoji, op: 'add'|'remove', by };
 *    the net per person is the replay of those events in order (the web does the same);
 *  - a reply is event_payload.reply_to = { id, author, snippet } on the new message;
 *  - a mention is `$handle` in the text (lib/mentions.ts); members are pushed;
 *  - a $b row hidden from others carries event_payload.agent_private + visible_to (hidden from others in the room; only the asker's client shows it).
 */

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '🙏', '🎉'] as const;

type Reaction = { target?: string; emoji?: string; op?: string; by?: string };

export const isReactionEvent = (m: ChatMessage) => m.event_type === 'reaction';

const norm = (h: string | null | undefined) => (h ?? '').trim().replace(/^[$@]/, '').toLowerCase();

/** message id → [{ emoji, handles }] (emoji in first-used order; empty sets dropped). */
export const reactionsByMessage = (messages: ChatMessage[]): Map<string, { emoji: string; handles: string[] }[]> => {
  const by = new Map<string, Map<string, Set<string>>>();
  for (const m of messages) {
    if (!isReactionEvent(m)) continue;
    const p = (m.event_payload ?? {}) as Reaction;
    const who = norm(p.by || m.author_handle);
    if (!p.target || !p.emoji || !who) continue;
    const forMsg = by.get(p.target) ?? new Map<string, Set<string>>();
    const set = forMsg.get(p.emoji) ?? new Set<string>();
    if (p.op === 'remove') set.delete(who);
    else set.add(who);
    forMsg.set(p.emoji, set);
    by.set(p.target, forMsg);
  }
  const out = new Map<string, { emoji: string; handles: string[] }[]>();
  for (const [id, emojis] of by) {
    const list = [...emojis].filter(([, s]) => s.size > 0).map(([emoji, s]) => ({ emoji, handles: [...s] }));
    if (list.length) out.set(id, list);
  }
  return out;
};

/** Apply my own reaction toggle locally, before the server echoes it (optimistic). */
export const optimisticReaction = (target: string, emoji: string, me: string, mineNow: boolean): ChatMessage => ({
  id: `local-reaction:${target}:${emoji}:${Date.now()}`,
  author_handle: norm(me),
  kind: 'event',
  body: null,
  event_type: 'reaction',
  event_payload: { target, emoji, op: mineNow ? 'remove' : 'add', by: norm(me) },
  created_at: new Date().toISOString(),
  pending: true,
});

export const replyOf = (m: ChatMessage): ReplyRef | null => {
  const p = m.event_payload as
    | { reply_to?: Partial<ReplyRef>; shared_by?: string; question?: string }
    | null
    | undefined;
  const r = p?.reply_to;
  if (r && typeof r.id === 'string') return { id: r.id, author: r.author ?? null, snippet: String(r.snippet ?? '') };
  // A shared $b answer from before 18 Oct kept only `question`: still quote it, or the room
  // sees an answer with no question.
  if (p?.shared_by && p.question) return { id: '', author: p.shared_by, snippet: String(p.question) };
  return null;
};

export const replyRefFor = (m: ChatMessage): ReplyRef => ({
  id: m.id,
  author: m.author_handle ? norm(m.author_handle) : null,
  snippet: (m.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
});

/** A private $b row (question or answer) only I can see. */
export const isPrivateB = (m: ChatMessage) =>
  Boolean((m.event_payload as { agent_private?: boolean } | null)?.agent_private);
export const isShared = (m: ChatMessage) => Boolean((m.event_payload as { shared?: boolean } | null)?.shared);
/** Server-only ids (`ephemeral:…`, e.g. /b help): nothing can be done to them. */
// One definition (messages.ts, from feat/lounge-bot); re-exported for chat-ux callers.
export { isEphemeral } from './messages';

// ── $mentions (same rule as bit-sign lib/mentions.ts) ──

const MENTION_RE = /(\$[a-z0-9][a-z0-9._-]*)/gi;
const MONEY_RE = /^\d+([.,]\d+)*$/;

export type Part = { text: string; mention?: string };

/** Split text into plain parts and `$handle` mentions; `$50` stays text. */
export const mentionParts = (body: string): Part[] =>
  body
    .split(MENTION_RE)
    .filter((t) => t !== '')
    .map((t) => {
      const h = /^\$/.test(t) ? t.slice(1) : '';
      return h && !MONEY_RE.test(h) ? { text: t, mention: h.toLowerCase().replace(/[._-]+$/, '') } : { text: t };
    });

/** The @/$ word being typed at the end of the draft: "hi @al" → "al"; null when none. */
export const mentionQuery = (draft: string): string | null => {
  const m = /(?:^|\s)[@$]([a-z0-9._-]*)$/i.exec(draft);
  return m ? m[1].toLowerCase() : null;
};

/** Replace the @/$ word at the end with `$handle ` (bChat's mention syntax). */
export const applyMention = (draft: string, handle: string): string =>
  draft.replace(/(^|\s)[@$][a-z0-9._-]*$/i, `$1$${norm(handle)} `);

/** Handles to suggest: recent authors first, filtered by the query, never me or $b. */
export const mentionSuggestions = (messages: ChatMessage[], query: string, me: string, max = 5): string[] => {
  const seen: string[] = [];
  for (let i = messages.length - 1; i >= 0 && seen.length < 50; i--) {
    const h = norm(messages[i].author_handle);
    if (h && h !== norm(me) && h !== 'b' && messages[i].kind !== 'event' && !seen.includes(h)) seen.push(h);
  }
  return seen.filter((h) => h.startsWith(query)).slice(0, max);
};

export const typingLabel = (handles: string[]): string => {
  const hs = handles.map((h) => `$${norm(h)}`);
  if (!hs.length) return '';
  if (hs.length === 1) return `${hs[0]} is typing…`;
  if (hs.length === 2) return `${hs[0]} and ${hs[1]} are typing…`;
  return `${hs[0]} and ${hs.length - 1} others are typing…`;
};
