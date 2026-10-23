/**
 * bWalletX extension's page-side wallet (MAIN world). vite.brand.ts swaps this in for src/cwi.ts.
 *
 * Upstream's createEventCWI sends every call as a `YoursRequest` page event, and the Yours extension
 * listens for the same event, so with both installed one request reached both wallets. bWalletX
 * instead:
 *  - sends its own `bWalletXRequest` event (only our content script listens: content.ts swap);
 *  - announces itself (brc100:announceWallet) so sites can offer it by name;
 *  - takes window.CWI by default, even over another wallet (owner, 4 Oct 2026: sites like foxespixel
 *    use window.CWI with no picker, so with Yours installed bWalletX was unreachable). Settings ›
 *    "Be the wallet websites connect to" off → hands window.CWI back to the other wallet. The content
 *    script tells the page the setting via the `bwalletx:cwi-pref` event;
 *  - answers legacy `YoursRequest` calls only while it holds window.CWI.
 */
import type { WalletInterface } from '@bsv/sdk';
import { createCWI, CWIEventName } from '@1sat/wallet-browser';
import icon from '../../assets/bwalletx-ext/icon128.png?inline';
import { announceWallet, claimWindowCwi } from './discovery';
import { replyError } from '../services/userDenied';

export { CWIEventName };

export const BWALLETX_REQUEST = 'bWalletXRequest';
const LEGACY_REQUEST = 'YoursRequest';

type Detail = { messageId: string; type: string; params: unknown };

const transport = (action: string, params: unknown) =>
  new Promise((resolve, reject) => {
    const messageId = `${action}-${Date.now()}-${Math.random()}`;
    self.addEventListener(
      messageId,
      (e) => {
        const detail = (e as CustomEvent<{ success: boolean; data?: unknown; error?: string; code?: unknown }>).detail;
        // A refusal by the user rejects with code ERR_PERMISSION_DENIED (services/userDenied.ts).
        if (detail.success) resolve(detail.data);
        else reject(replyError(detail));
      },
      { once: true },
    );
    self.dispatchEvent(new CustomEvent<Detail>(BWALLETX_REQUEST, { detail: { messageId, type: action, params } }));
  });

export const CWI: WalletInterface = createCWI(transport as Parameters<typeof createCWI>[0]);

if (typeof window !== 'undefined') {
  const w = window as unknown as { CWI?: WalletInterface };
  let take = true; // until the content script says otherwise
  let other: WalletInterface | undefined; // another wallet's window.CWI, kept to hand back
  const assert = () => {
    if (w.CWI && w.CWI !== CWI) other = w.CWI;
    if (take) w.CWI = CWI;
    else if (w.CWI === CWI && other) w.CWI = other;
  };
  claimWindowCwi(CWI);
  assert();
  // Another wallet may inject after us: check again shortly.
  for (const ms of [250, 1000, 3000]) setTimeout(assert, ms);
  self.addEventListener('bwalletx:cwi-pref', (e) => {
    take = (e as CustomEvent<{ take?: boolean }>).detail?.take !== false;
    assert();
  });
  // Legacy pages: answer upstream's event only while window.CWI is ours (checked per request, since
  // another wallet may inject after us).
  self.addEventListener(LEGACY_REQUEST, (e) => {
    if ((window as unknown as { CWI?: WalletInterface }).CWI !== CWI) return;
    self.dispatchEvent(new CustomEvent(BWALLETX_REQUEST, { detail: (e as CustomEvent<Detail>).detail }));
  });
  announceWallet({ name: 'bWalletX', icon, rdns: 'com.bwalletx.extension', kind: 'extension' }, CWI);
}
