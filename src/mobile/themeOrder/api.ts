import { buildOrdinalCustomInstructions, ORDINALS_BASKET, P1SAT_PROTOCOL, type OneSatContext } from '@1sat/actions';
import { buildInscriptionScript } from '@1sat/templates';
import { guardedPay, scriptAddress, type Shown } from '../../services/guardedPay';
import type { WalletInterface } from '@bsv/sdk';
import { P2PKH, PublicKey, Random, Utils } from '@bsv/sdk';
import { storeReceiptMap, storeReceiptSvg, STORE_RECEIPT_TYPE, type StoreReceipt } from '../storeReceipt/receipt';
import { BWALLET_PAYMAIL_API } from '../names/config';
import type { Fetch } from '../names/names';
import { signRequest } from '../names/paymail';
import { NO_SEND, releasePayment } from '../chat/roomSpend';
import type { MyOrder, OrderForm } from './form';

/**
 * Client for the theme order server (site/api/theme-orders.js). Every call is signed by the identity key
 * (same BRC-43 scheme as the paymail writes). Payment: the server's quote → ONE approval sheet → the wallet
 * builds the tx without sending it → claim (the server checks outputs + memo, then broadcasts). If the claim
 * fails, the unsent tx is dropped only when the server refused before broadcast and the chain has no copy.
 */

type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

export class ThemeOrderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Orders are closed until the owner sets THEME_ORDER_PAY_ADDRESS on the server. */
export const isNotConfigured = (e: unknown) => e instanceof ThemeOrderError && e.code === 'not_configured';

const MESSAGES: Record<string, string> = {
  not_configured: 'Orders open soon',
  slug_taken: 'That web address is taken. Try another.',
  slug_reserved: 'That web address is reserved.',
  price_unavailable: "Couldn't get the BSV price. Try again in a minute.",
  quote_expired: 'That price ran out. Start again for a new one.',
  broadcast_failed: "The network didn't take the payment. Nothing was paid; try again.",
  underpaid: 'The payment was less than the price. Nothing was paid.',
  memo_missing: "The payment didn't carry the order reference. Nothing was paid.",
  already_owned: 'You already own this theme.',
  pack_not_for_sale: "This theme isn't for sale.",
};

const post = async <T>(f: Fetch, op: string, body: unknown): Promise<T> => {
  if (!BWALLET_PAYMAIL_API) throw new ThemeOrderError('Orders open soon', 'not_configured', 503);
  const r = await f(`${BWALLET_PAYMAIL_API}/api/theme-orders/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = String(j?.error || `http_${r.status}`);
    throw new ThemeOrderError(MESSAGES[code] ?? code, code, r.status);
  }
  return j as T;
};

const sha256Hex = async (bytes: ArrayBuffer) =>
  Utils.toHex(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))));

export type UploadedFile = { path: string; type: string; size: number };

export const uploadFile = async (f: Fetch, wallet: Signer, file: File): Promise<UploadedFile> => {
  const buf = await file.arrayBuffer();
  const signed = await signRequest(wallet, 'theme-orders-upload', { type: file.type, sha256: await sha256Hex(buf) });
  return post<UploadedFile>(f, 'upload', { ...signed, data: Utils.toBase64(Array.from(new Uint8Array(buf))) });
};

export interface Quote {
  quote_id: string;
  outputs: { script: string; satoshis: number }[];
  memo_hex: string;
  usd: number;
  sats: number;
  expires_at: string;
}

/** The signed fields for a new order (strings only, as signedMessage needs). */
export const quoteFields = (form: OrderForm, files: UploadedFile[]): Record<string, string> => ({
  slug: form.slug,
  name: form.name.trim(),
  brand: form.brand.trim(),
  isBrand: form.isBrand ? '1' : '0',
  link: form.link.trim(),
  colours: JSON.stringify(form.colours.map((c) => c.toLowerCase())),
  files: JSON.stringify(files),
  note: form.note.trim(),
  ...(form.proof ? { proof: JSON.stringify({ kind: 'paymail', value: form.proof }) } : {}),
});

export const getQuote = async (f: Fetch, wallet: Signer, fields: Record<string, string>) =>
  post<Quote>(f, 'quote', await signRequest(wallet, 'theme-orders-quote', fields));

/** Renew an edition for another year: a new quote for the same slug. */
export const getRenewQuote = (f: Fetch, wallet: Signer, slug: string) => getQuote(f, wallet, { slug, renew: slug });

/** A $1 store theme; nothing near this is a real price. Editions ($99 a year) get a larger ceiling. */
export const MAX_THEME_BUY_SATS = 20_000_000;
export const MAX_EDITION_SATS = 1_000_000_000;

/** What the Pay sheet shows for a quote: each output as address + sats (refuses a non-P2PKH payment). */
export const quoteShown = (q: Quote): Shown[] =>
  q.outputs.filter((o) => o.satoshis > 1).map((o) => ({ address: scriptAddress(o.script), sats: o.satoshis }));

/** The quote's outputs + the memo as createAction outputs. Pure. */
export const quoteOutputs = (q: Quote) => [
  ...q.outputs.map((o) => ({ lockingScript: o.script, satoshis: o.satoshis, outputDescription: 'Theme edition' })),
  { lockingScript: q.memo_hex, satoshis: 0, outputDescription: 'Theme order reference' },
];

/** Call only after the user pressed Pay on the approval sheet. Returns the order the server recorded. */
export const payQuote = async (ctx: OneSatContext, f: Fetch, q: Quote): Promise<MyOrder> => {
  if (Date.parse(q.expires_at) < Date.now()) throw new ThemeOrderError(MESSAGES.quote_expired, 'quote_expired', 410);
  const outputs = quoteOutputs(q);
  const r = await guardedPay(
    { outputs, shown: quoteShown(q), trust: { kind: 'pinned' }, maxSats: MAX_EDITION_SATS },
    () => ctx.wallet.createAction({ description: 'bWalletX theme edition', outputs, options: NO_SEND }),
  );
  if (!r.tx || !r.txid) throw new Error('The wallet did not return the payment');
  try {
    const signed = await signRequest(ctx.wallet, 'theme-orders-claim', { quote_id: q.quote_id, txid: r.txid });
    const { order } = await post<{ order: MyOrder }>(f, 'claim', { ...signed, rawtx: Utils.toHex(r.tx) });
    return order;
  } catch (e) {
    // The rawtx has left the device. Drop it only on a refusal before broadcast (4xx) that the chain confirms;
    // 'broadcast_failed' (502) can follow a broadcast the network took (tx 877d2505…, 25 Oct 2026): keep it.
    await releasePayment(ctx, r.txid, e);
    throw e;
  }
};

export const myOrders = async (f: Fetch, wallet: Signer) =>
  post<{ orders: MyOrder[]; configured: boolean }>(f, 'mine', await signRequest(wallet, 'theme-orders-mine', {}));

/** Store theme purchases ($1 each, site/lib/themeBuys.js): the same quote → one approval → claim flow. */
export interface BuyQuote extends Quote {
  pack: string;
  /** The Store's receipt for this order (site/lib/storeReceipt.js), signed when the Store key is set. */
  receipt?: StoreReceipt;
}
export const getBuyQuote = async (f: Fetch, wallet: Signer, pack: string) =>
  post<BuyQuote>(f, 'buy-quote', await signRequest(wallet, 'theme-buy-quote', { pack }));

export type BuyResult = { pack: string; txid: string; receipt?: StoreReceipt; receiptSvg?: string };

/**
 * The receipt inscription (storeReceipt/receipt.ts): a 1-sat SVG card to a fresh key of the wallet's own ordinals,
 * as lock receipts and @1sat/actions inscribe do, so it shows in Collectibles. `art` is the shop's picture.
 */
async function receiptOutput(ctx: OneSatContext, r: StoreReceipt, art: string | null) {
  const keyID = `inscribe-${Utils.toHex(Random(8))}`;
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID,
    counterparty: 'self',
    forSelf: true,
  });
  const dest = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress());
  const svg = storeReceiptSvg(r, art);
  const tags = ['type:image/svg+xml', 'origin', STORE_RECEIPT_TYPE];
  const name = `bWalletX receipt · ${r.item.label}`;
  return {
    svg,
    output: {
      lockingScript: buildInscriptionScript(
        dest,
        new TextEncoder().encode(svg),
        'image/svg+xml',
        storeReceiptMap(r),
      ).toHex(),
      satoshis: 1,
      outputDescription: 'Store receipt',
      basket: ORDINALS_BASKET,
      tags,
      customInstructions: buildOrdinalCustomInstructions({ protocolID: P1SAT_PROTOCOL, keyID, tags, name }),
    },
  };
}

/** Call only after the user pressed Pay on the approval sheet. The receipt rides in the same transaction. */
export const payBuyQuote = async (
  ctx: OneSatContext,
  f: Fetch,
  q: BuyQuote,
  opts: { label?: string; art?: string | null } = {},
): Promise<BuyResult> => {
  if (Date.parse(q.expires_at) < Date.now()) throw new ThemeOrderError(MESSAGES.quote_expired, 'quote_expired', 410);
  const receipt =
    q.receipt && q.receipt.order === q.quote_id ? await receiptOutput(ctx, q.receipt, opts.art ?? null) : null;
  const outputs = [
    ...q.outputs.map((o) => ({ lockingScript: o.script, satoshis: o.satoshis, outputDescription: 'Theme' })),
    { lockingScript: q.memo_hex, satoshis: 0, outputDescription: 'Theme purchase reference' },
    ...(receipt ? [receipt.output] : []),
  ];
  const r = await guardedPay(
    { outputs, shown: quoteShown(q), trust: { kind: 'pinned' }, maxSats: MAX_THEME_BUY_SATS },
    () =>
      ctx.wallet.createAction({
        // "Theme purchase · NPG": the history labels it (wallet/txHistory.ts).
        description: `Theme purchase · ${opts.label ?? q.receipt?.item.label ?? q.pack}`,
        outputs,
        options: NO_SEND,
      }),
  );
  if (!r.tx || !r.txid) throw new Error('The wallet did not return the payment');
  try {
    const signed = await signRequest(ctx.wallet, 'theme-buy-claim', { quote_id: q.quote_id, txid: r.txid });
    const { pack } = await post<{ pack: string }>(f, 'buy-claim', { ...signed, rawtx: Utils.toHex(r.tx) });
    return { pack, txid: r.txid, ...(receipt && q.receipt ? { receipt: q.receipt, receiptSvg: receipt.svg } : {}) };
  } catch (e) {
    // Same rule as payQuote: never abort what the server may have broadcast (tx 877d2505…, 25 Oct 2026).
    await releasePayment(ctx, r.txid, e);
    throw e;
  }
};

export const ownedThemes = async (f: Fetch, wallet: Signer) =>
  post<{ packs: string[]; configured: boolean }>(f, 'owned', await signRequest(wallet, 'theme-buy-owned', {}));
