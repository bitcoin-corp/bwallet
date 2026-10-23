/**
 * Streaming spending grants (bMovies watch-to-pay, P3w).
 *
 * A site asks once (`requestSpendingAuthorization` in @bwalletx/connect) to stream small payments while the user
 * watches: "Allow bmovies.online to stream up to $X/hour". The user approves one sheet (and may lower the cap).
 * After that, createAction calls from THAT originator, carrying THAT protocol's label, are approved without a
 * sheet while they fit in the rolling one-hour budget and the grant has not expired. Everything else still prompts.
 *
 * - The originator always comes from the browser (Chrome's sender.origin / the native WebView), never from the page.
 * - Budget is a rolling 60-minute window per grant, and a global ceiling across all grants.
 * - A global kill switch ("Pause all streaming") turns every grant off at once.
 * - An over-budget, expired, revoked or paused grant does not refuse the payment: it just falls back to the
 *   normal approval sheet, exactly as if there were no grant.
 *
 * Pure functions on a plain state object, so the rules are unit tested (streamGrants.test.ts); background.ts
 * owns persistence (chrome.storage.local, key STREAM_GRANTS_KEY) and the wiring.
 */

export const STREAM_GRANTS_KEY = 'bwxStreamGrants';

/** Page → wallet message types (content.ts / mobile provider forward these like CWI calls). */
export const SPENDING_AUTH_REQUEST = 'bwxSpendingAuthRequest';
export const SPENDING_AUTH_REVOKE = 'bwxSpendingAuthRevoke';
export const SPENDING_AUTH_STATUS = 'bwxSpendingAuthStatus';
export const SPENDING_AUTH_ACTIONS: readonly string[] = [
  SPENDING_AUTH_REQUEST,
  SPENDING_AUTH_REVOKE,
  SPENDING_AUTH_STATUS,
];
export const isSpendingAuthAction = (type: unknown): boolean =>
  typeof type === 'string' && SPENDING_AUTH_ACTIONS.includes(type);

/** Version a page can feature-detect (window.CWI.spendingAuthorizationVersion). */
export const SPENDING_AUTH_VERSION = 1;

export const HOUR_MS = 60 * 60_000;
/** Default global ceiling across every streaming grant: 2,000,000 sats an hour (0.02 BSV). User editable. */
export const DEFAULT_CEILING_SATS_PER_HOUR = 2_000_000;
/** A grant lasts at most this long; longer requests are cut to it. */
export const MAX_GRANT_MS = 24 * HOUR_MS;
/** With no expiry in the request: four hours. */
export const DEFAULT_GRANT_MS = 4 * HOUR_MS;

export type StreamSpend = { at: number; sats: number; txid?: string };

export interface StreamGrant {
  id: string;
  /** Browser-derived originator (originKey.ts), e.g. "bmovies.online". */
  originator: string;
  protocolID: [2, string];
  /** The createAction label an action must carry: the protocol name, protocolID[1]. */
  label: string;
  capSatsPerHour: number;
  /** ms since epoch. */
  expiresAt: number;
  createdAt: number;
  description?: string;
  revokedAt?: number;
  /** Spends inside the last hour (older ones are pruned); `totalSats` keeps the lifetime count. */
  spends: StreamSpend[];
  totalSats: number;
}

export interface StreamState {
  grants: StreamGrant[];
  ceilingSatsPerHour: number;
  /** Kill switch: when true no grant auto-approves anything. */
  paused: boolean;
}

export const emptyStreamState = (): StreamState => ({
  grants: [],
  ceilingSatsPerHour: DEFAULT_CEILING_SATS_PER_HOUR,
  paused: false,
});

/** Read whatever is stored, tolerating junk. */
export const parseStreamState = (raw: unknown): StreamState => {
  const base = emptyStreamState();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<StreamState>;
  return {
    grants: Array.isArray(r.grants) ? r.grants.filter((g) => g && typeof g.id === 'string') : [],
    ceilingSatsPerHour:
      typeof r.ceilingSatsPerHour === 'number' && r.ceilingSatsPerHour >= 0
        ? Math.floor(r.ceilingSatsPerHour)
        : base.ceilingSatsPerHour,
    paused: r.paused === true,
  };
};

export interface SpendingAuthRequest {
  protocolID: [2, string];
  capSatsPerHour: number;
  /** ms since epoch, already clamped. */
  expiresAt: number;
  description?: string;
}

/** BRC-100 protocol name rules (5-400 chars, lowercase letters, digits, spaces). */
const PROTOCOL_NAME = /^[a-z0-9 ]{5,400}$/;

/**
 * Validate a page's request. `expiry` is Unix seconds (BRC-100 style); a value over 1e12 is read as ms.
 * Anything the page sends that is not listed here (an `originator` field, say) is ignored.
 */
export const parseSpendingAuthRequest = (
  params: unknown,
  now: number,
): { ok: true; request: SpendingAuthRequest } | { ok: false; error: string } => {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const pid = p.protocolID;
  if (!Array.isArray(pid) || pid.length !== 2 || pid[0] !== 2 || typeof pid[1] !== 'string')
    return { ok: false, error: 'protocolID must be [2, "<protocol name>"]' };
  const name = pid[1].trim().toLowerCase().replace(/\s+/g, ' ');
  if (!PROTOCOL_NAME.test(name) || name.includes('  ') || name.endsWith(' protocol'))
    return { ok: false, error: 'Invalid protocol name' };
  const cap = p.capSatsPerHour;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1 || cap > 21e14)
    return { ok: false, error: 'capSatsPerHour must be a positive number of satoshis' };
  let expiresAt: number;
  if (p.expiry === undefined || p.expiry === null) expiresAt = now + DEFAULT_GRANT_MS;
  else if (typeof p.expiry !== 'number' || !Number.isFinite(p.expiry))
    return { ok: false, error: 'expiry must be a number' };
  else expiresAt = p.expiry > 1e12 ? p.expiry : p.expiry * 1000;
  if (expiresAt <= now) return { ok: false, error: 'expiry is in the past' };
  expiresAt = Math.min(expiresAt, now + MAX_GRANT_MS);
  const description = typeof p.description === 'string' ? p.description.trim().slice(0, 140) || undefined : undefined;
  return { ok: true, request: { protocolID: [2, name], capSatsPerHour: Math.floor(cap), expiresAt, description } };
};

const inWindow = (s: StreamSpend, now: number) => now - s.at < HOUR_MS && s.at <= now;

/** Sats this grant has spent in the last hour. */
export const spentLastHour = (g: StreamGrant, now: number): number =>
  g.spends.reduce((t, s) => (inWindow(s, now) ? t + s.sats : t), 0);

/** Sats every grant has spent in the last hour (for the global ceiling). */
export const totalSpentLastHour = (state: StreamState, now: number): number =>
  state.grants.reduce((t, g) => t + spentLastHour(g, now), 0);

export const isActive = (g: StreamGrant, now: number): boolean => !g.revokedAt && g.expiresAt > now;

/** What may still go out under this grant in the current hour (its own cap and the global ceiling). */
export const budgetLeft = (state: StreamState, g: StreamGrant, now: number): number =>
  Math.max(
    0,
    Math.min(g.capSatsPerHour - spentLastHour(g, now), state.ceilingSatsPerHour - totalSpentLastHour(state, now)),
  );

/** The live grant for (originator, label), if any. */
export const findGrant = (
  state: StreamState,
  originator: string,
  label: string,
  now: number,
): StreamGrant | undefined =>
  state.grants.find((g) => g.originator === originator && g.label === label && isActive(g, now));

export type StreamDecision =
  | { approve: true; grant: StreamGrant; budget: number }
  | {
      approve: false;
      reason: 'paused' | 'no-label' | 'no-grant' | 'over-budget';
    };

/**
 * May this createAction go out without a sheet? `labels` are the action's labels; `sats` what it pays out
 * (the sum of its outputs; the permissions manager re-checks the exact net spend against `budget`).
 */
export const decide = (
  state: StreamState,
  q: { originator: string | undefined; labels: readonly string[] | undefined; sats: number; now: number },
): StreamDecision => {
  if (state.paused) return { approve: false, reason: 'paused' };
  if (!q.originator) return { approve: false, reason: 'no-grant' };
  const labels = (q.labels ?? []).map((l) => String(l).trim().toLowerCase());
  const candidates = state.grants.filter((g) => g.originator === q.originator && isActive(g, q.now));
  if (!candidates.length) return { approve: false, reason: 'no-grant' };
  const grant = candidates.find((g) => labels.includes(g.label));
  if (!grant) return { approve: false, reason: 'no-label' };
  const budget = budgetLeft(state, grant, q.now);
  if (!(q.sats >= 0) || q.sats > budget) return { approve: false, reason: 'over-budget' };
  return { approve: true, grant, budget };
};

const prune = (g: StreamGrant, now: number): StreamGrant => ({
  ...g,
  spends: g.spends.filter((s) => inWindow(s, now)),
});

/** Add a grant; one live grant per (originator, label), so an older one for the same pair is replaced. */
export const addGrant = (state: StreamState, grant: StreamGrant): StreamState => ({
  ...state,
  grants: [...state.grants.filter((g) => !(g.originator === grant.originator && g.label === grant.label)), grant],
});

export const recordSpend = (state: StreamState, grantId: string, spend: StreamSpend): StreamState => ({
  ...state,
  grants: state.grants.map((g) =>
    g.id === grantId ? prune({ ...g, spends: [...g.spends, spend], totalSats: g.totalSats + spend.sats }, spend.at) : g,
  ),
});

/**
 * Revoke a grant. With `originator`, only that site's grant (what a page may revoke); without, any (the
 * wallet's own Settings). Returns undefined when nothing matched.
 */
export const revokeGrant = (
  state: StreamState,
  id: string,
  now: number,
  originator?: string,
): StreamState | undefined => {
  const g = state.grants.find((x) => x.id === id && (originator === undefined || x.originator === originator));
  if (!g) return undefined;
  return { ...state, grants: state.grants.map((x) => (x.id === id ? { ...x, revokedAt: x.revokedAt ?? now } : x)) };
};

/** Drop revoked/expired grants older than a day so storage doesn't grow. */
export const tidy = (state: StreamState, now: number): StreamState => ({
  ...state,
  grants: state.grants
    .filter((g) => isActive(g, now) || now - Math.max(g.revokedAt ?? 0, g.expiresAt) < 24 * HOUR_MS)
    .map((g) => prune(g, now)),
});

export const newGrantId = (): string => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'sg_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

/** The grant as a page sees it (no spend history). */
export const publicGrant = (g: StreamGrant, state: StreamState, now: number) => ({
  grantId: g.id,
  protocolID: g.protocolID,
  capSatsPerHour: g.capSatsPerHour,
  expiry: Math.floor(g.expiresAt / 1000),
  spentLastHourSats: spentLastHour(g, now),
  remainingSats: isActive(g, now) && !state.paused ? budgetLeft(state, g, now) : 0,
  active: isActive(g, now) && !state.paused,
});

/** Sum of a createAction's outputs (what it pays out, before fee). */
export const outputSats = (outputs: readonly { satoshis?: number }[] | undefined): number =>
  (outputs ?? []).reduce((t, o) => t + (typeof o.satoshis === 'number' && o.satoshis > 0 ? o.satoshis : 0), 0);

/**
 * Fee headroom for the permissions manager's exact net spend over the outputs' sum. A tick is a handful of
 * outputs; 2,000 sats covers any fee rate the wallet uses for it and is itself charged to the budget.
 */
export const FEE_HEADROOM_SATS = 2_000;

/**
 * In-flight pass, one per originator: the background sets it while a stream-approved createAction is running so
 * the permissions manager's spending and label prompts for THAT call are answered without a sheet.
 */
export interface StreamPass {
  grantId: string;
  originator: string;
  label: string;
  /** The most the manager may report as net spend for this call. */
  maxSats: number;
  /** What the manager actually asked for (the exact net spend, fee included). */
  charged?: number;
}

/** Should this permission-manager request be answered by the pass? Only that site's spend (within max) and its label. */
export const passCovers = (
  pass: StreamPass | undefined,
  req: { type: string; originator?: string; protocolID?: unknown; spending?: { satoshis?: number } },
): boolean => {
  if (!pass || !req.originator || req.originator !== pass.originator) return false;
  if (req.type === 'spending') {
    const s = req.spending?.satoshis;
    return typeof s === 'number' && s >= 0 && s <= pass.maxSats;
  }
  if (req.type === 'protocol') {
    const pid = req.protocolID as [number, string] | undefined;
    return Array.isArray(pid) && pid[0] === 1 && pid[1] === `action label ${pass.label}`;
  }
  return false;
};

type WithStreamOption = { options?: object };

/** The protocol name a createAction names in options.spendingAuthorization.protocolID, if any (as a label). */
export const streamProtocolOption = (args: WithStreamOption): string[] => {
  const pid = (
    (args.options as { spendingAuthorization?: unknown } | undefined)?.spendingAuthorization as
      | { protocolID?: unknown }
      | undefined
  )?.protocolID;
  return Array.isArray(pid) && pid[0] === 2 && typeof pid[1] === 'string' ? [pid[1]] : [];
};

/** The args without options.spendingAuthorization (the signer only sees BRC-100 fields). */
export const withoutStreamOption = <T extends WithStreamOption>(args: T): T => {
  if (!args.options || !('spendingAuthorization' in args.options)) return args;
  const { spendingAuthorization: _drop, ...options } = args.options as { spendingAuthorization?: unknown };
  void _drop;
  return { ...args, options } as T;
};

/** "$1.20" from sats at a USD/BSV rate; undefined without a rate. USD first on every screen, sats secondary. */
export const satsToUsdText = (sats: number, usdPerBsv: number | undefined): string | undefined => {
  if (!usdPerBsv || !(usdPerBsv > 0)) return undefined;
  const usd = (sats / 1e8) * usdPerBsv;
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
};

/** Sats for a USD amount (rounded down, so an edited cap never exceeds what the user typed). */
export const usdToSats = (usd: number, usdPerBsv: number): number => Math.floor((usd / usdPerBsv) * 1e8);
