/**
 * One guarded path for payments whose destination comes from a server (b-Aware reports, 25 Oct 2026).
 *
 * Before anything is signed:
 *  (a) every paying output must be one the caller says the sheet shows (address + amount), and nothing else pays out;
 *  (b) every server-named destination must match a trusted source: an address pinned in this code, or the payee's
 *      own key binding / token issuer the caller resolved independently. Anything else is refused;
 *  (c) a hard ceiling per kind of payment where the price is a known small fee;
 *  (d) the spending pause is checked again right before signing.
 * Every refusal says "Nothing was paid".
 */
import { P2PKH, Script, Utils } from '@bsv/sdk';
import { assertNotPaused } from '../mobile/config/killSwitch';
import { HOUSE_ADDRESS } from '../mobile/market/launchpad/curve';

/** bCorp's own public receive addresses (store, theme editions, fees). A server can't add to this list. */
export const PINNED_REVENUE_ADDRESSES: readonly string[] = [HOUSE_ADDRESS];

export class GuardedPayError extends Error {
  constructor(why: string) {
    super(`Payment refused: ${why}. Nothing was paid.`);
    this.name = 'GuardedPayError';
  }
}

export type Shown = { address: string; sats: number };

/** Where a server-named address may point. */
export type Trust =
  | { kind: 'pinned'; addresses?: readonly string[] }
  /** The address resolved from the payee's binding / token issuer, NOT from the server that sent the charge. */
  | { kind: 'bound'; address: string | null | undefined; who: string };

const p2pkhAddress = (hex: string): string | null => {
  try {
    const chunks = Script.fromHex(hex).chunks;
    if (
      chunks.length === 5 &&
      chunks[0].op === 0x76 &&
      chunks[1].op === 0xa9 &&
      chunks[2].data?.length === 20 &&
      chunks[3].op === 0x88 &&
      chunks[4].op === 0xac
    )
      return Utils.toBase58Check(chunks[2].data, [0]);
  } catch {
    /* not a script */
  }
  return null;
};

/** Is `to` a destination this trust allows? Pure; throws GuardedPayError. */
export function checkPayTo(to: string, trust: Trust): void {
  if (trust.kind === 'pinned') {
    const list = trust.addresses ?? PINNED_REVENUE_ADDRESSES;
    if (!list.includes(to)) throw new GuardedPayError('the server asked to pay an address that is not ours');
    return;
  }
  if (!trust.address) throw new GuardedPayError(`we could not confirm ${trust.who}'s address`);
  if (to !== trust.address) throw new GuardedPayError(`the address is not ${trust.who}'s`);
}

type Out = { lockingScript: string; satoshis: number };

/**
 * The built outputs pay exactly what the sheet shows: every output with satoshis > 1 is a P2PKH to a shown address
 * for its shown amount (1-sat token/receipt outputs and 0-sat data outputs are the caller's own), and every shown
 * line is paid. Pure; throws GuardedPayError.
 */
export function checkOutputsMatchShown(
  outputs: readonly Out[],
  shown: readonly Shown[],
  opts: { maxSats?: number } = {},
) {
  const want = shown.map((s) => ({ ...s }));
  let total = 0;
  for (const o of outputs) {
    if (!Number.isSafeInteger(o.satoshis) || o.satoshis < 0) throw new GuardedPayError('an output has a bad amount');
    if (o.satoshis <= 1) continue;
    const addr = p2pkhAddress(o.lockingScript);
    const i = want.findIndex((w) => w.address === addr && w.sats === o.satoshis);
    if (!addr || i < 0) throw new GuardedPayError('the payment does not match what you were shown');
    want.splice(i, 1);
    total += o.satoshis;
  }
  if (want.length) throw new GuardedPayError('the payment does not match what you were shown');
  if (opts.maxSats !== undefined && total > opts.maxSats) throw new GuardedPayError('the price is higher than allowed');
}

/** The server's script → address, for a P2PKH quote output. Throws when it isn't one. */
export const scriptAddress = (hex: string): string => {
  const a = p2pkhAddress(hex);
  if (!a) throw new GuardedPayError('the server sent an output we can not read');
  return a;
};

export const p2pkhScript = (address: string) => new P2PKH().lock(address).toHex();

/**
 * Check, then run `sign` (the createAction call). `trust` applies to every shown address. The pause is read last.
 */
export async function guardedPay<T>(
  p: { outputs: readonly Out[]; shown: readonly Shown[]; trust: Trust; maxSats?: number },
  sign: () => Promise<T>,
  paused: () => Promise<void> = () => assertNotPaused('spending'),
): Promise<T> {
  for (const s of p.shown) checkPayTo(s.address, p.trust);
  checkOutputsMatchShown(p.outputs, p.shown, { maxSats: p.maxSats });
  await paused();
  return sign();
}
