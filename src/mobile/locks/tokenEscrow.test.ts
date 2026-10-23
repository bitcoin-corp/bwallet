import { describe, expect, test } from 'bun:test';
import { BigNumber, ECDSA, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk';
import {
  RESERVE_SATS,
  addEscrowSignature,
  buildSettlement,
  checkKeys,
  escrowReady,
  escrowScript,
  finalizeSettlement,
  isEscrowed,
  parseEscrow,
  proposalTx,
  refundOpen,
  settlementProblem,
  sighash,
  termsMessage,
  toChecksig,
  type Escrow,
  type Funding,
} from './tokenEscrow';
import { decodeTokenLock } from './tokenLocks';

const TOKEN = 'b'.repeat(64) + '_0';
const [poster, arbiter, deliverer, reserve, stranger] = [0, 1, 2, 3, 4].map(() => PrivateKey.fromRandom());
const pub = (k: PrivateKey) => k.toPublicKey().toString();
const hex = (b: number[]) => Utils.toHex(b);
const signDigest = (k: PrivateKey, d: number[]) =>
  hex(toChecksig(ECDSA.sign(new BigNumber(d), k, true).toDER() as number[]));
const signEscrow = (k: PrivateKey, p: { txEF: string }) => signDigest(k, sighash(proposalTx(p), 0));
const ESCROW_ID = '11111111-2222-3333-4444-555555555555';

const open: Escrow = {
  escrowId: ESCROW_ID,
  tokenId: TOKEN,
  amt: 10_000_000n,
  keys: [
    { role: 'poster', pubkey: pub(poster) },
    { role: 'arbiter', pubkey: pub(arbiter) },
  ],
};
const directed: Escrow = { ...open, keys: [...open.keys, { role: 'deliverer', pubkey: pub(deliverer) }] };

function fund(e: Escrow): Funding {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: escrowScript(e), satoshis: 1 });
  tx.addOutput({ lockingScript: new P2PKH().lock(reserve.toAddress()), satoshis: RESERVE_SATS });
  return { fundTx: tx, vout: 0, reserveVout: 1, reservePubKey: pub(reserve) };
}
const signReserve = async (d: number[]) => toChecksig(ECDSA.sign(new BigNumber(d), reserve, true).toDER() as number[]);

describe('escrow script', () => {
  test('round-trips, carries the amount and both keys, 2-of-2 / 2-of-3', () => {
    const p = parseEscrow(escrowScript(open))!;
    expect(p.tokenId).toBe(TOKEN);
    expect(p.amt).toBe(10_000_000n);
    expect(p.m).toBe(2);
    expect(p.pubKeys).toEqual([pub(poster), pub(arbiter)].sort());
    expect(parseEscrow(escrowScript(directed))!.pubKeys.length).toBe(3);
  });
  test('is not mistaken for a token time lock or ordinary token output', () => {
    expect(decodeTokenLock(escrowScript(open))).toBeNull();
    expect(isEscrowed(new P2PKH().lock(poster.toAddress()))).toBe(false);
  });
  test('refuses bad key sets', () => {
    expect(() => checkKeys([{ role: 'poster', pubkey: pub(poster) }])).toThrow();
    expect(() =>
      checkKeys([
        { role: 'poster', pubkey: pub(poster) },
        { role: 'arbiter', pubkey: pub(poster) },
      ]),
    ).toThrow();
    expect(() =>
      checkKeys([
        { role: 'poster', pubkey: pub(poster) },
        { role: 'deliverer', pubkey: pub(deliverer) },
      ]),
    ).toThrow();
  });
  test('escrows with different ids lock to different scripts', () => {
    expect(escrowScript(open).toHex()).not.toBe(escrowScript({ ...open, escrowId: 'other' }).toHex());
  });
});

describe('release', () => {
  test('poster + arbiter release to the deliverer; finalize runs the interpreter', async () => {
    const funding = fund(open);
    const p = await buildSettlement(
      { kind: 'release', escrow: open, funding, payTo: deliverer.toAddress(), contentSha256: 'c'.repeat(64) },
      signReserve,
    );
    expect(settlementProblem(p, { kind: 'release', escrow: open, to: deliverer.toAddress() })).toBeNull();
    const one = addEscrowSignature(p, pub(poster), signEscrow(poster, p));
    expect(escrowReady(one)).toBe(false);
    expect(() => finalizeSettlement(one)).toThrow(/Not enough/);
    const two = addEscrowSignature(one, pub(arbiter), signEscrow(arbiter, one));
    expect(escrowReady(two)).toBe(true);
    const { rawTx } = finalizeSettlement(two);
    const tx = Transaction.fromHex(rawTx);
    expect(tx.outputs.length).toBe(2);
    expect(tx.lockTime).toBe(0);
  });
  test('a stranger cannot sign; a release to someone else is flagged before signing', async () => {
    const funding = fund(open);
    const p = await buildSettlement(
      { kind: 'release', escrow: open, funding, payTo: stranger.toAddress() },
      signReserve,
    );
    expect(() => addEscrowSignature(p, pub(stranger), signEscrow(stranger, p))).toThrow();
    expect(settlementProblem(p, { kind: 'release', escrow: open, to: deliverer.toAddress() })).toMatch(/full amount/);
  });
  test('directed 2-of-3: poster + deliverer also suffices on chain (policy is the arbiter’s side)', async () => {
    const funding = fund(directed);
    const p = await buildSettlement(
      { kind: 'release', escrow: directed, funding, payTo: deliverer.toAddress() },
      signReserve,
    );
    const s = addEscrowSignature(
      addEscrowSignature(p, pub(poster), signEscrow(poster, p)),
      pub(deliverer),
      signEscrow(deliverer, p),
    );
    expect(() => finalizeSettlement(s)).not.toThrow();
  });
});

describe('refund', () => {
  test('time-locked to the refund height, non-final inputs, back to the poster', async () => {
    const funding = fund(open);
    const p = await buildSettlement(
      { kind: 'refund', escrow: open, funding, posterAddress: poster.toAddress(), refundAfterHeight: 900_144 },
      signReserve,
    );
    expect(
      settlementProblem(p, { kind: 'refund', escrow: open, to: poster.toAddress(), refundAfterHeight: 900_144 }),
    ).toBeNull();
    const tx = proposalTx(p);
    expect(tx.lockTime).toBe(900_144);
    expect(tx.inputs.every((i) => i.sequence === 0xfffffffe)).toBe(true);
    const s = addEscrowSignature(
      addEscrowSignature(p, pub(poster), signEscrow(poster, p)),
      pub(arbiter),
      signEscrow(arbiter, p),
    );
    expect(refundOpen(s, 900_143)).toBe(false);
    expect(refundOpen(s, 900_144)).toBe(true);
    expect(() => finalizeSettlement(s)).not.toThrow();
  });
  test('release and refund spend the same outputs, so only one can ever confirm', async () => {
    const funding = fund(open);
    const r = await buildSettlement(
      { kind: 'release', escrow: open, funding, payTo: deliverer.toAddress() },
      signReserve,
    );
    const f = await buildSettlement(
      { kind: 'refund', escrow: open, funding, posterAddress: poster.toAddress(), refundAfterHeight: 900_144 },
      signReserve,
    );
    const ins = (p: { txEF: string }) =>
      proposalTx(p)
        .inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)
        .join();
    expect(ins(r)).not.toContain('undefined');
    expect(ins(r)).toBe(ins(f));
  });
  test('refuses a funding output that is not this escrow', async () => {
    const funding = fund(open);
    await expect(
      buildSettlement(
        { kind: 'refund', escrow: directed, funding, posterAddress: poster.toAddress(), refundAfterHeight: 1 },
        signReserve,
      ),
    ).rejects.toThrow();
  });
});

test('terms message matches bit-sign commission-rules.ts', () => {
  expect(termsMessage({ ticker: 'FILM', no: 4, docHash: 'ab', handle: 'ann', role: 'poster' })).toBe(
    'Commission #B4 · $FILM\nI, $ann, agree to these terms as poster.\nTerms sha256 ab',
  );
});

// Shared vector with bit-sign escrow-mailbox-selftest.mts: if either side changes the script, both tests fail.
test('escrow script matches the bit-sign mailbox vector', () => {
  const a = PrivateKey.fromHex('01'.repeat(32)).toPublicKey().toString();
  const b = PrivateKey.fromHex('02'.repeat(32)).toPublicKey().toString();
  const s = escrowScript({
    escrowId: 'esc-1',
    tokenId: 'b'.repeat(64) + '_0',
    amt: 123n,
    keys: [
      { role: 'poster', pubkey: a },
      { role: 'arbiter', pubkey: b },
    ],
  });
  expect(s.toHex()).toBe(
    '0063036f726451126170706c69636174696f6e2f6273762d3230004c747b2270223a226273762d3230222c226f70223a227472616e73666572222c226964223a22626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262625f30222c22616d74223a22313233227d6820b52b9ba1b7fc5d761d92ff15687a53c468537b1441d07c3bec5d4b67e56bd463755221024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d076621031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f52ae',
  );
});
