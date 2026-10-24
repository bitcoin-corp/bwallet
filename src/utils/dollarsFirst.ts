/**
 * Dollars first on every approval / payment sheet (owner, 24 Oct 2026): users don't know what a sat is worth,
 * so the headline is a dollar figure ("$0.04", or "4¢" under a dollar) and the sats sit small underneath
 * ("3,412 sats"). Display only: nothing here decides an amount.
 */

/** What the sheet knows about the BSV price right now. */
export type PriceState = { status: 'loading' } | { status: 'ok'; usdPerBsv: number } | { status: 'unavailable' };

export const PRICE_LOADING = 'Price loading…';
export const PRICE_UNAVAILABLE = '($ price unavailable)';

/** A known price, or loading/unavailable. A rate of 0 / undefined is not a price. */
export const priceFrom = (usdPerBsv: number | undefined | null, settled: boolean): PriceState =>
  usdPerBsv && usdPerBsv > 0
    ? { status: 'ok', usdPerBsv }
    : settled
      ? { status: 'unavailable' }
      : { status: 'loading' };

/** "4¢" under a dollar (2 significant digits under a cent: "0.39¢"), "$1.23" from a dollar, "$12,345" from 10k. */
export const fmtDollars = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) return '0¢';
  if (usd < 1) {
    const cents = usd * 100;
    if (cents >= 1) return `${Math.round(cents)}¢`;
    if (cents < 0.0001) return '<0.0001¢';
    return `${Number(cents.toPrecision(2))}¢`;
  }
  if (usd >= 10_000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** "3,412 sats" (or "1.00000000 BSV" from a whole coin). */
export const fmtSatsSmall = (sats: number): string =>
  sats >= 1e8 ? `${(sats / 1e8).toFixed(8)} BSV` : `${sats.toLocaleString('en-US')} ${sats === 1 ? 'sat' : 'sats'}`;

export const satsToUsd = (sats: number, usdPerBsv: number) => (sats / 1e8) * usdPerBsv;

/** The two lines of an amount: `main` large, `sub` small and muted underneath. */
export const dollarsFirst = (sats: number, price: PriceState): { main: string; sub: string } => {
  if (price.status === 'ok') return { main: fmtDollars(satsToUsd(sats, price.usdPerBsv)), sub: fmtSatsSmall(sats) };
  if (price.status === 'loading') return { main: PRICE_LOADING, sub: fmtSatsSmall(sats) };
  return { main: fmtSatsSmall(sats), sub: PRICE_UNAVAILABLE };
};

/**
 * One-line form for buttons and sentences ("Pay 4¢"). Without a price it falls back to "3,412 sats": the sheet's
 * headline (dollarsFirst) is what says "Price loading…" or "($ price unavailable)".
 */
export const dollarsInline = (sats: number, price: PriceState): string =>
  price.status === 'ok' ? fmtDollars(satsToUsd(sats, price.usdPerBsv)) : fmtSatsSmall(sats);
