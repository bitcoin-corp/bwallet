/**
 * The account's legacy ordinals address (addresses.ordAddress, the Yours-style m/44'/236'/1'/0/0 key), watched by
 * the wallet's ongoing sync (owner, 24 Oct 2026: "watch the old ord address").
 *
 * Our paymail server hands that address to senders (pay.bwallet.space /api/paymail/ord/<paymail>), so an NFT sent
 * to $name lands there. The BRC-100 wallet only scans its own BRC-42 deposit keys, so those NFTs never reached
 * Wallet › NFTs. Here:
 *
 *  - installLegacyOrdSigner: the base wallet answers getPublicKey / createSignature for one wallet-only protocol
 *    (LEGACY_ORD_PROTOCOL, keyID 'ord') with the legacy ord key itself. Outside apps can never reach it
 *    (services/reservedProtocols.ts refuses the protocol before any prompt).
 *  - syncLegacyOrd: each unspent 1-sat ordinal at the address (with an origin; never Run jigs, OpNS names, tokens or
 *    plain BSV) is internalized into the ordinals basket with customInstructions naming that protocol. @1sat/actions
 *    then signs sends, listings and avatar moves through signOrdinalInput → the signer above, like any other NFT.
 *
 * Nothing is moved or broadcast here: the outputs stay where they are. Accounts without a key for the address
 * (passkey / seedless, an address that does not match the stored key) are skipped.
 */
import { BigNumber, ECDSA, Hash, PrivateKey } from '@bsv/sdk';
import type { WalletInterface } from '@bsv/sdk';
import type { OneSatServices } from '@1sat/client';
import { internalizeBeef } from '@1sat/actions';
import { ORDINALS_BASKET } from '@1sat/types';
import { scanAddress } from '../sweep/scanner';

/** Wallet-only protocol whose single key ('ord') is the legacy ord key. Listed in reservedProtocolList.ts. */
export const LEGACY_ORD_PROTOCOL: [2, string] = [2, 'bwalletx legacy ord'];
export const LEGACY_ORD_KEY_ID = 'ord';

const isLegacyOrdCall = (args: { protocolID?: unknown; keyID?: unknown; counterparty?: unknown }) =>
  Array.isArray(args.protocolID) &&
  args.protocolID[0] === LEGACY_ORD_PROTOCOL[0] &&
  typeof args.protocolID[1] === 'string' &&
  args.protocolID[1].trim().toLowerCase() === LEGACY_ORD_PROTOCOL[1] &&
  args.keyID === LEGACY_ORD_KEY_ID &&
  (args.counterparty === undefined || args.counterparty === 'self');

/**
 * The legacy ord key, only when it really is the key for the account's ordAddress. undefined: nothing to watch
 * (no ordWif stored, e.g. a passkey or seedless account, or a mismatch).
 */
export const legacyOrdKey = (ordWif: string | undefined, ordAddress: string | undefined): PrivateKey | undefined => {
  if (!ordWif || !ordAddress) return undefined;
  try {
    const key = PrivateKey.fromWif(ordWif);
    return key.toPublicKey().toAddress() === ordAddress ? key : undefined;
  } catch {
    return undefined;
  }
};

type SignerWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

let watching: string | undefined;
/** The legacy ord address this context's wallet can sign for ('' / undefined: none, so nothing to take in). */
export const watchedLegacyOrdAddress = () => watching;

/**
 * Patch the base wallet in place (like guardSpending) so the legacy ord protocol signs with `key`. Every other call
 * goes through unchanged. Returns an undo function (tests).
 */
export const installLegacyOrdSigner = (wallet: SignerWallet, key: PrivateKey): (() => void) => {
  const getPublicKey = wallet.getPublicKey.bind(wallet);
  const createSignature = wallet.createSignature.bind(wallet);
  const pub = key.toPublicKey().toString();
  watching = key.toPublicKey().toAddress();
  wallet.getPublicKey = (async (args, originator) => {
    if (!args.identityKey && isLegacyOrdCall(args)) return { publicKey: pub };
    return getPublicKey(args, originator);
  }) as WalletInterface['getPublicKey'];
  wallet.createSignature = (async (args, originator) => {
    if (!isLegacyOrdCall(args)) return createSignature(args, originator);
    const hash = args.hashToDirectlySign ?? (args.data ? Hash.sha256(args.data) : undefined);
    if (!hash) throw new Error('args.data or args.hashToDirectlySign must be valid');
    return { signature: ECDSA.sign(new BigNumber(hash), key, true).toDER() as number[] };
  }) as WalletInterface['createSignature'];
  return () => {
    watching = undefined;
    wallet.getPublicKey = getPublicKey;
    wallet.createSignature = createSignature;
  };
};

/** "txid_vout" / "txid.vout" → "txid_vout", lower case. */
export const normOutpoint = (o: string) => o.toLowerCase().replace('.', '_');

const TAKEN_KEY = 'bwx.legacyOrd.takenIn';
/** Outpoints (normalised) this device took in from the legacy ord address. Shown only once kept (legacyOrdVisible). */
export const takenInLegacy = (): Set<string> => {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(TAKEN_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
};
const rememberTakenIn = (ops: string[]) => {
  if (!ops.length) return;
  try {
    globalThis.localStorage?.setItem(TAKEN_KEY, JSON.stringify([...new Set([...takenInLegacy(), ...ops])]));
  } catch {
    // no storage here: the list then hides nothing extra, the inbox's Quarantine still applies on screen
  }
};

/**
 * Quarantine wins (owner review, 24 Oct 2026): an NFT taken in from the legacy ord address shows in Wallet › NFTs
 * only once it is kept (or its sender trusted) in bMail. `kept`: the inbox's kept NFTs (airdrops/inbox keptNfts).
 */
export const legacyOrdVisible = (
  outpoint: string,
  legacy: Set<string>,
  kept: { txid: string; outpoint?: string }[],
): boolean => {
  const op = normOutpoint(outpoint);
  if (!legacy.has(op)) return true;
  return kept.some((k) => (k.outpoint ? normOutpoint(k.outpoint) === op : op.split('_')[0] === k.txid.toLowerCase()));
};

type ListWallet = Pick<WalletInterface, 'listOutputs' | 'internalizeAction'>;

/** Outpoints already in the wallet's ordinals basket (normalised). */
export const heldOrdinals = async (wallet: Pick<WalletInterface, 'listOutputs'>): Promise<Set<string>> => {
  const held = new Set<string>();
  const limit = 1000;
  for (let offset = 0; offset < 20_000; offset += limit) {
    const r = await wallet.listOutputs({ basket: ORDINALS_BASKET, limit, offset });
    for (const o of r.outputs) held.add(normOutpoint(o.outpoint));
    if (r.outputs.length < limit) break;
  }
  return held;
};

export type LegacyOrdDeps = {
  wallet: ListWallet;
  services: OneSatServices;
  chain: 'main' | 'test';
  address: string;
  /** Test seams. */
  scan?: typeof scanAddress;
  internalize?: typeof internalizeBeef;
};

/** Take the address's unspent ordinals into the ordinals basket. Returns how many were added / failed. */
export const syncLegacyOrd = async (deps: LegacyOrdDeps): Promise<{ added: number; failed: number }> => {
  const scan = deps.scan ?? scanAddress;
  const internalize = deps.internalize ?? internalizeBeef;
  const { ordinals } = await scan(deps.services, deps.address);
  const held = await heldOrdinals(deps.wallet);
  // Only real ordinals (an origin the indexer knows); grouped per tx so one internalize takes all its vouts.
  const byTxid = new Map<string, number[]>();
  for (const o of ordinals) {
    if ((o.satoshis ?? 0) !== 1 || !o.origin) continue;
    const op = normOutpoint(o.outpoint);
    if (held.has(op)) continue;
    const [txid, vout] = op.split('_');
    const n = Number(vout);
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(n) || n < 0) continue;
    byTxid.set(txid, [...(byTxid.get(txid) ?? []), n]);
  }
  let added = 0;
  let failed = 0;
  for (const [txid, vouts] of byTxid) {
    try {
      const beef = await deps.services.beef.getBeef(txid);
      if (!beef) throw new Error(`no BEEF for ${txid}`);
      const r = await internalize({
        beef,
        wallet: deps.wallet as WalletInterface,
        services: deps.services,
        chain: deps.chain,
        outputs: vouts.map((outputIndex) => ({
          outputIndex,
          protocolID: LEGACY_ORD_PROTOCOL,
          keyID: LEGACY_ORD_KEY_ID,
          counterparty: 'self',
        })),
      } as Parameters<typeof internalizeBeef>[0]);
      added += r.internalized;
      rememberTakenIn(vouts.map((v) => `${txid}_${v}`));
    } catch (err) {
      failed++;
      console.warn('[legacyOrd] could not take in', txid, err);
    }
  }
  return { added, failed };
};

/** For screens (Refresh NFTs, bMail Keep): take in the watched address's NFTs with the screen's wallet context. */
export const takeInLegacyOrd = async (ctx: {
  wallet: unknown;
  services?: OneSatServices;
  chain?: 'main' | 'test';
}): Promise<{ added: number; failed: number }> => {
  const address = watchedLegacyOrdAddress();
  if (!address || !ctx.services) return { added: 0, failed: 0 };
  return syncLegacyOrd({
    wallet: ctx.wallet as ListWallet,
    services: ctx.services,
    chain: ctx.chain ?? 'main',
    address,
  });
};
