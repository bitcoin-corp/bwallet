import { Preferences } from '@capacitor/preferences';
import { YoursNative } from './native';
import type { HostOp, Sender, StorageArea, StorageChanges, ToEndpoint, ToHub } from './protocol';

/**
 * The hub plays the part of the browser: it routes runtime messages and ports
 * between extension pages and owns chrome.storage.
 *
 * - storage.local is persisted in native secure storage (iOS Keychain,
 *   this-device-only and excluded from backups; Android Keystore-wrapped
 *   prefs) so the encrypted keystore survives WebView storage eviction.
 * - storage.session on phones is mirrored to the WebView's sessionStorage: it
 *   survives a location.reload() (as chrome.storage.session survives a popup
 *   reload) and is gone when the app process dies.
 * - storage.session on web and Desktop is memory only (`persistSession: false`).
 *   A desktop browser writes sessionStorage to the profile on disk for session
 *   restore, and the session holds the unlock key, so nothing from it may land
 *   there. A reload asks for the one-tap unlock again; with auto-lock "Never"
 *   the wallet stays open for the life of the page.
 */

type Endpoint = { post: (json: string) => void; sender: Sender };

type PendingSend = {
  from: string;
  reqId: number;
  awaiting: Set<string>;
  done: boolean;
};

const LOCAL_PREFIX = 'chrome.storage.local:';
const SESSION_KEY = 'chrome.storage.session';
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const PORT_CLOSED = 'The message port closed before a response was received.';

export interface HubOptions {
  /** Mirror storage.session to sessionStorage so it survives a reload. Phones only; see the note above. */
  persistSession?: boolean;
}

/** Read the persisted session mirror, or drop it when this edition keeps the session in memory. */
export const initialSession = (persist: boolean, store: Pick<Storage, 'getItem' | 'removeItem'>) => {
  try {
    if (!persist) {
      // Older builds mirrored the session (unlock key included) here; remove it.
      store.removeItem(SESSION_KEY);
      return new Map<string, unknown>();
    }
    return new Map<string, unknown>(
      Object.entries(JSON.parse(store.getItem(SESSION_KEY) ?? '{}') as Record<string, unknown>),
    );
  } catch {
    return new Map<string, unknown>();
  }
};

export type HostHandler = (op: HostOp, args: unknown[]) => Promise<unknown>;

/**
 * Where storage.local is persisted. Keys arrive already prefixed (LOCAL_PREFIX) and values JSON-encoded.
 * - Phones (default): YoursNative secure storage, one item per key.
 * - Desktop (Tauri): one owner-only file in the app data dir, written atomically per batch (desktop/storage.ts).
 */
export interface LocalBackend {
  load(): Promise<Record<string, string>>;
  apply(sets: Record<string, string>, removes: string[]): Promise<void>;
}

/** Builds before 5.1.0-mobile.2 kept storage.local in Preferences; move it into secure storage. */
const migrateFromPreferences = async () => {
  const { keys } = await Preferences.keys();
  for (const key of keys) {
    if (!key.startsWith(LOCAL_PREFIX)) continue;
    const { value } = await Preferences.get({ key });
    if (value !== null) await YoursNative.secureSet({ key, value });
    await Preferences.remove({ key });
  }
};

export const nativeLocalBackend: LocalBackend = {
  async load() {
    await migrateFromPreferences();
    const out: Record<string, string> = {};
    const { keys } = await YoursNative.secureKeys();
    for (const key of keys) {
      if (!key.startsWith(LOCAL_PREFIX)) continue;
      const { value } = await YoursNative.secureGet({ key });
      if (value !== null) out[key] = value;
    }
    return out;
  },
  async apply(sets, removes) {
    await Promise.all([
      ...Object.entries(sets).map(([key, value]) => YoursNative.secureSet({ key, value })),
      ...removes.map((key) => YoursNative.secureRemove({ key })),
    ]);
  },
};

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export class Hub {
  private endpoints = new Map<string, Endpoint>();
  private pending = new Map<number, PendingSend>();
  private portOwners = new Map<string, string>();
  private nextHubReqId = 1;
  private local = new Map<string, unknown>();
  private session: Map<string, unknown>;
  private persistSession: boolean;
  private persistQueue: Promise<unknown> = Promise.resolve();
  private storageReady: Promise<void>;
  private backgroundReady: Promise<void>;
  private resolveBackgroundReady!: () => void;

  constructor(
    private host: HostHandler,
    private backend: LocalBackend = nativeLocalBackend,
    options: HubOptions = {},
  ) {
    this.persistSession = options.persistSession ?? true;
    this.session = initialSession(this.persistSession, sessionStorage);
    this.markUnlocked();
    this.storageReady = this.loadLocal();
    this.backgroundReady = new Promise((resolve) => (this.resolveBackgroundReady = resolve));
  }

  markBackgroundReady() {
    this.resolveBackgroundReady();
  }

  register(id: string, endpoint: Endpoint) {
    this.endpoints.set(id, endpoint);
  }

  unregister(id: string) {
    if (!this.endpoints.delete(id)) return;
    for (const [hubReqId, pending] of this.pending) {
      if (pending.awaiting.delete(id)) this.settleIfExhausted(hubReqId, pending);
    }
    for (const [portId, owner] of this.portOwners) {
      if (owner === id) {
        this.portOwners.delete(portId);
        this.broadcast({ t: 'portDisconnect', portId }, id);
      }
    }
  }

  /** Broadcast to every endpoint except `except`. */
  broadcast(msg: ToEndpoint, except?: string) {
    const json = JSON.stringify(msg);
    for (const [id, endpoint] of this.endpoints) {
      if (id !== except) endpoint.post(json);
    }
  }

  handle = async (from: string, msg: ToHub) => {
    switch (msg.t) {
      case 'send':
        // In Chrome a message wakes the service worker; here we hold it until
        // the background has registered its listeners.
        await this.backgroundReady;
        return this.routeSend(from, msg.reqId, msg.message);
      case 'deliverResult':
        return this.onDeliverResult(from, msg);
      case 'lateResponse': {
        const pending = this.pending.get(msg.hubReqId);
        if (pending && !pending.done) this.finish(msg.hubReqId, pending, { response: msg.response });
        return;
      }
      case 'storage':
        return this.onStorage(from, msg);
      case 'connect':
        this.portOwners.set(msg.portId, from);
        await this.backgroundReady;
        return this.broadcast(
          { t: 'connect', portId: msg.portId, name: msg.name, sender: this.endpoints.get(from)!.sender },
          from,
        );
      case 'portPost':
        return this.broadcast({ t: 'portPost', portId: msg.portId, msg: msg.msg }, from);
      case 'portDisconnect':
        this.portOwners.delete(msg.portId);
        return this.broadcast({ t: 'portDisconnect', portId: msg.portId }, from);
      case 'host':
        try {
          const result = await this.host(msg.op, msg.args);
          return this.send(from, { t: 'hostResult', reqId: msg.reqId, result });
        } catch (error) {
          return this.send(from, { t: 'hostResult', reqId: msg.reqId, error: String(error) });
        }
    }
  };

  private send(to: string, msg: ToEndpoint) {
    this.endpoints.get(to)?.post(JSON.stringify(msg));
  }

  private routeSend(from: string, reqId: number, message: unknown) {
    const sender = this.endpoints.get(from)?.sender;
    if (!sender) return;
    const targets = [...this.endpoints.keys()].filter((id) => id !== from);
    if (targets.length === 0) {
      return this.send(from, { t: 'reply', reqId, error: NO_RECEIVER });
    }
    const hubReqId = this.nextHubReqId++;
    this.pending.set(hubReqId, { from, reqId, awaiting: new Set(targets), done: false });
    const json = JSON.stringify({ t: 'deliver', hubReqId, message, sender } satisfies ToEndpoint);
    for (const id of targets) this.endpoints.get(id)?.post(json);
  }

  private onDeliverResult(from: string, msg: Extract<ToHub, { t: 'deliverResult' }>) {
    const pending = this.pending.get(msg.hubReqId);
    if (!pending || pending.done) return;
    if (msg.hasResponse) return this.finish(msg.hubReqId, pending, { response: msg.response });
    if (!msg.keepOpen) {
      pending.awaiting.delete(from);
      this.settleIfExhausted(msg.hubReqId, pending);
    }
  }

  private settleIfExhausted(hubReqId: number, pending: PendingSend) {
    if (!pending.done && pending.awaiting.size === 0) this.finish(hubReqId, pending, { error: PORT_CLOSED });
  }

  private finish(hubReqId: number, pending: PendingSend, result: { response?: unknown; error?: string }) {
    pending.done = true;
    this.pending.delete(hubReqId);
    this.send(pending.from, { t: 'reply', reqId: pending.reqId, ...result });
  }

  // STORAGE ****************************************************************

  private async loadLocal() {
    for (const [key, value] of Object.entries(await this.backend.load())) {
      if (key.startsWith(LOCAL_PREFIX)) this.local.set(key.slice(LOCAL_PREFIX.length), JSON.parse(value));
    }
  }

  private persist(ops: Array<[string, unknown]>) {
    const sets: Record<string, string> = {};
    const removes: string[] = [];
    for (const [key, value] of ops) {
      if (value === undefined) removes.push(LOCAL_PREFIX + key);
      else sets[LOCAL_PREFIX + key] = JSON.stringify(value);
    }
    this.persistQueue = this.persistQueue.then(() => this.backend.apply(sets, removes));
    return this.persistQueue;
  }

  private async onStorage(from: string, msg: Extract<ToHub, { t: 'storage' }>) {
    await this.storageReady;
    const store = msg.area === 'local' ? this.local : this.session;
    try {
      const { result, changes } = this.applyStorageOp(store, msg.op, msg.arg);
      if (msg.area === 'local' && changes) {
        await this.persist(Object.entries(changes).map(([key, change]) => [key, change.newValue]));
      } else if (changes) {
        if (this.persistSession) sessionStorage.setItem(SESSION_KEY, JSON.stringify(Object.fromEntries(this.session)));
        this.markUnlocked();
      }
      this.send(from, { t: 'storageResult', reqId: msg.reqId, result });
      // Chrome fires onChanged in every context, the writer included.
      if (changes && Object.keys(changes).length > 0) {
        this.broadcast({ t: 'storageChanged', area: msg.area as StorageArea, changes });
      }
    } catch (error) {
      this.send(from, { t: 'storageResult', reqId: msg.reqId, error: String(error) });
    }
  }

  /** A yes/no (never the key) for the web build check, which must not reload an unlocked page by itself. */
  private markUnlocked() {
    try {
      (globalThis as { __bwxUnlocked?: boolean }).__bwxUnlocked = this.session.has('passKey');
    } catch {
      /* not in a page */
    }
  }

  private applyStorageOp(
    store: Map<string, unknown>,
    op: 'get' | 'set' | 'remove' | 'clear',
    arg: unknown,
  ): { result?: unknown; changes?: StorageChanges } {
    if (op === 'get') {
      const out: Record<string, unknown> = {};
      if (arg === null || arg === undefined) {
        for (const [key, value] of store) out[key] = value;
      } else if (typeof arg === 'string' || Array.isArray(arg)) {
        for (const key of typeof arg === 'string' ? [arg] : (arg as string[])) {
          if (store.has(key)) out[key] = store.get(key);
        }
      } else {
        for (const [key, fallback] of Object.entries(arg as Record<string, unknown>)) {
          out[key] = store.has(key) ? store.get(key) : fallback;
        }
      }
      return { result: out };
    }

    const changes: StorageChanges = {};
    if (op === 'set') {
      for (const [key, raw] of Object.entries(clone(arg as Record<string, unknown>))) {
        const oldValue = store.get(key);
        if (raw === undefined) continue;
        if (JSON.stringify(oldValue) === JSON.stringify(raw)) continue;
        store.set(key, raw);
        changes[key] = oldValue === undefined ? { newValue: raw } : { oldValue, newValue: raw };
      }
    } else {
      const keys = op === 'clear' ? [...store.keys()] : typeof arg === 'string' ? [arg] : (arg as string[]);
      for (const key of keys) {
        if (!store.has(key)) continue;
        changes[key] = { oldValue: store.get(key) };
        store.delete(key);
      }
    }
    return { changes };
  }
}
