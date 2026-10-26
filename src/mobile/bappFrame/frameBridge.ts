/**
 * In-frame bApps: pure helpers (no DOM, no React) so they can be unit-tested.
 *
 * A bApp hosted in-frame is a cross-origin <iframe> inside the wallet WebView. The native
 * provider script is not injected into iframes, so the page reaches the wallet over the
 * BRC-100 XDM substrate (@bsv/sdk WalletClient's postMessage fallback):
 *   page → parent: { type: 'CWI', isInvocation: true, id, call, args }
 *   parent → page: { type: 'CWI', isInvocation: false, id, status: 'success', result }
 *                | { type: 'CWI', isInvocation: false, id, status: 'error', description, code }
 * Only origins in the bApps tile list may frame, and only the frame we created may call.
 */
import { isCWIEventName } from '@1sat/wallet-browser';
import { isMintPrivateAction, isMintPrivateCode } from '../../services/mintPrivateAction';
import { USER_DENIED_CODE, USER_DENIED_MESSAGE, isUserDenied } from '../../services/userDenied';

/** Exact origins (scheme://host[:port]) of the given URLs; invalid or non-https URLs are skipped. */
export const frameAllowlist = (urls: readonly string[]): Set<string> => {
  const out = new Set<string>();
  for (const u of urls) {
    try {
      const url = new URL(u);
      if (url.protocol === 'https:') out.add(url.origin);
    } catch {
      /* skip */
    }
  }
  return out;
};

/** True when `origin` is exactly one of the allowlisted origins (no suffix/prefix games). */
export const isAllowedFrameOrigin = (origin: string, allowlist: ReadonlySet<string>): boolean => {
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    // `origin` must already be a bare origin, not a URL with a path.
    if (parsed.origin !== origin || parsed.protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return allowlist.has(origin);
};

/** The allowlisted origin of a URL to open in-frame, or null. */
export const frameOriginFor = (url: string, allowlist: ReadonlySet<string>): string | null => {
  try {
    const o = new URL(url).origin;
    return isAllowedFrameOrigin(o, allowlist) ? o : null;
  } catch {
    return null;
  }
};

export type XdmRequest = { id: string; call: string; args: Record<string, unknown> };

const MAX_ID = 128;

/** Validates an XDM invocation; returns null for anything that is not a well-formed BRC-100 call. */
export const parseXdmRequest = (data: unknown): XdmRequest | null => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== 'CWI' || d.isInvocation !== true) return null;
  if (typeof d.id !== 'string' || d.id.length === 0 || d.id.length > MAX_ID) return null;
  if (typeof d.call !== 'string' || !(isCWIEventName(d.call) || isMintPrivateAction(d.call))) return null;
  const args = d.args === undefined ? {} : d.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return { id: d.id, call: d.call, args: args as Record<string, unknown> };
};

/** The wallet's internal reply shape ({ success, data, error }) as an XDM response. */
export const toXdmResponse = (id: string, reply: unknown) => {
  const r = (typeof reply === 'object' && reply !== null ? reply : {}) as {
    success?: boolean;
    data?: unknown;
    error?: unknown;
    code?: unknown;
  };
  if (r.success === true) return { type: 'CWI', isInvocation: false, id, status: 'success', result: r.data } as const;
  // The user declined: the standard code, never the generic 1 (services/userDenied.ts).
  if (r.code === USER_DENIED_CODE || isUserDenied(r.error))
    return {
      type: 'CWI',
      isInvocation: false,
      id,
      status: 'error',
      description: USER_DENIED_MESSAGE,
      code: USER_DENIED_CODE,
    } as const;
  const description = typeof r.error === 'string' && r.error ? r.error : 'Request failed';
  // wallet.mintPrivate refusals keep their code so the site can read it (services/mintPrivateAction.ts).
  if (isMintPrivateCode(r.code))
    return { type: 'CWI', isInvocation: false, id, status: 'error', description, code: r.code } as const;
  return { type: 'CWI', isInvocation: false, id, status: 'error', description, code: 1 } as const;
};

/**
 * Whether response headers let `parentOrigin` frame the page. CSP frame-ancestors wins over
 * X-Frame-Options when present (as browsers do). Conservative: anything unclear → false.
 */
export const framingAllowed = (headers: Record<string, string | undefined>, parentOrigin: string): boolean => {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') h[k.toLowerCase()] = v;

  const csp = h['content-security-policy'];
  const fa = csp
    ?.split(/[;,]/)
    .map((d) => d.trim())
    .filter((d) => /^frame-ancestors(\s|$)/i.test(d));
  if (fa && fa.length > 0) {
    // Every frame-ancestors directive present must allow us.
    return fa.every((d) => sourceListAllows(d.split(/\s+/).slice(1), parentOrigin));
  }
  const xfo = h['x-frame-options']?.trim().toLowerCase();
  if (!xfo) return true;
  return false; // DENY, SAMEORIGIN (we are never same-origin), ALLOW-FROM (unsupported) → refuse.
};

const sourceListAllows = (sources: string[], parentOrigin: string): boolean => {
  let parent: URL;
  try {
    parent = new URL(parentOrigin);
  } catch {
    return false;
  }
  return sources.some((raw) => {
    const s = raw.trim();
    if (s === '*') return parent.protocol === 'https:' || parent.protocol === 'http:';
    if (s === "'none'" || s === "'self'" || s.startsWith("'")) return false;
    // Scheme-only source, e.g. `capacitor:`.
    if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) return s.toLowerCase() === parent.protocol;
    const m = s.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\*|\d+))?(\/.*)?$/i);
    if (!m) return false;
    const [, scheme, wild, host, port] = m;
    if (scheme && `${scheme.toLowerCase()}:` !== parent.protocol) return false;
    const ph = parent.hostname.toLowerCase();
    const hl = host.toLowerCase();
    if (wild ? !ph.endsWith(`.${hl}`) : ph !== hl) return false;
    if (port && port !== '*' && port !== (parent.port || defaultPort(parent.protocol))) return false;
    return true;
  });
};

const defaultPort = (protocol: string) => (protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '');
