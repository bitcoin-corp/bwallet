import { describe, expect, test } from 'bun:test';
import {
  BOM,
  balances,
  bsvString,
  buildRows,
  csvField,
  filterRange,
  labelFor,
  rangeFor,
  toCsv,
  totals,
  withRates,
  type HistoryRow,
  type RawTx,
} from './txHistory';
import { statementHtml } from './txStatement';

const PAY = '1Pay';
const ORD = '1Ord';
const ID = '1Id';
const own = new Set([PAY, ORD, ID]);
const T0 = Date.UTC(2026, 0, 10) / 1000;

const tx = (txid: string, time: number, vin: RawTx['vin'], vout: [number, string][], script?: string): RawTx => ({
  txid,
  time,
  confirmations: 5,
  blockHeight: 900_000,
  vin,
  vout: vout.map(([sats, a], n) => ({ n, sats, addresses: a ? [a] : [], script: n === 0 ? script : undefined })),
});

// A: someone pays us 10,000 sats.  B: we send 6,000 to 1Bob, change 3,900, fee 100.
// C: self-transfer from pay to ord (1 sat) with change, fee 50.  D: someone pays our identity address.
const A = tx('a'.repeat(64), T0, [{ txid: 'x'.repeat(64), vout: 0 }], [[10_000, PAY]]);
const B = tx(
  'b'.repeat(64),
  T0 + 86400,
  [{ txid: A.txid, vout: 0 }],
  [
    [6_000, '1Bob'],
    [3_900, PAY],
  ],
);
const C = tx(
  'c'.repeat(64),
  T0 + 2 * 86400,
  [{ txid: B.txid, vout: 1 }],
  [
    [1, ORD],
    [3_849, PAY],
  ],
);
const D = tx('d'.repeat(64), T0 + 3 * 86400, [{ txid: 'y'.repeat(64), vout: 3 }], [[500, ID]]);

const rows = buildRows([A, B, C, C, D], own, new Map(), 0);
const byId = (c: string) => rows.find((r) => r.txid === c.repeat(64)) as HistoryRow;

describe('direction classification across own addresses', () => {
  test('de-duplicates a tx seen on two of our addresses', () => {
    expect(rows.length).toBe(4);
    expect(rows[0].txid).toBe(D.txid); // newest first
  });
  test('incoming', () => {
    expect(byId('a')).toMatchObject({ direction: 'in', amountSats: 10_000, feeSats: 0 });
    expect(byId('d')).toMatchObject({ direction: 'in', amountSats: 500 });
  });
  test('outgoing with change and fee', () => {
    expect(byId('b')).toMatchObject({ direction: 'out', amountSats: -6_000, feeSats: 100, counterparty: '1Bob' });
  });
  test('self-transfer between pay and ord', () => {
    expect(byId('c')).toMatchObject({ direction: 'self', amountSats: 0, feeSats: 50, counterparty: '' });
  });
  test('partly funded by others (fee unknown): net change', () => {
    const E = tx(
      'e'.repeat(64),
      T0,
      [
        { txid: A.txid, vout: 0 },
        { txid: 'z'.repeat(64), vout: 0 },
      ],
      [
        [1, ORD],
        [20_000, '1Seller'],
      ],
    );
    const r = buildRows([A, E], own, new Map(), 0).find((x) => x.txid === E.txid);
    expect(r).toMatchObject({ direction: 'out', amountSats: -9_999, feeSats: 0 });
  });
});

describe('totals and balances', () => {
  test('totals', () => {
    expect(totals(rows)).toEqual({ inSats: 10_500, outSats: 6_000, feeSats: 150, netSats: 4_350, count: 4 });
  });
  test('net equals the closing balance (3,849 + 1 + 500)', () => {
    expect(balances(rows, { from: null, to: null })).toEqual({ opening: 0, closing: 4_350 });
  });
  test('opening balance before the range', () => {
    const r = { from: (T0 + 86400) * 1000, to: null };
    expect(balances(rows, r)).toEqual({ opening: 10_000, closing: 4_350 });
  });
});

describe('date ranges', () => {
  const now = Date.UTC(2026, 5, 15, 12);
  test('presets', () => {
    expect(rangeFor('7d', now)).toEqual({ from: now - 7 * 86_400_000, to: now });
    expect(rangeFor('all', now)).toEqual({ from: null, to: null });
    expect(new Date(rangeFor('year', now).from as number).getMonth()).toBe(0);
  });
  test('custom days are inclusive local days', () => {
    const r = rangeFor('custom', now, { from: '2026-01-11', to: '2026-01-12' });
    expect(new Date(r.from as number).getDate()).toBe(11);
    expect(new Date(r.to as number).getHours()).toBe(23);
    const local = (d: number, h: number) => ({ ...rows[0], time: new Date(2026, 0, d, h).getTime() });
    const got = filterRange([local(10, 23), local(11, 0), local(12, 23), local(13, 0)], r);
    expect(got.map((x) => new Date(x.time).getDate())).toEqual([11, 12]);
  });
  test('open-ended custom', () => {
    expect(rangeFor('custom', now, { from: '', to: '' })).toEqual({ from: null, to: null });
  });
});

describe('labels', () => {
  test('from local action descriptions', () => {
    expect(labelFor('out', { description: 'Pot payment: Netflix' })).toBe('pot payment');
    expect(labelFor('out', { description: 'Agent buy' })).toBe('agent spend');
    expect(labelFor('out', { description: 'Tip a post' })).toBe('tip');
    expect(labelFor('out', { description: 'Lock BSV to a post' })).toBe('lock');
    expect(labelFor('out', { labels: ['bsv21'] })).toBe('token transfer');
    expect(labelFor('out', { description: 'Send ordinal' })).toBe('NFT');
    expect(labelFor('out', { description: 'Seal document' })).toBe('seal');
    expect(labelFor('out', { description: 'Indexing fee $402' })).toBe('indexing fee');
    expect(labelFor('in', { description: 'Paymail payment from a@b.c' })).toBe('receive');
    expect(labelFor('out', { kind: 'pot payment', description: 'tip' })).toBe('pot payment');
  });
  test('from the tx', () => {
    const hex = (s: string) => Buffer.from(s).toString('hex');
    const tip = tx('f'.repeat(64), T0, [], [[0, '']], `006a${hex('bChat')}${hex('tip')}`);
    expect(labelFor('out', undefined, tip)).toBe('tip');
    expect(labelFor('in', undefined, C)).toBe('token/NFT');
    expect(labelFor('in', undefined, A)).toBe('receive');
    expect(labelFor('self', undefined)).toBe('self');
  });
  test('paymail sender becomes the counterparty', () => {
    const r = buildRows([A], own, new Map([[A.txid, { description: 'Paymail payment from bob@x.com' }]]), 0)[0];
    expect(r.counterparty).toBe('bob@x.com');
  });
});

describe('CSV', () => {
  test('RFC 4180 escaping', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField(undefined)).toBe('');
    expect(csvField(-5)).toBe('-5');
  });
  test('BOM, header, CRLF and values', () => {
    const csv = toCsv(withRates(rows, new Map(), 50), 'My, "main" acct');
    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'date_iso,date_local,txid,direction,amount_sats,amount_bsv,fee_sats,usd_value,usd_rate,counterparty,label,note,account,block_height,confirmations,category,type,asset_kind,asset_id,asset_symbol,asset_qty,app,app_note,purpose',
    );
    expect(lines.length).toBe(rows.length + 2); // header + rows + trailing empty
    const b = lines.find((l) => l.includes('b'.repeat(64))) as string;
    expect(b).toContain(
      ',out,-6000,-0.00006000,100,0.00,50.00,1Bob,send,USD at current rate,"My, ""main"" acct",900000,5',
    );
  });
  test('bsvString', () => {
    expect(bsvString(123_456_789)).toBe('1.23456789');
    expect(bsvString(-1)).toBe('-0.00000001');
  });
  test('historical rate used when known', () => {
    const r = withRates([byId('a')], new Map([[new Date(A.time! * 1000).toISOString().slice(0, 10), 40]]), 50)[0];
    expect(r).toMatchObject({ usdRate: 40, usdRateIsCurrent: false });
  });
});

describe('statement', () => {
  test('escapes and summarises', () => {
    const html = statementHtml({
      account: '<x>',
      addresses: [PAY],
      range: { from: null, to: null },
      rows,
      opening: 0,
      closing: 4350,
    });
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('0.00004350 BSV');
    expect(html).not.toContain('window.print');
  });
});
