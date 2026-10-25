import type { MouseEvent } from 'react';
import { fiatSymbol, type Fx } from '../../utils/displayCurrency';
import { setCardUnit, useCardUnit } from './cardValue';

/**
 * The bottom-right fiat/BSV switch, the BSV card's own (.bw-wcard-unit). One shared setting: flipping it on any
 * balance card flips every card. The fiat side shows the Settings › Currency symbol ($ by default, £ for GBP).
 */
/** `bsvLabel`: the main wallet card passes "$bsv" (MAIN_CARD_UNIT); every other card keeps "BSV". */
export const CardUnitSwitch = ({ fx, bsvLabel = 'BSV' }: { fx: Fx; bsvLabel?: string }) => {
  const unit = useCardUnit();
  const pick = (u: 'usd' | 'bsv') => (e: MouseEvent) => {
    e.stopPropagation();
    setCardUnit(u);
  };
  return (
    <div className="bw-wcard-unit" role="group" aria-label="Balance unit">
      {(['usd', 'bsv'] as const).map((u) => (
        <button
          key={u}
          type="button"
          aria-pressed={unit === u}
          className={unit === u ? 'is-on' : undefined}
          onClick={pick(u)}
        >
          {u === 'usd' ? fiatSymbol(fx) : bsvLabel}
        </button>
      ))}
    </div>
  );
};
