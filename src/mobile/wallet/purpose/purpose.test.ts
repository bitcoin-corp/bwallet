import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import {
  applyChip,
  canWriteOnChain,
  cleanPurpose,
  loadPurposes,
  onChainData,
  onChainScript,
  purposeFor,
  purposeMemo,
  PURPOSE_MAX,
  savePurpose,
  withPurposes,
} from './purpose';
import {
  createInvoice,
  invoiceAppLink,
  invoiceLink,
  listIssued,
  matchPayment,
  newInvoiceId,
  notePaidInvoice,
  paidBefore,
  parseInvoiceLink,
  saveIssued,
  setIssuedStatus,
  verifyInvoice,
  type SignedInvoice,
} from './invoice';
import { requestPay, takePay, takePayAmount, takePayExtra } from '../payNav';
import type { HistoryRow } from '../txHistory';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const TX = 'ab'.repeat(32);
const TX2 = 'cd'.repeat(32);

describe('purpose text', () => {
  test('cleans control characters and caps length', () => {
    expect(cleanPurpose('  Rent\n\tMarch  ')).toBe('Rent March');
    expect(cleanPurpose('x'.repeat(PURPOSE_MAX + 50)).length).toBe(PURPOSE_MAX);
    expect(cleanPurpose(undefined)).toBe('');
  });
  test('chips fill or prefix', () => {
    expect(applyChip('', 'Rent')).toBe('Rent');
    expect(applyChip('March', 'Rent')).toBe('Rent · March');
    expect(applyChip('Rent · March', 'Rent')).toBe('Rent · March');
  });
  test('memo carries the invoice id', () => {
    expect(purposeMemo('Logo work', 'INV-ABCDEFGH')).toBe('Invoice INV-ABCDEFGH · Logo work');
    expect(purposeMemo('', undefined)).toBe('');
  });
});

describe('purpose storage', () => {
  test('saved per account, keyed by txid, shown on history rows', () => {
    const s = mem();
    expect(savePurpose('acct', TX, { text: 'Rent · March' }, 10, s)).toBe(true);
    expect(savePurpose('acct', 'not-a-txid', { text: 'x' }, 10, s)).toBe(false);
    expect(savePurpose('acct', TX2, { text: '' }, 10, s)).toBe(false);
    expect(purposeFor('acct', TX.toUpperCase(), s)?.text).toBe('Rent · March');
    expect(purposeFor('other', TX, s)).toBeUndefined();
    savePurpose('acct', TX2, { text: 'Logo', invoiceId: 'INV-ABCDEFGH' }, 11, s);
    const rows = [{ txid: TX }, { txid: TX2 }, { txid: 'ee'.repeat(32) }] as HistoryRow[];
    const out = withPurposes(rows, 'acct', s);
    expect(out.map((r) => r.purpose)).toEqual(['Rent · March', 'Invoice INV-ABCDEFGH · Logo', undefined]);
    expect(Object.keys(loadPurposes('acct', s))).toHaveLength(2);
  });
  test('broken storage reads as empty', () => {
    const s = mem();
    s.setItem('bwallet.purpose.acct', '{not json');
    expect(loadPurposes('acct', s)).toEqual({});
  });
});

describe('on-chain purpose', () => {
  test('one OP_RETURN push that round-trips the UTF-8 text', () => {
    const text = 'Wages · October 💸 '.repeat(20).trim();
    const data = onChainData(text)!;
    const script = onChainScript(data);
    const chunks = script.chunks;
    expect(chunks[0].op).toBe(0);
    expect(chunks[1].op).toBe(0x6a);
    expect(Utils.toUTF8(chunks[2].data!)).toBe(cleanPurpose(text));
    expect(onChainData('   ')).toBeNull();
  });
  test('only for plain-address payments, never send-all', () => {
    expect(canWriteOnChain(['1BoatSLRHtKNngkdXEeobR76b53LETtpyT'], false)).toBe(true);
    expect(canWriteOnChain(['alice@bwalletx.com'], false)).toBe(false);
    expect(canWriteOnChain(['$alice'], false)).toBe(false);
    expect(canWriteOnChain(['1BoatSLRHtKNngkdXEeobR76b53LETtpyT'], true)).toBe(false);
    expect(canWriteOnChain([], false)).toBe(false);
  });
});

describe('invoice links', () => {
  const payeeKey = PrivateKey.fromRandom();
  const wallet = new ProtoWallet(payeeKey);
  const pub = payeeKey.toPublicKey().toString();
  const lookup = async () => pub;
  const make = (f: Partial<Parameters<typeof createInvoice>[1]> = {}) =>
    createInvoice(wallet, { payee: 'Alice@bwalletx.com', usdCents: 1250, purpose: 'Logo work', ...f }, 1000);

  test('ids look right', () => {
    expect(newInvoiceId()).toMatch(/^INV-[A-Z2-9]{8}$/);
  });

  test('sign, link, parse, verify', async () => {
    const s = await make({ due: '2026-11-01' });
    expect(s.inv.payee).toBe('alice@bwalletx.com');
    const link = invoiceLink(s);
    expect(link.startsWith('https://web.bwalletx.com/?invoice=')).toBe(true);
    const back = parseInvoiceLink(link);
    expect(back).toEqual(s);
    expect(parseInvoiceLink(invoiceAppLink(s))).toEqual(s);
    const r = await verifyInvoice(back, lookup);
    expect(r.ok).toBe(true);
  });

  test('tampered amount, payee or purpose is rejected', async () => {
    const s = await make();
    for (const change of [
      { usdCents: 999999 },
      { payee: 'mallory@bwalletx.com' },
      { purpose: 'Something else' },
    ] as Partial<SignedInvoice['inv']>[]) {
      const bad = { ...s, inv: { ...s.inv, ...change } };
      const r = await verifyInvoice(parseInvoiceLink(invoiceLink(bad)), lookup);
      expect(r.ok).toBe(false);
    }
  });

  test("a valid signature from someone else's key is rejected", async () => {
    const s = await make();
    const r = await verifyInvoice(s, async () => PrivateKey.fromRandom().toPublicKey().toString());
    expect(r).toEqual({
      ok: false,
      reason: 'This invoice was not signed by alice@bwalletx.com. Nothing was filled in.',
    });
    const unknown = await verifyInvoice(s, async () => undefined);
    expect(unknown.ok).toBe(false);
  });

  test('junk links are not invoices', () => {
    expect(parseInvoiceLink('https://web.bwalletx.com/?invoice=%%%')).toBeNull();
    expect(parseInvoiceLink('bitcoin:1Boat?amount=1')).toBeNull();
    expect(parseInvoiceLink(null)).toBeNull();
  });

  test('a link with both or neither amount is not an invoice', async () => {
    const s = await make();
    const both = { ...s, inv: { ...s.inv, sats: 5 } };
    expect(parseInvoiceLink(invoiceLink(both))).toBeNull();
  });
});

describe('my invoices', () => {
  test('save, list, mark paid (needs a txid), cancel', async () => {
    const st = mem();
    const w = new ProtoWallet(PrivateKey.fromRandom());
    const a = await createInvoice(w, { payee: 'a@bwalletx.com', sats: 5000, purpose: '' }, 1, 'INV-AAAAAAAA');
    const b = await createInvoice(w, { payee: 'a@bwalletx.com', sats: 7000, purpose: 'x' }, 2, 'INV-BBBBBBBB');
    saveIssued('acct', a, 1, st);
    saveIssued('acct', b, 2, st);
    expect(listIssued('acct', st).map((x) => x.inv.id)).toEqual(['INV-BBBBBBBB', 'INV-AAAAAAAA']);
    expect(setIssuedStatus('acct', 'INV-AAAAAAAA', 'paid', 'nope', 3, st)).toBe(false);
    expect(setIssuedStatus('acct', 'INV-AAAAAAAA', 'paid', TX, 3, st)).toBe(true);
    expect(setIssuedStatus('acct', 'INV-BBBBBBBB', 'cancelled', undefined, 3, st)).toBe(true);
    expect(listIssued('acct', st).map((x) => [x.inv.id, x.status, x.txid])).toEqual([
      ['INV-BBBBBBBB', 'cancelled', undefined],
      ['INV-AAAAAAAA', 'paid', TX],
    ]);
  });

  test('payer side remembers paid invoices', () => {
    const st = mem();
    notePaidInvoice('acct', { id: 'INV-AAAAAAAA', payee: 'a@b.com', txid: TX, at: 1 }, st);
    expect(paidBefore('acct', 'INV-AAAAAAAA', st)?.txid).toBe(TX);
    expect(paidBefore('acct', 'INV-ZZZZZZZZ', st)).toBeUndefined();
  });

  test('matching payments', async () => {
    const w = new ProtoWallet(PrivateKey.fromRandom());
    const { inv } = await createInvoice(w, { payee: 'a@bwalletx.com', sats: 5000, purpose: '' }, 100);
    const rows = [
      { txid: 'old', time: 50, direction: 'in' as const, amountSats: 5000 },
      { txid: 'out', time: 150, direction: 'out' as const, amountSats: -5000 },
      { txid: 'wrong', time: 150, direction: 'in' as const, amountSats: 4999 },
      { txid: 'hit', time: 200, direction: 'in' as const, amountSats: 5000 },
    ];
    expect(matchPayment(inv, rows)).toBe('hit');
    expect(matchPayment(inv, rows, new Set(['hit']))).toBeUndefined();
    const usd = (await createInvoice(w, { payee: 'a@bwalletx.com', usdCents: 1000, purpose: '' }, 100)).inv;
    // $10 at $50/BSV = 0.2 BSV; 1% off still matches, 5% off does not.
    expect(matchPayment(usd, [{ txid: 'u', time: 200, direction: 'in', amountSats: 20_200_000, usdRate: 50 }])).toBe(
      'u',
    );
    expect(
      matchPayment(usd, [{ txid: 'u', time: 200, direction: 'in', amountSats: 21_000_000, usdRate: 50 }]),
    ).toBeUndefined();
  });
});

describe('pre-fill hand-off', () => {
  test('purpose, dollars and invoice travel with requestPay, read once', () => {
    requestPay('alice@bwalletx.com', undefined, {
      purpose: 'Logo work',
      usd: 12.5,
      invoice: { id: 'INV-AAAAAAAA', payee: 'alice@bwalletx.com' },
    });
    expect(takePay()).toBe('alice@bwalletx.com');
    expect(takePayAmount()).toBeNull();
    expect(takePayExtra()).toEqual({
      purpose: 'Logo work',
      usd: 12.5,
      invoice: { id: 'INV-AAAAAAAA', payee: 'alice@bwalletx.com' },
    });
    expect(takePayExtra()).toBeNull();
    requestPay('1Boat', 500);
    takePay();
    expect(takePayExtra()).toBeNull();
  });
});

describe('invoice links in a letter', () => {
  test('found in bMail text, junk ignored', async () => {
    const { findInvoiceLink } = await import('./invoice');
    const w = new ProtoWallet(PrivateKey.fromRandom());
    const s = await createInvoice(w, { payee: 'a@bwalletx.com', sats: 5000, purpose: 'Rent' }, 1);
    const body = `Hi,\nplease pay: ${invoiceLink(s)}\nthanks`;
    expect(findInvoiceLink(body)?.s).toEqual(s);
    expect(findInvoiceLink('https://web.bwalletx.com/?invoice=abc')).toBeNull();
  });
});
