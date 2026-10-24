import bundled from './blocklist.json';

/**
 * Market safety filter: ALWAYS ON, with no setting to turn it off (Apple App
 * Review 1.1.4 / Google Play sexual-content policy). Anything it matches is
 * removed from the Market; in Wallet › NFTs (the user's own items) matches
 * are blurred behind a tap-to-reveal instead of hidden.
 *
 * Sources, merged as a union (a remote list can only ADD blocks):
 *   1. ./blocklist.json (bundled)
 *   2. a remote JSON list of the same shape, if built with
 *      BWALLET_MARKET_BLOCKLIST_URL=https://… (vite.config.mobile.ts; empty
 *      default = bundled only). Cached for 1h.
 *   3. the user's local hidden list (Report button).
 * Report also POSTs to BWALLET_MARKET_REPORT_URL (default: bit-sign /api/bitsign/report; empty = local only).
 *
 * Keyword decisions (see safety.test.ts): matching is whole-word and
 * case-insensitive, so "Essex", "Sussex", "Middlesex", "adultery",
 * "pussycat", "cockpit" and "Dickens" are NOT matched; "sex", "Adult art",
 * "18+" and "NSFW" are. A few unambiguous terms ("substrings") also match
 * inside other words ("myNSFWdrop", "pornstar").
 */
declare const __MARKET_BLOCKLIST_URL__: string;
declare const __MARKET_REPORT_URL__: string;

export type Blocklist = {
  collections: string[];
  origins: string[];
  outpoints: string[];
  tokens: string[];
  keywords: string[];
  substrings: string[];
  allowCollections: string[];
};

const KEYS: (keyof Blocklist)[] = [
  'collections',
  'origins',
  'outpoints',
  'tokens',
  'keywords',
  'substrings',
  'allowCollections',
];
const ID_KEYS: (keyof Blocklist)[] = ['collections', 'origins', 'outpoints', 'tokens', 'allowCollections'];

const normId = (s: string) => s.trim().toLowerCase().replace('.', '_');

/** Accept any JSON; keep only string arrays of the known keys. */
export function normalizeBlocklist(raw: unknown): Blocklist {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as Blocklist;
  for (const k of KEYS) {
    const v = Array.isArray(r[k])
      ? (r[k] as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim())
      : [];
    out[k] = ID_KEYS.includes(k) ? v.map(normId) : v.map((x) => x.trim().toLowerCase());
  }
  return out;
}

export function mergeBlocklists(...lists: Blocklist[]): Blocklist {
  const out = {} as Blocklist;
  for (const k of KEYS) out[k] = [...new Set(lists.flatMap((l) => l[k]))];
  return out;
}

export const BUNDLED: Blocklist = normalizeBlocklist(bundled);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cyrillic/Greek letters that look like Latin ones. Used only for matching, never for display.
const CONFUSABLES: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  һ: 'h',
  ү: 'y',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  μ: 'u',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
  ς: 's',
  ϲ: 'c',
  ϳ: 'j',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

/**
 * Fold text for keyword matching: NFKC (fullwidth → ASCII), drop invisible
 * format characters (zero-width, joiners, BOM, soft hyphen, variation
 * selectors) and combining marks, lowercase, then map Cyrillic/Greek
 * lookalikes to Latin. Only the folded copy is matched; the original is shown.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
    .normalize('NFC');
}

/** Whole-word, case-insensitive match. "Word" edges are letters/digits, so "18+" and "r-18" work too. */
export function compileKeywords(keywords: string[], substrings: string[] = []): RegExp | null {
  const parts = [...keywords.map((k) => `(?<![a-z0-9])${escape(k)}(?![a-z0-9])`), ...substrings.map((k) => escape(k))];
  return parts.length ? new RegExp(parts.join('|'), 'i') : null;
}

const TRUE = new Set(['true', '1', 'yes', 'y']);
const ADULT_RATINGS = new Set(['adult', 'explicit', 'nsfw', 'x', 'xxx', 'r18', 'r-18', '18+', 'mature', 'porn']);

const MAX_DEPTH = 10;
const MAX_NODES = 500;

/** A string that is itself a JSON object or array (MAP values often are), parsed; otherwise null. */
const parseJsonish = (s: string): unknown => {
  const t = s.trim();
  if (t.length < 2 || t.length > 20_000 || !/^[[{]/.test(t)) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/**
 * Every object reachable in inscription metadata, nested objects/arrays and JSON-in-string values included,
 * to MAX_DEPTH levels and at most MAX_NODES nodes (b-Aware report: nesting deeper than the old walk hid terms).
 */
const walkMap = (map: unknown, onObject: (o: Record<string, unknown>) => void, onString: (s: string) => void): void => {
  let nodes = 0;
  const walk = (v: unknown, depth: number, fromJson: boolean) => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) return;
    if (typeof v === 'string') {
      onString(v);
      if (!fromJson) {
        const parsed = parseJsonish(v);
        if (parsed && typeof parsed === 'object') walk(parsed, depth + 1, true);
      }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1, fromJson));
    else if (v && typeof v === 'object') {
      onObject(v as Record<string, unknown>);
      Object.values(v).forEach((x) => walk(x, depth + 1, fromJson));
    }
  };
  walk(map, 0, false);
};

const objectFlagsAdult = (m: Record<string, unknown>): boolean => {
  for (const [k, v] of Object.entries(m)) {
    const key = k.toLowerCase();
    const val =
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v).trim().toLowerCase() : '';
    if (
      ['nsfw', 'adult', 'explicit', 'mature', 'isnsfw', 'is_nsfw', 'isadult'].includes(key) &&
      (v === true || TRUE.has(val))
    )
      return true;
    if (
      ['rating', 'contentrating', 'content_rating', 'agerating', 'age_rating'].includes(key) &&
      ADULT_RATINGS.has(val)
    )
      return true;
  }
  return false;
};

/** Inscription metadata that declares itself adult at any nesting level: nsfw/adult/explicit flags or an adult rating. */
export function metadataFlagsAdult(map: Record<string, unknown> | undefined | null): boolean {
  if (!map) return false;
  let flagged = false;
  walkMap(
    map,
    (o) => void (flagged ||= objectFlagsAdult(o)),
    () => undefined,
  );
  return flagged;
}

/** Everything the filter can look at for one listing / item. */
export type SafetySubject = {
  /** outpoint, origin, collection id, token id — any that apply. */
  ids?: (string | null | undefined)[];
  collectionId?: string | null;
  /** names, descriptions, collection name, symbol… */
  texts?: (string | null | undefined)[];
  map?: Record<string, unknown> | null;
};

// Each string is matched on its own: joining fields would match words formed across field boundaries.
const mapTexts = (map: Record<string, unknown> | null | undefined): string[] => {
  if (!map) return [];
  const out: string[] = [];
  walkMap(
    map,
    () => undefined,
    (s) => void out.push(s),
  );
  return out;
};

export type Verdict = { blocked: boolean; reason?: 'id' | 'hidden' | 'keyword' | 'metadata' };

export class SafetyFilter {
  private ids: Set<string>;
  private allow: Set<string>;
  private re: RegExp | null;
  constructor(
    list: Blocklist,
    private hidden: Set<string> = new Set(),
  ) {
    this.ids = new Set([...list.collections, ...list.origins, ...list.outpoints, ...list.tokens]);
    this.allow = new Set(list.allowCollections);
    this.re = compileKeywords(list.keywords, list.substrings);
  }

  matchesText(text: string): boolean {
    return !!this.re && this.re.test(normalizeForMatch(text));
  }

  check(s: SafetySubject): Verdict {
    const ids = [...(s.ids ?? []), s.collectionId].filter((x): x is string => !!x).map(normId);
    if (ids.some((id) => this.hidden.has(id))) return { blocked: true, reason: 'hidden' };
    if (ids.some((id) => this.ids.has(id))) return { blocked: true, reason: 'id' };
    if (metadataFlagsAdult(s.map)) return { blocked: true, reason: 'metadata' };
    const texts = [...(s.texts ?? []).filter((t): t is string => !!t), ...mapTexts(s.map)];
    if (texts.some((t) => this.matchesText(t))) return { blocked: true, reason: 'keyword' };
    return { blocked: false };
  }

  /** Thumbnails show unblurred only for allow-listed collections; everything else waits for "Show". */
  isAllowlisted(collectionId: string | null | undefined): boolean {
    return !!collectionId && this.allow.has(normId(collectionId));
  }
}

// ── runtime: remote list, local hidden list, reports ─────────────────────────
const REMOTE_URL = typeof __MARKET_BLOCKLIST_URL__ === 'string' ? __MARKET_BLOCKLIST_URL__.trim() : '';
const REPORT_URL = typeof __MARKET_REPORT_URL__ === 'string' ? __MARKET_REPORT_URL__.trim() : '';
const REMOTE_TTL = 60 * 60_000;
const LS_REMOTE = 'bwallet.market.remoteBlocklist';
const LS_HIDDEN = 'bwallet.market.hidden';

const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // storage unavailable: in-memory only
  }
};

let remote: { list: Blocklist; at: number } | null = null;

/** The remote list (cached 1h; last good copy is kept if a refresh fails). Empty when no URL is configured. */
export async function remoteBlocklist(url = REMOTE_URL, now = Date.now()): Promise<Blocklist> {
  const empty = normalizeBlocklist({});
  if (!url) return empty;
  if (!remote) {
    try {
      const saved = JSON.parse(lsGet(LS_REMOTE) ?? 'null') as { list: unknown; at: number } | null;
      if (saved) remote = { list: normalizeBlocklist(saved.list), at: saved.at };
    } catch {
      // ignore
    }
  }
  if (remote && now - remote.at < REMOTE_TTL) return remote.list;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: 'no-store' });
    if (res.ok) {
      remote = { list: normalizeBlocklist(await res.json()), at: now };
      lsSet(LS_REMOTE, JSON.stringify(remote));
    }
  } catch {
    // offline: keep last good copy
  }
  return remote?.list ?? empty;
}

export const hiddenIds = (): Set<string> => {
  try {
    const v = JSON.parse(lsGet(LS_HIDDEN) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(normId) : []);
  } catch {
    return new Set();
  }
};

let current = new SafetyFilter(BUNDLED, hiddenIds());
const listeners = new Set<() => void>();

/** Synchronous filter (bundled + hidden list, plus the remote list once loaded). */
export const safety = () => current;

/** Load the remote list (if configured) and rebuild the filter. */
export async function refreshSafety(): Promise<SafetyFilter> {
  const r = await remoteBlocklist();
  current = new SafetyFilter(mergeBlocklists(BUNDLED, r), hiddenIds());
  listeners.forEach((l) => l());
  return current;
}

export const onSafetyChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export type Report = {
  outpoint: string;
  origin?: string | null;
  collectionId?: string | null;
  name?: string | null;
  reason?: string;
};

/** Hide immediately on this device; also POST to the report endpoint when configured. */
export async function reportItem(r: Report, url = REPORT_URL): Promise<void> {
  const hidden = hiddenIds();
  hidden.add(normId(r.outpoint));
  if (r.origin) hidden.add(normId(r.origin));
  lsSet(LS_HIDDEN, JSON.stringify([...hidden]));
  void refreshSafety();
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...r, app: 'bwallet', at: new Date().toISOString() }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // best effort: it is already hidden locally
  }
}
