/**
 * Envelopes (owner, 24 Oct 2026): the one exception to "one sheet per payment".
 *
 * Many tiny payments (per-second listening, per-view, arcade games) cannot each have a sheet. Instead the user puts
 * a fixed amount into ONE site's envelope. That site may spend from it without a sheet; when it is empty the site
 * has to ask again. The worst case is the envelope's balance: no monthly maths, no rolling windows.
 *
 * The money STAYS IN THE USER'S WALLET. An envelope is an earmark, a labelled number in this store, not a payment
 * to the site and not coins moved anywhere. Each payment the site makes is a normal payment from the wallet, and
 * only then does the balance go down. "Coin return" (Close envelope) deletes the earmark at once; nothing the
 * site does can stop it, because there is nothing to give back: the coins never left.
 *
 * Rules, all enforced here and unit tested (envelopes.test.ts):
 * - One envelope per site, keyed by the browser-derived originator (never anything the page says).
 * - A spend is approved only when the whole amount fits in the balance; the balance can never go negative.
 * - Every change goes through one queue, so two payments racing for the last cents cannot both win.
 * - Another site's payment never reads or touches this envelope.
 */

export const ENVELOPES_KEY_PREFIX = 'bwxEnvelopes:';

/** Presets on every "Put $X in <site>'s envelope" sheet (owner, 24 Oct 2026). */
export const ENVELOPE_PRESETS_USD = [0.25, 1, 5] as const;
export const DEFAULT_ENVELOPE_USD = 1;

/** "$0.25", "$1", "$5": envelope amounts read as whole coins, not "$1.00". */
export const envelopeUsdText = (usd: number): string =>
  usd < 1 ? `$${usd.toFixed(2)}` : Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;

/** No single envelope holds more than this (a typo guard, not a budget): 1 BSV. */
export const MAX_ENVELOPE_SATS = 100_000_000;
/** History kept per envelope (newest last). */
export const HISTORY_LIMIT = 100;

export type EnvelopeEventKind = 'fill' | 'spend' | 'return';
export type EnvelopeEvent = { at: number; kind: EnvelopeEventKind; sats: number };

export interface Envelope {
  originator: string;
  balanceSats: number;
  createdAt: number;
  updatedAt: number;
  /** Lifetime totals, for the Settings screen. */
  filledSats: number;
  spentSats: number;
  history: EnvelopeEvent[];
}

export type EnvelopeState = { envelopes: Record<string, Envelope> };

export const emptyEnvelopeState = (): EnvelopeState => ({ envelopes: {} });

const wholeSats = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;

/** Read whatever is stored, tolerating junk. A record with a bad balance is dropped (it grants nothing). */
export const parseEnvelopeState = (raw: unknown): EnvelopeState => {
  const out = emptyEnvelopeState();
  const envs = (raw as { envelopes?: unknown } | null)?.envelopes;
  if (!envs || typeof envs !== 'object') return out;
  for (const [key, v] of Object.entries(envs as Record<string, unknown>)) {
    const e = v as Partial<Envelope> | null;
    const balance = wholeSats(e?.balanceSats);
    if (!e || typeof e.originator !== 'string' || e.originator !== key || balance === undefined) continue;
    out.envelopes[key] = {
      originator: key,
      balanceSats: Math.min(balance, MAX_ENVELOPE_SATS),
      createdAt: wholeSats(e.createdAt) ?? 0,
      updatedAt: wholeSats(e.updatedAt) ?? 0,
      filledSats: wholeSats(e.filledSats) ?? 0,
      spentSats: wholeSats(e.spentSats) ?? 0,
      history: Array.isArray(e.history)
        ? e.history
            .filter((h) => h && typeof h.at === 'number' && typeof h.sats === 'number' && typeof h.kind === 'string')
            .slice(-HISTORY_LIMIT)
        : [],
    };
  }
  return out;
};

const withEvent = (e: Envelope, ev: EnvelopeEvent): Envelope => ({
  ...e,
  updatedAt: ev.at,
  history: [...e.history, ev].slice(-HISTORY_LIMIT),
});

/** Put sats into a site's envelope (creating it). Returns the new state and the balance actually added. */
export const fillEnvelope = (
  state: EnvelopeState,
  originator: string,
  sats: number,
  now: number,
): { state: EnvelopeState; added: number } => {
  const want = wholeSats(sats) ?? 0;
  if (!originator || want <= 0) return { state, added: 0 };
  const cur = state.envelopes[originator];
  const before = cur?.balanceSats ?? 0;
  const after = Math.min(MAX_ENVELOPE_SATS, before + want);
  const added = after - before;
  if (added <= 0) return { state, added: 0 };
  const base: Envelope = cur ?? {
    originator,
    balanceSats: 0,
    createdAt: now,
    updatedAt: now,
    filledSats: 0,
    spentSats: 0,
    history: [],
  };
  const next = withEvent(
    { ...base, balanceSats: after, filledSats: base.filledSats + added },
    { at: now, kind: 'fill', sats: added },
  );
  return { state: { envelopes: { ...state.envelopes, [originator]: next } }, added };
};

/**
 * Take one payment from a site's envelope. All or nothing: approved only when the whole amount fits. A spend of 0
 * or less, or a non-number, is refused (it never needs an envelope and must not be used to probe one).
 */
export const spendFromEnvelope = (
  state: EnvelopeState,
  originator: string,
  sats: number,
  now: number,
): { state: EnvelopeState; ok: boolean; balanceSats: number } => {
  const cur = originator ? state.envelopes[originator] : undefined;
  const amount = typeof sats === 'number' && Number.isFinite(sats) ? Math.ceil(sats) : NaN;
  if (!cur || !(amount > 0) || amount > cur.balanceSats)
    return { state, ok: false, balanceSats: cur?.balanceSats ?? 0 };
  const next = withEvent(
    { ...cur, balanceSats: cur.balanceSats - amount, spentSats: cur.spentSats + amount },
    { at: now, kind: 'spend', sats: amount },
  );
  return { state: { envelopes: { ...state.envelopes, [originator]: next } }, ok: true, balanceSats: next.balanceSats };
};

/** Coin return: the envelope is closed and its balance released. Returns how much was released. */
export const returnCoins = (state: EnvelopeState, originator: string): { state: EnvelopeState; returned: number } => {
  const cur = state.envelopes[originator];
  if (!cur) return { state, returned: 0 };
  const envelopes = { ...state.envelopes };
  delete envelopes[originator];
  return { state: { envelopes }, returned: cur.balanceSats };
};

/** Where the store keeps its state (chrome.storage.local in the wallet, a Map in tests). */
export type EnvelopeBackend = {
  load(): Promise<unknown>;
  save(state: EnvelopeState): Promise<void>;
};

/**
 * The envelope store. Every read-modify-write runs in one queue, and the stored state is re-read inside the queue,
 * so concurrent payments are applied one after another: two payments cannot both spend the same last balance.
 * Only the background owns a store; pages ask the background (ENVELOPES_* messages) and never write it.
 */
export class EnvelopeStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly backend: EnvelopeBackend,
    private readonly now: () => number = Date.now,
  ) {}

  private run<T>(fn: (s: EnvelopeState) => { state?: EnvelopeState; result: T }): Promise<T> {
    const job = this.queue.then(async () => {
      const state = parseEnvelopeState(await this.backend.load());
      const out = fn(state);
      if (out.state && out.state !== state) await this.backend.save(out.state);
      return out.result;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  get(originator: string): Promise<Envelope | undefined> {
    return this.run((s) => ({ result: s.envelopes[originator] }));
  }

  list(): Promise<Envelope[]> {
    return this.run((s) => ({ result: Object.values(s.envelopes).sort((a, b) => b.updatedAt - a.updatedAt) }));
  }

  /** Fill or top up. Resolves to the new balance. */
  fill(originator: string, sats: number): Promise<number> {
    return this.run((s) => {
      const r = fillEnvelope(s, originator, sats, this.now());
      return { state: r.state, result: r.state.envelopes[originator]?.balanceSats ?? 0 };
    });
  }

  /** Atomically take one payment; false (and nothing changed) when it does not fit. */
  trySpend(originator: string, sats: number): Promise<boolean> {
    return this.run((s) => {
      const r = spendFromEnvelope(s, originator, sats, this.now());
      return { state: r.ok ? r.state : undefined, result: r.ok };
    });
  }

  /** Coin return. Resolves to what was released (0 when there was no envelope). */
  close(originator: string): Promise<number> {
    return this.run((s) => {
      const r = returnCoins(s, originator);
      return { state: r.returned || s.envelopes[originator] ? r.state : undefined, result: r.returned };
    });
  }
}

/** The wallet's store for one account: chrome.storage.local, one key per account (envelopes never cross accounts). */
export const chromeEnvelopeBackend = (accountId: string): EnvelopeBackend => {
  const key = ENVELOPES_KEY_PREFIX + (accountId || 'no-account');
  return {
    load: () => new Promise((resolve) => chrome.storage.local.get(key, (v) => resolve((v ?? {})[key]))),
    save: (state) =>
      new Promise<void>((resolve, reject) =>
        chrome.storage.local.set({ [key]: state }, () => {
          const err = chrome.runtime?.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        }),
      ),
  };
};

/**
 * Coin return for one site in other accounts' envelopes (a device-wide unpair / Revoke all). The live account uses
 * its own store (its queue); this is for the accounts that are not open.
 */
export const closeEnvelopeInAccounts = async (
  accountIds: string[],
  originator: string,
  backendFor: (accountId: string) => EnvelopeBackend = chromeEnvelopeBackend,
): Promise<number> => {
  let released = 0;
  for (const id of new Set(accountIds.filter(Boolean)))
    released += await new EnvelopeStore(backendFor(id)).close(originator);
  return released;
};

/** Sites whose payments are many and tiny (arcade games, per-second streams): their pay sheet offers an envelope. */
export const MICROPAYMENT_SITES: readonly string[] = ['tokenblaster.lol'];

const micropayCalls = new Map<string, number>();

/** Mark a site's in-flight call as micropayments (it named a streaming protocol); call the returned fn when done. */
export const markMicropayments = (originator: string): (() => void) => {
  micropayCalls.set(originator, (micropayCalls.get(originator) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (micropayCalls.get(originator) ?? 1) - 1;
    if (n > 0) micropayCalls.set(originator, n);
    else micropayCalls.delete(originator);
  };
};

/** Should this site's pay sheet offer "Put $X in its envelope"? */
export const isMicropaymentSite = (originator: string): boolean =>
  MICROPAYMENT_SITES.includes(originator) || micropayCalls.has(originator);

type SpendArgs = {
  originator?: string;
  satoshis: number;
  lineItems?: unknown[];
  reason?: string;
  seekPermission?: boolean;
};

type GuardDeps = {
  envelopes: Pick<EnvelopeStore, 'trySpend'>;
  adminOriginator: string;
  normalize: (o: string) => string;
};

/**
 * Install envelopes on the permissions manager instance (replaces guardAllowance while ALLOWANCES_ENABLED is off).
 *
 * The manager calls `this.ensureSpendingAuthorization` for every createAction/signAction spend, with the exact net
 * amount. For a site:
 * - it fits the site's envelope → taken from the balance, approved without a sheet;
 * - anything else → the normal pay sheet (`requestPermissionFlow`), covering this payment only.
 * Stored spending grants (old monthly allowances) are never consulted: the original method, which honours them, is
 * only used for the wallet itself and for spends of 0.
 */
export function guardEnvelopes<T extends object>(manager: T, deps: GuardDeps): T {
  const m = manager as Record<string, unknown>;
  const original = m.ensureSpendingAuthorization;
  const flow = m.requestPermissionFlow;
  if (typeof original !== 'function' || typeof flow !== 'function') {
    throw new Error('guardEnvelopes: permissions manager is missing ensureSpendingAuthorization/requestPermissionFlow');
  }
  m.ensureSpendingAuthorization = async (args: SpendArgs) => {
    if (!args?.originator || args.originator === deps.adminOriginator || !(args.satoshis > 0))
      return (original as (a: SpendArgs) => Promise<boolean>).call(manager, args);
    const originator = deps.normalize(args.originator);
    if (await deps.envelopes.trySpend(originator, args.satoshis)) return true;
    if (args.seekPermission === false)
      throw new Error(`Spending authorization needs your approval for ${args.satoshis} (seekPermission=false).`);
    return (flow as (r: unknown) => Promise<boolean>).call(manager, {
      type: 'spending',
      originator,
      spending: { satoshis: args.satoshis, lineItems: args.lineItems },
      reason: args.reason,
      renewal: false,
    });
  };
  return manager;
}
