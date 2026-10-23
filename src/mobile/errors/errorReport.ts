import { setAgentVoice } from '../agent/handoff';
import { hidePhrases } from './phraseGuard';

/**
 * Every error the wallet shows gets "Copy" and "Ask b" (owner, 10 Oct 2026). Ask b opens the b agent
 * (/m/ask-b) with the error already typed in, plus where it happened, the app version and the edition.
 *
 * ⚠ What leaves through either action is redacted first: an error can echo user input, and the person
 * may have pasted recovery words, a private key or a password into the field that failed. Never sent:
 * recovery words, WIF / extended private keys, 64-hex secrets, anything labelled password, passphrase,
 * seed, mnemonic, private key or WIF, and balances.
 */

const SECRET_LABEL =
  /\b(password|passphrase|pass|pin|seed|mnemonic|recovery words?|private key|priv(?:ate)?key|wif|secret)\s*[:=]\s*\S+/gi;
const WIF = /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;
const XPRV = /\b[xt]prv[1-9A-HJ-NP-Za-km-z]{100,112}\b/g;
const HEX64 = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;
const BALANCE =
  /\b(balance|total|you have|available)\b([^.\n]{0,40}?)\d[\d,]*(?:\.\d+)?\s*(bsv|sats?|satoshis|usd|\$)?/gi;
const MONEY = /(?:\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:bsv|sats?|satoshis)\b)/gi;

export const redactSecrets = (text: string): string =>
  hidePhrases(
    String(text ?? '')
      .replace(SECRET_LABEL, (_m, label: string) => `${label}: [hidden]`)
      .replace(XPRV, '[private key hidden]')
      .replace(WIF, '[private key hidden]')
      .replace(HEX64, '[key hidden]')
      .replace(BALANCE, (_m, word: string) => `${word} [amount hidden]`)
      .replace(MONEY, '[amount]'),
  ).slice(0, 1200);

export type ErrorContext = { screen?: string; version?: string; edition?: string; channel?: string; time?: string };

export const errorContext = (): ErrorContext => {
  let version = 'dev';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) version = chrome.runtime.getManifest().version;
  } catch {
    /* not the extension */
  }
  try {
    if (version === 'dev' && typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__)
      version = `dev ${__BUILD_COMMIT__}`;
  } catch {
    /* not stamped (tests) */
  }
  let channel = '';
  try {
    channel = import.meta.env?.VITE_CHANNEL ?? '';
  } catch {
    /* no env */
  }
  const g = globalThis as { Capacitor?: { getPlatform?: () => string } };
  const native = g.Capacitor?.getPlatform?.();
  if (!channel) channel = native && native !== 'web' ? native : version.startsWith('dev') ? 'web' : 'extension';
  let edition = 'bWalletX';
  try {
    if (/bwallet\b/i.test(document.title) && !/bwalletx/i.test(document.title)) edition = 'bWallet';
  } catch {
    /* no document */
  }
  let screen = '';
  try {
    screen = currentScreen();
  } catch {
    /* unknown */
  }
  return { screen, version, edition, channel, time: new Date().toISOString() };
};

const contextLine = (ctx: ErrorContext): string =>
  [
    ctx.screen && `Screen: ${ctx.screen}`,
    ctx.version && `Version: ${ctx.version}`,
    ctx.edition && `Edition: ${ctx.edition}`,
    ctx.channel && `Channel: ${ctx.channel}`,
    ctx.time && `Time: ${ctx.time}`,
  ]
    .filter(Boolean)
    .map((part) => redactSecrets(part as string))
    .join(' · ');

/** The text Copy puts on the clipboard: the error plus where it happened, redacted. */
export const errorReportText = (error: string, ctx: ErrorContext = errorContext()): string => {
  const where = contextLine(ctx);
  return `${redactSecrets(error)}${where ? `\n${where}` : ''}`;
};

/**
 * b's first message: a bug report. It starts with "Bug report:" so b logs it with the platform
 * (bit-sign lib/b-feedback.ts, the b bug loop) as well as explaining the error and how to fix it.
 */
export const askBMessage = (error: string, ctx: ErrorContext = errorContext()): string =>
  `Bug report: I got this error in bWalletX.\nError: "${redactSecrets(error)}"\n${contextLine(ctx)}\nPlease log this as a bug report, then tell me what it means and how to fix it.`;

// ── Navigation to b: the snackbar lives outside the router, so a bridge inside it registers navigate. ──
let navigateTo: ((path: string) => void) | null = null;
let screenOf: (() => string) | null = null;
export const registerErrorNavigator = (nav: (path: string) => void, screen: () => string) => {
  navigateTo = nav;
  screenOf = screen;
  return () => {
    if (navigateTo === nav) {
      navigateTo = null;
      screenOf = null;
    }
  };
};
const currentScreen = () => (screenOf ? screenOf() : '');

export const AGENT_PATH = '/m/ask-b';

/**
 * Open b with the bug report attached and sent: the same path as hold-to-talk (setAgentVoice), so b's page
 * sends it through its normal send(), which still shows the consent sheet / price confirm when needed.
 */
export const askB = (error: string) => {
  setAgentVoice(askBMessage(error));
  navigateTo?.(AGENT_PATH);
};

export const copyError = async (error: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(errorReportText(error));
    return true;
  } catch {
    return false;
  }
};
