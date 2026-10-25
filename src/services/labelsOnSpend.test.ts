import { describe, expect, test } from 'bun:test';
import { certainSpend, guardLabelsOnSpend, labelRunFor, takeLabelsForSheet } from './labelsOnSpend';

const ADMIN = 'admin.local';
const deps = { adminOriginator: ADMIN, normalize: (o: string) => o.toLowerCase() };

type Call = { kind: string; args: unknown };

/** A fake manager whose createAction runs the label checks then the spend check, as the toolbox does. */
const fakeManager = (opts: { granted?: string[]; sheet?: (site: string) => void } = {}) => {
  const calls: Call[] = [];
  const m = {
    config: { seekPermissionWhenApplyingActionLabels: true },
    async ensureLabelAccess(args: { originator?: string; label: string; usageType?: string }) {
      calls.push({ kind: 'labelSheet', args });
      return true;
    },
    async ensureSpendingAuthorization(args: { originator?: string; satoshis: number }) {
      calls.push({ kind: 'spend', args });
      opts.sheet?.(args.originator ?? '');
      return true;
    },
    async hasProtocolPermission(p: { protocolID: [number, string] }) {
      return (opts.granted ?? []).some((l) => p.protocolID[1] === `action label ${l}`);
    },
    async createAction(args: { labels?: string[]; outputs?: { satoshis: number }[] }, originator?: string) {
      for (const label of args.labels ?? [])
        await (this as typeof m).ensureLabelAccess({ originator, label, usageType: 'apply' });
      const sats = (args.outputs ?? []).reduce((s, o) => s + o.satoshis, 0);
      if (sats > 0) await (this as typeof m).ensureSpendingAuthorization({ originator, satoshis: sats });
      return { ok: true };
    },
  };
  return { m, calls };
};

describe('certainSpend', () => {
  test('wallet-funded payment is certain', () => {
    expect(certainSpend({ outputs: [{ satoshis: 100 }] })).toBe(true);
  });
  test('site inputs or zero outputs are not', () => {
    expect(certainSpend({ outputs: [{ satoshis: 100 }], inputs: [{}] })).toBe(false);
    expect(certainSpend({ outputs: [{ satoshis: 0 }] })).toBe(false);
    expect(certainSpend(undefined)).toBe(false);
  });
});

describe('guardLabelsOnSpend', () => {
  test('a new label shows on the spend sheet, not on its own sheet', async () => {
    let shown: string[] = [];
    const { m, calls } = fakeManager({ sheet: (site) => (shown = takeLabelsForSheet(site)) });
    guardLabelsOnSpend(m, deps);
    await m.createAction({ labels: ['tokenblaster'], outputs: [{ satoshis: 500 }] }, 'game.example');
    expect(shown).toEqual(['tokenblaster']);
    expect(calls.map((c) => c.kind)).toEqual(['spend']);
    expect(labelRunFor('game.example')).toBeUndefined();
  });

  test('no sheet opened for the spend: the label still asks on its own sheet', async () => {
    const { m, calls } = fakeManager(); // envelope answered the spend silently
    guardLabelsOnSpend(m, deps);
    await m.createAction({ labels: ['tokenblaster'], outputs: [{ satoshis: 500 }] }, 'game.example');
    expect(calls.map((c) => c.kind)).toEqual(['spend', 'labelSheet']);
  });

  test('already-granted label goes the normal way', async () => {
    const { m, calls } = fakeManager({ granted: ['tokenblaster'], sheet: (s) => takeLabelsForSheet(s) });
    guardLabelsOnSpend(m, deps);
    await m.createAction({ labels: ['tokenblaster'], outputs: [{ satoshis: 500 }] }, 'game.example');
    expect(calls.map((c) => c.kind)).toEqual(['labelSheet', 'spend']);
  });

  test('admin-only labels are never deferred', async () => {
    const { m, calls } = fakeManager({ sheet: (s) => takeLabelsForSheet(s) });
    guardLabelsOnSpend(m, deps);
    await m.createAction({ labels: ['admin originator x', 'p 1sat x'], outputs: [{ satoshis: 5 }] }, 'game.example');
    expect(calls.filter((c) => c.kind === 'labelSheet')).toHaveLength(2);
  });

  test('no payment: labels ask as before', async () => {
    const { m, calls } = fakeManager({ sheet: (s) => takeLabelsForSheet(s) });
    guardLabelsOnSpend(m, deps);
    await m.createAction({ labels: ['score'], outputs: [{ satoshis: 0 }] }, 'game.example');
    expect(calls.map((c) => c.kind)).toEqual(['labelSheet']);
  });

  test('the admin originator is untouched', async () => {
    const { m, calls } = fakeManager();
    guardLabelsOnSpend(m, deps);
    await m.createAction({ labels: ['x'], outputs: [{ satoshis: 5 }] }, ADMIN);
    expect(calls.map((c) => c.kind)).toEqual(['labelSheet', 'spend']);
  });

  test('a refused spend leaves no run behind', async () => {
    const { m } = fakeManager();
    m.ensureSpendingAuthorization = async () => {
      throw new Error('denied');
    };
    guardLabelsOnSpend(m, deps);
    await expect(m.createAction({ labels: ['x'], outputs: [{ satoshis: 5 }] }, 'game.example')).rejects.toThrow(
      'denied',
    );
    expect(labelRunFor('game.example')).toBeUndefined();
  });
});
