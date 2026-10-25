/**
 * The bApps screen catalogue in tiers (owner, 23 Oct 2026; docs/BAPP-STANDARD.md):
 *   1. 'bx'         — our b*X bApps, featured at the top with their own marks;
 *   2. 'commercial' — our and our clients' ventures with tokens (NPG, NPGX 18+, VexVoid, Zero Dice);
 *   3. 'community'  — other developers' apps, listed ONLY when they meet the bApp standard.
 * The built-in wallet bApps (bapps.ts BAPPS) keep their own data; this file is additive and only reads them.
 *
 * The bApp standard, as data on every entry (`standard`):
 *   token    — the app has a token (BSV-21 ticker; null = none yet);
 *   room     — it has a bChatX room (ticker in bit-sign; checked against chat/bappRooms.ts);
 *   theme    — it ships a wallet theme (host in theme/themeSites.ts);
 *   inWallet — it runs in the bWalletX bApp format: opens in the in-wallet frame/webview and connects over BRC-100
 *              (CWI / XDM) with no separate login. Checked here as "the site lets the wallet frame it"
 *              (no X-Frame-Options DENY / restrictive frame-ancestors, 23 Oct 2026).
 */
import { BAPPS, type BApp } from './bapps';
import { isBappRoom } from './chat/bappRooms';
import { familySite } from './theme/themeSites';
import bdojoxLogo from './brand/bx/bdojox.png';
import bmoviesxLogo from './brand/bx/bmoviesx.png';
import bfriendsxLogo from './brand/bx/bfriendsx.svg';

export type BappTier = 'bx' | 'commercial' | 'community';

export interface BappStandard {
  /** BSV-21 ticker (no $), or null. */
  token: string | null;
  /** bChatX room ticker, or null. */
  room: string | null;
  /** themeSites id, or null. */
  theme: string | null;
  inWallet: boolean;
}

export interface StoreApp {
  id: string;
  name: string;
  url: string;
  verb: string;
  tier: BappTier;
  /** Section header inside the tier. */
  category: string;
  /** Brand colour: the generated b-mark / monogram tile when there is no logo. */
  color: string;
  logo?: string;
  standard: BappStandard;
  /** Adult (18+): shown only after the 18+ confirmation, never in a store build. */
  adult?: boolean;
  /** bWalletX only: never in the store edition (bWallet). */
  privateOnly?: boolean;
  status?: 'live' | 'demo' | 'soon';
}

export const STANDARD_KEYS = ['token', 'room', 'theme', 'inWallet'] as const;
export type StandardKey = (typeof STANDARD_KEYS)[number];

/** Which parts of the standard an app is missing (empty = bApp-ready). */
export const missingStandard = (s: BappStandard): StandardKey[] =>
  STANDARD_KEYS.filter((k) => (k === 'inWallet' ? !s.inWallet : !s[k]));

export const meetsStandard = (s: BappStandard) => missingStandard(s).length === 0;

/** Build the standard from what the wallet already knows: rooms registry + theme hosts. */
const std = (url: string, token: string | null, inWallet: boolean): BappStandard => ({
  token,
  room: token && isBappRoom(token) ? token : null,
  theme: familySite(url)?.id ?? null,
  inWallet,
});

const bx = (
  id: string,
  name: string,
  url: string,
  verb: string,
  category: string,
  color: string,
  token: string | null,
  extra: Partial<StoreApp> & { inWallet?: boolean } = {},
): StoreApp => {
  const { inWallet = true, ...rest } = extra;
  return {
    id,
    name,
    url,
    verb,
    tier: 'bx',
    category,
    color,
    standard: std(url, token, inWallet),
    status: 'live',
    ...rest,
  };
};

/** Tier 1: our b*X bApps. Only ones with a live site (checked 23 Oct 2026). */
export const BX_APPS: StoreApp[] = [
  bx(
    'bchatx',
    'bChatX',
    'https://www.bchatx.com',
    'Rooms, Spaces and feeds for every token',
    'Talk',
    '#FFD24D',
    'BCHATX',
  ),
  bx(
    'bsocialx',
    'bSocialX',
    'https://bsocialx.com',
    'Spaces for every brand and token, in public',
    'Talk',
    '#FF8A3D',
    'BSOCIALX',
  ),
  bx(
    'bfriendsx',
    'bFriendsX',
    'https://bfriendsx.com',
    'Your friends, kept on Bitcoin',
    'Talk',
    '#5AD8FF',
    'BFRIENDSX',
    {
      logo: bfriendsxLogo,
    },
  ),
  bx(
    'bmoviesx',
    'bMoviesX',
    'https://www.bmoviesx.com',
    'Watch and back tokenised films',
    'Watch & make',
    '#FF1F2D',
    'BMOVIES',
    {
      logo: bmoviesxLogo,
    },
  ),
  bx(
    'bmusicx',
    'bMusicX',
    'https://bmusicx.com',
    'Tokenise your music; holders make the video with you',
    'Watch & make',
    '#B57BFF',
    'BMUSIC',
    {
      // frame-ancestors doesn't list the wallet yet (23 Oct 2026): opens full screen.
      inWallet: false,
    },
  ),
  bx(
    'bdojox',
    'bDojoX',
    'https://bdojox.com',
    'Train, compete and earn your belts',
    'Watch & make',
    '#C8141C',
    'BDOJOX',
    {
      logo: bdojoxLogo,
    },
  ),
  bx(
    'bradiox',
    'bRadioX',
    'https://bradiox.com',
    'Live shows, interviews and podcasts',
    'Watch & make',
    '#3DD68C',
    'BRADIO',
  ),
  bx(
    'bvideox',
    'bVideoX',
    'https://bvideox.com',
    'Publish video that pays you per view',
    'Watch & make',
    '#FF5FA2',
    'BVIDEOX',
    // Opens full screen so Connect bWalletX finds the wallet (bapps.ts bVideoX noFrame).
    { inWallet: false },
  ),
  bx('bnewsx', 'bNewsX', 'https://bnewsx.com', 'The stories on chain today', 'Watch & make', '#E6E6E6', 'BNEWS'),
  bx(
    'bmintx',
    'bMintX',
    'https://bmintx.com',
    'Mint anything: art, media, coins and archives',
    'Own & trade',
    '#FFD24D',
    'BMINTX',
  ),
  // Share registers are securities: not even listed in the App Store / Google Play edition (store grep).
  // Literal env check (same env as STORE_BUILD) so Rollup drops the entry's strings from store bundles.
  ...(import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
    ? []
    : [
        bx(
          'bsharesx',
          'bSharesX',
          'https://bsharesx.com',
          'Share registers for any company',
          'Own & trade',
          '#4D9BFF',
          'BSHARESX',
          {
            privateOnly: true,
          },
        ),
      ]),
  bx(
    'bmoneyx',
    'bMoneyX',
    'https://bmoneyx.com',
    'All your money in one view, with proofs',
    'Own & trade',
    '#2ECC71',
    'BMONEYX',
    {
      privateOnly: true,
    },
  ),
  bx(
    'bstorex',
    'bStoreX',
    'https://bstorex.com',
    'Themes, icons and packs for bWalletX',
    'Own & trade',
    '#FFB020',
    'BSTORE',
  ),
  bx(
    'bdrivex',
    'bDriveX',
    'https://bdrivex.com',
    'Files and designer drops, owned on-chain',
    'Work',
    '#36C5F0',
    'BDRIVEX',
  ),
  bx('bmailx', 'bMailX', 'https://bmailx.com', 'Email that pays and gets paid', 'Work', '#F25F5C', 'BMAIL'),
  bx(
    'bwriterx',
    'bWriterX',
    'https://bwriterx.com',
    'Write and publish documents on-chain',
    'Work',
    '#A0A0FF',
    'BWRITERX',
  ),
  bx('bcalx', 'bCalX', 'https://bcalx.com', 'Paid bookings and shared calendars', 'Work', '#FF7A59', 'BCAL'),
  bx('bjobsx', 'bJobsX', 'https://bjobsx.com', 'Micro-jobs for people and agents', 'Work', '#00C2A8', 'BJOBS'),
];

/**
 * Tier 2: commercial apps with tokens. NPG (all ages) and NPGX (adult) are separate brands and never share a tile,
 * a section or artwork. NPGX is not in a store bundle at all (literal env check, so Rollup drops the data).
 */
export const COMMERCIAL_APPS: StoreApp[] = [
  {
    id: 'npg',
    name: 'Ninja Punk Girls',
    url: 'https://ninjapunkgirls.com',
    verb: 'Collect, battle and trade the Ninja Punk Girls',
    tier: 'commercial',
    category: 'Games & collectibles',
    color: '#FF2E88',
    standard: std('https://ninjapunkgirls.com', 'NPG', true),
    status: 'live',
  },
  {
    id: 'vexvoid',
    name: 'VexVoid',
    url: 'https://vexvoid.com',
    verb: 'Jet-bike racing, music and techwear drops',
    tier: 'commercial',
    category: 'Games & collectibles',
    color: '#7CF7FF',
    standard: std('https://vexvoid.com', 'VEX', true),
    status: 'live',
  },
  // Zero Dice (client): real-money dice, so never in the store edition (like the real-money games).
  {
    id: 'zerodice',
    name: 'Zero Dice',
    url: 'https://zerodice.online',
    verb: 'Provably fair dice with a zero house edge',
    tier: 'commercial',
    category: 'Games & collectibles',
    color: '#FFFFFF',
    standard: std('https://zerodice.online', 'ZERODICE', true),
    privateOnly: true,
    status: 'live',
  },
  ...(!(
    import.meta.env.VITE_STORE_BUILD === '1' ||
    import.meta.env.VITE_CHANNEL === 'ios-store' ||
    import.meta.env.VITE_CHANNEL === 'android-play'
  )
    ? [
        {
          id: 'npgx',
          name: 'NPGX',
          url: 'https://npgx.website',
          verb: 'Adults only. The NPGX brand, separate from NPG',
          tier: 'commercial' as const,
          category: 'Adults only (18+)',
          color: '#B0000E',
          // X-Frame-Options DENY (23 Oct 2026): opens full screen until the site allows the wallet.
          standard: std('https://npgx.website', 'NPGX', false),
          adult: true,
          privateOnly: true,
          status: 'live' as const,
        },
      ]
    : []),
];

/**
 * The built-in wallet bApps (bapps.ts) with the standard filled in from what we know. Wallet routes (/m/…) run in
 * the wallet by definition; sites run in-frame unless flagged noFrame.
 */
export const builtinStandard = (a: BApp): BappStandard => {
  const ticker = a.name.replace(/X$/, '').toUpperCase();
  const route = a.url.startsWith('/');
  return {
    token: isBappRoom(ticker) ? ticker : null,
    room: isBappRoom(ticker) ? ticker : null,
    theme: route ? 'bwalletx' : (familySite(a.url)?.id ?? null),
    inWallet: route || !a.noFrame,
  };
};

/** Every listed entry (tiers 1–2 + the built-ins), for search and for reporting who fails the standard. */
export const standardReport = (): { name: string; tier: string; missing: StandardKey[] }[] => [
  ...[...BX_APPS, ...COMMERCIAL_APPS].map((a) => ({
    name: a.name,
    tier: a.tier,
    missing: missingStandard(a.standard),
  })),
  ...BAPPS.map((a) => ({ name: a.name, tier: 'builtin', missing: missingStandard(builtinStandard(a)) })),
];

/** Visible entries for an edition: no privateOnly / adult entries in a store build. Adult tiles stay locked until the
 * 18+ confirmation (BappsStore). */
export const visibleApps = (apps: StoreApp[], store: boolean): StoreApp[] =>
  apps.filter((a) => !(store && (a.privateOnly || a.adult)));

/**
 * One entry per product (24 Oct 2026): "bMovies" and "bMoviesX" are the same product, so both reduce to "bmovies".
 * Only b-names drop a trailing X; other names are just lower-cased.
 */
export const productKey = (name: string) => {
  const n = name.trim().toLowerCase();
  return /^b[a-z0-9]+x$/.test(n) ? n.slice(0, -1) : n;
};

/** Host without "www.", or null for a wallet path. */
export const bareHostOf = (url: string): string | null => {
  try {
    return /^https?:/i.test(url) ? new URL(url).hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

/** Drops items that repeat a product (same productKey) or a site (same host) already listed in `taken`. */
export const withoutDuplicates = <T extends { name: string; url?: string }>(
  items: T[],
  taken: { name: string; url?: string }[],
): T[] => {
  const names = new Set(taken.map((t) => productKey(t.name)));
  const hosts = new Set(taken.map((t) => (t.url ? bareHostOf(t.url) : null)).filter(Boolean));
  return items.filter((i) => {
    const host = i.url ? bareHostOf(i.url) : null;
    if (names.has(productKey(i.name)) || (host && hosts.has(host))) return false;
    names.add(productKey(i.name));
    if (host) hosts.add(host);
    return true;
  });
};

/** Case-insensitive search over name, verb and token. */
export const matchesQuery = (a: { name: string; verb?: string; standard?: BappStandard }, q: string) => {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [a.name, a.verb ?? '', a.standard?.token ?? ''].some((v) => v.toLowerCase().includes(s));
};

/** Group by category, keeping first-seen order. */
export const byCategory = <T extends { category: string }>(apps: T[]): { category: string; apps: T[] }[] => {
  const out: { category: string; apps: T[] }[] = [];
  for (const a of apps) {
    const g = out.find((x) => x.category === a.category);
    if (g) g.apps.push(a);
    else out.push({ category: a.category, apps: [a] });
  }
  return out;
};

export const ADULT_OK_KEY = 'bw.bapps.adultOk';

/**
 * One short line for a card (owner, 25 Oct 2026: "less explanatory text"). The first clause of the description,
 * cut at a ";", ":", "." or dash; the full text stays in the card's title and the app itself.
 */
export const shortLine = (verb: string | undefined, max = 24): string => {
  const first = (verb ?? '').split(/\s*(?:[;:.]\s|\s[—–-]\s)/)[0].trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 12 ? cut.slice(0, space) : first.slice(0, max)).replace(/[,\s]+$/, '')}…`;
};

/** Bold, distinct tile colours for apps without a brand colour: picked from the name, so each app keeps its own. */
export const TILE_PALETTE = [
  '#FFD24D',
  '#FF5FA2',
  '#5AD8FF',
  '#B57BFF',
  '#3DD68C',
  '#FF8A3D',
  '#4D9BFF',
  '#F25F5C',
  '#00C2A8',
  '#FFB020',
  '#C8141C',
  '#7CF7FF',
] as const;

export const tileColour = (name: string, color?: string): string => {
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return color;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_PALETTE[h % TILE_PALETTE.length];
};
