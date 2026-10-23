/**
 * One standard answer when the user says no.
 *
 * A site must be able to tell "the user declined" (Not now / Deny on a sheet, or a request a remembered answer refuses)
 * from "the wallet failed". wallet-toolbox's WalletPermissionsManager already rejects a denied request with
 * `Error('Permission denied.')` and `code: 'ERR_PERMISSION_DENIED'`; we keep that name and that message (sites match
 * on it today) and carry the code, plus `status: 403` and `isError: true`, on every path that answers a site:
 * the extension background, the phone/web dApp bridge, bApp frames and paired sessions (docs/gitbook/concepts/permissions.md).
 */

export const USER_DENIED_CODE = 'ERR_PERMISSION_DENIED';
export const USER_DENIED_MESSAGE = 'Permission denied.';
export const USER_DENIED_STATUS = 403;

/** The fields every refusal carries, as sent to the site. */
export type UserDeniedFields = { code: typeof USER_DENIED_CODE; status: typeof USER_DENIED_STATUS };
export const USER_DENIED_FIELDS: UserDeniedFields = { code: USER_DENIED_CODE, status: USER_DENIED_STATUS };

/** Messages the toolbox and this wallet use for a refusal by the user. */
const DENIED_TEXT =
  /^(permission denied\.?|(grouped |counterparty )?permission denied by user|the user has denied the request for permission\.?)$/i;

/** A denial error, shaped like the toolbox's own. */
export function userDeniedError(message: string = USER_DENIED_MESSAGE): Error & UserDeniedFields & { isError: true } {
  return Object.assign(new Error(message), { ...USER_DENIED_FIELDS, isError: true as const });
}

/** True when the error (or its message) is the user's refusal, never a failure. */
export function isUserDenied(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === 'string') return DENIED_TEXT.test(err.trim());
  if (typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === USER_DENIED_CODE) return true;
    if (typeof e.message === 'string') return DENIED_TEXT.test(e.message.trim());
  }
  return false;
}

/**
 * A `{ success: false, error }` reply with the denial code added when the error is a refusal. The message stays
 * the toolbox's "Permission denied." so older sites that match on text keep working.
 */
export function withDenialCode<R>(response: R): R {
  const r = response as { success?: unknown; error?: unknown; code?: unknown } | null | undefined;
  if (!r || typeof r !== 'object' || r.success !== false || !isUserDenied(r.error)) return response;
  return { ...r, error: USER_DENIED_MESSAGE, ...USER_DENIED_FIELDS } as R;
}

/** The Error a page-side transport rejects with for a `{ success: false, error, code? }` reply. */
export function replyError(detail: { error?: unknown; code?: unknown; status?: unknown }): Error {
  if (detail.code === USER_DENIED_CODE || isUserDenied(detail.error)) return userDeniedError();
  const err = new Error(typeof detail.error === 'string' && detail.error ? detail.error : 'Unknown error');
  if (detail.code !== undefined) Object.assign(err, { code: detail.code });
  return err;
}
