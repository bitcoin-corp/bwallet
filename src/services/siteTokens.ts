/**
 * Site tokens: how an outside site delivers BSV-21 tokens a user buys into the wallet's own token view, and lets the
 * user sell them, without ever deriving or signing with the wallet's token keys (TokenBlaster BlastPad, 25 Oct 2026:
 * 'This protocol is reserved for bWalletX itself: "onesat"'). Site developers: docs/SITE-TOKENS.md.
 *
 * The holes the reservations close stay closed (reservedProtocols.ts, reservedBaskets.ts, b-Aware reports):
 *  - [0,'onesat'] stays reserved on every method. A site never learns a token key it did not ask the wallet for,
 *    and never gets a signature with one.
 *  - 'bsv21' stays reserved for listOutputs and relinquishOutput, and no basket grant for it is ever stored.
 *
 * What this adds, for outside originators only:
 *  1. Receive key. getPublicKey({ protocolID: SITE_TOKEN_RECEIVE, keyID: <tokenId>, counterparty: 'self' }) answers
 *     a FRESH token key the wallet picks itself: [0,'onesat'] with keyID `${tokenId}-${ms}`, exactly the key the
 *     wallet's own trades use (launchpad/client.ts freshTokenKey), so the coin is a normal wallet coin (token view,
 *     Send, seed recovery scan). The answer carries { publicKey, keyID }. The site cannot choose the keyID, so it
 *     cannot derive any key the wallet already uses, and two sites never get the same key. No sheet: a public key
 *     the wallet minted for this request reveals nothing else.
 *  2. Delivery. A createAction / internalizeAction output into basket 'bsv21' is accepted only when it is exactly a
 *     BSV-21 transfer of 1 sat to the P2PKH address of a key from (1) (or a keyID of that same shape that derives the
 *     address). The wallet writes the record itself (customInstructions, tags): whatever the site sent there is
 *     thrown away, so a site cannot relabel a coin (fake symbol/icon/amount) or point its record at another key.
 *  3. Selling. A site's createAction may spend the wallet's own token coins by outpoint. The wallet shows one sheet
 *     listing the tokens that leave and where every output goes; on Allow it signs those inputs itself at
 *     signAction (spends for them from the site are refused). The site never gets a token signature.
 *  4. The receive protocol is for getPublicKey only: createSignature, encrypt, HMAC, linkage with it are refused.
 *  5. Seeing one token. listOutputs({ basket: 'bsv21', tags: ['bsv21:<tokenId>'] }) answers, after one sheet per site
 *     per token (remembered), only { outpoint, satoshis, amount } of the wallet's own coins of THAT token: no
 *     scripts, no records, no keys, no other token. So a site can sell coins it did not deliver (bought in the
 *     wallet's Exchange, in another browser, before site tokens). Any other listing of 'bsv21' stays refused.
 *  6. Deploying a token / inscribing its icon. getPublicKey with keyID 'deploy' (SITE_TOKEN_RECEIVE) or 'ordinal'
 *     (SITE_ORDINAL_RECEIVE) answers a fresh wallet key `deploy-<ms>` / `ordinal-<ms>` the same way as (1). A BSV-21
 *     deploy+mint to a deploy key is taken into 'bsv21' by internalizeAction (its token id is its own outpoint, so
 *     the tx must be signed first); an image inscription to an ordinal key is taken into '1sat'. Both scripts must
 *     rebuild byte for byte, and the wallet writes the record.
 */
import { OP, P2PKH, PublicKey, Script, Transaction, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import type { PromptRequest } from '@1sat/permission-module';
import { ONESAT, bsv21, tokenOutputTags, tokenSpends } from '../mobile/market/launchpad/tokens';
import { randomIdTag } from './tokenSendHeal';

/** The receive-key request protocol (a name only: the key answered is a wallet token key, see above). */
export const SITE_TOKEN_RECEIVE: WalletProtocol = [1, 'bwalletx token receive'];
/** The ordinal (token icon) receive-key request protocol: keyID 'ordinal'. */
export const SITE_ORDINAL_RECEIVE: WalletProtocol = [1, 'bwalletx ordinal receive'];
export const TOKEN_BASKET = 'bsv21';
export const ORDINAL_BASKET = '1sat';
const TOKEN_BASKETS = new Set(['bsv21', 'p 1sat bsv21']);

export const RECEIVE_ONLY_REFUSAL = 'bwalletx token receive is for getPublicKey only';
export const BAD_DELIVERY_REFUSAL = 'bWalletX takes a token into your wallet only to a receive key it gave this site';
export const SITE_SPENDS_REFUSAL = 'bWalletX signs its own token inputs; a site may not supply them';
export const SELL_REJECTED = 'You said no: nothing was signed';
export const LIST_REJECTED = 'You said no: this site cannot see that balance';
export const DEPLOY_NEEDS_TXID =
  'A token deploy goes into your wallet with internalizeAction once it is signed (its token id is its own outpoint)';

const TOKEN_ID = /^[0-9a-f]{64}_\d{1,6}$/;
const MAX_ISSUED_PER_SITE = 500;
const ISSUED_TTL_MS = 24 * 60 * 60 * 1000;

const PROTOCOL_METHODS = [
  'createSignature',
  'verifySignature',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'revealSpecificKeyLinkage',
] as const;

type Protocolish = { protocolID?: unknown };
const isProtocol = (p: unknown, want: WalletProtocol) =>
  Array.isArray(p) &&
  p.length === 2 &&
  p[0] === want[0] &&
  typeof p[1] === 'string' &&
  p[1].trim().toLowerCase() === want[1];
const isReceiveProtocol = (p: unknown) => isProtocol(p, SITE_TOKEN_RECEIVE) || isProtocol(p, SITE_ORDINAL_RECEIVE);

const normOutpoint = (op: string) => (op.length > 64 && op[64] === '_' ? `${op.slice(0, 64)}.${op.slice(65)}` : op);

/** The keyID the wallet mints for a receive key: the 1Sat wallets' own `${tokenId}-${ms}` (seed recovery scans it). */
export const receiveKeyID = (tokenId: string, ms: number) => `${tokenId}-${ms}`;

/** Parse a wallet receive keyID; null unless it is exactly `${tokenId}-${13-digit ms}`. */
export const parseReceiveKeyID = (keyID: unknown): { tokenId: string; ms: number } | null => {
  if (typeof keyID !== 'string') return null;
  const m = /^([0-9a-f]{64}_\d{1,6})-(\d{13})$/.exec(keyID);
  return m ? { tokenId: m[1], ms: Number(m[2]) } : null;
};

/** What a receive key is for: a transfer of one token id, a token deploy+mint, or an ordinal (icon). */
export type ReceiveKind = { kind: 'transfer'; tokenId: string } | { kind: 'deploy' } | { kind: 'ordinal' };

/** Parse any keyID the wallet mints for a site: transfer `${tokenId}-${ms}`, `deploy-${ms}`, `ordinal-${ms}`. */
export const parseIssuedKeyID = (keyID: unknown): (ReceiveKind & { ms: number }) | null => {
  const t = parseReceiveKeyID(keyID);
  if (t) return { kind: 'transfer', tokenId: t.tokenId, ms: t.ms };
  if (typeof keyID !== 'string') return null;
  const m = /^(deploy|ordinal)-(\d{13})$/.exec(keyID);
  return m ? { kind: m[1] as 'deploy' | 'ordinal', ms: Number(m[2]) } : null;
};

const sameKind = (a: ReceiveKind, b: ReceiveKind) =>
  a.kind === b.kind && (a.kind !== 'transfer' || (b.kind === 'transfer' && a.tokenId === b.tokenId));

const p2pkhTail = (scriptHex: string) => /76a914([0-9a-f]{40})88ac$/i.exec(scriptHex);

/** An ordinal inscription envelope + P2PKH, built the standard way (OP_0 OP_IF "ord" OP_1 <type> OP_0 <body> OP_ENDIF). */
const inscriptionScript = (contentType: number[], body: number[], address: string) => {
  const env = new Script()
    .writeOpCode(OP.OP_0)
    .writeOpCode(OP.OP_IF)
    .writeBin(Utils.toArray('ord', 'utf8'))
    .writeOpCode(OP.OP_1)
    .writeBin(contentType)
    .writeOpCode(OP.OP_0)
    .writeBin(body)
    .writeOpCode(OP.OP_ENDIF);
  return env.toHex() + new P2PKH().lock(address).toHex();
};

const DEPLOY_KEYS = new Set(['p', 'op', 'sym', 'amt', 'dec', 'icon']);

/**
 * Read a BSV-21 deploy+mint output: `{"p":"bsv-20","op":"deploy+mint","sym",...,"amt"[,"dec"][,"icon"]}` inscribed
 * as application/bsv-20, then P2PKH, nothing else. Only those keys (any order), each checked; the script must
 * rebuild byte for byte from them. Null when it is anything else.
 */
export const readTokenDeploy = (
  scriptHex: string,
): { sym: string; amt: bigint; dec?: string; icon?: string; address: string } | null => {
  try {
    const m = p2pkhTail(scriptHex);
    if (!m) return null;
    const address = Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]);
    const ascii = Utils.toUTF8(Utils.toArray(scriptHex.slice(0, scriptHex.length - 50), 'hex'));
    const start = ascii.indexOf('{"p":"bsv-20"');
    const end = ascii.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    const data = JSON.parse(ascii.slice(start, end + 1)) as Record<string, unknown>;
    if (Object.keys(data).some((k) => !DEPLOY_KEYS.has(k))) return null;
    if (Object.values(data).some((v) => typeof v !== 'string')) return null;
    const d = data as Record<string, string>;
    if (d.p !== 'bsv-20' || d.op !== 'deploy+mint') return null;
    // eslint-disable-next-line no-control-regex -- refuse control characters in a ticker
    if (typeof d.sym !== 'string' || !d.sym.trim() || d.sym.length > 32 || /[\u0000-\u001f\u007f]/.test(d.sym))
      return null;
    if (typeof d.amt !== 'string' || !/^[1-9]\d{0,30}$/.test(d.amt)) return null;
    if (d.dec !== undefined && !/^(1[0-8]|\d)$/.test(d.dec)) return null;
    if (d.icon !== undefined && !/^([0-9a-f]{64})?_\d{1,6}$/.test(d.icon)) return null;
    const rebuilt = inscriptionScript(
      Utils.toArray('application/bsv-20', 'utf8'),
      Utils.toArray(JSON.stringify(data), 'utf8'),
      address,
    );
    if (rebuilt !== scriptHex.toLowerCase()) return null;
    return { sym: d.sym, amt: BigInt(d.amt), dec: d.dec, icon: d.icon, address };
  } catch {
    return null;
  }
};

const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif']);
const MAX_ICON_BYTES = 1_000_000;

/**
 * Read an image ordinal inscription (a token icon): OP_0 OP_IF "ord" OP_1 <image/*> OP_0 <body> OP_ENDIF, then P2PKH,
 * nothing else, rebuilt byte for byte. Never application/bsv-20 (that is a token op, not an icon). Null otherwise.
 */
export const readImageInscription = (
  scriptHex: string,
): { contentType: string; bytes: number; address: string } | null => {
  try {
    const m = p2pkhTail(scriptHex);
    if (!m) return null;
    const address = Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]);
    const chunks = Script.fromHex(scriptHex.slice(0, scriptHex.length - 50)).chunks;
    if (chunks.length !== 8) return null;
    const [c0, cIf, cOrd, cField, cType, cSep, cBody, cEnd] = chunks;
    if (c0.op !== OP.OP_0 || cIf.op !== OP.OP_IF || cField.op !== OP.OP_1 || cSep.op !== OP.OP_0) return null;
    if (cEnd.op !== OP.OP_ENDIF || !cOrd.data || Utils.toUTF8(cOrd.data) !== 'ord') return null;
    if (!cType.data || !cBody.data || cBody.data.length === 0 || cBody.data.length > MAX_ICON_BYTES) return null;
    const contentType = Utils.toUTF8(cType.data);
    if (!ICON_TYPES.has(contentType)) return null;
    if (inscriptionScript(cType.data, cBody.data, address) !== scriptHex.toLowerCase()) return null;
    return { contentType, bytes: cBody.data.length, address };
  } catch {
    return null;
  }
};

/**
 * Read a BSV-21 transfer output exactly as bWalletX writes one (launchpad/tokens.ts bsv21): the script must rebuild
 * byte for byte from its own id, amount and address, so nothing else rides along. Null when it is anything else.
 */
export const readTokenTransfer = (scriptHex: string): { id: string; amt: bigint; address: string } | null => {
  try {
    const m = /76a914([0-9a-f]{40})88ac$/i.exec(scriptHex);
    if (!m) return null;
    const ascii = Utils.toUTF8(Utils.toArray(scriptHex.slice(0, scriptHex.length - 50), 'hex'));
    const start = ascii.indexOf('{"p":"bsv-20"');
    const end = ascii.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    const data = JSON.parse(ascii.slice(start, end + 1)) as { p?: string; op?: string; id?: string; amt?: string };
    if (data.p !== 'bsv-20' || data.op !== 'transfer' || typeof data.id !== 'string' || !TOKEN_ID.test(data.id))
      return null;
    if (typeof data.amt !== 'string' || !/^[1-9]\d{0,30}$/.test(data.amt)) return null;
    const address = Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]);
    const amt = BigInt(data.amt);
    if (bsv21(data.id, amt, address).toHex() !== scriptHex.toLowerCase()) return null;
    return { id: data.id, amt, address };
  } catch {
    return null;
  }
};

/** The record the wallet writes on a delivered coin: the same note its own trades write, minus site claims. */
export const deliveredNote = (id: string, amt: bigint, keyID: string) =>
  JSON.stringify({ id, amt: amt.toString(), op: 'transfer', protocolID: ONESAT, keyID, counterparty: 'self' });

/** The record the wallet writes on a deploy+mint it took in: the token id is the output's own outpoint. */
export const deployNote = (id: string, d: { sym: string; amt: bigint; dec?: string; icon?: string }, keyID: string) =>
  JSON.stringify({
    id,
    amt: d.amt.toString(),
    op: 'deploy+mint',
    sym: d.sym,
    ...(d.dec !== undefined ? { dec: d.dec } : {}),
    ...(d.icon ? { icon: d.icon } : {}),
    protocolID: ONESAT,
    keyID,
    counterparty: 'self',
  });

/** The record on an ordinal (icon) it took in: the key only, as the wallet's own ordinals carry. */
export const ordinalNote = (keyID: string) => JSON.stringify({ protocolID: ONESAT, keyID, counterparty: 'self' });

type Issued = { keyID: string; at: number };

/**
 * "Let this site see my $SYM balance" answers, per site per token. Remembered across restarts when persisted, for
 * LIST_CONSENT_DAYS, and dropped by Forget site / Revoke all (b-Aware 25 Oct 2026: they never expired and could not
 * be withdrawn).
 */
export type ListConsentStore = {
  has(site: string, tokenId: string): Promise<boolean>;
  add(site: string, tokenId: string): Promise<void>;
  /** Every site's remembered "see my balance" answers: site -> token ids (Connections). */
  list(): Promise<Record<string, string[]>>;
  /** Forget a site's answers (Forget site / Revoke all / Connections), so it must ask again. */
  forget(site: string): Promise<void>;
};

const groupConsents = (keys: Iterable<string>): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const k of keys) {
    const i = k.lastIndexOf('|');
    if (i <= 0) continue;
    (out[k.slice(0, i)] ??= []).push(k.slice(i + 1));
  }
  return out;
};

export const LIST_CONSENT_DAYS = 30;
const CONSENT_MS = LIST_CONSENT_DAYS * 86_400_000;
const live = (at: number, now: number) => Number.isFinite(at) && at <= now && now - at < CONSENT_MS;

export const memoryConsentStore = (now: () => number = Date.now): ListConsentStore => {
  const s = new Map<string, number>();
  return {
    has: async (site, id) => live(s.get(`${site}|${id}`) ?? NaN, now()),
    add: async (site, id) => void s.set(`${site}|${id}`, now()),
    list: async () => groupConsents([...s].filter(([, at]) => live(at, now())).map(([k]) => k)),
    forget: async (site) => {
      for (const k of [...s.keys()]) if (k.startsWith(`${site}|`)) s.delete(k);
    },
  };
};

export const LIST_CONSENT_KEY = 'bwalletx.siteTokenListConsent';

let sharedChromeStore: ListConsentStore | undefined;

/**
 * chrome.storage.local where it exists (extension, mobile shim), else memory. Entries are "site|tokenId|savedAtMs";
 * older entries with no time count as expired (asked again). Failures fall back to asking again.
 * One shared store unless a time source is passed (tests).
 */
export const chromeConsentStore = (now?: () => number): ListConsentStore =>
  now ? makeChromeConsentStore(now) : (sharedChromeStore ??= makeChromeConsentStore(Date.now));

const makeChromeConsentStore = (now: () => number): ListConsentStore => {
  type Area = {
    get(k: string): Promise<Record<string, unknown>>;
    set(v: Record<string, unknown>): Promise<void>;
  };
  const local = (globalThis as { chrome?: { storage?: { local?: Area } } }).chrome?.storage?.local;
  if (!local) return memoryConsentStore(now);
  const read = async (): Promise<string[]> => {
    try {
      const r = await local.get(LIST_CONSENT_KEY);
      return Array.isArray(r?.[LIST_CONSENT_KEY]) ? (r[LIST_CONSENT_KEY] as string[]) : [];
    } catch {
      return [];
    }
  };
  const write = async (all: string[]) => {
    try {
      await local.set({ [LIST_CONSENT_KEY]: all.slice(-2000) });
    } catch {
      /* asked again next time */
    }
  };
  const parts = (e: string) => {
    const i = e.lastIndexOf('|');
    const head = e.slice(0, i);
    return head.includes('|') ? { k: head, at: Number(e.slice(i + 1)) } : { k: e, at: NaN };
  };
  return {
    has: async (site, id) => (await read()).some((e) => parts(e).k === `${site}|${id}` && live(parts(e).at, now())),
    add: async (site, id) => {
      const k = `${site}|${id}`;
      const t = now();
      await write([...(await read()).filter((e) => parts(e).k !== k && live(parts(e).at, t)), `${k}|${t}`]);
    },
    list: async () => {
      const t = now();
      const stored = (await read())
        .map(parts)
        .filter((e) => live(e.at, t))
        .map((e) => e.k);
      return groupConsents(new Set(stored));
    },
    forget: async (site) => {
      await write((await read()).filter((e) => !parts(e).k.startsWith(`${site}|`)));
    },
  };
};

export type SiteTokenDeps = {
  adminOriginator: string;
  normalize: (o: string) => string;
  /** The approval sheet (oneSatPrompt.showOneSatPrompt). */
  prompt: (req: PromptRequest) => Promise<boolean>;
  /** Time source (tests). */
  now?: () => number;
  /** Where "see my balance" answers are kept (default: memory). */
  listConsent?: ListConsentStore;
};

type AnyFn = (args: never, originator?: string) => Promise<unknown>;
type Out = {
  lockingScript?: string;
  satoshis?: number;
  basket?: string;
  customInstructions?: string;
  tags?: string[];
  outputDescription?: string;
};
type CreateArgs = {
  description?: string;
  inputs?: { outpoint?: string; unlockingScriptLength?: number; inputDescription?: string }[];
  outputs?: Out[];
  options?: { signAndProcess?: boolean } & Record<string, unknown>;
} & Record<string, unknown>;
type InternalizeArgs = {
  tx?: number[] | Uint8Array;
  outputs?: {
    outputIndex: number;
    protocol?: string;
    insertionRemittance?: { basket?: string; customInstructions?: string; tags?: string[] };
  }[];
} & Record<string, unknown>;
type SignArgs = { reference?: string; spends?: Record<number, unknown> } & Record<string, unknown>;

type TokenCoinRec = {
  outpoint: string;
  satoshis: number;
  amtRaw: string;
  id: string;
  amt: bigint;
  sym?: string;
  protocolID: WalletProtocol;
  keyID: string;
};
type PendingSell = {
  originator: string;
  tx: number[];
  uses: { index: number; protocolID: WalletProtocol; keyID: string }[];
};

/**
 * Insertion tickets: guardReservedBaskets lets an outside 'bsv21' insertion through only against one of these. Each
 * guarded call holds its own ticket (one per output it validated) and drops whatever is left when it returns.
 */
type Ticket = { left: number };
const tickets = new Map<string, Ticket[]>(); // `${originator}|${basket}`
const TICKET_BASKETS = new Set([TOKEN_BASKET, ORDINAL_BASKET]);

/** Called by reservedBaskets.ensureBasketAccess: consume one validated-delivery ticket for this originator+basket. */
export const takeTokenInsertionTicket = (originator: unknown, basket: unknown, usage: unknown): boolean => {
  if (typeof originator !== 'string' || typeof basket !== 'string') return false;
  const b = basket.trim().toLowerCase();
  if (!TICKET_BASKETS.has(b) || (usage !== undefined && usage !== 'insertion')) return false;
  const t = tickets.get(`${originator}|${b}`)?.find((x) => x.left > 0);
  if (!t) return false;
  t.left--;
  return true;
};

const addTickets = (originator: string, counts: Record<string, number>) => {
  const releases: (() => void)[] = [];
  for (const [basket, n] of Object.entries(counts)) {
    if (n <= 0) continue;
    const key = `${originator}|${basket}`;
    const t: Ticket = { left: n };
    tickets.set(key, [...(tickets.get(key) ?? []), t]);
    releases.push(() => {
      const rest = (tickets.get(key) ?? []).filter((x) => x !== t);
      if (rest.length) tickets.set(key, rest);
      else tickets.delete(key);
    });
  }
  return () => releases.forEach((r) => r());
};

/** Test hook. */
export const _ticketsFor = (originator: string, basket = TOKEN_BASKET) =>
  (tickets.get(`${originator}|${basket}`) ?? []).reduce((n, t) => n + t.left, 0);

/**
 * Wrap the outermost wallet (the one background.ts hands every site): receive keys, validated deliveries and
 * wallet-signed sells for outside originators. Calls from the wallet itself pass straight through.
 */
export function guardSiteTokens<T extends object>(wallet: T, deps: SiteTokenDeps): T {
  const w = wallet as Record<string, unknown>;
  const now = deps.now ?? Date.now;
  const outside = (o?: string) => !!o && o !== deps.adminOriginator;
  const admin = deps.adminOriginator;
  const call = <R>(name: string, args: unknown, originator?: string): Promise<R> =>
    (w[`__site_${name}`] as AnyFn).call(wallet, args as never, originator) as Promise<R>;
  for (const name of ['getPublicKey', 'createAction', 'signAction', 'abortAction', 'internalizeAction', 'listOutputs'])
    if (typeof w[name] === 'function') w[`__site_${name}`] = w[name];
  for (const name of PROTOCOL_METHODS) if (typeof w[name] === 'function') w[`__site_${name}`] = w[name];

  const issued = new Map<string, Map<string, Issued>>(); // site -> address -> key
  let lastMs = 0;

  const deriveAddress = async (keyID: string) => {
    const { publicKey } = await call<{ publicKey: string }>(
      'getPublicKey',
      { protocolID: ONESAT, keyID, counterparty: 'self' },
      admin,
    );
    return { publicKey, address: PublicKey.fromString(publicKey).toAddress() };
  };

  /** The keyID that locks `address` for this site, or null: an issued key, or an issued-shape keyID that derives it. */
  const keyFor = async (
    site: string,
    want: ReceiveKind,
    address: string,
    claimed?: unknown,
  ): Promise<string | null> => {
    const hit = issued.get(site)?.get(address);
    const hitKind = hit ? parseIssuedKeyID(hit.keyID) : null;
    if (hit && hitKind && sameKind(hitKind, want)) return hit.keyID;
    const parsed = parseIssuedKeyID(claimed);
    if (!parsed || !sameKind(parsed, want) || parsed.ms > now() + ISSUED_TTL_MS) return null;
    const d = await deriveAddress(claimed as string);
    return d.address === address ? (claimed as string) : null;
  };

  const claimedKeyID = (ci: unknown) => {
    if (typeof ci !== 'string') return undefined;
    try {
      return (JSON.parse(ci) as { keyID?: unknown }).keyID;
    } catch {
      return undefined;
    }
  };

  /**
   * Validate one delivered output and give the record the wallet writes; throws BAD_DELIVERY_REFUSAL otherwise.
   * `basket` is TOKEN_BASKET or ORDINAL_BASKET; `outpoint` is known only for internalizeAction (signed tx).
   */
  const checkDelivery = async (
    site: string,
    basket: string,
    scriptHex: string,
    sats: number,
    ci: unknown,
    outpoint?: { txid: string; vout: number },
  ): Promise<{ customInstructions: string; tags: string[] }> => {
    const unknownKey = `${BAD_DELIVERY_REFUSAL} (unknown receive key; ask getPublicKey again)`;
    if (sats !== 1) throw new Error(`${BAD_DELIVERY_REFUSAL} (a delivery is exactly 1 sat)`);
    if (basket === ORDINAL_BASKET) {
      const ins = readImageInscription(scriptHex);
      if (!ins) throw new Error(`${BAD_DELIVERY_REFUSAL} (not an image inscription to a P2PKH key)`);
      const keyID = await keyFor(site, { kind: 'ordinal' }, ins.address, claimedKeyID(ci));
      if (!keyID) throw new Error(unknownKey);
      return { customInstructions: ordinalNote(keyID), tags: [`type:${ins.contentType}`] };
    }
    const t = readTokenTransfer(scriptHex);
    if (t) {
      const keyID = await keyFor(site, { kind: 'transfer', tokenId: t.id }, t.address, claimedKeyID(ci));
      if (!keyID) throw new Error(unknownKey);
      return { customInstructions: deliveredNote(t.id, t.amt, keyID), tags: tokenOutputTags(t.id) };
    }
    const d = readTokenDeploy(scriptHex);
    if (!d) throw new Error(`${BAD_DELIVERY_REFUSAL} (not a 1-sat BSV-21 transfer or deploy+mint)`);
    if (!outpoint) throw new Error(DEPLOY_NEEDS_TXID);
    const keyID = await keyFor(site, { kind: 'deploy' }, d.address, claimedKeyID(ci));
    if (!keyID) throw new Error(unknownKey);
    const id = `${outpoint.txid}_${outpoint.vout}`;
    return {
      customInstructions: deployNote(id, d, keyID),
      tags: ['bsv21:deploy', `bsv21:${id}`, randomIdTag(outpoint.vout)],
    };
  };

  /**
   * Which wallet basket a site output is a delivery into, or null to leave it alone (any other '1sat' or reserved
   * basket then meets reservedBaskets' refusal). Every 'bsv21' output is checked; a '1sat' output only when it is an
   * inscription at all, so plain misuse keeps its old answer.
   */
  const deliveryBasket = (basket: unknown, scriptHex: unknown): string | null => {
    if (typeof basket !== 'string') return null;
    const b = basket.trim().toLowerCase();
    if (TOKEN_BASKETS.has(b)) return TOKEN_BASKET;
    if (b === ORDINAL_BASKET && typeof scriptHex === 'string' && /^0063036f7264/i.test(scriptHex))
      return ORDINAL_BASKET;
    return null;
  };

  // 5. One token's coins for a site: outpoint, satoshis, amount. Nothing else.
  const listConsent = deps.listConsent ?? memoryConsentStore();
  const listOutputs = w.listOutputs as AnyFn | undefined;
  if (typeof listOutputs === 'function')
    w.listOutputs = async (
      args: { basket?: unknown; tags?: unknown; limit?: unknown; offset?: unknown },
      originator?: string,
    ) => {
      const basket = typeof args?.basket === 'string' ? args.basket.trim().toLowerCase() : '';
      const tags = Array.isArray(args?.tags) ? args.tags : [];
      const tokenId =
        tags.length === 1 && typeof tags[0] === 'string' && tags[0].startsWith('bsv21:')
          ? tags[0].slice(6).trim().replace('.', '_')
          : '';
      // Anything but exactly one token's tag on the token basket goes on unchanged (reservedBaskets refuses it).
      if (!outside(originator) || !TOKEN_BASKETS.has(basket) || !TOKEN_ID.test(tokenId))
        return call('listOutputs', args, originator);
      const site = deps.normalize(originator!);
      const coins = [...(await walletTokenCoins()).values()].filter((c) => c.id === tokenId && c.amt > 0n);
      if (!(await listConsent.has(site, tokenId))) {
        const sym = coins.find((c) => c.sym)?.sym;
        const name = sym ? `$${sym.replace(/^\$/, '')}` : `${tokenId.slice(0, 8)}…${tokenId.slice(-4)} token`;
        const ok = await deps.prompt({
          kind: 'basketAccess',
          originator: site,
          summary: `${site} wants to see your ${name} balance`,
          payload: {
            baskets: [
              {
                basket: name,
                description: `${site} wants to see your ${name} balance, so it can offer to sell them for you. It sees how many you hold and where, nothing else. It cannot move them without asking you.`,
                scope: 'token',
                value: tokenId,
              },
            ],
          },
        });
        if (!ok) throw new Error(LIST_REJECTED);
        await listConsent.add(site, tokenId);
      }
      const limit = Math.min(Math.max(Number(args?.limit) || 100, 1), 1000);
      const offset = Math.max(Number(args?.offset) || 0, 0);
      return {
        totalOutputs: coins.length,
        outputs: coins.slice(offset, offset + limit).map((c) => ({
          outpoint: c.outpoint,
          satoshis: c.satoshis,
          spendable: true,
          amount: c.amtRaw,
        })),
      };
    };

  // 1. Receive keys.
  const getPublicKey = w.getPublicKey as AnyFn | undefined;
  if (typeof getPublicKey === 'function')
    w.getPublicKey = async (args: Protocolish & { keyID?: unknown; counterparty?: unknown }, originator?: string) => {
      if (!outside(originator) || !isReceiveProtocol(args?.protocolID)) return call('getPublicKey', args, originator);
      if (args.counterparty !== undefined && args.counterparty !== 'self')
        throw new Error("counterparty must be 'self' for a token receive key");
      const asked = typeof args.keyID === 'string' ? args.keyID.trim() : '';
      let mint: (ms: number) => string;
      if (isProtocol(args.protocolID, SITE_ORDINAL_RECEIVE)) {
        if (asked !== 'ordinal') throw new Error("keyID must be 'ordinal' for an ordinal receive key");
        mint = (ms) => `ordinal-${ms}`;
      } else if (asked === 'deploy') {
        mint = (ms) => `deploy-${ms}`;
      } else {
        const tokenId = asked.replace('.', '_');
        if (!TOKEN_ID.test(tokenId)) throw new Error("keyID must be the BSV-21 token id (txid_vout) or 'deploy'");
        mint = (ms) => receiveKeyID(tokenId, ms);
      }
      const site = deps.normalize(originator!);
      const ms = (lastMs = Math.max(now(), lastMs + 1));
      const keyID = mint(ms);
      const { publicKey, address } = await deriveAddress(keyID);
      let mine = issued.get(site);
      if (!mine) issued.set(site, (mine = new Map()));
      for (const [a, k] of mine) if (now() - k.at > ISSUED_TTL_MS || mine.size >= MAX_ISSUED_PER_SITE) mine.delete(a);
      mine.set(address, { keyID, at: now() });
      return { publicKey, keyID };
    };

  // 4. The receive protocol signs nothing for a site.
  for (const name of PROTOCOL_METHODS) {
    if (typeof w[name] !== 'function') continue;
    w[name] = async (args: Protocolish, originator?: string) => {
      if (outside(originator) && isReceiveProtocol(args?.protocolID)) throw new Error(RECEIVE_ONLY_REFUSAL);
      return call(name, args, originator);
    };
  }

  // 3. Selling: the wallet's own token coins named as inputs.
  const pending = new Map<string, PendingSell>();
  const walletTokenCoins = async (): Promise<Map<string, TokenCoinRec>> => {
    const out = new Map<string, TokenCoinRec>();
    for (const basket of TOKEN_BASKETS) {
      const r = await call<{
        outputs: {
          outpoint: string;
          satoshis?: number;
          spendable?: boolean;
          customInstructions?: string;
          tags?: string[];
        }[];
      }>('listOutputs', { basket, includeCustomInstructions: true, includeTags: true, limit: 10000 }, admin).catch(
        () => null,
      );
      for (const o of r?.outputs ?? []) {
        if (o.spendable === false) continue;
        let ci: Record<string, unknown> = {};
        try {
          ci = o.customInstructions ? JSON.parse(o.customInstructions) : {};
        } catch {
          continue;
        }
        if (!Array.isArray(ci.protocolID) || typeof ci.keyID !== 'string' || typeof ci.id !== 'string') continue;
        const amtRaw = typeof ci.amt === 'string' && /^\d{1,40}$/.test(ci.amt) ? ci.amt : '0';
        out.set(normOutpoint(o.outpoint), {
          outpoint: normOutpoint(o.outpoint),
          satoshis: typeof o.satoshis === 'number' ? o.satoshis : 1,
          amtRaw,
          id: ci.id.replace('.', '_'),
          amt: BigInt(amtRaw),
          sym: typeof ci.sym === 'string' ? ci.sym : undefined,
          protocolID: ci.protocolID as WalletProtocol,
          keyID: ci.keyID,
        });
      }
    }
    return out;
  };

  const sellSheet = (originator: string, args: CreateArgs, sold: TokenCoinRec[]): PromptRequest => {
    const short = (s: string) => (s.length > 20 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
    const panels: Record<string, unknown>[] = sold.map((c) => ({
      title: `${c.amt.toLocaleString()} ${c.sym ? `$${c.sym}` : short(c.id)}`,
      subtitle: 'Leaves your wallet',
      subtitleCopy: c.id,
      variant: 'token',
      tone: 'danger',
    }));
    for (const o of args.outputs ?? []) {
      const hex = o.lockingScript ?? '';
      const t = readTokenTransfer(hex);
      if (t && o.basket === TOKEN_BASKET)
        panels.push({
          title: `${t.amt.toLocaleString()} ${short(t.id)}`,
          subtitle: 'Comes to your wallet',
          variant: 'token',
        });
      else if (t)
        // Tokens going anywhere but the wallet: the wallet writes the line (amount, token, address). A site's
        // outputDescription could otherwise call it "change back to you" (bridge audit 25 Oct 2026).
        panels.push({
          title: `${t.amt.toLocaleString()} ${short(t.id)} leave to ${short(t.address)}`,
          subtitle: `Site's label: ${String(o.outputDescription ?? '').slice(0, 60) || 'none'}`,
          subtitleCopy: t.address,
          variant: 'token',
          tone: 'danger',
        });
      else {
        const p2pkh = /^76a914([0-9a-f]{40})88ac$/i.exec(hex);
        const to = p2pkh ? Utils.toBase58Check(Utils.toArray(p2pkh[1], 'hex'), [0]) : 'a script';
        panels.push({
          title: o.outputDescription?.slice(0, 80) || 'Output',
          subtitle: `To ${short(to)}`,
          subtitleCopy: to,
          variant: 'value',
          amountSats: o.satoshis ?? 0,
          valueIcon: 'pay',
        });
      }
    }
    return {
      kind: 'transaction',
      originator,
      summary: `${originator} wants to spend ${sold.length} token coin${sold.length === 1 ? '' : 's'} from your wallet`,
      payload: {
        title: 'Transaction Request',
        subtitle: originator,
        panels,
        rows: [{ key: 'What the site says', value: String(args.description ?? '').slice(0, 200) }],
      },
    };
  };

  const createAction = w.createAction as AnyFn | undefined;
  if (typeof createAction === 'function')
    w.createAction = async (args: CreateArgs, originator?: string) => {
      if (!outside(originator)) return call('createAction', args, originator);
      const site = deps.normalize(originator!);
      // 2. Deliveries into the token basket: rewrite the record, or refuse.
      const deliveries: Record<string, number> = {};
      let next: CreateArgs = args;
      if (args?.outputs?.some((o) => deliveryBasket(o?.basket, o?.lockingScript))) {
        const outputs: Out[] = [];
        for (const o of args.outputs) {
          const basket = deliveryBasket(o?.basket, o?.lockingScript);
          if (!basket) {
            outputs.push(o);
            continue;
          }
          const rec = await checkDelivery(
            site,
            basket,
            String(o.lockingScript ?? ''),
            Number(o.satoshis),
            o.customInstructions,
          );
          outputs.push({ ...o, basket, ...rec });
          deliveries[basket] = (deliveries[basket] ?? 0) + 1;
        }
        next = { ...args, outputs };
      }
      // 3. Wallet token coins named as inputs.
      const named = (args?.inputs ?? []).map((i) => (typeof i?.outpoint === 'string' ? normOutpoint(i.outpoint) : ''));
      const coins = named.some(Boolean) ? await walletTokenCoins() : new Map<string, TokenCoinRec>();
      const sold = named.map((op) => coins.get(op)).filter((c): c is TokenCoinRec => !!c);
      const wantsAuto = sold.length > 0 && next.options?.signAndProcess !== false;
      if (sold.length > 0) {
        if (!(await deps.prompt(sellSheet(originator!, next, sold)))) throw new Error(SELL_REJECTED);
        next = { ...next, options: { ...(next.options ?? {}), signAndProcess: false } };
      }
      const release = addTickets(originator!, deliveries);
      let res: { signableTransaction?: { tx: number[]; reference: string } } & Record<string, unknown>;
      try {
        res = (await call('createAction', next, originator)) as typeof res;
      } finally {
        release();
      }
      if (sold.length === 0) return res;
      const signable = res.signableTransaction;
      if (!signable) throw new Error('The wallet did not return a transaction to sign');
      const tx = Transaction.fromAtomicBEEF(signable.tx);
      const uses: PendingSell['uses'] = [];
      tx.inputs.forEach((inp, index) => {
        const op = `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex')}.${inp.sourceOutputIndex}`;
        const c = coins.get(op);
        if (c && sold.includes(c)) uses.push({ index, protocolID: c.protocolID, keyID: c.keyID });
      });
      if (uses.length !== sold.length) {
        await call('abortAction', { reference: signable.reference }, originator).catch(() => undefined);
        throw new Error('The transaction to sign does not spend the coins you approved');
      }
      pending.set(signable.reference, { originator: originator!, tx: Array.from(signable.tx), uses });
      if (!wantsAuto) return res;
      return (w.signAction as AnyFn).call(wallet, { reference: signable.reference, spends: {} } as never, originator);
    };

  const signAction = w.signAction as AnyFn | undefined;
  if (typeof signAction === 'function')
    w.signAction = async (args: SignArgs, originator?: string) => {
      const p = args?.reference ? pending.get(args.reference) : undefined;
      if (!p) return call('signAction', args, originator);
      if (p.originator !== originator) throw new Error('This transaction belongs to another site');
      const spends = { ...(args.spends ?? {}) } as Record<number, unknown>;
      for (const u of p.uses) if (spends[u.index] !== undefined) throw new Error(SITE_SPENDS_REFUSAL);
      const tx = Transaction.fromAtomicBEEF(p.tx);
      const adminWallet = {
        createSignature: (a: unknown) => call('createSignature', a, admin),
        getPublicKey: (a: unknown) => call('getPublicKey', a, admin),
      } as unknown as WalletInterface;
      Object.assign(spends, await tokenSpends(adminWallet, tx, p.uses));
      const done = await call('signAction', { ...args, spends }, originator);
      pending.delete(args.reference!);
      return done;
    };

  const abortAction = w.abortAction as AnyFn | undefined;
  if (typeof abortAction === 'function')
    w.abortAction = async (args: { reference?: string }, originator?: string) => {
      const p = args?.reference ? pending.get(args.reference) : undefined;
      if (p && p.originator === originator) pending.delete(args.reference!);
      return call('abortAction', args, originator);
    };

  // 2b. internalizeAction into the token basket (a site sending tokens later).
  const internalize = w.internalizeAction as AnyFn | undefined;
  if (typeof internalize === 'function')
    w.internalizeAction = async (args: InternalizeArgs, originator?: string) => {
      if (!outside(originator)) return call('internalizeAction', args, originator);
      const insertions = (args?.outputs ?? []).filter(
        (o) => o?.protocol === 'basket insertion' && typeof o.insertionRemittance?.basket === 'string',
      );
      const named = (b: unknown) => (typeof b === 'string' ? b.trim().toLowerCase() : '');
      if (
        !insertions.some(
          (o) =>
            TICKET_BASKETS.has(named(o.insertionRemittance?.basket)) ||
            TOKEN_BASKETS.has(named(o.insertionRemittance?.basket)),
        )
      )
        return call('internalizeAction', args, originator);
      const site = deps.normalize(originator!);
      const tx = Transaction.fromAtomicBEEF(Array.from(args.tx ?? []));
      const txid = tx.id('hex');
      const outputs = [];
      const counts: Record<string, number> = {};
      for (const o of args.outputs ?? []) {
        const out = insertions.includes(o) ? tx.outputs[o.outputIndex] : undefined;
        const basket = insertions.includes(o)
          ? deliveryBasket(o.insertionRemittance?.basket, out?.lockingScript.toHex())
          : null;
        if (!basket) {
          outputs.push(o);
          continue;
        }
        if (!out) throw new Error(`${BAD_DELIVERY_REFUSAL} (no output ${o.outputIndex})`);
        const rec = await checkDelivery(
          site,
          basket,
          out.lockingScript.toHex(),
          Number(out.satoshis),
          o.insertionRemittance?.customInstructions,
          { txid, vout: o.outputIndex },
        );
        outputs.push({ ...o, insertionRemittance: { basket, ...rec } });
        counts[basket] = (counts[basket] ?? 0) + 1;
      }
      const release = addTickets(originator!, counts);
      try {
        return await call('internalizeAction', { ...args, outputs }, originator);
      } finally {
        release();
      }
    };

  return wallet;
}
