import { HD, Mnemonic } from '@bsv/sdk';
import type { ScannedAssets } from '../../sweep/scanner';
import {
  DEFAULT_IDENTITY_PATH,
  DEFAULT_ORD_PATH,
  DEFAULT_RELAYX_ORD_PATH,
  DEFAULT_TWETCH_WALLET_PATH,
  DEFAULT_WALLET_PATH,
  SWEEP_PATH,
} from '../../utils/constants';
import { MONEYBUTTON_PATH } from '../sweep/moneybutton';
import { normalizePhrase } from '../sweep/hd';
import { ensureContrast, mix } from '../theme/colour';

/**
 * "Where this account came from" (owner, 24 Oct 2026): one card per older wallet the account's recovery phrase was
 * used with, listing what is still at that wallet's addresses. Read-only: this module only derives addresses and
 * asks the indexer what sits there. Moving anything goes through the existing sweep screens (HdSweepScreen,
 * RelayxRecoverScreen), never from here.
 *
 * Paths, all already in the repo:
 *  - Yours: utils/constants.ts DEFAULT_WALLET_PATH / DEFAULT_ORD_PATH / DEFAULT_IDENTITY_PATH (the paths Yours
 *    itself uses, see sweep/hd.ts FIXED_KEYS), plus SWEEP_PATH, Yours' older payment key.
 *  - RelayX: SWEEP_PATH payment + DEFAULT_RELAYX_ORD_PATH ordinals (the RelayX switch in Keys.service.ts).
 *  - Twetch: DEFAULT_TWETCH_WALLET_PATH (m/0/0, same switch).
 *  - Money Button: m/44'/0'/0' receive chain (sweep/moneybutton.ts, Money Button docs "Mnemonics (BIP39)").
 *  - SimplyCash: m/44'/145'/0' (sweep/hd.ts PRESETS).
 * Not scanned: HandCash (gives users no recovery phrase) and Electrum (its own non-BIP39 seed format).
 */

export type OriginKey = { label: string; path: string };
export type Origin = {
  id: 'yours' | 'relayx' | 'twetch' | 'moneybutton' | 'simplycash';
  name: string;
  /** Single keys straight from the phrase. */
  keys: OriginKey[];
  /** BIP44 account (receive chain): the first HD_QUICK addresses are checked; the sweep walks the full gap. */
  account?: string;
  /** Which existing screen brings things over. */
  bring: 'sweep' | 'relayx';
};

/** Receive addresses checked per HD account in the quick check (the full gap walk is the sweep's job). */
export const HD_QUICK = 5;

export const ORIGINS: Origin[] = [
  {
    id: 'yours',
    name: 'Yours',
    keys: [
      { label: 'payment', path: DEFAULT_WALLET_PATH },
      { label: 'ordinals', path: DEFAULT_ORD_PATH },
      { label: 'identity', path: DEFAULT_IDENTITY_PATH },
      { label: 'older payment', path: SWEEP_PATH },
    ],
    bring: 'sweep',
  },
  {
    id: 'relayx',
    name: 'RelayX',
    keys: [
      { label: 'payment', path: SWEEP_PATH },
      { label: 'NFTs', path: DEFAULT_RELAYX_ORD_PATH },
    ],
    bring: 'relayx',
  },
  { id: 'twetch', name: 'Twetch', keys: [{ label: 'payment', path: DEFAULT_TWETCH_WALLET_PATH }], bring: 'sweep' },
  { id: 'moneybutton', name: 'Money Button', keys: [], account: MONEYBUTTON_PATH, bring: 'sweep' },
  { id: 'simplycash', name: 'SimplyCash', keys: [], account: "m/44'/145'/0'", bring: 'sweep' },
];

export type OriginAddress = { label: string; path: string; address: string };

/** Every address checked for each origin. Public addresses only: no private keys leave this function. */
export function originAddresses(mnemonic: string): Map<Origin['id'], OriginAddress[]> {
  const master = HD.fromSeed(Mnemonic.fromString(normalizePhrase(mnemonic)).toSeed(''));
  const out = new Map<Origin['id'], OriginAddress[]>();
  for (const o of ORIGINS) {
    const list: OriginAddress[] = o.keys.map((k) => ({
      ...k,
      address: master.derive(k.path).privKey.toAddress(),
    }));
    if (o.account) {
      const acct = master.derive(o.account);
      for (let i = 0; i < HD_QUICK; i++)
        list.push({
          label: `receive ${i}`,
          path: `${o.account}/0/${i}`,
          address: acct.deriveChild(0).deriveChild(i).privKey.toAddress(),
        });
    }
    out.set(o.id, list);
  }
  return out;
}

export type Holdings = { sats: number; ordinals: number; runJigs: number; tokens: number; names: number };
export type OriginResult = {
  id: Origin['id'];
  name: string;
  bring: Origin['bring'];
  status: 'found' | 'empty' | 'error';
  holdings: Holdings;
  addresses: number;
};
export type OriginScan = { at: number; results: OriginResult[] };

const empty = (): Holdings => ({ sats: 0, ordinals: 0, runJigs: 0, tokens: 0, names: 0 });
const add = (h: Holdings, a: ScannedAssets): void => {
  h.sats += a.totalBsv;
  h.ordinals += a.ordinals.length;
  h.runJigs += a.runJigs.length;
  h.tokens += a.bsv21Tokens.length + a.bsv20Tokens.length;
  h.names += a.opnsNames.length;
};
export const hasAny = (h: Holdings) => h.sats > 0 || h.ordinals + h.runJigs + h.tokens + h.names > 0;

/**
 * Check every origin's addresses. `scan` is the sweep scanner (sweep/scanner.ts scanAddress) bound to the services;
 * one address at a time, each address once even when two wallets share a key (Yours' older key = RelayX payment).
 */
export async function scanOrigins(
  mnemonic: string,
  scan: (address: string) => Promise<ScannedAssets>,
  now = Date.now(),
): Promise<OriginScan> {
  const addrs = originAddresses(mnemonic);
  const seen = new Map<string, ScannedAssets | null>();
  const results: OriginResult[] = [];
  for (const o of ORIGINS) {
    const h = empty();
    let failed = false;
    const list = addrs.get(o.id) ?? [];
    for (const a of list) {
      if (!seen.has(a.address)) {
        try {
          seen.set(a.address, await scan(a.address));
        } catch {
          seen.set(a.address, null);
        }
      }
      const got = seen.get(a.address);
      if (got) add(h, got);
      else failed = true;
    }
    results.push({
      id: o.id,
      name: o.name,
      bring: o.bring,
      status: hasAny(h) ? 'found' : failed ? 'error' : 'empty',
      holdings: h,
      addresses: list.length,
    });
  }
  return { at: now, results };
}

/** A scan this recent is shown as is, with no new lookups (background-friendly, easy on the indexer). */
export const FRESH_MS = 6 * 60 * 60 * 1000;
/** "Check again" waits at least this long after the last scan. */
export const RECHECK_MS = 60 * 1000;

export const shouldAutoScan = (cached: OriginScan | null, now = Date.now()) => !cached || now - cached.at > FRESH_MS;
export const canRecheck = (cached: OriginScan | null, now = Date.now()) => !cached || now - cached.at >= RECHECK_MS;

const cacheKey = (account: string) => `bwx.origins.v1.${account}`;

/** Per account, on this device. Public chain facts only (counts and sats), never addresses or keys. */
export function loadOrigins(account: string): OriginScan | null {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(cacheKey(account)) ?? 'null') as OriginScan | null;
    return v && typeof v.at === 'number' && Array.isArray(v.results) ? v : null;
  } catch {
    return null;
  }
}
export function saveOrigins(account: string, scan: OriginScan) {
  try {
    globalThis.localStorage?.setItem(cacheKey(account), JSON.stringify(scan));
  } catch {
    // storage blocked: the cards still show, they just are not cached
  }
}

/** One short line for a card: "3 NFTs · 2 Run NFTs · 1 token". BSV is shown separately, in money. */
export function holdingsLine(h: Holdings): string {
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  return [
    part(h.ordinals, 'NFT', 'NFTs'),
    part(h.runJigs, 'Run NFT', 'Run NFTs'),
    part(h.tokens, 'token', 'tokens'),
    part(h.names, 'name', 'names'),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Card themes (owner, 24 Oct 2026: "branded and themed wallets plug into this narrative"). Accent colour only, an
 * echo of the old wallet's look: no logos, no trademarks, plain names. A partner's branded wallet can supply its own
 * card theme later through registerOriginTheme, keyed by its origin id.
 */
export type OriginTheme = { accent: string };
const ORIGIN_THEMES = new Map<string, OriginTheme>([
  ['yours', { accent: '#2FBF71' }],
  ['relayx', { accent: '#3B8BEB' }],
  ['twetch', { accent: '#9B6CFF' }],
  ['moneybutton', { accent: '#F2994A' }],
  ['simplycash', { accent: '#2EC4B6' }],
  ['electrum', { accent: '#5B9BD5' }],
]);
export const registerOriginTheme = (id: string, theme: OriginTheme) => {
  if (/^#[0-9a-f]{6}$/i.test(theme.accent)) ORIGIN_THEMES.set(id, theme);
};
/** undefined: the card keeps the wallet's own gold. */
export const originTheme = (id: string): OriginTheme | undefined => ORIGIN_THEMES.get(id);

/** Plain names for the drawer badge (no logos). Electrum is listed for accounts marked by hand. */
export const ORIGIN_NAMES: Record<string, string> = {
  yours: 'Yours',
  relayx: 'RelayX',
  twetch: 'Twetch',
  moneybutton: 'Money Button',
  simplycash: 'SimplyCash',
  electrum: 'Electrum',
};

/** What a restore's wallet choice (RestoreAccount importWallet) says the account came from. */
export const originFromImport = (w: string | undefined): string | undefined =>
  w === 'yours' || w === 'panda' ? 'yours' : w === 'relayx' || w === 'twetch' ? w : undefined;

const originKey = (account: string) => `bwx.origin.v1.${account}`;
/** The account's origin on this device: set at restore, from the origin scan, or by hand. undefined: made here. */
export function loadAccountOrigin(account: string): string | undefined {
  try {
    const v = globalThis.localStorage?.getItem(originKey(account)) ?? '';
    return ORIGIN_NAMES[v] || ORIGIN_THEMES.has(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
export function saveAccountOrigin(account: string, origin: string | null) {
  try {
    if (origin) globalThis.localStorage?.setItem(originKey(account), origin);
    else globalThis.localStorage?.removeItem(originKey(account));
  } catch {
    // storage blocked: the account keeps the default gold
  }
}

/** First origin the scan found anything at, when the account has none recorded yet. */
export const inferOrigin = (scan: OriginScan): string | undefined => scan.results.find((r) => r.status === 'found')?.id;

const ROW_BG = '#17191E';
/**
 * Drawer tint for an account's origin. undefined (fresh bWalletX account, unknown origin): default gold row.
 * Badge text is kept at 4.5:1 or better on its pill.
 */
export function originTint(origin: string | undefined): { accent: string; pill: string; text: string } | undefined {
  const t = origin ? ORIGIN_THEMES.get(origin) : undefined;
  if (!t) return undefined;
  const pill = mix(ROW_BG, t.accent, 0.22);
  return { accent: t.accent, pill, text: ensureContrast(t.accent, pill, 4.5) };
}
