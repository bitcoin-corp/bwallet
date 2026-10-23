import { describe, expect, test } from 'bun:test';
import * as bip39 from 'bip39';
import { looksLikeSecret } from '../agent/agent';
import { redactSecrets } from './errorReport';
import { containsPhrase } from './phraseGuard';

const W12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const W24 = bip39.generateMnemonic(256).split(' ');
const grid = (w: string[], cols: number) =>
  Array.from({ length: Math.ceil(w.length / cols) }, (_, r) => w.slice(r * cols, r * cols + cols).join('   ')).join(
    '\n',
  );

const FORMATS: Array<[string, string]> = [
  ['plain', W12.join(' ')],
  ['numbered dot', W12.map((w, i) => `${i + 1}. ${w}`).join(' ')],
  ['numbered paren', W12.map((w, i) => `${i + 1}) ${w}`).join(' ')],
  ['numbered colon', W12.map((w, i) => `${i + 1}: ${w}`).join(' ')],
  ['numbered no space', W12.map((w, i) => `${i + 1}.${w}`).join(' ')],
  ['zero padded', W12.map((w, i) => `${String(i + 1).padStart(2, '0')}. ${w}`).join(' ')],
  ['newline per word', W12.join('\n')],
  ['numbered newline per word', W12.map((w, i) => `${i + 1}. ${w}`).join('\n')],
  ['3x4 grid', grid(W12, 4)],
  ['4x3 grid', grid(W12, 3)],
  [
    'numbered 3x4 grid',
    grid(
      W12.map((w, i) => `${i + 1}. ${w}`),
      4,
    ),
  ],
  ['uppercase', W12.join(' ').toUpperCase()],
  ['capitalised numbered', W12.map((w, i) => `${i + 1}. ${w[0].toUpperCase()}${w.slice(1)}`).join(' ')],
  ['partial numbering', W12.map((w, i) => (i % 3 === 0 ? `${i + 1}. ${w}` : w)).join(' ')],
  ['dash separated', W12.join(' - ')],
  ['dash joined', W12.join('-')],
  ['bullets', W12.map((w) => `• ${w}`).join('\n')],
  ['comma separated', W12.join(', ')],
  ['label prefix', `seed: ${W12.join(' ')}`],
  ['words label', `my words: ${W12.join(' ')}`],
  ['24 words', W24.join(' ')],
  ['24 numbered', W24.map((w, i) => `${i + 1}. ${w}`).join(' ')],
  [
    '24 grid',
    grid(
      W24.map((w, i) => `${i + 1}. ${w}`),
      3,
    ),
  ],
];

describe('recovery phrases in any format', () => {
  for (const [name, text] of FORMATS) {
    test(`redactSecrets hides every word: ${name}`, () => {
      const out = redactSecrets(`Restore failed: ${text}`).toLowerCase();
      expect(out).toContain('[recovery words hidden]');
      const left = out.split(/[^a-z]+/).filter((w) => (name.startsWith('24') ? W24 : W12).includes(w));
      expect(left).toEqual([]);
    });
    test(`Ask b refuses it: ${name}`, () => {
      expect(looksLikeSecret(text)).toBe(true);
    });
  }
  test('numbering is hidden with the words', () => {
    const out = redactSecrets(W12.map((w, i) => `${i + 1}. ${w}`).join(' '));
    expect(out).toBe('[recovery words hidden]');
  });
});

describe('ordinary text is left alone', () => {
  const PROSE = [
    'I tried to send some money to my friend yesterday but the app said the transaction failed. Can you tell me what happened and how to fix it?',
    'The wallet was working fine this morning. After the update the balance page shows a blank screen and the back button does nothing at all.',
    'We will be away on holiday for a few weeks, so please keep an eye on the account and let me know if anything strange appears in the history.',
    'Before you start, open the menu, choose settings, then pick the theme you like. There is also an option to change the language of the app.',
    'Please add a dark mode, a way to export my history as a file, and a simple guide for new people who have never used a bitcoin wallet before.',
  ];
  for (const p of PROSE) {
    test(`not flagged: ${p.slice(0, 30)}…`, () => {
      expect(containsPhrase(p)).toBe(false);
      expect(looksLikeSecret(p)).toBe(false);
      expect(redactSecrets(p)).not.toContain('[recovery words hidden]');
    });
  }
  test('a few BIP39 words in a sentence', () => {
    const s =
      'My phone has a crack across the screen so I need to buy a new one, any advice about which wallet app to install?';
    expect(containsPhrase(s)).toBe(false);
    expect(looksLikeSecret(s)).toBe(false);
  });
  test('a short list of BIP39 words', () => {
    const s = 'Ideas for the store: apple, banana, orange, lemon and a coffee theme.';
    expect(containsPhrase(s)).toBe(false);
    expect(redactSecrets(s)).toBe(s);
  });
});
