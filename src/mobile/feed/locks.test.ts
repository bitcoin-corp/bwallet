import { beforeEach, describe, expect, test } from 'bun:test';
import { __resetExchangeRateForTests } from '../../utils/exchangeRate';
import { Lock } from '@1sat/templates';
import { P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import {
  buildLockMapScript,
  decodeLockTx,
  formatLocked,
  lockCandidates,
  lockOutputs,
  rankByLocked,
  summarizeLocks,
  unlockDate,
  type PostLock,
} from './locks';
import { MAP_PREFIX } from './post';

const POST = 'ab'.repeat(32);
const address = PrivateKey.fromRandom().toAddress();
// Hodlocker / LooLock indexer's lockup prefix (jdh7190/loolock-indexer idxHelpers.js).
const HODLOCKER_PREFIX =
  '2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0262102ba79df5f8ae7604a9830f03c7933028186aede0675a16f025dc4f8be8eec0382201008ce7480da41702918d1ec8e6849ba32b4d65b1e40dc669c31a1e6306b266c';

const strings = (s: Script) => s.chunks.filter((c) => c.data).map((c) => Utils.toUTF8(c.data as number[]));

describe('lock script', () => {
  test('lock output is the Hodlocker lockup contract with pkh + height', () => {
    const { lock, until } = lockOutputs({ address, until: 900_123, satoshis: 1000, postTxid: POST, app: 'bWallet' });
    expect(until).toBe(900_123);
    expect(lock.toHex()).toContain(HODLOCKER_PREFIX);
    const d = Lock.decode(lock)!;
    expect(d.address).toBe(address);
    expect(d.until).toBe(900_123);
    // Hodlocker's parser: chunk 5 = pkh, chunk 6 = little-endian height.
    const pkh = Utils.toHex(Utils.fromBase58Check(address).data as number[]);
    expect(Utils.toHex(lock.chunks[5].data!)).toBe(pkh);
    const h = lock.chunks[6].data!;
    expect(h.reduce((n, b, i) => n + b * 256 ** i, 0)).toBe(900_123);
  });

  test('MAP is a like for the post with Hodlocker keys and no context', () => {
    const map = buildLockMapScript(POST, 'bWallet');
    const s = strings(map);
    expect(s).toEqual([MAP_PREFIX, 'SET', 'app', 'bWallet', 'type', 'like', 'tx', POST]);
    // LooLock getValue('tx') reads the item after the first "tx".
    expect(s[s.indexOf('tx') + 1]).toBe(POST);
  });

  test('rejects bad input', () => {
    expect(() => lockOutputs({ address, until: 0, satoshis: 1, postTxid: POST, app: 'x' })).toThrow();
    expect(() => lockOutputs({ address, until: 10, satoshis: 0, postTxid: POST, app: 'x' })).toThrow();
    expect(() => lockOutputs({ address, until: 10, satoshis: 1, postTxid: 'nope', app: 'x' })).toThrow();
  });

  test('decodeLockTx reads the lock output back', () => {
    const { lock, map } = lockOutputs({ address, until: 850_000, satoshis: 5000, postTxid: POST, app: 'bWallet' });
    const tx = new Transaction();
    tx.addOutput({ lockingScript: lock, satoshis: 5000 });
    tx.addOutput({ lockingScript: map, satoshis: 0 });
    tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 99 });
    const l = decodeLockTx(tx.toHex(), POST)!;
    expect(l).toMatchObject({ satoshis: 5000, until: 850_000, address, postTxid: POST, lockTxid: tx.id('hex') });
    expect(decodeLockTx('zz', POST)).toBeNull();
  });
});

const lk = (id: string, sats: number, until: number, addr = 'a', post = POST): PostLock => ({
  lockTxid: id,
  postTxid: post,
  satoshis: sats,
  until,
  address: addr,
});

describe('ranking', () => {
  test('summary counts active locks only, dedupes, counts lockers', () => {
    const s = summarizeLocks([lk('1', 100, 110), lk('1', 100, 110), lk('2', 50, 105, 'b'), lk('3', 999, 100)], 100);
    expect(s).toEqual({ total: 150, lockers: 2, score: 100 * 10 + 50 * 5 });
  });

  test('most locked weights amount by remaining blocks', () => {
    const posts = [
      { txid: 'big-short', at: 3 },
      { txid: 'small-long', at: 2 },
      { txid: 'none', at: 4 },
      { txid: 'none-old', at: 1 },
    ];
    const sums = {
      'big-short': summarizeLocks([lk('x', 1000, 101)], 100),
      'small-long': summarizeLocks([lk('y', 100, 200)], 100),
    };
    expect(rankByLocked(posts, sums).map((p) => p.txid)).toEqual(['small-long', 'big-short', 'none', 'none-old']);
  });
});

describe('helpers', () => {
  // formatLocked shows $ once a price is known; these cases are the no-price fallback, so pin "no price".
  beforeEach(() => __resetExchangeRateForTests({ storage: null }));
  test('formatLocked', () => {
    expect(formatLocked(100_000)).toBe('0.001 BSV');
    expect(formatLocked(10_000_000)).toBe('0.1 BSV');
    expect(formatLocked(250_000_000)).toBe('2.50 BSV');
    expect(formatLocked(500)).toBe('500 sats');
  });
  test('unlockDate is ~10 min per block', () => {
    expect(unlockDate(144, 0).getTime()).toBe(144 * 600_000);
  });
  test('lockCandidates keeps likes with a non-address output', () => {
    const body = {
      results: [
        { tx: { h: '11'.repeat(32) }, out: [{ xput: { e: { v: 0 } } }, { xput: { e: { v: 9, a: '1abc' } } }] },
        { tx: { h: '22'.repeat(32) }, out: [{ xput: { e: { v: 5000 } } }, { xput: { e: { v: 0 } } }] },
      ],
    };
    expect(lockCandidates(body)).toEqual(['22'.repeat(32)]);
    expect(lockCandidates(null)).toEqual([]);
  });
});
