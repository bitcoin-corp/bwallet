import { ONESAT_MAINNET_CONTENT_URL } from '@1sat/actions';
import { isUri } from '../../utils/uri';
import { PNEE_ICON, PNEE_TOKEN_ID } from '../notes/pnee';

/**
 * First-party tokens, pinned by EXACT token id (never by ticker: anyone can deploy another "PNEE").
 * Their deploy txs predate the signed issuer statement, so the chain check (issuerVerify) can't vouch
 * for them; the wallet itself does, because the id is compiled in. Only these ids get the official art.
 */
type Official = { icon: string; issuer: string };
const norm = (id: string) => id.trim().toLowerCase().replace('.', '_');
const OFFICIAL: Record<string, Official> = {
  [norm(PNEE_TOKEN_ID)]: { icon: PNEE_ICON, issuer: 'bWalletX' },
};

export const officialToken = (tokenId: string | null | undefined): Official | null =>
  tokenId ? (OFFICIAL[norm(tokenId)] ?? null) : null;

/**
 * Placeholder for a token with no icon: the symbol's first letter on a neutral grey disc with a small
 * amber warning mark. Never blank, never gold brand art (an unverified token must not look official).
 */
export const placeholderTokenIcon = (symbol: string | null | undefined): string => {
  const ch = (symbol || '?').replace(/^\$/, '').trim().charAt(0).toUpperCase() || '?';
  const safe = ch.replace(/[<>&"']/g, '?');
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
        '<circle cx="32" cy="32" r="32" fill="#4a4f57"/>' +
        `<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,sans-serif" font-size="30" font-weight="700" fill="#e4e6ea">${safe}</text>` +
        '<circle cx="50" cy="50" r="11" fill="#2b2f36"/>' +
        '<path d="M50 41.5 L58.5 56.5 H41.5 Z" fill="#e0a030"/>' +
        '<rect x="49" y="46" width="2" height="5.5" rx="1" fill="#2b2f36"/>' +
        '<circle cx="50" cy="54" r="1.2" fill="#2b2f36"/>' +
        '</svg>',
    )
  );
};

/** An on-chain icon field (outpoint or URL) as a URL, or '' if none. */
export const onchainIconUrl = (icon: string | null | undefined): string =>
  !icon ? '' : isUri(icon) ? icon : `${ONESAT_MAINNET_CONTENT_URL}/${icon}`;

/** The icon to show for a token: official art (exact id only), else its on-chain icon, else the placeholder. */
export const tokenIconUrl = (tokenId: string | null | undefined, symbol: string, icon: string | null | undefined) =>
  officialToken(tokenId)?.icon || onchainIconUrl(icon) || placeholderTokenIcon(symbol);
