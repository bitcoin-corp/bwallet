import { describe, expect, test } from 'bun:test';
import {
  appendAgentLog,
  cleanLabels,
  DEFAULT_AGENT_DAILY_CAP_USD,
  ledgerSpentToday,
  markAgentAccount,
  spendAllowed,
  spentToday,
  trimLog,
  type AgentAccount,
  type AgentLogEntry,
} from './agentAccounts';

const DAY = Date.UTC(2026, 9, 4, 12);
const acct = (p: Partial<AgentAccount> = {}): AgentAccount => ({
  identityAddress: '1Agent',
  labels: [],
  stopped: false,
  dailyCapUsd: null,
  createdAt: 0,
  ...p,
});
const spend = (usd: number, at = DAY): AgentLogEntry => ({ at, action: 'buy', detail: '', usd });

describe('agent accounts', () => {
  test('only agent accounts that are running may spend', () => {
    expect(spendAllowed(null, false, [], 1, DAY).ok).toBe(false);
    expect(spendAllowed(acct({ stopped: true }), false, [], 1, DAY).ok).toBe(false);
    expect(spendAllowed(acct(), true, [], 1, DAY).ok).toBe(false);
    expect(spendAllowed(acct(), false, [], 1_000_000, DAY).ok).toBe(true); // no cap: the balance is the limit
  });

  test('daily cap counts only today (UTC)', () => {
    const yesterday = DAY - 24 * 3600_000;
    const log = [spend(6), spend(50, yesterday)];
    expect(spentToday(log, DAY)).toBe(6);
    const a = acct({ dailyCapUsd: 10 });
    expect(spendAllowed(a, false, log, 4, DAY).ok).toBe(true);
    const r = spendAllowed(a, false, log, 5, DAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('$4.00 left of $10');
  });

  test('labels are trimmed, deduplicated and capped', () => {
    expect(cleanLabels([' degen ', 'degen', '', 'x'.repeat(40)])).toEqual(['degen', 'x'.repeat(24)]);
    expect(cleanLabels(Array.from({ length: 12 }, (_, i) => `l${i}`))).toHaveLength(8);
  });
});

describe('agent caps cannot be reset by the log (b-Aware, 24 Oct 2026)', () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };

  test('trimming drops zero-dollar entries before spends', () => {
    const log: AgentLogEntry[] = [spend(5), ...Array.from({ length: 600 }, () => ({ ...spend(0), action: 'refused' }))];
    const t = trimLog([...Array.from({ length: 10 }, () => ({ ...spend(0) })), ...log], 500);
    expect(t.length).toBe(500);
    expect(spentToday(t, DAY)).toBe(5);
  });

  test('a flood of refusals leaves today’s spend in the ledger and the log', () => {
    mem.clear();
    appendAgentLog('1Flood', spend(9, DAY));
    for (let i = 0; i < 700; i++) appendAgentLog('1Flood', { ...spend(0, DAY), action: 'refused' });
    expect(ledgerSpentToday('1Flood', DAY)).toBe(9);
    expect(spendAllowed(acct({ dailyCapUsd: 10 }), false, [], 2, DAY, ledgerSpentToday('1Flood', DAY)).ok).toBe(false);
    expect(ledgerSpentToday('1Flood', DAY + 24 * 3600_000)).toBe(0);
  });

  test('new agent accounts start capped; pots do not', () => {
    mem.clear();
    expect(markAgentAccount('1New').dailyCapUsd).toBe(DEFAULT_AGENT_DAILY_CAP_USD);
    expect(markAgentAccount('1Pot', [], Date.now(), { kind: 'pot' }).dailyCapUsd).toBeNull();
  });
});
