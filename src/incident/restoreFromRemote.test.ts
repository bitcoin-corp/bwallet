/**
 * INCIDENT (14 Oct 2026, $bug restore): a new device restored from seed shows 0 balance and no history.
 *
 * Local only: fake-indexeddb, a second StorageIdb standing in for wallet.1sat.app (the toolbox's StorageClient is
 * replaced by it), the real @1sat/wallet createWalletCore, and the production switch (services/restoreFromRemote.ts)
 * plus paymail history restore (mobile/names/paymail.ts) against a mocked endpoint. No network, random keys.
 */
import 'fake-indexeddb/auto';
import { describe, expect, mock, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { Services, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { createWalletCore } from '@1sat/wallet';
import {
  covers,
  isEmpty,
  summarizeActive,
  switchToLocalVerified,
  type SwitchDeps,
} from '../services/restoreFromRemote';

// Paymail on, pointed at the mocked endpoint (outside a build the constants are empty and paymail is off).
// Keep the real exports: bun module mocks are process-wide, and a partial mock left behind breaks later files that
// import other names from it.
const realNamesConfig = { ...(await import('../mobile/names/config')) };
mock.module('../mobile/names/config', () => ({
  ...realNamesConfig,
  BWALLET_PAYMAIL_DOMAIN: 'bwalletx.com',
  BWALLET_PAYMAIL_API: 'https://pay.test',
  LEGACY_PAYMAIL_DOMAINS: ['bwallet.space'],
  SIBLING_PAYMAIL_DOMAINS: ['bmailx.com'],
  BWALLET_PAYMAIL_DOMAINS: ['bwalletx.com', 'bmailx.com'],
  OPNS_PROFILE_DOMAIN: 'bwalletx.com',
}));

const HEIGHT = 971004;
const REMOTE = 'https://wallet.1sat.test';
/** $bug's five receipts (~272,000 sats). */
const BUG_PAYMENTS = [50_000, 60_000, 52_000, 55_000, 55_000];
const BUG_TOTAL = BUG_PAYMENTS.reduce((a, b) => a + b, 0);

const services = new Proxy(
  {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 }),
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
  } as Record<string, unknown>,
  {
    get: (t, p) =>
      p in t || typeof p === 'symbol' || p === 'then'
        ? t[p as string]
        : async () => {
            throw new Error(`mock services: ${String(p)}`);
          },
  },
) as never;

let n = 0;
const store = async (name: string) => {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  (s as unknown as { dbName: string }).dbName = name; // one IndexedDB per "device" (StorageIdb names it per chain)
  await s.migrate(name, `sik-${name}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
};

/** A paymail-style BRC-29 receipt (sender = anyone key, like the paymail server), mined. */
function receipt(kd: KeyDeriver, sats: number) {
  const anyone = new PrivateKey(1).toPublicKey().toString();
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const priv = kd.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, anyone);
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: sats });
  const txid = tx.id('hex');
  tx.merklePath = new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return {
    txid,
    beef,
    beefHex: beef.toHex(),
    anyone,
    outputs: [{ vout: 0, satoshis: sats, derivationPrefix, derivationSuffix }],
  };
}
type Receipt = ReturnType<typeof receipt>;

const internalize = (w: Wallet, r: Receipt) =>
  w.internalizeAction({
    tx: r.beef.toBinaryAtomic(r.txid),
    outputs: r.outputs.map((o) => ({
      outputIndex: o.vout,
      protocol: 'wallet payment' as const,
      paymentRemittance: {
        derivationPrefix: o.derivationPrefix,
        derivationSuffix: o.derivationSuffix,
        senderIdentityKey: r.anyone,
      },
    })),
    description: 'Paymail payment',
    labels: ['paymail'],
  });

/** Device A (the phone that collected): local-active, remote backup; collects, then pushes to the remote. */
async function phoneThatCollected(root: PrivateKey, opts: { push: boolean; failedSweep?: boolean }) {
  const kd = new KeyDeriver(root);
  const tag = ++n;
  const remote = await store(`remote-${tag}`);
  const local = await store(`phone-${tag}`);
  const sm = new WalletStorageManager(kd.identityKey, local, [remote]);
  await sm.makeAvailable();
  await sm.setActive(local.getSettings().storageIdentityKey);
  sm.setServices(services);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  const receipts = BUG_PAYMENTS.map((s) => receipt(kd, s));
  for (const r of receipts) await internalize(wallet, r);
  if (opts.failedSweep) {
    // dkg's shape: an action storage holds as failed though it mined. The record must travel with the restore.
    const { userId } = (await local.findUsers({ partial: { identityKey: kd.identityKey } }))[0];
    await local.insertTransaction({
      created_at: new Date(),
      updated_at: new Date(),
      transactionId: 0,
      userId,
      status: 'failed',
      reference: Utils.toBase64(Random(12)),
      isOutgoing: true,
      satoshis: 0,
      description: 'Sweep (failed but mined)',
      version: 1,
      lockTime: 0,
      txid: '9f66943b' + '00'.repeat(28),
    } as never);
  }
  if (opts.push) await sm.updateBackups();
  return { remote, receipts, tag, kd };
}

/** A fresh device (new browser profile): what initWallet + background do, with the remote faked. */
async function newDevice(
  root: PrivateKey,
  remote: StorageIdb,
  tag: number,
  faults: { failChunksAfter?: number; empty?: { on: boolean } } = {},
) {
  const local = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  const name = `new-${tag}-${++n}`;
  (local as unknown as { dbName: string }).dbName = name;
  await local.migrate(name, `sik-${name}`);
  (remote as unknown as { endpointUrl: string }).endpointUrl = REMOTE;
  // An interrupted connection: getSyncChunk fails once armed.
  let chunks = 0;
  let armed = false;
  const original = remote.getSyncChunk.bind(remote);
  remote.getSyncChunk = async (args) => {
    if (armed && faults.failChunksAfter !== undefined && chunks++ >= faults.failChunksAfter)
      throw new Error('network: connection reset');
    if (faults.empty?.on) {
      // A server answering with no rows: what an empty pull looks like from here.
      const c = await original(args);
      return {
        ...c,
        provenTxs: [],
        provenTxReqs: [],
        transactions: [],
        outputs: [],
        txLabelMaps: [],
        outputTagMaps: [],
        txLabels: [],
        outputTags: [],
        outputBaskets: [],
        certificates: [],
        certificateFields: [],
        commissions: [],
      };
    }
    return original(args);
  };
  class FakeStorageClient {
    constructor() {
      return remote;
    }
  }
  const core = await createWalletCore(
    { privateKey: root.toWif(), chain: 'main', activeRemote: REMOTE, backups: [] } as never,
    local,
    { Services, StorageClient: FakeStorageClient, StorageProvider, Wallet, WalletStorageManager } as never,
  );
  core.storage.setServices(services);
  (core.wallet as unknown as { services: unknown }).services = services; // no network in tests
  armed = true;
  const progress: string[] = [];
  const deps: SwitchDeps = {
    remoteUrl: REMOTE,
    activeRemoteUrl: () => core.storage.getStores().find((s) => s.isActive && !s.isConflicting)?.endpointURL,
    setActiveStorage: core.setActiveStorage,
    summarize: () => summarizeActive(core.wallet as never),
    pullRemote: async () => {
      await core.storage.syncFromReader((await core.storage.getAuth()).identityKey, remote as never);
    },
    progress: (m) => progress.push(m),
  };
  return { core, local, deps, progress };
}

const localSummary = async (local: StorageIdb) => {
  const outs = (await local.findOutputs({ partial: {} })).filter((o) => o.spendable);
  return {
    spendable: outs.reduce((s, o) => s + o.satoshis, 0),
    txs: await local.findTransactions({ partial: {}, noRawTx: true }),
  };
};

describe('restore on a new device pulls the backup store before the device store becomes active', () => {
  test('fresh restore: verified switch, right spendable balance, history and the failed-but-mined sweep record', async () => {
    const root = PrivateKey.fromRandom();
    const { remote, tag } = await phoneThatCollected(root, { push: true, failedSweep: true });
    const d = await newDevice(root, remote, tag);
    const r = await switchToLocalVerified(d.deps);
    expect(r.ok).toBe(true);
    expect(d.deps.activeRemoteUrl()).toBeUndefined(); // the device's store is active
    expect(d.progress[0]).toBe('Loading your wallet from backup…');
    const s = await localSummary(d.local);
    expect(s.spendable).toBe(BUG_TOTAL);
    expect(s.txs.length).toBe(6);
    expect(s.txs.find((t) => t.txid?.startsWith('9f66943b'))?.status).toBe('failed'); // recoverFailed takes it from here
    const listed = await d.core.wallet.listActions({ labels: ['paymail'], limit: 10 });
    expect(listed.totalActions).toBe(5); // history
  });

  test('interrupted pull keeps the backup store active, showing its balance; a later run completes', async () => {
    const root = PrivateKey.fromRandom();
    const { remote, tag } = await phoneThatCollected(root, { push: true });
    const d = await newDevice(root, remote, tag, { failChunksAfter: 0 });
    const r = await switchToLocalVerified(d.deps);
    expect(r.ok).toBe(false);
    expect(d.deps.activeRemoteUrl()).toBe(REMOTE);
    const shown = await d.deps.summarize();
    expect(shown.spendableSats).toBe(BUG_TOTAL); // the wallet shows the backup's records, not an empty device
    // Connection back: next open retries and completes.
    remote.getSyncChunk = Object.getPrototypeOf(remote).getSyncChunk.bind(remote);
    const again = await switchToLocalVerified(d.deps);
    expect(again.ok).toBe(true);
    expect((await localSummary(d.local)).spendable).toBe(BUG_TOTAL);
  });

  test('the incident: an empty pull used to leave the device active and empty; now it stays on the backup, and recovers', async () => {
    const root = PrivateKey.fromRandom();
    const { remote, tag } = await phoneThatCollected(root, { push: true });
    const empty = { on: true };
    const d = await newDevice(root, remote, tag, { empty });
    // Before the fix (background.preferLocalStorage): setActiveStorage('local') "succeeded" and localFirst was saved.
    await d.core.setActiveStorage('local');
    expect(d.deps.activeRemoteUrl()).toBeUndefined();
    expect(isEmpty(await d.deps.summarize())).toBe(true); // 0 balance, no history: what $bug's restore showed
    // Startup recovery on that stuck device while the backup still answers empty: verified → back to the backup.
    const stuck = await switchToLocalVerified(d.deps);
    expect(stuck.ok).toBe(false);
    expect(d.deps.activeRemoteUrl()).toBe(REMOTE);
    // The backup answers properly again: the next open pulls everything in, despite the earlier empty checkpoint.
    empty.on = false;
    const r = await switchToLocalVerified(d.deps);
    expect(r.ok).toBe(true);
    expect(d.deps.activeRemoteUrl()).toBeUndefined();
    expect((await localSummary(d.local)).spendable).toBe(BUG_TOTAL);
    expect(
      covers(r.ok ? r.local : { outputs: 0, spendableSats: 0, actions: 0 }, {
        outputs: 5,
        spendableSats: BUG_TOTAL,
        actions: 5,
      }),
    ).toBe(true);
  });

  test('re-runs are idempotent', async () => {
    const root = PrivateKey.fromRandom();
    const { remote, tag } = await phoneThatCollected(root, { push: true });
    const d = await newDevice(root, remote, tag);
    const a = await switchToLocalVerified(d.deps);
    const b = await switchToLocalVerified(d.deps);
    const c = await switchToLocalVerified(d.deps);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    const s = await localSummary(d.local);
    expect(s.spendable).toBe(BUG_TOTAL);
    expect(s.txs.length).toBe(5);
  });

  test('backup never received the receipts (phone local-active, never pushed): store restore finds nothing', async () => {
    const root = PrivateKey.fromRandom();
    const { remote, tag } = await phoneThatCollected(root, { push: false });
    const d = await newDevice(root, remote, tag);
    const r = await switchToLocalVerified(d.deps);
    expect(r.ok).toBe(true);
    expect(isEmpty(r.ok ? r.local : { outputs: 1, spendableSats: 0, actions: 1 })).toBe(true);
  });
});

describe('paymail history restore brings receipts back from the server record (seed + our server)', () => {
  test('re-internalizes collected receipts the device lacks; skips spent and held; idempotent', async () => {
    const { restorePaymailHistory } = await import('../mobile/names/paymail');
    const root = PrivateKey.fromRandom();
    const { remote, receipts, tag } = await phoneThatCollected(root, { push: false });
    const d = await newDevice(root, remote, tag);
    await switchToLocalVerified(d.deps);
    const spentTxid = receipts[4].txid; // spent on chain since: must not come back
    const rows = receipts.map((r, i) => ({
      reference: `ref-${i}`,
      txid: r.txid,
      beef: r.beefHex,
      rawTx: null,
      sender: 'alice@bwalletx.com',
      status: 'collected',
      outputs: r.outputs,
    }));
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      const body = JSON.parse(String(init?.body ?? '{}'));
      expect(body.signature).toBeTruthy();
      return new Response(JSON.stringify({ senderIdentityKey: receipts[0].anyone, payments: rows }), { status: 200 });
    }) as never;
    const held = async () => {
      const o = await d.core.wallet.listOutputs({ basket: 'default', limit: 100 });
      return new Set(o.outputs.map((x) => x.outpoint));
    };
    const deps = {
      hasOutput: async (txid: string, vout: number) => (await held()).has(`${txid}.${vout}`),
      isUnspent: async (txid: string) => txid !== spentTxid,
    };
    const r1 = await restorePaymailHistory(f, d.core.wallet as never, deps);
    expect(calls[0]).toBe('https://pay.test/api/paymail/history');
    expect(r1).toMatchObject({ payments: 5, restored: 4, spent: 1, errors: [] });
    expect(r1.satoshis).toBe(BUG_TOTAL - BUG_PAYMENTS[4]);
    expect((await d.deps.summarize()).spendableSats).toBe(BUG_TOTAL - BUG_PAYMENTS[4]);
    const r2 = await restorePaymailHistory(f, d.core.wallet as never, deps);
    expect(r2).toMatchObject({ restored: 0, alreadyHeld: 4, spent: 1 });
    expect((await d.deps.summarize()).spendableSats).toBe(BUG_TOTAL - BUG_PAYMENTS[4]);
  });
});
