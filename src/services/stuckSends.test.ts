import { describe, expect, test } from 'bun:test';
import {
  GIVE_UP_MS,
  MIN_ATTEMPTS,
  releaseStuckSends,
  releasedMessage,
  stuckVerdict,
  type QueuedSend,
} from './stuckSends';

const T = (c: string) => c.repeat(64);
const NOW = 1_800_000_000_000;
const q = (over: Partial<QueuedSend> = {}): QueuedSend => ({
  transactionId: 1,
  txid: T('a'),
  createdAt: NOW - GIVE_UP_MS - 1,
  attempts: MIN_ATTEMPTS,
  description: 'Mint VexVoid Clip',
  ...over,
});

describe('stuckVerdict', () => {
  test('waits while young or barely tried', () => {
    expect(stuckVerdict({ createdAt: NOW - 60_000, attempts: 50 }, NOW)).toBe('wait');
    expect(stuckVerdict({ createdAt: NOW - GIVE_UP_MS * 3, attempts: MIN_ATTEMPTS - 1 }, NOW)).toBe('wait');
    expect(stuckVerdict({ createdAt: NaN, attempts: 99 }, NOW)).toBe('wait');
  });
  test('gives up when old and retried enough', () => {
    expect(stuckVerdict({ createdAt: NOW - GIVE_UP_MS, attempts: MIN_ATTEMPTS }, NOW)).toBe('give-up');
  });
});

describe('releaseStuckSends', () => {
  const run = (queued: QueuedSend[], known: (t: string) => Promise<boolean>) => {
    const cancelled: string[] = [];
    const p = releaseStuckSends({
      listQueued: async () => queued,
      knownOnChain: known,
      cancel: async (s) => void cancelled.push(s.txid),
      now: () => NOW,
      log: () => undefined,
    });
    return p.then((r) => ({ r, cancelled }));
  };

  test('cancels an old queued send the network has no copy of', async () => {
    const { r, cancelled } = await run([q()], async () => false);
    expect(cancelled).toEqual([T('a')]);
    expect(r.released.map((s) => s.txid)).toEqual([T('a')]);
  });

  test('never cancels one the network has (it landed, like 36582df1…)', async () => {
    const { r, cancelled } = await run([q()], async () => true);
    expect(cancelled).toEqual([]);
    expect(r.kept).toEqual([T('a')]);
  });

  test('fails closed when the chain check throws', async () => {
    const { cancelled } = await run([q()], async () => {
      throw new Error('offline');
    });
    expect(cancelled).toEqual([]);
  });

  test('leaves young sends and non-txids alone, without even checking the chain', async () => {
    let checks = 0;
    const { cancelled } = await run([q({ createdAt: NOW - 1000 }), q({ txid: 'ref-not-a-txid' })], async () => {
      checks++;
      return false;
    });
    expect(cancelled).toEqual([]);
    expect(checks).toBe(0);
  });

  test('a listing error is reported, not thrown', async () => {
    const r = await releaseStuckSends({
      listQueued: async () => {
        throw new Error('db closed');
      },
      knownOnChain: async () => false,
      cancel: async () => undefined,
    });
    expect(r.error).toBe('db closed');
  });

  test('one failing cancel does not stop the rest', async () => {
    const r = await releaseStuckSends({
      listQueued: async () => [q({ txid: T('b') }), q({ txid: T('c') })],
      knownOnChain: async () => false,
      cancel: async (s) => {
        if (s.txid === T('b')) throw new Error('locked');
      },
      now: () => NOW,
      log: () => undefined,
    });
    expect(r.released.map((s) => s.txid)).toEqual([T('c')]);
  });
});

test('releasedMessage is plain', () => {
  expect(releasedMessage([{ description: 'Mint clip' }])).toContain('"Mint clip" never reached the network');
  expect(releasedMessage([{}, {}])).toContain('2 payments');
});

describe('releaseStuckSends with a remote active store', () => {
  test('skips without reading, cancelling or reporting an error', async () => {
    let read = false;
    const r = await releaseStuckSends({
      listQueued: async () => {
        read = true;
        return [q()];
      },
      knownOnChain: async () => false,
      cancel: async () => {
        throw new Error('must not cancel');
      },
      available: () => false,
      now: () => NOW,
    });
    expect(read).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.skipped).toBeTruthy();
    expect(r.released).toEqual([]);
  });
});

import { resolveUnsent } from './stuckSends';

describe('resolveUnsent: send now or cancel one queued send by hand', () => {
  const TX = 'b6963e8c3bb87bf0609e607017748fe578ff3b3920811630fdb26d9897ec3a23';
  const q = { transactionId: 7, txid: TX, createdAt: 0, attempts: 0, description: 'bVideoX: 3 private video records' };
  const deps = (known: boolean | 'throw', cancelled: unknown[] = [], sent: number[] = []) => ({
    listQueued: async () => [q],
    knownOnChain: async () => {
      if (known === 'throw') throw new Error('woc down');
      return known;
    },
    cancel: async (s: unknown) => void cancelled.push(s),
    sendWaiting: async () => void sent.push(1),
  });
  test('cancel releases a send the network never got', async () => {
    const c: unknown[] = [];
    expect(await resolveUnsent(deps(false, c), TX, 'cancel')).toEqual({ ok: true, txid: TX, result: 'cancelled' });
    expect(c).toHaveLength(1);
  });
  test('cancel keeps a send the network has, or when the check fails', async () => {
    const c: unknown[] = [];
    expect((await resolveUnsent(deps(true, c), TX, 'cancel')).ok).toBe(false);
    expect((await resolveUnsent(deps('throw', c), TX, 'cancel')).ok).toBe(false);
    expect(c).toHaveLength(0);
  });
  test('send runs SendWaiting and reports', async () => {
    const s: number[] = [];
    expect(await resolveUnsent(deps(false, [], s), TX, 'send')).toEqual({ ok: true, txid: TX, result: 'still-queued' });
    expect(s).toHaveLength(1);
  });
  test('refuses a txid that is not queued', async () => {
    const r = await resolveUnsent(deps(false), 'a'.repeat(64), 'cancel');
    expect(r.ok).toBe(false);
  });
});
