/**
 * Transaction history for one account: pure helpers (no network, no DOM) so they are unit-tested.
 *
 * The chain is the source of truth: every tx that touched any of the account's addresses (pay, ord/token,
 * identity) comes from WhatsOnChain (txHistoryFetch.ts). Amounts are worked out here from the outputs, and
 * from our own earlier outputs that a tx spends (any coin we spend was paid to one of our addresses, so it is
 * in the same history). Labels come from what the app logged locally (wallet action descriptions/labels, pot
 * payments) and from the tx itself (bChat tip/like OP_RETURN, 1-sat outputs).
 */

import type { Asset, Category, EventType } from './historyEvents';

export type Direction = 'in' | 'out' | 'self';

/** A tx as fetched (WhatsOnChain /txs shape, trimmed). */
export type RawTx = {
  txid: string;
  /** Unix seconds; undefined while unconfirmed. */
  time?: number;
  blockHeight?: number;
  confirmations?: number;
  /** `pubkey`: the public key a P2PKH input revealed when it was spent (airdrops: who sent it, airdrops/sender.ts). */
  vin: { txid?: string; vout?: number; coinbase?: string; pubkey?: string }[];
  vout: { n: number; sats: number; addresses: string[]; script?: string }[];
};

/** What the app knows about a txid from its own records. */
export type LocalInfo = {
  description?: string;
  labels?: string[];
  kind?: string;
  /**
   * The BRC-100 wallet's own net change for this action (listActions `satoshis`: + in, - out, fee included).
   * The wallet's coins sit on keys it derives per payment, not on the account's fixed addresses, so for a
   * tx it funded this is the only place the amount shows up.
   */
  satoshis?: number;
};

export type HistoryRow = {
  txid: string;
  /** Unix ms (now for unconfirmed). */
  time: number;
  direction: Direction;
  /** Value that crossed the account's boundary, fee excluded: + in, - out, 0 self. */
  amountSats: number;
  /** Fee this account paid (0 when it did not fund the tx or the inputs are not all ours). */
  feeSats: number;
  counterparty: string;
  label: string;
  note: string;
  blockHeight?: number;
  confirmations: number;
  usdRate?: number;
  /** True when usdRate is today's price, not the price on the day. */
  usdRateIsCurrent?: boolean;
  /** History v2 (historyEvents.ts): what it was, the token/NFT involved and the app that asked for it. */
  category?: Category;
  type?: EventType;
  asset?: Asset;
  app?: string;
  /** What the app said about the payment ("round 12 won"), from a `game:` / `app:` description or label. */
  appNote?: string;
  /** What the payer said it was for (purpose/purpose.ts), saved on this device when it was sent. */
  purpose?: string;
};

const SAT = 100_000_000;

/** Map of `txid:vout` → output (sats + address) for every output paid to one of our addresses. */
export const ownOutputs = (txs: RawTx[], own: Set<string>) => {
  const m = new Map<string, { sats: number; address: string }>();
  for (const t of txs)
    for (const o of t.vout) {
      const a = o.addresses.find((x) => own.has(x));
      if (a) m.set(`${t.txid}:${o.n}`, { sats: o.sats, address: a });
    }
  return m;
};

const hexOf = (s: string) =>
  Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const BCHAT_HEX = hexOf('bChat');
const TIP_HEX = hexOf('tip');
const LIKE_HEX = hexOf('like');

/** Pick a label. Local records win, then what the tx itself shows, then the direction. */
export const labelFor = (direction: Direction, local: LocalInfo | undefined, tx?: RawTx): string => {
  const kind = local?.kind;
  if (kind) return kind;
  const text = `${local?.description ?? ''} ${(local?.labels ?? []).join(' ')}`.toLowerCase();
  const rules: [RegExp, string][] = [
    // Store purchases (themeOrder/api.ts: "Theme purchase · NPG"), with the receipt in the same tx.
    [/^\s*theme purchase\b|store receipt/, 'theme purchase'],
    [/\bpots?\b|subscription|standing order/, 'pot payment'],
    [/\bagent\b/, 'agent spend'],
    [/\blike\b/, 'like'],
    [/\btip\b/, 'tip'],
    [/\bseal/, 'seal'],
    [/index(ing)? fee|\bindex\b|\$402|path402/, 'indexing fee'],
    // Lock BSV (locks/lockApi.ts and @1sat/actions lockBsv / unlockBsv). "Lock BSV to a post" stays social.
    [/^\s*lock bsv in \d+ output|lock receipt/, 'time lock'],
    [/\bunlock \d+ lock/, 'lock claimed'],
    [/\block\b/, 'lock'],
    [/opns|\$name|handle/, 'name'],
    [/listing|\bbuy\b|purchase|\bsale\b/, 'market'],
    [/ordinal|inscri|\bnft\b|1sat ord/, 'NFT'],
    [/bsv-?21|bsv-?20|token/, 'token transfer'],
    [/paymail/, direction === 'in' ? 'receive' : 'send'],
  ];
  for (const [re, l] of rules) if (re.test(text)) return l;
  if (tx) {
    for (const o of tx.vout) {
      const s = (o.script ?? '').toLowerCase();
      if (s.includes(BCHAT_HEX)) {
        if (s.includes(LIKE_HEX)) return 'like';
        if (s.includes(TIP_HEX)) return 'tip';
      }
    }
    if (tx.vout.some((o) => o.sats === 1 && o.addresses.length > 0)) return 'token/NFT';
  }
  return direction === 'in' ? 'receive' : direction === 'out' ? 'send' : 'self';
};

/** Work out direction, amount, fee and counterparty of one tx for the account. */
export const classify = (
  tx: RawTx,
  own: Set<string>,
  prev: Map<string, { sats: number; address: string }>,
  local?: LocalInfo,
  now = Date.now(),
  inputValues?: Map<string, number>,
): HistoryRow => {
  let ownIn = 0;
  let allInputsOwn = tx.vin.length > 0;
  for (const i of tx.vin) {
    const p = i.txid !== undefined && i.vout !== undefined ? prev.get(`${i.txid}:${i.vout}`) : undefined;
    if (p) ownIn += p.sats;
    else allInputsOwn = false;
  }
  let ownOut = 0;
  let extOut = 0;
  let totalOut = 0;
  let counterparty = '';
  for (const o of tx.vout) {
    totalOut += o.sats;
    if (o.addresses.some((a) => own.has(a))) ownOut += o.sats;
    else if (o.sats > 0 || o.addresses.length) {
      extOut += o.sats;
      if (!counterparty && o.addresses[0]) counterparty = o.addresses[0];
    }
  }
  const fee = allInputsOwn ? Math.max(0, ownIn - totalOut) : 0;
  let direction: Direction;
  let amountSats: number;
  if (ownIn === 0) {
    direction = 'in';
    amountSats = ownOut;
    counterparty = '';
  } else if (allInputsOwn && extOut === 0) {
    direction = 'self';
    amountSats = 0;
    counterparty = '';
  } else {
    // We funded at least part of it. Net change to the account, fee shown separately when known.
    const net = ownOut - ownIn + fee;
    direction = net >= 0 ? 'in' : 'out';
    amountSats = net;
  }
  // The BRC-100 wallet funded it from its derived keys (nothing spent from our fixed addresses): the wallet's
  // own figure is the balance change. Fee = inputs - outputs when every input's value is known.
  if (ownIn === 0 && local?.satoshis !== undefined && local.satoshis !== 0) {
    let inSum = 0;
    let known = tx.vin.length > 0;
    for (const i of tx.vin) {
      const v = i.txid !== undefined && i.vout !== undefined ? inputValues?.get(`${i.txid}:${i.vout}`) : undefined;
      if (v === undefined) known = false;
      else inSum += v;
    }
    const net = local.satoshis;
    const walletFee = net < 0 && known ? Math.max(0, Math.min(-net, inSum - totalOut)) : 0;
    direction = net >= 0 ? 'in' : 'out';
    amountSats = net + walletFee;
    return {
      txid: tx.txid,
      time: tx.time ? tx.time * 1000 : now,
      direction,
      amountSats,
      feeSats: walletFee,
      counterparty: net < 0 ? counterparty : '',
      label: labelFor(direction, local, tx),
      note: local.description ?? '',
      blockHeight: tx.blockHeight,
      confirmations: tx.confirmations ?? 0,
    };
  }
  const fromMatch = local?.description?.match(/from\s+(\S+@\S+|\$\S+)/i);
  if (direction === 'in' && fromMatch) counterparty = fromMatch[1];
  return {
    txid: tx.txid,
    time: tx.time ? tx.time * 1000 : now,
    direction,
    amountSats,
    feeSats: fee,
    counterparty,
    label: labelFor(direction, local, tx),
    note: local?.description ?? '',
    blockHeight: tx.blockHeight,
    confirmations: tx.confirmations ?? 0,
  };
};

/** Newest first; txs seen on several of our addresses appear once. */
export const buildRows = (
  txs: RawTx[],
  own: Set<string>,
  local: Map<string, LocalInfo>,
  now = Date.now(),
  /** Values of other outputs our txs spend (`txid:vout` → sats), for the fee of wallet-funded txs. */
  extraValues: Map<string, number> = new Map(),
) => {
  const uniq = new Map<string, RawTx>();
  for (const t of txs) if (!uniq.has(t.txid)) uniq.set(t.txid, t);
  const list = [...uniq.values()];
  const prev = ownOutputs(list, own);
  const values = new Map(extraValues);
  for (const t of list) for (const o of t.vout) values.set(`${t.txid}:${o.n}`, o.sats);
  return list.map((t) => classify(t, own, prev, local.get(t.txid), now, values)).sort((a, b) => b.time - a.time);
};

/** Txs the wallet funded whose inputs come from txs we have not loaded: fetch these to know the fee. */
export const missingParents = (txs: RawTx[], local: Map<string, LocalInfo>) => {
  const have = new Set(txs.map((t) => t.txid));
  const need = new Set<string>();
  for (const t of txs)
    if ((local.get(t.txid)?.satoshis ?? 0) < 0)
      for (const i of t.vin) if (i.txid && !have.has(i.txid)) need.add(i.txid);
  return [...need];
};

/** The "for N sats" a purchase description states: a cross-check only, never the amount. */
export const statedPriceSats = (description: string | undefined) => {
  const m = description?.match(/\bfor (\d+) sats?\b/i);
  return m ? Number(m[1]) : undefined;
};

// ─── Date ranges ─────────────────────────────────────────────────────────────

export type RangePreset = '7d' | '30d' | 'year' | 'all' | 'custom';
export type Range = { from: number | null; to: number | null };

const DAY = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** From/to (ms, inclusive). Custom days are local calendar days, `to` covers the whole day. */
export const rangeFor = (preset: RangePreset, now: number, custom?: { from?: string; to?: string }): Range => {
  if (preset === '7d') return { from: now - 7 * DAY, to: now };
  if (preset === '30d') return { from: now - 30 * DAY, to: now };
  if (preset === 'year') return { from: new Date(new Date(now).getFullYear(), 0, 1).getTime(), to: now };
  if (preset === 'all') return { from: null, to: null };
  const day = (s?: string) => {
    const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
  };
  const f = day(custom?.from);
  const t = day(custom?.to);
  return { from: f === null ? null : startOfDay(f), to: t === null ? null : t + DAY - 1 };
};

export const inRange = (time: number, r: Range) =>
  (r.from === null || time >= r.from) && (r.to === null || time <= r.to);
export const filterRange = (rows: HistoryRow[], r: Range) => rows.filter((x) => inRange(x.time, r));

// ─── Totals ──────────────────────────────────────────────────────────────────

export type Totals = { inSats: number; outSats: number; feeSats: number; netSats: number; count: number };

export const totals = (rows: HistoryRow[]): Totals => {
  let inSats = 0;
  let outSats = 0;
  let feeSats = 0;
  for (const r of rows) {
    if (r.amountSats > 0) inSats += r.amountSats;
    else outSats += -r.amountSats;
    feeSats += r.feeSats;
  }
  return { inSats, outSats, feeSats, netSats: inSats - outSats - feeSats, count: rows.length };
};

/** Balance change of one row (fee included). */
export const netOf = (r: HistoryRow) => r.amountSats - r.feeSats;

/** Opening / closing balance for a range, from the full history (all rows, any order). */
export const balances = (all: HistoryRow[], r: Range) => {
  let opening = 0;
  let inside = 0;
  for (const x of all) {
    if (r.from !== null && x.time < r.from) opening += netOf(x);
    else if (inRange(x.time, r)) inside += netOf(x);
  }
  return { opening, closing: opening + inside };
};

// ─── Prices ──────────────────────────────────────────────────────────────────

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The rate on `day`, else on the nearest earlier day we have (never a later one). */
export const nearestPrevious = (rates: Map<string, number>, day: string): number | undefined => {
  const hit = rates.get(day);
  if (hit !== undefined) return hit;
  let best: string | undefined;
  for (const k of rates.keys()) if (k < day && (best === undefined || k > best)) best = k;
  return best === undefined ? undefined : rates.get(best);
};

/** Fill usdRate from daily rates (UTC day → $; a missing day uses the nearest earlier one), else today's rate flagged as current. */
export const withRates = (rows: HistoryRow[], daily: Map<string, number>, current: number): HistoryRow[] =>
  rows.map((r) => {
    const d = nearestPrevious(daily, dayKey(r.time));
    if (d) return { ...r, usdRate: d, usdRateIsCurrent: false };
    return current > 0 ? { ...r, usdRate: current, usdRateIsCurrent: true } : r;
  });

export const ratesByDay = (list: { time: number; rate: number }[]) => {
  const m = new Map<string, number>();
  for (const x of list) if (x.rate > 0) m.set(dayKey(x.time * 1000), x.rate);
  return m;
};

// ─── CSV ─────────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  'date_iso',
  'date_local',
  'txid',
  'direction',
  'amount_sats',
  'amount_bsv',
  'fee_sats',
  'usd_value',
  'usd_rate',
  'counterparty',
  'label',
  'note',
  'account',
  'block_height',
  'confirmations',
  'category',
  'type',
  'asset_kind',
  'asset_id',
  'asset_symbol',
  'asset_qty',
  'app',
  'app_note',
  'purpose',
] as const;

/** RFC 4180 field: quote when it holds a comma, quote, CR or LF; double inner quotes. */
export const csvField = (v: string | number | undefined | null): string => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const bsvString = (sats: number) => {
  const neg = sats < 0;
  const a = Math.abs(Math.round(sats));
  const s = `${Math.floor(a / SAT)}.${String(a % SAT).padStart(8, '0')}`;
  return neg ? `-${s}` : s;
};

export const usdValue = (r: HistoryRow) =>
  r.usdRate === undefined ? '' : ((r.amountSats / SAT) * r.usdRate).toFixed(2).replace(/^-0\.00$/, '0.00');

const localDate = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const BOM = '﻿';

/** UTF-8 CSV with a BOM (Excel then reads it as UTF-8), CRLF line ends per RFC 4180. */
export const toCsv = (rows: HistoryRow[], account: string): string => {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const note = [r.note, r.usdRateIsCurrent ? 'USD at current rate' : ''].filter(Boolean).join('; ');
    lines.push(
      [
        new Date(r.time).toISOString(),
        localDate(r.time),
        r.txid,
        r.direction,
        r.amountSats,
        bsvString(r.amountSats),
        r.feeSats,
        usdValue(r),
        r.usdRate === undefined ? '' : r.usdRate.toFixed(2),
        r.counterparty,
        r.label,
        note,
        account,
        r.blockHeight ?? '',
        r.confirmations,
        r.category ?? '',
        r.type ?? '',
        r.asset?.kind ?? '',
        r.asset?.id ?? '',
        r.asset?.symbol ?? '',
        r.asset?.qty ?? '',
        r.app ?? '',
        r.appNote ?? '',
        r.purpose ?? '',
      ]
        .map(csvField)
        .join(','),
    );
  }
  return BOM + lines.join('\r\n') + '\r\n';
};

export const fileStem = (account: string, r: Range) => {
  const d = (t: number | null) => (t === null ? '' : new Date(t).toISOString().slice(0, 10));
  const span = r.from === null && r.to === null ? 'all-time' : `${d(r.from) || 'start'}_to_${d(r.to) || 'now'}`;
  return `bwallet-${account.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'account'}-${span}`;
};
