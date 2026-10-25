/**
 * b-Aware 25 Oct 2026: payments signed outside createAction (escrow, partnership, business agent, pots, bMail postage
 * fallback) were sent while spending was paused. The pause is now checked where the signed tx leaves the wallet.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { PAUSED_MESSAGE, resetKillSwitchCache, STATUS_URL } from './killSwitch';
import { broadcastRaw } from '../pots/potSend';
import { broadcastPostage } from '../bmail/client';

const realFetch = globalThis.fetch;
const sent: string[] = [];
beforeEach(() => {
  resetKillSwitchCache();
  sent.length = 0;
  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = String(u instanceof Request ? u.url : u);
    if (url === STATUS_URL) return new Response(JSON.stringify({ paused: ['spending'] }));
    sent.push(url);
    return new Response('{}');
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  resetKillSwitchCache();
});

describe('spending pause at broadcast time', () => {
  test('broadcastRaw (escrow, partnership, business agent, pots) refuses while paused', async () => {
    await expect(broadcastRaw('00')).rejects.toThrow(PAUSED_MESSAGE);
    expect(sent).toEqual([]);
  });

  test('bMail postage ARC fallback refuses while paused; nothing reaches ARC', async () => {
    const wallet = { createAction: async () => Promise.reject(new Error('wallet down')) };
    const postage = { txid: 'ab'.repeat(32), beef: '00' };
    await expect(broadcastPostage(wallet as never, postage as never, globalThis.fetch as typeof fetch)).rejects.toThrow(
      PAUSED_MESSAGE,
    );
    expect(sent).toEqual([]);
  });
});
