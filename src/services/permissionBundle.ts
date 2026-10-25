/**
 * One sheet per action (docs/ONE-SHEET-PERMISSIONS.md §3a/§3b).
 *
 * The permissions manager raises one callback per permission (protocol, basket,
 * certificate, spending). Instead of one prompt each, the background feeds them
 * into this bundler: requests from the same site inside a short merge window
 * become one bundle, shown as one sheet. A request that arrives while that
 * sheet is open never joins it (it must not ride on the user's answer to
 * something else): it waits in a per-site queue and gets its own sheet, judged
 * on its own merits, once the open one is answered or closed. The user's answer is a yes/no per request; the background
 * still resolves each one through the manager's own grantPermission /
 * denyPermission, so what is stored and checked does not change.
 *
 * Pure (no chrome APIs, timers injected) so it can be unit tested.
 */

import { BLOCK_SITE_BASKET, isReservedBasket } from './reservedBaskets';

export { BLOCK_SITE_BASKET };

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
  /** New labels this payment's action applies, shown on its sheet instead of a sheet of their own (labelsOnSpend.ts). */
  labels?: string[];
  reason?: string;
  /**
   * Joined the sheet while it was on screen (live sheet). Shown as "New: …", never pre-ticked, and never covered
   * by a tap made before it appeared: the answer carries a hash of the lines on screen (sheetHash).
   */
  addedLive?: boolean;
  /** The wallet's own "Reconnect to <site>?" line after a disconnect (services/reconnectGate.ts). */
  reconnect?: boolean;
}

/** Most lines that may join one open sheet. More queue for their own sheet. */
export const MAX_LIVE_CHANGES = 3;

/**
 * A short, stable fingerprint of exactly the requests a sheet shows (order-independent). The sheet sends the
 * hash of what was on screen when the user tapped; the background answers only if it still matches.
 */
export const sheetHash = (items: Pick<BundleRequest, 'requestID'>[]): string => {
  const text = items
    .map((i) => i.requestID)
    .sort()
    .join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${items.length}:${h.toString(16)}`;
};

/** Most requests one site may have waiting behind its open sheet. More are refused, so nothing can starve. */
export const MAX_QUEUED_PER_SITE = 10;

/** Thrown by add() when a site already has MAX_QUEUED_PER_SITE requests waiting. */
export class PermissionQueueFullError extends Error {
  constructor(originator: string) {
    super(
      `Too many permission requests from ${originator} are waiting for an answer. Answer the open request in bWalletX, then try again.`,
    );
    this.name = 'PermissionQueueFullError';
  }
}

export type BundleState = 'collecting' | 'shown';

export interface PermissionBundle<R extends BundleRequest = BundleRequest> {
  id: string;
  originator: string;
  state: BundleState;
  items: R[];
  createdAt: number;
  /** The user touched the sheet: nothing more joins it (later requests queue). */
  frozen?: boolean;
  /** Lines that joined while it was on screen. */
  liveChanges?: number;
}

export interface BundlerOptions<R extends BundleRequest> {
  /** Merge window in ms, counted from the first request of a bundle. */
  windowMs?: number;
  /** The bundle is ready to show (merge window over, or flushed). */
  onReady: (bundle: PermissionBundle<R>) => void;
  /** Queued requests became the site's next bundle (its sheet shows after the merge window). */
  onPromote?: (bundle: PermissionBundle<R>) => void;
  /** A line joined a sheet that is on screen: the sheet reloads it. */
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
  /** Per site: requests that arrived while its sheet was open, in arrival order. */
  private queues = new Map<string, R[]>();
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

  /**
   * Add a request. Returns the bundle it joined, or undefined when it was queued behind the site's open sheet.
   * An identical repeat (same requestID) joins whatever already holds it. Throws PermissionQueueFullError when the
   * site's queue is full.
   */
  add(request: R): PermissionBundle<R> | undefined {
    const existing = this.openFor(request.originator);
    if (existing?.items.some((i) => i.requestID === request.requestID)) return existing;
    if (existing && existing.state === 'collecting') {
      existing.items.push(request);
      return existing;
    }
    if (existing && !existing.frozen && (existing.liveChanges ?? 0) < MAX_LIVE_CHANGES) {
      existing.items.push({ ...request, addedLive: true });
      existing.liveChanges = (existing.liveChanges ?? 0) + 1;
      this.opts.onUpdate?.(existing);
      return existing;
    }
    if (existing) {
      const queue = this.queues.get(request.originator) ?? [];
      if (queue.some((i) => i.requestID === request.requestID)) return undefined;
      if (queue.length >= MAX_QUEUED_PER_SITE) throw new PermissionQueueFullError(request.originator);
      queue.push(request);
      this.queues.set(request.originator, queue);
      return undefined;
    }
    return this.open(request.originator, [request]);
  }

  /** Start a new bundle (merge window running). */
  private open(originator: string, items: R[]): PermissionBundle<R> {
    const bundle: PermissionBundle<R> = {
      id: (this.opts.newId ?? defaultId)(),
      originator,
      state: 'collecting',
      items,
      createdAt: (this.opts.now ?? Date.now)(),
    };
    this.bundles.set(bundle.id, bundle);
    this.timers.set(
      bundle.id,
      this.setTimer(() => this.flush(bundle.id), this.windowMs),
    );
    return bundle;
  }

  /** The site's sheet is gone: its queued requests become its next bundle (shown after the merge window). */
  private promote(originator: string): PermissionBundle<R> | undefined {
    if (this.openFor(originator)) return undefined;
    const queue = this.queues.get(originator);
    this.queues.delete(originator);
    if (!queue || queue.length === 0) return undefined;
    const bundle = this.open(originator, queue);
    this.opts.onPromote?.(bundle);
    return bundle;
  }

  /** The user touched the sheet (pointerdown): from now on new requests queue for their own sheet. */
  freeze(id: string): void {
    const b = this.bundles.get(id);
    if (b) b.frozen = true;
  }

  /** Requests waiting behind a site's open sheet, in arrival order. */
  queued(originator: string): R[] {
    return [...(this.queues.get(originator) ?? [])];
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
    seenHash?: string,
  ): { granted: R[]; denied: R[]; carried?: PermissionBundle<R>; stale?: boolean } | undefined {
    const bundle = this.bundles.get(id);
    if (!bundle) return undefined;
    // The tap was for a different set of lines than the sheet now holds: grant nothing.
    if (seenHash !== undefined && seenHash !== sheetHash(bundle.items)) {
      this.forget(id);
      this.promote(bundle.originator);
      return { granted: [], denied: [...bundle.items], stale: true };
    }
    this.forget(id);
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
        // On its own sheet a line that joined live is an ordinary line again (no "New:", judged on its own).
        items: unseen.map((i) => {
          if (!i.addedLive) return i;
          const rest = { ...i };
          delete rest.addedLive;
          return rest;
        }),
        createdAt: (this.opts.now ?? Date.now)(),
      };
      this.bundles.set(carried.id, carried);
      this.flush(carried.id);
    } else {
      this.promote(bundle.originator);
    }
    return { granted, denied, carried };
  }

  /** Remove one request (e.g. it was answered or failed elsewhere). Empty bundles go too. */
  removeRequest(requestID: string): void {
    for (const [site, queue] of this.queues) {
      const rest = queue.filter((i) => i.requestID !== requestID);
      if (rest.length === queue.length) continue;
      if (rest.length) this.queues.set(site, rest);
      else this.queues.delete(site);
      return;
    }
    const bundle = this.findByRequest(requestID);
    if (!bundle) return;
    bundle.items = bundle.items.filter((i) => i.requestID !== requestID);
    if (bundle.items.length === 0) this.drop(bundle.id);
  }

  /** Forget a bundle without deciding (the caller denies its requests). The site's queue, if any, comes next. */
  drop(id: string): void {
    const bundle = this.bundles.get(id);
    this.forget(id);
    if (bundle) this.promote(bundle.originator);
  }

  private forget(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) this.clearTimer(t);
    this.timers.delete(id);
    this.bundles.delete(id);
  }

  /** Forget everything, queues included (the caller denies every pending request). */
  clear(): void {
    this.queues.clear();
    for (const id of [...this.bundles.keys()]) this.forget(id);
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
  /** Joined while the sheet was open: shown as "New: …" with its own tick, never covered by Allow alone. */
  isNew?: boolean;
  /** For a key used only for your own data (counterparty self): what it keeps private, e.g. "Ask b chats". */
  privateLabel?: string;
}

export interface SheetPayment {
  requestID: string;
  satoshis: number;
  /** What the app says it is for (first line item or reason). */
  description?: string;
  detail: string;
  /** New labels the action applies; approving the payment applies them to this action only. */
  labels?: string[];
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
      if (r.labels?.length) parts.push(`labels: ${r.labels.join(', ')}`);
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
      if (!payment && !r.addedLive) {
        payment = {
          requestID: r.requestID,
          satoshis: sats,
          description: r.spending?.lineItems?.find((l) => l.description)?.description ?? r.reason,
          detail: lineDetail(r),
          ...(r.labels?.length ? { labels: [...r.labels] } : {}),
        };
      } else {
        // A second (or live-added) spend: shown as its own line, never pre-ticked.
        lines.push({
          requestID: r.requestID,
          text: `${r.addedLive ? 'New: pay' : 'Also pay'} ${sats.toLocaleString()} sats`,
          detail: lineDetail(r),
          risky: true,
          checked: false,
          ...(r.addedLive ? { isNew: true } : {}),
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
    const checked =
      !risky && !r.addedLive && (r.type !== 'protocol' || r.counterparty === 'anyone' || isIdentityKeyRequest(r));
    lines.push({
      requestID: r.requestID,
      text: r.addedLive ? `New: ${lineText(r)}` : lineText(r),
      ...(r.addedLive ? { isNew: true } : {}),
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
/**
 * What the face of a sheet shows (owner rule: never approve something the user can't read).
 * - faceTicks: lines drawn on the face with their own tick box. The box decides, as drawn.
 * - hidden: lines not on the face at all (only behind Details). Until Details is opened they are never granted:
 *   they are left out of the answer, so the background never grants them (#85 carries them to a sheet of their own;
 *   the live sheet's hash, built from the shown lines only, no longer matches, so nothing is granted).
 */
export interface SheetView {
  faceTicks?: ReadonlySet<string>;
  hidden?: ReadonlySet<string>;
}

/**
 * The face of a sheet. The careful card draws every line with its tick: the risky ones large, the ordinary ones
 * compact below (a mixed batch once hid an ordinary line under Details and "I trust it, allow" granted it unseen).
 * Other cards summarise their routine lines on the face (tiles, chips), so nothing is hidden there either.
 */
export const sheetView = (
  model: Pick<SheetModel, 'lines'>,
  careful: boolean,
  /** Lines whose row has been fully on screen. Given, every other line counts as hidden until it scrolls in. */
  seen?: ReadonlySet<string>,
): Required<SheetView> => ({
  // Lines that joined live are drawn up front with their own tick on every card ("New: …").
  faceTicks: new Set(model.lines.filter((l) => careful || l.isNew).map((l) => l.requestID)),
  hidden: new Set(seen ? model.lines.filter((l) => !seen.has(l.requestID)).map((l) => l.requestID) : []),
});

/** The requests the user can read on the sheet: what the answer and its hash may cover. */
export const shownItems = <T extends Pick<BundleRequest, 'requestID'>>(items: T[], view?: SheetView): T[] =>
  view?.hidden?.size ? items.filter((i) => !view.hidden!.has(i.requestID)) : items;

export const sheetDecisions = (
  model: Pick<SheetModel, 'lines' | 'payment'>,
  approve: boolean,
  ticks: Record<string, boolean>,
  detailsSeen: boolean,
  view: SheetView = {},
): Record<string, boolean> => {
  const decisions: Record<string, boolean> = {};
  for (const l of model.lines) {
    // Never on screen: not answered, so never granted.
    if (!detailsSeen && view.hidden?.has(l.requestID)) continue;
    // A tick box on the face (or in opened Details) decides as drawn; a new line counts only when the user ticked it.
    const drawn = detailsSeen || !!view.faceTicks?.has(l.requestID);
    // A line that joined live and was left as it arrived (unticked) is not part of what Allow approves, but Allow
    // must never deny a line the user saw (paid playtest, 25 Oct 2026: "I trust it, allow" denied a joined line).
    // It is left out of the answer, so resolve() carries it to a sheet of its own. Not now still declines it.
    if (approve && l.isNew && ticks[l.requestID] === undefined) continue;
    const ticked = ticks[l.requestID] ?? (l.isNew ? false : l.checked || (!l.risky && !drawn));
    decisions[l.requestID] = approve && ticked;
  }
  if (model.payment) decisions[model.payment.requestID] = approve;
  return decisions;
};

/**
 * The three answers a sheet offers (owner, 24 Oct 2026). The careful card shows all three; the others show the
 * first two.
 * - allow: the ticked lines and the main payment (sheetDecisions).
 * - notNow: this sheet only is declined. Nothing is stored, nothing is blocked; the site stays connected and may
 *   ask again. The site gets the normal "user declined" error.
 * - block: everything on the sheet is declined AND the site is blocked: its grants are revoked and a block record
 *   is stored, so every later request is refused without a sheet until the user revokes all its access in Settings (which removes the record).
 */
export type SheetChoice = 'allow' | 'notNow' | 'block';

export interface SheetAnswer {
  decisions: Record<string, boolean>;
  /** Store the block record and revoke the site's grants. */
  block: boolean;
  /** Allowance and "don't ask again" may be stored only on allow. */
  mayStore: boolean;
}

export const sheetAnswer = (
  model: Pick<SheetModel, 'lines' | 'payment'>,
  choice: SheetChoice,
  ticks: Record<string, boolean>,
  detailsSeen: boolean,
  view: SheetView = {},
): SheetAnswer => ({
  decisions: sheetDecisions(model, choice === 'allow', ticks, detailsSeen, view),
  block: choice === 'block',
  mayStore: choice === 'allow',
});

/** Whether a stored block record still blocks (expiry 0 = until removed). */
export const blockActive = (grant: { expiry: number } | null | undefined, nowMs: number = Date.now()): boolean =>
  !!grant && (grant.expiry === 0 || grant.expiry * 1000 > nowMs);

export const BLOCKED_SITE_REFUSAL =
  'You blocked this site in bWalletX. To unblock it, open Permissions in bWalletX settings and choose Revoke all for this site.';

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
