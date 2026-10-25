import { beforeEach, describe, expect, test } from 'bun:test';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
const { getSub, makePot, monthlyUsd, moveSub, pauseAllSubs, resumeAllSubs, saveSub } = await import('./pots');
type Subscription = import('./pots').Subscription;

const sub = (p: Partial<Subscription> = {}): Subscription => ({
  id: 's1',
  potId: '1A',
  payee: { name: 'Alice', address: '1Alice' },
  amount: { value: 1, currency: 'USD' },
  period: 'month',
  start: Date.parse('2026-10-01T00:00:00Z'),
  maxCount: null,
  paidCount: 0,
  periodIndex: 0,
  nextDue: 0,
  status: 'active',
  mode: 'onOpen',
  ...p,
});

describe('Pots & Locks › Subscriptions', () => {
  beforeEach(() => mem.clear());

  test('dollars per month across live subscriptions only', () => {
    const subs = [
      sub(),
      sub({ id: 's2', amount: { value: 0.01, currency: 'USD' }, period: 'day' }),
      sub({ id: 's3', status: 'paused', amount: { value: 50, currency: 'USD' } }),
      sub({ id: 's4', amount: { value: 12, currency: 'USD' }, period: 'year' }),
    ];
    expect(monthlyUsd(subs, 50)).toBe(1 + 0.3 + 1);
  });

  test('move to another pot keeps the schedule; unknown pot is ignored', () => {
    makePot('1A', 'Fun');
    makePot('1B', 'Subscriptions');
    saveSub(sub({ periodIndex: 3 }));
    moveSub('s1', '1Nope');
    expect(getSub('s1')!.potId).toBe('1A');
    moveSub('s1', '1B');
    expect(getSub('s1')!.potId).toBe('1B');
    expect(getSub('s1')!.periodIndex).toBe(3);
  });

  test('pause all and resume all', () => {
    makePot('1A', 'Fun');
    saveSub(sub());
    saveSub(sub({ id: 's2', status: 'lowFunds' }));
    saveSub(sub({ id: 's3', status: 'cancelled' }));
    expect(pauseAllSubs()).toBe(2);
    expect(getSub('s1')!.status).toBe('paused');
    expect(getSub('s3')!.status).toBe('cancelled');
    expect(resumeAllSubs()).toBe(2);
    expect(getSub('s2')!.status).not.toBe('paused');
  });
});
