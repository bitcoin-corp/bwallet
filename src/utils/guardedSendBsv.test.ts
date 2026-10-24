import { afterEach, describe, expect, test } from 'bun:test';
import { KeyDeriver, P2PKH, PrivateKey, ProtoWallet, Random, Utils } from '@bsv/sdk';
import { BAD_ORD_PROOF, destinationCheck, destinationFor, resolvePaymail } from '../mobile/names/names';
import { signOrdProof } from '../mobile/names/paymail';
import { checkPaymentOutputs, sendBsv } from './guardedSendBsv';

const PAYMAIL = 'payer@wedge.test';
const scriptA = new P2PKH().lock('125GFsvYsDtyzGkExfsX8DoHuXu2UsMUEZ').toHex();
const scriptB = new P2PKH().lock('18pBoqRpHUYf9udsab5G9LT3vQUPxEyMFf').toHex();
const pm = (satoshis: number, lockingScript = scriptA) => ({
  satoshis,
  lockingScript,
  outputDescription: `Paymail payment to ${PAYMAIL}`,
});

describe('checkPaymentOutputs', () => {
  test('paymail outputs adding up to the approved amount pass', () => {
    expect(checkPaymentOutputs([{ paymail: PAYMAIL, satoshis: 1000 }], [pm(1000)])).toBeNull();
    expect(checkPaymentOutputs([{ paymail: PAYMAIL, satoshis: 1000 }], [pm(600), pm(400, scriptB)])).toBeNull();
  });
  test('a host returning more than approved is refused', () => {
    expect(checkPaymentOutputs([{ paymail: PAYMAIL, satoshis: 1000 }], [pm(5_000_000, scriptB)])).not.toBeNull();
  });
  test('a host returning less than approved is refused', () => {
    expect(checkPaymentOutputs([{ paymail: PAYMAIL, satoshis: 1000 }], [pm(10)])).not.toBeNull();
  });
  test('an output nobody asked for is refused', () => {
    const extra = { satoshis: 1000, lockingScript: scriptB, outputDescription: 'something else' };
    expect(checkPaymentOutputs([{ paymail: PAYMAIL, satoshis: 1000 }], [pm(1000), extra])).not.toBeNull();
    const other = { ...pm(1000), outputDescription: 'Paymail payment to other@wedge.test' };
    expect(checkPaymentOutputs([{ paymail: PAYMAIL, satoshis: 1000 }], [other])).not.toBeNull();
  });
  test('plain address payments must match the approved amounts', () => {
    const plain = (n: number) => ({ satoshis: n, lockingScript: scriptA, outputDescription: `Payment of ${n} sats` });
    const reqs = [{ address: '125GFsvYsDtyzGkExfsX8DoHuXu2UsMUEZ', satoshis: 500 }];
    expect(checkPaymentOutputs(reqs, [plain(500)])).toBeNull();
    expect(checkPaymentOutputs(reqs, [plain(900)])).not.toBeNull();
    expect(checkPaymentOutputs([...reqs, { paymail: PAYMAIL, satoshis: 1000 }], [plain(500), pm(1000)])).toBeNull();
  });
  test('zero, negative or fractional amounts are refused', () => {
    expect(checkPaymentOutputs([{ paymail: PAYMAIL, satoshis: 1000 }], [pm(0), pm(1000)])).not.toBeNull();
    expect(checkPaymentOutputs([{ paymail: PAYMAIL, satoshis: 1000 }], [pm(-5), pm(1005)])).not.toBeNull();
    expect(checkPaymentOutputs([{ paymail: PAYMAIL, satoshis: 1000 }], [pm(999.5), pm(0.5)])).not.toBeNull();
  });
});

describe('sendBsv to a paymail host', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A paymail host whose p2p destination returns `outputs`; a wallet that records createAction. */
  const setup = (outputs: { script: string; satoshis: number }[]) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes('dns.google')) return json({ Status: 3 });
      if (url.endsWith('/.well-known/bsvalias'))
        return json({
          capabilities: {
            '2a40af698840': 'https://wedge.test/p2p/{alias}@{domain.tld}',
            '5c55a7fdb7bb': 'https://wedge.test/beef/{alias}@{domain.tld}',
          },
        });
      if (url.includes('/p2p/')) return json({ outputs, reference: 'ref-1' });
      if (url.includes('/beef/')) return json({ txid: 'x' });
      return json({}, 404);
    }) as typeof fetch;
    const calls: unknown[] = [];
    const wallet = {
      createAction: async (args: unknown) => {
        calls.push(args);
        return { txid: 'deadbeef' };
      },
    };
    return { calls, ctx: { wallet } as unknown as Parameters<typeof sendBsv.execute>[0] };
  };

  test('approved 1,000 sats, host returns 5,000,000 to another script: refused before createAction', async () => {
    const { calls, ctx } = setup([{ script: scriptB, satoshis: 5_000_000 }]);
    const res = await sendBsv.execute(ctx, { requests: [{ paymail: PAYMAIL, satoshis: 1000 }] });
    expect(calls).toHaveLength(0);
    expect(res.txid).toBeUndefined();
    expect(String(res.error)).toContain('Payment refused');
  });

  test('host returning the approved amount: createAction gets exactly that', async () => {
    const { calls, ctx } = setup([{ script: scriptA, satoshis: 1000 }]);
    const res = await sendBsv.execute(ctx, { requests: [{ paymail: PAYMAIL, satoshis: 1000 }] });
    expect(res.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    const outs = (calls[0] as { outputs: { satoshis: number }[] }).outputs;
    expect(outs.reduce((a, o) => a + o.satoshis, 0)).toBe(1000);
  });
});

describe('b_feedback 67: paymail scripts re-derived from the payee key before signing', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const payee = PrivateKey.fromRandom();
  const KEY = payee.toPublicKey().toString();
  const derived = (satoshis: number, key = KEY) => {
    const derivationPrefix = Utils.toBase64(Random(16));
    const derivationSuffix = Utils.toBase64(Random(16));
    const pub = new KeyDeriver(new PrivateKey(1)).derivePublicKey(
      [2, '3241645161d8'],
      `${derivationPrefix} ${derivationSuffix}`,
      key,
      false,
    );
    return { script: new P2PKH().lock(pub.toAddress()).toHex(), satoshis, derivationPrefix, derivationSuffix };
  };

  /** Our host (bwallet.space) serving pki `KEY`, the given p2p outputs, and recording BEEF deliveries. */
  const setup = (outputs: unknown[], domain = 'bwallet.space', ord?: Record<string, unknown>) => {
    const delivered: unknown[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes('dns.google')) return json({ Status: 3 });
      if (url.endsWith('/.well-known/bsvalias'))
        return json({
          capabilities: {
            pki: `https://${domain}/id/{alias}@{domain.tld}`,
            ...(ord ? { ordAddress: `https://${domain}/ord/{alias}@{domain.tld}` } : {}),
            '2a40af698840': `https://${domain}/p2p/{alias}@{domain.tld}`,
            '5c55a7fdb7bb': `https://${domain}/beef/{alias}@{domain.tld}`,
          },
        });
      if (url.includes('/id/')) return json({ pubkey: KEY });
      if (url.includes('/ord/')) return json(ord);
      if (url.includes('/p2p/')) return json({ outputs, reference: 'ref-1' });
      if (url.includes('/beef/')) return (delivered.push(JSON.parse(String(init?.body))), json({ txid: 'x' }));
      return json({}, 404);
    }) as typeof fetch;
    const calls: unknown[] = [];
    const wallet = {
      createAction: async (args: unknown) => {
        calls.push(args);
        return { txid: 'deadbeef' };
      },
    };
    return { calls, delivered, ctx: { wallet } as unknown as Parameters<typeof sendBsv.execute>[0] };
  };

  test('a correct derived script passes and pays exactly that script', async () => {
    const out = derived(1000);
    const { calls, ctx } = setup([out]);
    const res = await sendBsv.execute(ctx, { requests: [{ paymail: 'ann@bwallet.space', satoshis: 1000 }] });
    expect(res.error).toBeUndefined();
    expect(res.txid).toBe('deadbeef');
    const outs = (calls[0] as { outputs: { lockingScript: string; satoshis: number }[] }).outputs;
    expect(outs).toEqual([expect.objectContaining({ lockingScript: out.script, satoshis: 1000 })]);
  });

  test('a tampered script is refused before createAction', async () => {
    const out = { ...derived(1000), script: scriptB };
    const { calls, ctx } = setup([out]);
    const res = await sendBsv.execute(ctx, { requests: [{ paymail: 'ann@bwallet.space', satoshis: 1000 }] });
    expect(calls).toHaveLength(0);
    expect(String(res.error)).toContain("does not belong to the payee's key");
  });

  test('a script derived for another key is refused, even if the request names the key the user saw', async () => {
    const { calls, ctx } = setup([derived(1000, PrivateKey.fromRandom().toPublicKey().toString())]);
    const res = await sendBsv.execute(ctx, {
      requests: [{ paymail: 'ann@bwallet.space', satoshis: 1000, identityKey: KEY } as never],
    });
    expect(calls).toHaveLength(0);
    expect(String(res.error)).toContain('Payment refused');
  });

  test('our host without derivation is refused; a third-party host without it is paid, flagged unverified', async () => {
    const plain = { script: scriptA, satoshis: 1000 };
    let s = setup([plain]);
    let res = await sendBsv.execute(s.ctx, { requests: [{ paymail: 'ann@bwallet.space', satoshis: 1000 }] });
    expect(s.calls).toHaveLength(0);
    expect(String(res.error)).toContain('did not let us check');
    s = setup([plain], 'other.test');
    res = await sendBsv.execute(s.ctx, { requests: [{ paymail: 'ann@other.test', satoshis: 1000 }] });
    expect(res.error).toBeUndefined();
    expect(s.calls).toHaveLength(1);
    expect((res as { unverified?: string[] }).unverified).toEqual(['ann@other.test']);
  });

  test('ord_address: a proof that does not verify drops it and token sends are refused', async () => {
    const ord = PrivateKey.fromRandom().toAddress();
    const f = (u: string, i?: RequestInit) => fetch(u, i);
    const good = await signOrdProof(new ProtoWallet(payee), ord);
    setup([], 'bwallet.space', { address: ord, ordProof: good });
    let r = await resolvePaymail(f, 'ann@bwallet.space');
    expect(r.ordVerified).toBe(true);
    expect(destinationFor(r, 'token')).toEqual({ ok: true, to: ord });
    const forged = await signOrdProof(new ProtoWallet(PrivateKey.fromRandom()), ord);
    setup([], 'bwallet.space', { address: ord, ordProof: forged });
    r = await resolvePaymail(f, 'ann@bwallet.space');
    expect(r.ordAddress).toBeUndefined();
    expect(destinationFor(r, 'token')).toEqual({ ok: false, error: BAD_ORD_PROOF });
    setup([], 'bwallet.space', { address: ord });
    r = await resolvePaymail(f, 'ann@bwallet.space');
    expect(r.ordAddress).toBe(ord);
    expect(destinationCheck(r, 'token')).toBe('unverified');
  });
});
