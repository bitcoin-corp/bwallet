import { describe, expect, test } from 'bun:test';
import { BigNumber, ECDSA, Hash, PrivateKey, PublicKey, Signature } from '@bsv/sdk';
import {
  installLegacyOrdSigner,
  LEGACY_ORD_KEY_ID,
  LEGACY_ORD_PROTOCOL,
  legacyOrdKey,
  legacyOrdVisible,
  syncLegacyOrd,
  watchedLegacyOrdAddress,
} from './legacyOrd';
import { isReservedProtocol, reservedProtocolRefusal } from './reservedProtocols';

const key = PrivateKey.fromRandom();
const addr = key.toPublicKey().toAddress();

const fakeWallet = () => {
  const calls: string[] = [];
  return {
    calls,
    getPublicKey: async () => {
      calls.push('getPublicKey');
      return { publicKey: 'inner' };
    },
    createSignature: async () => {
      calls.push('createSignature');
      return { signature: [1] };
    },
  };
};

describe('legacyOrdKey', () => {
  test('returns the key only when it matches the address', () => {
    expect(legacyOrdKey(key.toWif(), addr)?.toWif()).toBe(key.toWif());
    expect(legacyOrdKey(key.toWif(), PrivateKey.fromRandom().toPublicKey().toAddress())).toBeUndefined();
    expect(legacyOrdKey(undefined, addr)).toBeUndefined();
    expect(legacyOrdKey('not a wif', addr)).toBeUndefined();
  });
});

describe('installLegacyOrdSigner', () => {
  test('signs the legacy protocol with the ord key, passes everything else through', async () => {
    const w = fakeWallet();
    const undo = installLegacyOrdSigner(w as never, key);
    expect(watchedLegacyOrdAddress()).toBe(addr);
    const args = { protocolID: LEGACY_ORD_PROTOCOL, keyID: LEGACY_ORD_KEY_ID, counterparty: 'self' as const };
    const { publicKey } = await w.getPublicKey({ ...args, forSelf: true } as never);
    expect(PublicKey.fromString(publicKey).toAddress()).toBe(addr);
    const hash = Hash.sha256([1, 2, 3]);
    const { signature } = await w.createSignature({ ...args, hashToDirectlySign: hash } as never);
    expect(ECDSA.verify(new BigNumber(hash), Signature.fromDER(signature), key.toPublicKey())).toBe(true);
    // Other protocols / keyIDs / counterparties: the wallet's own derivation.
    await w.getPublicKey({ protocolID: [2, 'other'], keyID: 'ord' } as never);
    await w.createSignature({ ...args, keyID: '1sat 0', hashToDirectlySign: hash } as never);
    await w.createSignature({ ...args, counterparty: 'anyone', hashToDirectlySign: hash } as never);
    expect(w.calls).toEqual(['getPublicKey', 'createSignature', 'createSignature']);
    undo();
    expect(watchedLegacyOrdAddress()).toBeUndefined();
  });

  test('the protocol is refused to outside apps', () => {
    expect(isReservedProtocol(LEGACY_ORD_PROTOCOL)).toBe(true);
    expect(reservedProtocolRefusal('createSignature', { protocolID: LEGACY_ORD_PROTOCOL, keyID: 'ord' })).toContain(
      'reserved',
    );
  });
});

describe('syncLegacyOrd', () => {
  const T1 = 'a'.repeat(64);
  const T2 = 'b'.repeat(64);
  const T3 = 'c'.repeat(64);
  test('takes in unheld origin ordinals per tx, with the legacy derivation', async () => {
    const seen: { txid: string; outputs: unknown }[] = [];
    const r = await syncLegacyOrd({
      address: addr,
      chain: 'main',
      services: { beef: { getBeef: async (t: string) => [t.charCodeAt(0)] } } as never,
      wallet: {
        listOutputs: async () => ({ totalOutputs: 1, outputs: [{ outpoint: `${T3}.0` }] }),
        internalizeAction: async () => ({ accepted: true }),
      } as never,
      scan: (async () => ({
        ordinals: [
          { outpoint: `${T1}_0`, satoshis: 1, origin: 'o1' },
          { outpoint: `${T1}_2`, satoshis: 1, origin: 'o2' },
          { outpoint: `${T2}_1`, satoshis: 1 }, // no origin
          { outpoint: `${T3}_0`, satoshis: 1, origin: 'o3' }, // already held
        ],
      })) as never,
      internalize: (async (o: { beef: number[]; outputs: unknown[] }) => {
        seen.push({ txid: String.fromCharCode(o.beef[0]), outputs: o.outputs });
        return { txid: '', internalized: o.outputs.length };
      }) as never,
    });
    expect(r).toEqual({ added: 2, failed: 0 });
    expect(seen).toEqual([
      {
        txid: 'a',
        outputs: [0, 2].map((outputIndex) => ({
          outputIndex,
          protocolID: LEGACY_ORD_PROTOCOL,
          keyID: 'ord',
          counterparty: 'self',
        })),
      },
    ]);
  });
});

describe('legacyOrdVisible (quarantine wins)', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const legacy = new Set([`${A}_0`, `${B}_1`]);
  test('a legacy NFT shows only once kept; other NFTs always show', () => {
    expect(legacyOrdVisible(`${'c'.repeat(64)}.0`, legacy, [])).toBe(true);
    expect(legacyOrdVisible(`${A}.0`, legacy, [])).toBe(false);
    expect(legacyOrdVisible(`${A}.0`, legacy, [{ txid: A, outpoint: `${A}_0` }])).toBe(true);
    expect(legacyOrdVisible(`${B}.1`, legacy, [{ txid: B }])).toBe(true);
    expect(legacyOrdVisible(`${B}.1`, legacy, [{ txid: A, outpoint: `${A}_0` }])).toBe(false);
  });
});
