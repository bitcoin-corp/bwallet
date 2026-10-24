import { toToken, toTokenSat } from 'satoshi-token';
import { formatFiat } from './displayCurrency';

/**
 * BSV-21 allows at most 18 decimals. `dec` comes from a token's inscription (any sender can mint one), and a huge
 * value makes the decimal formatter pad millions of digits on every render (b-Aware report, 24 Oct 2026), so
 * anything outside 0..18 is shown as the raw amount.
 */
export const MAX_TOKEN_DECIMALS = 18;
export const validDecimals = (dec: number): boolean => Number.isInteger(dec) && dec >= 0 && dec <= MAX_TOKEN_DECIMALS;

export function showAmount(amt: bigint, dec: number): string {
  if (!validDecimals(dec)) {
    return amt.toString();
  }
  return toToken(amt.toString(), dec, 'string');
}

export function normalize(amt: string, dec: number): string {
  if (!validDecimals(dec)) {
    return amt.split('.')[0];
  }
  return toTokenSat(amt, dec, 'string');
}

/** A US-dollar amount in the display currency (Settings › Currency): "$12.34" or "£9.12". */
export const formatUSD = (value: number): string => formatFiat(value);

export const truncate = (str: string, startLength: number, endLength: number) => {
  if (typeof str !== 'string') {
    throw new Error('Expected a string');
  }
  if (str.length <= startLength + endLength) {
    return str; // No need to truncate
  }
  const startStr = str.substring(0, startLength);
  const endStr = str.substring(str.length - endLength);
  return `${startStr}...${endStr}`;
};

export const formatNumberWithCommasAndDecimals = (number: number, decimalPlaces = 2): string => {
  if (isNaN(number)) {
    return 'Invalid Number';
  }

  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  };

  return number.toLocaleString(undefined, options);
};

/** Balance display: up to `decimalPlaces` decimals, trailing zeros dropped (238,095 not 238,095.00000000). */
export const formatLargeNumber = (number: number, decimalPlaces = 3): string => {
  if (isNaN(number)) {
    return 'Invalid Number';
  }

  if (number >= 1e9) {
    return `${removeTrailingZeros((number / 1e9).toFixed(decimalPlaces))} B`; // Billion
  } else if (number >= 1e6) {
    return `${removeTrailingZeros((number / 1e6).toFixed(decimalPlaces))} M`; // Million
  }

  // For numbers below 1 million, use the existing formatting function
  return removeTrailingZeros(formatNumberWithCommasAndDecimals(number, decimalPlaces));
};

export const convertToTokenValue = (balance: number, decimals: number): number => {
  return balance / Math.pow(10, decimals);
};

export const removeTrailingZeros = (numStr: string): string => {
  if (numStr.includes('.')) {
    return numStr.replace(/(\.\d*?[1-9])0+$|\.0*$/, '$1');
  }

  return numStr;
};

export const convertAtomicValueToReadableTokenValue = (value: number, decimals: number): string => {
  const tokenValue = convertToTokenValue(value, decimals);
  return removeTrailingZeros(formatNumberWithCommasAndDecimals(tokenValue, decimals));
};

/**
 * Get the value for a tag prefix from a tags array.
 * Tags are in format "prefix:value", e.g., "origin:abc123_0"
 * For 'type' prefix, prefers the most specific tag (one containing '/').
 */
export const getTagValue = (tags: string[] | undefined, prefix: string): string | undefined => {
  if (!tags) return undefined;
  const matchingTags = tags.filter((t) => t.startsWith(`${prefix}:`));
  if (matchingTags.length === 0) return undefined;
  // For 'type' prefix, prefer the most specific one (contains '/')
  if (prefix === 'type') {
    const specific = matchingTags.find((t) => t.includes('/'));
    if (specific) return specific.slice(prefix.length + 1);
  }
  return matchingTags[0].slice(prefix.length + 1);
};

export const getOutputName = (
  output: { customInstructions?: string; tags?: string[] },
  fallback = 'Unknown',
): string => {
  if (output.customInstructions) {
    try {
      const parsed = JSON.parse(output.customInstructions);
      if (parsed.name) return parsed.name;
    } catch {
      /* ignore */
    }
  }
  return getTagValue(output.tags, 'name') ?? fallback;
};

/**
 * Check if a tag prefix exists in a tags array.
 */
export const hasTag = (tags: string[] | undefined, prefix: string): boolean => {
  if (!tags) return false;
  return tags.some((t) => t.startsWith(`${prefix}:`));
};

/**
 * Resolve the origin outpoint for an output.
 * If the output has an `origin:<outpoint>` tag, returns that value.
 * If it has a bare `origin` tag (no colon), the output itself IS the origin —
 * return the output's own outpoint.
 */
export const resolveOriginOutpoint = (output: { outpoint: string; tags?: string[] }): string | undefined => {
  const tagged = getTagValue(output.tags, 'origin');
  if (tagged) return tagged;
  if (output.tags?.includes('origin')) return output.outpoint;
  return undefined;
};
