import { Capacitor } from '@capacitor/core';
import { returnTarget, returnUrlFor, type ReturnPlan, type ReturnPlatform } from '../../pair/returnTo';
import { YoursNative } from '../native';

/** Which opener this shell uses: the phone apps by OS; the web wallet (and anything else) opens the https URL. */
export const returnPlatform = (): ReturnPlatform => {
  const p = Capacitor.getPlatform();
  return p === 'ios' || p === 'android' ? p : 'web';
};

/** The URL that sends the user back for a claimed plan (fragment `#bwx=ok&rid=…`), for this shell. */
export const returnHref = (plan: NonNullable<ReturnPlan>, platform = returnPlatform()) =>
  returnUrlFor(returnTarget(plan.ret, plan.rid), plan.b, platform);

/**
 * Send the user back to the site. Android hands intent:// URLs to the native opener (a WebView can't start them);
 * iOS and the web wallet open the URL as a new window, which leaves this app (the system opens Safari / Chrome) or,
 * in the web wallet, opens the site in a new tab so this wallet tab stays alive for the site's requests.
 */
export async function openReturn(plan: NonNullable<ReturnPlan>): Promise<void> {
  const platform = returnPlatform();
  const href = returnHref(plan, platform);
  if (platform === 'android' && href.startsWith('intent://') && YoursNative.openIntentUri) {
    try {
      await YoursNative.openIntentUri({ uri: href });
      return;
    } catch {
      /* fall back to the plain https URL */
    }
    window.open(returnTarget(plan.ret, plan.rid), '_blank', 'noopener');
    return;
  }
  window.open(href, '_blank', 'noopener');
}
