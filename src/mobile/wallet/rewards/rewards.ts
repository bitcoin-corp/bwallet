/**
 * Rewards: tokens you earn by playing a game, shown on their own card in the Wallet (not with money or
 * tradable tokens). No buy or sell here; holders still send them person to person.
 *
 * Detection, first match wins (any game can mark its token this way):
 *  1. TokenBlaster's /api/launch/coins | /api/launch/coin row says `category: 'reward'` (coming).
 *  2. The row says `trading: false` with a safe `earn_url` (live, tokenblaster #76).
 *  3. The local no-curve list (market/launchpad/noCurve.ts), e.g. $TERRORNODE.
 */
import { NO_CURVE_IDS, safeEarnUrl } from '../../market/launchpad/noCurve';

export type RewardSource = 'category' | 'trading' | 'local';

export type RewardCoinFlags = {
  token_id?: unknown;
  category?: unknown;
  trading?: unknown;
  earn_url?: unknown;
  earn_label?: unknown;
  game?: unknown;
};

export type RewardInfo = { source: RewardSource; earnUrl: string | null; game: string | null };

/** Game names for the local list, so the button can say what to play. */
export const LOCAL_GAMES: Readonly<Record<string, string>> = {
  d5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1: 'Assault on Terrornode',
};

const has = (o: Readonly<Record<string, string>>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null);

const norm = (id: string) => id.trim().toLowerCase().replace('.', '_');

/** Is this token a reward, and where to earn more. `null` = an ordinary token. */
export const rewardInfo = (rawId: string, coin?: RewardCoinFlags | null): RewardInfo | null => {
  const id = norm(rawId);
  const local = has(NO_CURVE_IDS, id) ? NO_CURVE_IDS[id] : null;
  const game = text(coin?.game) ?? text(coin?.earn_label) ?? (has(LOCAL_GAMES, id) ? LOCAL_GAMES[id] : null);
  const url = safeEarnUrl(coin?.earn_url) ?? local;
  if (coin?.category === 'reward') return { source: 'category', earnUrl: url, game };
  if (coin?.trading === false && safeEarnUrl(coin?.earn_url)) return { source: 'trading', earnUrl: url, game };
  if (local) return { source: 'local', earnUrl: local, game };
  return null;
};

/** Button text for "earn more". */
export const earnLabel = (game: string | null) => (game ? `Play ${game}` : 'Play to earn more');

/** Index board rows by token id (normalised). */
export const coinsById = (coins: readonly RewardCoinFlags[]): Map<string, RewardCoinFlags> => {
  const m = new Map<string, RewardCoinFlags>();
  for (const c of coins) if (typeof c.token_id === 'string') m.set(norm(c.token_id), c);
  return m;
};

export type HeldToken = { id: string; symbol: string; dec: number; amountRaw: string; icon: string | null };

export type Reward = HeldToken & RewardInfo & { room: string | null };

/** Held tokens that are rewards, in held order. */
export const pickRewards = (
  held: readonly HeldToken[],
  coins: ReadonlyMap<string, RewardCoinFlags>,
  rooms: ReadonlyMap<string, string> = new Map(),
): Reward[] => {
  const out: Reward[] = [];
  for (const h of held) {
    if (BigInt(h.amountRaw || '0') <= 0n) continue;
    const info = rewardInfo(h.id, coins.get(norm(h.id)));
    if (info) out.push({ ...h, ...info, room: rooms.get(norm(h.id)) ?? null });
  }
  return out;
};

/** Whole-token amount with grouping, e.g. "1,250" or "12.5". */
export const formatAmount = (raw: string, dec: number): string => {
  const n = BigInt(raw || '0');
  const base = 10n ** BigInt(Math.max(0, dec));
  const whole = (n / base).toLocaleString('en-US');
  const frac = dec > 0 ? (n % base).toString().padStart(dec, '0').replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac.slice(0, 4)}` : whole;
};

/** "Unlocks the $TERRORNODE room" when a room's tokenGate is this token. */
export const unlockLine = (r: Pick<Reward, 'room' | 'symbol'>): string | null =>
  r.room ? `Unlocks the ${r.room.startsWith('$') ? r.room : `$${r.room}`} room` : null;
