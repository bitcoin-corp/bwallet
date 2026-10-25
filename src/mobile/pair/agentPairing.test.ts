import { beforeEach, describe, expect, test } from 'bun:test';
import { markAgentAccount } from '../agents/agentAccounts';
import { AgentCallError, checkGrant, makeGrant, MAX_GRANT_DAYS } from './agentPairing';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
const NOW = Date.UTC(2026, 9, 5);
const code = (f: () => void) => {
  try {
    f();
    return 'OK';
  } catch (e) {
    return (e as AgentCallError).code;
  }
};

describe('CLI pairing grants', () => {
  beforeEach(() => {
    mem.clear();
    markAgentAccount('1A', [], NOW);
  });

  test('read is always granted; expiry is capped at 30 days', () => {
    const g = makeGrant('1A', 'trader', ['trade'], 365, NOW);
    expect(g.scopes).toEqual(['read', 'trade']);
    expect(g.expiresAt).toBe(NOW + MAX_GRANT_DAYS * 86_400_000);
  });

  test('scope, expiry, open account and agent status are all checked', () => {
    const g = makeGrant('1A', 'trader', ['trade'], 7, NOW);
    expect(code(() => checkGrant(g, 'buy', '1A', NOW))).toBe('OK');
    expect(code(() => checkGrant(g, 'send', '1A', NOW))).toBe('SCOPE');
    expect(code(() => checkGrant(g, 'balance', '1B', NOW))).toBe('NOT_OPEN');
    expect(code(() => checkGrant(g, 'balance', '1A', NOW + 8 * 86_400_000))).toBe('EXPIRED');
    expect(code(() => checkGrant(g, 'mint', '1A', NOW))).toBe('SCOPE');
    expect(code(() => checkGrant(g, 'nope', '1A', NOW))).toBe('UNKNOWN');
    expect(code(() => checkGrant(makeGrant('1Z', 'x', [], 1, NOW), 'info', '1Z', NOW))).toBe('NOT_AGENT');
    // b-Aware 25 Oct: a pot keeps no daily cap, so a paired CLI may never trade or send from it.
    markAgentAccount('1P', [], NOW, { kind: 'pot' });
    expect(code(() => checkGrant(makeGrant('1P', 'Pot', ['send'], 1, NOW), 'send', '1P', NOW))).toBe('NOT_AGENT');
  });
});
