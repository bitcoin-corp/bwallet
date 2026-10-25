import { ONESAT_MAINNET_CONTENT_URL } from '@1sat/actions';
import { Gamepad2, Send, Trophy } from 'lucide-react';
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
};

/** Wallet › Rewards: tokens earned by playing. Amount, what it unlocks, where to earn more, Send. No buy/sell. */
export const RewardCards = ({ rewards, showUnlock, showEarn, onSend, onEarn }: RewardCardsProps) => {
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
              <p className="text-sm text-[#98A2B3] m-0">Earned by playing. You can send it to a friend.</p>
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
                  className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-base font-bold border cursor-pointer outline-none"
                  style={{ background: 'var(--bw-surface)', borderColor: '#3a2f0c', color: GOLD }}
                >
                  <Send size={16} /> Send
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};
