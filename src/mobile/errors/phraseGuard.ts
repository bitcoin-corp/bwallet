import * as bip39 from 'bip39';

/**
 * Finds recovery phrases in free text, however they were written down: numbered ("1." "1)" "01:"),
 * one word per line, in a grid, upper case, dash/bullet/comma separated, or after a label like "seed:".
 * Shared by redactSecrets (errorReport.ts) and the Ask b guard (agent.ts looksLikeSecret).
 *
 * Text is split into tokens; numbering, bullets and punctuation are stripped from each, and tokens that are
 * then empty (pure numbers or symbols) are ignored. A phrase is a stretch of word tokens holding at least
 * MIN_WORDS BIP39 words, where BIP39 words are at least MIN_DENSITY of the words, and no more than MAX_GAP
 * non-BIP39 words sit together. Ordinary English fails the density test: "the", "and", "of", "to", "is"
 * and most other glue words are not BIP39 words.
 */

const WORDS = new Set(bip39.wordlists.english);
/** 12 words, or 11 when one was mistyped. */
const MIN_WORDS = 11;
const MIN_DENSITY = 0.8;
const MAX_GAP = 2;
const TOKEN = /[^\s,;|/\\•·▪◦●*–—-]+/g;

type Token = { start: number; end: number; kind: 'bip' | 'other' | 'noise' };

const tokenise = (text: string): Token[] =>
  Array.from(text.matchAll(TOKEN), (m) => {
    const core = m[0].toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
    const kind: Token['kind'] = !core ? 'noise' : WORDS.has(core) ? 'bip' : 'other';
    return { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind };
  });

/** Character ranges [start, end) of every recovery phrase found, including its numbering. */
export const findPhraseSpans = (text: string): Array<[number, number]> => {
  const all = tokenise(String(text ?? ''));
  const words = all.map((t, i) => ({ t, i })).filter((x) => x.t.kind !== 'noise');
  const spans: Array<[number, number]> = [];
  let s = 0;
  while (s < words.length) {
    if (words[s].t.kind !== 'bip') {
      s++;
      continue;
    }
    let bip = 0;
    let other = 0;
    let gap = 0;
    let best = -1;
    for (let e = s; e < words.length; e++) {
      if (words[e].t.kind === 'bip') {
        bip++;
        gap = 0;
        if (bip >= MIN_WORDS && bip / (bip + other) >= MIN_DENSITY) best = e;
      } else {
        other++;
        if (++gap > MAX_GAP) break;
      }
    }
    if (best < 0) {
      s++;
      continue;
    }
    // Take in the numbering just before the first word ("1." on its own) as well.
    let first = words[s].i;
    while (first > 0 && all[first - 1].kind === 'noise') first--;
    spans.push([all[first].start, all[words[best].i].end]);
    s = best + 1;
  }
  return spans;
};

export const containsPhrase = (text: string): boolean => findPhraseSpans(text).length > 0;

/** Replace every recovery phrase (words and numbering) with `mask`. */
export const hidePhrases = (text: string, mask = '[recovery words hidden]'): string => {
  const src = String(text ?? '');
  let out = '';
  let at = 0;
  for (const [a, b] of findPhraseSpans(src)) {
    out += src.slice(at, a) + mask;
    at = b;
  }
  return out + src.slice(at);
};
