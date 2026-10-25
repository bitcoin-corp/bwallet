import { beforeEach, describe, expect, test } from 'bun:test';
import { LockingScript, PrivateKey, P2PKH, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { sendMail } from './client';
import {
  DEFAULT_MAX_BODY_BYTES,
  LetterTooLargeError,
  letterKey,
  loadPending,
  relayLimit,
  tscToMerklePath,
  trimPostageBeef,
} from './delivery';
import { friendlyMailError } from './friendlyError';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const ME = PrivateKey.fromRandom().toPublicKey().toString();
const TO = PrivateKey.fromRandom().toPublicKey().toString();

/** A chain grandparent → parent → child; `pad` bytes of OP_RETURN data make the grandparent big. */
const chain = (pad: number) => {
  const k = PrivateKey.fromRandom();
  const lock = new P2PKH().lock(k.toAddress());
  const gp = new Transaction();
  gp.addOutput({ lockingScript: lock, satoshis: 10_000 });
  gp.addOutput({
    lockingScript: new LockingScript([{ op: 0 }, { op: 0x6a }, { op: 0x4e, data: new Array(pad).fill(1) }]),
    satoshis: 0,
  });
  const parent = new Transaction();
  parent.addInput({ sourceTransaction: gp, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
  parent.addOutput({ lockingScript: lock, satoshis: 9_000 });
  const child = new Transaction();
  child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
  child.addOutput({ lockingScript: lock, satoshis: 8_000 });
  const sign = async () => {
    await parent.sign();
    await child.sign();
  };
  return { gp, parent, child, sign };
};

/** Make `t` look mined (a one-tx block proof). */
const mined = (t: Transaction) => {
  t.merklePath = tscToMerklePath(t.id('hex'), 0, [], 900_000);
};

type Call = string;
const fakeWallet = (beefHex: string, txid: string, calls: Call[], walletSends = true) =>
  ({
    getPublicKey: async (a: { identityKey?: boolean }) => ({
      publicKey: a.identityKey ? ME : PrivateKey.fromRandom().toPublicKey().toString(),
    }),
    encrypt: async () => ({ ciphertext: [1, 2, 3] }),
    createAction: async (a: { options?: { noSend?: boolean; sendWith?: string[] } }) => {
      if (a.options?.sendWith) {
        calls.push(`broadcast:${a.options.sendWith[0]}`);
        return { sendWithResults: [{ txid: a.options.sendWith[0], status: walletSends ? 'unproven' : 'failed' }] };
      }
      calls.push(a.options?.noSend ? 'sign:noSend' : 'sign:send');
      return { txid, tx: Utils.toArray(beefHex, 'hex') };
    },
    abortAction: async (a: { reference: string }) => {
      calls.push(`abort:${a.reference}`);
      return { aborted: true };
    },
  }) as unknown as WalletInterface;

const letter = {
  to: TO,
  toLabel: 'b',
  sealed: { subject: 'Agreement', body: 'Please sign' },
  sats: 500,
  replyPaidSats: 0,
};

beforeEach(() => mem.clear());

describe('postage BEEF trimming', () => {
  test('a mined parent replaces its ancestors with a proof', async () => {
    const { parent, child, sign } = chain(70_000);
    await sign();
    const big = Utils.toHex(child.toAtomicBEEF());
    expect(big.length).toBeGreaterThan(140_000);
    const pid = parent.id('hex');
    const small = await trimPostageBeef(big, async (id) => (id === pid ? tscToMerklePath(id, 0, [], 900_000) : null));
    expect(small.length).toBeLessThan(2_000);
    expect(Transaction.fromAtomicBEEF(Utils.toArray(small, 'hex')).id('hex')).toBe(child.id('hex'));
  });
  test('without proofs the BEEF is unchanged', async () => {
    const { gp, child, sign } = chain(10);
    mined(gp);
    await sign();
    const hex = Utils.toHex(child.toAtomicBEEF());
    expect(await trimPostageBeef(hex, async () => null)).toBe(hex);
  });
});

describe('relay preflight', () => {
  test('reads maxBodyBytes, falls back to the default', async () => {
    const ok = (async () => new Response(JSON.stringify({ maxBodyBytes: 32768 }))) as unknown as typeof fetch;
    expect(await relayLimit('https://a.example', ok)).toBe(32768);
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await relayLimit('https://b.example', down)).toBe(DEFAULT_MAX_BODY_BYTES);
  });
});

describe('sendMail: pay only after the relay accepts', () => {
  test('signs with noSend, delivers, then broadcasts; no pending left', async () => {
    const { gp, child, sign } = chain(10);
    mined(gp);
    await sign();
    const calls: Call[] = [];
    const w = fakeWallet(Utils.toHex(child.toAtomicBEEF()), child.id('hex'), calls);
    const sent = await sendMail(w, letter, {
      limit: DEFAULT_MAX_BODY_BYTES,
      fetchProof: null,
      deliver: async () => void calls.push('deliver'),
    });
    expect(calls).toEqual(['sign:noSend', 'deliver', `broadcast:${child.id('hex')}`]);
    expect(sent.txid).toBe(child.id('hex'));
    expect(loadPending(ME)).toEqual([]);
  });

  test('too large: never delivered or broadcast, stamp released, clear message', async () => {
    const { child, sign } = chain(70_000); // unconfirmed parent with a big ancestor, as in the Bureau test
    await sign();
    const calls: Call[] = [];
    const w = fakeWallet(Utils.toHex(child.toAtomicBEEF()), child.id('hex'), calls);
    const err = await sendMail(w, letter, {
      limit: DEFAULT_MAX_BODY_BYTES,
      fetchProof: null,
      deliver: async () => void calls.push('deliver'),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LetterTooLargeError);
    expect(friendlyMailError(err)).toMatch(/too large to send right now.*Nothing was charged/);
    expect(calls).toEqual(['sign:noSend', `abort:${child.id('hex')}`]);
    expect(loadPending(ME)).toEqual([]);
  });

  test('relay down: stamp kept, retry reuses the SAME stamp and id', async () => {
    const { gp, child, sign } = chain(10);
    mined(gp);
    await sign();
    const calls: Call[] = [];
    const w = fakeWallet(Utils.toHex(child.toAtomicBEEF()), child.id('hex'), calls);
    const bodies: string[] = [];
    await expect(
      sendMail(w, letter, {
        limit: DEFAULT_MAX_BODY_BYTES,
        fetchProof: null,
        deliver: async () => {
          throw new Error('Failed to send message.');
        },
      }),
    ).rejects.toThrow();
    const kept = loadPending<{ txid: string }>(ME);
    expect(kept).toHaveLength(1);
    expect(kept[0].key).toBe(letterKey(TO, 'Agreement', 'Please sign'));
    expect(kept[0].state).toBe('signed');
    const sent = await sendMail(
      w,
      { ...letter, sats: 510 },
      {
        limit: DEFAULT_MAX_BODY_BYTES,
        fetchProof: null,
        deliver: async (b) => void bodies.push(b),
      },
    );
    expect(calls.filter((c) => c.startsWith('sign'))).toEqual(['sign:noSend']); // paid once
    expect(calls).not.toContain(`abort:${child.id('hex')}`);
    expect(JSON.parse(bodies[0]).id).toBe(kept[0].id);
    expect(sent.txid).toBe(child.id('hex'));
    expect(loadPending(ME)).toEqual([]);
  });

  test('relay refusal (HTTP 413): stamp released, friendly copy', async () => {
    const { gp, child, sign } = chain(10);
    mined(gp);
    await sign();
    const calls: Call[] = [];
    const w = fakeWallet(Utils.toHex(child.toAtomicBEEF()), child.id('hex'), calls);
    const err = await sendMail(w, letter, {
      limit: DEFAULT_MAX_BODY_BYTES,
      fetchProof: null,
      deliver: async () => {
        throw new Error('Message Box send failed with HTTP 413 (ERR_MESSAGE_TOO_LARGE).');
      },
      unsent: { lookups: [async () => 'missing'], sleep: async () => {}, log: () => {} },
    }).catch((e) => e);
    expect(friendlyMailError(err)).toMatch(/too large to send/);
    expect(calls).toContain(`abort:${child.id('hex')}`);
    expect(calls.some((c) => c.startsWith('broadcast'))).toBe(false);
    expect(loadPending(ME)).toEqual([]);
  });

  test('relay refusal but the chain already has the stamp: kept, never aborted (unsentGuard)', async () => {
    const { gp, child, sign } = chain(10);
    mined(gp);
    await sign();
    const calls: Call[] = [];
    const w = fakeWallet(Utils.toHex(child.toAtomicBEEF()), child.id('hex'), calls);
    await sendMail(w, letter, {
      limit: DEFAULT_MAX_BODY_BYTES,
      fetchProof: null,
      deliver: async () => {
        throw new Error('Message Box send failed with HTTP 413 (ERR_MESSAGE_TOO_LARGE).');
      },
      unsent: {
        lookups: [async () => 'seen'],
        sleep: async () => {},
        log: () => {},
        settleDelaysMs: [],
        background: false,
      },
    }).catch((e) => e);
    expect(calls).not.toContain(`abort:${child.id('hex')}`);
  });

  test('wallet does not send it: the BEEF goes to ARC', async () => {
    const { gp, child, sign } = chain(10);
    mined(gp);
    await sign();
    const calls: Call[] = [];
    const w = fakeWallet(Utils.toHex(child.toAtomicBEEF()), child.id('hex'), calls, false);
    const arc: string[] = [];
    await sendMail(w, letter, {
      limit: DEFAULT_MAX_BODY_BYTES,
      fetchProof: null,
      deliver: async () => void calls.push('deliver'),
      broadcastFetch: (async (url: string) => {
        arc.push(url);
        return new Response(JSON.stringify({ txStatus: 'SEEN_ON_NETWORK' }));
      }) as unknown as typeof fetch,
    });
    expect(calls).toEqual(['sign:noSend', 'deliver', `broadcast:${child.id('hex')}`]);
    expect(arc).toEqual(['https://arc.gorillapool.io/v1/tx']);
  });
});
