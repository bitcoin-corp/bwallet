import { describe, expect, test } from 'bun:test';
import { Beef, BSM, P2PKH, PrivateKey, Script, Signature, Spend, Transaction, Utils } from '@bsv/sdk';
import {
  buildMeltTx,
  burnScript,
  checkQuote,
  commitMelt,
  getQuote,
  meltChallenge,
  MeltRefusedError,
  MELT_FEE_MAX_SATS,
  pollMelt,
  quoteReady,
  signChallenge,
  splitAvatar,
  type MeltQuote,
  MELT_UNREACHABLE,
} from './npgMelt';

const JIG_KEY = new PrivateKey(42);
const ORIGIN = `${'ab'.repeat(32)}_o3`;

// A RelayX-era parent: output 0 is the 273-sat P2PKH jig at the holder's address.
const parent = new Transaction();
parent.addOutput({ lockingScript: new P2PKH().lock(JIG_KEY.toAddress()), satoshis: 273 });
const LOCATION = `${parent.id('hex')}_o0`;

const quote = (over: Partial<MeltQuote> = {}): MeltQuote => ({
  quote_id: 'mq_test123',
  expires: new Date(Date.now() + 600_000).toISOString(),
  series: 2,
  n: 9,
  name: 'Naora',
  elements: [
    { file: 'T_018_Hair.png', hue: -102, slot: 'Hair' },
    { file: 's2/v2/0009.webp', slot: 'avatar' },
  ],
  note: null,
  challenge: meltChallenge('mq_test123', LOCATION),
  burn_script_hex: burnScript(ORIGIN, 'mq_test123').toHex(),
  fee_sats: 0,
  fee_to: null,
  mint: { count: 2, sats_each: 1 },
  ...over,
});

describe('npg melt', () => {
  test('burn script is OP_FALSE OP_RETURN "npg-melt" <origin> <quote_id>, byte for byte', () => {
    const hex = burnScript(ORIGIN, 'mq_test123').toHex();
    expect(hex.startsWith('006a086e70672d6d656c74')).toBe(true); // spec prefix
    expect(hex).toContain(Utils.toHex(Utils.toArray(ORIGIN, 'utf8')));
    expect(hex.endsWith(Utils.toHex(Utils.toArray('mq_test123', 'utf8')))).toBe(true);
  });

  test('challenge string and quote checks', () => {
    expect(meltChallenge('mq_x', 'tx_o3')).toBe('npg-melt|v1|mq_x|tx_o3');
    expect(checkQuote(quote(), LOCATION, ORIGIN)).toBeNull();
    expect(checkQuote(quote({ burn_script_hex: '006a' }), LOCATION, ORIGIN)).toMatch(/burn output/);
    expect(checkQuote(quote({ challenge: 'npg-melt|v1|mq_test123|other' }), LOCATION, ORIGIN)).toMatch(/challenge/);
    expect(checkQuote(quote({ fee_sats: 50, fee_to: 'nope' }), LOCATION, ORIGIN)).toMatch(/fee address/);
  });

  test('BSM signature over the challenge verifies with the jig key', () => {
    const c = meltChallenge('mq_test123', LOCATION);
    const sig = signChallenge(c, JIG_KEY.toWif());
    const parsed = Signature.fromCompact(sig, 'base64');
    expect(BSM.verify(Utils.toArray(c, 'utf8'), parsed, JIG_KEY.toPublicKey())).toBe(true);
  });

  test('avatar badge is split from the cards; quotes without one are fine', () => {
    expect(splitAvatar(quote()).avatar?.slot).toBe('avatar');
    expect(splitAvatar(quote()).cards).toHaveLength(1);
    expect(splitAvatar(quote({ elements: [{ file: 'a.png', slot: 'Hair' }] })).avatar).toBeUndefined();
  });

  test('builds the noSend tx: jig is input 0 signed by its key, burn is output 0, EF carries the parent', async () => {
    const calls: Record<string, unknown> = {};
    let pending: Transaction | null = null;
    const wallet = {
      createAction: async (args: Record<string, unknown>) => {
        calls.create = args;
        const tx = new Transaction();
        tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new Script() });
        tx.inputs[0].sequence = 0xffffffff;
        for (const o of args.outputs)
          tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
        pending = tx;
        const beef = new Beef();
        beef.mergeTransaction(tx);
        return { signableTransaction: { reference: 'ref1', tx: beef.toBinaryAtomic(tx.id('hex')) } };
      },
      signAction: async (args: Record<string, unknown>) => {
        calls.sign = args;
        pending!.inputs[0].unlockingScript = Script.fromHex(args.spends[0].unlockingScript);
        const beef = new Beef();
        beef.mergeTransaction(pending!);
        return { txid: pending!.id('hex'), tx: beef.toBinaryAtomic(pending!.id('hex')) };
      },
      abortAction: async () => {
        calls.abort = true;
        return { aborted: true };
      },
    };
    const services = {
      getBeefForTxid: async () => {
        const b = new Beef();
        b.mergeTransaction(parent);
        return b;
      },
    };
    const out = await buildMeltTx(wallet as never, services, quote(), { location: LOCATION, wif: JIG_KEY.toWif() });
    expect((calls.create as Record<string, unknown> & { outputs: unknown[] }).options).toMatchObject({
      noSend: true,
      randomizeOutputs: false,
    });
    expect((calls.create as Record<string, unknown> & { outputs: unknown[] }).outputs[0]).toMatchObject({
      satoshis: 0,
      lockingScript: burnScript(ORIGIN, 'mq_test123').toHex(),
    });
    expect(calls.abort).toBeUndefined();
    const ef = Transaction.fromHexEF(out.ef);
    expect(ef.inputs[0].sourceTXID ?? ef.inputs[0].sourceTransaction?.id('hex')).toBe(parent.id('hex'));
    // The EF carries the parent output (satoshis + script), so the server can check the spend without fetching it.
    const src = ef.inputs[0].sourceTransaction!.outputs[0];
    expect(src.satoshis).toBe(273);
    const spend = new Spend({
      sourceTXID: parent.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 273,
      lockingScript: src.lockingScript,
      transactionVersion: ef.version,
      otherInputs: [],
      outputs: ef.outputs,
      inputIndex: 0,
      unlockingScript: ef.inputs[0].unlockingScript!,
      inputSequence: ef.inputs[0].sequence ?? 0xffffffff,
      lockTime: ef.lockTime,
    });
    expect(spend.validate()).toBe(true);
    expect(ef.outputs[0].lockingScript.toHex()).toBe(burnScript(ORIGIN, 'mq_test123').toHex());
  });

  test('a failure after createAction aborts the unsent action', async () => {
    let aborted = false;
    const wallet = {
      createAction: async () => ({ signableTransaction: { reference: 'r', tx: [1, 2, 3] } }),
      signAction: async () => ({}),
      abortAction: async () => {
        aborted = true;
        return { aborted: true };
      },
    };
    const services = {
      getBeefForTxid: async () => {
        const b = new Beef();
        b.mergeTransaction(parent);
        return b;
      },
    };
    await expect(
      buildMeltTx(wallet as never, services, quote(), { location: LOCATION, wif: JIG_KEY.toWif() }),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  test('polls until done, and stops at the time limit', async () => {
    const seen: string[] = [];
    let n = 0;
    const f = (async () => ({
      ok: true,
      json: async () => ({ status: ++n < 3 ? 'minting' : 'done' }),
    })) as unknown as typeof fetch;
    const s = await pollMelt(f, 'mq', (x) => seen.push(x.status), { every: 1, max: 100, sleep: async () => {} });
    expect(s.status).toBe('done');
    expect(seen).toEqual(['minting', 'minting', 'done']);
    const g = (async () => ({ ok: true, json: async () => ({ status: 'minting' }) })) as unknown as typeof fetch;
    const t = await pollMelt(g, 'mq', () => {}, { every: 10, max: 30, sleep: async () => {} });
    expect(t.status).toBe('minting');
  });

  test('only an explicit commit_ready with a payable fee is ready', () => {
    const npg = [JIG_KEY.toAddress()];
    expect(quoteReady({ commit_ready: true, fee_sats: 51_381, fee_to: JIG_KEY.toAddress() }, npg)).toBe(true);
    // Not NPG's address: never ready.
    expect(quoteReady({ commit_ready: true, fee_sats: 51_381, fee_to: JIG_KEY.toAddress() }, [])).toBe(false);
    expect(quoteReady({ commit_ready: true, fee_sats: 0, fee_to: null })).toBe(true);
    expect(quoteReady({ commit_ready: false, fee_sats: 0, fee_to: null })).toBe(false);
    expect(quoteReady({ fee_sats: 0, fee_to: null })).toBe(false); // missing = not open
    expect(quoteReady({ commit_ready: true, fee_sats: 51_381, fee_to: null })).toBe(false); // fee with nowhere to go
    // A fee with no address is a readiness question, not a malformed quote.
    expect(checkQuote(quote({ fee_sats: 51_381, fee_to: null }), LOCATION, ORIGIN)).toBeNull();
  });

  test('melt fee is capped and only goes to NPG (report: 5,000,000 sats to another address)', async () => {
    const npg = JIG_KEY.toAddress();
    const attacker = PrivateKey.fromRandom().toAddress();
    const big = quote({ fee_sats: 5_000_000, fee_to: npg, commit_ready: true });
    expect(checkQuote(big, LOCATION, ORIGIN, [npg])).toMatch(/larger fee/);
    expect(quoteReady(big, [npg])).toBe(false);
    const elsewhere = quote({ fee_sats: 1_000, fee_to: attacker, commit_ready: true });
    expect(checkQuote(elsewhere, LOCATION, ORIGIN, [npg])).toMatch(/fee address/);
    expect(quoteReady(elsewhere, [npg])).toBe(false);
    expect(checkQuote(quote({ fee_sats: 5_000_000, fee_to: attacker }), LOCATION, ORIGIN, [npg])).not.toBeNull();
    expect(checkQuote(quote({ fee_sats: MELT_FEE_MAX_SATS + 1, fee_to: npg }), LOCATION, ORIGIN, [npg])).toMatch(
      /larger fee/,
    );
    // Normal quotes still pass: free, or a fee within the cap to NPG.
    expect(checkQuote(quote(), LOCATION, ORIGIN, [npg])).toBeNull();
    const normal = quote({ fee_sats: 51_381, fee_to: npg, commit_ready: true });
    expect(checkQuote(normal, LOCATION, ORIGIN, [npg])).toBeNull();
    expect(quoteReady(normal, [npg])).toBe(true);
    // The shipped list is NPG's only: with no address published yet, any fee address is refused.
    expect(checkQuote(quote({ fee_sats: 1_000, fee_to: attacker }), LOCATION, ORIGIN)).toMatch(/fee address/);
    // buildMeltTx refuses on its own too, before createAction.
    let created = false;
    const wallet = {
      createAction: async () => {
        created = true;
        return {};
      },
    };
    await expect(
      buildMeltTx(wallet as never, { getBeefForTxid: async () => new Beef() }, big, {
        location: LOCATION,
        wif: JIG_KEY.toWif(),
      }),
    ).rejects.toThrow(/will not pay/);
    expect(created).toBe(false);
  });

  test('realistic quote: 16 elements, avatar last, split for the sheet', () => {
    const slots = [
      'Hair Back',
      'Body',
      'Cincher',
      'Boots',
      'Gloves',
      'Mask',
      'Top',
      'Bottom',
      'Weapon L',
      'Weapon R',
      'Hair',
      'Eyes',
      'Mouth',
      'Horns',
      'Wings',
      'avatar',
    ];
    const q = quote({ elements: slots.map((slot, i) => ({ file: `e${i}.png`, slot })) });
    expect(splitAvatar(q).cards).toHaveLength(15);
    expect(splitAvatar(q).avatar?.file).toBe('e15.png');
  });

  const answer = (status: number, body: unknown) =>
    (async () => ({ status, ok: status < 300, json: async () => body })) as unknown as typeof fetch;

  test('commit 409 not_ready and 503 are clean refusals (coins freed); 500 is not', async () => {
    const body = { quote_id: 'mq', rawtx_ef: '00', signature: 's' };
    const e409 = await commitMelt(answer(409, { error: 'not_ready' }), body).catch((e) => e);
    expect(e409).toBeInstanceOf(MeltRefusedError);
    expect(e409.message).toBe('Melting opens soon.');
    expect(await commitMelt(answer(503, {}), body).catch((e) => e)).toBeInstanceOf(MeltRefusedError);
    const e500 = await commitMelt(answer(500, { error: 'boom' }), body).catch((e) => e);
    expect(e500).not.toBeInstanceOf(MeltRefusedError);
  });

  test('a 400 quote names the traced origin', async () => {
    const e = await getQuote(answer(400, { error: 'Not this origin', traced_origin: `${'cd'.repeat(32)}_o3` }), {
      jig_location: LOCATION,
      jig_origin: ORIGIN,
      recipient_pubkey: JIG_KEY.toPublicKey().toString(),
    }).catch((x) => x);
    expect(e.message).toContain('traces back to cdcdcdcdcdcd');
  });
});

describe('unreachable melt service', () => {
  test('a blocked request names the service, and is never a clean refusal', async () => {
    const f = (async () => {
      throw new TypeError('Load failed');
    }) as unknown as typeof fetch;
    const err = await commitMelt(f, { quote_id: 'q', rawtx_ef: '00', signature: 's' }).catch((e) => e);
    expect(err.message).toBe(MELT_UNREACHABLE);
    expect(err).not.toBeInstanceOf(MeltRefusedError);
  });
});
