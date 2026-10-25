/** b-Aware 25 Oct 2026: server-named destinations are checked before anything is signed. */
import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { checkOutputsMatchShown, checkPayTo, guardedPay, p2pkhScript, PINNED_REVENUE_ADDRESSES } from './guardedPay';
import { checkChargePayees } from '../mobile/chat/roomSpend';
import { quoteShown, MAX_THEME_BUY_SATS } from '../mobile/themeOrder/api';

const ours = PINNED_REVENUE_ADDRESSES[0];
const evil = PrivateKey.fromRandom().toAddress();
const issuer = PrivateKey.fromRandom().toAddress();
const ok = async () => undefined;

describe('guardedPay', () => {
  test('pinned: our address passes, any other is refused', () => {
    expect(() => checkPayTo(ours, { kind: 'pinned' })).not.toThrow();
    expect(() => checkPayTo(evil, { kind: 'pinned' })).toThrow(/Nothing was paid/);
  });
  test('bound: must equal the independently resolved address; unknown refuses', () => {
    expect(() => checkPayTo(issuer, { kind: 'bound', address: issuer, who: 'x' })).not.toThrow();
    expect(() => checkPayTo(evil, { kind: 'bound', address: issuer, who: 'x' })).toThrow(/Nothing was paid/);
    expect(() => checkPayTo(issuer, { kind: 'bound', address: null, who: 'x' })).toThrow(/Nothing was paid/);
  });
  test('outputs must be exactly what was shown: a swapped address, raised amount or extra payee is refused', () => {
    const shown = [{ address: ours, sats: 1000 }];
    expect(() => checkOutputsMatchShown([{ lockingScript: p2pkhScript(ours), satoshis: 1000 }], shown)).not.toThrow();
    expect(() => checkOutputsMatchShown([{ lockingScript: p2pkhScript(evil), satoshis: 1000 }], shown)).toThrow();
    expect(() => checkOutputsMatchShown([{ lockingScript: p2pkhScript(ours), satoshis: 1001 }], shown)).toThrow();
    expect(() =>
      checkOutputsMatchShown(
        [
          { lockingScript: p2pkhScript(ours), satoshis: 1000 },
          { lockingScript: p2pkhScript(evil), satoshis: 500 },
        ],
        shown,
      ),
    ).toThrow();
    expect(() =>
      checkOutputsMatchShown([{ lockingScript: p2pkhScript(ours), satoshis: 1000 }], shown, { maxSats: 999 }),
    ).toThrow();
  });
  test('nothing is signed when refused, or when spending is paused', async () => {
    let signed = 0;
    const sign = async () => ++signed;
    const bad = { outputs: [{ lockingScript: p2pkhScript(evil), satoshis: 5 }], shown: [{ address: evil, sats: 5 }] };
    await expect(guardedPay({ ...bad, trust: { kind: 'pinned' } }, sign, ok)).rejects.toThrow(/Nothing was paid/);
    const good = { outputs: [{ lockingScript: p2pkhScript(ours), satoshis: 5 }], shown: [{ address: ours, sats: 5 }] };
    await expect(
      guardedPay({ ...good, trust: { kind: 'pinned' } }, sign, async () => {
        throw new Error('paused');
      }),
    ).rejects.toThrow('paused');
    expect(signed).toBe(0);
    expect(await guardedPay({ ...good, trust: { kind: 'pinned' } }, sign, ok)).toBe(1);
  });
});

describe('server quotes and charges', () => {
  test('a theme quote paying anyone but us, or above the ceiling, is refused', async () => {
    const q = (to: string, sats: number) => ({
      quote_id: 'q',
      outputs: [{ script: p2pkhScript(to), satoshis: sats }],
      memo_hex: '006a',
      usd: 1,
      sats,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    let signed = 0;
    const run = (quote: ReturnType<typeof q>) =>
      guardedPay(
        {
          outputs: quote.outputs.map((o) => ({ lockingScript: o.script, satoshis: o.satoshis })),
          shown: quoteShown(quote),
          trust: { kind: 'pinned' },
          maxSats: MAX_THEME_BUY_SATS,
        },
        async () => ++signed,
        ok,
      );
    await expect(run(q(evil, 3000))).rejects.toThrow(/Nothing was paid/);
    await expect(run(q(ours, MAX_THEME_BUY_SATS + 1))).rejects.toThrow(/Nothing was paid/);
    expect(signed).toBe(0);
    expect(await run(q(ours, 3000))).toBe(1);
  });
  test("a room message charge may only pay the room's issuer, or burn", () => {
    expect(() => checkChargePayees([{ unit: 'sats', amount: '100', to: issuer }], issuer)).not.toThrow();
    expect(() => checkChargePayees([{ unit: 'token', tokenId: 't', amount: '1', to: 'burn' }], null)).not.toThrow();
    expect(() => checkChargePayees([{ unit: 'sats', amount: '100', to: evil }], issuer)).toThrow(/Nothing was paid/);
    expect(() => checkChargePayees([{ unit: 'token', tokenId: 't', amount: '1', to: evil }], issuer)).toThrow();
    expect(() => checkChargePayees([{ unit: 'sats', amount: '100', to: issuer }], null)).toThrow();
  });
});
