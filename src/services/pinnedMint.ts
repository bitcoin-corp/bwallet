/**
 * One button, one approval, for a paid action on a pinned protocol (owner, 24 Oct 2026: bvideox.com mint).
 *
 * A bvideox.com mint used to raise a sheet per permission, one after another, because each call blocks on its own
 * answer: encrypt (protocol [2,'bvideox records']) -> createAction's label ('action label bvideox records') ->
 * createAction's spend. The bundler (permissionBundle.ts) can only merge requests that are pending at the same time,
 * and these never are. Here the first two are let through for THIS call only, and the one sheet the user sees is
 * the spend sheet, which also asks for the protocol and the label (so "Open my records" later needs no sheet):
 *
 *   "Mint 3 videos, locked to you on bvideox.com" · costs <premium> + <fee> network fee · [Mint] [Not now]
 *
 * Why letting the first two through is safe, and how narrowly:
 *  - encrypt only (never decrypt, sign, HMAC or key reveal), counterparty 'self', never privileged, on a protocol
 *    that is pinned to its home site (pinnedProtocols.ts: every other site is refused before any sheet), called by
 *    that home site, and only while no other call on the same site+protocol is in flight (so the request the manager
 *    raises is known to be the encrypt). Encrypting to yourself discloses nothing: the site already holds the
 *    plaintext, and the ciphertext opens only with a decrypt, which still needs the real grant.
 *  - the grant is ephemeral (one call, nothing stored), and at most MAX_DEFERRED_ENCRYPTS per site per window.
 *  - the label is let through only while that site's own createAction carrying that label and naming that pinned
 *    protocol is running. A label only tags the action in your history; if the spend is refused the action is
 *    aborted, so nothing is written and nothing is paid.
 *  - the spend itself is never let through: it is the sheet. No allowance, no "don't ask again" on it (the
 *    background ignores both for a mint sheet), and the amount is shown before Allow.
 *
 * Pure (no chrome APIs) so it can be unit tested.
 */

import { pinnedProtocol } from './pinnedProtocols';

/** How long encrypts for one site may be let through before the rate cap below resets. */
export const DEFER_WINDOW_MS = 10 * 60_000;
/** Most encrypts let through per site+protocol per window (a mint encrypts one record per video, 25 per batch). */
export const MAX_DEFERRED_ENCRYPTS = 100;

type Pid = readonly [number, string];

const asPid = (p: unknown): Pid | null =>
  Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'string' ? [p[0], p[1]] : null;
const keyOf = (origin: string, pid: Pid) => `${origin}|${pid[0]}:${pid[1].trim().toLowerCase()}`;

/** Methods whose permission request is a protocol request (the toolbox raises one per call). */
const PROTOCOL_CALLS = new Set([
  'encrypt',
  'decrypt',
  'createSignature',
  'verifySignature',
  'createHmac',
  'verifyHmac',
  'getPublicKey',
  'revealSpecificKeyLinkage',
]);

/** In-flight protocol calls per site+protocol, split into encrypt and everything else. */
export class ProtocolCalls {
  private calls = new Map<string, { encrypt: number; other: number }>();

  /** Note a call starting; returns the function that ends it. `origin` must be normalised and browser-derived. */
  start(method: string, origin: string | undefined, args: unknown): () => void {
    const pid = asPid((args as { protocolID?: unknown } | null)?.protocolID);
    if (!origin || !pid || !PROTOCOL_CALLS.has(method)) return () => undefined;
    const k = keyOf(origin, pid);
    const c = this.calls.get(k) ?? { encrypt: 0, other: 0 };
    const counterpartySelf = ((args as { counterparty?: unknown }).counterparty ?? 'self') === 'self';
    const isEncrypt = method === 'encrypt' && counterpartySelf;
    if (isEncrypt) c.encrypt++;
    else c.other++;
    this.calls.set(k, c);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const cur = this.calls.get(k);
      if (!cur) return;
      if (isEncrypt) cur.encrypt--;
      else cur.other--;
      if (cur.encrypt <= 0 && cur.other <= 0) this.calls.delete(k);
    };
  }

  /** True when only self-encrypts are running for this site+protocol (so a protocol request is one of them). */
  onlyEncrypt(origin: string, pid: Pid): boolean {
    const c = this.calls.get(keyOf(origin, pid));
    return !!c && c.encrypt > 0 && c.other === 0;
  }
}

/** Rate cap for let-through encrypts, per site+protocol. */
export class DeferredEncrypts {
  private seen = new Map<string, number[]>();

  private recent(k: string, now: number): number[] {
    const list = (this.seen.get(k) ?? []).filter((t) => now - t < DEFER_WINDOW_MS);
    this.seen.set(k, list);
    return list;
  }

  canDefer(origin: string, pid: Pid, now: number): boolean {
    return this.recent(keyOf(origin, pid), now).length < MAX_DEFERRED_ENCRYPTS;
  }

  note(origin: string, pid: Pid, now: number): void {
    const k = keyOf(origin, pid);
    this.recent(k, now).push(now);
  }
}

/** The fields of a toolbox PermissionRequest read here. */
export type MintPermissionRequest = {
  type: string;
  originator?: string;
  privileged?: boolean;
  protocolID?: unknown;
  counterparty?: string;
};

/**
 * Let this protocol request through for one call, without a sheet? Only a self-encrypt by a pinned protocol's home
 * site on a protocol that has a mint action, with nothing else in flight on it, inside the rate cap.
 * `req.originator` must already be normalised.
 */
export const shouldDeferEncrypt = (
  req: MintPermissionRequest,
  calls: ProtocolCalls,
  deferred: DeferredEncrypts,
  now: number,
): boolean => {
  if (req.type !== 'protocol' || req.privileged || !req.originator) return false;
  if ((req.counterparty ?? 'self') !== 'self') return false;
  const pid = asPid(req.protocolID);
  const pin = pid ? pinnedProtocol(pid) : undefined;
  if (!pid || !pin?.mint || pid[0] !== 2) return false;
  if (!pin.origins.includes(req.originator)) return false;
  if (!calls.onlyEncrypt(req.originator, pid)) return false;
  return deferred.canDefer(req.originator, pid, now);
};

export type MintIntent = {
  origin: string;
  protocolID: Pid;
  /** The labels this createAction applies (only these may be let through). */
  labels: string[];
  description: string;
  verb: string;
  noun: string;
  /** Items named by the description, or the outputs paying nothing (the records) when it names none. */
  count: number;
  /** Sats the outputs pay (the premium), before the network fee. */
  outputSats: number;
};

type CreateParams = {
  description?: string;
  labels?: string[];
  outputs?: { satoshis?: number }[];
  options?: object;
};

/**
 * The mint a createAction is, or null. Needs: a site the createAction's options.spendingAuthorization.protocolID is
 * pinned to, and a protocol with a mint action. `origin` must be normalised and browser-derived. Read BEFORE
 * options.spendingAuthorization is stripped.
 */
export const mintIntentFor = (origin: string | undefined, params: CreateParams): MintIntent | null => {
  if (!origin || !params) return null;
  const pid = asPid(
    ((params.options as { spendingAuthorization?: { protocolID?: unknown } } | undefined)?.spendingAuthorization ?? {})
      .protocolID,
  );
  const pin = pid ? pinnedProtocol(pid) : undefined;
  if (!pid || pid[0] !== 2 || !pin?.mint || !pin.origins.includes(origin)) return null;
  const description = String(params.description ?? '');
  const outputs = params.outputs ?? [];
  const fromText = Number(pin.mint.countFrom.exec(description)?.[1]);
  const count =
    Number.isInteger(fromText) && fromText > 0 ? fromText : outputs.filter((o) => (o?.satoshis ?? 0) === 0).length;
  const outputSats = outputs.reduce((n, o) => n + (Number.isFinite(o?.satoshis) ? Number(o.satoshis) : 0), 0);
  return {
    origin,
    protocolID: pid,
    labels: (params.labels ?? []).filter((l) => typeof l === 'string'),
    description,
    verb: pin.mint.verb,
    noun: pin.mint.noun,
    count,
    outputSats,
  };
};

/** Let a label request through while its mint's createAction runs? Only that site, only that action's labels. */
export const labelCoveredByIntent = (req: MintPermissionRequest, intent: MintIntent | undefined): boolean => {
  if (!intent || req.type !== 'protocol' || req.privileged || req.originator !== intent.origin) return false;
  if ((req.counterparty ?? 'self') !== 'self') return false;
  const pid = asPid(req.protocolID);
  return !!pid && pid[0] === 1 && intent.labels.some((l) => pid[1] === `action label ${l}`);
};

export type MintSheet = {
  /** "Mint 3 videos, locked to you on bvideox.com" */
  title: string;
  site: string;
  count: number;
  /** What the outputs pay (the premium). */
  premiumSats: number;
  /** The rest of the spend: the network fee. */
  feeSats: number;
  totalSats: number;
};

/** The words of the one sheet. `spendSats` is the spending request's amount (premium + fee). */
export const mintSheetFor = (intent: MintIntent, spendSats: number): MintSheet => {
  const n = intent.count;
  const title = `${intent.verb} ${n > 0 ? `${n} ` : ''}${intent.noun}${n === 1 ? '' : 's'}, locked to you on ${intent.origin}`;
  const total = Math.max(0, Math.floor(spendSats || 0));
  const premium = Math.min(total, Math.max(0, intent.outputSats));
  return { title, site: intent.origin, count: n, premiumSats: premium, feeSats: total - premium, totalSats: total };
};
