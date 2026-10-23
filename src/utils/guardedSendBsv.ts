import { sendBsv as upstreamSendBsv } from '@1sat/actions';

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

const execute: typeof upstreamSendBsv.execute = async (ctx, input) => {
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

export const sendBsv: typeof upstreamSendBsv = Object.assign(Object.create(upstreamSendBsv), {
  ...upstreamSendBsv,
  execute,
});
