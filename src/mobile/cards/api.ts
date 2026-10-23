import validate from 'bitcoin-address-validation';
import { P2PKH, Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';

/**
 * Greeting cards (bwalletx.com/happy-b: Make it → Mint it → Send it → Wear it). Client for the bwalletx-push card
 * service: GET /v1/cards/price, POST /v1/cards/quote, POST /v1/cards/generate. bWalletX only
 * (GREETING_CARDS_ENABLED, storeBuild.ts): the maker is a lazy chunk and never in a store build.
 *
 * Money rule: the amount and the address paid come ONLY from the server's quote, never from anything typed. The
 * user approves one sheet showing both; the wallet then pays quote.sats to quote.payTo and the txid (+ the tx) goes
 * to /generate. A failed generation (502 refundable) gets one free retry with the same quote and txid.
 */

/** Base URL, overridable at build time like the feed API (feed/feedApi.ts). */
declare const __BWX_CARDS_API__: string | undefined;
export const CARDS_API =
  (typeof __BWX_CARDS_API__ === 'string' && __BWX_CARDS_API__.trim()) || 'https://push.bwalletx.com';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const OCCASIONS = ['Birthday', 'Thank you', 'Congrats', 'Just because'] as const;
export type Occasion = (typeof OCCASIONS)[number];
export const MAX_PROMPT = 300;

export type CardKind = { id: string; label: string; sats: number; usd: number };
/** A model / provider the user can pick; `spicy` = it can make 18+ images (bWalletX only, opt-in). */
export type CardModel = { id: string; label: string; sats: number; spicy?: boolean };
export type CardPrice = { kinds: CardKind[]; models?: CardModel[]; payTo: string; expiresAt: string };
/** 'card' = greeting card (occasion + who it's for); 'image' = any picture from a free prompt. */
export type MakeKind = 'card' | 'image';
export type CardQuote = { quoteId: string; sats: number; payTo: string; expiresAt: string };
export type CardResult = { cardId: string; imageUrl: string; sha256: string; mime: string; spicy?: boolean };

export type CardErrorCode =
  | 'unavailable'
  | 'refused'
  | 'generation_failed'
  | 'refund_needed'
  | 'payment_pending'
  | 'bad_quote'
  | 'expired'
  | 'not_sent'
  | 'http';

export class CardError extends Error {
  constructor(
    message: string,
    readonly code: CardErrorCode,
    readonly status = 0,
    /** 502/409 refundable: the user paid and got no card. */
    readonly refundable = false,
    /** 502 {retry:true}: one free retry with the same quoteId + txid is offered. */
    readonly retry = false,
  ) {
    super(message);
    this.name = 'CardError';
  }
}

export const COMING_SOON = 'Cards are coming soon';

/** 422: "This card can't be made: <reason>. Nothing was charged." (no reason: just the first part). */
export const refusedMessage = (reason: unknown): string => {
  const why = (typeof reason === 'string' ? reason : '')
    .trim()
    .replace(/[.!\s]+$/, '')
    .slice(0, 200);
  return why
    ? `This card can't be made: ${why}. Nothing was charged.`
    : "This card can't be made. Nothing was charged.";
};

/** The wallet said the payment was not accepted by the network: nothing left the wallet. */
export const NOT_SENT = "The payment didn't go out. Nothing was charged.";

const call = async <T>(f: Fetch, path: string, body?: unknown): Promise<T> => {
  let r: Response;
  try {
    r = await f(`${CARDS_API}/v1/cards/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new CardError("Couldn't reach the card service. Check your connection.", 'http');
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.ok) return j as T;
  if (r.status === 503) throw new CardError(COMING_SOON, 'unavailable', 503);
  if (r.status === 422) throw new CardError(refusedMessage(j.reason ?? j.error), 'refused', 422);
  if (r.status === 410) throw new CardError('That price ran out. Start again for a new one.', 'expired', 410);
  if (r.status === 402) {
    const msg = String(j.error || j.reason || '');
    const notYet = /not found|not seen|yet/i.test(msg);
    throw new CardError(
      notYet
        ? 'Waiting for the payment to reach the card service…'
        : `The payment didn't match the price. ${msg}`.trim(),
      notYet ? 'payment_pending' : 'http',
      402,
    );
  }
  if (r.status === 502 && j.refundable === true)
    throw new CardError(
      "The card didn't come out. Try again for free.",
      'generation_failed',
      502,
      true,
      j.retry === true,
    );
  if (r.status === 409 && j.refundable === true)
    throw new CardError(
      'Generation failed; contact support@bwalletx.com for a refund.',
      'refund_needed',
      409,
      true,
      false,
    );
  throw new CardError(String(j.error || j.reason || `The card service said ${r.status}`), 'http', r.status);
};

const isSats = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

export const getPrice = async (f: Fetch): Promise<CardPrice> => {
  const p = await call<CardPrice>(f, 'price');
  const kinds = Array.isArray(p?.kinds) ? p.kinds.filter((k) => k && isSats(k.sats)) : [];
  if (!kinds.length) throw new CardError(COMING_SOON, 'unavailable', 503);
  const models = Array.isArray(p?.models)
    ? p.models.filter((m) => m && typeof m.id === 'string' && m.id && isSats(m.sats))
    : [];
  return { ...p, kinds, models };
};

export type QuoteInput = {
  prompt: string;
  kind?: MakeKind;
  model?: string;
  occasion?: Occasion | '';
  to?: string;
  /** Only ever true from the bWalletX 18+ path (spicy.ts); it always travels with adult:true. */
  spicy?: boolean;
};

/** Trim, cap and drop empty optionals. Occasion and "to" belong to cards only. Throws on an empty prompt. */
export const quoteBody = (q: QuoteInput) => {
  const prompt = q.prompt.trim().slice(0, MAX_PROMPT);
  if (!prompt) throw new CardError('Say what it should show.', 'bad_quote');
  const kind = q.kind ?? 'card';
  const to = kind === 'card' ? (q.to ?? '').trim().slice(0, 60) : '';
  return {
    prompt,
    kind,
    ...(q.model ? { model: q.model } : {}),
    ...(kind === 'card' && q.occasion ? { occasion: q.occasion } : {}),
    ...(to ? { to } : {}),
    ...(q.spicy ? { spicy: true, adult: true } : {}),
  };
};

/** The price for this choice: the model's when it has one, else the kind's. */
export const priceFor = (p: CardPrice, kind: MakeKind, model?: string): number | undefined =>
  p.models?.find((m) => m.id === model)?.sats ?? (p.kinds.find((k) => k.id === kind) ?? p.kinds[0])?.sats;

export const getQuote = async (f: Fetch, q: QuoteInput): Promise<CardQuote> => {
  const r = await call<CardQuote>(f, 'quote', quoteBody(q));
  checkQuote(r);
  return r;
};

/**
 * The quote must name a real amount and a real address before anything is shown as payable. `maxSats` (the highest
 * price the user was shown, ×2) stops a server bug or a swapped response from asking for far more than the price;
 * `payTo` (the address /price named) must match the quote's.
 */
export const limitsFrom = (p: CardPrice): QuoteLimits => ({
  maxSats: Math.max(...p.kinds.map((k) => k.sats), ...(p.models ?? []).map((m) => m.sats)) * 2,
  ...(p.payTo ? { payTo: p.payTo } : {}),
});
export type QuoteLimits = { maxSats?: number; payTo?: string };
export function checkQuote(q: CardQuote, limits: QuoteLimits = {}, now = Date.now()): void {
  const { maxSats, payTo } = limits;
  if (!q || typeof q.quoteId !== 'string' || !q.quoteId)
    throw new CardError('The price came back broken.', 'bad_quote');
  if (!isSats(q.sats)) throw new CardError('The price came back broken.', 'bad_quote');
  if (typeof q.payTo !== 'string' || !validate(q.payTo))
    throw new CardError('The payment address came back broken. Nothing was paid.', 'bad_quote');
  if (payTo && q.payTo !== payTo)
    throw new CardError('The payment address changed. Nothing was paid. Start again.', 'bad_quote');
  if (maxSats !== undefined && q.sats > maxSats)
    throw new CardError('The price changed a lot. Start again for a new one.', 'bad_quote');
  if (Date.parse(q.expiresAt) < now) throw new CardError('That price ran out. Get a new one.', 'expired');
}

/** The one output that pays for the card: exactly quote.sats to quote.payTo. Pure. */
export const cardPaymentOutputs = (q: CardQuote) => [
  { lockingScript: new P2PKH().lock(q.payTo).toHex(), satoshis: q.sats, outputDescription: 'Greeting card' },
];

/** What /generate gets: the quote and the txid only. The wallet has broadcast the payment itself. */
export type CardPayment = { quoteId: string; txid: string };

/**
 * Call only after the user pressed Pay on the approval sheet. Pays the quote; returns what /generate needs.
 *
 * Broadcast now (acceptDelayedBroadcast: false): a delayed broadcast waits on a Monitor the web wallet does not run,
 * so the payment sat unsent in the wallet and the card service never saw it (owner, 23 Oct 2026; same bug as the
 * Bureau stamps, bmail/client.ts). The wallet's own report for this txid must not be 'failed' before /generate.
 */
export const payCardQuote = async (
  ctx: Pick<OneSatContext, 'wallet'>,
  q: CardQuote,
  limits: QuoteLimits = {},
): Promise<CardPayment> => {
  checkQuote(q, limits);
  const r = await ctx.wallet.createAction({
    description: 'Greeting card',
    outputs: cardPaymentOutputs(q),
    options: { acceptDelayedBroadcast: false },
  });
  if (!r.txid) throw new Error('The wallet did not return the payment');
  const mine = r.sendWithResults?.find((x) => x.txid === r.txid);
  if (mine?.status === 'failed') throw new CardError(NOT_SENT, 'not_sent');
  return { quoteId: q.quoteId, txid: r.txid };
};

/**
 * A paid card whose payment is still sitting in the wallet unsent (the old delayed broadcast). Ask the wallet to
 * send that exact txid now: createAction with only sendWith, which builds, signs and spends nothing new; the
 * toolbox sends a req in 'unsent'/'nosend'/'sending' and reports one already out as 'unproven'. An unknown txid
 * throws or reports 'failed'. Returns 'sent' (on its way / already out), 'failed' (the network refused it) or
 * 'unknown' (this wallet couldn't say: an older wallet, or not this wallet's payment).
 */
export const sendStuckPayment = async (
  wallet: Pick<OneSatContext['wallet'], 'createAction'>,
  txid: string,
): Promise<'sent' | 'failed' | 'unknown'> => {
  try {
    const r = await wallet.createAction({
      description: 'Greeting card: send payment',
      options: { sendWith: [txid], acceptDelayedBroadcast: false },
    });
    const mine = r.sendWithResults?.find((x) => x.txid === txid);
    if (!mine) return 'unknown';
    return mine.status === 'failed' ? 'failed' : 'sent';
  } catch (e) {
    console.warn('[cards] re-sending the payment failed', e);
    return 'unknown';
  }
};

export const stillWaitingMessage = (txid: string) =>
  `Your payment is still waiting to go out. Open Activity to send or cancel it. Payment ${txid}`;

/** imageUrl is relative (/v1/cards/:id/image): prefix the card service. Only that service's own paths. */
export const cardImageUrl = (u: unknown): string =>
  typeof u === 'string' && /^\/v1\/cards\/[\w-]+\/image$/.test(u) ? `${CARDS_API}${u}` : '';

export const generateCard = async (f: Fetch, p: CardPayment): Promise<CardResult> => {
  const r = await call<CardResult>(f, 'generate', p);
  const imageUrl = cardImageUrl(r?.imageUrl);
  if (!imageUrl)
    throw new CardError("The card didn't come out. Try again for free.", 'generation_failed', 502, true, true);
  return { ...r, imageUrl };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms));
/** "Payment not found yet": the server hasn't seen the tx. Back off for about 60 s before giving up. */
/** About 60 s in all: WhatsOnChain can be slow to see a fresh tx. */
export const PENDING_BACKOFF_MS = [2000, 3000, 5000, 8000, 10000, 12000, 20000];

/**
 * Generate with the paid quote. Network errors and "payment not found yet" retry on their own (generate is safe to
 * repeat: a completed quote returns the same card). `retriesLeft` is the free retry (one) the caller keeps per
 * payment; it is offered only when the server says retry:true, so a second failure never offers "Try again".
 */
export const generateOnce = async (
  f: Fetch,
  p: CardPayment,
  retriesLeft: number,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<{ ok: true; card: CardResult } | { ok: false; error: CardError | Error; canRetry: boolean }> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, card: await generateCard(f, p) };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const transient =
        err instanceof CardError && (err.code === 'payment_pending' || err.code === 'http') && !err.status;
      const pending = err instanceof CardError && err.code === 'payment_pending';
      if ((pending || transient) && attempt < PENDING_BACKOFF_MS.length) {
        await wait(PENDING_BACKOFF_MS[attempt]);
        continue;
      }
      if (pending)
        return {
          ok: false,
          error: new CardError(
            `The card service hasn't seen your payment yet. Reference ${p.quoteId}; contact support@bwalletx.com if it doesn't arrive.`,
            'payment_pending',
            402,
          ),
          canRetry: false,
        };
      const canRetry = err instanceof CardError && err.refundable && err.retry && retriesLeft > 0;
      return { ok: false, error: err, canRetry };
    }
  }
};

export type GenerateResult = Awaited<ReturnType<typeof generateOnce>>;

/**
 * "Finish your card" for a payment made earlier. If the service still hasn't seen the payment, it may be stuck
 * unsent in this wallet: send that txid now and try once more. If it can't be sent, say so (with the txid) and
 * point to Activity, where it can be sent or cancelled.
 */
export const finishInFlight = async (
  f: Fetch,
  wallet: Pick<OneSatContext['wallet'], 'createAction'>,
  p: CardPayment,
  retriesLeft: number,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<GenerateResult> => {
  const first = await generateOnce(f, p, retriesLeft, wait);
  if (first.ok || !(first.error instanceof CardError) || first.error.code !== 'payment_pending') return first;
  const sent = await sendStuckPayment(wallet, p.txid);
  if (sent === 'sent') return generateOnce(f, p, retriesLeft, wait);
  return { ok: false, error: new CardError(stillWaitingMessage(p.txid), 'payment_pending', 402), canRetry: false };
};

/** "Happy birthday, Sam" / "Thank you, Sam" / "Congratulations" … for the mint title. */
export function cardTitle(occasion: Occasion | '' | undefined, to: string | undefined): string {
  const who = (to ?? '').trim().replace(/^[$@]/, '');
  const head =
    occasion === 'Birthday'
      ? 'Happy birthday'
      : occasion === 'Thank you'
        ? 'Thank you'
        : occasion === 'Congrats'
          ? 'Congratulations'
          : occasion === 'Just because'
            ? 'Just because'
            : 'A card';
  return (who ? `${head}, ${who}` : head).slice(0, 100);
}

/** A $name / paymail the NFT send box can resolve, from "Who's it for?" (else ''). */
export const recipientHandle = (to: string | undefined): string => {
  const t = (to ?? '').trim();
  return /^\$[a-z0-9._-]{1,40}$/i.test(t) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : '';
};

/** Download the generated image as a File for the Picture mint, checking it is the image we were promised. */
export async function cardFile(f: Fetch, card: CardResult, title: string): Promise<File> {
  const r = await f(card.imageUrl);
  if (!r.ok) throw new Error("Couldn't download the card");
  const buf = await r.arrayBuffer();
  const digest = Utils.toHex(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))));
  if (card.sha256 && digest !== card.sha256.toLowerCase()) throw new Error("The card didn't download cleanly");
  const mime = card.mime && card.mime.startsWith('image/') ? card.mime : 'image/png';
  const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  return new File([buf], `${title.replace(/[^\w ,'-]/g, '').trim() || 'card'}.${ext}`, { type: mime });
}

/**
 * A paid card that hasn't come out yet ({quoteId, txid, createdAt}), kept in this browser so that if the app closes
 * after paying, the maker offers "Finish your card" (generate is idempotent for a paid quote). Cleared once the
 * card is made or the server says the quote is over (expired / refund needed).
 */
export const INFLIGHT_KEY = 'bwx.cards.inflight';
export const INFLIGHT_MAX_AGE_MS = 7 * 24 * 3600_000;
export type InFlight = CardPayment & { createdAt: number };

export const saveInFlight = (p: CardPayment, now = Date.now(), store: Pick<Storage, 'setItem'> = localStorage) => {
  try {
    store.setItem(INFLIGHT_KEY, JSON.stringify({ quoteId: p.quoteId, txid: p.txid, createdAt: now }));
  } catch {
    /* private mode: the quote id is still shown on errors */
  }
};
export const loadInFlight = (now = Date.now(), store: Pick<Storage, 'getItem'> = localStorage): InFlight | null => {
  try {
    const j = JSON.parse(store.getItem(INFLIGHT_KEY) || 'null') as Partial<InFlight> | null;
    if (!j || typeof j.quoteId !== 'string' || typeof j.txid !== 'string' || typeof j.createdAt !== 'number')
      return null;
    if (!j.quoteId || !/^[0-9a-f]{64}$/i.test(j.txid) || now - j.createdAt > INFLIGHT_MAX_AGE_MS) return null;
    return { quoteId: j.quoteId, txid: j.txid, createdAt: j.createdAt };
  } catch {
    return null;
  }
};
export const clearInFlight = (store: Pick<Storage, 'removeItem'> = localStorage) => {
  try {
    store.removeItem(INFLIGHT_KEY);
  } catch {
    /* nothing kept */
  }
};
/** Stop offering "Finish your card": the card came out, or the quote can never make one now. */
export const inFlightDone = (r: { ok: boolean; error?: Error }) =>
  r.ok || (r.error instanceof CardError && (r.error.code === 'expired' || r.error.code === 'refund_needed'));
