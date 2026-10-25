import { beforeEach, describe, expect, test } from 'bun:test';
import { markAgentAccount, getAgentLog, appendAgentLog } from './agentAccounts';
import {
  checkAgentAction,
  checkRules,
  exampleStrategy,
  getPaperBook,
  loadStrategy,
  paperFill,
  parseStrategy,
  STRATEGY_FORMAT,
  type RuleState,
  type StrategyRules,
} from './strategy';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const NOW = Date.UTC(2026, 9, 4, 12);
const st = (p: Partial<RuleState> = {}): RuleState => ({ spentTodayUsd: 0, spentTotalUsd: 0, ...p });
const rules = (p: Partial<StrategyRules> = {}): StrategyRules => ({
  tokens: ['B0ASEX'],
  actions: ['buy'],
  maxPerTradeUsd: 2,
  ...p,
});

describe('strategy file', () => {
  test('the example round-trips', () => {
    const r = parseStrategy(JSON.stringify(exampleStrategy()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.strategy).toEqual(exampleStrategy());
  });

  test('missing limits are reported, not defaulted', () => {
    const r = parseStrategy({
      format: STRATEGY_FORMAT,
      name: 'x',
      version: '1',
      goals: 'g',
      rules: { tokens: [], actions: ['buy', 'fly'] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toContain('rules.tokens');
      expect(r.errors.join(' ')).toContain('maxPerTradeUsd');
    }
    expect(parseStrategy('{nope').ok).toBe(false);
  });

  test('send needs a send list; unknown fields are dropped', () => {
    const base = {
      format: STRATEGY_FORMAT,
      name: 'x',
      version: '1',
      goals: 'g',
      rules: { tokens: ['A'], actions: ['send'], maxPerTradeUsd: 1 },
    };
    expect(parseStrategy(base).ok).toBe(false);
    const r = parseStrategy({ ...base, evil: 1, rules: { ...base.rules, sendTo: ['a@bwalletx.com'], widen: true } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('evil' in r.strategy).toBe(false);
      expect('widen' in r.strategy.rules).toBe(false);
    }
  });
});

describe('rules', () => {
  test('action, token and per-trade limits', () => {
    expect(checkRules(rules(), { kind: 'buy', token: '$b0asex', usd: 2, priceUsd: 1 }, st()).ok).toBe(true);
    expect(checkRules(rules(), { kind: 'sell', token: 'B0ASEX', usd: 0 }, st())).toMatchObject({
      ok: false,
      rule: 'actions',
    });
    expect(checkRules(rules(), { kind: 'buy', token: 'OTHER', usd: 1 }, st())).toMatchObject({
      ok: false,
      rule: 'tokens',
    });
    expect(checkRules(rules(), { kind: 'buy', token: 'B0ASEX', usd: 2.01 }, st())).toMatchObject({
      ok: false,
      rule: 'maxPerTradeUsd',
    });
    expect(checkRules(rules(), { kind: 'buy', token: 'B0ASEX', usd: -1 }, st()).ok).toBe(false);
  });

  test('day and total limits, price limits', () => {
    const r = rules({ maxPerDayUsd: 5, maxTotalUsd: 10, buyBelowUsd: 0.5 });
    expect(
      checkRules(r, { kind: 'buy', token: 'B0ASEX', usd: 2, priceUsd: 0.4 }, st({ spentTodayUsd: 4 })),
    ).toMatchObject({ rule: 'maxPerDayUsd' });
    expect(
      checkRules(r, { kind: 'buy', token: 'B0ASEX', usd: 2, priceUsd: 0.4 }, st({ spentTotalUsd: 9 })),
    ).toMatchObject({ rule: 'maxTotalUsd' });
    expect(checkRules(r, { kind: 'buy', token: 'B0ASEX', usd: 2, priceUsd: 0.6 }, st())).toMatchObject({
      rule: 'buyBelowUsd',
    });
    expect(checkRules(r, { kind: 'buy', token: 'B0ASEX', usd: 2 }, st())).toMatchObject({ rule: 'buyBelowUsd' });
    const s = rules({ actions: ['sell'], sellAboveUsd: 1 });
    expect(checkRules(s, { kind: 'sell', token: 'B0ASEX', usd: 0, priceUsd: 0.9 }, st())).toMatchObject({
      rule: 'sellAboveUsd',
    });
    expect(checkRules(s, { kind: 'sell', token: 'B0ASEX', usd: 0, priceUsd: 1 }, st()).ok).toBe(true);
  });

  test('send list and stop conditions', () => {
    const r = rules({ actions: ['send'], sendTo: ['Bob@bwalletx.com'] });
    expect(checkRules(r, { kind: 'send', token: 'B0ASEX', usd: 1, to: 'bob@bwalletx.com' }, st()).ok).toBe(true);
    expect(checkRules(r, { kind: 'send', token: 'B0ASEX', usd: 1, to: 'eve@x.com' }, st())).toMatchObject({
      rule: 'sendTo',
    });
    const stop = rules({ stop: { holdTokens: 100, downPct: 30 } });
    expect(checkRules(stop, { kind: 'buy', token: 'B0ASEX', usd: 1 }, st({ holding: 100 }))).toMatchObject({
      rule: 'stop',
    });
    expect(
      checkRules(stop, { kind: 'buy', token: 'B0ASEX', usd: 1 }, st({ startValueUsd: 100, valueUsd: 70 })),
    ).toMatchObject({ rule: 'stop' });
    expect(
      checkRules(stop, { kind: 'buy', token: 'B0ASEX', usd: 1 }, st({ startValueUsd: 100, valueUsd: 71 })).ok,
    ).toBe(true);
  });
});

describe('paper mode', () => {
  test('fills use pretend cash and holdings', () => {
    const b0 = { cashUsd: 10, tokens: {}, spentUsd: 0 };
    const b1 = paperFill(b0, { kind: 'buy', token: '$abc', usd: 4, priceUsd: 0.5 });
    expect(b1).toMatchObject({ ok: true, book: { cashUsd: 6, tokens: { ABC: 8 }, spentUsd: 4 } });
    if (!b1.ok) return;
    expect(paperFill(b1.book, { kind: 'buy', token: 'ABC', usd: 7, priceUsd: 1 }).ok).toBe(false);
    expect(paperFill(b1.book, { kind: 'sell', token: 'ABC', usd: 0, amount: 8, priceUsd: 1 })).toMatchObject({
      ok: true,
      book: { cashUsd: 14 },
    });
    expect(paperFill(b1.book, { kind: 'sell', token: 'ABC', usd: 0, amount: 9, priceUsd: 1 }).ok).toBe(false);
  });

  beforeEach(() => mem.clear());

  test('the gate fills paper trades, never asks to sign, and logs refusals with the rule', () => {
    markAgentAccount('1A', [], NOW);
    loadStrategy(
      '1A',
      { ...exampleStrategy('ABC'), rules: rules({ tokens: ['ABC'], maxTotalUsd: 5 }) },
      'paper',
      undefined,
      NOW,
    );
    expect(checkAgentAction('1A', { kind: 'buy', token: 'ABC', usd: 2, priceUsd: 0.1 }, {}, NOW)).toEqual({
      ok: true,
      paper: true,
    });
    expect(getPaperBook('1A')).toMatchObject({ cashUsd: 98, tokens: { ABC: 20 } });
    checkAgentAction('1A', { kind: 'buy', token: 'ABC', usd: 2, priceUsd: 0.1 }, {}, NOW);
    expect(checkAgentAction('1A', { kind: 'buy', token: 'ABC', usd: 2, priceUsd: 0.1 }, {}, NOW)).toMatchObject({
      ok: false,
      rule: 'maxTotalUsd',
    });
    expect(getAgentLog('1A')[0]).toMatchObject({ action: 'refused', rule: 'maxTotalUsd', usd: 0 });
  });

  test('live mode passes allowed actions to be signed; no strategy = account checks only', () => {
    markAgentAccount('1B', [], NOW);
    expect(checkAgentAction('1B', { kind: 'sell', token: 'ANY', usd: 0 }, {}, NOW)).toEqual({ ok: true, paper: false });
    loadStrategy('1B', { ...exampleStrategy('ABC'), rules: rules({ tokens: ['ABC'] }) }, 'live', undefined, NOW);
    expect(checkAgentAction('1B', { kind: 'buy', token: 'ABC', usd: 1 }, {}, NOW)).toEqual({ ok: true, paper: false });
    expect(checkAgentAction('1B', { kind: 'sell', token: 'ANY', usd: 0 }, {}, NOW).ok).toBe(false);
    expect(checkAgentAction('1Z', { kind: 'buy', token: 'ABC', usd: 1 }, {}, NOW)).toMatchObject({
      ok: false,
      reason: 'Not an agent account',
    });
  });

  test('live stop.holdTokens: unknown holdings refuse, enough holdings stop, fewer pass', () => {
    markAgentAccount('1C', [], NOW);
    loadStrategy(
      '1C',
      { ...exampleStrategy('ABC'), rules: rules({ tokens: ['ABC'], stop: { holdTokens: 100 } }) },
      'live',
      undefined,
      NOW,
    );
    const buy = { kind: 'buy' as const, token: 'ABC', usd: 1 };
    expect(checkAgentAction('1C', buy, {}, NOW)).toMatchObject({ ok: false, rule: 'stop' });
    expect(checkAgentAction('1C', buy, { holding: 100 }, NOW)).toMatchObject({ ok: false, rule: 'stop' });
    expect(checkAgentAction('1C', buy, { holding: 99 }, NOW)).toEqual({ ok: true, paper: false });
  });
});

describe('tickers', () => {
  test('a rule naming a ticker accepts that token by id', () => {
    const id = 'a'.repeat(64) + '_0';
    expect(checkRules(rules(), { kind: 'buy', token: id, ticker: 'B0ASEX', usd: 1 }, st()).ok).toBe(true);
    expect(checkRules(rules(), { kind: 'buy', token: id, ticker: 'FAKE', usd: 1 }, st()).ok).toBe(false);
  });
});

describe('strategy spend ledger (b-Aware: refusal floods must not reset strategy caps)', () => {
  beforeEach(() => mem.clear());
  const spend = (id: string, usd: number, at: number) =>
    appendAgentLog(id, { at, action: 'buy', detail: `Bought for $${usd}`, usd });
  const load = (id: string, at: number) =>
    loadStrategy(
      id,
      {
        ...exampleStrategy('ABC'),
        rules: rules({ tokens: ['ABC'], maxPerTradeUsd: 5, maxPerDayUsd: 5, maxTotalUsd: 8 }),
      },
      'live',
      undefined,
      at,
    );
  const buy = (usd: number) => ({ kind: 'buy' as const, token: 'ABC', usd });

  test('600 refusals (distinct and repeated) leave per-day and total limits holding', () => {
    markAgentAccount('1L', [], NOW);
    load('1L', NOW);
    spend('1L', 4, NOW + 1);
    for (let i = 0; i < 300; i++) checkAgentAction('1L', { kind: 'sell', token: `X${i}`, usd: 0 }, {}, NOW + 2 + i);
    for (let i = 0; i < 300; i++) checkAgentAction('1L', { kind: 'sell', token: 'SAME', usd: 0 }, {}, NOW + 400 + i);
    expect(getAgentLog('1L').length).toBeLessThanOrEqual(500);
    expect(getAgentLog('1L')[0]).toMatchObject({ action: 'refused', repeat: 300 });
    expect(checkAgentAction('1L', buy(2), {}, NOW + 800)).toMatchObject({ ok: false, rule: 'maxPerDayUsd' });
    // Even with the log wiped entirely, the ledger still holds both limits.
    mem.delete('bwallet.agentLog.1L');
    expect(checkAgentAction('1L', buy(2), {}, NOW + 801)).toMatchObject({ ok: false, rule: 'maxPerDayUsd' });
    const tomorrow = NOW + 86_400_000;
    spend('1L', 4, tomorrow);
    mem.delete('bwallet.agentLog.1L');
    expect(checkAgentAction('1L', buy(1), {}, tomorrow + 1)).toMatchObject({ ok: false, rule: 'maxTotalUsd' });
  });

  test('reloading a strategy resets the ledger', () => {
    markAgentAccount('1R', [], NOW);
    load('1R', NOW);
    spend('1R', 5, NOW + 1);
    mem.delete('bwallet.agentLog.1R');
    expect(checkAgentAction('1R', buy(1), {}, NOW + 2)).toMatchObject({ ok: false, rule: 'maxPerDayUsd' });
    const later = NOW + 86_400_000;
    load('1R', later);
    expect(checkAgentAction('1R', buy(5), {}, later + 1)).toEqual({ ok: true, paper: false });
  });
});
