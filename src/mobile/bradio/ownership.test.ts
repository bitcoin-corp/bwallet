import { describe, expect, mock, test } from 'bun:test';
import { Utils } from '@bsv/sdk';

const outputs: { outpoint: string; tags?: string[]; customInstructions?: string }[] = [];
// Keep the real exports: bun module mocks are process-wide, and a partial mock left behind breaks later files that
// import other names from it.
const realActions = { ...(await import('@1sat/actions')) };
mock.module('@1sat/actions', () => ({
  ...realActions,
  listOrdinals: { execute: async () => ({ outputs }) },
}));
const { isListed, keyOf, ownerSigner } = await import('./ownership');
const { PodcastListedError } = await import('./podcasts');

const TX = 'a'.repeat(64);
const fakeCtx = () => {
  const calls: { sig?: Record<string, unknown>; pub?: Record<string, unknown> } = {};
  const wallet = {
    getPublicKey: async (a: Record<string, unknown>) => ((calls.pub = a), { publicKey: '02' + 'b'.repeat(64) }),
    createSignature: async (a: Record<string, unknown>) => ((calls.sig = a), { signature: [0x30, 0x01] }),
  };
  return { ctx: { wallet } as never, calls };
};

describe('podcast ownership signer', () => {
  test('signs the raw message bytes (wallet sha256s data) with the key from customInstructions', async () => {
    outputs.length = 0;
    outputs.push({
      outpoint: `${TX}_2`,
      tags: [`origin:${TX}_0`],
      customInstructions: JSON.stringify({ protocolID: [1, 'P1SAT'], keyID: `${TX}.2` }),
    });
    const { ctx, calls } = fakeCtx();
    const r = await ownerSigner(ctx, `${TX}_0`)('bwx-podcast:p:n');
    expect(calls.sig!.data).toEqual(Utils.toArray('bwx-podcast:p:n', 'utf8'));
    expect(calls.sig!.hashToDirectlySign).toBeUndefined();
    expect(calls.sig!.keyID).toBe(`${TX}.2`);
    expect(calls.sig!.counterparty).toBe('self');
    expect(calls.pub!.keyID).toBe(`${TX}.2`);
    expect(r).toEqual({ pubKey: '02' + 'b'.repeat(64), sig: '3001' });
  });
  test('default key is P1SAT with keyID = current outpoint', () => {
    expect(keyOf({ outpoint: `${TX}_5` })).toEqual({
      protocolID: realActions.P1SAT_PROTOCOL as never,
      keyID: `${TX}.5`,
    });
  });
  test('OrdLock-listed NFT → PodcastListedError, never signs', async () => {
    outputs.length = 0;
    outputs.push({ outpoint: `${TX}_1`, tags: [`origin:${TX}_0`, 'ordlock'] });
    expect(isListed(outputs[0])).toBe(true);
    const { ctx, calls } = fakeCtx();
    await expect(ownerSigner(ctx, `${TX}_0`)('m')).rejects.toBeInstanceOf(PodcastListedError);
    expect(calls.sig).toBeUndefined();
  });
});
