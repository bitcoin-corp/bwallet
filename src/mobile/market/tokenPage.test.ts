import { describe, expect, test } from 'bun:test';
import { Transaction, LockingScript } from '@bsv/sdk';
import { standardCurve, curveHash } from '../../lib/curves';
import { curveMapScript } from '../curves/curveMap';
import {
  curveFromTx,
  dropSpent,
  listingSpendState,
  mapFields,
  nextAsk,
  parseHolderCount,
  parseTopHolders,
  spendStateOf,
  vsFloor,
} from './tokenPage';

describe('stale listings', () => {
  test('spendStateOf reads GorillaPool txo rows', () => {
    expect(spendStateOf({ spend: '' })).toBe('unspent');
    expect(spendStateOf({ spend: 'ab'.repeat(32) })).toBe('spent');
    expect(spendStateOf({})).toBe('unknown');
    expect(spendStateOf(null)).toBe('unknown');
  });
  test('listingSpendState: spent row, and failures are unknown (never block on the check itself)', async () => {
    const f = async () => ({ ok: true, status: 200, json: async () => ({ spend: 'x' }) });
    expect(await listingSpendState('a'.repeat(64) + '_7', f)).toBe('spent');
    const bad = async () => ({ ok: false, status: 500, json: async () => ({}) });
    expect(await listingSpendState('b'.repeat(64) + '_7', bad)).toBe('unknown');
  });
  test('dropSpent and nextAsk', () => {
    const asks = [
      { outpoint: 'a_0', buyable: true },
      { outpoint: 'b.0', buyable: false },
      { outpoint: 'c_0', buyable: true },
    ];
    expect(dropSpent(asks, new Set(['a_0'])).map((a) => a.outpoint)).toEqual(['b.0', 'c_0']);
    expect(nextAsk(asks, 'a.0')?.outpoint).toBe('c_0');
    expect(nextAsk([asks[0]], 'a_0')).toBeNull();
  });
});

describe('holders', () => {
  test('count from accounts; top holders sorted, junk dropped', () => {
    expect(parseHolderCount({ accounts: 46 })).toBe(46);
    expect(parseHolderCount({})).toBeNull();
    const top = parseTopHolders([
      { address: '1a', amt: '5' },
      { address: '1b', amt: '50' },
      { address: '', amt: '9' },
      { address: '1c', amt: 'x' },
    ]);
    expect(top.map((h) => h.address)).toEqual(['1b', '1a']);
    expect(parseTopHolders('nope')).toEqual([]);
  });
});

describe('launch curve from the deploy tx', () => {
  const c = standardCurve();
  test('round trip: the MAP output written at launch reads back verified', () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new LockingScript([]), satoshis: 1 });
    tx.addOutput({ lockingScript: curveMapScript(c), satoshis: 0 });
    const got = curveFromTx(tx);
    expect(got?.hash).toBe(curveHash(c));
    expect(got?.curve.floorUsd).toBe(c.floorUsd);
    expect(mapFields(curveMapScript(c))?.type).toBe('curve');
  });
  test('a tampered hash is not shown', () => {
    const s = curveMapScript(c);
    const tx = new Transaction();
    const asm = s
      .toASM()
      .replace(
        curveHash(c).length ? Buffer.from(curveHash(c)).toString('hex') : '',
        Buffer.from('0'.repeat(64)).toString('hex'),
      );
    tx.addOutput({ lockingScript: LockingScript.fromASM(asm), satoshis: 0 });
    expect(curveFromTx(tx)).toBeNull();
  });
  test('no curve output → null', () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new LockingScript([]), satoshis: 1 });
    expect(curveFromTx(tx)).toBeNull();
  });
});

test('vsFloor', () => {
  expect(vsFloor(0.03, 0.01)).toBeCloseTo(3);
  expect(vsFloor(null, 0.01)).toBeNull();
});
