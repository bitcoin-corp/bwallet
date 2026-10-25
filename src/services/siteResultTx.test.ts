import { describe, expect, it, mock } from 'bun:test';
const vi = { fn: mock };
import { atomicBytes, wantsTx, withSignedTx } from './siteResultTx';
import { queuedResult } from './repeatGuard';

const TXID = 'ab'.repeat(32);
const BEEF = [1, 1, 1, 1, ...Array(32).fill(0xab), 9, 9];

describe('site createAction answer carries the signed tx', () => {
  it('approved outputs-only createAction returns tx and txid even when pending', async () => {
    const load = vi.fn(async () => BEEF);
    const r = await withSignedTx(
      { txid: TXID, pending: true as const },
      { acceptDelayedBroadcast: false } as never,
      load,
    );
    expect(r.txid).toBe(TXID);
    expect(r.tx).toEqual(BEEF);
    expect(load).toHaveBeenCalledWith(TXID);
  });
  it('keeps a tx already present and turns Uint8Array into number[]', async () => {
    const load = vi.fn(async () => null);
    const r = await withSignedTx({ txid: TXID, tx: new Uint8Array(BEEF) }, undefined, load);
    expect(r.tx).toEqual(BEEF);
    expect(load).not.toHaveBeenCalled();
  });
  it('returnTXIDOnly drops tx (spec)', async () => {
    const r = await withSignedTx({ txid: TXID, tx: BEEF }, { returnTXIDOnly: true }, async () => BEEF);
    expect(r).toEqual({ txid: TXID });
  });
  it('signAndProcess false is a signable action: no tx added', () => {
    expect(wantsTx({ signAndProcess: false })).toBe(false);
    expect(wantsTx(undefined)).toBe(true);
  });
  it('a failed load leaves the answer unchanged', async () => {
    const r = await withSignedTx({ txid: TXID }, undefined, async () => {
      throw new Error('no storage');
    });
    expect(r).toEqual({ txid: TXID });
    expect(atomicBytes([])).toBeNull();
  });
  it('queuedResult keeps a Uint8Array tx from the toolbox error', () => {
    const err = { txid: TXID, tx: new Uint8Array(BEEF), sendWithResults: [{ txid: TXID, status: 'sending' }] };
    expect(queuedResult(err)?.tx).toEqual(BEEF);
  });
});
