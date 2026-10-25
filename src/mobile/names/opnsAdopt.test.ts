import { describe, expect, test } from 'bun:test';
import { Beef, LockingScript, Transaction, type InternalizeActionArgs, type WalletOutput } from '@bsv/sdk';
import { OPNS_BASKET, ORDINALS_BASKET } from '@1sat/types';
import { adoptOpnsNft, findOrdinalRow, withName } from './opnsAdopt';
import { opnsNameOf } from './opnsName';

const tx = new Transaction();
tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('76a914' + '11'.repeat(20) + '88ac') });
const txid = tx.id('hex');
const beef = new Beef();
beef.mergeTransaction(tx);
const BEEF = beef.toBinary();
const CI = JSON.stringify({ protocolID: [1, '1sat'], keyID: 'k', counterparty: 'abc' });

const fakeWallet = (opts: { failOpns?: boolean } = {}) => {
  type Call =
    | { method: 'listOutputs'; args: { include?: string } }
    | { method: 'relinquishOutput'; args: { basket: string; output: string } }
    | { method: 'internalizeAction'; args: InternalizeActionArgs };
  const calls: Call[] = [];
  const row = {
    outpoint: `${txid}.0`,
    satoshis: 1,
    spendable: true,
    tags: [`id:${txid}_0`, 'bmail'],
    customInstructions: CI,
  };
  const w = {
    calls,
    listOutputs: async (args: { include?: string }) => {
      calls.push({ method: 'listOutputs', args });
      return { totalOutputs: 1, outputs: [row], ...(args.include ? { BEEF } : {}) };
    },
    relinquishOutput: async (args: { basket: string; output: string }) => {
      calls.push({ method: 'relinquishOutput', args });
      return { relinquished: true as const };
    },
    internalizeAction: async (args: InternalizeActionArgs) => {
      calls.push({ method: 'internalizeAction', args });
      if (opts.failOpns && args.outputs[0].insertionRemittance?.basket === OPNS_BASKET) throw new Error('nope');
      return { accepted: true as const };
    },
  };
  return w;
};
type W = Parameters<typeof adoptOpnsNft>[0];
const rem = (c: Call) => (c.args as InternalizeActionArgs).outputs[0].insertionRemittance!;

describe('add a gifted name to Names', () => {
  test('withName keeps the spend details and adds the name', () => {
    expect(JSON.parse(withName(CI, 'a47'))).toEqual({ ...JSON.parse(CI), name: 'a47' });
    expect(() => withName('not json', 'a47')).toThrow();
  });

  test('finds the row by either outpoint spelling', () => {
    const rows = [{ outpoint: `${txid}.0` }] as WalletOutput[];
    expect(findOrdinalRow(rows, `${txid}_0`)).toBe(rows[0]);
    expect(findOrdinalRow(rows, `${txid}.1`)).toBeNull();
  });

  test('moves the row: relinquish from NFTs, merge into Names, no transaction', async () => {
    const w = fakeWallet();
    const r = await adoptOpnsNft(w as unknown as W, `${txid}_0`, 'a47');
    expect(r).toEqual({ id: `${txid}_0` });
    expect(w.calls.find((c) => c.method === 'relinquishOutput')?.args).toEqual({
      basket: ORDINALS_BASKET,
      output: `${txid}.0`,
    });
    const ins = w.calls.filter((c) => c.method === 'internalizeAction');
    expect(ins.length).toBe(1);
    const r0 = rem(ins[0]);
    expect(r0.basket).toBe(OPNS_BASKET);
    expect(JSON.parse(r0.customInstructions!).keyID).toBe('k');
    expect(opnsNameOf({ tags: [], customInstructions: r0.customInstructions })).toBe('a47');
    expect(w.calls.map((c) => c.method)).not.toContain('createAction');
  });

  test('puts it back with the NFTs when the move fails', async () => {
    const w = fakeWallet({ failOpns: true });
    const r = await adoptOpnsNft(w as unknown as W, `${txid}.0`, 'a47');
    expect('error' in r).toBe(true);
    const ins = w.calls.filter((c) => c.method === 'internalizeAction');
    expect(ins.map((c) => rem(c).basket)).toEqual([OPNS_BASKET, ORDINALS_BASKET]);
    expect(rem(ins[1]).customInstructions).toBe(CI);
  });

  test('refuses a bad outpoint', async () => {
    expect('error' in (await adoptOpnsNft(fakeWallet() as unknown as W, 'xyz', 'a47'))).toBe(true);
  });
});

describe('opnsNameOf', () => {
  test('tag first, then custom instructions', () => {
    expect(opnsNameOf({ tags: ['name:bob'], customInstructions: '{"name":"x"}' })).toBe('bob');
    expect(opnsNameOf({ tags: [], customInstructions: '{"name":"x"}' })).toBe('x');
    expect(opnsNameOf({ tags: [], customInstructions: 'garbage' })).toBeUndefined();
  });
});
