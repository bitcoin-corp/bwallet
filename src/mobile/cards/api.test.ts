import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { P2PKH } from '@bsv/sdk';
import {
  CARDS_API,
  CardError,
  cardImageUrl,
  cardPaymentOutputs,
  cardTitle,
  checkQuote,
  generateOnce,
  getPrice,
  getQuote,
  limitsFrom,
  payCardQuote,
  quoteBody,
  recipientHandle,
  type CardQuote,
} from './api';

const ADDR = '125GFsvYsDtyzGkExfsX8DoHuXu2UsMUEZ';
const OTHER = '18pBoqRpHUYf9udsab5G9LT3vQUPxEyMFf';
const future = () => new Date(Date.now() + 600_000).toISOString();

type Call = { url: string; init?: RequestInit };
const fake = (...responses: [number, unknown][]) => {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(body), { status });
  };
  return { f, calls };
};
const quote = (o: Partial<CardQuote> = {}): CardQuote => ({
  quoteId: 'q1',
  sats: 5000,
  payTo: ADDR,
  expiresAt: future(),
  ...o,
});
const noWait = async () => undefined;

describe('price', () => {
  test('GET /v1/cards/price on the push server', async () => {
    const { f, calls } = fake([200, { kinds: [{ id: 'std', label: 'Card', sats: 5000, usd: 0.25 }], payTo: ADDR }]);
    const p = await getPrice(f);
    expect(calls[0].url).toBe(`${CARDS_API}/v1/cards/price`);
    expect(CARDS_API).toBe('https://push.bwalletx.com');
    expect(calls[0].init?.method).toBe('GET');
    expect(p.kinds[0].sats).toBe(5000);
  });
  test('503 → Cards are coming soon (unavailable)', async () => {
    const { f } = fake([503, {}]);
    const e = await getPrice(f).catch((x) => x);
    expect(e).toBeInstanceOf(CardError);
    expect(e.code).toBe('unavailable');
    expect(e.message).toBe('Cards are coming soon');
  });
  test('no priced kinds is not payable either', async () => {
    const { f } = fake([200, { kinds: [{ id: 'x', label: 'x', sats: 0, usd: 0 }] }]);
    expect((await getPrice(f).catch((x) => x)).code).toBe('unavailable');
  });
});

describe('quote', () => {
  test('POSTs the trimmed prompt, occasion and to', async () => {
    const { f, calls } = fake([200, quote()]);
    await getQuote(f, { prompt: '  a cat  ', occasion: 'Birthday', to: ' Sam ' });
    expect(calls[0].url).toBe(`${CARDS_API}/v1/cards/quote`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      prompt: 'a cat',
      kind: 'card',
      occasion: 'Birthday',
      to: 'Sam',
    });
  });
  test('prompt is capped at 300 and must not be empty', () => {
    expect(quoteBody({ prompt: 'x'.repeat(400) }).prompt).toHaveLength(300);
    expect(() => quoteBody({ prompt: '   ' })).toThrow();
  });
  test('422 shows the moderation reason and says nothing was charged', async () => {
    const { f } = fake([422, { reason: 'No real people', refused: true }]);
    const e = await getQuote(f, { prompt: 'x' }).catch((x) => x);
    expect(e.code).toBe('refused');
    expect(e.message).toBe('No real people. Nothing was charged.');
  });
  test('503 on quote is coming soon too', async () => {
    const { f } = fake([503, {}]);
    expect((await getQuote(f, { prompt: 'x' }).catch((x) => x)).code).toBe('unavailable');
  });
  test('a broken address or amount is refused before anything is payable', async () => {
    for (const bad of [quote({ payTo: 'nope' }), quote({ sats: 0 }), quote({ sats: 1.5 }), quote({ quoteId: '' })]) {
      const { f } = fake([200, bad]);
      expect((await getQuote(f, { prompt: 'x' }).catch((x) => x)).code).toBe('bad_quote');
    }
  });
});

describe('pay: amount and address exactly from the quote', () => {
  test('one output: quote.sats to quote.payTo', () => {
    const outs = cardPaymentOutputs(quote({ sats: 7777 }));
    expect(outs).toHaveLength(1);
    expect(outs[0].satoshis).toBe(7777);
    expect(outs[0].lockingScript).toBe(new P2PKH().lock(ADDR).toHex());
  });
  test('createAction gets the quote outputs and nothing typed', async () => {
    const seen: unknown[] = [];
    const wallet = {
      createAction: async (a: unknown) => {
        seen.push(a);
        return { txid: 'ab'.repeat(32), tx: [1, 2, 3] };
      },
    };
    const p = await payCardQuote({ wallet } as never, quote(), { maxSats: 10_000, payTo: ADDR });
    expect((seen[0] as { outputs: unknown }).outputs).toEqual(cardPaymentOutputs(quote()));
    expect(p).toEqual({ quoteId: 'q1', txid: 'ab'.repeat(32) });
    expect(p).not.toHaveProperty('rawTx');
  });
  test('refuses a quote above twice the shown price, a changed address, or an expired quote', async () => {
    const wallet = { createAction: async () => ({ txid: 'x' }) };
    const lim = limitsFrom({ kinds: [{ id: 'a', label: 'a', sats: 5000, usd: 1 }], payTo: ADDR, expiresAt: '' });
    expect(lim).toEqual({ maxSats: 10_000, payTo: ADDR });
    expect(() => checkQuote(quote({ sats: 10_001 }), lim)).toThrow();
    expect(() => checkQuote(quote({ payTo: OTHER }), lim)).toThrow();
    expect(() => checkQuote(quote({ expiresAt: new Date(Date.now() - 1).toISOString() }), lim)).toThrow();
    let called = false;
    await payCardQuote(
      { wallet: { createAction: async () => ((called = true), { txid: 'x' }) } } as never,
      quote({ sats: 99_999 }),
      lim,
    ).catch(() => undefined);
    expect(called).toBe(false);
    expect(wallet).toBeTruthy();
  });
});

describe('generate', () => {
  const pay = { quoteId: 'q1', txid: 't1' };
  test('relative imageUrl gets the push base; foreign urls are refused', async () => {
    const { f, calls } = fake([200, { cardId: 'c1', imageUrl: '/v1/cards/c1/image', sha256: '', mime: 'image/png' }]);
    const r = await generateOnce(f, pay, 1, noWait);
    expect(calls[0].url).toBe(`${CARDS_API}/v1/cards/generate`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(pay);
    expect(r.ok && r.card.imageUrl).toBe(`${CARDS_API}/v1/cards/c1/image`);
    expect(cardImageUrl('https://evil.example/x.png')).toBe('');
  });
  test('502 retry:true offers the free retry once; the second failure does not', async () => {
    const { f } = fake([502, { refundable: true, retry: true }]);
    const first = await generateOnce(f, pay, 1, noWait);
    expect(first.ok).toBe(false);
    expect(!first.ok && first.canRetry).toBe(true);
    const second = await generateOnce(f, pay, 0, noWait);
    expect(!second.ok && second.canRetry).toBe(false);
  });
  test('502 retry:false offers no retry', async () => {
    const { f } = fake([502, { refundable: true, retry: false }]);
    const r = await generateOnce(f, pay, 1, noWait);
    expect(!r.ok && r.canRetry).toBe(false);
  });
  test('409 refundable after the retry → contact support', async () => {
    const { f } = fake([409, { refundable: true }]);
    const r = await generateOnce(f, pay, 0, noWait);
    expect(!r.ok && (r.error as CardError).code).toBe('refund_needed');
    expect(!r.ok && r.error.message).toContain('support@bwalletx.com');
  });
  test('402 payment not found yet backs off and then succeeds', async () => {
    const waits: number[] = [];
    const { f, calls } = fake(
      [402, { error: 'payment not found yet' }],
      [402, { error: 'payment not found yet' }],
      [200, { cardId: 'c', imageUrl: '/v1/cards/c/image', sha256: '', mime: 'image/png' }],
    );
    const r = await generateOnce(f, pay, 1, async (ms) => void waits.push(ms));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(61_000);
  });
  test('the backoff waits about 60 s in all', async () => {
    const { PENDING_BACKOFF_MS } = await import('./api');
    const total = PENDING_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(55_000);
    expect(total).toBeLessThanOrEqual(65_000);
  });
  test('generate body is {quoteId, txid} only', async () => {
    const { f, calls } = fake([200, { cardId: 'c', imageUrl: '/v1/cards/c/image', sha256: '', mime: 'image/png' }]);
    await generateOnce(f, pay, 1, noWait);
    expect(Object.keys(JSON.parse(String(calls[0].init?.body))).sort()).toEqual(['quoteId', 'txid']);
  });
  test('402 not found for ~60 s gives up with the reference, no retry', async () => {
    const { f } = fake([402, { error: 'payment not found yet' }]);
    const r = await generateOnce(f, pay, 1, noWait);
    expect(!r.ok && r.canRetry).toBe(false);
    expect(!r.ok && r.error.message).toContain('q1');
  });
  test('410 expired, no retry', async () => {
    const { f } = fake([410, {}]);
    const r = await generateOnce(f, pay, 1, noWait);
    expect(!r.ok && (r.error as CardError).code).toBe('expired');
    expect(!r.ok && r.canRetry).toBe(false);
  });
});

describe('titles and recipients', () => {
  test('prefilled mint title', () => {
    expect(cardTitle('Birthday', 'Sam')).toBe('Happy birthday, Sam');
    expect(cardTitle('Thank you', '$sam')).toBe('Thank you, sam');
    expect(cardTitle('', '')).toBe('A card');
  });
  test('only a $name or paymail goes to the send box', () => {
    expect(recipientHandle('$sam')).toBe('$sam');
    expect(recipientHandle('sam@bwalletx.com')).toBe('sam@bwalletx.com');
    expect(recipientHandle('Sam')).toBe('');
  });
});

describe('store gating', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('GREETING_CARDS_ENABLED is the inverse of STORE_BUILD, from the same env', async () => {
    const { GREETING_CARDS_ENABLED, STORE_BUILD } = await import('../storeBuild');
    expect(GREETING_CARDS_ENABLED).toBe(!STORE_BUILD);
    const s = src('../storeBuild.ts');
    expect(cond(s, 'GREETING_CARDS_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('the maker and send are only lazy imports behind the flag, and the tile is gated', () => {
    const m = src('../mint/MintButton.tsx');
    expect(m).toContain("GREETING_CARDS_ENABLED ? lazy(() => import('../cards/CardMaker')) : null");
    expect(m).toContain("GREETING_CARDS_ENABLED ? lazy(() => import('../cards/CardSend')) : null");
    expect(m).not.toMatch(/^import .*cards\//m);
    expect(m).toContain('...(GREETING_CARDS_ENABLED');
  });
});

describe('models, kinds and spicy', () => {
  test('quote carries kind and model; occasion/to only for cards; spicy always with adult', () => {
    expect(quoteBody({ prompt: 'x', kind: 'image', model: 'm2', occasion: 'Birthday', to: 'Sam' })).toEqual({
      prompt: 'x',
      kind: 'image',
      model: 'm2',
    });
    expect(quoteBody({ prompt: 'x', spicy: true })).toMatchObject({ spicy: true, adult: true });
    expect(quoteBody({ prompt: 'x' })).not.toHaveProperty('spicy');
  });
  test('price per model, else per kind; limits cover the dearest model', async () => {
    const { getPrice: gp, priceFor } = await import('./api');
    const { f } = fake([
      200,
      {
        kinds: [
          { id: 'card', label: 'Card', sats: 5000, usd: 0.25 },
          { id: 'image', label: 'Image', sats: 4000, usd: 0.2 },
        ],
        models: [
          { id: 'a', label: 'A', sats: 5000 },
          { id: 'b', label: 'B', sats: 9000, spicy: true },
          { id: '', label: 'bad', sats: 1 },
        ],
        payTo: ADDR,
      },
    ]);
    const p = await gp(f);
    expect(p.models).toHaveLength(2);
    expect(priceFor(p, 'card', 'b')).toBe(9000);
    expect(priceFor(p, 'image')).toBe(4000);
    expect(limitsFrom(p).maxSats).toBe(18_000);
  });
  test('spicy only for a spicy model, never in a store build, on web only after the 18+ setting', async () => {
    const { spicyAvailable, adultSettingShown } = await import('./spicy');
    const hot = { spicy: true };
    expect(spicyAvailable(hot, { web: false, optIn: false, enabled: true })).toBe(true);
    expect(spicyAvailable({ spicy: false }, { web: false, optIn: true, enabled: true })).toBe(false);
    expect(spicyAvailable(hot, { web: true, optIn: false, enabled: true })).toBe(false);
    expect(spicyAvailable(hot, { web: true, optIn: true, enabled: true })).toBe(true);
    expect(spicyAvailable(hot, { web: false, optIn: true, enabled: false })).toBe(false);
    expect(adultSettingShown({ web: true, enabled: false })).toBe(false);
  });
  test('SPICY_ENABLED is the inverse of STORE_BUILD, from the same env', async () => {
    const { SPICY_ENABLED, STORE_BUILD } = await import('../storeBuild');
    expect(SPICY_ENABLED).toBe(!STORE_BUILD);
    const s = readFileSync(new URL('../storeBuild.ts', import.meta.url), 'utf8');
    const cond = (name: string) =>
      (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(s)?.[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    expect(cond('SPICY_ENABLED')).toBe(cond('STORE_BUILD'));
  });
});

describe('in-flight paid quote', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  test('saved after paying, loaded on reopen, cleared when done', async () => {
    const { saveInFlight, loadInFlight, clearInFlight, inFlightDone, INFLIGHT_MAX_AGE_MS } = await import('./api');
    const s = mem();
    const txid = 'ab'.repeat(32);
    saveInFlight({ quoteId: 'q1', txid }, 1000, s);
    expect(loadInFlight(2000, s)).toEqual({ quoteId: 'q1', txid, createdAt: 1000 });
    expect(loadInFlight(1000 + INFLIGHT_MAX_AGE_MS + 1, s)).toBeNull();
    clearInFlight(s);
    expect(loadInFlight(2000, s)).toBeNull();
    s.setItem('bwx.cards.inflight', '{"quoteId":"q","txid":"nothex","createdAt":1}');
    expect(loadInFlight(2, s)).toBeNull();
    expect(inFlightDone({ ok: true })).toBe(true);
    expect(inFlightDone({ ok: false, error: new CardError('x', 'expired') })).toBe(true);
    expect(inFlightDone({ ok: false, error: new CardError('x', 'payment_pending') })).toBe(false);
    expect(inFlightDone({ ok: false, error: new CardError('x', 'generation_failed', 502, true, true) })).toBe(false);
  });
});
