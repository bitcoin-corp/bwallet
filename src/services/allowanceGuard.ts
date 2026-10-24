/**
 * Limits on a site's monthly allowance (payment-safety audit 24 Oct 2026, B2).
 *
 * The permissions manager approves a payment without asking whenever the month's spend plus this payment fits
 * the site's allowance, so one payment could take the whole month at once, to any address. Two limits on top:
 *
 * - Per-payment cap. A single payment above the cap asks the user (it is not refused). The cap is the grant's
 *   own `perPaymentSats` when set, else DEFAULT_PER_PAYMENT_FRACTION of the monthly amount.
 * - Optional payee allowlist. A grant carrying `payees` (output locking scripts, hex) covers only payments whose
 *   every paid output goes to one of them; anything else asks. A grant without `payees` behaves as before.
 *
 * Both only ever turn "approve silently" into "ask"; nothing that used to ask is approved by this module.
 */

export const DEFAULT_PER_PAYMENT_FRACTION = 0.25;
export const MAX_PAYEES = 50;

export type AllowanceGrant = {
  expiry: number;
  authorizedAmount?: number;
  perPaymentSats?: number;
  payees?: string[];
};

const live = (g: { expiry: number }, nowMs: number) => !g.expiry || g.expiry * 1000 > nowMs;

/** The most one payment may take from this allowance without asking. */
export const perPaymentCapSats = (g: AllowanceGrant): number => {
  if (typeof g.perPaymentSats === 'number' && Number.isFinite(g.perPaymentSats) && g.perPaymentSats >= 0)
    return Math.floor(g.perPaymentSats);
  return Math.floor((g.authorizedAmount ?? 0) * DEFAULT_PER_PAYMENT_FRACTION);
};

const HEX = /^(?:[0-9a-f]{2}){1,10000}$/;

/** Clean a payee list (lower-case hex locking scripts, de-duplicated); undefined when nothing valid remains. */
export const parsePayees = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out = new Set<string>();
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    const h = p.trim().toLowerCase();
    if (HEX.test(h)) out.add(h);
    if (out.size >= MAX_PAYEES) break;
  }
  return out.size ? [...out] : undefined;
};

/** True when there is no allowlist, or every output that carries money pays a listed locking script. */
export const payeesAllowed = (
  payees: readonly string[] | undefined,
  outputs: readonly { satoshis?: number; lockingScript?: string }[] | undefined,
): boolean => {
  if (!payees || payees.length === 0) return true;
  const allowed = new Set(payees.map((p) => p.toLowerCase()));
  return (outputs ?? []).every(
    (o) =>
      !(typeof o.satoshis === 'number' && o.satoshis > 0) || allowed.has(String(o.lockingScript ?? '').toLowerCase()),
  );
};

/** Must this payment ask, even though the allowance's monthly budget would cover it? */
export const allowanceMustAsk = (
  grant: AllowanceGrant | null | undefined,
  satoshis: number,
  nowMs = Date.now(),
): boolean => !!grant && live(grant, nowMs) && grant.authorizedAmount != null && satoshis > perPaymentCapSats(grant);

/** Sites with a createAction in flight that pays outside their allowance's payees (count per site). */
const mismatched = new Map<string, number>();

/** Mark a site's in-flight createAction as paying outside its payee list; call the returned function when it ends. */
export const markPayeeMismatch = (normalizedOriginator: string): (() => void) => {
  mismatched.set(normalizedOriginator, (mismatched.get(normalizedOriginator) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (mismatched.get(normalizedOriginator) ?? 1) - 1;
    if (n > 0) mismatched.set(normalizedOriginator, n);
    else mismatched.delete(normalizedOriginator);
  };
};

export const hasPayeeMismatch = (normalizedOriginator: string): boolean => mismatched.has(normalizedOriginator);

type SpendArgs = {
  originator?: string;
  satoshis: number;
  lineItems?: unknown[];
  reason?: string;
  seekPermission?: boolean;
};

type GuardDeps = {
  store: { findGrant(key: { type: 'spending'; originator: string }): Promise<unknown> };
  adminOriginator: string;
  normalize: (o: string) => string;
  /** Sites whose current createAction pays outside their allowance's payee list (set by the createAction handler). */
  payeeMismatch?: (normalizedOriginator: string) => boolean;
};

/**
 * Install the limits on the permissions manager instance. The upstream manager calls
 * `this.ensureSpendingAuthorization` for every createAction/signAction spend, so an instance override sees all
 * of them. A payment the limits catch goes to the manager's own prompt flow (`requestPermissionFlow`), the same
 * sheet an uncovered payment gets, and that approval covers only this payment.
 */
export function guardAllowance<T extends object>(manager: T, deps: GuardDeps): T {
  const m = manager as Record<string, unknown>;
  const original = m.ensureSpendingAuthorization;
  const flow = m.requestPermissionFlow;
  if (typeof original !== 'function' || typeof flow !== 'function') {
    throw new Error('guardAllowance: permissions manager is missing ensureSpendingAuthorization/requestPermissionFlow');
  }
  m.ensureSpendingAuthorization = async (args: SpendArgs) => {
    if (args?.originator && args.originator !== deps.adminOriginator) {
      const originator = deps.normalize(args.originator);
      const grant = (await deps.store.findGrant({ type: 'spending', originator })) as AllowanceGrant | null;
      const ask =
        allowanceMustAsk(grant, args.satoshis) ||
        (!!grant && grant.authorizedAmount != null && (deps.payeeMismatch ?? hasPayeeMismatch)(originator));
      if (ask) {
        if (args.seekPermission === false)
          throw new Error(`Spending authorization needs your approval for ${args.satoshis} (seekPermission=false).`);
        return (flow as (r: unknown) => Promise<boolean>).call(manager, {
          type: 'spending',
          originator,
          spending: { satoshis: args.satoshis, lineItems: args.lineItems },
          reason: args.reason,
          renewal: false,
        });
      }
    }
    return (original as (a: SpendArgs) => Promise<boolean>).call(manager, args);
  };
  return manager;
}
