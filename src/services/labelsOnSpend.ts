/**
 * Labels on the spend sheet (TokenBlaster Assault playtest, 25 Oct 2026). A createAction carrying a label the site
 * had not been granted showed a label sheet first, then the spend sheet: two sheets for one payment. A label is
 * metadata, not spending, so it now shows as a line on that payment's own sheet ("Labels: tokenblaster"), and the
 * payment shows exactly one sheet.
 *
 * Rules:
 *  - Only for a payment that is certain to reach the spend check: the site sends outputs worth something and no
 *    inputs of its own, so the wallet funds it and the net spend is above zero.
 *  - The label is let through for THIS action only; no label grant is stored, so the next payment shows it again.
 *  - If the payment's sheet did not open (an envelope or an earlier grant answered it), the label still asks on its
 *    own sheet before anything is signed. Nothing is ever applied without the user seeing it.
 *  - One action per site at a time; a second concurrent action from the same site keeps the old behaviour.
 */

export type LabelRun = {
  /** Labels waiting to be shown on this action's spend sheet. */
  labels: string[];
  /** The spend sheet opened with them on it. */
  shown: boolean;
};

const runs = new Map<string, LabelRun>();

/** The action running for a site (background.ts reads it when the spend sheet is built). */
export const labelRunFor = (originator: string | undefined): LabelRun | undefined =>
  originator ? runs.get(originator) : undefined;

/** The spend sheet for this site is about to open: put its pending labels on it. Returns the labels shown. */
export const takeLabelsForSheet = (originator: string | undefined): string[] => {
  const run = labelRunFor(originator);
  if (!run || run.labels.length === 0) return [];
  run.shown = true;
  return [...run.labels];
};

type Output = { satoshis?: unknown };
type CreateArgs = { labels?: unknown; outputs?: Output[]; inputs?: unknown[] };

/** Will the manager certainly ask for a spend? Wallet-funded (no site inputs) and paying something. */
export const certainSpend = (args: CreateArgs | undefined): boolean => {
  if (!args || (Array.isArray(args.inputs) && args.inputs.length > 0)) return false;
  const total = (args.outputs ?? []).reduce((s, o) => s + (typeof o?.satoshis === 'number' ? o.satoshis : 0), 0);
  return total > 0;
};

type LabelArgs = { originator?: string; label: string; reason?: string; seekPermission?: boolean; usageType?: string };
type SpendArgs = { originator?: string; satoshis: number };
type Fn<A, R> = (a: A) => Promise<R>;

export type LabelGuardDeps = {
  adminOriginator: string;
  normalize: (o: string) => string;
};

/**
 * Wrap the permissions manager: createAction marks the site's run, ensureLabelAccess defers a label that would ask
 * (onto the spend sheet), and ensureSpendingAuthorization asks for any deferred label the spend sheet did not show.
 */
export function guardLabelsOnSpend<T extends object>(manager: T, deps: LabelGuardDeps): T {
  const m = manager as Record<string, unknown>;
  const create = m.createAction as ((args: CreateArgs, originator?: string) => Promise<unknown>) | undefined;
  const label = m.ensureLabelAccess as Fn<LabelArgs, boolean> | undefined;
  const spend = m.ensureSpendingAuthorization as Fn<SpendArgs, boolean> | undefined;
  const has = m.hasProtocolPermission as Fn<Record<string, unknown>, boolean> | undefined;
  if (typeof create !== 'function' || typeof label !== 'function' || typeof spend !== 'function') return manager;
  const config = (m.config ?? {}) as { seekPermissionWhenApplyingActionLabels?: boolean };

  m.createAction = async (args: CreateArgs, originator?: string) => {
    const site = originator && originator !== deps.adminOriginator ? deps.normalize(originator) : '';
    const mine: LabelRun | undefined =
      site && !runs.has(site) && Array.isArray(args?.labels) && args.labels.length > 0 && certainSpend(args)
        ? { labels: [], shown: false }
        : undefined;
    if (mine) runs.set(site, mine);
    try {
      return await create.call(manager, args, originator);
    } finally {
      if (mine && runs.get(site) === mine) runs.delete(site);
    }
  };

  m.ensureLabelAccess = async (args: LabelArgs) => {
    const site = args?.originator ? deps.normalize(args.originator) : '';
    const run = site ? runs.get(site) : undefined;
    if (
      !run ||
      run.shown ||
      args.usageType !== 'apply' ||
      config.seekPermissionWhenApplyingActionLabels === false ||
      typeof args.label !== 'string' ||
      // Admin-only labels are refused by the manager itself: never deferred past that check.
      args.label.startsWith('admin') ||
      args.label.startsWith('p ')
    )
      return label.call(manager, args);
    // Already granted: nothing to show.
    const granted =
      typeof has === 'function'
        ? await has
            .call(manager, {
              originator: site,
              privileged: false,
              protocolID: [1, `action label ${args.label}`],
              counterparty: 'self',
            })
            .catch(() => false)
        : false;
    if (granted) return label.call(manager, args);
    if (!run.labels.includes(args.label)) run.labels.push(args.label);
    return true;
  };

  m.ensureSpendingAuthorization = async (args: SpendArgs) => {
    const ok = await spend.call(manager, args);
    const site = args?.originator ? deps.normalize(args.originator) : '';
    const run = site ? runs.get(site) : undefined;
    if (run && !run.shown && run.labels.length > 0) {
      // The payment did not reach a sheet: the labels ask on their own, before anything is signed.
      const pending = run.labels.splice(0);
      run.shown = true;
      for (const l of pending) await label.call(manager, { originator: args.originator, label: l, usageType: 'apply' });
    }
    return ok;
  };
  return manager;
}
