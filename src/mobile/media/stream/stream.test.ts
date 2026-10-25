import { describe, expect, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { MerklePath, P2PKH, PrivateKey, ProtoWallet, PublicKey, Signature, Transaction, Utils } from '@bsv/sdk';
import { StreamHttpError, type KeyResponse, type PayTo } from './api';
import { openSegment, unwrapKey } from './crypto';
import { segmentDue } from './engine';
import { PerSecondKeySource } from './keySource';
import { SessionPayer } from './payer';
import { deriveSessionKey, listSessions, recordSession, recoverSessions, STORE_KEY, sweepCoin } from './session';
import {
  buildSegmentTx,
  coinSats,
  estimateTotal,
  feeFor,
  SEGMENT_FEE,
  SEGMENT_TX_BYTES,
  sigMessage,
  signSegment,
  type Coin,
} from './tx';

const artist = PrivateKey.fromRandom();
const payTo = (segment: number): PayTo => ({
  segment,
  sats: 1,
  lockingScript: new P2PKH().lock(artist.toAddress()).toHex(),
  address: artist.toAddress(),
});

/** A confirmed-looking coin paying `sats` to `key` (a one-tx block proof, so BEEF is complete). */
const fund = (key: PrivateKey, sats: number): Coin => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: sats });
  tx.merklePath = new MerklePath(1, [[{ offset: 0, hash: tx.id('hex'), txid: true }]]);
  return { tx, vout: 0 };
};

class MemStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

/** ProtoWallet plus recorded internalizeAction calls. */
const mockWallet = (root = PrivateKey.fromRandom()) => {
  const pw = new ProtoWallet(root);
  const internalized: { tx: number[]; outputs: { paymentRemittance?: Record<string, string> }[] }[] = [];
  return {
    pw,
    internalized,
    createHmac: pw.createHmac.bind(pw),
    getPublicKey: pw.getPublicKey.bind(pw),
    createAction: async () => {
      throw new Error('not in test');
    },
    internalizeAction: async (a: (typeof internalized)[number]) => {
      internalized.push(a);
      return { accepted: true as const };
    },
  };
};

describe('tx builder', () => {
  test('fee is tx size × 100 sat/kB, rounded up', () => {
    expect(feeFor(226)).toBe(23);
    expect(feeFor(1000)).toBe(100);
    expect(SEGMENT_FEE).toBe(feeFor(SEGMENT_TX_BYTES));
    expect(estimateTotal(10)).toBe(10 * (1 + SEGMENT_FEE));
  });

  test('pays the server lockingScript, change back to the session key, within the size estimate', async () => {
    const key = PrivateKey.fromRandom();
    const coin = fund(key, 1000);
    const p = payTo(0);
    const next = await buildSegmentTx(key, coin, p.lockingScript, p.sats);
    const tx = next.tx;
    expect(tx.inputs.length).toBe(1);
    expect(tx.outputs[0].lockingScript.toHex()).toBe(p.lockingScript);
    expect(tx.outputs[0].satoshis).toBe(1);
    expect(tx.outputs[1].lockingScript.toHex()).toBe(new P2PKH().lock(key.toAddress()).toHex());
    expect(tx.outputs[1].satoshis).toBe(1000 - 1 - SEGMENT_FEE);
    expect(tx.toBinary().length).toBeLessThanOrEqual(SEGMENT_TX_BYTES);
    expect(await tx.verify('scripts only')).toBe(true);
  });

  test('chains unconfirmed change: each tx spends the previous change', async () => {
    const key = PrivateKey.fromRandom();
    let coin = fund(key, 500);
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      const prev = coin;
      coin = await buildSegmentTx(key, coin, payTo(n).lockingScript, 1);
      expect(coin.tx.inputs[0].sourceTXID ?? coin.tx.inputs[0].sourceTransaction?.id('hex')).toBe(prev.tx.id('hex'));
      expect(coin.tx.inputs[0].sourceOutputIndex).toBe(prev.vout);
      ids.push(coin.tx.id('hex'));
    }
    expect(new Set(ids).size).toBe(5);
    expect(coinSats(coin)).toBe(500 - 5 * (1 + SEGMENT_FEE));
  });

  test('refuses when the budget cannot cover sats + fee', async () => {
    const key = PrivateKey.fromRandom();
    await expect(buildSegmentTx(key, fund(key, SEGMENT_FEE + 1), payTo(0).lockingScript, 1)).rejects.toThrow(
      'Budget used up',
    );
  });
});

describe('sig message', () => {
  test('"<trackId>:<segment>:<txid>" signed by the session key, DER hex, verifiable like the server does', () => {
    const key = PrivateKey.fromRandom();
    const txid = 'ab'.repeat(32);
    expect(sigMessage('first-12-01', 7, txid)).toBe(`first-12-01:7:${txid}`);
    const sig = signSegment(key, 'first-12-01', 7, txid);
    expect(sig).toMatch(/^30[0-9a-f]+$/);
    const ok = PublicKey.fromString(key.toPublicKey().toString()).verify(
      Utils.toArray(`first-12-01:7:${txid}`, 'utf8'),
      Signature.fromDER(sig, 'hex'),
    );
    expect(ok).toBe(true);
  });
});

describe('payer state machine', () => {
  const okResponse = (n: number): KeyResponse => ({
    txid: 'x',
    wrappedKey: '',
    protocolID: [2, 'bmusic stream key'],
    keyID: `t.${n}`,
    serverIdentityKey: '',
    next: payTo(n + 1),
  });

  test('advances only on 200, stops on 502 with the real status, resyncs from the last accepted change', async () => {
    const key = PrivateKey.fromRandom();
    const coin = fund(key, 1000);
    const posted: { segment: number; rawTx: string }[] = [];
    let fail: StreamHttpError | Error | null = null;
    let payToCalls = 0;
    const payer = new SessionPayer({
      checkSpending: async () => {},
      key,
      coin,
      getPayTo: async (_t, n) => (payToCalls++, payTo(n)),
      post: async (b) => {
        posted.push(b);
        if (fail) throw fail;
        return okResponse(b.segment);
      },
    });
    await payer.pay('t', 0);
    const accepted = payer.lastAccepted;
    expect(payer.stats.payments).toBe(1);
    expect(payer.stats.artistSats).toBe(1);
    expect(payer.stats.feeSats).toBe(SEGMENT_FEE);

    // Prepaid one ahead: segment 1 uses the `next` payTo, no extra GET.
    fail = new StreamHttpError(502, '460 parent transaction not found');
    await expect(payer.pay('t', 1)).rejects.toThrow('460 parent transaction not found');
    expect(payToCalls).toBe(1);
    expect(payer.status).toBe('error');
    expect(payer.error).toContain('502');
    expect(payer.lastAccepted).toBe(accepted);
    expect(payer.sweepCandidates()).toEqual([accepted]);
    await expect(payer.pay('t', 1)).rejects.toThrow(); // stays stopped until resync

    payer.resync();
    fail = null;
    await payer.pay('t', 1);
    expect(payer.stats.payments).toBe(2);
    // The retried tx spends the same change the failed one tried to.
    const tried = Transaction.fromHex(posted[1].rawTx);
    const retried = Transaction.fromHex(posted[2].rawTx);
    expect(retried.inputs[0].sourceTXID).toBe(tried.inputs[0].sourceTXID);
    expect(retried.inputs[0].sourceTXID).toBe(accepted.tx.id('hex'));
  });

  test('b-Aware 25 Oct: paused mid-session, the next segment is never signed or sent', async () => {
    const key = PrivateKey.fromRandom();
    let paused = false;
    const posted: unknown[] = [];
    const payer = new SessionPayer({
      checkSpending: async () => {
        if (paused) throw new Error('Paused for a fix');
      },
      key,
      coin: fund(key, 1000),
      getPayTo: async (_t, n) => payTo(n),
      post: async (b) => (posted.push(b), okResponse(b.segment)),
    });
    await payer.pay('t', 0);
    paused = true;
    await expect(payer.pay('t', 1)).rejects.toThrow('Paused');
    expect(posted).toHaveLength(1);
  });

  test('a network failure keeps the maybe-broadcast tx as the first sweep candidate', async () => {
    const key = PrivateKey.fromRandom();
    const payer = new SessionPayer({
      checkSpending: async () => {},
      key,
      coin: fund(key, 1000),
      getPayTo: async (_t, n) => payTo(n),
      post: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(payer.pay('t', 0)).rejects.toThrow('Failed to fetch');
    const c = payer.sweepCandidates();
    expect(c.length).toBe(2);
    expect(c[1]).toBe(payer.lastAccepted);
  });

  test('budget used up → out', async () => {
    const key = PrivateKey.fromRandom();
    const payer = new SessionPayer({
      checkSpending: async () => {},
      key,
      coin: fund(key, SEGMENT_FEE + 1),
      getPayTo: async (_t, n) => payTo(n),
      post: async (b) => okResponse(b.segment),
    });
    await expect(payer.pay('t', 0)).rejects.toThrow('Budget used up');
    expect(payer.status).toBe('out');
  });

  test('pays only within 2 segments of the playhead (pause = no payments)', () => {
    expect(segmentDue(0, 0, 1)).toBe(true);
    expect(segmentDue(2, 0, 1)).toBe(true);
    expect(segmentDue(3, 0, 1)).toBe(false);
    expect(segmentDue(3, 1.2, 1)).toBe(true);
  });
});

describe('session key, sweep and recovery', () => {
  test('the session key is deterministic from the wallet and the session id', async () => {
    const w = mockWallet();
    const a = await deriveSessionKey(w, 'abc');
    const b = await deriveSessionKey(w, 'abc');
    const c = await deriveSessionKey(w, 'abd');
    expect(a.toHex()).toBe(b.toHex());
    expect(a.toHex()).not.toBe(c.toHex());
  });

  test('sweep is a BRC-29 wallet payment the wallet can derive', async () => {
    const w = mockWallet();
    const key = await deriveSessionKey(w, 's1');
    const sats = await sweepCoin(w, key, fund(key, 300));
    expect(sats).toBeGreaterThan(250);
    const call = w.internalized[0];
    const r = call.outputs[0].paymentRemittance!;
    expect(r.senderIdentityKey).toBe(key.toPublicKey().toString());
    const tx = Transaction.fromAtomicBEEF(call.tx);
    const { publicKey } = await w.pw.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${r.derivationPrefix} ${r.derivationSuffix}`,
      counterparty: r.senderIdentityKey,
      forSelf: true,
    });
    expect(tx.outputs[0].lockingScript.toHex()).toBe(
      new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex(),
    );
  });

  test('a stored session id is enough to recover and sweep after the page died', async () => {
    const w = mockWallet();
    const store = new MemStore();
    const me = (await w.getPublicKey({ identityKey: true })).publicKey;
    const key = await deriveSessionKey(w, 'dead');
    recordSession({ id: 'dead', identityKey: me, fundingTxid: 'f', createdAt: 0 }, store);
    recordSession({ id: 'other', identityKey: '02' + '11'.repeat(32), fundingTxid: 'g', createdAt: 0 }, store);
    expect(store.getItem(STORE_KEY)).not.toContain(key.toHex()); // no private keys in storage
    const r = await recoverSessions(w, {
      store,
      findCoins: async (addr) => (addr === key.toAddress() ? [fund(key, 400)] : []),
      active: new Set(),
    });
    expect(r.swept).toBe(1);
    expect(r.sats).toBeGreaterThan(350);
    expect(listSessions(store).map((s) => s.id)).toEqual(['other']); // another account's record is left alone
  });

  test('an empty fresh session is kept (indexer lag), an old one is dropped', async () => {
    const w = mockWallet();
    const store = new MemStore();
    const me = (await w.getPublicKey({ identityKey: true })).publicKey;
    recordSession({ id: 'fresh', identityKey: me, fundingTxid: null, createdAt: 1_000_000 }, store);
    recordSession({ id: 'old', identityKey: me, fundingTxid: null, createdAt: 0 }, store);
    await recoverSessions(w, { store, findCoins: async () => [], now: 1_000_000 + 1000, active: new Set() });
    expect(listSessions(store).map((s) => s.id)).toEqual(['fresh']);
  });
});

describe('segment decrypt', () => {
  const seal = (key: Uint8Array, plain: Buffer) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct]));
  };

  test('iv12|tag16|ct round trip with a test key, and a wrong key fails', async () => {
    const key = new Uint8Array(randomBytes(32));
    const plain = Buffer.from('moof mdat 1-second AAC segment');
    expect(Buffer.from(await openSegment(key, seal(key, plain))).toString()).toBe(plain.toString());
    await expect(openSegment(new Uint8Array(32), seal(key, plain))).rejects.toThrow();
  });

  test('key wrapped by the server (BRC-2) unwraps with the session key, and the key source decrypts', async () => {
    const server = new ProtoWallet(PrivateKey.fromRandom());
    const serverIdentityKey = (await server.getPublicKey({ identityKey: true })).publicKey;
    const session = PrivateKey.fromRandom();
    const segKey = Array.from(randomBytes(32));
    const { ciphertext } = await server.encrypt({
      plaintext: segKey,
      protocolID: [2, 'bmusic stream key'],
      keyID: 'first-12-01.3',
      counterparty: session.toPublicKey().toString(),
    });
    const wrapped = Utils.toBase64(ciphertext);
    const got = await unwrapKey(session, wrapped, [2, 'bmusic stream key'], 'first-12-01.3', serverIdentityKey);
    expect(Array.from(got)).toEqual(segKey);

    const payer = new SessionPayer({
      checkSpending: async () => {},
      key: session,
      coin: fund(session, 1000),
      getPayTo: async (_t, n) => payTo(n),
      post: async () => ({
        txid: 'x',
        wrappedKey: wrapped,
        protocolID: [2, 'bmusic stream key'],
        keyID: 'first-12-01.3',
        serverIdentityKey,
        next: null,
      }),
    });
    const ks = new PerSecondKeySource(payer, session);
    expect(ks.kind).toBe('perSecond');
    expect(Array.from(await ks.segmentKey('first-12-01', 3))).toEqual(segKey);
  });
});
