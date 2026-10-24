/**
 * One sheet per action (docs/ONE-SHEET-PERMISSIONS.md §3a/§3b).
 *
 * The permissions manager raises one callback per permission (protocol, basket,
 * certificate, spending). Instead of one prompt each, the background feeds them
 * into this bundler: requests from the same site inside a short merge window
 * become one bundle, shown as one sheet. Requests that arrive while that sheet
 * is open join it. The user's answer is a yes/no per request; the background
 * still resolves each one through the manager's own grantPermission /
 * denyPermission, so what is stored and checked does not change.
 *
 * Pure (no chrome APIs, timers injected) so it can be unit tested.
 */

import { isReservedBasket } from './reservedBaskets';

/** The fields of a toolbox PermissionRequest this module reads. */
export interface BundleRequest {
  requestID: string;
  type: 'protocol' | 'basket' | 'certificate' | 'spending';
  originator: string;
  displayOriginator?: string;
  privileged?: boolean;
  protocolID?: [number, string] | (string | number)[];
  counterparty?: string;
  basket?: string;
  certificate?: { verifier: string; certType: string; fields: string[] };
  spending?: { satoshis: number; lineItems?: { type: string; description: string; satoshis: number }[] };
  reason?: string;
  /**
   * Set when the request joined a sheet that was already on screen (b-Aware report, 24 Oct 2026). Such a line is
   * treated as risky: never pre-ticked, shown on the careful card, and answered "denied" unless the user ticks it.
   * A site can no longer slip a request into a sign-in sheet the user is about to Allow.
   */
  lateJoin?: boolean;
}

export type BundleState = 'collecting' | 'shown';

export interface PermissionBundle<R extends BundleRequest = BundleRequest> {
  id: string;
  originator: string;
  state: BundleState;
  items: R[];
  createdAt: number;
}

export interface BundlerOptions<R extends BundleRequest> {
  /** Merge window in ms, counted from the first request of a bundle. */
  windowMs?: number;
  /** The bundle is ready to show (merge window over, or flushed). */
  onReady: (bundle: PermissionBundle<R>) => void;
  /** A request joined a bundle whose sheet is already open. */
  onUpdate?: (bundle: PermissionBundle<R>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  newId?: () => string;
}

export const DEFAULT_MERGE_WINDOW_MS = 400;

let idCounter = 0;
const defaultId = () => `bundle-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export class PermissionBundler<R extends BundleRequest = BundleRequest> {
  private bundles = new Map<string, PermissionBundle<R>>();
  private timers = new Map<string, unknown>();
  private readonly windowMs: number;
  private readonly opts: BundlerOptions<R>;

  constructor(opts: BundlerOptions<R>) {
    this.opts = opts;
    this.windowMs = opts.windowMs ?? DEFAULT_MERGE_WINDOW_MS;
  }

  private setTimer(fn: () => void, ms: number) {
    return (this.opts.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }

  private clearTimer(handle: unknown) {
    (this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }

  /** The open bundle for a site (collecting or shown), if any. */
  private openFor(originator: string): PermissionBundle<R> | undefined {
    for (const b of this.bundles.values()) if (b.originator === originator) return b;
    return undefined;
  }

  /** Add a request. Returns the bundle it joined. */
  add(request: R): PermissionBundle<R> {
    const existing = this.openFor(request.originator);
    if (existing) {
      if (!existing.items.some((i) => i.requestID === request.requestID))
        existing.items.push(existing.state === 'shown' ? { ...request, lateJoin: true } : request);
      if (existing.state === 'shown') this.opts.onUpdate?.(existing);
      return existing;
    }
    const bundle: PermissionBundle<R> = {
      id: (this.opts.newId ?? defaultId)(),
      originator: request.originator,
      state: 'collecting',
      items: [request],
      createdAt: (this.opts.now ?? Date.now)(),
    };
    this.bundles.set(bundle.id, bundle);
    this.timers.set(
      bundle.id,
      this.setTimer(() => this.flush(bundle.id), this.windowMs),
    );
    return bundle;
  }

  /** End the merge window now and show the bundle. No-op if already shown or gone. */
  flush(id: string): PermissionBundle<R> | undefined {
    const bundle = this.bundles.get(id);
    if (!bundle) return undefined;
    const t = this.timers.get(id);
    if (t !== undefined) {
      this.clearTimer(t);
      this.timers.delete(id);
    }
    if (bundle.state === 'collecting') {
      bundle.state = 'shown';
      this.opts.onReady(bundle);
    }
    return bundle;
  }

  get(id: string): PermissionBundle<R> | undefined {
    return this.bundles.get(id);
  }

  /** The bundle holding a request, if any. */
  findByRequest(requestID: string): PermissionBundle<R> | undefined {
    for (const b of this.bundles.values()) if (b.items.some((i) => i.requestID === requestID)) return b;
    return undefined;
  }

  /** Bundles in arrival order. */
  list(): PermissionBundle<R>[] {
    return [...this.bundles.values()];
  }

  /**
   * Apply the user's answer. `decisions` maps requestID → granted. Requests the
   * sheet never showed (they joined after the user's view was built, so they are
   * missing from `decisions`) are not decided here: they move to a new bundle
   * that is shown at once, so nothing is approved unseen.
   */
  resolve(
    id: string,
    decisions: Record<string, boolean>,
  ): { granted: R[]; denied: R[]; carried?: PermissionBundle<R> } | undefined {
    const bundle = this.bundles.get(id);
    if (!bundle) return undefined;
    this.drop(id);
    const granted: R[] = [];
    const denied: R[] = [];
    const unseen: R[] = [];
    for (const item of bundle.items) {
      if (!(item.requestID in decisions)) unseen.push(item);
      else if (decisions[item.requestID] === true) granted.push(item);
      else denied.push(item);
    }
    let carried: PermissionBundle<R> | undefined;
    if (unseen.length > 0) {
      carried = {
        id: (this.opts.newId ?? defaultId)(),
        originator: bundle.originator,
        state: 'collecting',
        items: unseen,
        createdAt: (this.opts.now ?? Date.now)(),
      };
      this.bundles.set(carried.id, carried);
      this.flush(carried.id);
    }
    return { granted, denied, carried };
  }

  /** Remove one request (e.g. it was answered or failed elsewhere). Empty bundles go too. */
  removeRequest(requestID: string): void {
    const bundle = this.findByRequest(requestID);
    if (!bundle) return;
    bundle.items = bundle.items.filter((i) => i.requestID !== requestID);
    if (bundle.items.length === 0) this.drop(bundle.id);
  }

  /** Forget a bundle without deciding (the caller denies its requests). */
  drop(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) this.clearTimer(t);
    this.timers.delete(id);
    this.bundles.delete(id);
  }

  clear(): void {
    for (const id of [...this.bundles.keys()]) this.drop(id);
  }
}

// ─── The sheet model: plain words, ticks and risk ─────────────────────

/** Default allowance per app: $5 a month (owner, 9 Oct 2026). */
export const DEFAULT_ALLOWANCE_USD = 5;
/** Choices offered by [change] on the allowance line. 0 = none (every payment asks). */
export const ALLOWANCE_CHOICES_USD = [0, 1, 5, 20] as const;

const PRIVATE_CERT_FIELDS =
  /e-?mail|phone|mobile|kyc|passport|licen[cs]e|birth|dob|address|ssn|national|tax|id_?number/i;

export interface SheetLine {
  requestID: string;
  /** Plain-English line shown by default. */
  text: string;
  /** Protocol IDs, baskets, counterparties, raw sats: shown under Details. */
  detail: string;
  /** Risky lines are never pre-ticked and are drawn in red. */
  risky: boolean;
  /** Initial tick. */
  checked: boolean;
  /** A real sign-in line (a signature anyone can check, the public identity key, or a sign-in protocol). */
  signIn?: boolean;
  /** For a key used only for your own data (counterparty self): what it keeps private, e.g. "Ask b chats". */
  privateLabel?: string;
}

export interface SheetPayment {
  requestID: string;
  satoshis: number;
  /** What the app says it is for (first line item or reason). */
  description?: string;
  detail: string;
}

export interface SheetModel {
  originator: string;
  lines: SheetLine[];
  payment?: SheetPayment;
  /** Title verb for the header and the main button. */
  mode: 'connect' | 'pay' | 'connectAndPay';
  /** 'post': a site's first post (identity basket and/or post signature, maybe the post's cost) on one sheet. */
  purpose?: 'post';
}

const protoName = (r: BundleRequest) => String(r.protocolID?.[1] ?? 'unknown');
const protoLevel = (r: BundleRequest) => Number(r.protocolID?.[0] ?? 0);

/** True when a request should never be pre-ticked (plan §3c). */
export const isRiskyRequest = (r: BundleRequest): boolean => {
  if (r.privileged) return true;
  if (r.lateJoin) return true;
  // NOT counterparty 'anyone' (owner, 11 Oct 2026): it is how a site gets a signature it can check
  // with only your public identity key, e.g. "Sign in with bWalletX" on bChatX. It proves you hold
  // your key and moves nothing; anything "encrypted for anyone" is readable from your public key
  // anyway. Flagging it red and unticked made sign-in fail with "permission denied".
  if (r.type === 'certificate' && (r.certificate?.fields ?? []).some((f) => PRIVATE_CERT_FIELDS.test(f))) return true;
  return false;
};

/**
 * The wallet's request for the public identity key (BRC-100 getPublicKey with identityKey:true) arrives as the
 * level-1 protocol named "identity key retrieval" with counterparty "self". It reveals only the PUBLIC key, which is
 * what a site needs to recognise you, and gives no signing power. Not privileged (a privileged request is
 * never this).
 */
export const isIdentityKeyRequest = (r: BundleRequest): boolean =>
  r.type === 'protocol' &&
  !r.privileged &&
  r.protocolID?.[1] === 'identity key retrieval' &&
  (r.counterparty === undefined || r.counterparty === 'self');

/** Protocol names that are a sign-in (the site checks who you are), not general key use. */
const SIGN_IN_PROTOCOL = /\b(auth|authentication|sign[- ]?in|login|log[- ]?in)\b/i;

/** True for a line that really is a sign-in: nothing kept, nothing shared, only "this is you". */
export const isSignInRequest = (r: BundleRequest): boolean =>
  r.type === 'protocol' &&
  !r.privileged &&
  (r.counterparty === 'anyone' ||
    isIdentityKeyRequest(r) ||
    (SIGN_IN_PROTOCOL.test(protoName(r)) &&
      (r.counterparty === undefined || r.counterparty === 'self' || r.counterparty === 'anyone')));

/** Self-only keys we can name in plain words (protocol name → what they keep private). */
const PRIVATE_LABELS: [RegExp, string][] = [
  [/agent history/i, 'Ask b chats'],
  [/\b(chat|message)s?\b/i, 'chats'],
  [/\bnotes?\b/i, 'notes'],
  [/\b(history|private|backup|vault|encrypt)/i, 'data'],
];

/** "Keep your … private" label for a key used only on your own data, or undefined. */
export const privateLabelFor = (r: BundleRequest): string | undefined => {
  if (r.type !== 'protocol' || r.privileged || r.counterparty !== 'self' || isSignInRequest(r)) return undefined;
  const name = protoName(r);
  return PRIVATE_LABELS.find(([re]) => re.test(name))?.[1];
};

/**
 * A site's first post asks for several things at once: its identity basket ("bap"), the post signature (protocol
 * "sigma") and the post's cost. These are the companions the wallet asks for together, so the user sees ONE sheet
 * ("Allow <site> to post for you") rather than three in a row.
 */
export const POST_BASKET = 'bap';
export const POST_PROTOCOL: [1, 'sigma'] = [1, 'sigma'];

const isPostSignature = (r: BundleRequest): boolean =>
  r.type === 'protocol' && !r.privileged && protoName(r).toLowerCase() === POST_PROTOCOL[1];
const isPostBasket = (r: BundleRequest): boolean => r.type === 'basket' && r.basket === POST_BASKET;

/** True when a request is one of the first-post set (so its companions are asked for on the same sheet). */
export const isPostPackRequest = (r: BundleRequest): boolean => isPostSignature(r) || isPostBasket(r);

/** The first-post companions still missing from a bundle, given one of its requests. */
export const postPackCompanions = (
  items: Pick<BundleRequest, 'type' | 'basket' | 'protocolID' | 'privileged'>[],
): ('basket' | 'protocol')[] => {
  const all = items as BundleRequest[];
  if (!all.some(isPostPackRequest)) return [];
  const missing: ('basket' | 'protocol')[] = [];
  if (!all.some(isPostBasket)) missing.push('basket');
  if (!all.some(isPostSignature)) missing.push('protocol');
  return missing;
};

const lineText = (r: BundleRequest): string => {
  switch (r.type) {
    case 'protocol': {
      if (isIdentityKeyRequest(r)) return 'See your public identity (the key that names you)';
      if (r.counterparty === 'anyone') return "Prove it's you (a signature anyone can check)";
      if (isPostSignature(r)) return 'Sign your posts and likes as you';
      const kept = privateLabelFor(r);
      if (kept) return `Keep your ${kept} private (encrypted with your keys, only for you)`;
      if (protoLevel(r) === 2 && r.counterparty && r.counterparty !== 'self')
        return `Sign and encrypt with your "${protoName(r)}" keys, shared with one named person or service`;
      // Not "sign in": this lets the app sign anything with keys derived from your wallet (audit C1).
      return `Sign and encrypt anything with your "${protoName(r)}" keys`;
    }
    case 'basket':
      if (isPostBasket(r)) return 'Use your public profile (name and picture) on its posts';
      return 'Keep its tickets and tokens in your wallet';
    case 'certificate': {
      const fields = r.certificate?.fields ?? [];
      return fields.length ? `See your certificate details (${fields.join(', ')})` : 'See your certificates';
    }
    default:
      return 'Spend from your wallet';
  }
};

const lineDetail = (r: BundleRequest): string => {
  const parts: string[] = [];
  switch (r.type) {
    case 'protocol':
      parts.push(`protocol "${protoName(r)}" level ${protoLevel(r)}`);
      if (r.counterparty) parts.push(`counterparty ${r.counterparty}`);
      break;
    case 'basket':
      parts.push(`basket "${r.basket ?? ''}"`);
      break;
    case 'certificate':
      parts.push(`certificate ${r.certificate?.certType ?? ''}`, `verifier ${r.certificate?.verifier ?? ''}`);
      break;
    case 'spending':
      parts.push(`${r.spending?.satoshis ?? 0} sats`);
      break;
  }
  if (r.privileged) parts.push('privileged');
  if (r.reason) parts.push(`reason: ${r.reason}`);
  return parts.join(' · ');
};

/**
 * A sheet may set a monthly allowance only when it is about money: it carries a payment, or it is a site's first
 * post (posts cost a little each, and that sheet says so). A plain sign-in or connect never stores one
 * (b-Aware report 24 Oct 2026: "Sign in" stored a hidden $5/month spending grant).
 */
export const offersAllowance = (model: Pick<SheetModel, 'payment' | 'purpose'>): boolean =>
  !!model.payment || model.purpose === 'post';

/**
 * Whether an answered bundle may store the allowance: the sheet offered one, and the user granted its payment
 * (or, for a first-post sheet without a payment, granted something on it).
 */
export const allowanceGranted = (
  bundle: Pick<PermissionBundle, 'originator' | 'items'>,
  granted: Pick<BundleRequest, 'requestID'>[],
): boolean => {
  const model = buildSheetModel(bundle);
  if (!offersAllowance(model) || granted.length === 0) return false;
  if (model.payment) return granted.some((r) => r.requestID === model.payment!.requestID);
  return true;
};

/** Build the one sheet for a bundle. Spending requests become the "Pay now" section. */
export const buildSheetModel = (bundle: Pick<PermissionBundle, 'originator' | 'items'>): SheetModel => {
  const lines: SheetLine[] = [];
  let payment: SheetPayment | undefined;
  for (const r of bundle.items) {
    if (r.type === 'spending') {
      const sats = r.spending?.satoshis ?? 0;
      // A spend that joined an open sheet is never the sheet's main payment (Allow would answer it).
      if (!payment && !r.lateJoin) {
        payment = {
          requestID: r.requestID,
          satoshis: sats,
          description: r.spending?.lineItems?.find((l) => l.description)?.description ?? r.reason,
          detail: lineDetail(r),
        };
      } else {
        // A second (or late) spend in the same bundle: shown as its own line, never pre-ticked.
        lines.push({
          requestID: r.requestID,
          text: `${r.lateJoin ? 'Added while this was open: pay' : 'Also pay'} ${sats.toLocaleString()} sats`,
          detail: lineDetail(r),
          risky: true,
          checked: false,
        });
      }
      continue;
    }
    const risky = isRiskyRequest(r);
    // Protocol (key use) lines are not pre-ticked: the user ticks them knowingly (audit C1). The one exception is
    // "Prove it's you" (counterparty 'anyone'), which Sign in with bWalletX needs; reserved wallet protocols never
    // reach a sheet at all (services/reservedProtocols.ts).
    // The public identity key is the other exception: Sign in with bWalletX asks for it first, and an unticked line
    // made Allow answer "denied" for it ("Permission denied." on every site since 5.2.35, 20 Oct 2026).
    const checked = !risky && (r.type !== 'protocol' || r.counterparty === 'anyone' || isIdentityKeyRequest(r));
    lines.push({
      requestID: r.requestID,
      text: r.lateJoin ? `Added while this was open: ${lineText(r)}` : lineText(r),
      detail: lineDetail(r),
      risky,
      checked,
      signIn: isSignInRequest(r),
      privateLabel: privateLabelFor(r),
    });
  }
  const mode: SheetModel['mode'] = payment ? (lines.length ? 'connectAndPay' : 'pay') : 'connect';
  const post = bundle.items.some(isPostSignature) || bundle.items.some(isPostBasket);
  return { originator: bundle.originator, lines, payment, mode, ...(post ? { purpose: 'post' as const } : {}) };
};

/**
 * What each line of a sheet answers when the user taps Allow or Not now.
 *
 * The per-line ticks live behind "Details". A line the user never saw unticked cannot have been
 * unticked knowingly, so when Details was never opened, Allow covers every routine line the card
 * asked for. Before this, a sign-in card for one protocol line (Ask b history, a post signature)
 * answered "denied" to the very thing it showed: "Permission denied." and the same card again on
 * every call (chat.bwalletx.com, 23 Oct 2026). Risky lines are shown with their ticks on the
 * careful card, so they always keep their tick state. Details opened: the ticks decide.
 */
export const sheetDecisions = (
  model: Pick<SheetModel, 'lines' | 'payment'>,
  approve: boolean,
  ticks: Record<string, boolean>,
  detailsSeen: boolean,
): Record<string, boolean> => {
  const decisions: Record<string, boolean> = {};
  for (const l of model.lines) {
    const ticked = ticks[l.requestID] ?? (l.checked || (!l.risky && !detailsSeen));
    decisions[l.requestID] = approve && ticked;
  }
  if (model.payment) decisions[model.payment.requestID] = approve;
  return decisions;
};

/** Convert a dollar allowance to satoshis at a USD-per-BSV rate. 0 or no rate → 0. */
export const allowanceSats = (usd: number, usdPerBsv: number | undefined): number => {
  if (!usd || !usdPerBsv || usdPerBsv <= 0 || !Number.isFinite(usdPerBsv)) return 0;
  return Math.floor((usd / usdPerBsv) * 1e8);
};

// ─── "Don't ask again on this site" (owner, 10 Oct 2026: fewer popups, more "allow all") ───

/**
 * A site the user trusts for routine requests is recorded as a grant in the same permission store,
 * under this reserved basket name, so "Forget site" and per-grant revoke in Settings remove it too.
 * Nothing in the wallet uses a basket with this name.
 */
export const TRUST_SITE_BASKET = 'bwalletx.trust-site';

/**
 * Requests a trusted site may get without a sheet: signing and key use for this app only (protocol
 * level 0-1, or level 2 with itself), and its own baskets. Never: payments (they go through the
 * monthly allowance instead), certificates (personal details), privileged keys, signing for anyone,
 * or sharing keys with a named counterparty.
 */
export const isAutoGrantable = (r: BundleRequest): boolean => {
  if (isRiskyRequest(r)) return false;
  // Signatures anyone can check are pre-ticked but still always shown, even on a trusted site.
  if (r.type === 'protocol' && r.counterparty === 'anyone') return false;
  // The wallet's own baskets (coins, ordinals, tokens, locks, names) are never granted without a sheet, and
  // never to an outside site at all (services/reservedBaskets.ts).
  if (r.type === 'basket') return !!r.basket && !isReservedBasket(r.basket);
  // Protocol permissions are never auto-granted (audit C1): "Don't ask again" must not silently hand a site
  // signing keys, at any level. Key derivation ignores the app, so a new protocol may be one the wallet uses.
  return false;
};

/** The sheet offers "Don't ask again" when at least one ticked line is the routine kind. */
export const sheetCanTrust = (bundle: Pick<PermissionBundle, 'items'>): boolean =>
  bundle.items.some((r) => isAutoGrantable(r));

/** The baskets a "Don't ask again" covers: only the routine ones that were on the sheet the user approved. */
export const trustedBasketsFrom = (granted: BundleRequest[]): string[] => [
  ...new Set(granted.filter((r) => r.type === 'basket' && isAutoGrantable(r)).map((r) => r.basket as string)),
];

/**
 * Whether a stored site-trust record covers a later request without a sheet. A basket request is covered only
 * when its basket was one of those shown on the approved sheet; a record without that list (written before
 * 23 Oct 2026) covers no basket. Nothing that isAutoGrantable refuses is ever covered.
 */
export const trustCovers = (
  grant: { expiry: number; baskets?: unknown } | null | undefined,
  r: BundleRequest,
  nowMs: number = Date.now(),
): boolean => {
  if (!grant || !isAutoGrantable(r)) return false;
  if (!(grant.expiry === 0 || grant.expiry * 1000 > nowMs)) return false;
  if (r.type === 'basket') return Array.isArray(grant.baskets) && grant.baskets.includes(r.basket);
  return true;
};
