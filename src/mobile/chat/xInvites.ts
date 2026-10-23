/**
 * Room X invites, option B (owner, 15 Oct 2026): pre-funded one-time keys.
 *
 * Host: for N @handles the wallet makes N fresh random keys ON THIS DEVICE and funds each one-time
 * address with the room's gate amount (1 SCAM for SCAMMERSCARTEL) plus a few sats, all in ONE
 * transaction from the host's own tokens. bit-sign is told only `x_handle` + `funded_address`; the
 * key travels only in the link's fragment (`…/i/x/<code>#k=<WIF>&t=<funding txid>`), which a browser
 * never sends to a server. The links stay on this device, encrypted with the wallet's own key
 * (wallet.encrypt, counterparty self) inside the device's secure storage.
 *
 * Invitee: opens the link → verify (bit-sign checks the linked X matches) → sweep the sats, then the
 * token, from the fragment key into their own wallet → report "swept".
 *
 * Revoke: the host's wallet sweeps the open one-time outputs back with the stored keys, then tells
 * bit-sign. Pure helpers are tested in xInvites.test.ts; never log a key or a link.
 */
import { P2PKH, PrivateKey, PublicKey, Script, Transaction, Utils } from '@bsv/sdk';
import { BSV21 } from '@1sat/templates';
import {
  BSV21_BASKET,
  P1SAT_PROTOCOL,
  bsv21FieldsFromOutput,
  bsv21FilterTags,
  buildBsv21CustomInstructions,
  executeTrackedAction,
  prepareP1SatArgs,
  sweepBsv,
  sweepBsv21,
  type OneSatContext,
} from '@1sat/actions';
import { buildInputAssetLabel, buildTokenLabel, readAssetIdTag } from '@1sat/types';
import { YoursNative } from '../native';
import { withTokenKeyCheck } from '../../services/tokenSpendGuard';

/** The first room (owner, 15 Oct 2026). */
export const SCAMMERSCARTEL_GATE = 'bsv21:8353949b27e8e16025702ce2b5d9b1ac2dad56d725eb2a38761974a857d98804_0';

export const INVITE_URL_BASE = 'https://www.bchatx.com/i/x/';
export const MAX_INVITES_PER_BATCH = 50;

// ── keys ──

/** A fresh random one-time key (the SDK draws from the platform CSPRNG). */
export const newInviteKey = (): PrivateKey => PrivateKey.fromRandom();

export const addressOf = (k: PrivateKey) => k.toPublicKey().toAddress().toString();

// ── handles ──

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** "@a, b\n@c x.com/d" → ['a','b','c','d'] (X rules: 1–15 letters, digits, _; lower-cased, unique). */
export function parseHandles(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text || '').split(/[\s,;]+/)) {
    const h = raw
      .trim()
      .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
      .replace(/^(x|twitter)\.com\//i, '')
      .replace(/^@/, '')
      .replace(/[/?#].*$/, '');
    if (HANDLE.test(h) && !out.includes(h.toLowerCase())) out.push(h.toLowerCase());
  }
  return out;
}

// ── links ──

/** The share link: the server's url_base, then the key (and the funding txid) in the fragment only. */
export function inviteLink(urlBase: string, wif: string, fundingTxid: string): string {
  const base = urlBase.split('#')[0];
  return `${base}#k=${encodeURIComponent(wif)}&t=${encodeURIComponent(fundingTxid)}`;
}

export interface XInviteLink {
  code: string;
  wif: string;
  /** Funding txid (lets the invitee find the outputs without an indexer). */
  txid: string | null;
}

const CODE = /^[A-Za-z0-9_-]{4,64}$/;
const TXID = /^[0-9a-f]{64}$/i;
const LINK_HOSTS = new Set([
  'bchatx.com',
  'www.bchatx.com',
  'chat.bwalletx.com',
  'bit-sign.online',
  'www.bit-sign.online',
]);

/** `https://www.bchatx.com/i/x/<code>#k=<WIF>&t=<txid>` or `bwalletx://xinvite/<code>#k=…`; null if not one. */
export function parseXInviteLink(url: string | null | undefined): XInviteLink | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    let code = '';
    if (u.protocol === 'https:' && LINK_HOSTS.has(u.host)) {
      const m = u.pathname.match(/^\/i\/x\/([^/]+)\/?$/);
      code = m ? decodeURIComponent(m[1]) : '';
    } else if (u.protocol === 'bwalletx:' && u.host === 'xinvite') {
      code = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ''));
    } else return null;
    if (!CODE.test(code)) return null;
    const frag = new URLSearchParams(u.hash.replace(/^#/, ''));
    const wif = frag.get('k') || '';
    const txid = frag.get('t') || '';
    try {
      PrivateKey.fromWif(wif);
    } catch {
      return null;
    }
    return { code, wif, txid: TXID.test(txid) ? txid.toLowerCase() : null };
  } catch {
    return null;
  }
}

/**
 * The bchatx.com web page for an invite link, fragment (key) intact: what a build without X invites
 * (Play / App Store) opens in the system browser instead of swallowing the link.
 */
export function xInviteWebUrl(url: string): string | null {
  const x = parseXInviteLink(url);
  if (!x) return null;
  const u = new URL(url.trim());
  if (u.protocol === 'https:') return url.trim();
  return `${INVITE_URL_BASE}${encodeURIComponent(x.code)}${u.hash}`;
}

/** Hand an invite link to the system browser (Capacitor opens `_system` outside the app). */
export function openXInviteInBrowser(
  url: string,
  open: (u: string, target: string) => unknown = (u, t) => window.open(u, t),
): boolean {
  const web = xInviteWebUrl(url);
  if (!web) return false;
  open(web, '_system');
  return true;
}

// ── how many sats per invite ──

/**
 * Sats sent with each invite, enough for the invitee to sweep with an empty wallet: the BSV sweep
 * (1 in / 1 out) and the token sweep (token + funding in; token, overlay fee and change out) at the
 * wallet's fee rate are well under 200 sats together, plus the token's overlay fee for the one token
 * output the sweep makes. A floor of 1,000 sats leaves room for a higher fee rate.
 */
export const SWEEP_MARGIN_SATS = 500;
export const MIN_INVITE_SATS = 1000;
export const inviteSats = (overlayFeePerOutput: number | null | undefined) =>
  Math.max(MIN_INVITE_SATS, Math.ceil(Math.max(0, Number(overlayFeePerOutput) || 0)) + SWEEP_MARGIN_SATS);

// ── the funding transaction ──

/**
 * Per invite: at least the room's gate minimum (minAmountRaw; 10^10 raw = 1 SCAM), and never less
 * than one whole token, so the invitee always clears the gate.
 */
export const inviteAmountRaw = (gate: { minRaw: string; dec: number }): bigint => {
  const min = /^\d+$/.test(gate.minRaw || '') ? BigInt(gate.minRaw) : BigInt(0);
  const whole = BigInt(10) ** BigInt(gate.dec || 0);
  return min > whole ? min : whole;
};

export interface PlannedOutput {
  lockingScript: string;
  satoshis: number;
  outputDescription: string;
}

/**
 * Per invite, in order: the token output (1 sat, `amountRaw` of the gate token to the one-time
 * address), then its sats output. Token change and fees are added by the builder after these.
 */
export function inviteOutputs(
  tokenId: string,
  amountRaw: bigint,
  addresses: string[],
  satsEach: number,
): PlannedOutput[] {
  if (amountRaw <= BigInt(0)) throw new Error('Invite amount must be positive');
  if (!Number.isInteger(satsEach) || satsEach < 1) throw new Error('Invite sats must be a positive integer');
  const out: PlannedOutput[] = [];
  for (const a of addresses) {
    const lock = new P2PKH().lock(a);
    out.push({
      lockingScript: BSV21.transfer(tokenId, amountRaw).lock(lock).toHex(),
      satoshis: 1,
      outputDescription: 'Room invite token',
    });
    out.push({ lockingScript: lock.toHex(), satoshis: satsEach, outputDescription: 'Room invite sats' });
  }
  return out;
}

type ListedOutput = { outpoint: string; tags?: string[]; customInstructions?: string };
const normId = (id: string) => id.trim().toLowerCase().replace('.', '_');

export interface FundedInvites {
  txid: string;
  /** AtomicBEEF hex, for bit-sign to check the outputs. */
  beef: string;
}

/**
 * Build, sign and broadcast the ONE funding transaction through the wallet (the wallet's approval
 * applies, as for any token send), then submit it to the token overlay. Tokens are only spent once
 * the overlay says they are valid, as sendBsv21 does.
 */
export async function fundInvites(
  ctx: OneSatContext,
  m: { tokenId: string; amountRaw: bigint; addresses: string[]; satsEach: number; ticker: string },
): Promise<FundedInvites> {
  // F-3: token inputs whose records can't be signed are fixed before, and once after, an empty unlock.
  return withTokenKeyCheck(ctx, m.tokenId, () => fundInvitesOnce(ctx, m));
}

async function fundInvitesOnce(
  ctx: OneSatContext,
  m: { tokenId: string; amountRaw: bigint; addresses: string[]; satsEach: number; ticker: string },
): Promise<FundedInvites> {
  if (!m.addresses.length) throw new Error('No invites');
  if (!ctx.services?.bsv21) throw new Error('Token services unavailable');
  const tokenId = m.tokenId;
  const details = await ctx.services.bsv21.getTokenDetails(tokenId, { fresh: true });
  const planned = inviteOutputs(tokenId, m.amountRaw, m.addresses, m.satsEach);
  const need = m.amountRaw * BigInt(m.addresses.length);

  const list = await ctx.wallet.listOutputs({
    basket: BSV21_BASKET,
    includeTags: true,
    includeCustomInstructions: true,
    include: 'entire transactions',
    limit: 10000,
  });
  const fields = (o: ListedOutput) =>
    bsv21FieldsFromOutput({ tags: o.tags, customInstructions: o.customInstructions, outpoint: o.outpoint });
  const mine = (list.outputs as ListedOutput[]).filter((o) => {
    const id = fields(o).tokenId;
    return !!id && normId(id) === normId(tokenId);
  });
  const states = new Map<string, string>();
  for (const s of await ctx.services.bsv21.getOutputStatus(
    tokenId,
    mine.map((o) => o.outpoint),
  ))
    states.set(s.outpoint, s.state);
  const selected: ListedOutput[] = [];
  let have = BigInt(0);
  for (const o of mine) {
    if (have >= need) break;
    const amt = fields(o).amt;
    if (!amt || states.get(o.outpoint) !== 'valid') continue;
    selected.push(o);
    have += BigInt(amt);
  }
  const sym = details.token.sym ?? 'tokens';
  if (have < need) throw new Error(`Not enough $${sym} ready to send`);

  const outputs: Array<PlannedOutput & { basket?: string; tags?: string[]; customInstructions?: string }> = [
    ...planned,
  ];
  let tokenOuts = m.addresses.length;
  const change = have - need;
  if (change > BigInt(0)) {
    tokenOuts++;
    const keyID = `${tokenId}-${Date.now()}`;
    const { publicKey } = await ctx.wallet.getPublicKey({
      protocolID: P1SAT_PROTOCOL,
      keyID,
      counterparty: 'self',
      forSelf: true,
    });
    const lock = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress());
    outputs.push({
      lockingScript: BSV21.transfer(tokenId, change).lock(lock).toHex(),
      satoshis: 1,
      outputDescription: 'Token change',
      basket: BSV21_BASKET,
      tags: bsv21FilterTags({ tokenId }),
      customInstructions: buildBsv21CustomInstructions({
        token: {
          id: tokenId,
          op: 'transfer',
          amt: change.toString(),
          sym: details.token.sym,
          dec: details.token.dec ?? 0,
          icon: details.token.icon,
        },
        protocolID: P1SAT_PROTOCOL,
        keyID,
        counterparty: 'self',
      }),
    });
  }
  const feeAddr = details.status?.fee_address;
  const feePer = details.status?.fee_per_output;
  if (typeof feeAddr === 'string' && feeAddr && typeof feePer === 'number' && feePer > 0) {
    outputs.push({
      lockingScript: new P2PKH().lock(feeAddr).toHex(),
      satoshis: feePer * tokenOuts,
      outputDescription: 'Overlay processing fee',
    });
  }
  const inputBEEF = list.BEEF ? Array.from(list.BEEF) : undefined;
  if (!inputBEEF?.length) throw new Error('Token inputs unavailable');
  const description = `Room invites: ${m.addresses.length} × $${sym} for $${m.ticker.replace(/^\$/, '')}`;
  const args = await prepareP1SatArgs(ctx, {
    description,
    labels: [
      buildTokenLabel(tokenId),
      ...selected
        .map((o) => readAssetIdTag(o.tags))
        .filter((id): id is string => !!id)
        .map((id) => buildInputAssetLabel(BSV21_BASKET, id)),
    ],
    inputBEEF,
    inputs: selected.map((o) => ({
      outpoint: o.outpoint,
      inputDescription: 'Token input',
      unlockingScriptLength: 108,
    })),
    outputs,
    options: { randomizeOutputs: false },
  });
  const spends = selected
    .map((o) => readAssetIdTag(o.tags))
    .filter((id): id is string => !!id)
    .map((id) => ({ basket: BSV21_BASKET, id }));
  const res = await executeTrackedAction(ctx.wallet, args, undefined, inputBEEF, undefined, {
    spends,
    permissionScheme: 'bsv21',
  });
  if (res.error || !res.tx || !res.txid) throw new Error(res.error || 'The wallet did not send the invites');
  try {
    await ctx.services.overlay.submitBsv21(res.tx, tokenId);
  } catch {
    /* the overlay also picks it up from the network */
  }
  return { txid: res.txid, beef: Utils.toHex(res.tx) };
}

// ── finding a one-time address's outputs (claim and revoke) ──

export interface SweepIn {
  outpoint: string;
  satoshis: number;
  lockingScript: string;
}
export interface TokenSweepIn extends SweepIn {
  tokenId: string;
  amount: string;
}
export interface ClaimPlan {
  sats: SweepIn[];
  tokens: TokenSweepIn[];
}

/** The bsv-20 JSON inscribed in a token output, if any. */
function bsv20Of(script: Script): { id?: string; amt?: string; op?: string } | null {
  for (const c of script.chunks) {
    if (!c.data || c.data.length < 10) continue;
    try {
      const j = JSON.parse(Utils.toUTF8(c.data)) as { p?: string; id?: string; amt?: string; op?: string };
      if (j?.p === 'bsv-20') return j;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/**
 * Which outputs of the funding tx the one-time `address` controls: plain P2PKH ones are sats to
 * sweep; inscribed BSV-21 transfers to it are tokens. Anything else is left alone.
 */
export function claimPlan(tx: Transaction, address: string): ClaimPlan {
  const txid = tx.id('hex');
  const p2pkh = new P2PKH().lock(address).toHex();
  const plan: ClaimPlan = { sats: [], tokens: [] };
  tx.outputs.forEach((o, vout) => {
    const hex = o.lockingScript.toHex();
    const sats = o.satoshis ?? 0;
    const base = { outpoint: `${txid}_${vout}`, satoshis: sats, lockingScript: hex };
    if (hex === p2pkh) {
      plan.sats.push(base);
      return;
    }
    if (!hex.endsWith(p2pkh)) return;
    const j = bsv20Of(o.lockingScript);
    if (j?.op === 'transfer' && j.id && j.amt && /^\d+$/.test(j.amt))
      plan.tokens.push({ ...base, tokenId: normId(j.id), amount: j.amt });
  });
  return plan;
}

/** The funding transaction, from the services' BEEF lookup. */
export async function fetchFundingTx(ctx: OneSatContext, txid: string): Promise<Transaction> {
  if (!ctx.services) throw new Error('Services unavailable');
  const beef = await ctx.services.getBeefForTxid(txid);
  const tx = beef.findTxid(txid)?.tx;
  if (!tx) throw new Error('Could not find the invite transaction');
  return tx;
}

export interface SweepResult {
  satsTxid?: string;
  tokenTxid?: string;
}

/**
 * Sweep a one-time key into the CURRENT wallet: sats first (so an empty wallet can pay the token
 * sweep's fee), then the token. Used by the invitee (claim) and the host (revoke).
 */
export async function sweepInvite(ctx: OneSatContext, wif: string, fundingTxid: string): Promise<SweepResult> {
  const key = PrivateKey.fromWif(wif);
  const tx = await fetchFundingTx(ctx, fundingTxid);
  const plan = claimPlan(tx, addressOf(key));
  if (!plan.sats.length && !plan.tokens.length) throw new Error('Nothing to collect at this invite');
  const out: SweepResult = {};
  if (plan.sats.length) {
    const r = await sweepBsv.execute(ctx, { inputs: plan.sats, keys: plan.sats.map(() => key) });
    if (r.error) throw new Error(r.error);
    out.satsTxid = r.txid;
  }
  for (const t of plan.tokens) {
    const r = await sweepBsv21.execute(ctx, { inputs: [t], keys: [key] });
    if (r.error) {
      if (r.error === 'unvalidated-inputs') throw new Error('Already collected, or the token is not indexed yet');
      throw new Error(r.error);
    }
    out.tokenTxid = r.txid;
  }
  return out;
}

// ── this device's links (encrypted with the wallet's own key) ──

export interface StoredInvite {
  code: string;
  x_handle: string;
  funded_address: string;
  wif: string;
  txid: string;
  url: string;
  created_at: string;
}

const VAULT_PROTOCOL: [0, string] = [0, 'bwx xinvites'];
const vaultSlot = (ticker: string) => `bwx.xinvites.${ticker.replace(/^\$/, '').toLowerCase()}`;

type Crypto = Pick<OneSatContext['wallet'], 'encrypt' | 'decrypt'>;
type SecureStore = {
  secureGet(o: { key: string }): Promise<{ value: string | null }>;
  secureSet(o: { key: string; value: string }): Promise<void>;
};

export async function loadStoredInvites(
  wallet: Crypto,
  ticker: string,
  store: SecureStore = YoursNative,
): Promise<StoredInvite[]> {
  const v = (await store.secureGet({ key: vaultSlot(ticker) }).catch(() => ({ value: null }))).value;
  if (!v) return [];
  try {
    const { plaintext } = await wallet.decrypt({
      ciphertext: Utils.toArray(v, 'base64'),
      protocolID: VAULT_PROTOCOL,
      keyID: vaultSlot(ticker),
      counterparty: 'self',
    });
    const list = JSON.parse(Utils.toUTF8(plaintext)) as StoredInvite[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveStoredInvites(
  wallet: Crypto,
  ticker: string,
  list: StoredInvite[],
  store: SecureStore = YoursNative,
): Promise<void> {
  const { ciphertext } = await wallet.encrypt({
    plaintext: Utils.toArray(JSON.stringify(list), 'utf8'),
    protocolID: VAULT_PROTOCOL,
    keyID: vaultSlot(ticker),
    counterparty: 'self',
  });
  await store.secureSet({ key: vaultSlot(ticker), value: Utils.toBase64(ciphertext) });
}

/** Add (or replace by code) and save. */
export async function rememberInvites(wallet: Crypto, ticker: string, add: StoredInvite[], store?: SecureStore) {
  const cur = await loadStoredInvites(wallet, ticker, store);
  const codes = new Set(add.map((a) => a.code));
  await saveStoredInvites(wallet, ticker, [...cur.filter((c) => !codes.has(c.code)), ...add], store);
}

// ── an opened link, held in memory only until the claim screen takes it ──

let pendingClaim: XInviteLink | null = null;
const claimListeners = new Set<() => void>();
export const offerXInvite = (link: XInviteLink) => {
  pendingClaim = link;
  claimListeners.forEach((l) => l());
};
export const takeXInvite = () => {
  const c = pendingClaim;
  pendingClaim = null;
  return c;
};
export const peekXInvite = () => pendingClaim;
export const onXInvite = (l: () => void) => (claimListeners.add(l), () => void claimListeners.delete(l));

// ── handoff from Friends › "Invite the rest" (wallet/XFollowsImport) ──

let invitePrefill: string[] = [];

/** Queue @handles for the next Invites sheet (your room); it opens straight on its confirm with the cost. */
export const requestInvitePrefill = (handles: readonly string[]) => {
  invitePrefill = parseHandles(handles.join(' '));
};

/** Take the queued handles once, at most one batch; the rest stay queued for the next batch. */
export const takeInvitePrefill = (): string[] => {
  const batch = invitePrefill.slice(0, MAX_INVITES_PER_BATCH);
  invitePrefill = invitePrefill.slice(MAX_INVITES_PER_BATCH);
  return batch;
};

export const hasInvitePrefill = () => invitePrefill.length > 0;
