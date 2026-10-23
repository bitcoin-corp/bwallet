/**
 * Which origin the wallet uses for bChatX / bit-sign (rooms, Spaces, calls, feeds, frames).
 *
 * www.bchatx.com is the home, but a registrar hold can take the name off the internet. The same bit-sign
 * deployment also answers at chat.bwalletx.com, so: probe the primary once (short timeout), fall back when
 * it doesn't answer, and remember the choice for a day (memory + localStorage) so calls never wait on a probe
 * again. Code keeps building URLs on BCHAT_PRIMARY_ORIGIN; `liveBchatUrl` (and the fetch shim) moves them to
 * the live origin. No @capacitor imports: the extension background uses this too.
 */
export const BCHAT_PRIMARY_ORIGIN = 'https://www.bchatx.com';
export const BCHAT_FALLBACK_ORIGIN = 'https://chat.bwalletx.com';
/** Every origin that is bChatX: what the wallet may frame, trust or link-parse as bChatX. */
export const BCHAT_ORIGINS = [BCHAT_PRIMARY_ORIGIN, BCHAT_FALLBACK_ORIGIN] as const;
/** The same, as bare hosts (with the apex bchatx.com, which redirects to www). */
export const BCHAT_HOSTS = ['bchatx.com', 'www.bchatx.com', 'chat.bwalletx.com'] as const;

export const BCHAT_PROBE_TIMEOUT_MS = 2500;
export const BCHAT_CHOICE_TTL_MS = 24 * 60 * 60 * 1000;
export const BCHAT_ORIGIN_STORAGE_KEY = 'bwallet.bchatOrigin';

type Store = { get(): string | null; set(v: string): void };
export type OriginDeps = {
  /** Resolves true when the origin answered at all (any HTTP status), false on network error/timeout. */
  probe: (origin: string, timeoutMs: number) => Promise<boolean>;
  now: () => number;
  store: Store;
};

const localStore: Store = {
  get: () => {
    try {
      return globalThis.localStorage?.getItem(BCHAT_ORIGIN_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      globalThis.localStorage?.setItem(BCHAT_ORIGIN_STORAGE_KEY, v);
    } catch {
      /* private mode / no storage: memory only */
    }
  },
};

/** no-cors GET of /: an opaque answer still proves DNS + TLS + server are up. */
export const fetchProbe = async (origin: string, timeoutMs: number): Promise<boolean> => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetch(`${origin}/`, {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: ctl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
};

const defaultDeps = (): OriginDeps => ({ probe: fetchProbe, now: () => Date.now(), store: localStore });

let current: string | null = null;
let pending: Promise<string> | null = null;

const isKnown = (o: unknown): o is string => typeof o === 'string' && (BCHAT_ORIGINS as readonly string[]).includes(o);

const readCached = (deps: OriginDeps): string | null => {
  try {
    const raw = deps.store.get();
    if (!raw) return null;
    const { origin, at } = JSON.parse(raw) as { origin?: unknown; at?: unknown };
    if (!isKnown(origin) || typeof at !== 'number') return null;
    const age = deps.now() - at;
    return age >= 0 && age < BCHAT_CHOICE_TTL_MS ? origin : null;
  } catch {
    return null;
  }
};

/** Pure selection: cached choice if fresh, else primary if it answers, else the fallback. */
export const chooseBchatOrigin = async (deps: OriginDeps): Promise<string> => {
  const cached = readCached(deps);
  if (cached) return cached;
  const origin = (await deps.probe(BCHAT_PRIMARY_ORIGIN, BCHAT_PROBE_TIMEOUT_MS))
    ? BCHAT_PRIMARY_ORIGIN
    : BCHAT_FALLBACK_ORIGIN;
  deps.store.set(JSON.stringify({ origin, at: deps.now() }));
  return origin;
};

/** The live origin, resolving it (once per session, cached a day) on first use. */
export const ensureBchatOrigin = (deps: OriginDeps = defaultDeps()): Promise<string> => {
  if (current) return Promise.resolve(current);
  pending ??= chooseBchatOrigin(deps)
    .catch(() => BCHAT_PRIMARY_ORIGIN)
    .then((o) => (current = o));
  return pending;
};

/** Sync best guess (for img src / frame src built during render): resolved, else cached, else primary. */
export const bchatOrigin = (): string => current ?? readCached(defaultDeps()) ?? BCHAT_PRIMARY_ORIGIN;

/** A URL on the primary (or apex) bChatX origin moved to `origin`; any other URL unchanged. */
export const liveBchatUrl = (url: string, origin: string = bchatOrigin()): string => {
  if (origin === BCHAT_PRIMARY_ORIGIN) return url;
  for (const p of [BCHAT_PRIMARY_ORIGIN, 'https://bchatx.com']) {
    if (url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`) || url.startsWith(`${p}#`)) {
      return origin + url.slice(p.length);
    }
  }
  return url;
};

const onPrimary = (url: string) => liveBchatUrl(url, BCHAT_FALLBACK_ORIGIN) !== url;

/** Rewrites a request URL for the live origin (awaiting the first resolution only for bChatX URLs). */
export const routeBchatUrl = async (url: string, deps?: OriginDeps): Promise<string> =>
  onPrimary(url) ? liveBchatUrl(url, await ensureBchatOrigin(deps)) : url;

/** Wrap globalThis.fetch so every bChatX request follows the live origin. Idempotent. */
export function installBchatFetch(): void {
  const g = globalThis as typeof globalThis & { __bchatFetch?: boolean };
  if (g.__bchatFetch || typeof g.fetch !== 'function') return;
  g.__bchatFetch = true;
  const inner = g.fetch.bind(g);
  g.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!onPrimary(url)) return inner(input, init);
    const live = await routeBchatUrl(url);
    if (live === url) return inner(input, init);
    return inner(typeof input === 'string' || input instanceof URL ? live : new Request(live, input), init);
  };
}

/** Tests only. */
export const resetBchatOriginForTests = () => {
  current = null;
  pending = null;
};
