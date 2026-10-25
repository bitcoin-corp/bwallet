import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FeaturePausedError,
  PAUSED_MESSAGE,
  STATUS_TTL,
  getPaused,
  guardSpending,
  parseStatus,
  resetKillSwitchCache,
} from './killSwitch';

const res = (body: unknown, ok = true) => Promise.resolve({ ok, json: async () => body } as Response);

describe('parseStatus', () => {
  test('plain names pause that feature', () => {
    expect([...parseStatus({ paused: ['spending'] }, '5.2.39')]).toEqual(['spending']);
  });
  test('versions limit an entry to those versions', () => {
    const raw = { paused: [{ feature: 'passkeyCreate', versions: ['5.2.38'] }] };
    expect(parseStatus(raw, '5.2.39').size).toBe(0);
    expect(parseStatus(raw, '5.2.38').has('passkeyCreate')).toBe(true);
  });
  test('an unknown running version matches (pause too much, not too little)', () => {
    expect(parseStatus({ paused: [{ feature: 'spending', versions: ['5.2.38'] }] }, null).has('spending')).toBe(true);
  });
  test('only listed features count; recovery can never be paused', () => {
    const raw = { paused: ['showSeed', 'restore', 'unlock', 'passkeyRestore', { feature: 'backup' }, 42, null] };
    expect(parseStatus(raw, '5.2.39').size).toBe(0);
  });
  test('junk gives nothing paused', () => {
    for (const raw of [null, 'x', {}, { paused: 'spending' }]) expect(parseStatus(raw, '5.2.39').size).toBe(0);
  });
});

describe('getPaused', () => {
  beforeEach(resetKillSwitchCache);
  test('fails open on a network error or a bad status', async () => {
    expect((await getPaused(() => Promise.reject(new Error('offline')), 1)).size).toBe(0);
    resetKillSwitchCache();
    expect((await getPaused(() => res({ paused: ['spending'] }, false), 1)).size).toBe(0);
  });
  test('caches for STATUS_TTL, then refetches', async () => {
    let calls = 0;
    const f = () => (calls++, res({ paused: ['spending'] }));
    expect((await getPaused(f, 1000)).has('spending')).toBe(true);
    await getPaused(f, 1000 + STATUS_TTL - 1);
    expect(calls).toBe(1);
    await getPaused(f, 1000 + STATUS_TTL);
    expect(calls).toBe(2);
  });
});

describe('guardSpending', () => {
  test('createAction and signAction refuse while paused; other methods still work', async () => {
    const wallet = {
      createAction: async () => 'created',
      signAction: async () => 'signed',
      listOutputs: async () => 'listed',
    };
    const g = guardSpending(wallet, async () => {
      throw new FeaturePausedError('spending');
    });
    await expect(g.createAction()).rejects.toThrow(PAUSED_MESSAGE);
    await expect(g.signAction()).rejects.toThrow(PAUSED_MESSAGE);
    expect(await g.listOutputs()).toBe('listed');
  });
  test('passes arguments and this through when not paused', async () => {
    const wallet = {
      tag: 'w',
      async createAction(this: { tag: string }, args: { n: number }, originator?: string) {
        return `${this.tag}:${args.n}:${originator}`;
      },
    };
    const g = guardSpending(wallet, async () => {});
    expect(await g.createAction({ n: 3 }, 'admin')).toBe('w:3:admin');
  });
  test('b-Aware 25 Oct: a tx-digest signature (hashToDirectlySign) is refused while paused; plain signing is not', async () => {
    let paused = false;
    const wallet = {
      createSignature: async (a: { hashToDirectlySign?: number[] }) => (a.hashToDirectlySign ? 'tx' : 'msg'),
    };
    const g = guardSpending(wallet, async () => {
      if (paused) throw new FeaturePausedError('spending');
    });
    expect(await g.createSignature({ hashToDirectlySign: [1] })).toBe('tx');
    paused = true; // switched on after the flow started
    await expect(g.createSignature({ hashToDirectlySign: [1] })).rejects.toThrow(PAUSED_MESSAGE);
    expect(await g.createSignature({})).toBe('msg'); // sign-in and message signatures are not payments
  });
});
