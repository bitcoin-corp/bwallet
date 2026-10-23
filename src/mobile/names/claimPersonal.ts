import { bsv21FieldsFromOutput, deployBsv21Mint, syncAddresses, type OneSatContext } from '@1sat/actions';
import { BSV21_BASKET } from '@1sat/types';
import { isNative } from '../native';
import { inscribeIcon, withMapOutput } from '../tickets/mintTicket';
import { CURVE_MAP_DESCRIPTION, curveMapScript } from '../curves/curveMap';
import type { Curve } from '../../lib/curves';
import { iconFile } from '../mint/mint';
import { getLocalAvatar, isDefaultAvatar } from './avatar';
import { withIssuerSignature } from '../issuer/issuerSign';
import { registerIssuer } from '../issuer/issuerVerify';
import { rememberOwnToken } from '../tokens/indexFund';
import { BchatClient, defaultHttp, loadSession, saveSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { proveHoldings } from '../chat/holdings';
import { requestRoomByTicker } from '../chat/segmentNav';
import {
  bsv20TakenError,
  bsv20TickExists,
  controlledTokens,
  decideExisting,
  heldTokenNote,
  duplicateNote,
  linkImported,
  signImport,
  type ExistingChoice,
  type LegacyKeys,
  withLegacyIssuers,
  type TokenRef,
} from './existingToken';
import {
  PERSONAL_DECIMALS,
  PERSONAL_MIN,
  PERSONAL_PURPOSE,
  BWALLET_MARK_ICON,
  cleanSupply,
  getPersonalLink,
  personalKey,
  personalTicker,
  pickOwnDeploy,
  rememberPersonal,
  type OwnDeploy,
  setPersonalLink,
  validateSupply,
  withPersonalMap,
  type PersonalLink,
} from './personalToken';

/**
 * The two network halves of "claim your name": (1) deploy the personal BSV-21 token — a wallet
 * transaction, run only after the user confirms the SendConfirmation sheet; (2) open the personal
 * room in bit-sign — signatures only (bChat sign-in + key proofs), nothing spent.
 *
 * A just-deployed token is not indexed for a while, and bit-sign re-checks the holding through
 * the indexer, so (2) can fail at first. The link keeps `roomTicker: null` and the Chat tab
 * retries (`retryPersonalRoom`) until it goes through.
 */

// deploy+mint inscription (~250 B) + MAP (~100 B) + issuer MAP+AIP (~300 B) + inputs/change at ~100 sat/kB.
export const PERSONAL_NETWORK_FEE_SATS = 110;
/**
 * Everything the confirm sheet shows for the token + room. No indexing at mint: the room is set up
 * later, as a separate confirmed payment (tokens/roomSetup.ts).
 */
export const PERSONAL_FEE_ESTIMATE_SATS = PERSONAL_NETWORK_FEE_SATS;

/** Did a mint fail only because the wallet can't pay its network fee? */
export const isFundsError = (e: string | undefined) => !!e && /insufficient|not enough|no (utxos|funds)|funds/i.test(e);

const SPONSOR_WAIT_MS = 2000;
const SPONSOR_TRIES = 6;

export async function deployPersonalToken(
  ctx: OneSatContext,
  input: {
    identityAddress: string;
    name: string;
    supply: string;
    icon?: string;
    /** An image for the icon. Without one (and no `icon`), the profile picture is used (owner, 4 Oct 2026). */
    iconImage?: File | null;
    /** The account's avatar (1sat://, https or data URI) when it isn't a photo picked on this device. */
    avatar?: string | null;
    /**
     * The wallet's own BSV address. With it, an empty wallet asks bCorp to sponsor the mint fee
     * (bit-sign /api/bitsign/sponsor/mint), waits for the gift to sync, then mints.
     */
    payAddress?: string;
    /** The user saw the "someone else already has a token called X" note and chose to mint anyway. */
    acceptDuplicate?: boolean;
    /** Tests / callers that already decided: skips the lookup. */
    choice?: ExistingChoice;
    /** Launch curve, committed on the deploy tx as its own MAP output; fixed from then on. */
    curve?: Curve | null;
  },
): Promise<PersonalLink> {
  const ticker = personalTicker(input.name);
  if (!ticker) throw new Error('That name cannot be a token ticker');
  // Never a silent duplicate (owner, 13 Oct 2026): an existing token this account controls is imported, a
  // BSV-20 tick is unique by protocol, and someone else's ticker needs the note first.
  const choice = input.choice ?? (await existingChoice(ctx, input.name));
  if (choice.kind === 'import')
    throw new Error(`You already have the $${choice.token.sym} token. Import it instead of minting a new one.`);
  if (choice.kind === 'held') throw new Error(heldTokenNote(choice.token.sym));
  if (choice.kind === 'bsv20-taken') throw new Error(bsv20TakenError(choice.tick));
  if (choice.kind === 'mint-labelled' && !input.acceptDuplicate) throw new Error(duplicateNote(input.name));
  const bad = validateSupply(input.supply);
  if (bad) throw new Error(bad);
  const supply = cleanSupply(input.supply);
  // Never mint with our logo when the person has a picture: inscribe it as the token's icon.
  const icon = input.icon || (await personalIcon(ctx, ticker, input).catch(() => undefined));
  // Fresh wrapper per attempt: the MAP proxies add their output to one createAction only.
  const withCurve = () => (input.curve ? withMapOutput(ctx, curveMapScript(input.curve), CURVE_MAP_DESCRIPTION) : ctx);
  const deploy = () =>
    deployBsv21Mint.execute(withIssuerSignature(withPersonalMap(withCurve(), input.name, ticker), 'bsv21'), {
      symbol: ticker,
      amount: supply,
      decimals: PERSONAL_DECIMALS,
      icon: icon || BWALLET_MARK_ICON,
    });
  let res = await deploy();
  if (isFundsError(res.error) && input.payAddress) {
    // bCorp covers a new user's mint fee: a small gift to their own address, then mint as usual.
    const client = await chatClient(ctx);
    // A wallet that was sponsored once (or has money still arriving) gets "Already sponsored": that is not the
    // reason the mint failed, so say what is (owner, 11 Oct 2026, $vexvoid: money at the address not yet spendable).
    try {
      await client.sponsorMint(input.payAddress);
    } catch {
      throw new Error(
        `Couldn't create $${ticker}: the wallet has no spendable money for the network fee yet. ` +
          `If you just received some, wait a minute for it to be added, tap refresh, then try again.`,
      );
    }
    for (let i = 0; i < SPONSOR_TRIES && isFundsError(res.error); i++) {
      await new Promise((ok) => setTimeout(ok, SPONSOR_WAIT_MS));
      await syncAddresses.execute(ctx, { count: 5 }).catch(() => undefined);
      res = await deploy();
    }
  }
  if (res.error || !res.tokenId) throw new Error(res.error || 'Token deploy failed');
  void registerIssuer(res.tokenId);
  const link: PersonalLink = {
    name: personalKey(input.name),
    tokenId: res.tokenId,
    ticker,
    supply,
    createdAt: Date.now(),
    roomTicker: null,
  };
  setPersonalLink(input.identityAddress, link);
  // Minting no longer pays indexing; "Set up $X's room" offers it later.
  rememberOwnToken({ tokenId: res.tokenId, ticker });
  return link;
}

/**
 * What the personal-token step should offer for `handle`: import a token this wallet controls, refuse a
 * taken BSV-20 tick, or mint (labelled when someone else's token already uses the ticker).
 */
export async function existingChoice(
  ctx: OneSatContext,
  handle: string,
  client?: BchatClient,
  legacy?: Pick<LegacyKeys, 'addresses'>,
): Promise<ExistingChoice> {
  const ticker = personalTicker(handle);
  const [controlled, tick, bound] = await Promise.all([
    controlledTokens(ctx)
      .then((t) => withLegacyIssuers(handle, t, legacy))
      .catch(() => [] as TokenRef[]),
    ticker ? bsv20TickExists(ticker) : Promise.resolve(false),
    (client ? Promise.resolve(client) : Promise.resolve(new BchatClient(defaultHttp(isNative), loadSession())))
      .then((c) => c.personalToken(personalKey(handle)))
      .then((r) => r.tokenId)
      .catch(() => null),
  ]);
  const own = new Set(controlled.filter((t) => t.issued).map((t) => t.tokenId));
  const others = bound && !own.has(bound) ? 1 : 0;
  // A BSV-20 tick only blocks when this wallet doesn't hold that tick itself (BSV-20 isn't listed above).
  return decideExisting({ handle, controlled, othersBsv21: others, bsv20Tick: tick === true });
}

/**
 * "We found the $X token — sign to import it": one identity signature over a challenge naming the token and
 * the key, sent to bit-sign; the token becomes this account's personal token and its room opens. No mint.
 */
export async function importExistingToken(
  ctx: OneSatContext,
  identityAddress: string,
  handle: string,
  token: TokenRef,
  legacy?: LegacyKeys,
): Promise<{ link: PersonalLink; roomTicker: string | null }> {
  if (!token.issued) throw new Error('Only the token’s issuer can import it as a personal token.');
  const signed = await signImport(ctx, token.tokenId, handle);
  // Issued from an imported legacy key: that key signs the same challenge, proving control of the issuer.
  let proof: { address: string; signature: string } | null = null;
  if (token.legacyAddress) {
    if (!legacy) throw new Error('Unlock the wallet to sign with the key that issued this token.');
    proof = { address: token.legacyAddress, signature: await legacy.sign(token.legacyAddress, signed.message) };
  }
  const client = await chatClient(ctx);
  // Server half pending (see BchatClient.importPersonalToken); the room open below still binds a matching handle.
  await client
    .importPersonalToken({
      name: personalKey(handle),
      token_id: token.tokenId,
      message: signed.message,
      identity_key: signed.identityKey,
      signature: signed.signature,
      proof,
    })
    .catch(() => undefined);
  const link = linkImported(identityAddress, handle, token);
  rememberOwnToken({ tokenId: link.tokenId, ticker: link.ticker });
  const roomTicker = await openPersonalRoom(ctx, identityAddress, link, client).catch(() => null);
  if (roomTicker) requestRoomByTicker(roomTicker, false);
  return { link, roomTicker };
}

async function chatClient(ctx: OneSatContext): Promise<BchatClient> {
  const client = new BchatClient(defaultHttp(isNative), loadSession());
  if (!client.handle) saveSession(await client.signIn(walletSigner(ctx)));
  return client;
}

/** Open (idempotently) the personal room for a link. Returns its ticker, or null if not yet. */
export async function openPersonalRoom(
  ctx: OneSatContext,
  identityAddress: string,
  link: PersonalLink,
  client?: BchatClient,
): Promise<string | null> {
  const c = client ?? (await chatClient(ctx));
  const key = `bsv21:${link.tokenId}`;
  await proveHoldings(ctx, c, key).catch(() => 0);
  const ticker = await c.startTokenRoom(key, {
    name: `$${link.ticker}`,
    min: PERSONAL_MIN,
    purpose: PERSONAL_PURPOSE,
    // bit-sign binds the name only if it is the caller's own handle; otherwise it is a plain
    // token room (still gated, still yours) and the ✓ stays local.
    ...(c.handle && personalKey(c.handle) === link.name ? { personal_name: link.name } : {}),
  });
  setPersonalLink(identityAddress, { ...link, roomTicker: ticker });
  return ticker;
}

/** Chat tab: finish a personal room that could not be opened right after the deploy. */
export async function retryPersonalRoom(ctx: OneSatContext, identityAddress: string, client: BchatClient) {
  const link = getPersonalLink(identityAddress);
  if (!link || link.roomTicker) return null;
  return openPersonalRoom(ctx, identityAddress, link, client).catch(() => null);
}

/** Learn (and cache) the token bound to a name from bit-sign. */
export async function lookupPersonal(client: BchatClient, name: string): Promise<string | null> {
  const r = await client.personalToken(personalKey(name)).catch(() => null);
  if (r?.tokenId) rememberPersonal({ name, tokenId: r.tokenId });
  return r?.tokenId ?? null;
}

/**
 * Restore a lost local link (e.g. app data cleared, or minted from another screen): look for this
 * wallet's own deploy of $HANDLE in the BSV-21 basket. Read-only; returns the restored link or null.
 */
export async function recoverPersonalLink(
  ctx: OneSatContext,
  identityAddress: string,
  handle: string,
): Promise<PersonalLink | null> {
  const existing = getPersonalLink(identityAddress);
  if (existing) return existing;
  const ticker = personalTicker(handle);
  if (!ticker) return null;
  const res = await ctx.wallet
    .listOutputs({
      basket: BSV21_BASKET,
      tags: ['bsv21:deploy'],
      includeTags: true,
      includeCustomInstructions: true,
      limit: 200,
    })
    .catch(() => null);
  const deploys: OwnDeploy[] = [];
  for (const o of res?.outputs ?? []) {
    const f = bsv21FieldsFromOutput({ tags: o.tags, customInstructions: o.customInstructions, outpoint: o.outpoint });
    if (f.isDeploy && f.tokenId && f.sym && f.amt) deploys.push({ tokenId: f.tokenId, sym: f.sym, amt: f.amt });
  }
  const d = pickOwnDeploy(deploys, ticker);
  if (!d) return null;
  const link: PersonalLink = {
    name: personalKey(handle),
    tokenId: d.tokenId,
    ticker,
    supply: d.amt,
    createdAt: Date.now(),
    roomTicker: null,
  };
  setPersonalLink(identityAddress, link);
  return link;
}

/** The icon outpoint for a personal token: the chosen image, else the profile picture; undefined = our mark. */
async function personalIcon(
  ctx: OneSatContext,
  ticker: string,
  input: { identityAddress: string; iconImage?: File | null; avatar?: string | null },
): Promise<string | undefined> {
  if (input.iconImage) return inscribeIcon(ctx, await iconFile(input.iconImage), ticker, 'token');
  const raw = getLocalAvatar(input.identityAddress) || input.avatar || '';
  if (!raw || isDefaultAvatar(raw)) return undefined;
  // Already on chain: point at it, no new inscription.
  const m = raw.match(/^1sat:\/\/([0-9a-f]{64})[._](\d+)$/i);
  if (m) return `${m[1].toLowerCase()}_${m[2]}`;
  const blob = await (await fetch(raw)).blob();
  if (!blob.type.startsWith('image/')) return undefined;
  return inscribeIcon(ctx, await iconFile(new File([blob], 'icon', { type: blob.type })), ticker, 'token');
}
