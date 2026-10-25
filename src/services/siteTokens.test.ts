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
  DEPLOY_NEEDS_TXID,
  LIST_REJECTED,
  SITE_ORDINAL_RECEIVE,
  readImageInscription,
  readTokenDeploy,
  RECEIVE_ONLY_REFUSAL,
  SELL_REJECTED,
  SITE_SPENDS_REFUSAL,
  SITE_TOKEN_RECEIVE,
  _ticketsFor,
  guardSiteTokens,
  memoryConsentStore,
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
const setup = (opts: { approve?: boolean | ((r: any) => boolean) } = {}) => {
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
      const t = pendingTx.get(a.reference);
      return { txid: t?.id('hex'), tx: t?.toAtomicBEEF() };
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
      return typeof opts.approve === 'function' ? opts.approve(r) : (opts.approve ?? true);
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

const OP_HEX = (s: string) => Utils.toHex(Utils.toArray(s, 'utf8'));
/** OP_0 OP_IF "ord" OP_1 <type> OP_0 <body> OP_ENDIF + P2PKH, the standard envelope. */
const inscribe = (type: string, body: number[], address: string) =>
  LockingScript.fromASM(
    `OP_0 OP_IF ${OP_HEX('ord')} OP_1 ${OP_HEX(type)} OP_0 ${Utils.toHex(body)} OP_ENDIF ${new P2PKH().lock(address).toASM()}`,
  );
const deployScript = (fields: Record<string, string>, address: string) =>
  inscribe('application/bsv-20', Utils.toArray(JSON.stringify(fields), 'utf8'), address);

describe('site tokens: seeing one token (listOutputs)', () => {
  const list = (wallet: Record<string, (a: unknown, o?: string) => Promise<any>>, args: unknown, o = SITE) =>
    wallet.listOutputs(args, o);

  test('one sheet per site per token, remembered; answers outpoint + satoshis + amount of THAT token only', async () => {
    const { wallet, hold, prompts } = setup();
    const a = await hold(TOKEN, 1234n);
    await hold(OTHER_TOKEN, 99n);
    const r = await list(wallet, {
      basket: 'bsv21',
      tags: [`bsv21:${TOKEN}`],
      includeCustomInstructions: true,
      includeTags: true,
      include: 'entire transactions',
    });
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain(`${SITE} wants to see your $TN balance`);
    expect(r).toEqual({
      totalOutputs: 1,
      outputs: [{ outpoint: a.outpoint, satoshis: 1, spendable: true, amount: '1234' }],
    });
    expect(r.BEEF).toBeUndefined();
    await list(wallet, { basket: 'bsv21', tags: [`bsv21:${TOKEN}`] });
    expect(prompts).toHaveLength(1); // remembered
  });

  test('a listed coin bought elsewhere sells through the normal sheet; the wallet signs with its own record key', async () => {
    const { wallet, hold, signed } = setup();
    const coin = await hold(TOKEN, 50n, `${TOKEN}-1700000000000`);
    const r = await list(wallet, { basket: 'bsv21', tags: [`bsv21:${TOKEN}`] });
    const res = await wallet.createAction(
      {
        description: 'Sell',
        inputs: [{ outpoint: r.outputs[0].outpoint, unlockingScriptLength: 108, inputDescription: 'your TN' }],
        outputs: [{ lockingScript: new P2PKH().lock('1BoatSLRHtKNngkdXEeobR76b53LETtpyT').toHex(), satoshis: 9 }],
        options: { signAndProcess: false },
      },
      SITE,
    );
    // The signable BEEF carries the source tx of the wallet's token input (needed to check the sell).
    const tx = Transaction.fromAtomicBEEF(res.signableTransaction.tx);
    expect(tx.inputs[0].sourceTransaction?.id('hex')).toBe(coin.outpoint.split('.')[0]);
    const done = await wallet.signAction({ reference: res.signableTransaction.reference, spends: {} }, SITE);
    expect((signed[0][0] as { unlockingScript: string }).unlockingScript.endsWith(coin.publicKey)).toBe(true);
    // signAction's answer is passed back untouched: txid + tx (AtomicBEEF of the signed tx).
    expect(Transaction.fromAtomicBEEF(done.tx).id('hex')).toBe(done.txid);
  });

  test('ATTACK: listing another token needs its own sheet; saying no shows nothing', async () => {
    const { wallet, hold } = setup({ approve: (r) => !JSON.stringify(r).includes(OTHER_TOKEN) });
    await hold(TOKEN, 1n);
    await hold(OTHER_TOKEN, 2n);
    await list(wallet, { basket: 'bsv21', tags: [`bsv21:${TOKEN}`] });
    await expect(list(wallet, { basket: 'bsv21', tags: [`bsv21:${OTHER_TOKEN}`] })).rejects.toThrow(LIST_REJECTED);
  });

  test('ATTACK: another site does not inherit the first site’s yes', async () => {
    const { wallet, hold, prompts } = setup();
    await hold(TOKEN, 1n);
    await list(wallet, { basket: 'bsv21', tags: [`bsv21:${TOKEN}`] });
    await list(wallet, { basket: 'bsv21', tags: [`bsv21:${TOKEN}`] }, EVIL);
    expect(prompts).toHaveLength(2);
  });

  test('ATTACK: no tag, two tags, a non-token tag, or another wallet basket stays refused', async () => {
    const { wallet, hold, prompts } = setup();
    await hold(TOKEN, 1n);
    for (const args of [
      { basket: 'bsv21' },
      { basket: 'bsv21', tags: [] },
      { basket: 'bsv21', tags: [`bsv21:${TOKEN}`, `bsv21:${OTHER_TOKEN}`] },
      { basket: 'bsv21', tags: ['bsv21:deploy'] },
      { basket: 'bsv21', tags: [`bsv21:${TOKEN}`, 'id:x'] },
      { basket: '1sat', tags: [`bsv21:${TOKEN}`] },
      { basket: 'lock', tags: [`bsv21:${TOKEN}`] },
    ])
      await expect(list(wallet, args)).rejects.toThrow(RESERVED_BASKET_REFUSAL);
    expect(prompts).toHaveLength(0);
  });

  test('ATTACK: the answer never carries keys, records, scripts or tags', async () => {
    const { wallet, hold } = setup();
    const c = await hold(TOKEN, 7n);
    const r = await list(wallet, { basket: 'bsv21', tags: [`bsv21:${TOKEN}`], includeCustomInstructions: true });
    const text = JSON.stringify(r);
    for (const leak of ['keyID', 'protocolID', 'onesat', 'customInstructions', 'lockingScript', 'tags', c.keyID])
      expect(text).not.toContain(leak);
  });
});

describe('site tokens: deploy + icon', () => {
  test('deploy and ordinal receive keys are fresh wallet keys the wallet names', async () => {
    const { wallet, proto } = setup();
    const d = await wallet.getPublicKey(
      { protocolID: SITE_TOKEN_RECEIVE, keyID: 'deploy', counterparty: 'self' },
      SITE,
    );
    expect(d.keyID).toMatch(/^deploy-\d{13}$/);
    expect(d.publicKey).toBe(
      (await proto.getPublicKey({ protocolID: ONESAT, keyID: d.keyID, counterparty: 'self' })).publicKey,
    );
    const o = await wallet.getPublicKey(
      { protocolID: SITE_ORDINAL_RECEIVE, keyID: 'ordinal', counterparty: 'self' },
      SITE,
    );
    expect(o.keyID).toMatch(/^ordinal-\d{13}$/);
    await expect(
      wallet.getPublicKey({ protocolID: SITE_ORDINAL_RECEIVE, keyID: 'x', counterparty: 'self' }, SITE),
    ).rejects.toThrow("'ordinal'");
    await expect(
      wallet.createSignature({ protocolID: SITE_ORDINAL_RECEIVE, keyID: 'ordinal', data: [1] }, SITE),
    ).rejects.toThrow(RECEIVE_ONLY_REFUSAL);
  });

  const deployTx = (script: LockingScript) => {
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: fakeSource(), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    tx.addOutput({ lockingScript: script, satoshis: 1 });
    return tx;
  };

  test('a deploy+mint to a deploy key is internalized into bsv21 with the wallet’s record (id = its outpoint)', async () => {
    const { wallet, last } = setup();
    const d = await wallet.getPublicKey(
      { protocolID: SITE_TOKEN_RECEIVE, keyID: 'deploy', counterparty: 'self' },
      SITE,
    );
    const address = PublicKey.fromString(d.publicKey).toAddress();
    const tx = deployTx(
      deployScript(
        { p: 'bsv-20', op: 'deploy+mint', sym: 'TERRORNODE', amt: '1000000000', dec: '0', icon: '_1' },
        address,
      ),
    );
    await wallet.internalizeAction(
      {
        tx: tx.toAtomicBEEF(),
        description: 'deploy',
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'bsv21', customInstructions: '{"sym":"FAKE"}', tags: ['x'] },
          },
        ],
      },
      SITE,
    );
    const rem = last().outputs[0].insertionRemittance;
    const id = `${tx.id('hex')}_0`;
    expect(rem.basket).toBe('bsv21');
    expect(JSON.parse(rem.customInstructions)).toEqual({
      id,
      amt: '1000000000',
      op: 'deploy+mint',
      sym: 'TERRORNODE',
      dec: '0',
      icon: '_1',
      protocolID: ONESAT,
      keyID: d.keyID,
      counterparty: 'self',
    });
    expect(rem.tags.slice(0, 2)).toEqual(['bsv21:deploy', `bsv21:${id}`]);
    expect(_ticketsFor(SITE)).toBe(0);
  });

  test('ATTACK: a deploy in createAction (no txid yet), to a transfer key, or with extra fields is refused', async () => {
    const { wallet } = setup();
    const d = await wallet.getPublicKey(
      { protocolID: SITE_TOKEN_RECEIVE, keyID: 'deploy', counterparty: 'self' },
      SITE,
    );
    const addr = PublicKey.fromString(d.publicKey).toAddress();
    const good = deployScript({ p: 'bsv-20', op: 'deploy+mint', sym: 'TN', amt: '5' }, addr);
    await expect(
      wallet.createAction(
        { description: 'x', outputs: [{ lockingScript: good.toHex(), satoshis: 1, basket: 'bsv21' }] },
        SITE,
      ),
    ).rejects.toThrow(DEPLOY_NEEDS_TXID);
    const t = await receive(wallet);
    const toTransferKey = deployTx(
      deployScript(
        { p: 'bsv-20', op: 'deploy+mint', sym: 'TN', amt: '5' },
        PublicKey.fromString(t.publicKey).toAddress(),
      ),
    );
    const ins = (tx: Transaction, ci?: string) =>
      wallet.internalizeAction(
        {
          tx: tx.toAtomicBEEF(),
          description: 'd',
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: { basket: 'bsv21', customInstructions: ci },
            },
          ],
        },
        SITE,
      );
    await expect(ins(toTransferKey, JSON.stringify({ keyID: t.keyID }))).rejects.toThrow(BAD_DELIVERY_REFUSAL);
    const extra = deployTx(deployScript({ p: 'bsv-20', op: 'deploy+mint', sym: 'TN', amt: '5', lim: '1' }, addr));
    await expect(ins(extra)).rejects.toThrow(BAD_DELIVERY_REFUSAL);
    // Another site cannot use a deploy key it was not given (even naming the keyID derives a key it holds nothing of).
    const stranger = deployTx(
      deployScript({ p: 'bsv-20', op: 'deploy+mint', sym: 'TN', amt: '5' }, PrivateKey.fromRandom().toAddress()),
    );
    await expect(ins(stranger, JSON.stringify({ keyID: d.keyID }))).rejects.toThrow(BAD_DELIVERY_REFUSAL);
  });

  test('an image inscription to an ordinal key goes into 1sat with the wallet’s record', async () => {
    const { wallet, last } = setup();
    const o = await wallet.getPublicKey(
      { protocolID: SITE_ORDINAL_RECEIVE, keyID: 'ordinal', counterparty: 'self' },
      SITE,
    );
    const script = inscribe(
      'image/png',
      [0x89, 0x50, 0x4e, 0x47, 1, 2, 3],
      PublicKey.fromString(o.publicKey).toAddress(),
    );
    await wallet.createAction(
      {
        description: 'icon',
        outputs: [
          {
            lockingScript: script.toHex(),
            satoshis: 1,
            basket: '1sat',
            customInstructions: '{"keyID":"evil"}',
            tags: ['origin:fake'],
          },
        ],
      },
      SITE,
    );
    const out = last().outputs[0];
    expect(out.basket).toBe('1sat');
    expect(JSON.parse(out.customInstructions)).toEqual({ protocolID: ONESAT, keyID: o.keyID, counterparty: 'self' });
    expect(out.tags).toEqual(['type:image/png']);
    expect(_ticketsFor(SITE, '1sat')).toBe(0);
  });

  test('ATTACK: icons to a key not given, token ops dressed as icons, extra script, 2 sats: all refused', async () => {
    const { wallet } = setup();
    const o = await wallet.getPublicKey(
      { protocolID: SITE_ORDINAL_RECEIVE, keyID: 'ordinal', counterparty: 'self' },
      SITE,
    );
    const addr = PublicKey.fromString(o.publicKey).toAddress();
    const send = (hex: string, satoshis = 1) =>
      wallet.createAction({ description: 'x', outputs: [{ lockingScript: hex, satoshis, basket: '1sat' }] }, SITE);
    await expect(send(inscribe('image/png', [1], PrivateKey.fromRandom().toAddress()).toHex())).rejects.toThrow(
      BAD_DELIVERY_REFUSAL,
    );
    await expect(
      send(deployScript({ p: 'bsv-20', op: 'deploy+mint', sym: 'X', amt: '1' }, addr).toHex()),
    ).rejects.toThrow(BAD_DELIVERY_REFUSAL);
    await expect(send(inscribe('image/png', [1], addr).toHex() + '51')).rejects.toThrow(BAD_DELIVERY_REFUSAL);
    await expect(send(inscribe('image/png', [1], addr).toHex(), 2)).rejects.toThrow(BAD_DELIVERY_REFUSAL);
    // the ordinal key is not a token key, and a deploy key is not an ordinal key
    const t = await receive(wallet);
    await expect(
      send(inscribe('image/png', [1], PublicKey.fromString(t.publicKey).toAddress()).toHex()),
    ).rejects.toThrow(BAD_DELIVERY_REFUSAL);
    await expect(
      wallet.createAction(
        {
          description: 'x',
          outputs: [{ lockingScript: bsv21(TOKEN, 5n, addr).toHex(), satoshis: 1, basket: 'bsv21' }],
        },
        SITE,
      ),
    ).rejects.toThrow(BAD_DELIVERY_REFUSAL);
  });

  test('readTokenDeploy / readImageInscription read only exact scripts', () => {
    const a = PrivateKey.fromRandom().toAddress();
    expect(readTokenDeploy(deployScript({ p: 'bsv-20', op: 'deploy+mint', sym: 'X', amt: '1' }, a).toHex())?.sym).toBe(
      'X',
    );
    expect(
      readTokenDeploy(deployScript({ p: 'bsv-20', op: 'deploy+mint', sym: 'X', amt: '01' }, a).toHex()),
    ).toBeNull();
    expect(readTokenDeploy(bsv21(TOKEN, 1n, a).toHex())).toBeNull();
    expect(readImageInscription(inscribe('image/webp', [9, 9], a).toHex())).toEqual({
      contentType: 'image/webp',
      bytes: 2,
      address: a,
    });
    expect(readImageInscription(inscribe('text/html', [9], a).toHex())).toBeNull();
  });
});

describe('site tokens: list consent can be revoked', () => {
  test('memory store lists and forgets one site only', async () => {
    const st = memoryConsentStore();
    await st.add('a.com', 'x');
    await st.add('a.com', 'y');
    await st.add('b.com', 'x');
    expect(await st.list()).toEqual({ 'a.com': ['x', 'y'], 'b.com': ['x'] });
    await st.forget('a.com');
    expect(await st.has('a.com', 'x')).toBe(false);
    expect(await st.has('b.com', 'x')).toBe(true);
  });
});
