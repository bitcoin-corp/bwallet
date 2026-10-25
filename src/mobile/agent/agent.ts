/**
 * The b agent (top bar's centre b → /m/ask-b): a help assistant for using bWallet. It runs one of two
 * ways, chosen in Settings › b agent (agentPrefs.ts):
 *   - 'own'  — the user's own provider key; the device calls the provider directly (providers.ts).
 *   - 'paid' — answered by bit-sign. While ASK_B_FREE is on this costs nothing (bit-sign /agent/free, with a
 *              daily cap); with it off, each message is paid in BSV from the wallet (paid.ts).
 * The system prompt is guide.ts. Replies are whole turns (no streaming). Pure helpers here.
 */
import { containsPhrase } from '../errors/phraseGuard';

/**
 * Owner, 25 Oct 2026: "For now, it shouldn't cost users anything to talk to b. If they want to send bug reports
 * and stuff, we want their feedback more than their money." On: the bCorp mode sends no payment and asks for no
 * confirm; bit-sign answers free under a daily cap. Off: the old pay-per-message flow (paid.ts) comes back as is.
 */
export const ASK_B_FREE = true;
/**
 * Owner, 25 Oct 2026: no price talk either way ("Just let them talk"). Conversations with b are kept so the team gets
 * fast, unfiltered feedback ("They're talking to US; we are b."), so this is said once, plainly (UK GDPR
 * transparency): the first-open line in Ask b, Settings › b agent, the consent sheet and bwalletx.com/privacy.
 */
/** Where the first-open line's "More" goes. */
export const ASK_B_MORE_URL = 'https://bwalletx.com/talk-to-b';
export const ASK_B_DISCLOSURE =
  "I'm b, the bWalletX team. We read these chats to fix bugs and improve b. Don't share your recovery phrase or passwords.";

export type AgentRole = 'user' | 'assistant';
export type AgentMessage = { role: AgentRole; text: string };

/** Most recent turns sent each time (stateless backends; keeps requests and prices bounded). */
export const MAX_TURNS = 8;
export const MAX_INPUT = 2000;

/** The transcript to send: blank turns dropped, last MAX_TURNS kept. */
export const transcript = (messages: AgentMessage[]): AgentMessage[] =>
  messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, text: m.text }));

const SECRET_LABELLED =
  /\b(password|passphrase|passcode|pin|seed|mnemonic|recovery (?:phrase|words?)|private key|privkey|wif|secret key)\s*(?:is|was|=|:)\s*\S+/i;

/** Rough guard: things that look like a seed phrase or a private key must never leave the device. */
export const looksLikeSecret = (text: string): boolean => {
  const t = text.trim();
  // WIF (5/K/L…, base58, 51–52 chars) or 64-hex private key.
  if (/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/.test(t)) return true;
  if (/\b[0-9a-fA-F]{64}\b/.test(t)) return true;
  if (/\bxprv[1-9A-HJ-NP-Za-km-z]{100,}/.test(t)) return true;
  // A labelled password / passphrase / PIN / key ("my password is hunter2", "pin: 4821").
  if (SECRET_LABELLED.test(t)) return true;
  // Recovery words however written: numbered, one per line, in a grid, capitals, after a label (phraseGuard.ts).
  if (containsPhrase(t)) return true;
  // 12 / 15 / 18 / 21 / 24 lowercase words and nothing else: a recovery phrase.
  const words = t.split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w));
};

export const SECRET_WARNING =
  'That looks like a recovery phrase, a private key or a password, so it was not sent. Never share it with anyone, including b. If you think it was exposed, move your funds to a new wallet.';
