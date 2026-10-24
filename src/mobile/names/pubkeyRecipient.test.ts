import { describe, expect, test } from 'bun:test';
import { LockingScript, OP, PrivateKey, Utils } from '@bsv/sdk';
import { MAP } from '@1sat/templates';
import {
  compressedKey,
  decryptNoteWithKey,
  defaultKeyMode,
  encryptNoteForKey,
  GENESIS_PUBKEY,
  keyAddress,
  knownKeyLabel,
  noteMap,
  parsePubKey,
} from './pubkeyRecipient';
import { parseRecipient, resolveRecipient } from './names';
import { sealedToBytes, bytesToSealed } from '../bmail/envelope';

const priv = PrivateKey.fromString('1'.repeat(64), 'hex');
const comp = priv.toPublicKey().toString();
const uncomp = Utils.toHex(priv.toPublicKey().encode(false) as number[]);

describe('parsePubKey', () => {
  test('compressed and uncompressed keys', () => {
    expect(parsePubKey(comp)).toEqual({ hex: comp, compressed: true });
    expect(parsePubKey(uncomp)).toEqual({ hex: uncomp, compressed: false });
    expect(parsePubKey(GENESIS_PUBKEY.toUpperCase())).toEqual({ hex: GENESIS_PUBKEY, compressed: false });
  });
  test('bad hex / wrong length / off-curve', () => {
    expect(parsePubKey('satoshi')).toBeNull();
    expect(parsePubKey(comp.slice(0, 64))).toHaveProperty('error');
    expect(parsePubKey(`02${'f'.repeat(64)}`)).toHaveProperty('error');
    expect(parsePubKey(`04${'0'.repeat(128)}`)).toHaveProperty('error');
  });
  test('parseRecipient classifies keys before names', () => {
    expect(parseRecipient(comp)).toEqual({ kind: 'pubkey', key: comp, compressed: true });
    expect(parseRecipient(`03${'z'.repeat(64)}`).kind).not.toBe('pubkey');
    expect(parseRecipient(`02${'f'.repeat(64)}`).kind).toBe('invalid');
  });
});

describe('addresses', () => {
  test('genesis key → 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', () => {
    expect(keyAddress(GENESIS_PUBKEY)).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    expect(knownKeyLabel(GENESIS_PUBKEY)).toBe('Satoshi (genesis block key)');
  });
  test('compressed form matches the SDK address; uncompressed differs', () => {
    expect(keyAddress(comp)).toBe(priv.toPublicKey().toAddress());
    expect(keyAddress(uncomp)).not.toBe(keyAddress(comp));
    expect(compressedKey(uncomp)).toBe(comp);
  });
  test('resolveRecipient gives a labelled pubkey recipient', async () => {
    const r = await resolveRecipient(fetch, parseRecipient(GENESIS_PUBKEY));
    expect(r.via).toBe('pubkey');
    expect(r.target).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    expect(r.ordAddress).toBe(r.target);
    expect(r.displayName).toBe('Satoshi (genesis block key)');
    const c = await resolveRecipient(fetch, parseRecipient(comp));
    expect(c.displayName).toBe(`Public key ${comp.slice(0, 6)}…${comp.slice(-4)}`);
  });
  test('default mode: wallet for compressed, plain for uncompressed and genesis', () => {
    expect(defaultKeyMode({ hex: comp, compressed: true })).toBe('wallet');
    expect(defaultKeyMode({ hex: uncomp, compressed: false })).toBe('plain');
    expect(defaultKeyMode({ hex: GENESIS_PUBKEY, compressed: false })).toBe('plain');
  });
});

describe('encrypted note', () => {
  test('BIE1 round-trip with the key holder, for both key forms', () => {
    for (const k of [comp, uncomp]) {
      const c = encryptNoteForKey('Happy birthday!', k);
      expect(Utils.toUTF8(c.slice(0, 4))).toBe('BIE1');
      expect(decryptNoteWithKey(c, priv)).toBe('Happy birthday!');
    }
  });
  test('another key cannot read it', () => {
    const c = encryptNoteForKey('secret', comp);
    expect(() => decryptNoteWithKey(c, PrivateKey.fromRandom())).toThrow();
  });
  test('output script: P2PKH | OP_RETURN | MAP SET app bwalletx type note enc bie1 + ciphertext only', () => {
    const c = encryptNoteForKey('Happy birthday!', GENESIS_PUBKEY);
    const m = noteMap(c);
    expect(m).toEqual({ app: 'bwalletx', type: 'note', enc: 'bie1', note: Utils.toBase64(c) });
    const map = MAP.set(m) as unknown as LockingScript;
    const hex = map.toHex();
    expect(map.chunks[0].op).toBe(OP.OP_RETURN);
    expect(hex).not.toContain(Utils.toHex(Utils.toArray('Happy', 'utf8')));
  });
  test('bMail sealed letter carries the ordinal delivery details', () => {
    const s = { subject: 's', body: 'b', ordinal: { txid: 'ab'.repeat(32), deliveries: [{ outputIndex: 0 }] } };
    expect(bytesToSealed(sealedToBytes(s))).toEqual(s);
  });
});
