import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { buildInscriptionScript, Inscription } from '@1sat/templates';
import {
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Script,
  Spend,
  Transaction,
  Utils,
  type CreateActionArgs,
  type CreateActionOutput,
} from '@bsv/sdk';
import { relayout, verifyBrc217 } from './brc217';
import { isInscriptionScript, issuerSigningKey, parseIssueScript, scriptSha256, verifyIssueTx } from './issuer';
import { withBrc217, withPublicMintSignature, type IssueRecord } from './issuerSign';
import { lockOfInscription, withExtraOutputs } from '../mint/mintMedia';
import { withFeeOutput } from '../mint/mint';
import { parseInscription as checkParse } from '../bmint/check/verify';
import { extractInscription } from '../media/nftViewer';
import { parseInscription as historyParse } from '../wallet/historyEvents';

const owner = PrivateKey.fromRandom();
const identityKey = owner.toPublicKey().toString();
const holder = PrivateKey.fromRandom();
const lock = new P2PKH().lock(holder.toPublicKey().toAddress());
const body = Utils.toArray('hello ordinal', 'utf8');
const MAP = { app: 'bWallet', type: 'ord', name: 'One' };
/** The script @1sat/actions inscribe builds today (envelope FIRST). */
const oldScript = (map: Record<string, string> | undefined = MAP) =>
  buildInscriptionScript(lock, new Uint8Array(body), 'text/plain', map).toHex();

/** ProtoWallet does the real BRC-42 signing; createAction just records its args. */
function fakeCtx() {
  const proto = new ProtoWallet(owner);
  const calls: CreateActionArgs[] = [];
  const wallet = new Proxy(proto, {
    get(t, p) {
      if (p === 'createAction')
        return async (a: CreateActionArgs) => {
          calls.push(a);
          return { txid: 'f'.repeat(64) };
        };
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { ctx: { wallet } as unknown as OneSatContext, calls };
}

const txOf = (outs: CreateActionOutput[]) => {
  const tx = new Transaction();
  for (const o of outs) tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
  return tx;
};
const out = (lockingScript: string): CreateActionOutput => ({
  lockingScript,
  satoshis: 1,
  outputDescription: 'Inscription',
});

describe('public mint signing (wallet path)', () => {
  test('BRC-217 on the inscription + the legacy issuer statement over the final script', async () => {
    const { ctx, calls } = fakeCtx();
    let rec: IssueRecord | null = null;
    const w = withPublicMintSignature(ctx, 'ordinal', (r) => (rec = r)).wallet;
    await w.createAction({ description: 'mint', outputs: [out(oldScript())] });
    const outs = calls[0].outputs!;
    expect(outs.length).toBe(2);
    const s = outs[0].lockingScript;
    expect(s.startsWith(lock.toHex())).toBe(true); // R1: lock first
    expect(s).not.toContain(Utils.toHex([0x68, 0x00, 0x6a])); // never OP_FALSE OP_RETURN
    const v = verifyBrc217(s);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.address).toBe(issuerSigningKey(identityKey).toAddress());
    expect(v.map).toEqual({ ...MAP, identity_key: identityKey });
    expect(rec!.scriptSha256).toBe(scriptSha256(s));
    expect(parseIssueScript(Script.fromHex(outs[1].lockingScript))?.fields.script_sha256).toBe(scriptSha256(s));
    const tx = txOf(outs);
    expect(verifyIssueTx(tx, `${tx.id('hex')}_0`).ok).toBe(true);
  });

  test('BRC-217 alone verifies (bAvatar, ticket icons: no statement output)', async () => {
    const { ctx, calls } = fakeCtx();
    await withBrc217(ctx).wallet.createAction({ description: 'mint', outputs: [out(oldScript())] });
    const outs = calls[0].outputs!;
    expect(outs.length).toBe(1);
    const tx = txOf(outs);
    const r = verifyIssueTx(tx, `${tx.id('hex')}_0`);
    expect(r.ok && r.identityKey).toBe(identityKey);
  });

  test('a BRC-217 author section claiming someone else’s identity key fails', async () => {
    const { ctx, calls } = fakeCtx();
    await withBrc217(ctx).wallet.createAction({ description: 'mint', outputs: [out(oldScript())] });
    const other = PrivateKey.fromRandom().toPublicKey().toString();
    const forged = calls[0].outputs![0].lockingScript.replace(
      Utils.toHex(Utils.toArray(identityKey, 'utf8')),
      Utils.toHex(Utils.toArray(other, 'utf8')),
    );
    const tx = txOf([{ ...out(forged) }]);
    expect(verifyIssueTx(tx, `${tx.id('hex')}_0`).ok).toBe(false);
  });

  test('fee output, editions and the poster: every inscription signed, fee untouched', async () => {
    const { ctx, calls } = fakeCtx();
    const feeAddr = PrivateKey.fromRandom().toPublicKey().toAddress();
    const poster = {
      base64Content: Utils.toBase64(body),
      contentType: 'image/png',
      map: { app: 'bWallet', type: 'ord' },
    };
    const wrapped = withFeeOutput(
      withExtraOutputs(withPublicMintSignature(ctx, 'ordinal'), { copies: 3, poster }),
      7,
      feeAddr,
    );
    await wrapped.wallet.createAction({ description: 'mint', outputs: [out(oldScript())] });
    const outs = calls[0].outputs!;
    // 3 editions, poster, fee, issuer statement.
    expect(outs.length).toBe(6);
    for (const o of outs.slice(0, 4)) expect(verifyBrc217(o.lockingScript).ok).toBe(true);
    expect(outs[0].lockingScript).toBe(outs[2].lockingScript);
    expect(outs[4].lockingScript).toBe(new P2PKH().lock(feeAddr).toHex());
    expect(outs[4].satoshis).toBe(7);
    expect(outs[5].satoshis).toBe(0);
    for (const o of outs.slice(0, 4)) expect(lockOfInscription(o.lockingScript)!.toHex()).toBe(lock.toHex());
  });

  test('passes through when there is no inscription, and only for the NEXT action', async () => {
    const { ctx, calls } = fakeCtx();
    const w = withBrc217(ctx).wallet;
    const plain = { lockingScript: lock.toHex(), satoshis: 5, outputDescription: 'x' };
    await w.createAction({ description: 'a', outputs: [plain] });
    await w.createAction({ description: 'b', outputs: [out(oldScript())] });
    expect(calls[0].outputs).toEqual([plain]);
    expect(calls[1].outputs![0].lockingScript).toBe(oldScript());
  });

  test('collection item: MAP subTypeData (the parent collectionId) survives byte for byte', async () => {
    const collectionId = `${'a'.repeat(64)}_0`;
    const map = {
      app: 'bWallet',
      type: 'ord',
      name: 'Item',
      subType: 'collectionItem',
      subTypeData: JSON.stringify({ collectionId }),
    };
    const { ctx, calls } = fakeCtx();
    await withPublicMintSignature(ctx, 'ordinal').wallet.createAction({
      description: 'm',
      outputs: [out(oldScript(map))],
    });
    const v = verifyBrc217(calls[0].outputs![0].lockingScript);
    expect(v.ok && JSON.parse(v.map.subTypeData).collectionId).toBe(collectionId);
  });
});

describe('the satoshi stays spendable (R3/R4)', () => {
  const spend = (lockingHex: string) => {
    const src = new Transaction();
    src.addOutput({ lockingScript: Script.fromHex(lockingHex), satoshis: 1 });
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(holder) });
    tx.addOutput({ lockingScript: lock, satoshis: 1 });
    return tx;
  };
  const run = async (lockingHex: string) => {
    const tx = spend(lockingHex);
    await tx.sign();
    const s = new Spend({
      sourceTXID: tx.inputs[0].sourceTransaction!.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      lockingScript: Script.fromHex(lockingHex),
      transactionVersion: tx.version,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript: tx.inputs[0].unlockingScript!,
      outputs: tx.outputs,
      inputSequence: tx.inputs[0].sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    });
    try {
      return s.validate();
    } catch {
      return false;
    }
  };
  test('BRC-217 output spends through its P2PKH lock; OP_FALSE OP_RETURN does not', async () => {
    const { ctx, calls } = fakeCtx();
    await withBrc217(ctx).wallet.createAction({ description: 'mint', outputs: [out(oldScript())] });
    const signed = calls[0].outputs![0].lockingScript;
    expect(await run(signed)).toBe(true);
    const bare = Utils.toHex(relayout(oldScript({}))!.signedRange); // <lock> <envelope> 6a
    expect(await run(bare)).toBe(true);
    expect(await run(bare.slice(0, -2) + '006a')).toBe(false);
  });
});

describe('readers accept both layouts', () => {
  const both = async () => {
    const { ctx, calls } = fakeCtx();
    await withBrc217(ctx).wallet.createAction({ description: 'mint', outputs: [out(oldScript())] });
    return { old: oldScript(), brc217: calls[0].outputs![0].lockingScript };
  };
  test('bMint check, NFT viewer, history, lock, 1Sat decode, issuer helpers', async () => {
    for (const hex of Object.values(await both())) {
      const s = Script.fromHex(hex);
      expect(checkParse(s)).toEqual({ contentType: 'text/plain', body, name: 'One' });
      const ins = extractInscription(s)!;
      expect(ins.contentType).toBe('text/plain');
      expect(Array.from(ins.data)).toEqual(body);
      expect(historyParse(hex)?.contentType).toBe('text/plain');
      expect(lockOfInscription(hex)!.toHex()).toBe(lock.toHex());
      expect(isInscriptionScript(hex)).toBe(true);
      const d = Inscription.decode(s)!;
      expect(d.file.type).toBe('text/plain');
      expect(Array.from(d.file.content)).toEqual(body);
    }
  });
  test('old-form mints keep verifying through the legacy statement; unsigned old form is unverified', () => {
    const tx = txOf([out(oldScript())]);
    expect(verifyIssueTx(tx, `${tx.id('hex')}_0`)).toEqual({ ok: false, reason: 'no issuer signature' });
  });
});
