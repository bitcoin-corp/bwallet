import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { P2PKH } from '@bsv/sdk';
import { keepGlobals } from '../../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

// Offline: no chain, no indexer, no broadcast. The wallet and the indexer are fakes.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

// Real mainnet tokens (GorillaPool /api/bsv20/id/<id> fundAddress == api.1sat.app status.fee_address).
const VESTTEST = 'd01f0e04974608b6845da541dbc9a40420ecaf1aa9e2f76b8543f685dc3494b4_0';
const VESTTEST_FUND = '1HejRXhp8J6MZLSzzP9N39KapqR42FVk1S';
const P2PEPE = '0ed3811d11dfb91827d3d5c9946a9ec186162ca0d327ca2fa5bd759c58ded6a3_1';
const P2PEPE_FUND = '1BFy5kxyLydSikv5gBiHd6EozNkfwVKJYJ';

const steps: string[] = [];
// Keep the real exports: bun module mocks are process-wide, and a partial mock left behind breaks later files that
// import other names from it.
const realMintTicket = { ...(await import('../../tickets/mintTicket')) };
mock.module('../../tickets/mintTicket', () => ({
  ...realMintTicket,
  deployBsv21: async () => (steps.push('deploy'), VESTTEST),
  chatClient: async () => {
    steps.push('room');
    throw new Error('no session');
  },
  openRoom: async () => null,
}));

const {
  deriveFeeAddress,
  fundIndexing,
  launchDepositSats,
  outputsLeft,
  topUpSats,
  FUNDING_HEADROOM_OUTPUTS,
  LAUNCH_INDEX_OUTPUTS,
} = await import('../../tokens/indexFund');
const { deployLaunch, payLaunchDeposit } = await import('./launchNet');
const { emptyLaunchForm, defaultLaunchOptions } = await import('./launch');

type Out = { lockingScript: string; satoshis: number };
const fakeCtx = (details: unknown, fail = false) => {
  const paid: Out[][] = [];
  const ctx = {
    wallet: {
      createAction: async (a: { outputs: Out[] }) => {
        steps.push('deposit');
        if (fail) throw new Error('Insufficient funds');
        paid.push(a.outputs);
        return { txid: 'e'.repeat(64) };
      },
      listActions: async () => ({ actions: [] }),
    },
    services: { bsv21: { getTokenDetails: async () => details } },
  } as unknown as OneSatContext;
  return { ctx, paid };
};
const status = (s: Record<string, unknown>) => ({ status: s });

beforeEach(() => {
  store.clear();
  steps.length = 0;
});

describe('fee address (derived from the token id)', () => {
  test('matches the indexer for real tokens', () => {
    expect(deriveFeeAddress(VESTTEST)).toBe(VESTTEST_FUND);
    expect(deriveFeeAddress(P2PEPE)).toBe(P2PEPE_FUND);
    expect(deriveFeeAddress(VESTTEST.replace('_', '.'))).toBe(VESTTEST_FUND);
  });
  test('depends on the deploy txid, so it cannot be paid inside the deploy', () => {
    const other = `${'0'.repeat(63)}1_0`;
    expect(deriveFeeAddress(other)).not.toBe(VESTTEST_FUND);
    expect(deriveFeeAddress(`${VESTTEST.slice(0, 64)}_1`)).not.toBe(VESTTEST_FUND);
  });
  test('malformed ids → null', () => {
    expect(deriveFeeAddress('nope')).toBeNull();
    expect(deriveFeeAddress('ab_0')).toBeNull();
  });
});

describe('deposit maths', () => {
  test('fresh token: min_funding + 10 outputs of headroom = 10,010,000 sats', () => {
    expect(launchDepositSats()).toBe(10_010_000);
    expect(launchDepositSats({ feePerOutput: 1000, minFunding: 10_000_000 })).toBe(10_010_000);
    expect(FUNDING_HEADROOM_OUTPUTS).toBe(10);
  });
  test('credits already paid count toward min_funding', () => {
    expect(launchDepositSats({ feePerOutput: 1000, minFunding: 10_000_000, credits: 134_000 })).toBe(9_876_000);
  });
  test('never less than the launch floor (deploy + vesting + first 100 transfers ≈ 250 outputs)', () => {
    expect(LAUNCH_INDEX_OUTPUTS).toBe(250);
    expect(launchDepositSats({ feePerOutput: 1000, minFunding: 1000 })).toBe(250_000);
    expect(launchDepositSats({ feePerOutput: 1000, minFunding: 10_000_000, credits: 20_000_000 })).toBe(250_000);
  });
  test('top-up: activating deposit when inactive, else 1,000 outputs', () => {
    const base = { feeAddress: VESTTEST_FUND, feePerOutput: 1000, minFunding: 10_000_000 };
    expect(topUpSats({ ...base, isActive: false, balance: 0 })).toBe(10_010_000);
    expect(topUpSats({ ...base, isActive: true, balance: 5_000_000, credits: 10_010_000 })).toBe(1_000_000);
  });
  test('outputs left', () => {
    expect(outputsLeft({ balance: 7000, feePerOutput: 1000 })).toBe(7);
    expect(outputsLeft({ balance: -37000, feePerOutput: 1000 })).toBe(0);
  });
});

describe('fundIndexing for a launch', () => {
  test('indexer silent: pays the approved sats to the derived address', async () => {
    const { ctx, paid } = fakeCtx({ message: 'token not found' });
    const r = await fundIndexing(ctx, VESTTEST, 'VESTTEST', { sats: 10_010_000, allowDerived: true, timeoutMs: 0 });
    expect(r.feeAddress).toBe(VESTTEST_FUND);
    expect(paid[0]).toEqual([
      expect.objectContaining({ lockingScript: new P2PKH().lock(VESTTEST_FUND).toHex(), satoshis: 10_010_000 }),
    ]);
  });
  test('refuses an indexer address that does not match the id', async () => {
    const { ctx, paid } = fakeCtx(status({ fee_address: P2PEPE_FUND, fee_per_output: 1000 }));
    await expect(fundIndexing(ctx, VESTTEST, 'VESTTEST', { sats: 10_010_000, allowDerived: true })).rejects.toThrow(
      /doesn't match/,
    );
    expect(paid).toHaveLength(0);
  });
});

describe('launch flow (one Allow)', () => {
  const form = { ...emptyLaunchForm(), name: 'Vest Test', ticker: 'VESTTEST', supply: '1000000' };
  test('deploy, then the deposit, then the room', async () => {
    const { ctx, paid } = fakeCtx(status({ fee_address: VESTTEST_FUND, fee_per_output: 1000 }));
    const r = await deployLaunch(ctx, form, defaultLaunchOptions(), {
      icon: null,
      launchFeeSats: 0,
      depositSats: 10_010_000,
    });
    expect(steps.slice(0, 3)).toEqual(['deploy', 'deposit', 'room']);
    expect(r.indexError).toBeNull();
    expect(paid[0][0].satoshis).toBe(10_010_000);
  });
  test('a failed deposit is reported (the launch still stands), and the retry pays once', async () => {
    const bad = fakeCtx(status({ fee_address: VESTTEST_FUND, fee_per_output: 1000 }), true);
    const r = await deployLaunch(bad.ctx, form, defaultLaunchOptions(), {
      icon: null,
      launchFeeSats: 0,
      depositSats: 10_010_000,
    });
    expect(r.launch.tokenId).toBe(VESTTEST);
    expect(r.indexError).toMatch(/Insufficient funds/);

    const good = fakeCtx(status({ fee_address: VESTTEST_FUND, fee_per_output: 1000 }));
    await payLaunchDeposit(good.ctx, VESTTEST, 'VESTTEST', 10_010_000);
    await payLaunchDeposit(good.ctx, VESTTEST, 'VESTTEST', 10_010_000);
    expect(good.paid).toHaveLength(1);
  });
});
