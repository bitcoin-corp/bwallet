import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  chainSaysUnknown,
  refusedBeforeBroadcast,
  releaseAfterHandoff,
  settleWhenSeen,
  type Sighting,
} from './unsentGuard';
import { releasePayment } from '../mobile/chat/roomSpend';
import { ThemeOrderError } from '../mobile/themeOrder/api';

/** tx 877d2505… (25 Oct 2026 16:17 UTC, block 972621): the theme purchase whose change the wallet lost. */
const TXID = '877d2505159194dcd7ea01ae8ee68bfb9740bd85335badd836671e1844ce4224';

const fakeWallet = () => {
  const aborted: string[] = [];
  const sent: string[][] = [];
  return {
    aborted,
    sent,
    abortAction: async (a: { reference: string }) => {
      aborted.push(a.reference);
      return { aborted: true };
    },
    createAction: async (a: { options: { sendWith: string[] } }) => {
      sent.push(a.options.sendWith);
      return { sendWithResults: a.options.sendWith.map((txid) => ({ txid, status: 'unproven' })) };
    },
  };
};

/** The chain right after a broadcast: nothing for the first `lag` lookups, then the tx. */
const laggingChain = (lag: number) => {
  let n = 0;
  return async (): Promise<Sighting> => (n++ < lag ? 'missing' : 'seen');
};
const quiet = { sleep: async () => {}, log: () => {} };

describe('the 16:17 scenario: the server broadcast, then answered with an error', () => {
  test("buy-claim 502 'broadcast_failed' after the network took it: no abort, change kept, then settled", async () => {
    const w = fakeWallet();
    const err = new ThemeOrderError('The network didn’t take the payment.', 'broadcast_failed', 502);
    const r = await releaseAfterHandoff(w, TXID, {
      ...quiet,
      notBroadcast: refusedBeforeBroadcast(err),
      lookups: [laggingChain(2)],
      settleDelaysMs: [1, 1, 1],
      background: false,
    });
    expect(r.kind).toBe('kept');
    expect(w.aborted).toEqual([]);
    expect(await r.settled).toBe('sent');
    expect(w.sent).toEqual([[TXID]]);
  });

  test('a 4xx answer while the chain is slow to show it: the retries see it, so no abort', async () => {
    const w = fakeWallet();
    const err = new ThemeOrderError('quote used', 'quote_used', 409);
    const r = await releaseAfterHandoff(w, TXID, {
      ...quiet,
      notBroadcast: refusedBeforeBroadcast(err),
      lookups: [laggingChain(3)], // the toolbox's single instant check would have said "not known"
      settleDelaysMs: [1],
      background: false,
    });
    expect(r).toMatchObject({ kind: 'kept', reason: 'chain-has-it-or-unclear' });
    expect(w.aborted).toEqual([]);
  });

  test('releasePayment (theme orders, room charges) with the 502 never calls abortAction', async () => {
    const w = fakeWallet();
    await releasePayment({ wallet: w } as never, TXID, new ThemeOrderError('x', 'broadcast_failed', 502), {
      ...quiet,
      lookups: [async () => 'missing'],
      settleDelaysMs: [],
      background: false,
    });
    expect(w.aborted).toEqual([]);
  });

  test('theme order client routes every failed claim through the guard', () => {
    const src = readFileSync('src/mobile/themeOrder/api.ts', 'utf8');
    expect(src).not.toContain("e.code === 'broadcast_failed')");
    expect(src.match(/releasePayment\(ctx, r\.txid, e\)/g)?.length).toBe(2);
  });
});

describe('releaseAfterHandoff', () => {
  test('aborts only on a refusal before broadcast AND a clean "missing" on every retry', async () => {
    const w = fakeWallet();
    const r = await releaseAfterHandoff(w, TXID, {
      ...quiet,
      notBroadcast: true,
      lookups: [async () => 'missing', async () => 'missing'],
    });
    expect(r.kind).toBe('aborted');
    expect(w.aborted).toEqual([TXID]);
  });

  test('network error / timeout (no HTTP status) is not "not broadcast"', async () => {
    expect(refusedBeforeBroadcast(new TypeError('Failed to fetch'))).toBe(false);
    expect(refusedBeforeBroadcast({ status: 500 })).toBe(false);
    expect(refusedBeforeBroadcast({ status: 502 })).toBe(false);
    expect(refusedBeforeBroadcast({ status: 402 })).toBe(true);
  });

  test('an unclear chain answer (rate limit, offline) keeps it', async () => {
    const w = fakeWallet();
    const r = await releaseAfterHandoff(w, TXID, {
      ...quiet,
      notBroadcast: true,
      lookups: [async () => 'missing', async () => 'unclear'],
      settleDelaysMs: [],
      background: false,
    });
    expect(r.kind).toBe('kept');
    expect(w.aborted).toEqual([]);
  });

  test('a throwing lookup counts as unclear', async () => {
    expect(
      await chainSaysUnknown(TXID, {
        ...quiet,
        lookups: [
          async () => {
            throw new Error('boom');
          },
        ],
      }),
    ).toBe(false);
  });

  test('the default retries span about 30 s', async () => {
    const waited: number[] = [];
    await chainSaysUnknown(TXID, { lookups: [async () => 'missing'], sleep: async (ms) => void waited.push(ms) });
    const total = waited.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(25_000);
    expect(total).toBeLessThanOrEqual(40_000);
  });

  test('never seen: left pending (nosend), never aborted', async () => {
    const w = fakeWallet();
    expect(await settleWhenSeen(w, TXID, { ...quiet, lookups: [async () => 'missing'], settleDelaysMs: [1, 1] })).toBe(
      'not-seen',
    );
    expect(w.aborted).toEqual([]);
    expect(w.sent).toEqual([]);
  });
});
