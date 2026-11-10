import { inscribe, syncAddresses, type OneSatContext } from '@1sat/actions';
import { mintPrivateMedia } from '../private/privateMint';
import { withBrc217 } from '../issuer/issuerSign';
import { BchatClient, defaultHttp, loadSession, saveSession, type BavatarMine } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { isNative } from '../native';
import { MINT_APP } from '../mint/mint';
import { cardPaymail } from '../wallet/cardBackQr';
import { artSymbol, compactArtBackGroup, paymailPayload } from './flipQr';
import { bavatarSvg, isVariant } from './bavatar';

/** Same test as names/claimPersonal.ts (not imported: that module pulls the token stack in). */
const isFundsError = (e: string | undefined) => !!e && /insufficient|not enough|no (utxos|funds)|funds/i.test(e);

/**
 * Minting a bAvatar (owner, 11 Oct 2026; two-sided since 14 Oct): the account's bAvatar with its pay
 * QR on the back (its paymail, scannable by any phone camera) with "$handle · bWalletX #001" inscribed as a 1-sat ordinal in the account's own wallet.
 * The number is signup order (bChatX /api/bitsign/bavatar/mine). Accounts #1–#1,000 are the Founding
 * 1,000: bCorp pays their network fee (/api/bitsign/bavatar/sponsor, once per account), the same
 * gift-then-mint pattern as the personal token (names/claimPersonal.ts). One mint per account: the
 * server records it (/api/bitsign/bavatar/minted) and the sheet then shows "Minted".
 *
 * Shuffle (owner, 27 Oct 2026): a user who doesn't like their picture can page through designs #1, #2, …
 * (bavatar.ts variantSeed; #0 is the original), mint the one they like, and it replaces their bAvatar on
 * bChatX. Previews are local and free. The sponsor pays for an account's FIRST mint only (founders); every
 * later mint is a replacement the user pays for. The design number goes into the inscription so anyone can
 * redraw and check it, and the server checks it before switching the picture.
 */

export const FOUNDING = 1000;
/** Inscription size cap: the two-sided card (art once + compact Art QR) is ~25 KB. */
export const MAX_BAVATAR_BYTES = 40_000;

/** #001 under 1,000, plain digits after: `bavatarNumber(7)` → `#007`, `bavatarNumber(1234)` → `#1234`. */
export const bavatarNumber = (n: number) => '#' + (n < FOUNDING ? String(n).padStart(3, '0') : String(n));

/** "$alice · bWalletX #007", the inscription's MAP name and the sheet's title line. */
export const bavatarLabel = (handle: string, n: number) => `$${handle} · bWalletX ${bavatarNumber(n)}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const INK = '#0b0a08';
const KEY_RE = /^0[23][0-9a-f]{64}$/;

/**
 * The inscription (flip bAvatar, owner 14 Oct 2026): a 512×640 card with two sides. The FRONT is the pure
 * bAvatar art and shows by default (also the only side a static renderer such as resvg draws). The BACK is the
 * bAvatar Art QR (as on bwalletx.com/bavatars) of the account's paymail, public data only, on a rounded pale
 * card. Viewers that run SVG animation turn the card over on a loop (front ~6 s, back ~4 s). The art is held
 * once as a symbol and used by both sides. Under both: the handle, the number and, for #1–#1,000,
 * FOUNDING 1,000. '' with no identity key or paymail.
 */
export function bavatarMintSvg(identityKey: string, handle: string, number: number, variant = 0): string {
  const key = String(identityKey).toLowerCase();
  const pm = paymailPayload(cardPaymail(handle));
  if (!KEY_RE.test(key) || !pm || !isVariant(variant)) return '';
  const back = compactArtBackGroup(pm, 'bva', 24, 24, 464);
  if (!back) return '';
  const founding = number <= FOUNDING;
  // Flip by squashing each side to its vertical centre line and back (scaleX), one side at a time.
  const T = 10;
  const kt = '0;0.57;0.6;0.97;1';
  const flip = (frontSide: boolean) =>
    `<animateTransform attributeName="transform" type="scale" dur="${T}s" repeatCount="indefinite" keyTimes="${kt}" ` +
    `values="${frontSide ? '1 1;1 1;0 1;0 1;1 1' : '0 1;0 1;1 1;1 1;0 1'}" calcMode="linear"/>`;
  return (
    // Design #0 keeps the card exactly as before; #n carries its number so anyone can redraw it.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 640" width="512" height="640"${variant ? ` data-bavatar-design="${variant}"` : ''}>` +
    `<defs>${artSymbol(key, 'bva', variant)}<clipPath id="bvr"><rect x="24" y="24" width="464" height="464" rx="40"/></clipPath></defs>` +
    `<rect width="512" height="640" fill="${INK}"/>` +
    '<g transform="translate(256 0)"><g class="bv-f"><g>' +
    flip(true) +
    '<g transform="translate(-256 0)"><use href="#bva" width="512" height="512" aria-label="bAvatar"/></g></g></g>' +
    '<g class="bv-b"><g transform="scale(0 1)">' +
    flip(false) +
    `<g transform="translate(-256 0)" aria-label="Pay code"><g clip-path="url(#bvr)">${back}</g></g></g></g></g>` +
    '<g font-family="Helvetica,Arial,sans-serif" text-anchor="middle">' +
    `<text x="256" y="566" font-size="34" font-weight="700" fill="#ffd24d">$${esc(handle)}</text>` +
    `<text x="256" y="604" font-size="22" font-weight="600" fill="#f1ead9">bWalletX ${esc(bavatarNumber(number))}</text>` +
    (founding
      ? '<text x="256" y="630" font-size="13" font-weight="700" letter-spacing="3" fill="#c58b12">FOUNDING 1,000</text>'
      : '') +
    '</g></svg>'
  );
}

/** The user's estimate of a bAvatar inscription's network fee (the card is ~25 KB; same figure the sponsor grants). */
export const BAVATAR_FEE_SATS = 4000;

/** The design this account shows now: the newest mint's, else #0. */
export const currentVariant = (mine: BavatarMine) => mine.minted?.variant ?? 0;

/** Has this account minted any bAvatar yet? */
export const hasMinted = (mine: BavatarMine) => (mine.mints ?? 0) > 0 || !!mine.minted;

/** What minting design `variant` costs this account. */
export type MintOffer =
  | { kind: 'current' } // this design is already their minted bAvatar: nothing to pay, nothing to do
  | { kind: 'free' } // FIRST mint of a Founding 1,000 account: bWalletX pays the network fee
  | { kind: 'paid'; sats: number }; // everyone else, and every replacement: the user pays

export function mintOffer(mine: BavatarMine, variant = 0): MintOffer {
  if (mine.minted && currentVariant(mine) === variant) return { kind: 'current' };
  if (!hasMinted(mine) && mine.founding && mine.number <= FOUNDING) return { kind: 'free' };
  return { kind: 'paid', sats: BAVATAR_FEE_SATS };
}

/** Ask for the sponsor gift only for an unsponsored founder's FIRST mint whose wallet couldn't pay. */
export const shouldSponsor = (mine: BavatarMine, error: string | undefined) =>
  isFundsError(error) && mine.founding && mine.number <= FOUNDING && !mine.sponsored && !hasMinted(mine);

/**
 * Save before commit: a spent mint is written here the moment its txid exists, BEFORE the server is told,
 * and cleared only once the server has it. If recording fails (offline, app closed), the next sheet open
 * re-sends the record (never the spend), and mintBavatar refuses to spend again while one is waiting.
 */
export type PendingBavatar = { identityKey: string; txid: string; variant: number; at: number };
type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const PENDING_KEY = (identityKey: string) => `bwx.bavatar.pending.${identityKey.toLowerCase()}`;
const store = (): KV | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
export function loadPendingBavatar(identityKey: string, kv: KV | null = store()): PendingBavatar | null {
  try {
    const p = JSON.parse(kv?.getItem(PENDING_KEY(identityKey)) || 'null') as PendingBavatar | null;
    return p && /^[0-9a-f]{64}$/.test(p.txid) && isVariant(p.variant) ? p : null;
  } catch {
    return null;
  }
}
export function savePendingBavatar(p: PendingBavatar, kv: KV | null = store()) {
  try {
    kv?.setItem(PENDING_KEY(p.identityKey), JSON.stringify(p));
  } catch {
    /* storage full or blocked: the record is still attempted right away */
  }
}
export function clearPendingBavatar(identityKey: string, kv: KV | null = store()) {
  try {
    kv?.removeItem(PENDING_KEY(identityKey));
  } catch {
    /* ignore */
  }
}

/** The plain design SVG the server redraws and compares (design #`variant` of this identity key). */
export const bavatarArt = (identityKey: string, variant: number) =>
  bavatarSvg(String(identityKey).toLowerCase(), { size: 512, variant });

/**
 * Recover: re-send a waiting record (never the spend). Returns the txid once the server has it, null when
 * nothing is waiting, and throws when the server is still unreachable (the record stays saved).
 */
export async function recoverPendingBavatar(
  client: Pick<BchatClient, 'recordBavatarMint'>,
  identityKey: string,
  kv: KV | null = store(),
) {
  const p = loadPendingBavatar(identityKey, kv);
  if (!p) return null;
  await client.recordBavatarMint(p.txid, p.variant, bavatarArt(identityKey, p.variant));
  clearPendingBavatar(identityKey, kv);
  return p.txid;
}

export async function bavatarClient(ctx: OneSatContext): Promise<BchatClient> {
  const client = new BchatClient(defaultHttp(isNative), loadSession());
  if (!client.handle) saveSession(await client.signIn(walletSigner(ctx)));
  return client;
}

const SPONSOR_WAIT_MS = 2000;
const SPONSOR_TRIES = 6;

/** Base64 of an ASCII/UTF-8 string, without Buffer (runs in the extension and on phones). */
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** Inscribe this account's bAvatar. Returns the txid. Throws with a readable message on failure. */
export async function mintBavatar(
  ctx: OneSatContext,
  input: {
    identityKey: string;
    payAddress: string;
    mine: BavatarMine;
    client?: BchatClient;
    /** Default true (owner, 25 Oct 2026): encrypted to this wallet (spec §9, kind bavatar). */
    private?: boolean;
    /** The design to mint (0 = the original). */
    variant?: number;
    /** Test seam for the save-before-commit store. */
    kv?: KV | null;
  },
): Promise<string> {
  const { mine } = input;
  const variant = input.variant ?? 0;
  if (!isVariant(variant)) throw new Error('Unknown bAvatar design');
  // Never spend twice for the same thing: the design already minted is a no-op, and a spent mint that the
  // server hasn't heard about yet is recorded (not re-minted).
  if (mine.minted && currentVariant(mine) === variant) return mine.minted.txid;
  const kv = input.kv === undefined ? store() : input.kv;
  const waiting = loadPendingBavatar(input.identityKey, kv);
  if (waiting) {
    const client = input.client ?? (await bavatarClient(ctx));
    await recoverPendingBavatar(client, input.identityKey, kv);
    throw new Error('Your last bAvatar mint has now been recorded. Check it before minting another.');
  }
  const handle = cardPaymail(mine.handle).split('@')[0];
  const svg = bavatarMintSvg(input.identityKey, handle, mine.number, variant);
  if (!svg) throw new Error('This account needs a $name before it can mint its bAvatar.');
  if (new TextEncoder().encode(svg).length > MAX_BAVATAR_BYTES) throw new Error('bAvatar image too large');

  const privateRun = async (): Promise<{ txid?: string; error?: string }> => {
    try {
      const r = await mintPrivateMedia(ctx, {
        file: Array.from(new TextEncoder().encode(svg)),
        mime: 'image/svg+xml',
        name: variant ? `${handle}-bavatar-design-${variant}.svg` : `${handle}-bavatar.svg`,
        kind: 'bavatar',
        feeSats: 0,
      });
      return { txid: r.txid };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  const run = () =>
    input.private !== false
      ? privateRun()
      : inscribe.execute(withBrc217(ctx), {
          base64Content: b64(svg),
          contentType: 'image/svg+xml',
          map: {
            app: MINT_APP,
            type: 'bavatar',
            name: bavatarLabel(handle, mine.number),
            handle,
            number: String(mine.number),
            edition: mine.number <= FOUNDING && mine.founding ? 'Founding 1,000' : 'bWalletX',
            variant: String(variant),
          },
        });

  const client = input.client ?? (await bavatarClient(ctx));
  let res = await run();
  if (shouldSponsor(mine, res.error) && input.payAddress) {
    await client.sponsorBavatar(input.payAddress);
    for (let i = 0; i < SPONSOR_TRIES && isFundsError(res.error); i++) {
      await new Promise((ok) => setTimeout(ok, SPONSOR_WAIT_MS));
      await syncAddresses.execute(ctx, { count: 5 }).catch(() => undefined);
      res = await run();
    }
  }
  if (res.error || !res.txid) throw new Error(res.error || 'bAvatar mint failed');
  // The ordinal is in the wallet either way. Save first, then tell the server (which switches the picture);
  // a failed record stays saved and is re-sent on the next open, never re-minted.
  savePendingBavatar({ identityKey: input.identityKey, txid: res.txid, variant, at: Date.now() }, kv);
  if (loadPendingBavatar(input.identityKey, kv)) {
    await recoverPendingBavatar(client, input.identityKey, kv).catch(() => undefined);
  } else {
    // Storage blocked, full or absent: nothing was saved, so tell the server directly (never re-mint).
    await client.recordBavatarMint(res.txid, variant, bavatarArt(input.identityKey, variant)).catch(() => undefined);
  }
  return res.txid;
}
