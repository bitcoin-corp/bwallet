/**
 * Push registration: one device row on push.bwalletx.com per install, owned by the bChat handle the
 * wallet is signed in with. Native (iOS / Android) uses @capacitor/push-notifications; the web wallet and
 * the extension use Web Push (service worker + VAPID). Pure rules live in logic.ts.
 *
 * - Native: on by default; registers when bChat signs in (the OS asks for permission once).
 * - Web / extension: off until the user turns it on in Settings › Notifications (the browser only asks
 *   from a user action).
 * - Sign out or switch account: the row is deleted (or, for a new handle, moved by the server's upsert).
 */
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { CHANNEL } from '../channel';
import { STORE_BUILD } from '../storeBuild';
import { IS_EXTENSION } from '../extension';
import { defaultHttp, type ChatSession, type Http } from '../chat/api';
import { isNative, YoursNative } from '../native';
import {
  deviceBody,
  PUSH_ORIGIN,
  routeFromData,
  type DeviceBody,
  type PushPlatform,
  type PushRoute,
  type RoomNotify,
  type ServerPrefs,
  type WebPushSubscriptionJson,
} from './logic';

// ── Server API ─────────────────────────────────────────────────────────────────────────────────

export class PushApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class PushApi {
  constructor(
    private readonly bearer: string,
    private readonly http: Http = defaultHttp(isNative),
    private readonly origin = PUSH_ORIGIN,
  ) {}
  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    let res;
    try {
      res = await this.http({
        method,
        url: `${this.origin}${path}`,
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.bearer}` },
        body,
      });
    } catch (e) {
      throw new PushApiError(e instanceof Error ? e.message : 'Network error', 0);
    }
    if (res.status < 200 || res.status >= 300) {
      const err = (res.data as { error?: unknown } | null)?.error;
      throw new PushApiError(typeof err === 'string' ? err : `Push server error ${res.status}`, res.status);
    }
    return res.data as T;
  }
  register = (b: DeviceBody) => this.call<{ id: string }>('POST', '/v1/devices', b);
  unregister = (id: string) => this.call<{ ok: boolean }>('DELETE', `/v1/devices/${encodeURIComponent(id)}`);
  prefs = () => this.call<ServerPrefs>('GET', '/v1/prefs');
  putPrefs = (p: ServerPrefs) => this.call<ServerPrefs>('PUT', '/v1/prefs', p);
  roomPrefs = () => this.call<{ rooms: Record<string, RoomNotify> }>('GET', '/v1/rooms/prefs');
  putRoomPref = (ticker: string, notify: RoomNotify) =>
    this.call<{ ticker: string; notify: RoomNotify }>(
      'PUT',
      `/v1/rooms/${encodeURIComponent(ticker.replace(/^\$/, ''))}/prefs`,
      { notify },
    );
}

export const vapidPublicKey = async (http: Http = defaultHttp(isNative)): Promise<string> => {
  const r = await http({ method: 'GET', url: `${PUSH_ORIGIN}/v1/webpush/vapid-public-key`, headers: {} });
  const key = (r.data as { key?: unknown } | null)?.key;
  if (r.status !== 200 || typeof key !== 'string') throw new PushApiError('Web Push is not available', r.status);
  return key;
};

// ── Local state ────────────────────────────────────────────────────────────────────────────────

export const PUSH_PLATFORM: PushPlatform = isNative
  ? Capacitor.getPlatform() === 'ios'
    ? 'ios'
    : 'android'
  : IS_EXTENSION
    ? 'extension'
    : 'web';
const IS_WEB_PUSH = PUSH_PLATFORM === 'web' || PUSH_PLATFORM === 'extension';

type State = {
  /** null = never chosen: on for native, off for web / extension. */
  enabled: boolean | null;
  /** The registered row, and whose bearer can delete it. */
  deviceId?: string;
  handle?: string;
  bearer?: string;
  /** Token / endpoint it was registered with, to skip repeat POSTs. */
  key?: string;
};
const KEY = 'bwallet.push';
const EVENT = 'bwallet:push-state';

const read = (): State => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    return s && typeof s === 'object' ? (s as State) : { enabled: null };
  } catch {
    return { enabled: null };
  }
};
const write = (s: State) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* storage unavailable */
  }
};
export const onPushState = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

export const pushEnabled = () => read().enabled ?? !IS_WEB_PUSH;
export const pushRegistered = () => !!read().deviceId;

// ── Tokens ─────────────────────────────────────────────────────────────────────────────────────

let nativeToken: Promise<string> | null = null;
let nativeListeners = false;

const routeListeners = new Set<(r: PushRoute) => void>();
let pendingRoute: PushRoute | null = null;
const deliverRoute = (r: PushRoute) => {
  if (routeListeners.size) routeListeners.forEach((fn) => fn(r));
  else pendingRoute = r;
};
/** Taps are held until the app (unlocked) listens; then delivered once. */
export const onPushRoute = (fn: (r: PushRoute) => void) => {
  routeListeners.add(fn);
  if (pendingRoute) {
    const r = pendingRoute;
    pendingRoute = null;
    fn(r);
  }
  return () => void routeListeners.delete(fn);
};
/** Web Push clicks open the page with ?push=… (logic.ts routeToQuery), or post to an open one. */
export const takeRouteFrom = (r: PushRoute | null) => r && deliverRoute(r);

/** Call once at startup (before unlock) so a tap that launched the app is not lost. */
export const initPushTaps = () => {
  if (!isNative || nativeListeners) return;
  nativeListeners = true;
  void PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
    const r = routeFromData(a.notification?.data as Record<string, unknown> | undefined);
    if (r) deliverRoute(r);
  });
  if (PUSH_PLATFORM === 'android')
    void PushNotifications.createChannel({
      id: 'chat',
      name: 'Chat',
      description: 'Messages, mentions and DMs',
      importance: 4,
      visibility: 0,
      lights: true,
      vibration: true,
    }).catch(() => undefined);
  // Meeting invites (owner, 26 Oct 2026): their own channel so they can be silenced apart from chat. The push
  // server (bwalletx-push deliver.ts) sends kind meeting_invite on this channel id.
  if (PUSH_PLATFORM === 'android')
    void PushNotifications.createChannel({
      id: 'meeting_invite',
      name: 'Meeting invites',
      description: 'Meeting invites and when a meeting starts',
      importance: 4,
      visibility: 0,
      lights: true,
      vibration: true,
    }).catch(() => undefined);
};

const getNativeToken = (): Promise<string> => {
  if (nativeToken) return nativeToken;
  nativeToken = new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('No push token from the system')), 20_000);
    void PushNotifications.addListener('registration', (t) => {
      window.clearTimeout(timer);
      resolve(t.value);
    });
    void PushNotifications.addListener('registrationError', (e) => {
      window.clearTimeout(timer);
      reject(new Error(e.error || 'Push registration failed'));
    });
    void PushNotifications.register().catch(reject);
  });
  nativeToken.catch(() => (nativeToken = null));
  return nativeToken;
};

/** Ask for permission (native: the OS prompt; web: must run inside a click). False if refused. */
export const askPermission = async (): Promise<boolean> => {
  if (isNative) {
    let { receive } = await PushNotifications.checkPermissions();
    if (receive === 'prompt' || receive === 'prompt-with-rationale')
      ({ receive } = await PushNotifications.requestPermissions());
    return receive === 'granted';
  }
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
};

const permissionGranted = async (): Promise<boolean> => {
  if (isNative) return (await PushNotifications.checkPermissions()).receive === 'granted';
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
};

const b64urlToBytes = (s: string) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Web wallet: /push-sw.js at the site root (vite.config.web.ts), so a deep page like /bapp/bchatx registers the same
 * worker. Extension: its background service worker. */
const swRegistration = async (): Promise<ServiceWorkerRegistration> => {
  if (PUSH_PLATFORM === 'extension') return navigator.serviceWorker.ready;
  return navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
};

const webSubscription = async (): Promise<WebPushSubscriptionJson> => {
  const reg = await swRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const key = await vapidPublicKey();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
  }
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error('Browser gave an incomplete subscription');
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } };
};

const nativeEnv = async () => {
  if (PUSH_PLATFORM !== 'ios') return null;
  try {
    return (await YoursNative.pushEnv()).env;
  } catch {
    return null;
  }
};
const nativeBundle = async () => {
  if (!isNative) return null;
  try {
    return (await App.getInfo()).id;
  } catch {
    return null;
  }
};

// ── Sync ───────────────────────────────────────────────────────────────────────────────────────

const removeRow = async (s: State) => {
  if (s.deviceId && s.bearer) await new PushApi(s.bearer).unregister(s.deviceId).catch(() => undefined);
  write({ enabled: s.enabled });
};

let syncing: Promise<void> = Promise.resolve();

/**
 * Make the server match: registered for `session` when push is on and permission is granted, else no
 * row. `ask` = also show the permission prompt (native sign-in, or a Settings tap on the web).
 */
export const syncPush = (session: ChatSession | null, opts: { ask?: boolean } = {}): Promise<void> => {
  syncing = syncing.then(() => doSync(session, opts)).catch(() => undefined);
  return syncing;
};

const doSync = async (session: ChatSession | null, { ask = false }: { ask?: boolean }) => {
  const s = read();
  const on = s.enabled ?? !IS_WEB_PUSH;
  if (!session || !on) return void (s.deviceId ? await removeRow(s) : undefined);
  if (s.deviceId && s.handle && s.handle !== session.handle) await removeRow(s);
  const granted = ask && (isNative || on) ? await askPermission() : await permissionGranted();
  if (!granted) return;
  const env = await nativeEnv();
  const bundleId = await nativeBundle();
  const body = IS_WEB_PUSH
    ? deviceBody({
        platform: PUSH_PLATFORM,
        channel: CHANNEL,
        store: STORE_BUILD,
        subscription: await webSubscription(),
      })
    : deviceBody({
        platform: PUSH_PLATFORM,
        channel: CHANNEL,
        store: STORE_BUILD,
        env,
        bundleId,
        token: await getNativeToken(),
      });
  const key = body.token ?? body.webPushSubscription?.endpoint ?? '';
  const cur = read();
  if (cur.deviceId && cur.handle === session.handle && cur.key === key && cur.bearer === session.token) return;
  const { id } = await new PushApi(session.token).register(body);
  write({ enabled: cur.enabled, deviceId: id, handle: session.handle, bearer: session.token, key });
};

/** Settings master switch. Turning it on from a tap may show the permission prompt. */
export const setPushEnabled = async (on: boolean, session: ChatSession | null): Promise<boolean> => {
  const s = read();
  write({ ...s, enabled: on });
  if (!on) {
    await syncPush(session);
    if (IS_WEB_PUSH)
      await swRegistration()
        .then((r) => r.pushManager.getSubscription())
        .then((sub) => sub?.unsubscribe())
        .catch(() => undefined);
    return false;
  }
  const granted = await askPermission();
  if (!granted) {
    write({ ...read(), enabled: false });
    return false;
  }
  await syncPush(session);
  return pushRegistered();
};
