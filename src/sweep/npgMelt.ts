import { BSM, OP, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import { chainSaysUnknown } from '../services/unsentGuard';
import { deriveDepositAddresses, type OneSatContext } from '@1sat/actions';
import { splitOutpoint } from './runIdentify';

/**
 * Melt an NPG RelayX jig into its element cards (owner, 17 Oct 2026: burn on chain, melt fee 0, the holder
 * pays network and mint fees at cost). Server side: ninjapunkgirls.com, spec ninja-punk-girls-com
 * docs/MELT-API.md. The wallet:
 *  1. asks for a quote, naming where the element cards go (the wallet's first deposit address, which address
 *     sync reads, so they land in Collectibles);
 *  2. builds ONE transaction, never broadcast here (noSend): input 0 = the jig, signed on this device with the
 *     RelayX key that holds it; output 0 = the burn script, rebuilt byte for byte and compared with the quote;
 *     output 1 = fee_sats to fee_to when there is a fee; the wallet funds the rest;
 *  3. proves control with a BSM signature over the quote's challenge, and commits the EF transaction;
 *  4. polls status while NPG mints the cards. If the server refuses, the unsent action is aborted so its
 *     inputs are free again.
 */
export const NPG_MELT_API = 'https://www.ninjapunkgirls.com/api/melt';

export type MeltElement = { file: string; hue?: number; slot: string };
export type MeltQuote = {
  quote_id: string;
  expires: string;
  series: number;
  n: number;
  name?: string;
  elements: MeltElement[];
  note: string | null;
  challenge: string;
  burn_script_hex: string;
  fee_sats: number;
  fee_to: string | null;
  mint: { count: number; sats_each: number };
  /** The server can take a commit for this quote. Missing or false: melting isn't open yet (no build, no signing). */
  commit_ready?: boolean;
};
export type MeltStatus = {
  status: 'quoted' | 'burned' | 'minting' | 'done' | 'failed';
  burn_txid?: string;
  elements?: { file: string; outpoint: string }[];
  error?: string;
};

/** The quote endpoint isn't there yet: the sheet says "Melting opens soon", never a pretend melt. */
export class MeltNotOpenError extends Error {
  constructor() {
    super('Melting opens soon.');
  }
}

/**
 * Element art. S1 parts are "21-Body/…png" under the NPG site assets; S2 parts are bare names like
 * "B_011_[Weapon]<Graffiti_Can>(R)((RGB)).png" in NPG's Blob under s2/elements/. Names carry [ ] < > ( ) and
 * must be encoded (owner, 17 Oct 2026: every element tile on the melt sheet was a broken image).
 */
export const NPG_ASSETS = 'https://www.ninjapunkgirls.com/assets/';
export const NPG_S2_ELEMENTS = 'https://qw1nh74cmgrgawoh.public.blob.vercel-storage.com/s2/elements/';
export const elementUrl = (file: string) => {
  if (/^https?:\/\//.test(file)) return file;
  const path = file.replace(/^\//, '');
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return path.includes('/') ? NPG_ASSETS + enc : NPG_S2_ELEMENTS + enc;
};

/** A readable label for an element: the quote's slot, else from the file name ("[Weapon]" or "[[Peggy]]<choker>"). */
export const elementLabel = (e: { slot?: string; file: string }) => {
  if (e.slot?.trim()) return e.slot.replace(/_/g, ' ');
  const name = e.file.split('/').pop() ?? '';
  const m = /\[\[[^\]]+\]\]<([^>]+)>/.exec(name) ?? /\[([^\]]+)\]/.exec(name) ?? /^\d+-([A-Za-z-]+)\//.exec(e.file);
  return m ? m[1].replace(/[_-]/g, ' ') : 'Element';
};

/** The avatar badge rides along with the cards (slot "avatar"); shown apart on the sheet. Absent for S1 so far. */
export const splitAvatar = (q: Pick<MeltQuote, 'elements'>) => ({
  cards: q.elements.filter((e) => e.slot !== 'avatar'),
  avatar: q.elements.find((e) => e.slot === 'avatar'),
});

/**
 * The melt fee is 0 (owner, 17 Oct 2026); the holder pays the mint and network costs at cost: a few element cards
 * of 1 sat each plus the network fees of minting them. The largest quote seen so far was 51,381 sats, so the cap is
 * 100,000 sats (about 2x). The quote names the amount and the recipient, so both are bounded here, never taken on
 * trust: a fee above this cap, or to an address that is not NPG's, is refused before anything is built or signed.
 */
export const MELT_FEE_MAX_SATS = 100_000;

/**
 * NPG's addresses that may receive the melt's mint fees (owner-supplied 23 Oct 2026). A quote paying any other
 * address is refused.
 */
export const NPG_MELT_FEE_ADDRESSES: readonly string[] = ['1AfPwENoykyHMPxDPbkq8n3MDCQ4yveomp'];

export const isMeltFeeAddress = (a: string | null | undefined, allowed: readonly string[] = NPG_MELT_FEE_ADDRESSES) =>
  typeof a === 'string' && allowed.includes(a);

export const meltChallenge = (quoteId: string, jigLocation: string) => `npg-melt|v1|${quoteId}|${jigLocation}`;

/** OP_FALSE OP_RETURN "npg-melt" <origin ascii> <quote_id ascii>, 0 sats. */
export function burnScript(origin: string, quoteId: string): Script {
  const push = (s: string) => Utils.toArray(s, 'utf8');
  return new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(push('npg-melt'))
    .writeBin(push(origin))
    .writeBin(push(quoteId));
}

/** Refuse a quote whose challenge or burn output isn't exactly what this jig and quote id should give. */
export function checkQuote(
  q: MeltQuote,
  jigLocation: string,
  jigOrigin: string,
  feeAddresses: readonly string[] = NPG_MELT_FEE_ADDRESSES,
): string | null {
  if (!q?.quote_id || !/^[\w-]{4,80}$/.test(q.quote_id)) return 'The quote has no valid id.';
  if (q.challenge !== meltChallenge(q.quote_id, jigLocation)) return "The quote's challenge doesn't match this NFT.";
  if (q.burn_script_hex.toLowerCase() !== burnScript(jigOrigin, q.quote_id).toHex())
    return "The quote's burn output isn't the agreed one.";
  if (!Number.isSafeInteger(q.fee_sats) || q.fee_sats < 0) return 'The quote has an invalid fee.';
  if (q.fee_sats > MELT_FEE_MAX_SATS) return 'The quote asks for a larger fee than a melt costs.';
  if (q.fee_sats > 0 && q.fee_to !== null && !isMeltFeeAddress(q.fee_to, feeAddresses))
    return "The quote's fee address isn't NPG's.";
  if (!Array.isArray(q.elements) || !q.elements.length) return 'The quote lists no element cards.';
  return null;
}

/**
 * Whether to offer Allow. Only an explicit commit_ready: true; and a fee needs somewhere to go (fee_sats > 0 with
 * fee_to null can't be paid, so it isn't ready either). Anything else shows "Melting opens soon" and signs nothing.
 */
export const quoteReady = (
  q: Pick<MeltQuote, 'commit_ready' | 'fee_sats' | 'fee_to'>,
  feeAddresses: readonly string[] = NPG_MELT_FEE_ADDRESSES,
): boolean =>
  q.commit_ready === true &&
  Number.isSafeInteger(q.fee_sats) &&
  q.fee_sats >= 0 &&
  q.fee_sats <= MELT_FEE_MAX_SATS &&
  !(q.fee_sats > 0 && !isMeltFeeAddress(q.fee_to, feeAddresses));

/** BSM signature (base64) over the challenge with the key of the jig's output. The key stays on this device. */
export const signChallenge = (challenge: string, wif: string): string =>
  BSM.sign(Utils.toArray(challenge, 'utf8'), PrivateKey.fromWif(wif), 'base64') as string;

/** Where the element cards go: deposit address 0, which the wallet's address sync reads (ordinals included). */
export async function recipientPubkey(ctx: OneSatContext): Promise<string> {
  const { derivations } = await deriveDepositAddresses.execute(ctx, { count: 1 });
  const pk = derivations?.[0]?.publicKey;
  if (!pk) throw new Error("Couldn't derive where your element cards go.");
  return pk;
}

/** A refusal the server answered with (4xx): nothing was broadcast, so the wallet's inputs can be freed. */
export class MeltRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
export const MELT_UNREACHABLE =
  "Couldn't reach NPG's melt service (ninjapunkgirls.com). Check your connection and try again in a bit.";
/** Browsers report a blocked or dropped request as a bare TypeError ("Load failed" on iPhone, owner 17 Oct 2026).
 *  Name the service instead. Still a plain Error, never a refusal: a dropped commit may have broadcast. */
const reach = async (f: Fetch, url: string, init?: RequestInit) => {
  try {
    return await f(url, init);
  } catch (e) {
    if (e instanceof TypeError) throw new Error(MELT_UNREACHABLE);
    throw e;
  }
};
const post = async (f: Fetch, path: string, body: unknown, refusals: readonly number[] = []) => {
  const r = await reach(f, `${NPG_MELT_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 404 || r.status === 405 || r.status === 501) throw new MeltNotOpenError();
  const j = await r.json().catch(() => ({}));
  let msg = typeof j?.error === 'string' ? j.error : `The NPG melt service said ${r.status}.`;
  if (msg === 'not_ready') msg = 'Melting opens soon.';
  if (r.status === 400 && typeof j?.traced_origin === 'string')
    msg = `${msg} (this NFT traces back to ${j.traced_origin.slice(0, 12)}…)`;
  // Commit answers these before broadcasting anything (409 not_ready, 503): a clean refusal, coins are freed.
  if (refusals.includes(r.status)) throw new MeltRefusedError(msg, r.status);
  // Only a 4xx is a clean refusal. A 5xx or a dropped connection may have broadcast already: never free inputs then.
  if (r.status >= 400 && r.status < 500) throw new MeltRefusedError(msg, r.status);
  if (!r.ok) throw new Error(msg);
  return j;
};

export const getQuote = (
  f: Fetch,
  body: { jig_location: string; jig_origin: string; recipient_pubkey: string },
): Promise<MeltQuote> => post(f, '/quote', body);

export const commitMelt = (
  f: Fetch,
  body: { quote_id: string; rawtx_ef: string; signature: string },
): Promise<MeltStatus> => post(f, '/commit', body, COMMIT_REFUSALS);

/** Commit statuses that mean "not broadcast": 409 not_ready and 503 (owner's server, 17 Oct 2026), plus any 4xx. */
export const COMMIT_REFUSALS = [409, 503] as const;

export async function meltStatus(f: Fetch, quoteId: string): Promise<MeltStatus> {
  const r = await reach(f, `${NPG_MELT_API}/status/${encodeURIComponent(quoteId)}`);
  if (!r.ok) throw new Error(`Status ${r.status}`);
  return r.json();
}

/** Poll every 3 s for up to 2 min (spec). Resolves with the last status; 'minting' at the end means check back. */
export async function pollMelt(
  f: Fetch,
  quoteId: string,
  onStatus: (s: MeltStatus) => void,
  { every = 3000, max = 120_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<MeltStatus> {
  let last: MeltStatus = { status: 'minting' };
  for (let t = 0; t <= max; t += every) {
    try {
      last = await meltStatus(f, quoteId);
      onStatus(last);
      if (last.status === 'done' || last.status === 'failed') return last;
    } catch {
      /* a missed poll is retried */
    }
    await sleep(every);
  }
  return last;
}

/** "<txid>_o<n>" (Run) or "<txid>_<n>" → the toolbox outpoint "<txid>.<n>". */
export const toolboxOutpoint = (location: string) => {
  const { txid, vout } = splitOutpoint(location);
  return `${txid}.${vout}`;
};

type MeltWallet = Pick<OneSatContext['wallet'], 'createAction' | 'signAction' | 'abortAction'>;
type BeefServices = { getBeefForTxid(txid: string): Promise<{ toBinary(): number[] }> };

/** Unlocking a P2PKH input with a compressed key: up to 107 bytes; reserve 108 as the sweep does. */
const P2PKH_UNLOCK_LEN = 108;

/**
 * Build and sign the melt transaction without broadcasting it. Returns the EF hex the server broadcasts, and
 * the action reference to abort if the server refuses.
 */
export async function buildMeltTx(
  wallet: MeltWallet,
  services: BeefServices,
  q: MeltQuote,
  jig: { location: string; wif: string },
  feeAddresses: readonly string[] = NPG_MELT_FEE_ADDRESSES,
): Promise<{ ef: string; txid: string; reference: string }> {
  // Checked again here: buildMeltTx must never pay a fee checkQuote would refuse.
  if (q.fee_sats > MELT_FEE_MAX_SATS || (q.fee_sats > 0 && !isMeltFeeAddress(q.fee_to, feeAddresses)))
    throw new Error('The quote asks for a fee the wallet will not pay.');
  const { txid, vout } = splitOutpoint(jig.location);
  const beef = await services.getBeefForTxid(txid);
  const outputs = [
    { lockingScript: q.burn_script_hex, satoshis: 0, outputDescription: `Burn NPG #${q.n} (melt)` },
    ...(q.fee_sats > 0 && q.fee_to
      ? [
          {
            lockingScript: new P2PKH().lock(q.fee_to).toHex(),
            satoshis: q.fee_sats,
            outputDescription: 'NPG mint fees',
          },
        ]
      : []),
  ];
  const created = await wallet.createAction({
    description: `Melt NPG #${String(q.n).padStart(4, '0')} into element cards`,
    inputBEEF: beef.toBinary(),
    inputs: [
      {
        outpoint: `${txid}.${vout}`,
        inputDescription: `RelayX NPG #${q.n}`,
        unlockingScriptLength: P2PKH_UNLOCK_LEN,
      },
    ],
    outputs,
    options: { randomizeOutputs: false, noSend: true, signAndProcess: false },
  });
  const st = created.signableTransaction;
  if (!st) throw new Error("The wallet didn't return a transaction to sign.");
  const reference = st.reference;
  try {
    const tx = Transaction.fromAtomicBEEF(st.tx);
    const i = tx.inputs.findIndex(
      (x) => (x.sourceTXID ?? x.sourceTransaction?.id('hex')) === txid && x.sourceOutputIndex === vout,
    );
    if (i !== 0) throw new Error('The NFT must be the first input.');
    const unlocking = await new P2PKH().unlock(PrivateKey.fromWif(jig.wif)).sign(tx, 0);
    const signed = await wallet.signAction({
      reference,
      spends: { 0: { unlockingScript: unlocking.toHex() } },
      options: { noSend: true },
    });
    if (!signed.tx) throw new Error("The wallet didn't return the signed transaction.");
    const final = Transaction.fromAtomicBEEF(signed.tx);
    return { ef: final.toHexEF(), txid: final.id('hex'), reference };
  } catch (e) {
    await wallet.abortAction({ reference }).catch(() => undefined);
    throw e;
  }
}

/**
 * The server refused the commit with a 4xx (MeltRefusedError): free the wallet's inputs. Never call this after a
 * 5xx or a network error: the server may have broadcast, and freeing spent inputs makes the next send fail
 * (UTXO_SPENT, owner's $1 send, 17 Oct 2026).
 */
export async function releaseMelt(
  wallet: MeltWallet,
  reference: string,
  txid?: string,
  opts: Parameters<typeof chainSaysUnknown>[1] = {},
): Promise<boolean> {
  // The rawtx left the device: abort only once the chain confirms it has no copy (services/unsentGuard.ts).
  if (!txid || !(await chainSaysUnknown(txid, opts))) {
    console.warn(`[bwx-unsent] melt ${txid ?? reference}: kept, not aborted (the chain has it or can't say)`);
    return false;
  }
  await wallet.abortAction({ reference }).catch(() => undefined);
  return true;
}
