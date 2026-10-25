/**
 * Per-message room spend (owner, 8 Oct 2026): a priced token room's message and its payment
 * are ONE transaction, so they can't be separated. bit-sign verifies it on every post
 * (bit-sign src/lib/room-spend.ts; the commitment bytes must match `commitmentScript` there).
 *
 *   payment:    P2PKH sats to the issuer | BSV-21 `burn` output | BSV-21 `transfer` to the issuer
 *   commitment: OP_FALSE OP_RETURN <MAP> SET app bChat type room_pay
 *                 room <ticker> author <handle> body <sha256 hex of the text> rule <rule since>
 *
 * Pure helpers (tested in roomSpend.test.ts) + `payForMessage`, which builds and SIGNS the tx
 * with `noSend` (the wallet never broadcasts it) and returns its AtomicBEEF. bit-sign verifies,
 * broadcasts and only then stores the message; if it refuses, nothing was spent and
 * `releasePayment` aborts the action so the wallet frees the inputs.
 */
import { Hash, OP, P2PKH, PublicKey, Script, Utils } from '@bsv/sdk';
import { BSV21 } from '@1sat/templates';
import {
  BSV21_BASKET,
  P1SAT_PROTOCOL,
  bsv21FieldsFromOutput,
  bsv21FilterTags,
  buildBsv21CustomInstructions,
  executeTrackedAction,
  prepareP1SatArgs,
  type OneSatContext,
} from '@1sat/actions';
import { buildInputAssetLabel, buildTokenLabel, readAssetIdTag } from '@1sat/types';
import { formatRaw } from './tokenRooms';
import { withTokenKeyCheck } from '../../services/tokenSpendGuard';
import { checkPayTo } from '../../services/guardedPay';
import { assertNotPaused } from '../config/killSwitch';

/** Token id equality (dot or underscore outpoint form). */
const normalizeBsv21TokenId = (id: string) => id.trim().toLowerCase().replace('.', '_');

export const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';

/** What one message must carry (the server's `spend_charge.charges`). */
export type MessageCharge =
  | { unit: 'sats'; amount: string; to: string }
  | { unit: 'token'; tokenId: string; amount: string; to: 'burn' | string };

/** GET token-gated `spend_charge`. */
export interface SpendCharge {
  rule: string;
  charges: MessageCharge[];
  unenforced: string | null;
  exempt: boolean;
}

const isAmt = (s: unknown): s is string => typeof s === 'string' && /^\d{1,30}$/.test(s) && !/^0+$/.test(s);

export function parseSpendCharge(v: unknown): SpendCharge | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { rule?: unknown; charges?: unknown; unenforced?: unknown; exempt?: unknown };
  const charges: MessageCharge[] = [];
  for (const c of Array.isArray(o.charges) ? o.charges : []) {
    const x = c as { unit?: unknown; amount?: unknown; to?: unknown; tokenId?: unknown };
    if (!isAmt(x.amount) || typeof x.to !== 'string' || !x.to) return null;
    if (x.unit === 'sats') charges.push({ unit: 'sats', amount: x.amount, to: x.to });
    else if (x.unit === 'token' && typeof x.tokenId === 'string')
      charges.push({ unit: 'token', tokenId: x.tokenId, amount: x.amount, to: x.to });
    else return null;
  }
  return {
    rule: typeof o.rule === 'string' ? o.rule : '',
    charges,
    unenforced: typeof o.unenforced === 'string' ? o.unenforced : null,
    exempt: o.exempt === true,
  };
}

/** Does posting here cost anything for me? */
export const mustPay = (c: SpendCharge | null | undefined): c is SpendCharge =>
  !!c && !c.exempt && c.charges.length > 0;

/** "5 $ACME, burned" / "100 sats to the issuer" */
export function chargeLabel(c: MessageCharge, symbol: string, dec: number): string {
  if (c.unit === 'sats') return `${c.amount} sats to the issuer`;
  return `${formatRaw(c.amount, dec)} $${symbol}${c.to === 'burn' ? ', burned' : ' to the issuer'}`;
}

/** "This message costs 5 $ACME, burned" */
export const costLine = (c: SpendCharge, symbol: string, dec: number) =>
  `This message costs ${c.charges.map((x) => chargeLabel(x, symbol, dec)).join(' + ')}`;

export const sha256Hex = (text: string) => Utils.toHex(Hash.sha256(Utils.toArray(text, 'utf8')));

export interface Commitment {
  room: string;
  author: string;
  body: string;
  rule: string;
}

/** Must produce the same bytes as bit-sign's commitmentScript. */
export function commitmentScript(c: Commitment): Script {
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  const push = (v: string) => s.writeBin(Utils.toArray(v, 'utf8'));
  push(MAP_PREFIX);
  push('SET');
  for (const [k, v] of [
    ['app', 'bChat'],
    ['type', 'room_pay'],
    ['room', c.room],
    ['author', c.author],
    ['body', c.body],
    ['rule', c.rule],
  ]) {
    push(k);
    push(v);
  }
  return s;
}

export const commitmentFor = (ticker: string, handle: string, text: string, rule: string): Commitment => ({
  room: ticker.replace(/^\$/, ''),
  author: handle.replace(/^\$/, '').toLowerCase(),
  body: sha256Hex(text.trim()),
  rule,
});

export interface PlannedOutput {
  lockingScript: string;
  satoshis: number;
  outputDescription: string;
}

/**
 * The payment + commitment outputs for one message (token CHANGE and fees are added by the
 * builder). Order: token outputs first, then sats, then the commitment.
 */
export function paymentOutputs(charges: MessageCharge[], commitment: Commitment): PlannedOutput[] {
  const out: PlannedOutput[] = [];
  for (const c of charges) {
    if (c.unit !== 'token') continue;
    const script =
      c.to === 'burn'
        ? BSV21.burn(c.tokenId, BigInt(c.amount)).lock()
        : BSV21.transfer(c.tokenId, BigInt(c.amount)).lock(new P2PKH().lock(c.to));
    out.push({
      lockingScript: script.toHex(),
      satoshis: 1,
      outputDescription: c.to === 'burn' ? 'Room message burn' : 'Room message payment',
    });
  }
  for (const c of charges) {
    if (c.unit !== 'sats') continue;
    out.push({
      lockingScript: new P2PKH().lock(c.to).toHex(),
      satoshis: Number(c.amount),
      outputDescription: 'Room message payment',
    });
  }
  out.push({ lockingScript: commitmentScript(commitment).toHex(), satoshis: 0, outputDescription: 'Room message' });
  return out;
}

// ── confirm / auto-pay settings ──

export interface SpendPrefs {
  /** Per room: pay without asking when the token amount is ≤ this (raw). '' = always ask. */
  autoUnderRaw: string;
  /** Per room, per app session: stop auto-paying past this total (raw). '' = no auto-pay cap. */
  sessionCapRaw: string;
}
const PREF_KEY = (roomKey: string) => `bwx.roomSpend.${roomKey}`;

export function loadPrefs(roomKey: string, store: Pick<Storage, 'getItem'> | null = safeStorage()): SpendPrefs {
  try {
    const v = JSON.parse(store?.getItem(PREF_KEY(roomKey)) || 'null') as Partial<SpendPrefs> | null;
    return {
      autoUnderRaw: isAmt(v?.autoUnderRaw) ? v!.autoUnderRaw! : '',
      sessionCapRaw: isAmt(v?.sessionCapRaw) ? v!.sessionCapRaw! : '',
    };
  } catch {
    return { autoUnderRaw: '', sessionCapRaw: '' };
  }
}

export function savePrefs(roomKey: string, p: SpendPrefs, store: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try {
    store?.setItem(PREF_KEY(roomKey), JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Spent this app session, per room key (memory only: a restart is a new session). */
const sessionSpent = new Map<string, bigint>();
export const spentThisSession = (roomKey: string) => sessionSpent.get(roomKey) ?? BigInt(0);
export const recordSpent = (roomKey: string, raw: bigint) => sessionSpent.set(roomKey, spentThisSession(roomKey) + raw);
export const resetSessionSpend = () => sessionSpent.clear();

/** Total cost in one unit, for the auto-pay comparison (sats and token never mixed). */
export const totalRaw = (c: SpendCharge): bigint => c.charges.reduce((n, x) => n + BigInt(x.amount), BigInt(0));

/** Ask before paying? Yes unless under the room's "don't ask" amount and within the session cap. */
export function needsConfirm(c: SpendCharge, prefs: SpendPrefs, spent: bigint): boolean {
  if (!prefs.autoUnderRaw) return true;
  const units = new Set(c.charges.map((x) => x.unit));
  if (units.size !== 1) return true;
  const cost = totalRaw(c);
  if (cost > BigInt(prefs.autoUnderRaw)) return true;
  if (prefs.sessionCapRaw && spent + cost > BigInt(prefs.sessionCapRaw)) return true;
  return false;
}

// ── building the transaction ──

/** Sign, never broadcast: bit-sign broadcasts after it verifies (owner, 8 Oct 2026). */
export const NO_SEND = { randomizeOutputs: false, noSend: true } as const;

/** bit-sign refused the message: drop the unsent action so its inputs are spendable again. */
export async function releasePayment(ctx: OneSatContext, txid: string): Promise<void> {
  try {
    await ctx.wallet.abortAction({ reference: txid });
  } catch {
    /* already gone, or the wallet frees it on its own */
  }
}

/** Minimum charges (owner, 8 Oct 2026). Token rules: at least 1 raw unit. */
export const SATS_FLOOR = 50;
export const spendFloorError = (unit: 'token' | 'sats', raw: string): string | null =>
  unit === 'sats' && BigInt(raw) < BigInt(SATS_FLOOR) ? `At least ${SATS_FLOOR} sats per message` : null;

type ListedOutput = { outpoint: string; tags?: string[]; customInstructions?: string };

/**
 * Build, sign and broadcast the message tx through the wallet. Returns the AtomicBEEF hex for
 * the post (`spend.beef`) and the txid. Token inputs are only spent once the overlay says they
 * are valid (as sendBsv21 does), so the server's provenance check passes.
 */
/**
 * b-Aware 25 Oct 2026: a charge's payee must be the room's issuer (from the room, not from the charge), or a burn.
 * Pure; throws GuardedPayError.
 */
export function checkChargePayees(charges: MessageCharge[], issuerAddress: string | null | undefined): void {
  for (const c of charges) {
    if (c.unit === 'token' && c.to === 'burn') continue;
    checkPayTo(c.to, { kind: 'bound', address: issuerAddress, who: "the room's issuer" });
  }
}

export async function payForMessage(
  ctx: OneSatContext,
  m: { ticker: string; handle: string; text: string; charge: SpendCharge; issuerAddress: string | null | undefined },
): Promise<{ beef: string; txid: string }> {
  checkChargePayees(m.charge.charges, m.issuerAddress);
  return payForCharges(ctx, m);
}

/**
 * Paid listening (spaces/paidListen.ts) pays the Space's speakers from a plan the user approved; its payees are
 * checked there, not against the issuer.
 */
export async function payForCharges(
  ctx: OneSatContext,
  m: { ticker: string; handle: string; text: string; charge: SpendCharge },
): Promise<{ beef: string; txid: string }> {
  await assertNotPaused('spending');
  const tokenIds = m.charge.charges.flatMap((c) => (c.unit === 'token' ? [c.tokenId] : []));
  if (!tokenIds.length) return payForMessageOnce(ctx, m);
  // F-3: token inputs whose records can't be signed are fixed before, and once after, an empty unlock.
  return withTokenKeyCheck(ctx, tokenIds, () => payForMessageOnce(ctx, m));
}

async function payForMessageOnce(
  ctx: OneSatContext,
  m: { ticker: string; handle: string; text: string; charge: SpendCharge },
): Promise<{ beef: string; txid: string }> {
  const commitment = commitmentFor(m.ticker, m.handle, m.text, m.charge.rule);
  const planned = paymentOutputs(m.charge.charges, commitment);
  const tokens = m.charge.charges.filter((c): c is Extract<MessageCharge, { unit: 'token' }> => c.unit === 'token');
  const tokenId = tokens[0]?.tokenId;
  if (tokens.some((t) => t.tokenId !== tokenId)) throw new Error('One token per message payment');

  if (!tokenId) {
    const r = await ctx.wallet.createAction({
      description: `Message in $${commitment.room}`,
      outputs: planned,
      options: NO_SEND,
    });
    if (!r.tx || !r.txid) throw new Error('The wallet did not return the payment');
    return { beef: Utils.toHex(r.tx), txid: r.txid };
  }

  const need = tokens.reduce((n, t) => n + BigInt(t.amount), BigInt(0));
  if (!ctx.services?.bsv21) throw new Error('Token services unavailable');
  const details = await ctx.services.bsv21.getTokenDetails(tokenId, { fresh: true });
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
    return !!id && normalizeBsv21TokenId(id) === normalizeBsv21TokenId(tokenId);
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
  if (have < need) throw new Error(`Not enough $${details.token.sym ?? 'tokens'} ready to spend`);

  const outputs: Array<PlannedOutput & { basket?: string; tags?: string[]; customInstructions?: string }> = [
    ...planned,
  ];
  const change = have - need;
  let tokenOuts = tokens.length;
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
    // Change goes right after the payment outputs, before sats and the commitment.
    outputs.splice(tokens.length, 0, {
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
  const args = await prepareP1SatArgs(ctx, {
    description: `Message in $${commitment.room}`,
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
    options: NO_SEND,
  });
  const spends = selected
    .map((o) => readAssetIdTag(o.tags))
    .filter((id): id is string => !!id)
    .map((id) => ({ basket: BSV21_BASKET, id }));
  const res = await executeTrackedAction(ctx.wallet, args, undefined, inputBEEF, undefined, {
    spends,
    permissionScheme: 'bsv21',
  });
  if (res.error || !res.tx || !res.txid) throw new Error(res.error || 'The wallet did not return the payment');
  // No overlay submit here: the tx is not on the network until bit-sign broadcasts it.
  return { beef: Utils.toHex(res.tx), txid: res.txid };
}
