import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import offers from '../lib/offerReceipts.js';

// Test data only: random keys, made-up company and reference.
const company = PrivateKey.fromRandom();
const director = PrivateKey.fromRandom();
const offeree = PrivateKey.fromRandom();
const stranger = PrivateKey.fromRandom();
const key = (p) => p.toPublicKey().toString();
const ENV = {
  PAYMAIL_DOMAIN: 'pay.test',
  PAYMAIL_COMPANIES: JSON.stringify({
    acme: { name: 'Acme Test Ltd', number: '00000001', directors: [key(director)] },
  }),
};
const REF = 'ACME-OFF-2099-01-001';
const HASH = 'ab'.repeat(32);
const SEAL_TX = 'cd'.repeat(32);

const store = () => {
  const aliases = new Map([['acme', { alias: 'acme', identity_key: key(company) }]]);
  const pays = new Map();
  const offersT = new Map();
  const receipts = new Map();
  return {
    receipts,
    getAlias: async (a) => aliases.get(a) ?? null,
    insertPayment: async (r) => void pays.set(r.reference, { ...r }),
    getPayment: async (r) => pays.get(r) ?? null,
    updatePayment: async (r, p) => void Object.assign(pays.get(r), p),
    countRecentPayments: async () => 0,
    getOffer: async (ref) => offersT.get(ref) ?? null,
    putOffer: async (row) => void offersT.set(row.ref, { ...row }),
    getReceipt: async (txid) => receipts.get(txid) ?? null,
    insertReceipt: async (row) => {
      if (receipts.has(row.txid)) throw new Error('duplicate');
      receipts.set(row.txid, row);
    },
    listReceipts: async (alias) => [...receipts.values()].filter((r) => r.alias === alias),
  };
};

let CLOCK = Date.now();
const signed = async (priv, action, fields, timestamp = CLOCK) => {
  const identityKey = key(priv);
  const { signature } = await new ProtoWallet(priv).createSignature({
    data: Utils.toArray(pm.signedMessage(action, { ...fields, identityKey, timestamp: String(timestamp) }), 'utf8'),
    protocolID: pm.SIGN_PROTOCOL,
    keyID: pm.SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return { identityKey, timestamp, fields, signature: Utils.toHex(signature) };
};

const offerSig = async (priv, role, hash) =>
  Utils.toHex(
    (
      await new ProtoWallet(priv).createSignature({
        data: Utils.toArray(offers.sigRecord(REF, role, hash), 'utf8'),
        protocolID: offers.OFFER_SIG_PROTOCOL,
        keyID: REF,
        counterparty: 'anyone',
      })
    ).signature,
  );

const opReturn = (ref, hash) =>
  new Script()
    .writeOpCode(0)
    .writeOpCode(0x6a)
    .writeBin(Utils.toArray('bcorp-offer', 'utf8'))
    .writeBin(Utils.toArray(ref, 'utf8'))
    .writeBin(Utils.toArray(hash, 'utf8'));

const fields = (over = {}) => ({
  alias: 'acme',
  ref: REF,
  amountUsd: '100.00',
  expires: '2099-01-31T23:59:00+00:00',
  sealHash: HASH,
  sealTxid: SEAL_TX,
  offereeKey: key(offeree),
  offereeHandle: 'someone',
  directorKey: key(director),
  directorHandle: 'dir',
  ...over,
});

const payTx = (script, sats, withOp = true) => {
  const src = new Transaction();
  src.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: sats + 1000 });
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new Script() });
  tx.addOutput({ lockingScript: Script.fromHex(script), satoshis: sats });
  if (withOp) tx.addOutput({ lockingScript: opReturn(REF, HASH), satoshis: 0 });
  return tx;
};

const setup = async (now = Date.parse('2099-01-10T12:00:00Z'), rate = 50) => {
  CLOCK = now;
  const st = store();
  const notes = [];
  const h = pm.makeHandlers({
    store: st,
    env: ENV,
    now: () => now,
    offerRate: async () => rate,
    notifyOffer: async (handle, r) => (notes.push([handle, r]), true),
  });
  return { st, h, notes };
};

const pay = async (h, sats, meta) => {
  const [, dest] = await h.p2pDestination({ handle: 'acme@pay.test' }, { satoshis: sats });
  const tx = payTx(dest.outputs[0].script, sats);
  return h.receive(
    { handle: 'acme@pay.test' },
    { hex: tx.toHex(), reference: dest.reference, metadata: { offer: meta } },
  );
};

describe('status rules (template §B)', () => {
  test('paid in full before expiry: pending allotment', () => {
    expect(
      offers.receiptStatus({
        amountUsd: '100.00',
        usdValue: '100.00',
        expires: '2099-01-31T23:59:00Z',
        firstSeen: '2099-01-10T00:00:00Z',
      }),
    ).toBe('received_pending_allotment');
  });
  test('one cent short: shortfall', () => {
    expect(
      offers.receiptStatus({
        amountUsd: '100.00',
        usdValue: '99.99',
        expires: '2099-01-31T23:59:00Z',
        firstSeen: '2099-01-10T00:00:00Z',
      }),
    ).toBe('received_shortfall');
  });
  test('after expiry: after lapse, even when short or in full', () => {
    for (const usdValue of ['10.00', '100.00', '500.00'])
      expect(
        offers.receiptStatus({
          amountUsd: '100.00',
          usdValue,
          expires: '2099-01-31T23:59:00Z',
          firstSeen: '2099-02-01T00:00:00Z',
        }),
      ).toBe('received_after_lapse');
  });
  test('an unreadable value is a shortfall, never pending allotment', () => {
    expect(
      offers.receiptStatus({
        amountUsd: '100.00',
        usdValue: null,
        expires: '2099-01-31T23:59:00Z',
        firstSeen: '2099-01-10T00:00:00Z',
      }),
    ).toBe('received_shortfall');
  });
  test('USD value rounds down to the cent', () => {
    expect(offers.usdValueOf(200_000_000, 50)).toBe('100.00');
    expect(offers.usdValueOf(199_999_999, 50)).toBe('99.99');
  });
  test("payer's rate is used only within 5% of ours", () => {
    expect(offers.pickRate(51, 50)).toEqual({ rate: 51, source: 'payer-build' });
    expect(offers.pickRate(60, 50)).toEqual({ rate: 50, source: 'coingecko' });
  });
});

describe('OP_RETURN', () => {
  test('parses ["bcorp-offer", ref, completedHash] as UTF-8 pushes', () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: opReturn(REF, HASH), satoshis: 0 });
    expect(offers.parseOfferOpReturn(tx)).toEqual({ vout: 0, ref: REF, completedHash: HASH });
  });
  test('ignores other OP_RETURNs and bad hashes', () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new Script().writeOpCode(0).writeOpCode(0x6a).writeBin([1, 2]), satoshis: 0 });
    tx.addOutput({ lockingScript: opReturn(REF, 'nothex'), satoshis: 0 });
    expect(offers.parseOfferOpReturn(tx)).toBeNull();
  });
});

describe('company paymail', () => {
  test('pki and profile say which company it is', async () => {
    const { h } = await setup();
    const [s, pki] = await h.pki({ handle: 'acme@pay.test' });
    expect(s).toBe(200);
    expect(pki.pubkey).toBe(key(company));
    expect(pki.company).toEqual({ name: 'Acme Test Ltd', number: '00000001', directors: [key(director)] });
    const [, prof] = await h.profile({ handle: 'acme@pay.test' });
    expect(prof.name).toBe('Acme Test Ltd');
  });
  test('bad PAYMAIL_COMPANIES: no company (fail closed)', () => {
    expect(offers.companies({ PAYMAIL_COMPANIES: '{oops' }).size).toBe(0);
    expect(offers.companies({ PAYMAIL_COMPANIES: '{"x":{"name":"N"}}' }).size).toBe(0);
  });
});

describe('offer-register', () => {
  test('only the company key may register', async () => {
    const { h } = await setup();
    const [s1] = await h['offer-register']({}, await signed(stranger, 'offer-register', fields()));
    expect(s1).toBe(403);
    const [s2] = await h['offer-register']({}, await signed(director, 'offer-register', fields()));
    expect(s2).toBe(403);
    const [s3, out] = await h['offer-register']({}, await signed(company, 'offer-register', fields()));
    expect([s3, out.ref]).toEqual([200, REF]);
  });
  test('the director must be one of the company directors', async () => {
    const { h } = await setup();
    const [s] = await h['offer-register'](
      {},
      await signed(company, 'offer-register', fields({ directorKey: key(stranger) })),
    );
    expect(s).toBe(400);
  });
  test('a reference cannot be re-used for a different document', async () => {
    const { h } = await setup();
    await h['offer-register']({}, await signed(company, 'offer-register', fields()));
    const [s] = await h['offer-register'](
      {},
      await signed(company, 'offer-register', fields({ sealHash: 'ef'.repeat(32) })),
    );
    expect(s).toBe(409);
  });
});

describe('receipt on payment', () => {
  const meta = async (over = {}) => ({
    identityKey: key(offeree),
    signature: await offerSig(offeree, 'subscriber', HASH),
    rateUsdPerBsv: '50.00',
    rateAt: '2099-01-10T11:59:00Z',
    ...over,
  });

  test('full payment: received_pending_allotment, allotment null, director notified', async () => {
    const { h, st, notes } = await setup();
    await h['offer-register']({}, await signed(company, 'offer-register', fields()));
    const [s, r] = await pay(h, 200_000_000, await meta());
    expect(s).toBe(200);
    const row = st.receipts.get(r.txid);
    expect(row.status).toBe('received_pending_allotment');
    expect(row.record.allotment).toBeNull();
    expect(row.record.payment.usdValue).toBe('100.00');
    expect(row.record.payment.bsv).toBe('2.00000000');
    expect(row.record.payment.vout).toEqual([0]);
    expect(row.record.completedHash).toBe(HASH);
    expect(row.record.sealTxid).toBe(SEAL_TX);
    expect(row.record.checks).toEqual({
      offereeKeyMatches: true,
      subscriberSigValid: true,
      completedHashFromChain: true,
    });
    expect(notes.length).toBe(1);
    expect(notes[0][0]).toBe('dir');
  });

  test('short payment: received_shortfall with the shortfall in USD', async () => {
    const { h, st } = await setup();
    await h['offer-register']({}, await signed(company, 'offer-register', fields()));
    const [, r] = await pay(h, 100_000_000, await meta());
    const rec = st.receipts.get(r.txid).record;
    expect(rec.status).toBe('received_shortfall');
    expect(rec.payment.shortfallUsd).toBe('50.00');
    expect(rec.allotment).toBeNull();
  });

  test('after the expiry: received_after_lapse', async () => {
    const { h, st } = await setup(Date.parse('2099-02-02T00:00:00Z'));
    await h['offer-register']({}, await signed(company, 'offer-register', fields()));
    const [, r] = await pay(h, 200_000_000, await meta());
    expect(st.receipts.get(r.txid).record.status).toBe('received_after_lapse');
  });

  test("someone else's signature is recorded as not valid", async () => {
    const { h, st } = await setup();
    await h['offer-register']({}, await signed(company, 'offer-register', fields()));
    const [, r] = await pay(
      h,
      200_000_000,
      await meta({ identityKey: key(stranger), signature: await offerSig(stranger, 'subscriber', HASH) }),
    );
    expect(st.receipts.get(r.txid).record.checks.subscriberSigValid).toBe(false);
  });

  test('no allotment in any status, and nothing writes one', async () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../lib/offerReceipts.js'),
      'utf8',
    );
    expect(src).not.toMatch(/allotment\s*[:=]\s*(?!null)[^\s,]/);
    for (const now of [Date.parse('2099-01-10T00:00:00Z'), Date.parse('2099-03-01T00:00:00Z')]) {
      const { h, st } = await setup(now);
      await h['offer-register']({}, await signed(company, 'offer-register', fields()));
      const [, r] = await pay(h, 1000, await meta());
      expect(st.receipts.get(r.txid).record.allotment).toBeNull();
    }
  });

  test('a payment without the offer OP_RETURN is just a payment', async () => {
    const { h, st } = await setup();
    await h['offer-register']({}, await signed(company, 'offer-register', fields()));
    const [, dest] = await h.p2pDestination({ handle: 'acme@pay.test' }, { satoshis: 5000 });
    const tx = payTx(dest.outputs[0].script, 5000, false);
    const [s] = await h.receive({ handle: 'acme@pay.test' }, { hex: tx.toHex(), reference: dest.reference });
    expect(s).toBe(200);
    expect(st.receipts.size).toBe(0);
  });

  test('receipts: directors and the company only', async () => {
    const { h } = await setup();
    await h['offer-register']({}, await signed(company, 'offer-register', fields()));
    await pay(h, 200_000_000, await meta());
    const [s1] = await h['offer-receipts']({}, await signed(stranger, 'offer-receipts', { alias: 'acme' }));
    expect(s1).toBe(403);
    const [s2, out] = await h['offer-receipts']({}, await signed(director, 'offer-receipts', { alias: 'acme' }));
    expect(s2).toBe(200);
    expect(out.receipts.length).toBe(1);
    expect(out.receipts[0].offerRef).toBe(REF);
  });
});
