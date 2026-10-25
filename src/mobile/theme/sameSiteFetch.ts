/**
 * Theme and room-look fetches never follow a redirect (bridge audit 25 Oct 2026, B8). With redirect 'follow' the
 * origin check ran only after the redirected request had already gone out, so a site's theme could make the wallet
 * send GETs anywhere (LAN, loopback). The one redirect real sites need, apex ↔ www, is handled by asking the other
 * host directly, again without following anything.
 */

/** "https://a.com/x" ↔ "https://www.a.com/x"; null for anything else. */
export const apexWwwSwap = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    u.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
    return u.toString();
  } catch {
    return null;
  }
};

/** True when `a` and `b` are the same origin, or the same https site's apex and www. */
export const sameSiteOrigin = (a: string, b: string): boolean => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    if (x.origin === y.origin) return true;
    if (x.protocol !== 'https:' || y.protocol !== 'https:' || x.port !== y.port) return false;
    const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
    return strip(x.hostname) === strip(y.hostname);
  } catch {
    return false;
  }
};

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/** fetch with redirect 'error'; when that fails, one more try at the apex/www twin (also redirect 'error'). */
export async function fetchNoRedirect(url: string, init: RequestInit, f: typeof fetch = fetch): Promise<Response> {
  const opts: RequestInit = { ...init, redirect: 'error' };
  try {
    return await f(url, opts);
  } catch (e) {
    const twin = isAbort(e) || init.signal?.aborted ? null : apexWwwSwap(url);
    if (!twin) throw e;
    return f(twin, opts);
  }
}
