import { ONESAT_MAINNET_CONTENT_URL } from '@1sat/actions';
import { Gamepad2, Send, ShoppingCart, Tag, Trophy } from 'lucide-react';
import { isUri } from '../../../utils/uri';
import { earnLabel, formatAmount, unlockLine, type Reward } from './rewards';

const GOLD = 'var(--bw-accent-hi)';
const iconUrl = (icon: string | null) => (!icon ? null : isUri(icon) ? icon : `${ONESAT_MAINNET_CONTENT_URL}/${icon}`);

export type RewardCardsProps = {
  rewards: readonly Reward[];
  /** Show "Unlocks … room" (off in a store build: holding a token never unlocks app features there). */
  showUnlock: boolean;
  /** Show the "Play …" button (off in a store build: no outside game links). */
  showEarn: boolean;
  onSend: (r: Reward) => void;
  onEarn: (url: string) => void;
  /** "Buy from players": open the token's listings (absent = hidden, e.g. a store build). */
  onBuy?: (r: Reward) => void;
  /** "Sell": list some for sale at your own price (absent = hidden). */
  onSell?: (r: Reward) => void;
};

const SECONDARY =
  'inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-base font-bold border cursor-pointer outline-none';

/**
 * Wallet › Rewards: tokens earned by playing. Amount, what it unlocks, where to earn more (primary), Send, and
 * player-to-player trading: Buy from players (listings) and Sell (list at your own price). No curve buy/sell.
 */
export const RewardCards = ({ rewards, showUnlock, showEarn, onSend, onEarn, onBuy, onSell }: RewardCardsProps) => {
  if (!rewards.length) return null;
  return (
    <section aria-label="Rewards" className="w-[92%] mx-auto mt-4 mb-2">
      <h2 className="flex items-center gap-2 text-lg font-bold m-0 mb-2" style={{ color: GOLD }}>
        <Trophy size={20} /> Rewards
      </h2>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))' }}>
        {rewards.map((r) => {
          const src = iconUrl(r.icon);
          const unlock = showUnlock ? unlockLine(r) : null;
          return (
            <article
              key={r.id}
              data-reward={r.id}
              className="rounded-2xl p-4 flex flex-col gap-3 min-w-0"
              style={{ background: 'var(--bw-surface)', border: '1px solid #3a2f0c' }}
            >
              <div className="flex items-center gap-3 min-w-0">
                {src ? (
                  <img src={src} alt="" className="w-12 h-12 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 bg-[#2b2f36]">
                    <Trophy size={22} color={GOLD} />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-2xl font-bold text-white break-words">{formatAmount(r.amountRaw, r.dec)}</div>
                  <div className="text-base font-semibold break-words" style={{ color: GOLD }}>
                    ${r.symbol}
                  </div>
                </div>
              </div>
              {unlock && <p className="text-base text-white m-0">{unlock}</p>}
              <p className="text-sm text-[#98A2B3] m-0">
                Earned by playing.{' '}
                {onBuy || onSell ? 'Send it, sell it, or buy more from players.' : 'You can send it to a friend.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {showEarn && r.earnUrl && (
                  <button
                    type="button"
                    onClick={() => onEarn(r.earnUrl as string)}
                    className="flex-1 min-w-[10rem] inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-base font-bold border-0 cursor-pointer outline-none"
                    style={{ background: GOLD, color: '#000' }}
                  >
                    <Gamepad2 size={18} /> {earnLabel(r.game)}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Send ${r.symbol}`}
                  onClick={() => onSend(r)}
                  className={SECONDARY}
                  style={{ background: 'var(--bw-surface)', borderColor: '#3a2f0c', color: GOLD }}
                >
                  <Send size={16} /> Send
                </button>
                {onBuy && (
                  <button
                    type="button"
                    aria-label={`Buy ${r.symbol} from players`}
                    onClick={() => onBuy(r)}
                    className={SECONDARY}
                    style={{ background: 'var(--bw-surface)', borderColor: '#3a2f0c', color: GOLD }}
                  >
                    <ShoppingCart size={16} /> Buy from players
                  </button>
                )}
                {onSell && BigInt(r.amountRaw || '0') > 0n && (
                  <button
                    type="button"
                    aria-label={`Sell ${r.symbol}`}
                    onClick={() => onSell(r)}
                    className={SECONDARY}
                    style={{ background: 'var(--bw-surface)', borderColor: '#3a2f0c', color: GOLD }}
                  >
                    <Tag size={16} /> Sell
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};
