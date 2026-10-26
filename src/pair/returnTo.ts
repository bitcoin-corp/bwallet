/**
 * Return-to-site after a phone pairing (docs/PAIRING-ORIGIN-PROOF.md, "Return to the site (v2)").
 *
 * A v2 pairing link may carry `ret` (where to send the user after Allow), `rid` (a one-time request id) and `b` (the
 * browser that opened it). The wallet sends the user back only when ALL of these hold, else it shows the usual
 * "switch back" screen:
 *   - the v2 proof `s2` verifies against the origin's well-known keys (it binds c, k, o, e, ret, rid and b);
 *   - `ret` is https, has no userinfo, no explicit port, and its host is the proven origin's host or a subdomain;
 *   - `rid` has not been used on this device in the last 24 hours.
 * The user always lands on an https URL on the proven site, so there is no open redirect.
 *
 * Pure apart from the default nonce store (localStorage), so every rule is unit-tested in returnTo.test.ts.
 */
import { RET_MAX_BYTES, RID_RE, type BrowserHint, type PairLink } from './protocol';

/** True when `ret` may be used as the return for a pairing proven to come from `origin`. */
export function isAllowedReturn(ret: string, origin: string): boolean {
  if (!ret || ret.length > RET_MAX_BYTES) return false;
  try {
    const o = new URL(origin);
    const r = new URL(ret);
    if (o.protocol !== 'https:' || r.protocol !== 'https:') return false;
    if (r.username || r.password || r.port) return false;
    if (o.port) return false; // proven origins with a port are dev setups; no automatic return there
    const host = r.hostname.toLowerCase();
    const base = o.hostname.toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  } catch {
    return false;
  }
}

/** One-time request ids, remembered for a day (a small LRU). */
export const RID_TTL_MS = 24 * 60 * 60 * 1000;
const RID_MAX = 200;
const RID_KEY = 'bwalletxPairRids';

export type KV = { get(k: string): string | null; set(k: string, v: string): void };
const localKv: KV = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable: the rid is then single use only in memory */
    }
  },
};
const memory = new Map<string, number>();

/**
 * Marks `rid` as used. True the first time, false when it was already used in the last 24 h (a replayed link).
 * If storage can't be read the in-memory copy still refuses a reuse in this run.
 */
export function claimRid(rid: string, now = Date.now(), kv: KV = localKv): boolean {
  if (!RID_RE.test(rid)) return false;
  let seen: Record<string, number> = {};
  try {
    const raw = kv.get(RID_KEY);
    if (raw) seen = JSON.parse(raw) as Record<string, number>;
  } catch {
    seen = {};
  }
  for (const [k, t] of memory) if (!(k in seen)) seen[k] = t;
  const fresh = Object.entries(seen).filter(([, t]) => typeof t === 'number' && now - t < RID_TTL_MS);
  if (fresh.some(([k]) => k === rid)) return false;
  fresh.push([rid, now]);
  const kept = fresh.sort((a, b) => a[1] - b[1]).slice(-RID_MAX);
  memory.set(rid, now);
  kv.set(RID_KEY, JSON.stringify(Object.fromEntries(kept)));
  return true;
}
/** Tests only. */
export const resetRidMemory = () => memory.clear();

/** The decision taken when the pairing is checked: return to `ret` (still subject to the rid) or not at all. */
export type ReturnPlan = { ret: string; rid: string; b?: BrowserHint } | null;
export function planReturn(link: PairLink, origin: string, v2Proven: boolean): ReturnPlan {
  if (!v2Proven || !link.ret || !link.rid) return null;
  if (origin !== link.o) return null;
  if (!isAllowedReturn(link.ret, link.o)) return null;
  return { ret: link.ret, rid: link.rid, ...(link.b && { b: link.b }) };
}

/** `ret` with the result in the fragment (never sent to the server): `#bwx=ok&rid=<rid>`. */
export const returnTarget = (ret: string, rid: string) => {
  const u = new URL(ret);
  u.hash = `bwx=ok&rid=${encodeURIComponent(rid)}`;
  return u.toString();
};

/** Android browser packages for each hint; anything else returns through the https fallback (default browser). */
export const ANDROID_BROWSERS: Partial<Record<BrowserHint, string>> = {
  chrome: 'com.android.chrome',
  samsung: 'com.sec.android.app.sbrowser',
  firefox: 'org.mozilla.firefox',
  edge: 'com.microsoft.emmx',
  brave: 'com.brave.browser',
};

export type ReturnPlatform = 'ios' | 'android' | 'web';

/**
 * The URL the wallet opens to send the user back, for the browser they came from:
 * - iOS: Safari (and unknown) get the https URL; Chrome gets googlechromes://; Firefox gets firefox://open-url.
 * - Android: intent://… naming the browser package, with the https URL as S.browser_fallback_url.
 * - web wallet: the https URL (it is already in that browser).
 */
export function returnUrlFor(target: string, b: BrowserHint | undefined, platform: ReturnPlatform): string {
  const u = new URL(target);
  if (u.protocol !== 'https:') throw new Error('return must be https');
  const rest = target.slice('https://'.length);
  if (platform === 'ios') {
    if (b === 'chrome') return `googlechromes://${rest}`;
    if (b === 'firefox') return `firefox://open-url?url=${encodeURIComponent(target)}`;
    return target;
  }
  if (platform === 'android') {
    const pkg = b ? ANDROID_BROWSERS[b] : undefined;
    if (!pkg) return target;
    // Intent.parseUri splits at the LAST '#', so the target's own #bwx=… fragment stays in the data URI.
    return `intent://${rest}#Intent;scheme=https;package=${pkg};S.browser_fallback_url=${encodeURIComponent(target)};end`;
  }
  return target;
}
