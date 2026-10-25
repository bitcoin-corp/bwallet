import { beforeEach, describe, expect, test } from 'bun:test';
import { BSV21, buildInscriptionScript } from '@1sat/templates';
import { KeyDeriver, P2PKH, PrivateKey, Transaction, type WalletProtocol } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const {
  TOKEN_LOCK_KEY_ID,
  loadTokenLocks,
  saveTokenLocks,
  reconcileTokenLocks,
  recordFromLockTx,
  splitOutpoint,
  tokenLockScript,
  tokenLocksScanned,
} = await import('./tokenLocks');
const { findTokenLocks } = await import('./tokenLockApi');
const { buildReceipt, receiptMap, receiptSvg } = await import('./receipt');
type TokenLockRecord = import('./tokenLocks').TokenLockRecord;

const P1SAT: WalletProtocol = [0, 'onesat'];
const TOKEN = 'a'.repeat(64) + '_0';
const UNTIL = 970_500;
const AMT = 1_250_000n;
const ACCOUNT = '1Account';
const [S1, S2, S3] = ['1', '2', '3'].map((c) => c.repeat(64));

const root = PrivateKey.fromRandom();
const lockKey = new KeyDeriver(root).derivePrivateKey(P1SAT, TOKEN_LOCK_KEY_ID, 'self');
const lockAddress = lockKey.toAddress();
const otherAddress = PrivateKey.fromRandom().toAddress();

const receiptScript = (label: string, address = lockAddress) => {
  const r = buildReceipt({
    mode: 'date',
    pieces: [{ height: UNTIL, sats: 1 }],
    lockAddress: address,
    identity: { handle: '$alice', address: '1Alice' },
    token: { id: TOKEN, amt: String(AMT), dec: 4, sym: 'VEX' },
    label,
  });
  return buildInscriptionScript(
    new P2PKH().lock(address),
    new TextEncoder().encode(receiptSvg(r)),
    'image/svg+xml',
    receiptMap(r),
  );
};

/** Lock at vout 0, token change at vout 1, optional receipt at vout 2 — the shape createTokenLock broadcasts. */
function lockTx(opts: { amt?: bigint; to?: string; receipt?: ReturnType<typeof receiptScript>; seed?: number } = {}) {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: (opts.seed ?? 0).toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(lockAddress),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: tokenLockScript(TOKEN, opts.amt ?? AMT, opts.to ?? lockAddress, UNTIL), satoshis: 1 });
  tx.addOutput({ lockingScript: BSV21.transfer(TOKEN, 5n).lock(new P2PKH().lock(lockAddress)), satoshis: 1 });
  if (opts.receipt) tx.addOutput({ lockingScript: opts.receipt, satoshis: 1 });
  return tx;
}

const rec = (o: Partial<TokenLockRecord> & { outpoint: string }): TokenLockRecord => ({
  tokenId: TOKEN,
  dec: 4,
  amt: String(AMT),
  until: UNTIL,
  label: 'Token lock',
  lockAddress,
  createdAt: '2026-10-01T00:00:00.000Z',
  receipt: false,
  ...o,
});

describe('recordFromLockTx (a lock read back from the chain)', () => {
  test('round-trips the builder: token, exact base-unit amount, height, outpoint', () => {
    const tx = lockTx();
    const r = recordFromLockTx(tx, 0, lockAddress, { sym: 'VEX', dec: 4, createdAt: '2026-10-21T00:00:00.000Z' });
    expect(r).toEqual({
      outpoint: `${tx.id('hex')}.0`,
      tokenId: TOKEN,
      sym: 'VEX',
      dec: 4,
      amt: '1250000',
      until: UNTIL,
      label: 'Token lock',
      lockAddress,
      createdAt: '2026-10-21T00:00:00.000Z',
      receipt: false,
    });
  });
  test('keeps a u64 amount exact (no float rounding)', () => {
    const max = 2n ** 64n - 1n;
    expect(recordFromLockTx(lockTx({ amt: max }), 0, lockAddress)?.amt).toBe(max.toString());
  });
  test('the receipt in the same transaction gives back the label, decimals and symbol', () => {
    const r = recordFromLockTx(lockTx({ receipt: receiptScript('Vesting') }), 0, lockAddress);
    expect(r).toMatchObject({ label: 'Vesting', dec: 4, sym: 'VEX', receipt: true });
  });
  test('indexer metadata wins over the receipt for decimals and symbol', () => {
    const r = recordFromLockTx(lockTx({ receipt: receiptScript('Vesting') }), 0, lockAddress, { sym: 'VEX2', dec: 8 });
    expect(r).toMatchObject({ sym: 'VEX2', dec: 8 });
  });
  test('ignores a receipt made for another lock address', () => {
    const r = recordFromLockTx(lockTx({ receipt: receiptScript('Theirs', otherAddress) }), 0, lockAddress);
    expect(r).toMatchObject({ label: 'Token lock', receipt: false, dec: 0 });
  });
  test('rejects a lock to another key, a plain token output and a missing output', () => {
    expect(recordFromLockTx(lockTx({ to: otherAddress }), 0, lockAddress)).toBeNull();
    expect(recordFromLockTx(lockTx(), 1, lockAddress)).toBeNull();
    expect(recordFromLockTx(lockTx(), 9, lockAddress)).toBeNull();
  });
});

describe('reconcileTokenLocks', () => {
  test('dedupes by outpoint and keeps the label this device chose', () => {
    const local = [rec({ outpoint: 'x.0', label: 'Vesting' })];
    const found = [rec({ outpoint: 'x.0' }), rec({ outpoint: 'y.0', createdAt: '2026-10-05T00:00:00.000Z' })];
    const out = reconcileTokenLocks(local, found);
    expect(out.map((r) => r.outpoint)).toEqual(['y.0', 'x.0']);
    expect(out.find((r) => r.outpoint === 'x.0')?.label).toBe('Vesting');
  });
  test('marks a record unlocked when the chain shows it spent', () => {
    const out = reconcileTokenLocks([rec({ outpoint: 'x.0' }), rec({ outpoint: 'z.0' })], [], {
      'x.0': S1,
      'z.0': null,
    });
    expect(out.find((r) => r.outpoint === 'x.0')?.unlockedTxid).toBe(S1);
    expect(out.find((r) => r.outpoint === 'z.0')?.unlockedTxid).toBeUndefined();
  });
  test('ignores a spend reply that is not a txid', () => {
    expect(reconcileTokenLocks([rec({ outpoint: 'x.0' })], [], { 'x.0': 'garbage' })[0].unlockedTxid).toBeUndefined();
  });
  test('a lock the chain shows unspent is unlockable again, even if this device noted an unlock', () => {
    const out = reconcileTokenLocks([rec({ outpoint: 'x.0', unlockedTxid: S2 })], [rec({ outpoint: 'x.0' })]);
    expect(out[0].unlockedTxid).toBeUndefined();
  });
  test('never overwrites an unlock the wallet already recorded', () => {
    const out = reconcileTokenLocks([rec({ outpoint: 'x.0', unlockedTxid: S2 })], [], { 'x.0': S3 });
    expect(out[0].unlockedTxid).toBe(S2);
  });
  test('splitOutpoint reads both separators', () => {
    const t = 'f'.repeat(64);
    expect(splitOutpoint(`${t}_3`)).toEqual({ txid: t, vout: 3 });
    expect(splitOutpoint(`${t}.0`)).toEqual({ txid: t, vout: 0 });
    expect(splitOutpoint('nope')).toBeNull();
  });
});

describe('findTokenLocks (the scan)', () => {
  type Fake = {
    sync?: 'done' | 'error' | 'cut';
    outs?: { outpoint: string }[] | Error;
    txs?: Transaction[];
    beefFails?: boolean;
    lookup?: { tokenId: string; token: { sym?: string; dec?: number } }[] | Error;
    spends?: (string | null)[] | Error;
  };
  const ctxWith = (f: Fake) =>
    ({
      chain: 'main',
      wallet: { getPublicKey: async () => ({ publicKey: lockKey.toPublicKey().toString() }) },
      services: {
        owner: {
          async *getTxos() {
            if (f.sync === 'error') yield { type: 'error', error: new Error('indexer down') };
            else if (f.sync !== 'cut') yield { type: 'done' };
          },
        },
        txo: {
          search: async () => {
            if (f.outs instanceof Error) throw f.outs;
            return f.outs ?? [];
          },
          getSpends: async (o: string[]) => {
            if (f.spends instanceof Error) throw f.spends;
            return f.spends ?? o.map(() => null);
          },
        },
        getBeefForTxid: async () => {
          if (f.beefFails) throw new Error('beef down');
          return { findTxid: (id: string) => ({ tx: (f.txs ?? []).find((t) => t.id('hex') === id) }) };
        },
        bsv21: {
          lookupTokens: async () => {
            if (f.lookup instanceof Error) throw f.lookup;
            return f.lookup ?? [];
          },
        },
      },
    }) as unknown as OneSatContext;

  beforeEach(() => store.clear());

  test('finds a lock from the seed alone and saves it (restored wallet, empty list)', async () => {
    const tx = lockTx({ receipt: receiptScript('Vesting') });
    const txid = tx.id('hex');
    const res = await findTokenLocks(
      ctxWith({ outs: [{ outpoint: `${txid}_0` }, { outpoint: `${txid}_1` }, { outpoint: `${txid}_2` }], txs: [tx] }),
      ACCOUNT,
    );
    expect(res).toMatchObject({ found: 1, added: 1 });
    expect(loadTokenLocks(ACCOUNT)).toEqual([
      expect.objectContaining({ outpoint: `${txid}.0`, label: 'Vesting', amt: '1250000' }),
    ]);
    expect(tokenLocksScanned(ACCOUNT)).toBe(true);
  });

  test('a second scan adds nothing and keeps local labels', async () => {
    const tx = lockTx({ seed: 1 });
    const txid = tx.id('hex');
    saveTokenLocks(ACCOUNT, [rec({ outpoint: `${txid}.0`, label: 'Mine' })]);
    const res = await findTokenLocks(ctxWith({ outs: [{ outpoint: `${txid}_0` }], txs: [tx] }), ACCOUNT);
    expect(res).toMatchObject({ found: 1, added: 0 });
    expect(loadTokenLocks(ACCOUNT)[0].label).toBe('Mine');
  });

  test('marks a stored lock unlocked when its output is spent on chain', async () => {
    saveTokenLocks(ACCOUNT, [rec({ outpoint: 'c'.repeat(64) + '.0' })]);
    await findTokenLocks(ctxWith({ outs: [], spends: [S1] }), ACCOUNT);
    expect(loadTokenLocks(ACCOUNT)[0].unlockedTxid).toBe(S1);
  });

  test('skips outputs that are not token locks to this wallet', async () => {
    const theirs = lockTx({ to: otherAddress, seed: 2 });
    const res = await findTokenLocks(
      ctxWith({ outs: [{ outpoint: `${theirs.id('hex')}_0` }], txs: [theirs] }),
      ACCOUNT,
    );
    expect(res.found).toBe(0);
    expect(loadTokenLocks(ACCOUNT)).toEqual([]);
  });

  test('the token lookup failing still saves the lock (decimals from the receipt)', async () => {
    const tx = lockTx({ receipt: receiptScript('Vesting'), seed: 3 });
    await findTokenLocks(
      ctxWith({ outs: [{ outpoint: `${tx.id('hex')}_0` }], txs: [tx], lookup: new Error('down') }),
      ACCOUNT,
    );
    expect(loadTokenLocks(ACCOUNT)[0]).toMatchObject({ dec: 4, sym: 'VEX' });
  });

  test("reads the indexer's string decimals, and ignores nonsense ones", async () => {
    const tx = lockTx({ seed: 4 });
    const outs = [{ outpoint: `${tx.id('hex')}_0` }];
    const lookup = (dec: unknown) => [{ tokenId: TOKEN, token: { sym: 'VEX', dec } }] as never;
    await findTokenLocks(ctxWith({ outs, txs: [tx], lookup: lookup('8') }), ACCOUNT);
    expect(loadTokenLocks(ACCOUNT)[0]).toMatchObject({ dec: 8, sym: 'VEX', amt: '1250000' });
    store.clear();
    await findTokenLocks(ctxWith({ outs, txs: [tx], lookup: lookup('99') }), ACCOUNT);
    expect(loadTokenLocks(ACCOUNT)[0].dec).toBe(0);
  });

  test('indexer failures throw and leave the stored list and the scanned flag alone', async () => {
    const kept = [rec({ outpoint: 'd'.repeat(64) + '.0', label: 'Keep' })];
    for (const f of [
      { sync: 'error' as const },
      { sync: 'cut' as const },
      { outs: new Error('search down') },
      { outs: [{ outpoint: 'e'.repeat(64) + '_0' }], beefFails: true },
    ]) {
      store.clear();
      saveTokenLocks(ACCOUNT, kept);
      await expect(findTokenLocks(ctxWith(f), ACCOUNT)).rejects.toThrow();
      expect(loadTokenLocks(ACCOUNT)).toEqual(kept);
      expect(tokenLocksScanned(ACCOUNT)).toBe(false);
    }
  });

  test('a spend lookup failure leaves records as they were', async () => {
    saveTokenLocks(ACCOUNT, [rec({ outpoint: 'f'.repeat(64) + '.0' })]);
    await findTokenLocks(ctxWith({ outs: [], spends: new Error('down') }), ACCOUNT);
    expect(loadTokenLocks(ACCOUNT)[0].unlockedTxid).toBeUndefined();
  });
});
