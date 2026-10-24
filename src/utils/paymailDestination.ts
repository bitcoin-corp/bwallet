import { KeyDeriver, P2PKH, PrivateKey } from '@bsv/sdk';

/**
 * Check a paymail host's P2P destination against the payee's identity key (b_feedback 67).
 *
 * Our paymail server (site/lib/paymail.js deriveDestination) builds each output as BRC-29 with the "anyone" key
 * (private key 1) as sender: child = identityKey.deriveChild(anyone, "2-3241645161d8-<prefix> <suffix>"), P2PKH.
 * It returns derivationPrefix/derivationSuffix with each script, so the wallet re-derives the script from the key the
 * payer saw (pki + signed name binding) and refuses anything else. A host that sends no derivation can't be checked.
 */

export type P2pOutput = {
  script: string;
  satoshis: number;
  derivationPrefix?: string;
  derivationSuffix?: string;
  senderIdentityKey?: string;
};

const BRC29: [2, string] = [2, '3241645161d8'];
const anyone = new KeyDeriver(new PrivateKey(1));
const ANYONE_PUB = new PrivateKey(1).toPublicKey().toString();

/** The P2PKH script our host derives for `identityKey` with this prefix/suffix. */
export const brc29Script = (identityKey: string, prefix: string, suffix: string): string =>
  new P2PKH().lock(anyone.derivePublicKey(BRC29, `${prefix} ${suffix}`, identityKey, false).toAddress()).toHex();

export type DestinationCheck = { ok: true; verified: boolean } | { ok: false; error: string };

const refuse = (why: string): DestinationCheck => ({
  ok: false,
  error: `Payment refused: ${why}. Nothing was sent.`,
});

/**
 * Every output must re-derive from `identityKey`. Outputs with no derivation at all → { verified: false } (the
 * caller decides whether that's allowed); some with and some without, or any mismatch → refused.
 */
export const checkP2pDestination = (
  identityKey: string | undefined,
  outputs: readonly P2pOutput[],
): DestinationCheck => {
  if (!Array.isArray(outputs) || !outputs.length) return refuse('the paymail host returned no outputs');
  const has = outputs.filter((o) => o && (o.derivationPrefix !== undefined || o.derivationSuffix !== undefined));
  if (!has.length) return { ok: true, verified: false };
  if (has.length !== outputs.length) return refuse('the paymail host returned an output it would not let us check');
  if (!identityKey) return refuse("we don't know the payee's key to check the paymail host's address against");
  for (const o of outputs) {
    if (typeof o.derivationPrefix !== 'string' || typeof o.derivationSuffix !== 'string')
      return refuse('the paymail host returned a malformed derivation');
    if (o.senderIdentityKey !== undefined && o.senderIdentityKey !== ANYONE_PUB)
      return refuse('the paymail host used a derivation we can not check');
    let want: string;
    try {
      want = brc29Script(identityKey, o.derivationPrefix, o.derivationSuffix);
    } catch {
      return refuse("the payee's key is not valid");
    }
    if (String(o.script).toLowerCase() !== want)
      return refuse("the paymail host's address does not belong to the payee's key");
  }
  return { ok: true, verified: true };
};
