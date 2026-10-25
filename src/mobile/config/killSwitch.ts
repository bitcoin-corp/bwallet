/**
 * Kill switches (docs/MONEY-GUARD.md): pause one feature in every shipped copy of the wallet without a release.
 *
 * The owner edits `status.json` in bwalletx-site and pushes; Vercel serves it at STATUS_URL within minutes and
 * every wallet picks it up within STATUS_TTL. Shape:
 *
 *   { "paused": ["passkeyCreate", { "feature": "spending", "versions": ["5.2.39"] }] }
 *
 * A switch can only turn a feature OFF, never on, and only from the fixed list below. Recovery (unlock, show the
 * 12 words, backups, restore, including restore with a passkey) is never on the list, so no switch can stop anyone getting at their money. The pause
 * message is built in, never taken from the file, so a tampered file can't put a phishing message in the wallet.
 * It fails OPEN: no file, a bad file or no network → nothing paused.
 */
export const STATUS_URL = 'https://bwalletx.com/status.json';
export const STATUS_TTL = 10 * 60_000;
const FETCH_TIMEOUT = 3000;

export const KILL_FEATURES = ['spending', 'passkeyCreate'] as const;
export type KillFeature = (typeof KILL_FEATURES)[number];

export const PAUSED_MESSAGE = 'Paused for a fix. Your money is safe. Please try again soon.';

export class FeaturePausedError extends Error {
  constructor(readonly feature: KillFeature) {
    super(PAUSED_MESSAGE);
    this.name = 'FeaturePausedError';
  }
}

const isFeature = (v: unknown): v is KillFeature => KILL_FEATURES.includes(v as KillFeature);

/** The running version (extension manifest; the phone builds shim chrome.runtime). Unknown → null. */
export const appVersion = (): string | null => {
  try {
    return typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : null;
  } catch {
    return null;
  }
};

/** Which features the file pauses for this version. An entry with `versions` applies only to those versions. */
export const parseStatus = (raw: unknown, version: string | null): Set<KillFeature> => {
  const out = new Set<KillFeature>();
  const list = (raw as { paused?: unknown } | null)?.paused;
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    if (isFeature(e)) out.add(e);
    else if (e && typeof e === 'object' && isFeature((e as { feature?: unknown }).feature)) {
      const versions = (e as { versions?: unknown }).versions;
      // An unknown version is treated as matching: pausing too much is safer than too little.
      if (!Array.isArray(versions) || !version || versions.includes(version))
        out.add((e as { feature: KillFeature }).feature);
    }
  }
  return out;
};

let cache: { at: number; paused: Set<KillFeature> } | null = null;
let inflight: Promise<Set<KillFeature>> | null = null;

/** Paused features, from a fresh (<10 min) in-memory copy or the network. Never throws. */
export const getPaused = async (
  f: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
  now = Date.now(),
): Promise<Set<KillFeature>> => {
  if (cache && now - cache.at < STATUS_TTL) return cache.paused;
  if (inflight) return inflight;
  inflight = (async () => {
    let paused = new Set<KillFeature>();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
      const r = await f(STATUS_URL, { cache: 'no-store', signal: ctl.signal }).finally(() => clearTimeout(t));
      if (r.ok) paused = parseStatus(await r.json(), appVersion());
    } catch {
      /* fail open */
    }
    cache = { at: now, paused };
    inflight = null;
    return paused;
  })();
  return inflight;
};

export const isPaused = async (feature: KillFeature): Promise<boolean> => (await getPaused()).has(feature);

/** Throws FeaturePausedError when `feature` is paused. */
export const assertNotPaused = async (feature: KillFeature): Promise<void> => {
  if (await isPaused(feature)) throw new FeaturePausedError(feature);
};

/**
 * Wrap the wallet so createAction and signAction refuse while `spending` is paused. This is the one door every
 * payment goes through (our screens, dApps and background jobs alike). Reads, receiving and unlock are untouched.
 */
export function guardSpending<T extends object>(
  wallet: T,
  check: () => Promise<void> = () => assertNotPaused('spending'),
): T {
  const w = wallet as Record<string, unknown>;
  for (const method of ['createAction', 'signAction'] as const) {
    const original = w[method];
    if (typeof original !== 'function') continue;
    w[method] = async (...args: unknown[]) => {
      await check();
      return (original as (...a: unknown[]) => Promise<unknown>).apply(wallet, args);
    };
  }
  // A signature over a tx digest (hashToDirectlySign) is how escrow, memepool, launchpad and bTrust sign their own
  // transactions outside createAction: while spending is paused those signatures are refused too (b-Aware 25 Oct).
  const sign = w.createSignature;
  if (typeof sign === 'function')
    w.createSignature = async (...args: unknown[]) => {
      if ((args[0] as { hashToDirectlySign?: unknown } | undefined)?.hashToDirectlySign !== undefined) await check();
      return (sign as (...a: unknown[]) => Promise<unknown>).apply(wallet, args);
    };
  return wallet;
}

/** Test hook. */
export const resetKillSwitchCache = () => {
  cache = null;
  inflight = null;
};
