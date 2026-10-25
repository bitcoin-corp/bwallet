import { useEffect, useState } from 'react';
import { cachedExchangeRate, fetchExchangeRate } from '../utils/exchangeRate';
import { dollarsFirst, priceFrom, type PriceState } from '../utils/dollarsFirst';

/**
 * The BSV price for a sheet's amount labels. A rate the sheet was handed wins; otherwise the last known rate,
 * then a fetch. "loading" until the fetch settles, "unavailable" if it brought nothing. Display only.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const useSheetPrice = (known?: number): PriceState => {
  const [fetched, setFetched] = useState<number>(() => cachedExchangeRate());
  const [settled, setSettled] = useState(false);
  const have = !!known && known > 0;
  useEffect(() => {
    if (have) return;
    let live = true;
    fetchExchangeRate('main')
      .then((r) => live && r > 0 && setFetched(r))
      .catch(() => undefined)
      .finally(() => live && setSettled(true));
    return () => {
      live = false;
    };
  }, [have]);
  return have ? { status: 'ok', usdPerBsv: known } : priceFrom(fetched, settled);
};

/** Large dollar figure with the sats small and muted underneath. */
export const DollarAmount = ({
  sats,
  price,
  size = 28,
  color,
  mutedColor,
  align = 'right',
}: {
  sats: number;
  price: PriceState;
  size?: number;
  color?: string;
  mutedColor?: string;
  align?: 'left' | 'right' | 'center';
}) => {
  const { main, sub } = dollarsFirst(sats, price);
  const small = price.status !== 'ok';
  return (
    <span
      style={{ display: 'inline-flex', flexDirection: 'column', textAlign: align, lineHeight: 1.1 }}
      data-testid="dollar-amount"
    >
      <span style={{ fontSize: small ? Math.max(14, Math.round(size * 0.6)) : size, fontWeight: 800, color }}>
        {main}
      </span>
      <span style={{ fontSize: 12, fontWeight: 500, opacity: 0.7, color: mutedColor, marginTop: 2 }}>{sub}</span>
    </span>
  );
};
