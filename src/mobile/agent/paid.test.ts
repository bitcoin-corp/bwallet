import { describe, expect, test } from 'bun:test';
import {
  paymentFailedText,
  MAX_MESSAGE_SATS,
  bitsignPaidBackend,
  formatPrice,
  parsePrice,
  parseQuote,
  payDecision,
  turnBody,
  freeBody,
  freeFallbackReply,
  FREE_REST_TEXT,
} from './paid';
import { ASK_B_DISCLOSURE, ASK_B_FREE } from './agent';
import { BWALLET_GUIDE as GUIDE } from './guide';
import { consentInfo } from './consent';
import { ADD_ON_PRICE_NOTE } from '../bweb/bweb';
import { addSpend, dayOf, parseAgentPrefs, spentToday } from './agentPrefs';

const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

describe('pricing', () => {
  test('formatPrice is USD first, sats only without a rate', () => {
    expect(formatPrice(1000, 40)).toBe('$0.0004');
    expect(formatPrice(100_000, 40)).toBe('$0.04');
    expect(formatPrice(500, 0)).toBe('500 sats');
    expect(formatPrice(33_334, 30, 0.01)).toBe('$0.01');
    expect(formatPrice(500, 0, 0.01)).toBe('$0.01');
  });

  test('parsePrice: reads usd when present', () => {
    expect(parsePrice({ enabled: true, usd: 0.01, sats: 2000, bsvUsd: 50 }).usd).toBe(0.01);
    expect(parsePrice({ enabled: true, sats: 2000, bsvUsd: 50 }).usd).toBeNull();
    expect(parsePrice({ enabled: true, usd: -1, sats: 2000 }).usd).toBeNull();
  });
  test('parsePrice: disabled unless a sane positive price', () => {
    expect(parsePrice({ enabled: true, sats: 2000, bsvUsd: 40, model: 'm' }).enabled).toBe(true);
    expect(parsePrice({ enabled: true, sats: 0 }).enabled).toBe(false);
    expect(parsePrice({ enabled: true, sats: MAX_MESSAGE_SATS + 1 }).enabled).toBe(false);
    expect(parsePrice(null).reason).toBeTruthy();
  });

  test('parseQuote validates id, amount, address and expiry', () => {
    const now = 1_000;
    const ok = { quoteId: 'q-12345678', sats: 1500, payTo: ADDR, expiresAt: now + 60_000 };
    expect(parseQuote(ok, now)).toEqual(ok);
    expect(() => parseQuote({ ...ok, payTo: 'bc1qxyz' }, now)).toThrow();
    expect(() => parseQuote({ ...ok, sats: -1 }, now)).toThrow();
    expect(() => parseQuote({ ...ok, expiresAt: now - 1 }, now)).toThrow();
    expect(() => parseQuote({ ...ok, quoteId: '../x' }, now)).toThrow();
  });
});

describe('payDecision', () => {
  test('daily limit is absolute; one-click decides auto vs confirm', () => {
    let asked = 0;
    const yes = () => (asked++, true);
    expect(payDecision(1000, 0, 0, yes)).toEqual({ kind: 'refuse', reason: 'limit-off' });
    expect(payDecision(1000, 10_000, 9_500, yes)).toEqual({ kind: 'refuse', reason: 'over-daily' });
    expect(asked).toBe(0); // a refused message never uses a one-click slot
    expect(payDecision(1000, 10_000, 0, yes)).toEqual({ kind: 'auto' });
    expect(payDecision(1000, 10_000, 0, () => false)).toEqual({ kind: 'confirm' });
    expect(payDecision(MAX_MESSAGE_SATS + 1, 1e9, 0, yes).kind).toBe('refuse');
  });

  test('spend ledger resets each day', () => {
    const t = new Date(2026, 9, 2, 12).getTime();
    const l = addSpend(addSpend(null, 500, t), 700, t);
    expect(spentToday(l, t)).toBe(1200);
    expect(spentToday(l, t + 86_400_000)).toBe(0);
    expect(l.day).toBe(dayOf(t));
  });
});

describe('paid backend', () => {
  test('never sends a provider key; only quote, txid, transcript and guide', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const be = bitsignPaidBackend(async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.endsWith('/quote'))
        return { quoteId: 'q-12345678', sats: 1000, payTo: ADDR, expiresAt: Date.now() + 1e5 };
      if (path.endsWith('/turn')) return { text: ' hi ' };
      return { enabled: true, sats: 1000 };
    });
    const q = await be.quote([{ role: 'user', text: 'hey' }]);
    expect(await be.turn(q, 'tx', [{ role: 'user', text: 'hey' }], 'GUIDE')).toBe('hi');
    expect(calls.map((c) => c.path)).toEqual(['/api/bitsign/agent/quote', '/api/bitsign/agent/turn']);
    expect(Object.keys(turnBody(q, 'tx', [], 'g')).sort()).toEqual(['client', 'messages', 'quoteId', 'system', 'txid']);
    expect(turnBody(q, 'tx', [], 'g').client).toEqual({ platform: 'web' });
    expect(turnBody(q, 'tx', [], 'g', '0100beef').beef).toBe('0100beef');
    expect(Object.keys(turnBody(q, 'tx', [], 'g', 'not hex!'))).not.toContain('beef');
    await be.turn(q, 'tx', [{ role: 'user', text: 'hey' }], 'GUIDE', 'ABCDEF');
    expect((calls[2].body as { beef?: string }).beef).toBe('ABCDEF');
    expect(JSON.stringify(calls)).not.toMatch(/sk-|api[_-]?key/i);
  });
});

describe('free Ask b', () => {
  test('is on, with no price talk either way, and the chats are disclosed once plainly', () => {
    expect(ASK_B_FREE).toBe(true);
    expect(ADD_ON_PRICE_NOTE).toBe('No extra charge');
    expect(ASK_B_DISCLOSURE).toBe(
      "I'm b, the bWalletX team. We read these chats to fix bugs and improve b. Don't share your recovery phrase or passwords.",
    );
    expect(GUIDE).not.toMatch(/free for now/i);
    expect(GUIDE).toMatch(/no charge to talk to b/);
    expect(consentInfo('paid').summary).toMatch(/reads and keeps conversations with b for up to 180 days/);
  });
  test('a free turn calls /agent/free only: no quote, no txid, no payment, never a key', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const be = bitsignPaidBackend(async (_m, path, body) => {
      calls.push({ path, body });
      return { text: ' sure ', free: true, remaining: 49 };
    });
    expect(await be.free([{ role: 'user', text: 'hey' }], 'GUIDE')).toBe('sure');
    expect(calls.map((c) => c.path)).toEqual(['/api/bitsign/agent/free']);
    expect(Object.keys(freeBody([], 'g')).sort()).toEqual(['client', 'messages', 'system']);
    expect(JSON.stringify(calls)).not.toMatch(/quoteId|txid|beef|sk-|api[_-]?key/i);
  });
  test('when b needs a rest, the report still goes through', () => {
    expect(FREE_REST_TEXT).toMatch(/Bug reports still go through/);
    expect(freeFallbackReply(FREE_REST_TEXT, 'Logged as #F-12.')).toBe(`${FREE_REST_TEXT}\n\nLogged as #F-12.`);
    expect(freeFallbackReply(null, 'Logged.')).toMatch(
      /^b can't answer just now, but your message was passed to the team\.\n\nLogged\.$/,
    );
  });
});

describe('agent prefs', () => {
  test('bad stored values fall back to defaults', () => {
    const p = parseAgentPrefs({ mode: 'free', provider: 'x', dailyLimitCents: 7, models: { openai: 'bad model!' } });
    expect(p.mode).toBe('paid');
    expect(p.provider).toBe('anthropic');
    expect(p.dailyLimitCents).toBe(100);
    expect(p.models.openai).toBe('gpt-5-mini');
  });
});

describe('tell b without a key (14 Oct 2026)', () => {
  test('parses the ack and ref; an error body throws its message', async () => {
    const { parseReport, noKeyReply } = await import('./paid');
    expect(parseReport({ ok: true, id: 12, ref: '#F-12', ack: 'Passed to the team as #F-12.' })).toEqual({
      ok: true,
      ack: 'Passed to the team as #F-12.',
      ref: '#F-12',
    });
    expect(parseReport({ ok: false, ack: "I couldn't log that just now." }).ok).toBe(false);
    expect(() => parseReport({ error: 'Unauthorized' })).toThrow('Unauthorized');
    expect(noKeyReply({ ok: true, ack: 'Logged.' }, 'Claude')).toContain('Settings › b agent');
  });
});

describe('paymentFailedText', () => {
  test('names the reason and says the message was not sent', () => {
    const t = paymentFailedText(
      new Error('WERR_REVIEW_ACTIONS: Undelayed createAction or signAction results require review.'),
    );
    expect(t).toStartWith("Payment didn't go through: ");
    expect(t).toContain('earlier payment');
    expect(t).toEndWith("Your message wasn't sent.");
    expect(paymentFailedText('Insufficient funds in the available inputs')).toContain('not enough spendable BSV');
    expect(paymentFailedText('An unknown error has occurred! Try again.')).toContain('gave no reason');
    expect(paymentFailedText(new Error('Balance timed out after 15 s'))).toContain('took too long');
    expect(paymentFailedText('Broadcast failed: mempool conflict!')).toContain('Broadcast failed: mempool conflict.');
  });
});
