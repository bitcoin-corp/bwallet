import type { SocialProfile } from '../chat/api';
import { PAYMAIL_ALIAS_RE, toAlias } from '../names/paymail';
import { isPlaceholderName } from '../names/handlePrompt';

/**
 * "Link your X (Twitter)" on Create your master password (owner, 24 Oct 2026, reversing the 18 Oct password-only
 * screen). Linking X is optional and never signs anyone in: it fills the (still editable) account name and photo,
 * and the "Claim your name" step then offers $handle when handle@<our domain> is free. Never auto-claimed.
 * Handle rules: $ = paymail, @ = social; names are case-insensitive; nothing here ever comes from an email.
 */

/** The plain paymail alias an X profile gives first claim on ('' when it has none, or for any other provider). */
export const xAlias = (p: Pick<SocialProfile, 'provider' | 'name' | 'suggested_handle'> | null | undefined) => {
  if (!p || p.provider !== 'x') return '';
  const a = toAlias(String(p.suggested_handle || p.name || '').replace(/^@/, ''));
  return PAYMAIL_ALIAS_RE.test(a) ? a : '';
};

/** Create Account prefill from a linked X profile: the display name (else the @handle) and the X photo. */
export const xPrefill = (p: Pick<SocialProfile, 'provider' | 'name' | 'display' | 'avatar'>) => {
  const handle = String(p.name || '').replace(/^@/, '');
  const display = String(p.display || '').trim();
  return { name: display && !isPlaceholderName(display) ? display : handle, avatar: p.avatar || '' };
};

/** Other plain names to try when handle@<domain> is taken (the old .x form is no longer handed out, 9 Oct 2026). */
export const xAlternatives = (alias: string): string[] =>
  [`${alias}x`, `${alias}-x`, `${alias}_b`, `${alias}1`].filter((a) => PAYMAIL_ALIAS_RE.test(a));

export type XOffer =
  | { kind: 'take'; alias: string }
  | { kind: 'taken'; alias: string; alternatives: string[] }
  | { kind: 'none' };

/**
 * What "Claim your name" proposes for a linked X account. `free` answers whether handle@<domain> is available
 * (null = not known yet / couldn't check: propose nothing rather than a name that might not be free);
 * `freeAlts` lists the alternatives that were checked and are free.
 */
export const xOffer = (alias: string, free: boolean | null, freeAlts: string[] = []): XOffer => {
  if (!alias || free === null) return { kind: 'none' };
  if (free) return { kind: 'take', alias };
  return { kind: 'taken', alias, alternatives: freeAlts };
};

/** Check handle@<domain> and, when taken, which alternatives are free. `available` = paymailAvailable. */
export const checkXOffer = async (alias: string, available: (a: string) => Promise<boolean>): Promise<XOffer> => {
  if (!alias) return { kind: 'none' };
  let free: boolean | null;
  try {
    free = await available(alias);
  } catch {
    free = null;
  }
  if (free !== false) return xOffer(alias, free);
  const alts: string[] = [];
  for (const a of xAlternatives(alias)) {
    if (alts.length >= 3) break;
    if (await available(a).catch(() => false)) alts.push(a);
  }
  return xOffer(alias, false, alts);
};

/**
 * The X handle captured when X was linked on Create, kept for the whole create flow (owner, 24 Oct 2026): the
 * server's sign-in ticket lasts 10 minutes, but a plain-name claim doesn't need it, so "Claim your name" can still
 * offer $handle from this. Up to 60 minutes; cleared once the offer has been used or closed.
 */
const XKEY = 'bwallet.createXHandle';
export const X_HANDLE_TTL_MS = 60 * 60_000;
type Stash = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const store = (): Stash | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
export const rememberXHandle = (alias: string, now = Date.now(), s: Stash | null = store()) => {
  try {
    if (alias) s?.setItem(XKEY, JSON.stringify({ alias, at: now }));
  } catch {
    /* private mode */
  }
};
export const rememberedXHandle = (now = Date.now(), s: Stash | null = store()): string => {
  try {
    const v = JSON.parse(s?.getItem(XKEY) || 'null') as { alias?: string; at?: number } | null;
    if (v?.alias && typeof v.at === 'number' && now - v.at < X_HANDLE_TTL_MS && PAYMAIL_ALIAS_RE.test(v.alias))
      return v.alias;
    s?.removeItem(XKEY);
  } catch {
    /* ignore */
  }
  return '';
};
export const forgetXHandle = (s: Stash | null = store()) => {
  try {
    s?.removeItem(XKEY);
  } catch {
    /* ignore */
  }
};
