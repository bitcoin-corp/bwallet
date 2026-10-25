import { describe, expect, test } from 'bun:test';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { isAgentCreatePending, openAgentCreate, setAgentCreate } = await import('./agentCreate');

describe('Mint › An agent account', () => {
  test('turns the Agent switch on, selects Settings › create-account and routes there', () => {
    setAgentCreate(false);
    const selected: [string, string | undefined][] = [];
    const routed: string[] = [];
    openAgentCreate(
      (item, query) => selected.push([item, query]),
      (to) => routed.push(to),
      '/m/settings',
    );
    expect(isAgentCreatePending()).toBe(true);
    expect(selected).toEqual([['settings', 'create-account']]);
    expect(routed).toEqual(['/m/settings']);
  });

  test('works without the tab context or a route (still sets the switch)', () => {
    setAgentCreate(false);
    const routed: string[] = [];
    openAgentCreate(undefined, (to) => routed.push(to), undefined);
    expect(isAgentCreatePending()).toBe(true);
    expect(routed).toEqual([]);
  });
});
