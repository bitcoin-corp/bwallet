import { describe, expect, test } from 'bun:test';
import {
  KeyDeriver,
  LockingScript,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Transaction,
  type CreateActionArgs,
  type WalletInterface,
} from '@bsv/sdk';
import { BTRUST_PROTOCOL, checkIn, inheritanceLock, type InheritancePlan } from './inheritance';
import { beaconAddress, ownerKeyID, scanForLocks, type ChainReader } from './derive';
import { checkLockSpendable, fundLock, loadSavedPlans, MIN_LOCK_SATS, nextOwnerSlot, savePlanLocally } from './fund';
import { heirSigner, ownerSigner, signCheckIn, signLeadClaim, verifySpend } from './sign';

/** A mock chain that indexes every P2PKH output of every broadcast transaction. */
function mockChain() {
  const txs: Transaction[] = [];
  const spent = new Set<string>();
  const add = (t: Transaction) => {
    txs.push(t);
    for (const i of t.inputs) spent.add(`${i.sourceTXID ?? i.sourceTransaction?.id('hex')}:${i.sourceOutputIndex}`);
  };
  const reader: ChainReader = {
    history: async (address) => {
      const p2 = new P2PKH().lock(address).toHex();
      return txs.filter((t) => t.outputs.some((o) => o.lockingScript.toHex() === p2)).map((t) => t.id('hex'));
    },
    rawTx: async (txid) => txs.find((t) => t.id('hex') === txid)!.toHex(),
    spent: async (txid, vouts) => new Set(vouts.filter((v) => spent.has(`${txid}:${v}`))),
  };
  return { reader, add, txs };
}

/**
 * A BRC-100 wallet stand-in: real seed-derived keys (ProtoWallet) plus a createAction that funds from one
 * P2PKH coin, pays a fee, signs, holds noSend actions and broadcasts them to the mock chain on sendWith.
 */
function mockWallet(
  root: PrivateKey,
  chain: ReturnType<typeof mockChain>,
  opts: { tamper?: boolean; failSend?: boolean } = {},
) {
  const proto = new ProtoWallet(root);
  const coinKey = PrivateKey.fromRandom();
  const pending = new Map<string, Transaction>();
  const aborted: string[] = [];
  const wallet = {
    getPublicKey: proto.getPublicKey.bind(proto),
    createSignature: proto.createSignature.bind(proto),
    abortAction: async ({ reference }: { reference: string }) => {
      aborted.push(reference);
      pending.delete(reference);
      return { aborted: true as const };
    },
    createAction: async (args: CreateActionArgs) => {
      if (args.options?.sendWith) {
        const results = args.options.sendWith.map((txid) => {
          const t = pending.get(txid);
          if (!t || opts.failSend) return { txid, status: 'failed' as const };
          chain.add(t);
          pending.delete(txid);
          return { txid, status: 'unproven' as const };
        });
        return { sendWithResults: results };
      }
      const src = new Transaction();
      src.addInput({
        sourceTXID: PrivateKey.fromRandom().toHex(),
        sourceOutputIndex: 0,
        unlockingScript: new P2PKH().lock(coinKey.toAddress()),
        sequence: 0xffffffff,
      });
      src.addOutput({ lockingScript: new P2PKH().lock(coinKey.toAddress()), satoshis: 1_000_000 });
      const tx = new Transaction();
      tx.addInput({
        sourceTransaction: src,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(coinKey),
      });
      const outs = args.outputs ?? [];
      for (const o of outs)
        tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis });
      if (opts.tamper) tx.outputs[0].satoshis = (tx.outputs[0].satoshis ?? 0) - 1;
      const spent = outs.reduce((a, o) => a + o.satoshis, 0);
      tx.addOutput({ lockingScript: new P2PKH().lock(coinKey.toAddress()), satoshis: 1_000_000 - spent - 200 });
      await tx.sign();
      const txid = tx.id('hex');
      pending.set(txid, tx);
      return { txid, tx: tx.toAtomicBEEF(true) };
    },
  };
  return { wallet: wallet as unknown as WalletInterface, aborted, pending };
}

const root = PrivateKey.fromRandom();
const heirRoots = [PrivateKey.fromRandom(), PrivateKey.fromRandom(), PrivateKey.fromRandom()];
const heirPub = (k: PrivateKey) => new KeyDeriver(k).derivePublicKey(BTRUST_PROTOCOL, 'heir', 'self', true).toString();
const keys = async (keyID: string) =>
  new KeyDeriver(root).derivePublicKey(BTRUST_PROTOCOL, keyID, 'self', true).toString();
const planFor = (ownerPubKey: string, h = 1_000_000): InheritancePlan => ({
  v: 1,
  ownerPubKey,
  heirs: heirRoots.map((k, i) => ({ name: `Heir ${i + 1}`, pubKey: heirPub(k) })),
  heirsHeight: h,
  leadHeight: h + 100,
});

describe('funding', () => {
  test('uses the next free slot, adds the beacon, and scanForLocks finds it straight after', async () => {
    const chain = mockChain();
    const { wallet } = mockWallet(root, chain);
    const first = await nextOwnerSlot(wallet, chain.reader);
    expect(first.slot).toBe(0);
    const a = await fundLock({ wallet, plan: planFor(first.ownerPubKey), slot: first.slot, sats: 5000 });
    expect(a.tx.outputs[1].lockingScript.toHex()).toBe(new P2PKH().lock(beaconAddress(first.ownerPubKey)).toHex());
    expect(a.tx.outputs[1].satoshis).toBe(1);

    const second = await nextOwnerSlot(wallet, chain.reader);
    expect(second.slot).toBe(1);
    expect(second.ownerPubKey).toBe(await keys(ownerKeyID(1)));
    await fundLock({ wallet, plan: planFor(second.ownerPubKey), slot: 1, sats: 7000 });

    const { locks, nextSlot } = await scanForLocks(keys, chain.reader);
    expect(locks.map((l) => [l.slot, l.sats, l.spent])).toEqual([
      [0, 5000, false],
      [1, 7000, false],
    ]);
    expect(locks[0].txid).toBe(a.txid);
    expect(nextSlot).toBe(2);
  });

  test('refuses a wrong slot, too small an amount, and a wallet that changes the outputs (and aborts)', async () => {
    const chain = mockChain();
    const { wallet } = mockWallet(root, chain);
    const p0 = planFor(await keys(ownerKeyID(0)));
    await expect(fundLock({ wallet, plan: p0, slot: 1, sats: 5000 })).rejects.toThrow('slot');
    await expect(fundLock({ wallet, plan: p0, slot: 0, sats: MIN_LOCK_SATS - 1 })).rejects.toThrow();
    const bad = mockWallet(root, chain, { tamper: true });
    await expect(fundLock({ wallet: bad.wallet, plan: p0, slot: 0, sats: 5000 })).rejects.toThrow('changed the lock');
    expect(bad.aborted.length).toBe(1);
    expect(chain.txs.length).toBe(0);
  });

  test('P0: a send that was attempted and failed is kept, never aborted (the network may have it)', async () => {
    const chain = mockChain();
    const w = mockWallet(root, chain, { failSend: true });
    const p0 = planFor(await keys(ownerKeyID(0)));
    const logs: string[] = [];
    await expect(
      fundLock({
        wallet: w.wallet,
        plan: p0,
        slot: 0,
        sats: 5000,
        unsent: { settleDelaysMs: [], sleep: async () => undefined, lookups: [], log: (m) => logs.push(m) },
      }),
    ).rejects.toThrow('did not accept');
    expect(w.aborted).toEqual([]);
    expect(w.pending.size).toBe(1);
    expect(logs.join('\n')).toMatch(/kept, not aborted \(server-may-have-broadcast\)/);
  });

  test('the spendability check fails for a lock the wallet cannot spend', async () => {
    const other = new ProtoWallet(PrivateKey.fromRandom());
    const p0 = planFor(await keys(ownerKeyID(0)));
    const t = new Transaction();
    t.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    });
    t.addOutput({ lockingScript: inheritanceLock(p0), satoshis: 5000 });
    await expect(checkLockSpendable(t, 0, p0, await ownerSigner(other))).rejects.toThrow('not be spendable');
  });

  test('plans are kept on the device', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const plan = planFor(PrivateKey.fromRandom().toPublicKey().toString());
    savePlanLocally({ txid: 'a', slot: 0, plan, savedAt: 1 }, store);
    savePlanLocally({ txid: 'a', slot: 0, plan, savedAt: 2 }, store);
    expect(loadSavedPlans(store)).toEqual([{ txid: 'a', slot: 0, plan, savedAt: 2 }]);
  });
});

test('full loop on a mock chain: fund → scan → check-in → scan → lead-heir claim', async () => {
  const chain = mockChain();
  const { wallet } = mockWallet(root, chain);
  const { slot, ownerPubKey } = await nextOwnerSlot(wallet, chain.reader);
  await fundLock({ wallet, plan: planFor(ownerPubKey, 1_000_000), slot, sats: 10_000 });

  let found = (await scanForLocks(keys, chain.reader)).locks.filter((l) => !l.spent);
  expect(found.length).toBe(1);

  const next = checkIn(found[0].plan, 1_000_050, 1, 1);
  const ci = await signCheckIn({
    lockTx: found[0].tx,
    vout: found[0].vout,
    plan: found[0].plan,
    next,
    owner: await ownerSigner(wallet, found[0].slot),
  });
  expect(verifySpend(ci)).toBe(true);
  chain.add(ci);

  const all = (await scanForLocks(keys, chain.reader)).locks;
  expect(all.map((l) => l.spent)).toEqual([true, false]);
  found = all.filter((l) => !l.spent);
  expect(found[0].plan.heirsHeight).toBe(next.heirsHeight);

  const lead = await heirSigner(new ProtoWallet(heirRoots[0]));
  const payTo = PrivateKey.fromRandom().toAddress();
  await expect(
    signLeadClaim({
      lockTx: found[0].tx,
      vout: found[0].vout,
      plan: found[0].plan,
      lead,
      payTo,
      height: next.leadHeight - 1,
    }),
  ).rejects.toThrow();
  const claim = await signLeadClaim({
    lockTx: found[0].tx,
    vout: found[0].vout,
    plan: found[0].plan,
    lead,
    payTo,
    height: next.leadHeight,
  });
  expect(verifySpend(claim)).toBe(true);
  chain.add(claim);
  expect((await scanForLocks(keys, chain.reader)).locks.every((l) => l.spent)).toBe(true);
});
