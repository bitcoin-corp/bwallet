/**
 * The one "mint media" routine, shared by the Mint screen (MintButton.tsx) and paired-CLI minting
 * (pair/agentPairing.ts, scope "mint"). Same transactions either way:
 *   inscribe (no collection) · mintCollection + mintCollectionItem (new) · mintCollectionItem (existing),
 * the 1% bWallet mint fee output on the item tx (withFeeOutput), the issuer signature in the same tx
 * (withIssuerSignature) and registration with bit-sign after broadcast (registerIssuer).
 */
import { inscribe, mintCollection, mintCollectionItem, type OneSatContext } from '@1sat/actions';
import { Hash, Script, Transaction, Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import { buildInscriptionScript } from '@1sat/templates';
import { withPublicMintSignature } from '../issuer/issuerSign';
import { findEnvelope, OP_RETURN as RET, tokenize } from '../issuer/brc217';
import { registerIssuer } from '../issuer/issuerVerify';
import { buildMap, collectionIdFrom, MINT_APP, withFeeOutput, type Collection } from './mint';

export type MintMediaInput = {
  base64Content: string;
  contentType: string;
  title: string;
  description: string;
  collection: Collection;
  /** The 1% mint fee in sats (estimateCost().feeSats); 0 = no fee output. */
  feeSats: number;
  /** MAP to inscribe instead of buildMap's (no collection only), e.g. bPics' share tag (bpics/bpics.ts). */
  map?: Record<string, string>;
  /** No collection only: N identical inscription outputs in this one tx (mintKinds.planEditions; 1 = just one). */
  copies?: number;
  /** No collection only: a companion image inscription in the same tx (vout = copies), referenced as MAP poster "_n". */
  poster?: { base64Content: string; contentType: string; map: Record<string, string> };
};
export type MintMediaResult = {
  txid: string;
  /** The new item's outpoint; a fresh inscription's origin is the same outpoint. */
  outpoint: string;
  origin: string;
  collectionId?: string;
  /** Network fees of every tx this mint created, where the wallet returned the tx (else null). */
  networkSats: number | null;
};

/**
 * Wraps ctx so every createAction's network fee is added up (from the returned atomic BEEF).
 * `total()` is null when any tx couldn't be measured.
 */
export function meterFees(ctx: OneSatContext): { ctx: OneSatContext; total: () => number | null } {
  let sum = 0;
  let unknown = false;
  const wallet = new Proxy(ctx.wallet as WalletInterface, {
    get(target, prop, receiver) {
      if (prop === 'createAction') {
        return async (args: CreateActionArgs, originator?: string) => {
          const r = await target.createAction(args, originator);
          try {
            if (!r.tx) throw new Error('no tx');
            sum += Transaction.fromAtomicBEEF(r.tx).getFee();
          } catch {
            unknown = true;
          }
          return r;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ctx: { ...ctx, wallet } as OneSatContext, total: () => (unknown ? null : sum) };
}

/**
 * The owner lock of a 1Sat inscription script, either layout:
 *   old (@1sat/templates): [OP_FALSE OP_IF ord … OP_ENDIF] <lock> [OP_RETURN MAP…]
 *   BRC-217:               <lock> [OP_FALSE OP_IF ord … OP_ENDIF] OP_RETURN [MAP…] | AIP …
 */
export function lockOfInscription(hex: string): Script | null {
  let bytes: number[];
  let ops;
  try {
    bytes = Utils.toArray(hex, 'hex');
    ops = tokenize(bytes);
  } catch {
    return null;
  }
  const env = findEnvelope(ops);
  if (!env) return null;
  if (env.start > 0) return Script.fromBinary(bytes.slice(0, ops[env.start].start));
  const rest = ops.slice(env.endif + 1);
  const ret = rest.findIndex((o) => o.op === RET && !o.data);
  const lock = ret < 0 ? rest : rest.slice(0, ret);
  return lock.length ? Script.fromBinary(bytes.slice(lock[0].start, lock[lock.length - 1].end)) : null;
}

/** 1Sat stamps `id:<actionId>_<index>` per basketed output before createAction; keep the index true after inserting. */
export function restampIds<T extends { basket?: string; tags?: string[] }>(outputs: T[]): T[] {
  const idTag = outputs.flatMap((o) => o.tags ?? []).find((t) => t.startsWith('id:'));
  const actionId = idTag?.slice(3).replace(/_\d+$/, '');
  if (!actionId) return outputs;
  return outputs.map((o, i) =>
    o.basket ? { ...o, tags: [...(o.tags ?? []).filter((t) => !t.startsWith('id:')), `id:${actionId}_${i}`] } : o,
  );
}

type ExtraOuts = { copies: number; poster?: MintMediaInput['poster'] };

/**
 * A context whose wallet, on the NEXT createAction, puts N-1 copies of output 0 (the inscription) right after it,
 * then the poster inscription (same owner lock and wallet instructions, its own type/sha256 tags). Outputs are
 * not randomised by inscribe, so the editions are vouts 0…N-1 and the poster is vout N.
 */
export function withExtraOutputs(ctx: OneSatContext, extra: ExtraOuts): OneSatContext {
  const copies = Math.max(1, Math.floor(extra.copies) || 1);
  if (copies === 1 && !extra.poster) return ctx;
  let done = false;
  const wallet = new Proxy(ctx.wallet as WalletInterface, {
    get(target, prop, receiver) {
      if (prop === 'createAction' && !done) {
        return (args: CreateActionArgs, originator?: string) => {
          done = true;
          const outs = args.outputs ?? [];
          const first = outs[0];
          if (!first) return target.createAction(args, originator);
          const added = Array.from({ length: copies - 1 }, (_, i) => ({
            ...first,
            outputDescription: `Inscription (edition ${i + 2} of ${copies})`,
          }));
          if (extra.poster) {
            const lock = lockOfInscription(first.lockingScript);
            if (!lock) throw new Error('Could not attach the cover picture');
            const body = Utils.toArray(extra.poster.base64Content, 'base64');
            const script = buildInscriptionScript(
              lock,
              new Uint8Array(body),
              extra.poster.contentType,
              extra.poster.map,
            );
            const tags = (first.tags ?? []).filter((t) => !t.startsWith('type:') && !t.startsWith('sha256:'));
            added.push({
              ...first,
              lockingScript: script.toHex(),
              outputDescription: 'Cover picture (inscription)',
              tags: [`type:${extra.poster.contentType}`, ...tags, `sha256:${Utils.toHex(Hash.sha256(body))}`],
            });
          }
          return target.createAction({ ...args, outputs: restampIds([first, ...added, ...outs.slice(1)]) }, originator);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

export async function mintMedia(apiContext: OneSatContext, m: MintMediaInput): Promise<MintMediaResult> {
  const meter = meterFees(apiContext);
  const base = meter.ctx;
  const { base64Content, contentType, collection, feeSats } = m;
  const name = m.title.trim();
  const description = m.description.trim();
  let signedAt: number | null = null;
  // Innermost wrapper: the fee output and the editions / poster are added first, then every inscription output
  // becomes BRC-217 (lock first, signed), then the legacy issuer statement hashes that final script.
  const signed = (ctx: OneSatContext) =>
    withPublicMintSignature(ctx, 'ordinal', (r) => {
      signedAt = r.index;
    });
  const register = (txid?: string) => {
    if (txid && signedAt !== null) void registerIssuer(`${txid}_${signedAt}`);
    signedAt = null;
  };
  let res: { txid?: string; error?: string };
  let collectionId: string | undefined;
  if (collection.kind === 'none') {
    const extras = withExtraOutputs(signed(base), { copies: m.copies ?? 1, poster: m.poster });
    res = await inscribe.execute(withFeeOutput(extras, feeSats), {
      base64Content,
      contentType,
      map: m.map ?? buildMap({ title: name, description, collection }),
    });
  } else {
    collectionId = collection.kind === 'existing' ? collection.id : '';
    if (collection.kind === 'new') {
      const c = await mintCollection.execute(signed(base), {
        base64Content,
        contentType,
        name: collection.name.trim(),
        description,
        quantity: 1000,
        app: MINT_APP,
      });
      if (!c.txid || c.error) throw new Error(c.error || 'Collection mint failed');
      register(c.txid);
      collectionId = collectionIdFrom(c.txid, c.collectionId);
    }
    res = await mintCollectionItem.execute(withFeeOutput(signed(base), feeSats), {
      base64Content,
      contentType,
      name,
      collectionId,
      app: MINT_APP,
    });
  }
  if (!res.txid || res.error) throw new Error(res.error || 'Mint failed');
  register(res.txid);
  // Output 0 is the inscription (withFeeOutput and the issuer signature append after it).
  const outpoint = `${res.txid}_0`;
  return {
    txid: res.txid,
    outpoint,
    origin: outpoint,
    ...(collectionId && { collectionId }),
    networkSats: meter.total(),
  };
}
