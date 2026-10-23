/**
 * Page side of streaming spending grants: methods added to window.CWI. They travel like CWI calls (the
 * YoursRequest CustomEvent → content script / in-app provider → background), and the wallet takes the
 * originator from the browser, so an `originator` argument from the page is ignored.
 */
import {
  SPENDING_AUTH_REQUEST,
  SPENDING_AUTH_REVOKE,
  SPENDING_AUTH_STATUS,
  SPENDING_AUTH_VERSION,
} from './services/streamGrants';

/** inject.ts CustomListenerName.YOURS_REQUEST (not imported: inject.ts imports cwi.ts). */
const YOURS_REQUEST = 'YoursRequest';

type Reply = { success: boolean; data?: unknown; error?: string };

let seq = 0;
const call = (type: string, params: unknown): Promise<Reply> =>
  new Promise((resolve) => {
    const messageId = `bwx-spend-auth-${Date.now()}-${++seq}`;
    self.addEventListener(
      messageId,
      (e) => resolve(((e as CustomEvent<Reply>).detail ?? { success: false }) as Reply),
      {
        once: true,
      },
    );
    self.dispatchEvent(new CustomEvent(YOURS_REQUEST, { detail: { type, messageId, params } }));
  });

export const attachSpendingAuthorization = (target: Record<string, unknown>) => {
  target.spendingAuthorizationVersion = SPENDING_AUTH_VERSION;
  /** Resolves { granted: true, grantId, capSatsPerHour, expiry, protocolID } or { granted: false } when declined. */
  target.requestSpendingAuthorization = async (args: unknown) => {
    const r = await call(SPENDING_AUTH_REQUEST, args);
    if (r.success) return { granted: true, ...(r.data as object) };
    if (r.error === 'Declined') return { granted: false };
    throw new Error(r.error || 'Spending authorization failed');
  };
  target.revokeSpendingAuthorization = async (args: unknown) => {
    const grantId = typeof args === 'string' ? args : (args as { grantId?: string } | undefined)?.grantId;
    const r = await call(SPENDING_AUTH_REVOKE, { grantId });
    if (!r.success) throw new Error(r.error || 'Revoke failed');
    return r.data;
  };
  target.getSpendingAuthorizations = async () => {
    const r = await call(SPENDING_AUTH_STATUS, {});
    if (!r.success) throw new Error(r.error || 'Status failed');
    return r.data;
  };
};
