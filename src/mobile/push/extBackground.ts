/**
 * bWalletX extension service worker: upstream's background (src/background.ts) plus Web Push for chat
 * (vite.config.background.ts uses this as the entry). The side panel subscribes through this worker's
 * registration (register.ts); here we show what push.bwalletx.com sends and open the room on a click.
 */
import '../../background';
import { routeFromData, routeToQuery, webNotification } from './logic';

// The DOM lib has no ServiceWorkerGlobalScope types; just what is used here.
type SwEvent = Event & { waitUntil(p: Promise<unknown>): void };
type PushEv = SwEvent & { data: { text(): string } | null };
type ClickEv = SwEvent & { notification: Notification };
type Win = { url: string; postMessage(m: unknown): void; focus?: () => Promise<unknown> };
const sw = self as unknown as {
  addEventListener(t: 'push', fn: (e: PushEv) => void): void;
  addEventListener(t: 'notificationclick', fn: (e: ClickEv) => void): void;
  registration: ServiceWorkerRegistration;
  clients: { matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<Win[]> };
};

sw.addEventListener('push', (event) => {
  const n = webNotification(event.data?.text());
  event.waitUntil(sw.registration.showNotification(n.title, { ...n.options, icon: 'icons/icon128.png' }));
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const r = routeFromData(event.notification.data as Record<string, unknown> | undefined);
  const query = r ? `?${routeToQuery(r)}` : '';
  event.waitUntil(
    (async () => {
      // A live meeting_invite also opens the bChatX room page in a tab (owner, 26 Oct 2026). openUrl is only ever a
      // https://www.bchatx.com/room/<TICKER> rebuilt by logic.ts meetingRoute, never the payload's own url.
      if (r?.openUrl) await chrome.tabs.create({ url: r.openUrl }).catch(() => undefined);
      const pages = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const panel = pages.find((c) => /\/index\.html/.test(new URL(c.url).pathname));
      if (panel) {
        if (query) panel.postMessage({ type: 'bwallet-push-route', query });
        await panel.focus?.().catch(() => undefined);
        return;
      }
      await chrome.tabs.create({ url: chrome.runtime.getURL(`index.html${query}`) });
    })(),
  );
});
