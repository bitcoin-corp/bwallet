/**
 * "Let this one call through" answers (pinned-site mints, stream passes). The permission manager stores every
 * non-spending grant it is given and ignores `ephemeral`, with expiry 0 meaning never (b-Aware 25 Oct 2026), so a
 * one-call answer became a permanent grant. Give it an expiry just long enough for the call in flight.
 */
export const ONE_SHOT_SECONDS = 60;

/** Expiry in UNIX seconds (the manager's unit) for a grant meant to cover only the call in flight. */
export const oneShotExpiry = (now = Date.now()) => Math.floor(now / 1000) + ONE_SHOT_SECONDS;

/** grantPermission arguments for a one-call answer. */
export const oneShotGrant = (requestID: string, now = Date.now()) => ({
  requestID,
  ephemeral: true,
  expiry: oneShotExpiry(now),
});
