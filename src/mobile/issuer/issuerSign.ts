import { applyAip, type OneSatContext } from '@1sat/actions';
import { PublicKey, Signature, Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import { finish, messageHash, relayout, toRecoverable } from './brc217';
import {
  inscriptionTicker,
  isInscriptionScript,
  issueMapScript,
  ISSUER_KEY_ID,
  ISSUER_PROTOCOL,
  scriptSha256,
  type IssueKind,
} from './issuer';

/** What the wrapper signed (set once the next createAction ran). */
export interface IssueRecord {
  /** Index of the token output in the createAction outputs (its vout unless outputs are randomised). */
  index: number;
  scriptSha256: string;
  ticker: string | null;
  identityKey: string;
}

/**
 * Context whose wallet adds a signed issuer statement (issuer.ts) to the NEXT createAction:
 * it finds the first 1-sat inscription output (the token / NFT), hashes it, signs
 * MAP issue … with the identity key's [2,'bwallet issuer'] child via @1sat/actions applyAip
 * (the same AIP path feed posts use), and appends it as a 0-sat OP_RETURN output.
 *
 * Never blocks a mint: if there is no inscription output, or signing fails, the action goes
 * ahead unsigned (the token then shows as "Unverified issuer").
 */
export function withIssuerSignature(
  ctx: OneSatContext,
  kind: IssueKind,
  onSigned?: (r: IssueRecord) => void,
): OneSatContext {
  let done = false;
  const base = ctx.wallet as WalletInterface;
  const wallet = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'createAction' && !done) {
        return async (args: CreateActionArgs, originator?: string) => {
          done = true;
          const outs = args.outputs ?? [];
          const index = outs.findIndex((o) => o.satoshis === 1 && isInscriptionScript(o.lockingScript));
          if (index < 0) return target.createAction(args, originator);
          try {
            const { publicKey: identityKey } = await target.getPublicKey({ identityKey: true });
            const tokenHex = outs[index].lockingScript;
            const rec: IssueRecord = {
              index,
              scriptSha256: scriptSha256(tokenHex),
              ticker: kind === 'bsv21' ? inscriptionTicker(tokenHex) : null,
              identityKey,
            };
            const unsigned = issueMapScript({ kind, ticker: rec.ticker, scriptSha256: rec.scriptSha256, identityKey });
            const signed = await applyAip(
              { ...ctx, wallet: target } as OneSatContext,
              unsigned,
              ISSUER_PROTOCOL,
              ISSUER_KEY_ID,
              'anyone',
            );
            onSigned?.(rec);
            return target.createAction(
              {
                ...args,
                outputs: [
                  ...outs,
                  { lockingScript: signed.toHex(), satoshis: 0, outputDescription: 'Issuer signature (MAP + AIP)' },
                ],
              },
              originator,
            );
          } catch (e) {
            console.warn('[issuer] could not sign issuer statement; minting unsigned:', e);
            return target.createAction(args, originator);
          }
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

/**
 * Context whose wallet, on the NEXT createAction, turns every 1-sat inscription output @1sat/actions built
 * (`<envelope> <lock> OP_RETURN MAP…`) into a BRC-217 Authenticated 1Sat Inscription (brc217.ts):
 *
 *   <lock> <envelope> OP_RETURN MAP… identity_key <hex> | AIP <address> BITCOIN_ECDSA <65-byte sig> -1
 *
 * Signed by the same key as the issuer statement: the identity key's BRC-42 child [2,'bwallet issuer'] / '1' /
 * counterparty 'anyone', through the wallet's own createSignature (the wallet never signs with its root key).
 * `identity_key` in the MAP lets anyone re-derive that child and bind the signature to the account with no
 * extra output (issuer.ts verifyIssueTx). Public mints only; private mints never pass through here.
 *
 * Never blocks a mint: if signing fails the outputs go out exactly as @1sat built them.
 */
export function withBrc217(ctx: OneSatContext): OneSatContext {
  let done = false;
  const base = ctx.wallet as WalletInterface;
  const wallet = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'createAction' && !done) {
        return async (args: CreateActionArgs, originator?: string) => {
          done = true;
          const outs = args.outputs ?? [];
          if (!outs.some((o) => o.satoshis === 1 && isInscriptionScript(o.lockingScript)))
            return target.createAction(args, originator);
          try {
            const { publicKey: identityKey } = await target.getPublicKey({ identityKey: true });
            const keyArgs = { protocolID: ISSUER_PROTOCOL, keyID: ISSUER_KEY_ID, counterparty: 'anyone' as const };
            const { publicKey } = await target.getPublicKey({ ...keyArgs, forSelf: true });
            const pub = PublicKey.fromString(publicKey);
            const address = pub.toAddress();
            const signed = new Map<string, string>();
            const outputs = [];
            for (const o of outs) {
              const u =
                o.satoshis === 1 ? relayout(o.lockingScript, [['identity_key', identityKey.toLowerCase()]]) : null;
              if (!u) {
                outputs.push(o);
                continue;
              }
              let script = signed.get(o.lockingScript);
              if (!script) {
                const hash = messageHash(u.signedRange);
                const { signature } = await target.createSignature({ ...keyArgs, hashToDirectlySign: hash });
                const sig = toRecoverable(Signature.fromDER(Array.from(signature)), pub, hash);
                script = Utils.toHex(finish(u, address, sig));
                signed.set(o.lockingScript, script);
              }
              outputs.push({ ...o, lockingScript: script });
            }
            return target.createAction({ ...args, outputs }, originator);
          } catch (e) {
            console.warn('[issuer] could not sign BRC-217 inscription; minting unsigned:', e);
            return target.createAction(args, originator);
          }
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

/**
 * A public mint's signing: BRC-217 on the inscription output(s) (outer proxy, runs first), then the legacy issuer
 * statement output over the FINAL script (inner, so its script_sha256 is of the BRC-217 script). The legacy output
 * stays because bit-sign verifies it server-side (issuer registry, launch registry, bMovies claim: issuer-sig.ts).
 */
export const withPublicMintSignature = (
  ctx: OneSatContext,
  kind: IssueKind,
  onSigned?: (r: IssueRecord) => void,
): OneSatContext => withBrc217(withIssuerSignature(ctx, kind, onSigned));
