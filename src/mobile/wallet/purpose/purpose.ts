import { Script, Utils } from '@bsv/sdk';
import type { HistoryRow } from '../txHistory';

/**
 * Purpose of payment (owner, 23 Oct 2026): "I want to see a purpose-of-payment field in the wallet when I pay.
 * For many it will just be a few words, like a memo. To us, it's the whole shebang."
 *
 * The text is optional and private by default: it is kept on this device, per account, keyed by txid, and shown
 * again in History, the CSV and the printable statement. It travels to the payee only where an existing channel
 * carries a note (a BRC-169 handle payment's memo), and goes on-chain only when the payer ticks "Also write it
 * on-chain (public)" for a payment to plain addresses. No React, no network.
 */

export const PURPOSE_MAX = 500;
/** Quick picks under the field: tapping one fills it (the text stays editable). */
export const PURPOSE_CHIPS = ['Gift', 'Invoice', 'Wages', 'Rent', 'Refund', 'Dinner', 'Loan'] as const;

/** Trim, drop control characters (newlines become spaces), cap at PURPOSE_MAX characters. */
export const cleanPurpose = (raw: string | null | undefined): string =>
  Array.from(
    (raw ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim(),
  )
    .slice(0, PURPOSE_MAX)
    .join('');

/** A chip tapped: replace an empty field, otherwise put the chip first ("Rent · March"). */
export const applyChip = (current: string, chip: string): string => {
  const c = current.trim();
  if (!c) return chip;
  if (c === chip || c.startsWith(`${chip} · `)) return c;
  return cleanPurpose(`${chip} · ${c}`);
};

export type PurposeRecord = {
  text: string;
  /** Set when this payment paid an invoice (invoice.ts). */
  invoiceId?: string;
  invoicePayee?: string;
  /** The text was also written in an OP_RETURN output of the payment. */
  onChain?: boolean;
  at: number;
};

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = (acct: string) => `bwallet.purpose.${acct}`;
/** Oldest records are dropped past this many (a few hundred KB at most). */
export const MAX_PURPOSES = 2000;

const storage = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const TXID = /^[0-9a-f]{64}$/i;

export const loadPurposes = (acct: string | undefined, s: Store | null = storage()): Record<string, PurposeRecord> => {
  if (!acct || !s) return {};
  try {
    const v = JSON.parse(s.getItem(KEY(acct)) ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, PurposeRecord> = {};
    for (const [txid, r] of Object.entries(v as Record<string, unknown>)) {
      const rec = r as Partial<PurposeRecord> | null;
      if (TXID.test(txid) && rec && typeof rec.text === 'string' && typeof rec.at === 'number')
        out[txid.toLowerCase()] = rec as PurposeRecord;
    }
    return out;
  } catch {
    return {};
  }
};

/** Remember what a payment was for. Returns false when there was nothing to save or storage refused it. */
export const savePurpose = (
  acct: string | undefined,
  txid: string | undefined,
  rec: Omit<PurposeRecord, 'at' | 'text'> & { text: string },
  now = Date.now(),
  s: Store | null = storage(),
): boolean => {
  const text = cleanPurpose(rec.text);
  if (!acct || !s || !txid || !TXID.test(txid) || (!text && !rec.invoiceId)) return false;
  const all = loadPurposes(acct, s);
  all[txid.toLowerCase()] = { ...rec, text, at: now };
  const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at);
  try {
    s.setItem(KEY(acct), JSON.stringify(Object.fromEntries(entries.slice(0, MAX_PURPOSES))));
    return true;
  } catch {
    return false;
  }
};

export const purposeFor = (acct: string | undefined, txid: string, s: Store | null = storage()) =>
  loadPurposes(acct, s)[txid.toLowerCase()];

/** The line History shows: "Rent · March" or "Invoice INV-7K2 · Rent". */
export const purposeLine = (r: Pick<PurposeRecord, 'text' | 'invoiceId'> | undefined): string => {
  if (!r) return '';
  return [r.invoiceId ? `Invoice ${r.invoiceId}` : '', r.text].filter(Boolean).join(' · ');
};

/** History rows with the purpose this device saved for them (History screen, CSV, statement). */
export const withPurposes = (
  rows: HistoryRow[],
  acct: string | undefined,
  s: Store | null = storage(),
): HistoryRow[] => {
  const all = loadPurposes(acct, s);
  if (!Object.keys(all).length) return rows;
  return rows.map((r) => {
    const p = purposeLine(all[r.txid.toLowerCase()]);
    return p ? { ...r, purpose: p } : r;
  });
};

/** The memo a payee sees where the payment channel carries one (BRC-169 handle payments). */
export const purposeMemo = (text: string, invoiceId?: string): string =>
  cleanPurpose([invoiceId ? `Invoice ${invoiceId}` : '', text].filter(Boolean).join(' · '));

/**
 * The OP_RETURN data element for "Also write it on-chain (public)": the UTF-8 text as one hex push, in the shape
 * @1sat/actions sendBsv takes for a data request (`OP_0 OP_RETURN <hex>`). Null when there is nothing to write.
 */
export const onChainData = (text: string): string[] | null => {
  const t = cleanPurpose(text);
  if (!t) return null;
  return [Utils.toHex(Utils.toArray(t, 'utf8'))];
};

/** The locking script sendBsv will build for onChainData (used by tests to prove the round trip). */
export const onChainScript = (data: string[]) => Script.fromASM(`OP_0 OP_RETURN ${data.join(' ')}`);

/** Only plain-address payments can carry the extra OP_RETURN output (handle payments must be the only request). */
export const canWriteOnChain = (targets: string[], sendAll: boolean): boolean =>
  !sendAll && targets.length > 0 && targets.every((t) => !!t && !t.includes('@') && !t.startsWith('$'));
