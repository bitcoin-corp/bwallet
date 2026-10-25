import { resolvePaymentHandle, sendBsv as upstreamSendBsv } from '@1sat/actions';
import { Transaction, Utils } from '@bsv/sdk';
import { CAP, destinationFor, fill, getCapabilities, isOurDomain, resolvePaymail } from '../mobile/names/names';
import { checkP2pDestination, type P2pOutput } from './paymailDestination';

/**
 * sendBsv with a check on what the paymail host returns.
 *
 * Upstream sendBsv asks a paymail host for a P2P payment destination and copies the returned outputs (script AND
 * satoshis) into createAction. The host decides those values, not the person who approved the payment. This wrapper
 * checks the outputs handed to createAction against the requests the person approved, and refuses the payment unless:
 * - every paymail's outputs add up to exactly the approved amount for that paymail,
 * - every other output is one the wallet built itself from an approved request (same amount),
 * - there is no output the requests do not account for.
 *
 * Paymail payments (b_feedback 67) don't go through upstream's own destination fetch: this wrapper fetches the P2P
 * destination itself, re-derives every returned script from the payee's identity key (the one the payer saw, via pki
 * and the signed name binding; or `identityKey` on the request), refuses a script that doesn't match, then pays the
 * checked scripts through upstream sendBsv and delivers the BEEF to the host with the reference. Our own host must
 * return the derivation; a third-party host that returns none is paid as before and the result lists it in
 * `unverified` (the pay sheet already showed names.ts NOT_VERIFIED_NOTE for it).
 *
 * Use this everywhere instead of importing sendBsv from '@1sat/actions'.
 */

type SendBsvInput = Parameters<typeof upstreamSendBsv.execute>[1];
type SendBsvRequest = SendBsvInput['requests'][number];
type Ctx = Parameters<typeof upstreamSendBsv.execute>[0];
type Output = { satoshis?: number; outputDescription?: string; lockingScript?: string };

const PAYMAIL_PREFIX = 'Paymail payment to ';
const HANDLE_DESCRIPTION = 'Payment to handle';
const PLAIN = /^Payment of (\d+) sats$/;

export class PaymentOutputMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentOutputMismatch';
  }
}

const isSats = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/**
 * Returns null when `outputs` match the approved `requests`, otherwise the reason they do not.
 * Pure: exported for tests.
 */
export const checkPaymentOutputs = (requests: readonly SendBsvRequest[], outputs: readonly Output[]): string | null => {
  if (!outputs.length) return 'no outputs';
  const wantPaymail = new Map<string, number>();
  const wantPlain: number[] = [];
  for (const r of requests) {
    if (!isSats(r.satoshis)) return 'invalid approved amount';
    const pm = r.paymail ?? r.handle;
    if (pm) wantPaymail.set(pm, (wantPaymail.get(pm) ?? 0) + r.satoshis);
    else wantPlain.push(r.satoshis);
  }

  // A BRC-169 handle payment: one request, one output the wallet built with the approved amount.
  const handleOuts = outputs.filter((o) => o.outputDescription === HANDLE_DESCRIPTION);
  if (handleOuts.length) {
    if (requests.length !== 1 || outputs.length !== 1) return 'unexpected outputs in a handle payment';
    return handleOuts[0].satoshis === requests[0].satoshis ? null : 'handle payment amount differs from approved';
  }

  const gotPaymail = new Map<string, number>();
  const gotPlain: number[] = [];
  for (const o of outputs) {
    if (!isSats(o.satoshis)) return 'output with an invalid amount';
    const d = o.outputDescription ?? '';
    if (d.startsWith(PAYMAIL_PREFIX)) {
      const pm = d.slice(PAYMAIL_PREFIX.length);
      if (!wantPaymail.has(pm)) return `output for an unrequested paymail ${pm}`;
      gotPaymail.set(pm, (gotPaymail.get(pm) ?? 0) + o.satoshis);
      if (gotPaymail.get(pm)! > wantPaymail.get(pm)!) return `${pm} returned more than the approved amount`;
      continue;
    }
    const m = PLAIN.exec(d);
    if (m && Number(m[1]) === o.satoshis) {
      gotPlain.push(o.satoshis);
      continue;
    }
    return 'output the approved requests do not account for';
  }
  for (const [pm, sats] of wantPaymail) {
    if (gotPaymail.get(pm) !== sats) return `${pm} outputs do not add up to the approved amount`;
  }
  const a = [...wantPlain].sort((x, y) => x - y);
  const b = [...gotPlain].sort((x, y) => x - y);
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) return 'outputs do not match the approved payments';
  return null;
};

const assertOutputs = (requests: readonly SendBsvRequest[], args: { outputs?: Output[] }) => {
  const why = checkPaymentOutputs(requests, args.outputs ?? []);
  if (why) throw new PaymentOutputMismatch(`Payment refused: ${why}. Nothing was sent.`);
};

/** The context with createAction (and any funding provider) checked against `requests` before anything is signed. */
export const guardContext = <C extends Ctx>(ctx: C, requests: readonly SendBsvRequest[]): C => {
  const wallet = ctx.wallet;
  const createAction = wallet.createAction.bind(wallet);
  return {
    ...ctx,
    wallet: Object.assign(Object.create(wallet), {
      createAction: async (args: Parameters<typeof createAction>[0], originator?: string) => {
        assertOutputs(requests, args as { outputs?: Output[] });
        return createAction(args, originator);
      },
    }),
  };
};

/** Upstream sendBsv with createAction / the funding provider checked against `requests`. */
const guardedUpstream: typeof upstreamSendBsv.execute = async (ctx, input) => {
  const requests = input?.requests ?? [];
  const fp = input?.fundingProvider;
  const guardedInput: SendBsvInput = fp
    ? {
        ...input,
        fundingProvider: {
          ...fp,
          fund: async (args: Parameters<typeof fp.fund>[0]) => {
            assertOutputs(requests, args as { outputs?: Output[] });
            return fp.fund(args);
          },
        },
      }
    : input;
  try {
    return await upstreamSendBsv.execute(guardContext(ctx, requests), guardedInput);
  } catch (e) {
    if (e instanceof PaymentOutputMismatch) return { error: e.message };
    throw e;
  }
};

/** A paymail request may carry the payee key the pay sheet showed; otherwise it is looked up again here. */
export type PaymailRequest = SendBsvRequest & { identityKey?: string };
type Delivery = { paymail: string; alias: string; domain: string; reference: string; caps: Record<string, unknown> };
const f = (u: string, i?: RequestInit) => fetch(u, i);
const refused = (why: string) => new PaymentOutputMismatch(`Payment refused: ${why}. Nothing was sent.`);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** The payee's identity key as the pay sheet resolves it (pki + signed binding + key-change checks). */
const payeeKey = async (paymail: string, ours: boolean): Promise<string | undefined> => {
  try {
    const r = await resolvePaymail(f, paymail);
    const d = destinationFor(r, 'bsv');
    if (!d.ok) throw refused(d.error.replace(/\.$/, ''));
    return r.pubkey;
  } catch (e) {
    if (e instanceof PaymentOutputMismatch || ours)
      throw e instanceof PaymentOutputMismatch
        ? e
        : refused((e instanceof Error ? e.message : String(e)).replace(/\.$/, ''));
    return undefined; // a third-party host we can't look up: only its derivation (if any) could be checked
  }
};

/** Fetch, check and convert one paymail request into the plain script outputs it pays. */
const checkedDestination = async (req: PaymailRequest, paymail: string) => {
  const [alias, domain] = paymail.split('@');
  if (!alias || !domain) throw refused(`${paymail} is not a paymail`);
  const ours = isOurDomain(domain);
  const key = str(req.identityKey) ?? (await payeeKey(paymail, ours));
  const caps = await getCapabilities(f, domain);
  const url = str(caps[CAP.p2pDestination]);
  if (!url) throw refused(`${domain} does not support P2P payment destinations`);
  const res = await f(fill(url, alias, domain), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ satoshis: req.satoshis }),
  });
  if (!res.ok) throw refused(`the paymail host answered ${res.status}`);
  const dest = (await res.json()) as { outputs?: P2pOutput[]; reference?: string };
  const outputs = dest.outputs ?? [];
  const check = checkP2pDestination(key, outputs);
  if (!check.ok) throw new PaymentOutputMismatch(check.error);
  // Our host always derives from the key: a missing derivation there means it isn't the server we deployed.
  if (!check.verified && ours) throw refused('our paymail host did not let us check the address');
  // b-Aware 25 Oct 2026: when the payer already holds the payee's key from a signed binding (not from this same host),
  // a host that leaves out the derivation is declining a check we can do. Refuse, as for a wrong derivation.
  if (!check.verified && str(req.identityKey))
    throw refused(`${domain} did not let us check the address against ${paymail}'s key`);
  if (!outputs.every((o) => isSats(o.satoshis))) throw refused('output with an invalid amount');
  if (outputs.reduce((a, o) => a + o.satoshis, 0) !== req.satoshis)
    throw refused(`${paymail} outputs do not add up to the approved amount`);
  const reference = str(dest.reference);
  if (!reference) throw refused('the paymail host returned no reference');
  return {
    verified: check.verified,
    requests: outputs.map((o) => ({ script: String(o.script), satoshis: o.satoshis })),
    delivery: { paymail, alias, domain, reference, caps } as Delivery,
  };
};

/** Hand the signed payment to each payee's host (BRC-70 P2P receive), as upstream does after broadcast. */
const deliver = async (d: Delivery, beefHex: string) => {
  const beefUrl = str(d.caps[CAP.receiveBeef]);
  const txUrl = str(d.caps['5f1323cddf31']);
  const url = beefUrl ?? txUrl;
  if (!url) throw new Error(`${d.domain} does not support P2P receive`);
  const body = beefUrl ? { beef: beefHex, reference: d.reference } : { hex: beefHex, reference: d.reference };
  const r = await f(fill(url, d.alias, d.domain), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`P2P send failed: ${r.status}`);
};

const payPaymails = async (
  ctx: Ctx,
  input: SendBsvInput & StrictInput,
): Promise<Awaited<ReturnType<typeof upstreamSendBsv.execute>> & { unverified?: string[] }> => {
  if (input.from) throw refused('sending as a paymail is not supported for checked payments');
  const requests: SendBsvRequest[] = [];
  const deliveries: Delivery[] = [];
  const unverified: string[] = [];
  for (const req of input.requests) {
    const pm = req.paymail ?? req.handle;
    if (!pm) {
      requests.push(req);
      continue;
    }
    if (!isSats(req.satoshis)) throw refused('invalid approved amount');
    const d = await checkedDestination(req, pm);
    requests.push(...d.requests);
    deliveries.push(d.delivery);
    if (!d.verified) unverified.push(pm);
  }
  // No person sees a sheet on these paths (bPhone meter, agents), so nobody could read a "not verified" note.
  if (unverified.length && input.requireVerified)
    throw refused(`${unverified.join(', ')}: the paymail host did not let us check the address`);
  const res = await guardedUpstream(ctx, { ...input, requests });
  if (res.error || !res.txid) return res;
  if (res.tx) {
    const beefHex = Utils.toHex(Transaction.fromAtomicBEEF(res.tx).toBEEF());
    try {
      for (const d of deliveries) await deliver(d, beefHex);
    } catch (e) {
      return { ...res, error: `delivery-failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return unverified.length ? { ...res, unverified } : res;
};

/** requireVerified: refuse any paymail whose host address could not be checked (paths with no sheet in front). */
type StrictInput = { requireVerified?: boolean };

const execute: typeof upstreamSendBsv.execute = async (ctx, input: SendBsvInput & StrictInput) => {
  const requests = input?.requests ?? [];
  try {
    const paymails = requests.map((r) => r.paymail ?? r.handle).filter((p): p is string => !!p);
    if (paymails.length) {
      // BRC-169 handles: upstream builds that output itself from the handle's key, so it has nothing to check.
      let handle = false;
      for (const p of paymails) if ((await resolvePaymentHandle(p)) !== undefined) handle = true;
      if (!handle) return await payPaymails(ctx, input);
    }
  } catch (e) {
    if (e instanceof PaymentOutputMismatch) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'unknown-error' };
  }
  return guardedUpstream(ctx, input);
};

export const sendBsv: typeof upstreamSendBsv = Object.assign(Object.create(upstreamSendBsv), {
  ...upstreamSendBsv,
  execute,
});
