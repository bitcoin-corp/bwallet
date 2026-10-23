import { describe, expect, test } from 'bun:test';
import { FOR_OTHERS_REASON, QUARANTINE_REASON, checkListable, custodyVerdict, isForOthersTag } from './custodyGuard';

const ID = 'a'.repeat(64) + '_0';

describe('custody guard', () => {
  test('tags that mean held for others', () => {
    expect(isForOthersTag('escrow')).toBe(true);
    expect(isForOthersTag('held-for:npg-claims')).toBe(true);
    expect(isForOthersTag('bsv21:' + ID)).toBe(false);
  });
  test('verdicts', () => {
    expect(custodyVerdict(ID, new Set(), [['bsv21:' + ID]])).toEqual({ ok: true });
    expect(custodyVerdict(ID, new Set([ID]), [])).toEqual({ ok: false, reason: QUARANTINE_REASON });
    expect(custodyVerdict(ID, new Set(), [['bsv21:x'], ['custody']])).toEqual({ ok: false, reason: FOR_OTHERS_REASON });
  });
  test('checkListable reads the bsv21 basket by token tag, and fails closed', async () => {
    let args: unknown;
    const wallet = {
      listOutputs: async (a: unknown) => {
        args = a;
        return { totalOutputs: 1, outputs: [{ outpoint: 'x.0', satoshis: 1, spendable: true, tags: ['escrow'] }] };
      },
    };
    expect((await checkListable(wallet as never, ID, new Set())).ok).toBe(false);
    expect((args as { basket: string; tags: string[] }).tags).toEqual(['bsv21:' + ID]);
    const broken = { listOutputs: async () => Promise.reject(new Error('x')) };
    expect((await checkListable(broken as never, ID, new Set())).ok).toBe(false);
  });
});
