// bTrust funding: lock an amount under the inheritance plan, from the wallet's normal balance.
//
// 1. pick the next free owner slot from the seed-only scan (derive.ts), so every lock has its own owner key;
// 2. the wallet builds and signs the transaction through its own createAction path (it chooses the inputs and
//    pays the fee), with noSend so nothing leaves the device yet;
// 3. we check the outputs are exactly ours (the lock, then the 1-sat beacon to the slot's owner address) and run
//    a real owner-branch spend of the new lock output through the script interpreter, signed by the wallet;
// 4. only then the wallet broadcasts it (sendWith). On any failure before that, the action is aborted. Once the
//    send was attempted the network may have it (P0 25 Oct 2026), so a failed send is never aborted: it is kept
//    and watched (services/unsentGuard.ts), and released only at its deadline once the chain shows it never went
//    out (services/unsentExpiry.ts).

import { OP, Script, Transaction, UnlockingScript, type WalletInterface } from '@bsv/sdk';
import { BTRUST_PROTOCOL, inheritanceLock, TEST_HEIRS_BLOCKS, validatePlan, type InheritancePlan } from './inheritance';
import { beaconScript, ownerKeyID, planFromScript, scanForLocks, type ChainReader } from './derive';
import { BEACON_SATS, ownerSigner, signInput, verifySpend, type HashSigner } from './sign';
import { releaseAfterHandoff, type ReleaseOpts, type UnsentWallet } from '../../services/unsentGuard';

/** The smallest lock we accept: enough to pay a check-in or claim fee and still leave coins locked. */
export const MIN_LOCK_SATS = 1000;

type FundWallet = Pick<WalletInterface, 'createAction' | 'abortAction' | 'createSignature' | 'getPublicKey'>;

/** Owner key for the next free slot (seed-only scan). */
export async function nextOwnerSlot(wallet: Pick<WalletInterface, 'getPublicKey'>, chain: ChainReader) {
  const keys = async (keyID: string) =>
    (await wallet.getPublicKey({ protocolID: BTRUST_PROTOCOL, keyID, counterparty: 'self' })).publicKey;
  const { nextSlot } = await scanForLocks(keys, chain);
  return { slot: nextSlot, ownerPubKey: await keys(ownerKeyID(nextSlot)) };
}

/**
 * Prove output `vout` of `tx` is spendable by the owner: sign an owner-branch spend with the wallet and run it
 * through the interpreter. Also checks the script rebuilds into the same plan (so a seed scan will find it).
 */
export async function checkLockSpendable(tx: Transaction, vout: number, plan: InheritancePlan, owner: HashSigner) {
  const out = tx.outputs[vout];
  if (!out?.satoshis) throw new Error('no lock output');
  const rebuilt = planFromScript(out.lockingScript);
  if (!rebuilt || inheritanceLock(rebuilt).toHex() !== inheritanceLock(plan).toHex())
    throw new Error('the lock does not rebuild from the chain');
  const spend = new Transaction();
  spend.addInput({ sourceTransaction: tx, sourceOutputIndex: vout, sequence: 0xffffffff });
  spend.addOutput({ lockingScript: beaconScript(plan.ownerPubKey), satoshis: out.satoshis });
  const sig = await signInput(spend, 0, owner);
  spend.inputs[0].unlockingScript = new UnlockingScript(new Script().writeBin(sig).writeOpCode(OP.OP_1).chunks);
  if (!verifySpend(spend)) throw new Error('the lock would not be spendable by you');
}

export type Funded = { txid: string; tx: Transaction; vout: 0; slot: number; plan: InheritancePlan };

/** Fund `plan` (whose owner key is slot `slot`) with `sats`. The wallet pays the fee from its balance. */
export async function fundLock(opts: {
  wallet: FundWallet;
  plan: InheritancePlan;
  slot: number;
  sats: number;
  /** Test hook: options for the keep-and-watch after a failed send. */
  unsent?: Omit<ReleaseOpts, 'notBroadcast'>;
}): Promise<Funded> {
  const { wallet, slot, sats } = opts;
  const plan = validatePlan(opts.plan);
  if (!Number.isInteger(sats) || sats < MIN_LOCK_SATS) throw new Error(`lock at least ${MIN_LOCK_SATS} sats`);
  const owner = await ownerSigner(wallet, slot);
  if (owner.pubKey !== plan.ownerPubKey) throw new Error('the plan is not for this wallet slot');
  const lock = inheritanceLock(plan);
  const beacon = beaconScript(plan.ownerPubKey);

  const r = await wallet.createAction({
    description: 'bTrust: lock for your heirs',
    outputs: [
      { lockingScript: lock.toHex(), satoshis: sats, outputDescription: 'bTrust inheritance lock' },
      { lockingScript: beacon.toHex(), satoshis: BEACON_SATS, outputDescription: 'bTrust beacon' },
    ],
    labels: ['btrust'],
    options: { randomizeOutputs: false, noSend: true, acceptDelayedBroadcast: false },
  });
  if (!r.tx || !r.txid) throw new Error('The wallet did not return the funding transaction.');
  const txid = r.txid;
  let sent = false;
  let attempted = false;
  try {
    const tx = Transaction.fromAtomicBEEF(r.tx);
    if (tx.id('hex') !== txid) throw new Error('Refusing to send: the transaction id does not match.');
    if (tx.outputs[0]?.lockingScript.toHex() !== lock.toHex() || tx.outputs[0].satoshis !== sats)
      throw new Error('Refusing to send: the wallet changed the lock output.');
    if (tx.outputs[1]?.lockingScript.toHex() !== beacon.toHex() || tx.outputs[1].satoshis !== BEACON_SATS)
      throw new Error('Refusing to send: the beacon output is missing.');
    await checkLockSpendable(tx, 0, plan, owner);
    attempted = true;
    const s = await wallet.createAction({
      description: 'bTrust: send lock',
      options: { sendWith: [txid], acceptDelayedBroadcast: false },
    });
    const mine = s.sendWithResults?.find((x) => x.txid === txid);
    if (!mine || mine.status === 'failed') throw new Error('The network did not accept the lock.');
    sent = true;
    return { txid, tx, vout: 0, slot, plan };
  } finally {
    if (!sent && !attempted) await wallet.abortAction({ reference: txid }).catch(() => undefined);
    else if (!sent)
      await releaseAfterHandoff(wallet as unknown as UnsentWallet, txid, { ...opts.unsent, notBroadcast: false });
  }
}

/**
 * Refuse to fund a plan whose timings do not match the mode the page is in: a test plan (or test mode) must
 * have test-length heights, and a real plan must not. Returns the reason, or '' when it is fine.
 */
export function fundingMismatch(plan: InheritancePlan, height: number, testMode: boolean): string {
  const short = plan.heirsHeight - height <= TEST_HEIRS_BLOCKS + 2;
  if (testMode || plan.test) {
    if (!plan.test || !testMode) return 'This plan was built in a different mode. Build the plan again.';
    if (!short) return 'Test mode, but this plan has real dates. Build the plan again.';
  } else if (short) return 'These dates are too close. Build the plan again.';
  return '';
}

// ── plans kept on this device ────────────────────────────────────────────────

const KEY = 'btrust.plans.v1';
export type SavedPlan = { txid: string; slot: number; plan: InheritancePlan; savedAt: number };

export function savePlanLocally(entry: SavedPlan, store: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
  if (!store) return;
  try {
    const all = loadSavedPlans(store).filter((p) => p.txid !== entry.txid);
    store.setItem(KEY, JSON.stringify([...all, entry]));
  } catch {
    /* storage full or blocked: the download is the real copy */
  }
}

export function loadSavedPlans(store: Pick<Storage, 'getItem'> | null = safeStorage()): SavedPlan[] {
  try {
    const raw = store?.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedPlan[]) : [];
  } catch {
    return [];
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
