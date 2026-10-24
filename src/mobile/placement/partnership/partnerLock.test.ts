import { describe, expect, test } from 'bun:test';
import { BigNumber, ECDSA, Hash, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { BSV21 } from '@1sat/templates';
import {
  RULE_WARNING,
  addSignatures,
  defaultRule,
  describeProposalMoves,
  proposalMoveProblem,
  exportProposal,
  feeFor,
  finalize,
  findMyHoldings,
  importProposal,
  inputsFor,
  isPartnerLocked,
  isReady,
  keysetFor,
  parsePartnerLock,
  partnerLockScript,
  partnershipLabel,
  propose,
  proposalTx,
  sighash,
  toChecksig,
  waitingOn,
  type Keyset,
  type MovePlan,
} from './partnerLock';
import { buildListingScript } from '../../sell/sell';

const TOKEN = 'a'.repeat(64) + '_0';
const ann = PrivateKey.fromRandom();
const ben = PrivateKey.fromRandom();
const cat = PrivateKey.fromRandom();
const max = PrivateKey.fromRandom();
const stranger = PrivateKey.fromRandom();
const feeKey = PrivateKey.fromRandom();
const pub = (k: PrivateKey) => k.toPublicKey().toString();

// A partner's wallet signs with createSignature({hashToDirectlySign}); this is the same maths with a local key.
const signDigest = (k: PrivateKey, digest: number[]) =>
  toChecksig(ECDSA.sign(new BigNumber(digest), k, true).toDER() as number[]);
const signAs = (k: PrivateKey, tx: Transaction, inputs: number[]) =>
  Object.fromEntries(inputs.map((i) => [i, toHex(signDigest(k, sighash(tx, i)))]));
const toHex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');

let n = 0;
function locked(keyset: Keyset, holder: PrivateKey, amt: bigint) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: (n++).toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(ann.toAddress()),
    sequence: 0xffffffff,
  });
  src.addOutput({
    lockingScript: partnerLockScript({ tokenId: TOKEN, amt, holder: pub(holder) }, keyset),
    satoshis: 1,
  });
  return { sourceTx: src, vout: 0 };
}
function feeUtxo(sats: number) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: (n++).toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(ann.toAddress()),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript: new P2PKH().lock(feeKey.toAddress()), satoshis: sats });
  return { sourceTx: src, vout: 0, pubKey: pub(feeKey) };
}
const signFee = async (d: number[]) => signDigest(feeKey, d);

function plan(keyset: Keyset, over: Partial<MovePlan> = {}): MovePlan {
  return {
    partnershipId: 'room-1',
    agreementVersion: 1,
    proposalId: 'p-1',
    kind: 'transfer',
    summary: 'Send 1,000 shares from $ann to $ben',
    inputs: over.inputs ?? [locked(keyset, ann, 3000n)],
    outputs: [
      { tokenId: TOKEN, amt: 1000n, holder: pub(ben) },
      { tokenId: TOKEN, amt: 2000n, holder: pub(ann) },
    ],
    keyset,
    ...over,
  };
}
const make = async (p: MovePlan) => propose(p, feeUtxo(feeFor(p)), signFee);

const k2of3 = keysetFor({ kind: 'majority', m: 2 }, [pub(ann), pub(ben), pub(cat)]);
const k3of3 = keysetFor({ kind: 'unanimous' }, [pub(cat), pub(ann), pub(ben)]);

describe('default rule', () => {
  test('smallest majority by default; warnings in plain words', () => {
    expect([3, 4, 5].map((n) => defaultRule(n))).toEqual([
      { kind: 'majority', m: 2 },
      { kind: 'majority', m: 3 },
      { kind: 'majority', m: 3 },
    ]);
    expect(keysetFor(defaultRule(3), [pub(ann), pub(ben), pub(cat)]).m).toBe(2);
    expect(RULE_WARNING.unanimous).toContain('stuck for good');
    expect(RULE_WARNING.majority).toContain('lost phone never freezes');
  });
});

describe('script build / verify', () => {
  test('unanimous = n-of-n, majority = M-of-N, keys canonical', () => {
    expect(k3of3.m).toBe(3);
    expect(k2of3.m).toBe(2);
    expect(k3of3.pubKeys).toEqual([...k3of3.pubKeys].sort());
    expect(keysetFor({ kind: 'unanimous' }, [pub(ben), pub(ann), pub(cat)])).toEqual(k3of3);
  });
  test('refuses non-majority, duplicates, a lone partner', () => {
    expect(() => keysetFor({ kind: 'majority', m: 1 }, [pub(ann), pub(ben), pub(cat)])).toThrow();
    expect(() => keysetFor({ kind: 'unanimous' }, [pub(ann), pub(ann)])).toThrow();
    expect(() => keysetFor({ kind: 'unanimous' }, [pub(ann)])).toThrow();
  });
  test('round trip: token, amount, holder, keyset', () => {
    for (const ks of [k2of3, k3of3]) {
      const s = partnerLockScript({ tokenId: TOKEN, amt: 3000n, holder: pub(cat) }, ks);
      expect(parsePartnerLock(s)).toEqual({ tokenId: TOKEN, amt: 3000n, holder: pub(cat), ...ks });
      expect(BSV21.decode(s)?.getAmount()).toBe(3000n); // a normal BSV-21 transfer to indexers
    }
  });
  test('holder must be a partner', () => {
    expect(() => partnerLockScript({ tokenId: TOKEN, amt: 1n, holder: pub(stranger) }, k2of3)).toThrow();
  });
  test('label', () => expect(partnershipLabel(3000n)).toBe('Partnership shares · 3,000 · locked'));
});

describe('partial-signature collection', () => {
  test('2-of-3: proposer + one partner → ready → valid transaction', async () => {
    let p = await make(plan(k2of3));
    const tx = proposalTx(p);
    expect(isReady(p)).toBe(false);
    p = addSignatures(p, pub(ann), signAs(ann, tx, inputsFor(p, pub(ann))));
    expect(isReady(p)).toBe(false);
    expect(waitingOn(p).sort()).toEqual([pub(ben), pub(cat)].sort());
    p = importProposal(exportProposal(p)); // travels as JSON
    p = addSignatures(p, pub(cat), signAs(cat, tx, [0]));
    expect(isReady(p)).toBe(true);
    const { rawTx, txid } = finalize(p);
    expect(Transaction.fromHex(rawTx).id('hex')).toBe(txid);
  });
  test('3-of-3: needs all three, any order', async () => {
    let p = await make(plan(k3of3, { inputs: [locked(k3of3, ann, 3000n)] }));
    const tx = proposalTx(p);
    for (const k of [cat, ann]) p = addSignatures(p, pub(k), signAs(k, tx, [0]));
    expect(isReady(p)).toBe(false);
    p = addSignatures(p, pub(ben), signAs(ben, tx, [0]));
    expect(() => finalize(p)).not.toThrow();
  });
  test('two locked inputs are each counted', async () => {
    let p = await make(
      plan(k2of3, {
        inputs: [locked(k2of3, ann, 1000n), locked(k2of3, ann, 2000n)],
      }),
    );
    const tx = proposalTx(p);
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0, 1]));
    p = addSignatures(p, pub(ben), signAs(ben, tx, [0]));
    expect(isReady(p)).toBe(false);
    p = addSignatures(p, pub(ben), signAs(ben, tx, [1]));
    expect(isReady(p)).toBe(true);
    expect(() => finalize(p)).not.toThrow();
  });
  test('bad signatures are refused when added', async () => {
    const p = await make(plan(k2of3));
    const tx = proposalTx(p);
    expect(() => addSignatures(p, pub(stranger), signAs(stranger, tx, [0]))).toThrow('not one of these partners');
    expect(() => addSignatures(p, pub(ben), signAs(ann, tx, [0]))).toThrow('does not match');
    const other = proposalTx(await make(plan(k2of3, { summary: 'other' })));
    expect(() => addSignatures(p, pub(ben), signAs(ben, other, [0]))).toThrow('does not match');
  });
});

describe('refusal to broadcast with too few signatures', () => {
  test('2-of-3 with one signature', async () => {
    let p = await make(plan(k2of3));
    p = addSignatures(p, pub(ann), signAs(ann, proposalTx(p), [0]));
    expect(() => finalize(p)).toThrow('Not enough partner signatures yet: 1 of 2');
  });
  test('3-of-3 with two', async () => {
    let p = await make(plan(k3of3, { inputs: [locked(k3of3, ann, 3000n)] }));
    const tx = proposalTx(p);
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0]));
    p = addSignatures(p, pub(ben), signAs(ben, tx, [0]));
    expect(() => finalize(p)).toThrow('2 of 3');
  });
  test('a forged signature smuggled into the JSON does not count', async () => {
    let p = await make(plan(k2of3));
    const tx = proposalTx(p);
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0]));
    p = { ...p, sigs: { '0': { ...p.sigs['0'], [pub(ben)]: signAs(stranger, tx, [0])[0] } } };
    expect(isReady(p)).toBe(false);
    expect(() => finalize(p)).toThrow('Not enough');
  });
  test('shares must balance and stay one token', async () => {
    expect(make(plan(k2of3, { outputs: [{ tokenId: TOKEN, amt: 3001n, holder: pub(ben) }] }))).rejects.toThrow(
      'balance',
    );
    expect(
      make(plan(k2of3, { outputs: [{ tokenId: 'b'.repeat(64) + '_0', amt: 3000n, holder: pub(ben) }] })),
    ).rejects.toThrow('one token');
  });
  test('fee input must be the fee key and big enough', async () => {
    const pl = plan(k2of3);
    expect(propose(pl, feeUtxo(1), signFee)).rejects.toThrow('too small');
    expect(propose(pl, { ...feeUtxo(feeFor(pl)), pubKey: pub(stranger) }, signFee)).rejects.toThrow('fee key');
  });
});

describe('admit a partner', () => {
  test('old 2-of-3 signs a move into the new 3-of-4 keyset', async () => {
    const next = keysetFor({ kind: 'majority', m: 3 }, [pub(ann), pub(ben), pub(cat), pub(max)]);
    let p = await make(
      plan(k2of3, {
        kind: 'admit',
        summary: 'Admit $max for 10%',
        inputs: [locked(k2of3, ann, 3000n)],
        outputs: [
          { tokenId: TOKEN, amt: 2700n, holder: pub(ann) },
          { tokenId: TOKEN, amt: 300n, holder: pub(max) },
        ],
        keyset: next,
      }),
    );
    const tx = proposalTx(p);
    expect(() => addSignatures(p, pub(max), signAs(max, tx, [0]))).toThrow(); // new partner can't sign the old lock
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0]));
    p = addSignatures(p, pub(ben), signAs(ben, tx, [0]));
    const out = Transaction.fromHex(finalize(p).rawTx).outputs.map((o) => parsePartnerLock(o.lockingScript));
    expect(out[1]).toMatchObject({ holder: pub(max), amt: 300n, m: 3 });
  });
});

describe('recovery from seed + agreement record', () => {
  test('rebuilds the exact script and finds my holdings with no server', async () => {
    // Seed-derived key stand-in: a deterministic key from the "seed" + partnership id (wallet: BRC-42 self).
    const seed = PrivateKey.fromRandom();
    const derive = (s: PrivateKey, id: string) => PrivateKey.fromString(toHex(Hash.sha256(s.toString() + id)), 'hex');
    const mine = derive(seed, 'room-1');
    const record = { rule: { kind: 'majority', m: 2 } as const, partnerKeys: [pub(mine), pub(ben), pub(cat)] };
    const ks = keysetFor(record.rule, record.partnerKeys);
    const onChain = [
      { outpoint: 'x.0', lockingScript: partnerLockScript({ tokenId: TOKEN, amt: 500n, holder: pub(mine) }, ks) },
      { outpoint: 'y.0', lockingScript: partnerLockScript({ tokenId: TOKEN, amt: 900n, holder: pub(ben) }, ks) },
      { outpoint: 'z.0', lockingScript: BSV21.transfer(TOKEN, 5n).lock(new P2PKH().lock(ann.toAddress())) },
    ];
    // Lost phone: restore the seed, derive again, same key.
    const again = derive(seed, 'room-1');
    const found = findMyHoldings(onChain, pub(again));
    expect(found.map((f) => f.outpoint)).toEqual(['x.0']);
    expect(found[0].lock.pubKeys).toEqual(ks.pubKeys);
    // ...and can spend it with one other partner, using only the record.
    const src = new Transaction();
    src.addInput({
      sourceTXID: 'f'.repeat(64),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(ann.toAddress()),
      sequence: 0xffffffff,
    });
    src.addOutput({ lockingScript: found[0].lockingScript, satoshis: 1 });
    const pl = plan(ks, {
      inputs: [{ sourceTx: src, vout: 0 }],
      outputs: [{ tokenId: TOKEN, amt: 500n, holder: pub(ben) }],
    });
    let p = await make(pl);
    const tx = proposalTx(p);
    p = addSignatures(p, pub(again), signAs(again, tx, [0]));
    p = addSignatures(p, pub(cat), signAs(cat, tx, [0]));
    expect(() => finalize(p)).not.toThrow();
  });
});

describe('Exchange never lists them', () => {
  test('locked holdings are recognised; ordinary tokens and listings are not', () => {
    expect(isPartnerLocked(partnerLockScript({ tokenId: TOKEN, amt: 1n, holder: pub(ann) }, k2of3))).toBe(true);
    expect(isPartnerLocked(BSV21.transfer(TOKEN, 1n).lock(new P2PKH().lock(ann.toAddress())))).toBe(false);
    expect(isPartnerLocked(buildListingScript(TOKEN, 1n, ann.toAddress(), ann.toAddress(), 100))).toBe(false);
  });
});

describe('approval shows what the transaction really moves (b-Aware)', () => {
  test('decodes the real holdings, ignoring the summary', async () => {
    const p = await make(plan(k2of3, { summary: 'Send 1 share to $ben' }));
    const d = describeProposalMoves(p);
    expect(d.moves.map((m) => [m.holder, m.amt])).toEqual([
      [pub(ben), 1000n],
      [pub(ann), 2000n],
    ]);
    expect(d.sharesIn).toBe(3000n);
    expect(proposalMoveProblem(d)).toBeNull();
  });
  test('an output outside the partnership is refused', async () => {
    const p = await make(plan(k2of3));
    const tx = proposalTx(p);
    tx.addOutput({
      lockingScript: BSV21.transfer(TOKEN, 5n).lock(new P2PKH().lock(stranger.toAddress())),
      satoshis: 1,
    });
    const bad = { ...p, txEF: tx.toHexEF() };
    const d = describeProposalMoves(bad);
    expect(d.unexpected.length).toBe(1);
    expect(proposalMoveProblem(d)).toContain('outside the partnership');
  });
  test('unbalanced shares are refused', () => {
    expect(
      proposalMoveProblem({
        moves: [{ holder: 'a', amt: 1n, tokenId: 't', m: 1, pubKeys: [] }],
        unexpected: [],
        sharesIn: 2n,
        sharesOut: 1n,
      }),
    ).toContain("don't balance");
  });
});
