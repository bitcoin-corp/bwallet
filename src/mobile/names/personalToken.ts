import { LockingScript, OP, Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';

/**
 * Personal token: claiming a name ($BOASE) also mints a BSV-21 token with ticker = the name and
 * opens the owner's personal room in bit-sign, gated on that token (min 1). An invite to the
 * room is one token, sent. Personal tokens are SOCIAL / ACCESS only: no price, no dividends.
 *
 * BSV-21 tickers are not unique, so anyone can deploy another "BOASE". The real one is the
 * token id linked to the name — kept here (local, per identity) and in bit-sign (the personal
 * room's metadata, readable by name), and announced on-chain by a MAP output on the deploy tx.
 * Only a token whose id matches the link shows as "$BOASE ✓".
 *
 * Pure helpers + localStorage. Nothing here signs or broadcasts.
 */

/** New personal tokens mint 1B by default (owner, 12 Oct 2026); existing tokens keep their supply. */
export const DEFAULT_SUPPLY = '1000000000';
export const MAX_SUPPLY = 10n ** 15n;
export const PERSONAL_DECIMALS = 0;
export const PERSONAL_MIN = '1';
export const PERSONAL_PURPOSE = 'community';
export const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';

/** "$boase", "boase@handcash.io", "Boase" → "BOASE"; null if it can't be a ticker. */
export function personalTicker(name: string): string | null {
  // Verified social names keep the plain ticker: b0asex.x → $B0ASEX (marked X ✓ by its link).
  const s = (name || '')
    .trim()
    .replace(/^\$/, '')
    .split('@')[0]
    .replace(/\.(x|gmail)$/i, '')
    .toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(s) ? s : null;
}

/** The name as bit-sign keys it: lowercase, no $ or @domain. */
export const personalKey = (name: string) => (name || '').trim().replace(/^\$/, '').split('@')[0].toLowerCase();

export function validateSupply(raw: string): string | null {
  const s = (raw || '').trim().replace(/[,_\s]/g, '');
  if (!/^\d+$/.test(s)) return 'Supply is a whole number.';
  const n = BigInt(s);
  if (n < 1n) return 'Supply must be at least 1.';
  if (n > MAX_SUPPLY) return 'Supply is too large.';
  return null;
}
export const cleanSupply = (raw: string) => BigInt((raw || '').trim().replace(/[,_\s]/g, '') || '0').toString();

const OUTPOINT = /^([0-9a-f]{64})[._](\d{1,6})$/i;
export const normId = (s: string | null | undefined): string | null => {
  const m = (s || '').trim().match(OUTPOINT);
  return m ? `${m[1].toLowerCase()}_${m[2]}` : null;
};

export interface PersonalLink {
  /** bit-sign key form: "boase". */
  name: string;
  tokenId: string;
  ticker: string;
  supply: string;
  createdAt: number;
  /** Set once bit-sign accepted the personal room. */
  roomTicker?: string | null;
}

/** ✓ only when the token id equals the one linked to that name. Mirrors bit-sign's rule. */
export function isVerified(
  link: Pick<PersonalLink, 'name' | 'tokenId'> | null | undefined,
  name: string,
  tokenId: string,
): boolean {
  if (!link) return false;
  const a = normId(link.tokenId);
  const k = personalKey(name);
  return !!a && !!k && a === normId(tokenId) && personalKey(link.name) === k;
}

/** "$BOASE ✓" for the linked token, "$BOASE" for a copycat with the same ticker. */
export function tickerLabel(
  symbol: string,
  tokenId: string,
  links: Iterable<Pick<PersonalLink, 'name' | 'tokenId'>>,
): string {
  const sym = (symbol || '').replace(/^\$/, '');
  for (const l of links) if (isVerified(l, sym, tokenId)) return `$${sym} ✓`;
  return `$${sym}`;
}

/** Is this token id a known personal token (for the Market "Personal token" badge)? */
export const isPersonalTokenId = (tokenId: string, links: Iterable<Pick<PersonalLink, 'tokenId'>>) => {
  const id = normId(tokenId);
  if (!id) return false;
  for (const l of links) if (normId(l.tokenId) === id) return true;
  return false;
};

// ── on-chain MAP announcing the link (an extra 0-sat OP_RETURN on the deploy tx) ──

export const personalMapFields = (name: string, ticker: string): string[] => [
  'app',
  'bWallet',
  'type',
  'personal-token',
  'name',
  personalKey(name),
  'ticker',
  ticker,
];

export function personalMapScript(name: string, ticker: string): LockingScript {
  const s = new LockingScript();
  s.writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  for (const part of [MAP_PREFIX, 'SET', ...personalMapFields(name, ticker)]) s.writeBin(Utils.toArray(part, 'utf8'));
  return s;
}

/** Context whose wallet appends the MAP output to the NEXT createAction (the deploy). */
export function withPersonalMap(ctx: OneSatContext, name: string, ticker: string): OneSatContext {
  let done = false;
  const wallet = new Proxy(ctx.wallet as WalletInterface, {
    get(target, prop, receiver) {
      if (prop === 'createAction' && !done) {
        return (args: CreateActionArgs, originator?: string) => {
          done = true;
          const outputs = [
            ...(args.outputs ?? []),
            {
              lockingScript: personalMapScript(name, ticker).toHex(),
              satoshis: 0,
              outputDescription: 'Personal token name link (MAP)',
            },
          ];
          return target.createAction({ ...args, outputs }, originator);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

/** Default icon: the bWallet mark (src/mobile/brand/bwallet-mark.svg), as an SVG data URI (used when the account has no avatar). */
export const BWALLET_MARK_ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 4 120 120"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="0" y2="105"><stop offset="0" stop-color="#FFE58A"/><stop offset=".55" stop-color="#FFD24D"/><stop offset="1" stop-color="#C98F00"/></linearGradient><mask id="m"><rect x="-10" y="-10" width="140" height="140" fill="#fff"/><circle cx="60" cy="72" r="15" fill="#000"/></mask></defs><rect x="-4" y="4" width="120" height="120" fill="#000"/><g transform="translate(56 64) scale(.74) translate(-56 -64)"><g fill="url(#g)" mask="url(#m)"><polygon points="45,12 45,72 27,72 27,30"/><circle cx="60" cy="72" r="33"/></g></g></svg>',
  );

// ── storage ──

const KEY = (identityAddress: string) => `bwallet.personalToken.${identityAddress}`;
const KNOWN = 'bwallet.personalTokens.known';
const EVENT = 'bwallet-personal-token-changed';

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

export const getPersonalLink = (identityAddress?: string): PersonalLink | null =>
  identityAddress ? read<PersonalLink | null>(KEY(identityAddress), null) : null;

export function setPersonalLink(identityAddress: string, link: PersonalLink | null) {
  write(KEY(identityAddress), link);
  if (link) rememberPersonal({ name: link.name, tokenId: link.tokenId });
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window in tests */
  }
}

export const onPersonalChange = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/** Name→token links learned from bit-sign (GET ?name=) or our own claim. */
export const knownPersonal = (): Pick<PersonalLink, 'name' | 'tokenId'>[] => read(KNOWN, []);

export function rememberPersonal(l: Pick<PersonalLink, 'name' | 'tokenId'>) {
  const id = normId(l.tokenId);
  const name = personalKey(l.name);
  if (!id || !name) return;
  const rest = knownPersonal().filter((x) => personalKey(x.name) !== name);
  write(KNOWN, [...rest, { name, tokenId: id }].slice(-200));
}

// ── recovery: the link is local; if it was lost, find this wallet's own deploy of $TICKER ──

export type OwnDeploy = { tokenId: string; sym: string; amt: string };

/**
 * The deploy+mint output this wallet made for `ticker` (BSV-21 basket, tagged bsv21:deploy).
 * Several deploys of the same ticker: the last one listed (the newest). null if none.
 */
export function pickOwnDeploy(deploys: OwnDeploy[], ticker: string): OwnDeploy | null {
  const t = (ticker || '').replace(/^\$/, '').toUpperCase();
  const hits = deploys.filter((d) => normId(d.tokenId) && (d.sym || '').replace(/^\$/, '').toUpperCase() === t);
  return hits.length ? { ...hits[hits.length - 1], tokenId: normId(hits[hits.length - 1].tokenId)! } : null;
}

// ── discovery: the link above is per device; a second device restored from the same words finds it again ──

/** A link rebuilt from bit-sign's name → token binding (bit-sign binds a personal name only for its own handle). */
export function linkFromBound(
  handle: string,
  bound: { tokenId: string | null; ticker: string | null } | null | undefined,
): PersonalLink | null {
  const tokenId = normId(bound?.tokenId);
  const ticker = personalTicker(handle);
  if (!tokenId || !ticker) return null;
  return {
    name: personalKey(handle),
    tokenId,
    ticker,
    supply: '',
    createdAt: Date.now(),
    roomTicker: bound?.ticker ?? null,
  };
}

export type DrawerRoomState = 'get-name' | 'finding' | 'create' | 'room';

/** Drawer row: never "Create your room" while the lookup is still running or when a personal token exists. */
export const drawerRoomState = (s: { name: string; link: PersonalLink | null; finding: boolean }): DrawerRoomState =>
  !s.name ? 'get-name' : s.link ? 'room' : s.finding ? 'finding' : 'create';

/** A second personal token for the same identity is refused (owner, 24 Oct 2026: restored devices minted twice). */
export const secondPersonalError = (existing: Pick<PersonalLink, 'ticker'> | null | undefined): string | null =>
  existing
    ? `This wallet already has its personal token $${existing.ticker}. Open its room instead of creating another.`
    : null;
