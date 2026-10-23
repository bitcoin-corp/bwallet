/**
 * CWI (Chrome Wallet Interface) - BRC-100 WalletInterface implementation
 * Re-exports from @1sat/wallet-remote for browser page context
 */

import type { WalletInterface } from '@bsv/sdk';
import { createEventCWI, CWIEventName } from '@1sat/wallet-browser';
import { attachSpendingAuthorization } from './spendingAuthPage';

// Re-export for backwards compatibility
export { CWIEventName };

// Create the CWI instance for browser pages (uses CustomEvent pattern)
export const CWI = createEventCWI();
// bWalletX extension: streaming spending grants (services/streamGrants.ts, docs/STREAMING-PERMISSIONS.md).
attachSpendingAuthorization(CWI as unknown as Record<string, unknown>);

// Inject CWI on window
if (typeof window !== 'undefined') {
  (window as unknown as { CWI: WalletInterface }).CWI = CWI;
}
