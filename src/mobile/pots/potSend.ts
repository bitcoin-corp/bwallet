import { LockingScript, OP, P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction, Utils } from '@bsv/sdk';
import { OneSatServices } from '@1sat/wallet-browser';
import { BSV21 } from '@1sat/templates';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import { decrypt } from '../../utils/crypto';
import { parseRecipient, resolveRecipient } from '../names/names';
import { payeeDestination, type PayeeDestination } from './payeeBinding';
import { isPayingPot, type Payee } from './pots';
import { PNEE_TOKEN_ID } from '../notes/pnee';
import { assertNotPaused } from '../config/killSwitch';
import { pickPneeInputs, pneeOverlayFee, type PneeCandidate } from './pneePot';

/**
 * Paying from a pot without switching to it (POTS-SUBSCRIPTIONS-PLAN.md v1). The session passKey that is
 * present while the wallet is unlocked opens every account's keys (as changePassword does), so the pot's
 * pay key is decrypted in memory for one payment and dropped. Same tx shape as Keys.service sweepLegacy:
 * the pot's P2PKH coins in, the payments out, change back to the pot. Nothing else is touched.
 */

let services: OneSatServices | null = null;
const svc = () => (services ??= new OneSatServices('main'));

const potAccount = (store: ChromeStorageService, potId: string) =>
  store.getAllAccounts().find((a) => a.addresses.identityAddress === potId) ?? null;

type Coin = { txid: string; vout: number; sats: number };

const allCoins = async (address: string): Promise<Coin[]> => {
  // Ask the indexer to catch up on this address first (sweepLegacy does the same).
  for await (const ev of svc().owner.getTxos(address, { refresh: true, limit: 1 })) {
    if (ev.type === 'done' || ev.type === 'error') break;
  }
  const utxos = (await svc().txo.search(`own:${address}`, { unspent: true, sats: true, limit: 0 })) ?? [];
  return utxos
    .map((u) => {
      const [txid, vout] = u.outpoint.split(/[._]/);
      return { txid, vout: parseInt(vout, 10), sats: u.satoshis ?? 0 };
    })
    .filter((c) => c.txid && Number.isFinite(c.vout));
};

// Never spend 1-sat outputs (ordinals, tokens) as fee coins.
const potCoins = async (address: string): Promise<Coin[]> => (await allCoins(address)).filter((c) => c.sats > 1);

/** A pot's spendable BSV in sats (its own P2PKH coins). */
export const potBalanceSats = async (store: ChromeStorageService, potId: string): Promise<number> => {
  const a = potAccount(store, potId);
  if (!a) return 0;
  const coins = await potCoins(a.addresses.bsvAddress);
  return coins.reduce((s, c) => s + c.sats, 0);
};

/**
 * Where a payee is paid: its address, or the address its paymail resolves to, checked like an interactive send
 * (destinationFor) and against the key pinned at setup (payeeBinding.ts). Paymails that only take P2P payments
 * (a fresh destination per payment, submitted to their host) aren't supported for standing orders in v1.
 */
export const resolvePayee = async (p: Payee, opts: { ignorePin?: boolean } = {}): Promise<PayeeDestination> => {
  if (p.address) return { address: p.address };
  if (!p.paymail) throw new Error('No payee address');
  const r = await resolveRecipient((u, i) => fetch(u, i), parseRecipient(p.paymail));
  return payeeDestination(p, r, opts);
};

export const payeeAddress = async (p: Payee): Promise<string> => (await resolvePayee(p)).address;

export type PotPayment = { address: string; sats: number };

/** Sign (but don't broadcast) one tx from the pot paying `outputs`. payDue records it before broadcasting. */
export const signFromPot = async (
  store: ChromeStorageService,
  potId: string,
  outputs: PotPayment[],
  memo?: string,
): Promise<{ rawTx: string; txid: string }> => {
  // The spending pause covers pots: they sign with their own key, outside the wallet's guarded createAction.
  await assertNotPaused('spending');
  // Pot only, never the main balance (owner, 18 Oct 2026): refuse any id that isn't a registered pot.
  if (!isPayingPot(potId)) throw new Error('Only a pot can pay');
  const acct = potAccount(store, potId);
  if (!acct?.encryptedKeys) throw new Error('This pot isn’t on this device');
  const passKey = await store.getPassKey();
  if (!passKey) throw new Error('Unlock the wallet first');
  const keys = JSON.parse(await decrypt(acct.encryptedKeys, passKey)) as { walletWif?: string };
  if (!keys.walletWif) throw new Error('This pot’s keys are incomplete');
  const pk = PrivateKey.fromWif(keys.walletWif);
  const from = acct.addresses.bsvAddress;
  if (pk.toAddress() !== from) throw new Error('Pot key mismatch');

  const need = outputs.reduce((s, o) => s + o.sats, 0);
  const coins = await potCoins(from);
  const have = coins.reduce((s, c) => s + c.sats, 0);
  if (have < need + 50) throw new Error('Not enough in the pot');

  const tx = new Transaction();
  for (const o of outputs) tx.addOutput({ lockingScript: new P2PKH().lock(o.address), satoshis: o.sats });
  // The service's reference (subscribeLink.ts), so it can tie the payment to the account that asked.
  if (memo) tx.addOutput({ lockingScript: memoScript(memo), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(from), change: true });
  let added = 0;
  for (const c of coins.sort((a, b) => b.sats - a.sats)) {
    const raw = await svc().beef.getRawTx(c.txid);
    if (!raw.length) continue;
    tx.addInput({
      sourceTransaction: Transaction.fromBinary([...raw]),
      sourceOutputIndex: c.vout,
      sequence: 0xffffffff,
      unlockingScriptTemplate: new P2PKH().unlock(pk),
    });
    added += c.sats;
    if (added >= need + 1000) break;
  }
  if (added < need) throw new Error('Not enough in the pot');
  await tx.fee(new SatoshisPerKilobyte(store.getCustomFeeRate()));
  await tx.sign();
  return { rawTx: tx.toHex(), txid: tx.id('hex') };
};

// ── PNEE pots ─────────────────────────────────────────────────────────────────────────────────────────────

const normId = (id: string) => id.trim().toLowerCase().replace('.', '_');

type PneeInput = PneeCandidate & { tx: Transaction; vout: number };

/**
 * The pot's PNEE outputs: its 1-sat coins whose script is a BSV-21 transfer (or the deploy) of PNEE, with the token
 * overlay's state for each. Source txs come from BEEF, so the payment can be handed to the overlay as BEEF.
 */
const potPneeOutputs = async (address: string): Promise<PneeInput[]> => {
  if (!PNEE_TOKEN_ID) return [];
  const id = normId(PNEE_TOKEN_ID);
  const ones = (await allCoins(address)).filter((c) => c.sats === 1);
  const found: PneeInput[] = [];
  const txs = new Map<string, Transaction>();
  for (const c of ones) {
    let tx = txs.get(c.txid);
    if (!tx) {
      const beef = await svc().beef.getBeef(c.txid);
      if (!beef.length) continue;
      tx = Transaction.fromBEEF([...beef], c.txid);
      txs.set(c.txid, tx);
    }
    const out = tx.outputs[c.vout];
    if (!out) continue;
    const t = BSV21.decode(out.lockingScript);
    if (!t) continue;
    const tokenId = t.tokenData.op.startsWith('deploy') ? `${c.txid}_${c.vout}` : (t.tokenData.id ?? '');
    if (normId(tokenId) !== id || (t.tokenData.op !== 'transfer' && !t.tokenData.op.includes('mint'))) continue;
    found.push({
      outpoint: `${c.txid}_${c.vout}`,
      amt: t.getAmount(),
      scriptHex: out.lockingScript.toHex(),
      tx,
      vout: c.vout,
    });
  }
  if (!found.length) return found;
  const states = new Map(
    (
      await svc().bsv21.getOutputStatus(
        PNEE_TOKEN_ID,
        found.map((f) => f.outpoint),
      )
    ).map((s) => [normId(s.outpoint), s.state as string]),
  );
  return found.map((f) => ({ ...f, state: states.get(normId(f.outpoint)) }));
};

const potHash160 = (address: string) => Utils.toHex(Utils.fromBase58Check(address).data as number[]);

/** A PNEE pot's spendable PNEEs in units (1 unit = 1¢): overlay-valid outputs its own key signs. */
export const potPneeUnits = async (store: ChromeStorageService, potId: string): Promise<number> => {
  const a = potAccount(store, potId);
  if (!a) return 0;
  const outs = await potPneeOutputs(a.addresses.bsvAddress);
  const pick = pickPneeInputs(outs, potHash160(a.addresses.bsvAddress), BigInt(Number.MAX_SAFE_INTEGER));
  return Number(pick.ok ? pick.total : pick.spendable);
};

export type PotPneePayment = { address: string; units: number };

/**
 * Sign (but don't broadcast) one PNEE transfer from the pot: the pot's valid PNEE outputs in, one BSV-21 transfer per
 * payment out, token change back to the pot, the overlay's per-output fee, the memo, and BSV change back to the pot.
 * Fees come from the pot's own BSV. Returns BEEF hex for broadcastPnee.
 */
export const signPneeFromPot = async (
  store: ChromeStorageService,
  potId: string,
  outputs: PotPneePayment[],
  memo?: string,
): Promise<{ rawTx: string; txid: string }> => {
  if (!PNEE_TOKEN_ID) throw new Error('PNEEs aren’t available');
  await assertNotPaused('spending');
  const acct = potAccount(store, potId);
  if (!acct?.encryptedKeys) throw new Error('This pot isn’t on this device');
  const passKey = await store.getPassKey();
  if (!passKey) throw new Error('Unlock the wallet first');
  const keys = JSON.parse(await decrypt(acct.encryptedKeys, passKey)) as { walletWif?: string };
  if (!keys.walletWif) throw new Error('This pot’s keys are incomplete');
  const pk = PrivateKey.fromWif(keys.walletWif);
  const from = acct.addresses.bsvAddress;
  if (pk.toAddress() !== from) throw new Error('Pot key mismatch');
  if (!outputs.length || outputs.some((o) => !Number.isInteger(o.units) || o.units <= 0))
    throw new Error('Bad PNEE amount');

  const need = outputs.reduce((n, o) => n + BigInt(o.units), BigInt(0));
  const cands = await potPneeOutputs(from);
  const pick = pickPneeInputs(cands, potHash160(from), need);
  if (!pick.ok) throw new Error(pick.reason);

  const details = await svc().bsv21.getTokenDetails(PNEE_TOKEN_ID, { fresh: true });
  const tx = new Transaction();
  for (const o of outputs)
    tx.addOutput({
      lockingScript: BSV21.transfer(PNEE_TOKEN_ID, BigInt(o.units)).lock(new P2PKH().lock(o.address)),
      satoshis: 1,
    });
  let tokenOuts = outputs.length;
  if (pick.change > BigInt(0)) {
    tx.addOutput({
      lockingScript: BSV21.transfer(PNEE_TOKEN_ID, pick.change).lock(new P2PKH().lock(from)),
      satoshis: 1,
    });
    tokenOuts++;
  }
  const feeAddr = details.status?.fee_address;
  const feePer = details.status?.fee_per_output;
  const overlayFee = pneeOverlayFee(feeAddr, feePer, tokenOuts);
  if (overlayFee) tx.addOutput({ lockingScript: new P2PKH().lock(feeAddr!), satoshis: overlayFee });
  if (memo) tx.addOutput({ lockingScript: memoScript(memo), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(from), change: true });

  const byOutpoint = new Map(cands.map((c) => [c.outpoint, c]));
  for (const i of pick.inputs) {
    const c = byOutpoint.get(i.outpoint)!;
    tx.addInput({
      sourceTransaction: c.tx,
      sourceOutputIndex: c.vout,
      sequence: 0xffffffff,
      unlockingScriptTemplate: new P2PKH().unlock(pk),
    });
  }
  // BSV for the token sats, the overlay fee and the mining fee, from the pot's own coins.
  const satsNeed = tokenOuts + overlayFee;
  const coins = await potCoins(from);
  let added = pick.inputs.length; // each token input carries 1 sat
  for (const c of coins.sort((a, b) => b.sats - a.sats)) {
    if (added >= satsNeed + 1000) break;
    const beef = await svc().beef.getBeef(c.txid);
    if (!beef.length) continue;
    tx.addInput({
      sourceTransaction: Transaction.fromBEEF([...beef], c.txid),
      sourceOutputIndex: c.vout,
      sequence: 0xffffffff,
      unlockingScriptTemplate: new P2PKH().unlock(pk),
    });
    added += c.sats;
  }
  if (added < satsNeed + 50) throw new Error('Not enough BSV in the pot for the network fee');
  await tx.fee(new SatoshisPerKilobyte(store.getCustomFeeRate()));
  await tx.sign();
  return { rawTx: Utils.toHex(tx.toBEEF()), txid: tx.id('hex') };
};

/**
 * Broadcast a signed PNEE transfer (BEEF hex), then hand it to the PNEE overlay so the payee can spend it. Idempotent:
 * the same tx again gets its current status. An overlay hiccup after a good broadcast doesn't fail the payment (the
 * wallet's unseen-output heal resubmits mined token txs).
 */
export const broadcastPnee = async (beefHex: string): Promise<void> => {
  const tx = Transaction.fromHexBEEF(beefHex);
  await broadcastRaw(tx.toHex());
  try {
    await svc().overlay.submitBsv21(Utils.toArray(beefHex, 'hex'), normId(PNEE_TOKEN_ID));
  } catch (e) {
    console.warn('[pots] PNEE overlay submit failed; the token heal retries it', e);
  }
};

/** OP_FALSE OP_RETURN <memo>: a 0-sat data output. */
export const memoScript = (memo: string) => {
  const data = Utils.toArray(memo, 'utf8');
  if (data.length > 75) throw new Error('Memo too long');
  return new LockingScript([{ op: OP.OP_FALSE }, { op: OP.OP_RETURN }, { op: data.length, data }]);
};

const REFUSED = new Set(['REJECTED', 'DOUBLE_SPEND_ATTEMPTED', 'INVALID', 'MALFORMED']);

/**
 * Broadcast a signed raw tx. Idempotent: sending the same tx again gets its current status (seen / mined),
 * so payDue can safely retry a payment whose first broadcast outcome it never recorded.
 */
export const broadcastRaw = async (rawTx: string): Promise<void> => {
  const r = await svc().submitToStack(Utils.toArray(rawTx, 'hex'));
  if (REFUSED.has(r.txStatus))
    throw new Error(`Payment refused by the network (${r.txStatus}${r.extraInfo ? `: ${r.extraInfo}` : ''})`);
};
