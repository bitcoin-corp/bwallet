import { describe, expect, test } from 'bun:test';
import {
  allowanceMustAsk,
  guardAllowance,
  markPayeeMismatch,
  parsePayees,
  payeesAllowed,
  perPaymentCapSats,
} from './allowanceGuard';

const A = '76a914' + 'aa'.repeat(20) + '88ac';
const B = '76a914' + 'bb'.repeat(20) + '88ac';

describe('per-payment cap (audit 24 Oct B2)', () => {
  test('default is a quarter of the month; an explicit cap wins', () => {
    expect(perPaymentCapSats({ expiry: 0, authorizedAmount: 100_000 })).toBe(25_000);
    expect(perPaymentCapSats({ expiry: 0, authorizedAmount: 100_000, perPaymentSats: 5_000 })).toBe(5_000);
  });
  test('only a live allowance and only over the cap', () => {
    const g = { expiry: 0, authorizedAmount: 100_000 };
    expect(allowanceMustAsk(g, 25_000)).toBe(false);
    expect(allowanceMustAsk(g, 25_001)).toBe(true);
    expect(allowanceMustAsk(null, 1e9)).toBe(false);
    expect(allowanceMustAsk({ expiry: 1, authorizedAmount: 100 }, 1e9)).toBe(false); // expired: manager asks anyway
  });
});

describe('payees', () => {
  test('parsePayees cleans and caps the list', () => {
    expect(parsePayees([A, A.toUpperCase(), 'nothex', 7])).toEqual([A]);
    expect(parsePayees('x')).toBeUndefined();
    expect(parsePayees([])).toBeUndefined();
  });
  test('payeesAllowed: no list = anything; with a list only listed paid outputs', () => {
    expect(payeesAllowed(undefined, [{ satoshis: 1, lockingScript: B }])).toBe(true);
    expect(payeesAllowed([A], [{ satoshis: 1, lockingScript: A }])).toBe(true);
    expect(payeesAllowed([A], [{ satoshis: 1, lockingScript: B }])).toBe(false);
    expect(payeesAllowed([A], [{ satoshis: 0, lockingScript: B }])).toBe(true);
  });
});

describe('guardAllowance', () => {
  const make = (grant: unknown) => {
    const calls: string[] = [];
    const m = {
      ensureSpendingAuthorization: async (a: { satoshis: number }) => (calls.push(`silent:${a.satoshis}`), true),
      requestPermissionFlow: async (r: { spending: { satoshis: number }; renewal: boolean }) => (
        calls.push(`ask:${r.spending.satoshis}:${r.renewal}`),
        true
      ),
    };
    guardAllowance(m, {
      store: { findGrant: async () => grant },
      adminOriginator: 'admin.local',
      normalize: (o) => o.toLowerCase(),
    });
    return { m, calls };
  };
  const allowance = { expiry: 0, authorizedAmount: 100_000 };

  test('within the cap: the manager decides as before', async () => {
    const { m, calls } = make(allowance);
    await m.ensureSpendingAuthorization({ originator: 'site.com', satoshis: 20_000 } as never);
    expect(calls).toEqual(['silent:20000']);
  });
  test('over the cap: asks, even though the month would cover it', async () => {
    const { m, calls } = make(allowance);
    await m.ensureSpendingAuthorization({ originator: 'site.com', satoshis: 90_000 } as never);
    expect(calls).toEqual(['ask:90000:false']);
  });
  test('over the cap with seekPermission=false: not covered', async () => {
    const { m } = make(allowance);
    await expect(
      m.ensureSpendingAuthorization({ originator: 'site.com', satoshis: 90_000, seekPermission: false } as never),
    ).rejects.toThrow('approval');
  });
  test('no allowance, or the wallet itself: untouched', async () => {
    const a = make(null);
    await a.m.ensureSpendingAuthorization({ originator: 'site.com', satoshis: 1e9 } as never);
    const b = make(allowance);
    await b.m.ensureSpendingAuthorization({ originator: 'admin.local', satoshis: 1e9 } as never);
    expect([...a.calls, ...b.calls]).toEqual(['silent:1000000000', 'silent:1000000000']);
  });
  test('a call marked as paying outside the payee list asks; the mark is released', async () => {
    const { m, calls } = make({ ...allowance, payees: [A] });
    const release = markPayeeMismatch('site.com');
    await m.ensureSpendingAuthorization({ originator: 'site.com', satoshis: 10 } as never);
    release();
    release(); // idempotent
    await m.ensureSpendingAuthorization({ originator: 'site.com', satoshis: 10 } as never);
    expect(calls).toEqual(['ask:10:false', 'silent:10']);
  });
});
