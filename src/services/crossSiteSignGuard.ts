/**
 * Cross-site signature relay guard (payment-safety audit 24 Oct 2026, B1).
 *
 * BRC-42 keys depend on the protocol, key ID and counterparty, not on which site asked. So evil.com could ask
 * for a signature under good.com's login protocol, over a challenge it fetched from good.com, and replay it
 * there as the user. Changing key derivation would change every existing login key, so instead the wallet
 * reads the data it is asked to sign: when it is text that names the site it is meant for (a SIWE-style
 * "<host> wants you to sign in" or "<host> wallet login:" line, or a domain / origin / host / audience / uri / url /
 * site / callback / redirect field), that site must be the one
 * calling (or a parent/subdomain of it). Data that names no site is signed as before; free links inside content (a post with a URL) are not
 * treated as a binding, so signed posts keep working.
 */

// Keys that say which site a message is for. uri/url/site/callback/redirect shapes added after the b-Aware
// report of 24 Oct 2026 (b_feedback 51): a sign-in message naming its site through one of these was not checked.
const BINDING_KEYS = [
  'domain',
  'origin',
  'host',
  'hostname',
  'audience',
  'aud',
  'uri',
  'url',
  'site',
  'website',
  'realm',
  'rp',
  'rp_id',
  'rpid',
  'relying_party',
  'callback',
  'callback_url',
  'callback_uri',
  'redirect',
  'redirect_uri',
  'redirect_url',
  'return_to',
  'return_url',
  'return_uri',
].join('|');
const BINDING_FIELD = new RegExp(`["']?\\b(${BINDING_KEYS})\\b["']?\\s*[:=]\\s*["']?([^\\s"',;}\\]]+)`, 'gi');
// "<host> wants you to sign in" (SIWE), "<host> wallet login:" and "Sign in to <host>" lines, anywhere in the
// text: a prefix such as "Login: " or a JSON string around the line must not hide it.
const HOST = '((?:[a-z0-9-]+\\.)+[a-z]{2,}(?::\\d+)?)';
const SIGN_IN_LINES = [
  new RegExp(
    `(?:^|[\\s"'\`(:])${HOST}(?: wants you to sign in| (?:wallet |account )?(?:log ?in|sign[ -]?in)\\b)`,
    'gim',
  ),
  new RegExp(`\\b(?:sign|log) ?in to ${HOST}`, 'gi'),
];
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Lower-case hostname with no port, no trailing dot and no pairing suffix (".c<hex>.paired.invalid"). */
export const bareHost = (value: string): string | null => {
  let v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.includes('://')) {
    try {
      v = new URL(v).hostname;
    } catch {
      return null;
    }
  }
  v = v
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/(\.c[0-9a-f]{44})?\.paired\.invalid$/, '');
  return HOST_RE.test(v) ? v : null;
};

/**
 * Equal hosts, or one a dot-boundary subdomain of the other (app.bchatx.com and bchatx.com). Siblings never
 * match: a.vercel.app / b.vercel.app, a.github.io / b.github.io and a.co.uk / b.co.uk are different sites.
 */
export const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

const decodeText = (data: unknown): string | null => {
  if (!Array.isArray(data) || data.length === 0 || data.length > 64 * 1024) return null;
  if (!data.every((b) => typeof b === 'number' && b >= 0 && b <= 255)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data as number[]));
    let printable = 0;
    for (const ch of text) if (ch >= ' ' || ch === '\n' || ch === '\r' || ch === '\t') printable++;
    return printable / text.length >= 0.9 ? text : null;
  } catch {
    return null;
  }
};

/** Every site the text says it is meant for. */
export const boundHosts = (text: string): string[] => {
  const out = new Set<string>();
  for (const re of SIGN_IN_LINES) {
    for (const m of text.matchAll(re)) {
      const h = bareHost(m[1]);
      if (h) out.add(h);
    }
  }
  for (const m of text.matchAll(BINDING_FIELD)) {
    const h = bareHost(m[2]);
    if (h) out.add(h);
  }
  return [...out];
};

export const CROSS_SITE_REFUSAL = 'This message is for a different site than the one asking you to sign it';

/** Why this outside call must be refused, or null. Only text data that names a site is checked. */
export const crossSiteSignRefusal = (originator: string | undefined, args: unknown): string | null => {
  if (!originator || !args || typeof args !== 'object') return null;
  const caller = bareHost(originator);
  if (!caller) return null;
  const text = decodeText((args as { data?: unknown }).data);
  if (text === null) return null;
  const hosts = boundHosts(text);
  if (hosts.length === 0) return null;
  // Every site the message names must be the caller's: one matching field must not launder another.
  const other = hosts.find((h) => !sameSite(h, caller));
  return other ? `${CROSS_SITE_REFUSAL} (${other})` : null;
};

const SIGNING_METHODS = ['createSignature', 'createHmac'] as const;

/** Wrap the manager's signing methods so an outside originator's cross-site message is refused before any prompt. */
export function guardCrossSiteSigning<T extends object>(manager: T, adminOriginator: string): T {
  const m = manager as Record<string, unknown>;
  for (const method of SIGNING_METHODS) {
    const original = m[method];
    if (typeof original !== 'function') continue;
    m[method] = async (args: unknown, originator?: string) => {
      if (originator !== adminOriginator) {
        const refusal = crossSiteSignRefusal(originator, args);
        if (refusal) throw new Error(refusal);
      }
      return (original as (a: unknown, o?: string) => Promise<unknown>).call(manager, args, originator);
    };
  }
  return manager;
}
