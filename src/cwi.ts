/**
 * CWI (Chrome Wallet Interface) - BRC-100 WalletInterface implementation
 * Re-exports from @1sat/wallet-remote for browser page context
 */

import type { WalletInterface } from '@bsv/sdk';
import { createCWI, CWIEventName } from '@1sat/wallet-browser';
import { replyError } from './services/userDenied';
import { attachSpendingAuthorization } from './spendingAuthPage';
import { attachMintPrivate } from './mintPrivatePage';

// Re-export for backwards compatibility
export { CWIEventName };

/**
 * Upstream's CustomEvent transport (the 'YoursRequest' page event), but a refusal by the user rejects with the
 * standard denial error (code ERR_PERMISSION_DENIED, services/userDenied.ts) instead of a bare Error.
 */
const transport = (action: string, params: unknown) =>
  new Promise((resolve, reject) => {
    const messageId = `${action}-${Date.now()}-${Math.random()}`;
    self.addEventListener(
      messageId,
      (e) => {
        const detail = (e as CustomEvent<{ success: boolean; data?: unknown; error?: string; code?: unknown }>).detail;
        if (detail.success) resolve(detail.data);
        else reject(replyError(detail));
      },
      { once: true },
    );
    self.dispatchEvent(new CustomEvent('YoursRequest', { detail: { messageId, type: action, params } }));
  });

// Create the CWI instance for browser pages (uses CustomEvent pattern)
export const CWI: WalletInterface = createCWI(transport as Parameters<typeof createCWI>[0]);
// bWalletX extension: streaming spending grants (services/streamGrants.ts, docs/STREAMING-PERMISSIONS.md).
attachSpendingAuthorization(CWI as unknown as Record<string, unknown>);
// bWalletX: wallet.mintPrivate (services/mintPrivateSite.ts).
attachMintPrivate(CWI as unknown as Record<string, unknown>, transport);

// Inject CWI on window
if (typeof window !== 'undefined') {
  (window as unknown as { CWI: WalletInterface }).CWI = CWI;
}
