import { describe, expect, test } from 'bun:test';
import { MAX_TURNS, looksLikeSecret, transcript, type AgentMessage } from './agent';
import { BWALLET_GUIDE } from './guide';

describe('transcript', () => {
  test('drops blanks and keeps the last MAX_TURNS', () => {
    const many: AgentMessage[] = Array.from({ length: MAX_TURNS + 5 }, (_, i) => ({ role: 'user', text: `m${i}` }));
    const t = transcript([{ role: 'assistant', text: '  ' }, ...many]);
    expect(t.length).toBe(MAX_TURNS);
    expect(t[0].text).toBe('m5');
  });

  test('history is capped at 8 turns (bit-sign refuses more)', () => {
    expect(MAX_TURNS).toBe(8);
    const many: AgentMessage[] = Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `m${i}` }));
    expect(transcript(many).length).toBe(8);
  });
});

describe('looksLikeSecret', () => {
  test('recovery phrases and keys are caught', () => {
    expect(looksLikeSecret('abandon '.repeat(11) + 'about')).toBe(true);
    expect(looksLikeSecret('KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn')).toBe(true);
    expect(looksLikeSecret('a'.repeat(64))).toBe(true);
  });
  test('numbered and labelled recovery phrases are caught (#42)', () => {
    const w = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
    expect(looksLikeSecret(w.map((x, i) => `${i + 1}. ${x}`).join(' '))).toBe(true);
    expect(looksLikeSecret(w.map((x, i) => `${i + 1}) ${x}`).join('\n'))).toBe(true);
    expect(looksLikeSecret(`my seed: ${w.join(' ')}`)).toBe(true);
  });
  test('passwords are caught before anything is sent (chats are kept by the team)', () => {
    expect(looksLikeSecret('my password is hunter2')).toBe(true);
    expect(looksLikeSecret('Password: Tr0ub4dor&3')).toBe(true);
    expect(looksLikeSecret('pin = 4821')).toBe(true);
    expect(looksLikeSecret('passphrase: correct horse battery')).toBe(true);
  });
  test('talking about passwords without giving one passes', () => {
    expect(looksLikeSecret('how do I change my password?')).toBe(false);
    expect(looksLikeSecret('I forgot my PIN, what now')).toBe(false);
  });
  test('normal questions pass', () => {
    expect(looksLikeSecret('how do I send bsv to a paymail address')).toBe(false);
    expect(looksLikeSecret('What is a ticket?')).toBe(false);
  });
});

describe('guide', () => {
  test('covers the tabs and the safety rules', () => {
    for (const w of [
      'Apps · Market · Wallet · Feed · Chat',
      'Tickets',
      'Sweep from another wallet',
      'bwalletx.com',
      'One-click',
      'seed phrase',
    ])
      expect(BWALLET_GUIDE).toContain(w);
  });
  test('walks people through making things instead of refusing (bWalletX)', () => {
    for (const w of ['Launch your own coin', 'List an app as a bApp', "app's name", 'its website', 'BRC-100'])
      expect(BWALLET_GUIDE).toContain(w);
    expect(BWALLET_GUIDE).not.toMatch(/only help with bWallet/);
    expect(BWALLET_GUIDE).toContain('never brush people off');
  });
});

describe('looksLikeSecret: secrets written without spaces (audit 25 Oct 2026)', () => {
  const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const WIF = 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ';
  const HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  test.each([
    ['dots', PHRASE.split(' ').join('.')],
    ['plus', PHRASE.split(' ').join('+')],
    ['underscores', PHRASE.split(' ').join('_')],
    ['wif in underscores', `key_${WIF}_`],
    ['hex after letters', `priv0x${HEX}`],
  ])('%s', (_name, text) => expect(looksLikeSecret(text)).toBe(true));
  test('ordinary question is not a secret', () => {
    expect(looksLikeSecret('How do I send 5.00 to my friend? e.g. via paymail.')).toBe(false);
  });
});
