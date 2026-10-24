/**
 * Default lifetime for a site's stored grants (payment-safety audit 24 Oct 2026, B1).
 *
 * The permissions manager treats expiry 0 as "never expires", and every sheet answered with no explicit expiry
 * used to store exactly that: one approval for a signing protocol stayed live for ever, so a relay set up once
 * never asked again. A grant answered without an expiry now lasts GRANT_DEFAULT_DAYS, then the site asks again.
 * An explicit future expiry (the one-hour "this visit" grant) is kept as it is.
 */
export const GRANT_DEFAULT_DAYS = 90;
const DEFAULT_SECONDS = GRANT_DEFAULT_DAYS * 24 * 3600;

/** Expiry (unix seconds) to store: the caller's when it is a positive number, else now + GRANT_DEFAULT_DAYS. */
export const withDefaultExpiry = (expiry: number | undefined | null, nowMs = Date.now()): number =>
  typeof expiry === 'number' && Number.isFinite(expiry) && expiry > 0
    ? Math.floor(expiry)
    : Math.floor(nowMs / 1000) + DEFAULT_SECONDS;
