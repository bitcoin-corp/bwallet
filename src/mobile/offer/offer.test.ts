import { describe, expect, mock, test } from 'bun:test';
import { Hash, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import {
  OfferError,
  atEnd,
  docHash,
  embedSignature,
  makeQuote,
  offerOpReturnHex,
  parseManifest,
  sealScriptHex,
  signOfferHash,
  sigImgTag,
  usdToSatsCeil,
  verifyOfferHash,
} from './offer';
import { mergeOffers, parseOffer, type OfferSealed } from './payload';
import { acceptAndPay, retryPending, type Pending, type PendingStore } from './accept';
import { verifyCompany, type Company } from './company';

// Test data only: random keys, a made-up reference and amount.
const REF = 'BCORP-OFF-2099-01-001';
const PNG_A = Utils.toBase64([137, 80, 78, 71, 1, 2, 3, 4]);
const PNG_B = Utils.toBase64([137, 80, 78, 71, 9, 9, 9, 9]);
const manifest = (over: Record<string, unknown> = {}) => ({
  nds: '1.0',
  documentTitle: 'Share Subscription Offer — Test Person',
  documentRef: REF,
  canonical: { algo: 'sha-256', over: 'rendered-pdf' },
  resolution: 'dom-anchor',
  payment: {
    payee: 'bcorp@bwalletx.com',
    amountUsd: '100.00',
    rateSource: 'coingecko:bitcoin-cash-sv/usd',
    rateAt: 'build',
    reference: REF,
    expires: '2099-01-31T23:59:00+00:00',
    opReturn: ['bcorp-offer', '<reference>', '<sha256 of completed doc>'],
  },
  signatureFields: [
    { id: 'company', party: 'company', signerHandle: 'dir', sealHandle: 'bcorp', required: true, order: 1 },
    {
      id: 'subscriber',
      party: 'subscriber',
      signerHandle: 'sub',
      required: true,
      order: 2,
      method: 'signature-pad',
      bindsPayment: true,
    },
  ],
  ...over,
});
const html = (m: unknown = manifest()) =>
  `<!doctype html><html><head><script type="application/npg-sig-manifest+json">${JSON.stringify(m)}</script></head>` +
  `<body><p>Terms.</p><div data-sig-anchor="company"></div><div class="x" data-sig-anchor="subscriber"></div></body></html>`;

const W = () => new ProtoWallet(PrivateKey.fromRandom());
const keyOf = async (w: ProtoWallet) => (await w.getPublicKey({ identityKey: true })).publicKey;
const sha = (s: string) => Utils.toHex(Hash.sha256(Utils.toArray(s, 'utf8')));

describe('manifest', () => {
  test('reads the template', () => {
    const m = parseManifest(html());
    expect(m.documentRef).toBe(REF);
    expect(m.payment.amountUsd).toBe('100.00');
  });
  test('refuses an unknown payee, a mismatched reference, no binding, a missing anchor', () => {
    const p = manifest().payment;
    expect(() => parseManifest(html(manifest({ payment: { ...p, payee: 'someone@else.com' } })))).toThrow(OfferError);
    expect(() => parseManifest(html(manifest({ payment: { ...p, reference: 'OTHER-REF' } })))).toThrow(OfferError);
    const f = manifest().signatureFields.map((x) => ({ ...x, bindsPayment: false }));
    expect(() => parseManifest(html(manifest({ signatureFields: f })))).toThrow(OfferError);
    expect(() => parseManifest(html().replace('data-sig-anchor="company"', ''))).toThrow(OfferError);
  });
});

describe('hashes', () => {
  test('sealHash and completedHash are sha256 of the HTML with the images at the anchors', () => {
    const base = html();
    const sealed = embedSignature(base, 'company', PNG_A);
    expect(sealed).toBe(
      base.replace('<div data-sig-anchor="company">', `<div data-sig-anchor="company">${sigImgTag('company', PNG_A)}`),
    );
    expect(docHash(sealed)).toBe(sha(sealed));
    const done = embedSignature(sealed, 'subscriber', PNG_B);
    expect(done).toContain(`<div class="x" data-sig-anchor="subscriber">${sigImgTag('subscriber', PNG_B)}`);
    expect(docHash(done)).not.toBe(docHash(sealed));
    // Same inputs, same bytes: every party gets the same hash.
    expect(docHash(embedSignature(embedSignature(base, 'company', PNG_A), 'subscriber', PNG_B))).toBe(docHash(done));
  });
  test('a field is never signed twice', () => {
    expect(() => embedSignature(embedSignature(html(), 'company', PNG_A), 'company', PNG_B)).toThrow(OfferError);
  });
});

describe('OP_RETURN layout', () => {
  test('payment: OP_FALSE OP_RETURN "bcorp-offer" <ref> <completedHash>, UTF-8 pushes', () => {
    const h = 'ab'.repeat(32);
    const hex = offerOpReturnHex(REF, h);
    const push = (s: string) => Utils.toHex([s.length, ...Utils.toArray(s, 'utf8')]);
    expect(hex).toBe(`006a${push('bcorp-offer')}${push(REF)}40${Utils.toHex(Utils.toArray(h, 'utf8'))}`);
    expect(hex.startsWith('006a')).toBe(true); // OP_FALSE OP_RETURN
  });
  test('seal: hash + signers only', () => {
    const k1 = PrivateKey.fromRandom().toPublicKey().toString();
    const k2 = PrivateKey.fromRandom().toPublicKey().toString();
    const hex = sealScriptHex(REF, 'cd'.repeat(32), k1, k2);
    const text = Utils.toUTF8(Utils.toArray(hex, 'hex'));
    for (const s of ['bcorp-offer-seal', REF, 'cd'.repeat(32), k1, k2]) expect(text).toContain(s);
    expect(text).not.toContain('Terms');
  });
});

describe('identity signatures', () => {
  test('round trip; bound to role, ref and hash', async () => {
    const w = W();
    const h = 'ef'.repeat(32);
    const sig = await signOfferHash(w, REF, 'subscriber', h);
    expect(await verifyOfferHash(await keyOf(w), REF, 'subscriber', h, sig)).toBe(true);
    expect(await verifyOfferHash(await keyOf(w), REF, 'company', h, sig)).toBe(false);
    expect(await verifyOfferHash(await keyOf(w), REF, 'subscriber', 'aa'.repeat(32), sig)).toBe(false);
    expect(await verifyOfferHash(await keyOf(W()), REF, 'subscriber', h, sig)).toBe(false);
  });
});

describe('money', () => {
  test('USD to sats rounds up, never short', () => {
    expect(usdToSatsCeil('100.00', 50)).toBe(200_000_000);
    expect(usdToSatsCeil('0.01', 30)).toBe(33_334);
    const s = usdToSatsCeil('2500.00', 37.123);
    expect((s * 37.123) / 1e8).toBeGreaterThanOrEqual(2500);
  });
});

describe('scroll gate', () => {
  test('Accept & pay only at the end', () => {
    expect(atEnd({ scrollTop: 0, clientHeight: 500, scrollHeight: 3000 })).toBe(false);
    expect(atEnd({ scrollTop: 2400, clientHeight: 500, scrollHeight: 3000 })).toBe(false);
    expect(atEnd({ scrollTop: 2495, clientHeight: 500, scrollHeight: 3000 })).toBe(true);
    expect(atEnd({ scrollTop: 0, clientHeight: 500, scrollHeight: 400 })).toBe(true);
  });
});

// ── a sealed offer, made the way the director + company make it ──

const sealedOffer = async () => {
  const director = W();
  const company = W();
  const offeree = W();
  const withCompany = embedSignature(html(), 'company', PNG_A);
  const sealHash = docHash(withCompany);
  const offer: OfferSealed = {
    k: 'bcorp-offer',
    v: 1,
    stage: 'offer',
    ref: REF,
    html: withCompany,
    sealHash,
    directorKey: await keyOf(director),
    directorSig: await signOfferHash(director, REF, 'director', sealHash),
    offereeKey: await keyOf(offeree),
    offereeHandle: 'sub',
    companyKey: await keyOf(company),
    companySig: await signOfferHash(company, REF, 'company', sealHash),
    sealTxid: '11'.repeat(32),
    at: 1,
  };
  const parsed = parseOffer(JSON.parse(JSON.stringify(offer)));
  if (!parsed || parsed.stage !== 'offer' || !parsed.manifest) throw new Error('parse');
  return { director, company, offeree, offer: { ...parsed, manifest: parsed.manifest } };
};

const memPending = (): PendingStore & { xs: Pending[] } => {
  const xs: Pending[] = [];
  return {
    xs,
    load: () => [...xs],
    put: (p) => {
      const i = xs.findIndex((x) => x.ref === p.ref);
      if (i >= 0) xs.splice(i, 1);
      xs.unshift(p);
    },
    drop: (ref) => {
      const i = xs.findIndex((x) => x.ref === ref);
      if (i >= 0) xs.splice(i, 1);
    },
  };
};

const NOW = Date.parse('2099-01-10T12:00:00Z');
const setup = async (o: { sign?: 'fail'; action?: 'fail' | 'queued' | 'notx'; submit?: 'fail' } = {}) => {
  const s = await sealedOffer();
  const order: string[] = [];
  const wallet = {
    createSignature: mock(async (args: Parameters<ProtoWallet['createSignature']>[0]) => {
      order.push('sign');
      if (o.sign === 'fail') throw new Error('user cancelled');
      return s.offeree.createSignature(args);
    }),
    createAction: mock(async (args: { outputs?: { lockingScript: string }[]; options?: Record<string, unknown> }) => {
      order.push('pay');
      if (o.action === 'fail') throw new Error('broadcast refused: insufficient fee');
      if (o.action === 'notx') return { txid: undefined };
      return {
        txid: '22'.repeat(32),
        tx: [1, 2, 3],
        ...(o.action === 'queued' ? { sendWithResults: [{ txid: '22'.repeat(32), status: 'sending' }] } : {}),
        _args: args,
      };
    }),
  };
  const submitted: unknown[] = [];
  const pending = memPending();
  const deps = {
    wallet: wallet as never,
    destination: mock(async (sats: number) => {
      order.push('dest');
      return { outputs: [{ script: '76a914' + '00'.repeat(20) + '88ac', satoshis: sats }], reference: 'r'.repeat(32) };
    }),
    submit: mock(async (a: unknown) => {
      order.push('submit');
      if (o.submit === 'fail') throw new Error('server down');
      submitted.push(a);
    }),
    pending,
    now: () => NOW,
  };
  const me = s.offer.offereeKey;
  const input = { offer: s.offer, me, myHandle: 'sub', pngB64: PNG_B, quote: makeQuote('100.00', 50, NOW) };
  return { s, wallet, deps, input, order, submitted, pending };
};

describe('accept = sign to pay (atomic)', () => {
  test('happy path: sign → destination → one tx with the OP_RETURN, broadcast now → submit with the signature', async () => {
    const t = await setup();
    const r = await acceptAndPay(t.deps, t.input);
    expect(r.state).toBe('done');
    expect(t.order).toEqual(['sign', 'dest', 'pay', 'submit']);
    const args = t.wallet.createAction.mock.calls[0][0] as {
      outputs: { lockingScript: string; satoshis: number }[];
      options: Record<string, unknown>;
    };
    expect(args.options.acceptDelayedBroadcast).toBe(false);
    const completed = docHash(embedSignature(t.s.offer.html, 'subscriber', PNG_B));
    expect(r.accepted.completedHash).toBe(completed);
    expect(args.outputs[1]).toEqual({
      lockingScript: offerOpReturnHex(REF, completed),
      satoshis: 0,
      outputDescription: 'Offer reference',
    });
    expect(args.outputs[0].satoshis).toBe(200_000_000);
    const sub = t.submitted[0] as { metadata: { offer: { signature: string; completedHash: string } } };
    expect(sub.metadata.offer.completedHash).toBe(completed);
    expect(await verifyOfferHash(t.input.me, REF, 'subscriber', completed, sub.metadata.offer.signature)).toBe(true);
    expect(t.pending.xs.length).toBe(0);
    // The acceptance a party receives checks out against the offer.
    const [rec] = await mergeOffers([t.s.offer, r.accepted]);
    expect(rec.checks).toEqual({ directorSig: true, companySig: true, completed: true });
  });

  test('no signature, no payment', async () => {
    const t = await setup({ sign: 'fail' });
    await expect(acceptAndPay(t.deps, t.input)).rejects.toThrow('user cancelled');
    expect(t.order).toEqual(['sign']);
    expect(t.wallet.createAction).not.toHaveBeenCalled();
    expect(t.submitted.length).toBe(0);
  });

  test('no payment, no signature submitted (refused broadcast)', async () => {
    const t = await setup({ action: 'fail' });
    await expect(acceptAndPay(t.deps, t.input)).rejects.toThrow('broadcast refused');
    expect(t.deps.submit).not.toHaveBeenCalled();
    expect(t.pending.xs.length).toBe(0);
  });

  test('a wallet answer without a transaction is an error, never a txid', async () => {
    const t = await setup({ action: 'notx' });
    await expect(acceptAndPay(t.deps, t.input)).rejects.toThrow(OfferError);
    expect(t.deps.submit).not.toHaveBeenCalled();
  });

  test('queued by the network: payment and signature kept together, not submitted yet', async () => {
    const t = await setup({ action: 'queued' });
    const r = await acceptAndPay(t.deps, t.input);
    expect(r.state).toBe('waiting');
    expect(t.deps.submit).not.toHaveBeenCalled();
    expect(t.pending.xs.length).toBe(1);
    expect(t.pending.xs[0].metadata.offer.signature).toBe(r.accepted.subscriberSig);
    // Later: retry sends both.
    expect(await retryPending(t.deps)).toEqual([REF]);
    expect(t.pending.xs.length).toBe(0);
  });

  test('submit fails after payment: kept for retry, never paid twice', async () => {
    const t = await setup({ submit: 'fail' });
    const r = await acceptAndPay(t.deps, t.input);
    expect(r.state).toBe('waiting');
    expect(t.pending.xs.length).toBe(1);
    await expect(acceptAndPay(t.deps, t.input)).rejects.toThrow('already paid');
    expect(t.wallet.createAction).toHaveBeenCalledTimes(1);
  });

  test('expired offer, wrong person, wrong amount: refused before signing', async () => {
    const late = await setup();
    await expect(
      acceptAndPay({ ...late.deps, now: () => Date.parse('2099-02-02T00:00:00Z') }, late.input),
    ).rejects.toThrow('lapsed');
    const other = await setup();
    await expect(acceptAndPay(other.deps, { ...other.input, me: await keyOf(W()) })).rejects.toThrow('someone else');
    const amt = await setup();
    await expect(acceptAndPay(amt.deps, { ...amt.input, quote: { ...amt.input.quote, sats: 1 } })).rejects.toThrow(
      'does not match',
    );
    for (const t of [late, other, amt]) expect(t.order).toEqual([]);
  });
});

describe('payloads', () => {
  test('a tampered offer (HTML changed after sealing) is dropped', async () => {
    const { offer } = await sealedOffer();
    expect(parseOffer({ ...offer, html: offer.html.replace('Terms.', 'Other terms.') })).toBeNull();
  });
  test('a forged company seal fails the check', async () => {
    const { offer } = await sealedOffer();
    const forged = { ...offer, companySig: await signOfferHash(W(), REF, 'company', offer.sealHash) };
    const [rec] = await mergeOffers([forged]);
    expect(rec.checks.companySig).toBe(false);
  });
});

describe('verified company', () => {
  test('verified only when the server record, seal key and director all line up', async () => {
    const { offer } = await sealedOffer();
    const co: Company = {
      paymail: 'bcorp@bwalletx.com',
      alias: 'bcorp',
      key: offer.companyKey,
      name: 'The Bitcoin Corporation Ltd',
      number: '16735102',
      directors: [offer.directorKey],
    };
    const ok = { companySig: true, directorSig: true };
    const o = { ...offer, payee: 'bcorp@bwalletx.com' };
    expect(verifyCompany(co, o, ok).verified).toBe(true);
    expect(verifyCompany({ ...co, key: offer.directorKey }, o, ok).verified).toBe(false);
    expect(verifyCompany({ ...co, number: '1' }, o, ok).verified).toBe(false);
    expect(verifyCompany({ ...co, directors: [] }, o, ok).verified).toBe(false);
    expect(verifyCompany(co, o, { companySig: false, directorSig: true }).verified).toBe(false);
    expect(verifyCompany(null, o, ok).verified).toBe(false);
  });
});
