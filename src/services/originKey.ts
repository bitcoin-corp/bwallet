/**
 * The permission key ("originator") for a dApp origin (security review M3).
 *
 * Grants, "Don't ask again" trust and allowances are stored per originator. They used to be the bare host, so
 * http://site (open to anyone on the network path) shared everything https://site had been granted. Now:
 *
 * - https://host[:port]  → "host[:port]". This is the canonical key for the https origin (scheme implied). It is
 *   exactly the form existing grants were stored under, so https grants carry over with no migration and no
 *   re-minting of permission tokens.
 * - http://localhost, 127.0.0.0/8, [::1] → "host[:port]". Loopback cannot be intercepted on the network; kept for
 *   local development.
 * - any other http origin, or any other scheme → refused. Such a site can no longer reach the wallet, so any grant
 *   that was made from a plain-http page is never used again (that is the "drop http grants" half: stored grants
 *   only ever carried the host, so they can't be told apart; the http path to them is what is closed).
 */

export const INSECURE_ORIGIN_ERROR = 'bWalletX only works with secure (https) sites';

export const isLoopbackHostname = (hostname: string): boolean => {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h === '::1') return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
};

export type OriginatorResult = { originator: string; error?: undefined } | { originator?: undefined; error: string };

/** The originator for a page origin or URL, or why it may not use the wallet. */
export const originatorForOrigin = (origin: string | undefined | null): OriginatorResult => {
  if (!origin) return { error: 'Missing origin' };
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { error: 'Invalid origin' };
  }
  if (!url.host) return { error: 'Invalid origin' };
  if (url.protocol === 'https:') return { originator: url.host };
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return { originator: url.host };
  return { error: INSECURE_ORIGIN_ERROR };
};

/**
 * Phone pairing (security audit 19 Oct 2026, H1): the site's origin on a paired session comes from the relay, which
 * reads the WebSocket Origin header. Any non-browser client can set that header, so it is a hint, not proof. Paired
 * sessions therefore run under their own permission key, "<host>.paired.invalid" (.invalid can never resolve, so no
 * real site can hold it), and never inherit the site's saved grants, monthly allowance or "Don't ask again".
 * See docs/PAIRING-ORIGIN-PROOF.md for how a site could later prove its origin.
 *
 * The key also names the pairing's own relay channel, "<host>.c<channel hex>.paired.invalid" (b-Aware report,
 * 24 Oct 2026): keyed by host alone, a second pairing that merely claimed the same origin (a forged QR, any Origin
 * header) shared the live pairing's grants and allowance, and signed with no sheet. Now every pairing starts empty
 * and whatever it is granted stays with that one channel.
 */
export const PAIRED_SUFFIX = '.paired.invalid';
/** Before 24 Oct 2026 the paired key had no channel label; kept to sweep grants stored under it. */
export const legacyPairedOrigin = (origin: string): string => {
  const u = new URL(origin);
  return `https://${u.hostname}${PAIRED_SUFFIX}${u.port ? `:${u.port}` : ''}`;
};
/**
 * DNS label for a 22-char base64url relay channel id: "c" + the hex of its characters (45 chars, under the 63 limit).
 * The characters, not the decoded bytes: the last base64url char has padding bits, so two channel ids the relay
 * treats as different could decode to the same bytes.
 */
export const channelLabel = (channel: string): string => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(channel)) throw new Error('Bad pairing channel');
  let hex = '';
  for (let i = 0; i < channel.length; i++) hex += channel.charCodeAt(i).toString(16).padStart(2, '0');
  return `c${hex}`;
};
export const pairedOrigin = (origin: string, channel: string): string => {
  const u = new URL(origin);
  return `https://${u.hostname}.${channelLabel(channel)}${PAIRED_SUFFIX}${u.port ? `:${u.port}` : ''}`;
};
export const isPairedHost = (host: string) => host.toLowerCase().replace(/\.$/, '').endsWith(PAIRED_SUFFIX);
