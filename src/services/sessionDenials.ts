/**
 * Fewer prompts before play (TokenBlaster Assault playtest, 25 Oct 2026: five sheets before the game started).
 *
 * 1. Basket read denials, remembered for the browser session. A site that lists a basket the user said No to
 *    (listOutputs on "ordinals", "ordnance"…) used to get a fresh sheet every time its window regained focus. Now
 *    the No stands, per site and per basket, until the browser session ends (chrome.storage.session). Nothing is
 *    stored for longer, and a No is never turned into a Yes: the site's call is refused without a sheet.
 * 2. The site's manifest on its first identity-key request. The grouped (manifest.json) sheet used to open only
 *    from waitForAuthentication, so a site connecting with getPublicKey({ identityKey: true }) got one sheet per
 *    basket, label and protocol instead. Now its first identity-key request in a session shows the manifest as ONE
 *    sheet (docs/ONE-SHEET-PERMISSIONS.md); the manager asks only for what the site does not already hold.
 *
 * Pure apart from the injected store, so it can be unit tested.
 */

export const SESSION_DENIALS_KEY = 'bwx.basketReadDenials';
const MAX_KEYS = 500;

export type SessionStore = {
  load(): Promise<string[]>;
  save(keys: string[]): Promise<void>;
};

/** The host a site is tracked under: lower case, no scheme, path or default port. */
const site = (originator: string): string =>
  originator
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:443$/, '')
    .toLowerCase();

const keyFor = (originator: string, basket: string) => `${site(originator)}\n${basket.trim().toLowerCase()}`;

/** Read-only basket access: a listOutputs, nothing inserted or removed. */
export const isBasketRead = (r: { type?: string; basket?: unknown; usageType?: unknown }): boolean =>
  r.type === 'basket' && typeof r.basket === 'string' && r.basket.trim() !== '' && r.usageType === 'listing';

export class SessionBasketDenials {
  private keys = new Set<string>();
  private loaded: Promise<void> | undefined;

  constructor(private readonly store?: SessionStore) {}

  private ready(): Promise<void> {
    this.loaded ??= (this.store?.load() ?? Promise.resolve([]))
      .then((ks) => {
        for (const k of ks) if (typeof k === 'string') this.keys.add(k);
      })
      .catch(() => undefined);
    return this.loaded;
  }

  async has(originator: string | undefined, basket: unknown): Promise<boolean> {
    if (!originator || typeof basket !== 'string') return false;
    await this.ready();
    return this.keys.has(keyFor(originator, basket));
  }

  async add(originator: string | undefined, basket: unknown): Promise<void> {
    if (!originator || typeof basket !== 'string' || !basket.trim()) return;
    await this.ready();
    this.keys.add(keyFor(originator, basket));
    const all = [...this.keys].slice(-MAX_KEYS);
    this.keys = new Set(all);
    await this.store?.save(all).catch(() => undefined);
  }

  /** "Forget site" or a grant in Settings: the site may ask again. */
  async forget(originator: string): Promise<void> {
    await this.ready();
    const prefix = `${site(originator)}\n`;
    for (const k of [...this.keys]) if (k.startsWith(prefix)) this.keys.delete(k);
    await this.store?.save([...this.keys]).catch(() => undefined);
  }
}

/** Whether a getPublicKey call should first show the site's manifest sheet. */
export const wantsManifestSheet = (
  params: { identityKey?: unknown } | undefined,
  originator: string | undefined,
  adminOriginator: string,
): originator is string => params?.identityKey === true && !!originator && originator !== adminOriginator;

/**
 * Shows a site's manifest sheet once per session. Calls that arrive while it is open wait for the same sheet; a
 * refusal is remembered for the session (the site's own requests still ask one by one, as they always did).
 */
export class ManifestOnce {
  private runs = new Map<string, Promise<void>>();

  run(originator: string, ask: () => Promise<unknown>): Promise<void> {
    const k = site(originator);
    let p = this.runs.get(k);
    if (!p) {
      p = ask().then(
        () => undefined,
        () => undefined,
      );
      this.runs.set(k, p);
    }
    return p;
  }

  /** The site's grants were removed (Forget site, Disconnect in Settings): its next connect may show it again. */
  forget(originator: string): void {
    this.runs.delete(site(originator));
  }
}
