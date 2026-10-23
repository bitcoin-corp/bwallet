import { mintFeeAddress, txFeeSats } from '../../mint/mint';
import { DEFAULT_PRESET, PRESETS, maxPrice, usd, type Curve, type PresetId } from '../../../lib/curves';
import { LockingScript, OP, Utils } from '@bsv/sdk';
import { MAP_PREFIX } from '../../names/personalToken';
import { INDEX_FUND_NETWORK_SATS, depositValue, launchDepositSats } from '../../tokens/indexFund';
import { TOKEN_DEPLOY_BYTES, cleanToken, validateToken, type TokenForm } from '../../tokens/token';
import { safety, type SafetyFilter } from '../../market/safety';
import { hasReturnsWording, RETURNS_BLOCK } from '../../tokens/returnsWording';
import { scheduleSummary, trancheCount, validateVestPlan, vestSchedule, type VestPlan } from './vesting';

/**
 * Exchange › Launchpad › Launch your own coin (phase 1 of the launchpad of launchpads): a BSV-21 token
 * deployed from this wallet on our own flow, no tokenblaster.lol. Pure helpers; nothing here signs.
 *
 * Fee (owner, 11 Oct 2026: "small flat BSV fee, never a share of the token"): one flat output of
 * LAUNCH_FEE_SATS to the build's bCorp fee address (BWALLET_MINT_FEE_ADDRESS, address only). A build
 * without that address, and every store build (bcorpFeeAddress), charges no launch fee.
 *
 * Indexing deposit (owner, 18 Oct 2026: "launching a coin can't be presented as free"): a BSV-21 coin is
 * not validated by the 1Sat/GorillaPool indexer until its fee address holds min_funding (0.1 BSV), and
 * every indexed output then costs 1,000 sats from it. Every launch pays that deposit right after the
 * deploy, under the same Allow (launchDepositSats, tokens/indexFund.ts). It goes to the indexer, not us.
 */

/** Flat launch fee: 0.001 BSV. Owner decision pending on the exact figure. */
export const LAUNCH_FEE_SATS = 100_000;
/** Launchpad default: 1 billion whole tokens (house convention, CLAUDE.md). */
export const LAUNCH_DEFAULT_SUPPLY = '1000000000';

export const emptyLaunchForm = (): TokenForm => ({
  name: '',
  ticker: '',
  supply: LAUNCH_DEFAULT_SUPPLY,
  decimals: '0',
  description: '',
});

/** The flat fee, or 0 when the build carries no fee address. */
export const launchFeeFor = (feeAddress?: string): number => (mintFeeAddress(feeAddress) ? LAUNCH_FEE_SATS : 0);

export interface LaunchCost {
  /** Miner fees: icon inscription, deploy and the deposit payment. */
  networkSats: number;
  /** Our own flat launch fee (0 = none). */
  launchFeeSats: number;
  /** Indexing deposit paid to the token's indexer fee address (GorillaPool / 1Sat), not to us. */
  depositSats: number;
  totalSats: number;
  txCount: number;
}

/** Everything a launch costs: network fees (icon, deploy, deposit tx), the indexing deposit and our launch fee. */
export function launchCost(
  iconBytes: number,
  satsPerKb: number,
  feeAddress?: string,
  opts: { mapBytes?: number; depositSats?: number; vest?: VestPlan } = {},
): LaunchCost {
  const icon = iconBytes > 0 ? txFeeSats(iconBytes, satsPerKb) : 0;
  const vesting = opts.vest && opts.vest.keepBps > 0 ? txFeeSats(vestBytes(opts.vest), satsPerKb) : 0;
  const networkSats =
    icon + txFeeSats(TOKEN_DEPLOY_BYTES + (opts.mapBytes ?? 0), satsPerKb) + INDEX_FUND_NETWORK_SATS + vesting;
  const launchFeeSats = launchFeeFor(feeAddress);
  const depositSats = opts.depositSats ?? launchDepositSats();
  return {
    networkSats,
    launchFeeSats,
    depositSats,
    totalSats: networkSats + launchFeeSats + depositSats,
    txCount: (iconBytes > 0 ? 2 : 1) + 1 + (vesting > 0 ? 1 : 0),
  };
}

/** Rough size of the vesting transaction: token input, ~1.1 KB per tranche lock, the rest coin and the receipt. */
export const vestBytes = (p: VestPlan): number => 400 + trancheCount(p) * 1_150 + 300 + 900;

export const DEPOSIT_LABEL = 'Indexing deposit (paid to the token indexer, GorillaPool)';

export { depositValue };

/** Why the deposit exists, under the form and on the sheet. */
export const DEPOSIT_NOTE =
  "The indexer (GorillaPool / 1Sat) only validates a new coin once its fee address holds a 0.1 BSV deposit; each transfer it indexes then uses 1,000 sats of it. Without it, wallets and the Exchange can't verify the coin.";

/** One-line cost summary under the form: no "free" anywhere, the total says what launching costs. */
export const costSummary = (cost: LaunchCost, fmt: (sats: number) => string): string =>
  [
    `Indexing deposit ${fmt(cost.depositSats)} (to GorillaPool)`,
    `network ≈ ${fmt(cost.networkSats)}`,
    cost.launchFeeSats > 0 ? `our launch fee ${fmt(cost.launchFeeSats)}` : 'our launch fee: none',
  ].join(' · ');

/** Form check before the approval sheet: token rules plus the returns-wording block. */
export function validateLaunch(f: TokenForm, s: SafetyFilter = safety()): string | null {
  return validateToken(f, s) ?? (hasReturnsWording(`${f.name} ${f.description}`) ? RETURNS_BLOCK : null);
}

/** Creator vesting check before the approval sheet: the plan's rules and that the supply splits into the ladder. */
export function validateVest(f: TokenForm, p: VestPlan): string | null {
  const err = validateVestPlan(p);
  if (err || p.keepBps === 0) return err;
  try {
    vestSchedule(BigInt(cleanToken(f).amount), p, 1);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Check the vesting schedule.';
  }
}

/**
 * The Launchpad's default disclaimer (owner, 15 Oct 2026): on every token page it creates (the on-chain MAP card,
 * the launch form, the done screen and the token's Exchange page). Creators may sell named tokens to fund named
 * things only on these terms.
 */
export const LAUNCH_DISCLAIMER =
  'No returns, dividends or price rises are promised. There is no promise the money will be spent on the project, that it will succeed, or that it will become a company.';

/** Launchpad prefill from a query string (?name=&description=&website=&category=), e.g. a bApp's Tokenise. */
export const launchPrefill = (
  search: string,
): { form: Partial<TokenForm>; options: Partial<LaunchOptions>; curve: PresetId } => {
  const sp = new URLSearchParams(search);
  const get = (k: string, max: number) => (sp.get(k) ?? '').trim().slice(0, max);
  const form: Partial<TokenForm> = {};
  const options: Partial<LaunchOptions> = {};
  const name = get('name', 64);
  if (name) form.name = name;
  const description = get('description', 1000);
  if (description) form.description = description;
  const website = get('website', 200);
  if (/^https:\/\/[^\s]+$/i.test(website)) options.website = website;
  const category = get('category', 32);
  if (/^[a-z0-9-]+$/.test(category)) options.category = category;
  // ?curve=standard|big|huge preselects the climb; anything else (e.g. bMovies' ?curve=film) = Standard.
  const c = get('curve', 16);
  const curve: PresetId = c in PRESETS ? (c as PresetId) : DEFAULT_PRESET;
  return { form, options, curve };
};

/** Shown on the approval sheet (replaces tokenblaster's "I understand" checkbox: nothing to tick). */
export const LAUNCH_NOTICE =
  'This is a real BSV transaction from your wallet, signed with your key. Coins are for fun and can be worth nothing.';

/** The one approval sheet's lines: everything the launch does, all in one Allow. */
export function approvalLines(
  f: TokenForm,
  cost: LaunchCost,
  fmt: (sats: number) => string,
  hasIcon: boolean,
  o: LaunchOptions = defaultLaunchOptions(),
  vest?: VestPlan,
  curve?: Curve | null,
): { label: string; value: string }[] {
  const c = cleanOptions(o);
  const ticker = f.ticker.trim().replace(/^\$/, '');
  const supply = BigInt((f.supply || '0').replace(/[,_\s]/g, '') || '0').toLocaleString('en-US');
  return [
    { label: 'Create token', value: `$${ticker}` },
    { label: 'Supply to your wallet', value: supply },
    ...(vest && vest.keepBps > 0
      ? [{ label: 'Keep for yourself, locked', value: `${vest.keepBps / 100}% · ${scheduleSummary(vest)}` }]
      : []),
    ...(hasIcon ? [{ label: 'Inscribe icon', value: 'On-chain image' }] : []),
    ...(hasMapExtras(o)
      ? [{ label: 'Coin card on-chain', value: 'Links, category and the no-promises disclaimer' }]
      : []),
    ...(curve
      ? [
          {
            label: 'Launch curve (permanent)',
            value: `${curve.preset ? PRESETS[curve.preset].label + ' · ' : ''}${usd(curve.floorUsd)} → ${usd(maxPrice(curve))}`,
          },
        ]
      : []),
    { label: "Open holders' room", value: `Hold ${BigInt(c.roomMin).toLocaleString('en-US')} to enter` },
    { label: 'List on the Launchpad', value: 'Public launch registry' },
    { label: DEPOSIT_LABEL, value: depositValue(cost.depositSats, fmt) },
    { label: 'Network fee', value: fmt(cost.networkSats) },
    { label: 'Our launch fee', value: cost.launchFeeSats > 0 ? fmt(cost.launchFeeSats) : 'None' },
  ];
}

// ── Advanced options (parity with tokenblaster.lol's launch form where it fits a wallet launch) ──

export interface LaunchOptions {
  /** 0 = whole tokens only (tokenblaster: always 0). */
  decimals: string;
  website: string;
  /** X handle, without @. */
  x: string;
  /** Telegram handle or group, without @. */
  telegram: string;
  /** Exchange category slug ('' = none). */
  category: string;
  /** Whole tokens a holder needs to enter the holders' room. */
  roomMin: string;
}

export const defaultLaunchOptions = (): LaunchOptions => ({
  decimals: '0',
  website: '',
  x: '',
  telegram: '',
  category: '',
  roomMin: '1',
});

const HANDLE = /^[A-Za-z0-9_]{1,32}$/;
const handle = (s: string) =>
  s
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^https?:\/\/t\.me\//i, '');

export const cleanOptions = (o: LaunchOptions): LaunchOptions => ({
  ...o,
  decimals: o.decimals.trim() || '0',
  website: o.website.trim(),
  x: handle(o.x),
  telegram: handle(o.telegram),
  roomMin: o.roomMin.trim().replace(/[,_\s]/g, '') || '1',
});

export function validateOptions(o: LaunchOptions, categories: readonly string[]): string | null {
  const c = cleanOptions(o);
  if (c.website && !/^https:\/\/[^\s/$.?#][^\s]*\.[^\s]+$/i.test(c.website)) return 'Website: a full https:// link.';
  if (c.website.length > 200) return 'Keep the website link under 200 characters.';
  if (c.x && !HANDLE.test(c.x)) return 'X: just the handle, like bwalletx.';
  if (c.telegram && !HANDLE.test(c.telegram)) return 'Telegram: just the handle or group name.';
  if (c.category && !categories.includes(c.category)) return 'Pick a category from the list.';
  if (!/^\d{1,18}$/.test(c.roomMin) || BigInt(c.roomMin) < 1n) return 'Room entry: a whole number of coins, 1 or more.';
  return null;
}

/** The token form with the advanced decimals folded in (TokenForm carries decimals). */
export const withOptions = (f: TokenForm, o: LaunchOptions): TokenForm => ({
  ...f,
  decimals: cleanOptions(o).decimals,
});

/** Room entry minimum in raw units. */
export const roomMinRaw = (o: LaunchOptions): string => {
  const c = cleanOptions(o);
  return (BigInt(c.roomMin) * 10n ** BigInt(Number(c.decimals) || 0)).toString();
};

/** MAP SET fields on the deploy tx: the coin's public card (links, category, story). */
export function launchMapFields(f: TokenForm, o: LaunchOptions): string[] {
  const c = cleanOptions(o);
  const pairs: [string, string][] = [
    ['app', 'bWallet'],
    ['type', 'coin'],
    ['name', f.name.trim()],
  ];
  const d = f.description.trim();
  if (d) pairs.push(['description', d]);
  if (c.website) pairs.push(['website', c.website]);
  if (c.x) pairs.push(['x', c.x]);
  if (c.telegram) pairs.push(['telegram', c.telegram]);
  if (c.category) pairs.push(['category', c.category]);
  pairs.push(['disclaimer', LAUNCH_DISCLAIMER]);
  return pairs.flat();
}

export function launchMapScript(f: TokenForm, o: LaunchOptions): LockingScript {
  const s = new LockingScript();
  s.writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  for (const part of [MAP_PREFIX, 'SET', ...launchMapFields(f, o)]) s.writeBin(Utils.toArray(part, 'utf8'));
  return s;
}

/** Rough MAP output size for the fee estimate (0 when there is nothing extra to write). */
export const mapBytes = (f: TokenForm, o: LaunchOptions): number =>
  hasMapExtras(o) ? 60 + launchMapFields(f, o).reduce((n, x) => n + x.length + 2, 0) : 0;

/** Every launch writes the MAP card now: it always carries the Launchpad disclaimer. */
export const hasMapExtras = (_o: LaunchOptions): boolean => true;

// ── Launched in bWalletX: this device's launches + the shared registry (bit-sign /api/bitsign/launches) ──

export interface Launch {
  /** sha256 of the canonical launch curve committed on the deploy tx (lib/curves), when it had one. */
  curveHash?: string | null;
  tokenId: string;
  ticker: string;
  name: string;
  icon: string | null;
  category: string | null;
  roomTicker: string | null;
  createdAt: number;
  /** A creator-made advert video (https), from the registry; shown labelled "made by the creator". */
  video?: string | null;
}

const TOKEN_ID = /^[0-9a-f]{64}_\d{1,6}$/i;
const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const httpsUrl = (v: unknown): string | null => {
  const u = str(v, 500);
  return u && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null;
};

export const parseLaunch = (r: unknown): Launch | null => {
  const o = (r ?? {}) as Record<string, unknown>;
  const tokenId = str(o.token_id ?? o.tokenId, 80);
  const ticker = str(o.ticker, 32);
  if (!tokenId || !TOKEN_ID.test(tokenId) || !ticker) return null;
  const created = o.created_at ?? o.createdAt;
  const at = typeof created === 'number' ? created : Date.parse(String(created ?? ''));
  return {
    tokenId: tokenId.toLowerCase(),
    ticker,
    name: str(o.name, 64) ?? ticker,
    icon: str(o.icon, 80),
    category: str(o.category, 32),
    roomTicker: str(o.room_ticker ?? o.roomTicker, 64),
    createdAt: Number.isFinite(at) ? at : 0,
    video: httpsUrl(o.video ?? o.advert_video),
    curveHash: (() => {
      const h = str(o.curve_hash ?? o.curveHash, 64);
      return h && /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null;
    })(),
  };
};

export const parseLaunchList = (data: unknown): Launch[] => {
  const rows = Array.isArray(data) ? data : (data as { launches?: unknown } | null)?.launches;
  return Array.isArray(rows) ? rows.map(parseLaunch).filter((l): l is Launch => !!l) : [];
};

/** Registry rows win over local ones; newest first. */
export const mergeLaunches = (registry: Launch[], local: Launch[]): Launch[] => {
  const by = new Map<string, Launch>();
  for (const l of local) by.set(l.tokenId, l);
  for (const l of registry) by.set(l.tokenId, l);
  return [...by.values()].sort((a, b) => b.createdAt - a.createdAt);
};

export const launchRegistration = (l: Launch) => ({
  token_id: l.tokenId,
  ticker: l.ticker,
  name: l.name,
  icon: l.icon,
  category: l.category,
  room_ticker: l.roomTicker,
  ...(l.curveHash ? { curve_hash: l.curveHash } : {}),
});

const KEY = 'bwallet.launches';
export const localLaunches = (): Launch[] => {
  try {
    return parseLaunchList(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    return [];
  }
};
export const saveLocalLaunch = (l: Launch) => {
  try {
    const rest = localLaunches().filter((x) => x.tokenId !== l.tokenId);
    localStorage.setItem(KEY, JSON.stringify([l, ...rest].slice(0, 200)));
  } catch {
    /* storage unavailable */
  }
};
