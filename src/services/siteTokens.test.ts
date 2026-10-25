/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles return loosely typed wallet results */
import { describe, expect, test } from 'bun:test';
import {
  LockingScript,
  UnlockingScript,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  Utils,
} from '@bsv/sdk';
import { ONESAT, bsv21, noteFor } from '../mobile/market/launchpad/tokens';
import { guardReservedBaskets, RESERVED_BASKET_REFUSAL } from './reservedBaskets';
import { guardReservedProtocols, RESERVED_REFUSAL } from './reservedProtocols';
import {
  BAD_DELIVERY_REFUSAL,
  RECEIVE_ONLY_REFUSAL,
  SELL_REJECTED,
  SITE_SPENDS_REFUSAL,
  SITE_TOKEN_RECEIVE,
  _ticketsFor,
  guardSiteTokens,
  parseReceiveKeyID,
  readTokenTransfer,
} from './siteTokens';

const ADMIN = 'admin.bwalletx';
const SITE = 'www.tokenblaster.lol';
const EVIL = 'evil.example';
const TOKEN = `${'ab'.repeat(32)}_0`;
const OTHER_TOKEN = `${'cd'.repeat(32)}_1`;

/**
 * A fake permissions manager over a real key deriver: getPublicKey/createSignature derive real keys, createAction
 * asks ensureBasketAccess for every basketed output (like the toolbox) and returns a signable tx whose token inputs
 * come from listOutputs, signAction records the spends it was given.
 */
const setup = (opts: { approve?: boolean } = {}) => {
  const proto = new ProtoWallet(PrivateKey.fromRandom());
  const calls: string[] = [];
  const signed: Record<number, unknown>[] = [];
  const prompts: unknown[] = [];
  const held: { outpoint: string; customInstructions: string; tags: string[]; tx: Transaction }[] = [];
  const pendingTx = new Map<string, Transaction>();
  let refs = 0;
  const m: Record<string, unknown> = {
    async getPublicKey(a: never, o?: string) {
      calls.push(`getPublicKey:${o}`);
      return proto.getPublicKey(a);
    },
    async createSignature(a: never, o?: string) {
      calls.push(`createSignature:${o}`);
      return proto.createSignature(a);
    },
    async encrypt() {
      return { ciphertext: [] };
    },
    async ensureBasketAccess(a: { basket: string }) {
      calls.push(`grant-prompt:${a.basket}`);
      return true;
    },
    async listOutputs(a: { basket: string }, o?: string) {
      calls.push(`listOutputs:${a.basket}:${o}`);
      return { outputs: a.basket === 'bsv21' ? held.map((h) => ({ ...h, spendable: true })) : [] };
    },
    async relinquishOutput(a: { basket: string }, o?: string) {
      calls.push(`relinquish:${a.basket}:${o}`);
      return { relinquished: true };
    },
    async createAction(
      a: { inputs?: { outpoint: string }[]; outputs?: { basket?: string; lockingScript: string; satoshis: number }[] },
      o?: string,
    ) {
      for (const out of a.outputs ?? [])
        if (out.basket)
          await (m.ensureBasketAccess as (x: unknown) => Promise<boolean>)({
            originator: o,
            basket: out.basket,
            usageType: 'insertion',
          });
      calls.push(`createAction:${o}`);
      const tx = new Transaction();
      for (const i of a.inputs ?? []) {
        const h = held.find((x) => x.outpoint === i.outpoint);
        const src = h?.tx ?? fakeSource();
        tx.addInput({
          sourceTransaction: src,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript(),
        });
      }
      for (const out of a.outputs ?? [])
        tx.addOutput({ lockingScript: Script(out.lockingScript), satoshis: out.satoshis });
      const reference = `ref${++refs}`;
      pendingTx.set(reference, tx);
      (m as { lastArgs?: unknown }).lastArgs = a;
      return { signableTransaction: { reference, tx: tx.toAtomicBEEF() } };
    },
    async signAction(a: { reference: string; spends: Record<number, unknown> }, o?: string) {
      calls.push(`signAction:${o}`);
      signed.push(a.spends);
      return { txid: pendingTx.get(a.reference)?.id('hex') };
    },
    async abortAction() {
      calls.push('abort');
      return { aborted: true };
    },
    async internalizeAction(a: { outputs: { insertionRemittance?: { basket: string } }[] }, o?: string) {
      for (const out of a.outputs)
        if (out.insertionRemittance)
          await (m.ensureBasketAccess as (x: unknown) => Promise<boolean>)({
            originator: o,
            basket: out.insertionRemittance.basket,
            usageType: 'insertion',
          });
      (m as { lastArgs?: unknown }).lastArgs = a;
      calls.push(`internalize:${o}`);
      return { accepted: true };
    },
  };
  const wallet = guardSiteTokens(guardReservedBaskets(guardReservedProtocols(m, ADMIN), ADMIN), {
    adminOriginator: ADMIN,
    normalize: (o) => o,
    prompt: async (r) => {
      prompts.push(r);
      return opts.approve ?? true;
    },
  }) as Record<string, (a: unknown, o?: string) => Promise<any>>;
  /** A coin the wallet holds, written the way its own trades write one. */
  const hold = async (id: string, amt: bigint, keyID = `${id}-1761400000000`) => {
    const { publicKey } = await proto.getPublicKey({ protocolID: ONESAT, keyID, counterparty: 'self' });
    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: fakeSource(),
      sourceOutputIndex: 0,
      sequence: 0xffffffff,
      unlockingScript: new UnlockingScript(),
    });
    tx.addOutput({ lockingScript: bsv21(id, amt, PublicKey.fromString(publicKey).toAddress()), satoshis: 1 });
    const outpoint = `${tx.id('hex')}.0`;
    held.push({ outpoint, customInstructions: noteFor(id, amt, 'TN', 0, keyID), tags: [`bsv21:${id}`], tx });
    return { outpoint, keyID, publicKey };
  };
  return { wallet, calls, signed, prompts, hold, proto, last: () => (m as { lastArgs?: any }).lastArgs };
};

const Script = (hex: string) => LockingScript.fromHex(hex);
let srcN = 0;
const fakeSource = () => {
  const t = new Transaction();
  t.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1000 + srcN++ });
  return t;
};

const receive = (wallet: Record<string, (a: unknown, o?: string) => Promise<any>>, origin = SITE, keyID = TOKEN) =>
  wallet.getPublicKey({ protocolID: SITE_TOKEN_RECEIVE, keyID, counterparty: 'self' }, origin);

describe('site tokens: receive keys', () => {
  test('a site gets a fresh wallet token key it did not choose, with its keyID', async () => {
    const { wallet, proto } = setup();
    const a = await receive(wallet);
    const b = await receive(wallet);
    expect(a.publicKey).not.toBe(b.publicKey);
    const parsed = parseReceiveKeyID(a.keyID);
    expect(parsed?.tokenId).toBe(TOKEN);
    // It is exactly the wallet's own onesat key for that keyID (so Send and the recovery scan see the coin).
    const own = await proto.getPublicKey({ protocolID: ONESAT, keyID: a.keyID, counterparty: 'self' });
    expect(own.publicKey).toBe(a.publicKey);
  });

  test('keyID must be a token id; counterparty must be self', async () => {
    const { wallet } = setup();
    await expect(receive(wallet, SITE, 'funds')).rejects.toThrow('token id');
    await expect(
      wallet.getPublicKey({ protocolID: SITE_TOKEN_RECEIVE, keyID: TOKEN, counterparty: 'anyone' }, SITE),
    ).rejects.toThrow("'self'");
  });

  test('ATTACK: onesat stays reserved on getPublicKey and createSignature', async () => {
    const { wallet, calls } = setup();
    await expect(
      wallet.getPublicKey({ protocolID: [0, 'onesat'], keyID: `${TOKEN}-1`, counterparty: 'self' }, EVIL),
    ).rejects.toThrow(RESERVED_REFUSAL);
    await expect(
      wallet.createSignature({ protocolID: [0, 'onesat'], keyID: 'x', data: [1, 2, 3], counterparty: 'self' }, EVIL),
    ).rejects.toThrow(RESERVED_REFUSAL);
    expect(calls.filter((c) => c.startsWith('createSignature'))).toEqual([]);
  });

  test('ATTACK: the receive protocol signs and encrypts nothing for a site', async () => {
    const { wallet } = setup();
    for (const method of ['createSignature', 'encrypt'])
      await expect(
        wallet[method]({ protocolID: SITE_TOKEN_RECEIVE, keyID: TOKEN, data: [1], plaintext: [1] }, EVIL),
      ).rejects.toThrow(RECEIVE_ONLY_REFUSAL);
  });
});

describe('site tokens: deliveries', () => {
  const buyArgs = (address: string, ci = '{}', basket = 'bsv21') => ({
    description: 'Buy TN',
    outputs: [
      { lockingScript: bsv21(TOKEN, 500n, address).toHex(), satoshis: 1, basket, customInstructions: ci, tags: ['x'] },
      { lockingScript: new P2PKH().lock('1BoatSLRHtKNngkdXEeobR76b53LETtpyT').toHex(), satoshis: 1000 },
    ],
  });

  test('a delivery to a receive key lands in bsv21 with the record the wallet writes (site CI/tags discarded)', async () => {
    const { wallet, calls, last } = setup();
    const k = await receive(wallet);
    const address = PublicKey.fromString(k.publicKey).toAddress();
    const fake = JSON.stringify({
      id: TOKEN,
      amt: '999999',
      sym: 'USDC',
      icon: 'evil',
      protocolID: [2, 'x'],
      keyID: k.keyID,
    });
    await wallet.createAction(buyArgs(address, fake), SITE);
    const out = last().outputs[0];
    expect(out.basket).toBe('bsv21');
    const ci = JSON.parse(out.customInstructions);
    expect(ci).toEqual({
      id: TOKEN,
      amt: '500',
      op: 'transfer',
      protocolID: ONESAT,
      keyID: k.keyID,
      counterparty: 'self',
    });
    expect(out.tags[0]).toBe(`bsv21:${TOKEN}`);
    expect(out.tags).not.toContain('x');
    // No basket grant prompt and no stored grant: one ticket, consumed.
    expect(calls.filter((c) => c.startsWith('grant-prompt'))).toEqual([]);
    expect(_ticketsFor(SITE)).toBe(0);
  });

  test('ATTACK: delivery to an address the wallet never gave this site is refused', async () => {
    const { wallet } = setup();
    await expect(wallet.createAction(buyArgs(PrivateKey.fromRandom().toAddress()), SITE)).rejects.toThrow(
      BAD_DELIVERY_REFUSAL,
    );
  });

  test('ATTACK: another site cannot deliver to (or claim) a key issued to the first site without the keyID', async () => {
    const { wallet } = setup();
    const k = await receive(wallet, SITE);
    const address = PublicKey.fromString(k.publicKey).toAddress();
    await expect(wallet.createAction(buyArgs(address), EVIL)).rejects.toThrow(BAD_DELIVERY_REFUSAL);
  });

  test('ATTACK: a token of a different id than the key was issued for is refused', async () => {
    const { wallet } = setup();
    const k = await receive(wallet, SITE, OTHER_TOKEN);
    await expect(wallet.createAction(buyArgs(PublicKey.fromString(k.publicKey).toAddress()), SITE)).rejects.toThrow(
      BAD_DELIVERY_REFUSAL,
    );
  });

  test('ATTACK: a script with anything extra rides along is not a delivery', async () => {
    const { wallet } = setup();
    const k = await receive(wallet);
    const address = PublicKey.fromString(k.publicKey).toAddress();
    const args = buyArgs(address);
    args.outputs[0].lockingScript = `${args.outputs[0].lockingScript}6a`;
    await expect(wallet.createAction(args, SITE)).rejects.toThrow(BAD_DELIVERY_REFUSAL);
    const two = buyArgs(address);
    two.outputs[0].satoshis = 2;
    await expect(wallet.createAction(two, SITE)).rejects.toThrow(BAD_DELIVERY_REFUSAL);
  });

  test('after a worker restart (no issued keys) the keyID the site kept still delivers: it derives the address', async () => {
    const { wallet, proto, last } = setup();
    const keyID = `${TOKEN}-1761400000123`;
    const { publicKey } = await proto.getPublicKey({ protocolID: ONESAT, keyID, counterparty: 'self' });
    await wallet.createAction(buyArgs(PublicKey.fromString(publicKey).toAddress(), JSON.stringify({ keyID })), SITE);
    expect(JSON.parse(last().outputs[0].customInstructions).keyID).toBe(keyID);
  });

  test('internalizeAction into bsv21 is checked and rewritten the same way', async () => {
    const { wallet, last } = setup();
    const k = await receive(wallet);
    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: fakeSource(),
      sourceOutputIndex: 0,
      sequence: 0xffffffff,
      unlockingScript: new UnlockingScript(),
    });
    tx.addOutput({ lockingScript: bsv21(TOKEN, 7n, PublicKey.fromString(k.publicKey).toAddress()), satoshis: 1 });
    await wallet.internalizeAction(
      {
        tx: tx.toAtomicBEEF(),
        description: 'airdrop',
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'bsv21', customInstructions: '{"sym":"FAKE"}' },
          },
        ],
      },
      SITE,
    );
    expect(JSON.parse(last().outputs[0].insertionRemittance.customInstructions).amt).toBe('7');
    const bad = new Transaction();
    bad.addInput({
      sourceTransaction: fakeSource(),
      sourceOutputIndex: 0,
      sequence: 0xffffffff,
      unlockingScript: new UnlockingScript(),
    });
    bad.addOutput({ lockingScript: bsv21(TOKEN, 7n, PrivateKey.fromRandom().toAddress()), satoshis: 1 });
    await expect(
      wallet.internalizeAction(
        {
          tx: bad.toAtomicBEEF(),
          description: 'x',
          outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'bsv21' } }],
        },
        SITE,
      ),
    ).rejects.toThrow(BAD_DELIVERY_REFUSAL);
  });

  test('ATTACK: sites still cannot list or relinquish the token basket, or insert into other wallet baskets', async () => {
    const { wallet, calls } = setup();
    await expect(wallet.listOutputs({ basket: 'bsv21' }, EVIL)).rejects.toThrow(RESERVED_BASKET_REFUSAL);
    await expect(wallet.relinquishOutput({ basket: 'bsv21', output: `${'00'.repeat(32)}.0` }, EVIL)).rejects.toThrow(
      RESERVED_BASKET_REFUSAL,
    );
    await expect(
      wallet.createAction({ description: 'x', outputs: [{ lockingScript: '51', satoshis: 1, basket: '1sat' }] }, EVIL),
    ).rejects.toThrow(RESERVED_BASKET_REFUSAL);
    expect(calls.filter((c) => c.startsWith('relinquish') || c.startsWith('listOutputs:bsv21:evil'))).toEqual([]);
  });
});

describe('site tokens: selling', () => {
  const sellArgs = (outpoint: string, signAndProcess = false) => ({
    description: 'Sell TN',
    inputs: [{ outpoint, unlockingScriptLength: 108, inputDescription: 'your TN' }],
    outputs: [
      {
        lockingScript: new P2PKH().lock('1BoatSLRHtKNngkdXEeobR76b53LETtpyT').toHex(),
        satoshis: 900,
        outputDescription: 'Your BSV',
      },
    ],
    options: { signAndProcess },
  });

  test('the wallet shows one sheet, then signs its own token input at signAction', async () => {
    const { wallet, hold, prompts, signed } = setup();
    const coin = await hold(TOKEN, 500n);
    const res = await wallet.createAction(sellArgs(coin.outpoint), SITE);
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain('Leaves your wallet');
    await wallet.signAction({ reference: res.signableTransaction.reference, spends: {} }, SITE);
    const unlock = signed[0][0] as { unlockingScript: string };
    expect(unlock.unlockingScript.length).toBeGreaterThan(100);
    // The unlock carries the coin's own key.
    expect(unlock.unlockingScript.endsWith(coin.publicKey)).toBe(true);
  });

  test('signAndProcess left on: the wallet signs and sends in one go', async () => {
    const { wallet, hold, signed } = setup();
    const coin = await hold(TOKEN, 5n);
    const r = await wallet.createAction(sellArgs(coin.outpoint, true), SITE);
    expect(r.txid).toBeTruthy();
    expect(Object.keys(signed[0])).toEqual(['0']);
  });

  test('ATTACK: user says no, nothing is created or signed', async () => {
    const { wallet, hold, calls } = setup({ approve: false });
    const coin = await hold(TOKEN, 5n);
    await expect(wallet.createAction(sellArgs(coin.outpoint), SITE)).rejects.toThrow(SELL_REJECTED);
    expect(calls.filter((c) => c.startsWith('createAction') || c.startsWith('createSignature'))).toEqual([]);
  });

  test('ATTACK: a site may not supply spends for the wallet token inputs, nor sign another site’s action', async () => {
    const { wallet, hold } = setup();
    const coin = await hold(TOKEN, 5n);
    const res = await wallet.createAction(sellArgs(coin.outpoint), SITE);
    const reference = res.signableTransaction.reference;
    await expect(wallet.signAction({ reference, spends: { 0: { unlockingScript: '00' } } }, SITE)).rejects.toThrow(
      SITE_SPENDS_REFUSAL,
    );
    await expect(wallet.signAction({ reference, spends: {} }, EVIL)).rejects.toThrow('another site');
  });

  test('inputs that are not wallet token coins get no sheet and no wallet signature', async () => {
    const { wallet, prompts, signed } = setup();
    const res = await wallet.createAction(sellArgs(`${'11'.repeat(32)}.0`), SITE);
    expect(prompts).toHaveLength(0);
    await wallet.signAction(
      { reference: res.signableTransaction.reference, spends: { 0: { unlockingScript: '00' } } },
      SITE,
    );
    expect(signed[0]).toEqual({ 0: { unlockingScript: '00' } });
  });
});

describe('readTokenTransfer', () => {
  test('reads only the exact bWalletX transfer script', () => {
    const address = PrivateKey.fromRandom().toAddress();
    expect(readTokenTransfer(bsv21(TOKEN, 42n, address).toHex())).toEqual({ id: TOKEN, amt: 42n, address });
    expect(readTokenTransfer(new P2PKH().lock(address).toHex())).toBeNull();
    expect(readTokenTransfer(Utils.toHex([0x51]))).toBeNull();
  });
});
