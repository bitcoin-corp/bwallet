import { checkBinding, keyChange, type BindingStatus } from './binding';
import { Utils } from '@bsv/sdk';
import { AMOUNT_HINT, cleanRecipient, isMainnetAddress, looksLikeAmount } from './address';
import { BWALLET_PAYMAIL_DOMAIN, LEGACY_PAYMAIL_DOMAINS, SIBLING_PAYMAIL_DOMAINS } from './config';

/** Other domains every name answers on (legacy bwallet.space, sibling bmailx.com). Tolerates mocked config. */
const alsoOurs = (): string[] => [...(LEGACY_PAYMAIL_DOMAINS ?? []), ...(SIBLING_PAYMAIL_DOMAINS ?? [])];
import { isPlaceholderName } from './handlePrompt';
import { compressedKey, keyAddress, knownKeyLabel, parsePubKey, shortKey } from './pubkeyRecipient';

/**
 * "Send to a name": classify what the user typed in a recipient box and resolve it to
 * something upstream's send code already understands (a P2PKH address or a paymail).
 *
 *   1ABC…            → address (passed straight through)
 *   $boase           → our paymail boase@<BWALLET_PAYMAIL_DOMAIN> (or the legacy bwallet.space)
 *                      ONLY. Handles are bWalletX handles: never HandCash or any other
 *                      service (owner, 13 Oct 2026), else "No bWalletX user called $boase".
 *   $name@domain     → the paymail name@domain (explicit; flagged `external` if not ours)
 *   name@domain.tld  → paymail (bsvalias capability discovery; flagged `external` if not ours)
 *   satchmo          → our paymail satchmo@<BWALLET_PAYMAIL_DOMAIN> first, else the
 *                      OpNS name (1Sat on-chain name) → current owner address
 *
 * Every network call goes through an injectable fetch so tests can mock it.
 * Nothing here signs or broadcasts.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type Parsed =
  | { kind: 'empty' }
  | { kind: 'address'; address: string }
  | { kind: 'handle'; handle: string }
  | { kind: 'paymail'; paymail: string }
  | { kind: 'opns'; name: string }
  | { kind: 'pubkey'; key: string; compressed: boolean }
  | { kind: 'invalid'; reason: string };

const PAYMAIL_RE = /^([a-z0-9._+-]{1,64})@([a-z0-9-]+(\.[a-z0-9-]+)+)$/i;
const HANDLE_RE = /^\$([a-z0-9_.-]{1,50})$/i;
// OpNS names: the covenant only accepts a-z, 0-9 and - (opns.md "Character set").
const OPNS_RE = /^[a-z0-9-]{1,64}$/i;

export const parseRecipient = (raw: string): Parsed => {
  const s = cleanRecipient(raw);
  if (!s) return { kind: 'empty' };
  if (isMainnetAddress(s)) return { kind: 'address', address: s };
  // A raw public key (send to any key, 24 Oct 2026): checked before names, since hex also fits the OpNS charset.
  const k = parsePubKey(s);
  if (k && 'error' in k) return { kind: 'invalid', reason: k.error };
  if (k) return { kind: 'pubkey', key: k.hex, compressed: k.compressed };
  // "$0.01" / "5" / "£1": an amount in the wrong box, never a $handle or OpNS name.
  if (looksLikeAmount(s)) return { kind: 'invalid', reason: AMOUNT_HINT };
  const h = s.match(HANDLE_RE);
  if (h) {
    const handle = h[1].toLowerCase();
    return { kind: 'handle', handle };
  }
  // `$name@domain` is a paymail with a `$` in front: accept it as the paymail.
  if (s.startsWith('$') && s.includes('@') && PAYMAIL_RE.test(s.slice(1))) {
    return { kind: 'paymail', paymail: s.slice(1).toLowerCase() };
  }
  if (s.startsWith('$')) return { kind: 'invalid', reason: 'Handles look like $name' };
  if (s.includes('@')) {
    return PAYMAIL_RE.test(s)
      ? { kind: 'paymail', paymail: s.toLowerCase() }
      : { kind: 'invalid', reason: 'Not a valid paymail' };
  }
  // Long base58-ish strings that failed address validation are mistyped addresses, not names.
  if (s.length >= 26 && /^[13mn][1-9A-HJ-NP-Za-km-z]+$/.test(s)) {
    return { kind: 'invalid', reason: 'Not a valid address' };
  }
  if (OPNS_RE.test(s)) return { kind: 'opns', name: s.toLowerCase() };
  return { kind: 'invalid', reason: 'Enter an address, $handle, paymail or name' };
};

export type Via = 'address' | 'p2p-paymail' | 'paymail-address' | 'opns-owner' | 'pubkey';

export const VIA_LABEL: Record<Via, string> = {
  address: 'Bitcoin address',
  'p2p-paymail': 'Paymail P2P (fresh derived address each payment)',
  'paymail-address': 'Paymail address',
  'opns-owner': 'OpNS name owner address',
  pubkey: "Public key (the key's plain address)",
};

export type Resolved = {
  input: string;
  /** What to hand upstream's send: a paymail (BSV P2P path) or an address. */
  target: string;
  targetKind: 'paymail' | 'address';
  via: Via;
  displayName?: string;
  avatar?: string;
  /** Paymail identity pubkey (pki) or OpNS-bound identity key, when known. */
  pubkey?: string;
  /** A bWalletX name's owner-signed binding to `pubkey` (names/binding.ts): signed, not yet signed, or bad. */
  nameBinding?: BindingStatus;
  /** Where tokens (BSV-21 / ordinals) would go, if this name can receive them. */
  ordAddress?: string;
  /** A $name that wasn't ours but a lookalike is (0/o, 1/l/i): "did you mean $b0asey?" (12 Oct 2026). */
  didYouMean?: string;
  /**
   * The domain of an explicitly typed paymail that is NOT a bWalletX domain (e.g. "handcash.io").
   * Only ever set for a full name@domain the user typed; a $handle never resolves outside bWalletX.
   */
  external?: string;
  /** A raw public key exactly as typed (via 'pubkey'); `pubkey` holds its compressed form. */
  rawKey?: string;
};

export class ResolveError extends Error {}

/**
 * The confirm-card line for an explicitly typed paymail outside bWalletX: the full paymail and its
 * domain, so it is never mistaken for a bWalletX handle ("boase@handcash.io — outside bWalletX").
 */
export const externalLabel = (r: Pick<Resolved, 'input' | 'external'>): string | undefined =>
  r.external ? `${r.input.replace(/^\$/, '').toLowerCase()} — outside bWalletX` : undefined;

/**
 * Whether an OpNS name is bound to a wallet (signed identity key, opns.idKey) or only held at an address.
 * Display only: Send still pays the holder's address either way (pay-to-name is a later stage).
 */
export const opnsBinding = (r: Pick<Resolved, 'via' | 'pubkey'>): 'bound' | 'unbound' | null =>
  r.via !== 'opns-owner' ? null : r.pubkey ? 'bound' : 'unbound';

export const SERVICES = {
  doh: 'https://dns.google.com/resolve',
  opnsApi: 'https://ordinals.gorillapool.io/api/opns',
  opnsOrigin: 'https://api.1sat.app/1sat/opns/origin',
  opnsMine: 'https://api.1sat.app/1sat/opns/mine',
  inscriptionLatest: 'https://ordinals.gorillapool.io/api/inscriptions',
};

// Response shapes we read (all fields optional: these are third-party servers).
type DohResponse = { Answer?: { type: number; data?: unknown }[] };
type BsvaliasDoc = { capabilities?: Capabilities };
type Fields = Record<string, unknown>;
type OpnsRecord = { owner?: unknown; map?: Fields };
type Outpoint = { outpoint?: unknown };
type Inscription = {
  owner?: unknown;
  outpoint?: unknown;
  spend?: unknown;
  data?: { map?: Fields; list?: { price?: unknown } };
};

const getJson = async <T>(f: Fetch, url: string, init?: RequestInit): Promise<T> => {
  const res = await f(url, init);
  if (!res.ok) throw new ResolveError(`HTTP ${res.status}`);
  return res.json();
};

const tryJson = async <T>(f: Fetch, url: string, init?: RequestInit): Promise<T | undefined> => {
  try {
    return await getJson<T>(f, url, init);
  } catch {
    return undefined;
  }
};

export const fill = (tpl: string, alias: string, domain: string) =>
  tpl.replace('{alias}', encodeURIComponent(alias)).replace('{domain.tld}', domain);

/** bsvalias host via SRV (handcash.io → cloud.handcash.io), else the domain itself. */
export const discoverHost = async (f: Fetch, domain: string): Promise<string> => {
  const dns = await tryJson<DohResponse>(f, `${SERVICES.doh}?name=_bsvalias._tcp.${domain}&type=SRV`);
  const ans = dns?.Answer?.find((a) => a.type === 33);
  if (ans?.data) {
    const parts = String(ans.data).trim().split(/\s+/);
    const host = parts[3]?.replace(/\.$/, '');
    const port = parts[2];
    if (host) return port && port !== '443' ? `${host}:${port}` : host;
  }
  return domain;
};

export type Capabilities = Record<string, string | boolean>;

export const getCapabilities = async (f: Fetch, domain: string): Promise<Capabilities> => {
  const host = await discoverHost(f, domain);
  let doc = await tryJson<BsvaliasDoc>(f, `https://${host}/.well-known/bsvalias`);
  if (!doc?.capabilities && host !== domain)
    doc = await tryJson<BsvaliasDoc>(f, `https://${domain}/.well-known/bsvalias`);
  if (!doc?.capabilities) throw new ResolveError(`${domain} doesn't host paymail`);
  return doc.capabilities as Capabilities;
};

// bsvalias BRFC ids.
export const CAP = {
  pki: 'pki',
  paymentDestination: 'paymentDestination',
  publicProfile: 'f12f968c92d6',
  p2pDestination: '2a40af698840',
  receiveBeef: '5c55a7fdb7bb',
} as const;

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** 1Sat paymail ordinal-receive capability (`ordAddress`); any url-valued key naming "ord". */
export const ordCapability = (caps: Capabilities): string | undefined =>
  str(caps.ordAddress) ??
  Object.entries(caps)
    .find(([k, v]) => /ord/i.test(k) && str(v))?.[1]
    ?.toString();

export const scriptToAddress = (hex: string): string | undefined => {
  const m = hex.match(/^76a914([0-9a-f]{40})88ac$/i);
  return m ? Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]) : undefined;
};

export const resolvePaymail = async (f: Fetch, paymail: string, input = paymail): Promise<Resolved> => {
  const [alias, domain] = paymail.split('@');
  const caps = await getCapabilities(f, domain);
  const r: Partial<Resolved> = { input };
  if (!isOurDomain(domain)) r.external = domain.toLowerCase();

  const prof = str(caps[CAP.publicProfile]);
  if (prof) {
    const p = await tryJson<Fields>(f, fill(prof, alias, domain));
    // "Anonymous" / "Account 1" from an old profile is no name: the UI shows the paymail instead.
    r.displayName = str(p?.name) && !isPlaceholderName(str(p?.name)) ? str(p?.name) : undefined;
    r.avatar = str(p?.avatar);
  }
  const pki = str(caps[CAP.pki]);
  if (pki) {
    const id = await tryJson<Fields & { binding?: unknown }>(f, fill(pki, alias, domain));
    r.pubkey = str(id?.pubkey);
    // Our names carry the owner's signed binding: check it here rather than trust our server.
    if (!r.external && r.pubkey) {
      const status = await checkBinding(alias, r.pubkey, id?.binding);
      const from = (id?.binding as { handover?: { from?: string } } | undefined)?.handover?.from;
      r.nameBinding = keyChange(alias, r.pubkey, status, from);
    }
  }

  const ord = ordCapability(caps);
  if (ord) r.ordAddress = str((await tryJson<Fields>(f, fill(ord, alias, domain)))?.address);

  // Prefer P2P (BRC-29-style per-payment outputs) — upstream sendBsv handles it natively.
  const p2p = str(caps[CAP.p2pDestination]);
  if (p2p && (str(caps[CAP.receiveBeef]) || str(caps['5f1323cddf31']))) {
    return { ...r, target: paymail, targetKind: 'paymail', via: 'p2p-paymail' } as Resolved;
  }
  // Fallback: basic address resolution (some servers require a signed request; try unsigned).
  const pd = str(caps[CAP.paymentDestination]);
  if (pd) {
    const out = await tryJson<{ output?: string }>(f, fill(pd, alias, domain), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderHandle: 'bwallet@bwallet', dt: new Date().toISOString(), purpose: 'payment' }),
    });
    const address = out?.output ? scriptToAddress(out.output) : undefined;
    if (address) return { ...r, target: address, targetKind: 'address', via: 'paymail-address' } as Resolved;
  }
  if (r.pubkey === undefined && !prof) throw new ResolveError(`${paymail} not found`);
  throw new ResolveError(`${paymail} can't receive payments`);
};

export const resolveOpns = async (f: Fetch, name: string): Promise<Resolved> => {
  // Primary: GorillaPool OpNS index (owner + MAP, incl. opns.idKey).
  const rec = await tryJson<OpnsRecord>(f, `${SERVICES.opnsApi}/${encodeURIComponent(name)}`);
  let owner = str(rec?.owner);
  let pubkey = str(rec?.map?.['opns.idKey']);
  if (!owner) {
    // Fallback: 1sat-stack origin → latest inscription location.
    const o = await tryJson<Outpoint>(f, `${SERVICES.opnsOrigin}/${encodeURIComponent(name)}`);
    const origin = str(o?.outpoint);
    if (!origin) throw new ResolveError(`No one has the name "${name}"`);
    const latest = await tryJson<Inscription>(
      f,
      `${SERVICES.inscriptionLatest}/${origin.replace('.', '_')}/latest?script=false`,
    );
    owner = str(latest?.owner);
    pubkey ??= str(latest?.data?.map?.['opns.idKey']);
    if (!owner) throw new ResolveError(`Couldn't locate the owner of "${name}"`);
  }
  return {
    input: name,
    target: owner,
    targetKind: 'address',
    via: 'opns-owner',
    displayName: name,
    pubkey,
    ordAddress: owner,
  };
};

/**
 * A bare name: our own paymail (name@<domain>) first, then OpNS. Inside bWallet people see each
 * other's paymail without the domain, so typing what you see must reach the same person.
 */
export const resolveBareName = async (
  f: Fetch,
  name: string,
  domain: string = BWALLET_PAYMAIL_DOMAIN,
): Promise<Resolved> => {
  if (domain && PAYMAIL_RE.test(`${name}@${domain}`)) {
    try {
      return await resolvePaymail(f, `${name}@${domain}`, name);
    } catch {
      /* not one of ours → OpNS */
    }
  }
  return resolveOpns(f, name);
};

/** A bWalletX paymail domain: the configured one (bwalletx.com), a sibling (bmailx.com) or a legacy one (bwallet.space). */
export const isOurDomain = (d: string, domain: string = BWALLET_PAYMAIL_DOMAIN) => {
  const x = d.toLowerCase();
  return (!!domain && x === domain.toLowerCase()) || alsoOurs().includes(x);
};

export const noSuchUser = (input: string) => `No bWalletX user called ${input}`;

/**
 * A `$name` is a bWalletX handle and nothing else (owner, 13 Oct 2026): name@<domain> (bwalletx.com),
 * then the legacy bwallet.space. It NEVER falls back to HandCash or any other service: a newcomer
 * would think handles are universal and pay a stranger. Ours only counts when the server knows the
 * alias (pki answers with a key). Unknown → a lookalike of ours ("did you mean"), else noSuchUser.
 */
export const resolveHandle = async (
  f: Fetch,
  p: { handle: string },
  domain: string = BWALLET_PAYMAIL_DOMAIN,
): Promise<Resolved> => {
  const input = `$${p.handle}`;
  const domains = [...new Set([domain.toLowerCase(), ...LEGACY_PAYMAIL_DOMAINS].filter(Boolean))];
  for (const d of domains) {
    if (!PAYMAIL_RE.test(`${p.handle}@${d}`)) continue;
    try {
      const ours = await resolvePaymail(f, `${p.handle}@${d}`, input);
      if (ours.pubkey) {
        const { external: _ours, ...rest } = ours; // our own domain, whatever the build calls it
        return rest;
      }
    } catch {
      /* not at this domain → next */
    }
  }
  const didYouMean = domain ? await ourLookalike(f, p.handle, domain) : undefined;
  if (didYouMean) throw new ResolveError(`${noSuchUser(input)}. Did you mean ${didYouMean}?`);
  throw new ResolveError(noSuchUser(input));
};

/** Swaps people mix up when reading a handle: 0↔o, 1↔l, 1↔i. Single swaps only, at most 8. */
export const lookalikes = (handle: string): string[] => {
  const swap: Record<string, string[]> = { '0': ['o'], o: ['0'], '1': ['l', 'i'], l: ['1'], i: ['1'] };
  const out = new Set<string>();
  for (let i = 0; i < handle.length && out.size < 8; i++)
    for (const r of swap[handle[i]] ?? []) out.add(handle.slice(0, i) + r + handle.slice(i + 1));
  out.delete(handle);
  return [...out];
};

/** The first lookalike of `handle` that IS one of our names, as `$name`, or undefined. */
export const ourLookalike = async (f: Fetch, handle: string, domain: string): Promise<string | undefined> => {
  const found = await Promise.all(
    lookalikes(handle).map(async (h) => {
      try {
        // Only "does our server know this alias" (pki answers with a key); payment capabilities don't matter here.
        const pki = str((await getCapabilities(f, domain))[CAP.pki]);
        const key = pki ? str((await tryJson<Fields>(f, fill(pki, h, domain)))?.pubkey) : undefined;
        return key ? `$${h}` : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return found.find(Boolean);
};

/** A raw public key: shown as "Public key 04678a…1d5f" (or its known label), paying the key's own P2PKH address. */
export const resolvePubKey = (key: string): Resolved => {
  const address = keyAddress(key);
  return {
    input: key,
    target: address,
    targetKind: 'address',
    via: 'pubkey',
    displayName: knownKeyLabel(key) ?? `Public key ${shortKey(key)}`,
    pubkey: compressedKey(key),
    rawKey: key,
    ordAddress: address,
  };
};

export const resolveRecipient = async (
  f: Fetch,
  p: Parsed,
  domain: string = BWALLET_PAYMAIL_DOMAIN,
): Promise<Resolved> => {
  switch (p.kind) {
    case 'address':
      return { input: p.address, target: p.address, targetKind: 'address', via: 'address', ordAddress: p.address };
    case 'pubkey':
      return resolvePubKey(p.key);
    case 'handle':
      return resolveHandle(f, p, domain);
    case 'paymail':
      return resolvePaymail(f, p.paymail);
    case 'opns':
      return resolveBareName(f, p.name, domain);
    default:
      throw new ResolveError(p.kind === 'invalid' ? p.reason : 'Enter a recipient');
  }
};

export const TOKENS_UNSUPPORTED = "This name can't receive tokens";

/** Pick the destination for a send. Tokens only go to a name with an ordinal-receive address. */
/**
 * "No binding, no payment" (OpNS docs; BWALLETX-MEDIA-SPEC §6.4): an OpNS name pays only once its holder has
 * published a binding to their identity key. Never fall back to whoever holds the name ordinal right now: a
 * sold, listed or never-published name would silently take the money.
 */
export const UNBOUND_NAME =
  "This name can't receive payments yet. Ask its owner to publish it, or pay their address instead.";

/** A bWalletX name whose served key doesn't match its owner's signed binding: never pay it. */
export const BAD_BINDING =
  "This name's signed binding doesn't match its key, so it may have been changed without its owner. Not paying it.";

/** BRC-169 4.4: the name points to a different key than before, with no signed handover. */
export const KEY_CHANGED =
  "This name now points to a different wallet than before, and its owner didn't sign a handover. Not paying it.";

export const destinationFor = (
  r: Resolved,
  asset: 'bsv' | 'token',
): { ok: true; to: string } | { ok: false; error: string } => {
  if (opnsBinding(r) === 'unbound') return { ok: false, error: UNBOUND_NAME };
  if (r.nameBinding === 'bad') return { ok: false, error: BAD_BINDING };
  if (r.nameBinding === 'changed') return { ok: false, error: KEY_CHANGED };
  if (asset === 'bsv') return { ok: true, to: r.target };
  if (r.ordAddress) return { ok: true, to: r.ordAddress };
  return { ok: false, error: TOKENS_UNSUPPORTED };
};

export type Availability =
  | { status: 'taken'; name: string; owner?: string; origin: string; listing?: { outpoint: string; price: number } }
  | { status: 'available'; name: string; mineFrom?: string }
  | { status: 'invalid'; name: string; reason: string };

/** Read-only OpNS availability: origin exists → taken; else the mine tree's nearest parent. */
export const checkOpnsAvailability = async (f: Fetch, raw: string): Promise<Availability> => {
  const name = raw.trim().toLowerCase().replace(/^@/, '');
  if (!OPNS_RE.test(name)) return { status: 'invalid', name, reason: 'Letters, numbers and - only' };
  const o = await tryJson<Outpoint>(f, `${SERVICES.opnsOrigin}/${encodeURIComponent(name)}`);
  const originOutpoint = str(o?.outpoint);
  if (originOutpoint) {
    const rec = await tryJson<OpnsRecord>(f, `${SERVICES.opnsApi}/${encodeURIComponent(name)}`);
    // For sale? The latest location carries an OrdLock listing (price in sats) while unspent.
    const latest = await tryJson<Inscription>(
      f,
      `${SERVICES.inscriptionLatest}/${originOutpoint.replace('.', '_')}/latest?script=false`,
    );
    const price = Number(latest?.data?.list?.price);
    const latestOutpoint = str(latest?.outpoint);
    const listing =
      price > 0 && !latest?.spend && latestOutpoint ? { outpoint: latestOutpoint.replace('_', '.'), price } : undefined;
    return {
      status: 'taken',
      name,
      origin: originOutpoint,
      owner: str(rec?.owner ?? latest?.owner),
      ...(listing && { listing }),
    };
  }
  const mine = await tryJson<Outpoint>(f, `${SERVICES.opnsMine}/${encodeURIComponent(name)}`);
  return { status: 'available', name, mineFrom: str(mine?.outpoint) };
};

/**
 * How a name is shown inside bWallet: our own paymail without "@<domain>" (alice@bwallet.space → alice).
 * Other domains, $handles and OpNS names are unchanged. The Receive screen shows the full address.
 */
export const bareName = (name: string, domain: string = BWALLET_PAYMAIL_DOMAIN) => {
  if (!name || !domain) return name;
  // bwallet.space is the earlier domain and bmailx.com the sibling; every name answers there too.
  for (const d of new Set([domain.toLowerCase(), ...alsoOurs()])) {
    const suffix = `@${d}`;
    if (name.toLowerCase().endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length);
  }
  return name;
};

/** bWallet-hosted paymail (name@BWALLET_PAYMAIL_DOMAIN), or undefined when paymail is off (docs/NAMES.md). */
export const bwalletPaymail = (name: string) =>
  BWALLET_PAYMAIL_DOMAIN ? `${name}@${BWALLET_PAYMAIL_DOMAIN}` : undefined;

/** Both addresses of one name, primary first: name@bwalletx.com, name@bmailx.com. [] when paymail is off. */
export const bwalletPaymails = (name: string, domain: string = BWALLET_PAYMAIL_DOMAIN): string[] =>
  domain ? [...new Set([domain.toLowerCase(), ...(SIBLING_PAYMAIL_DOMAINS ?? [])])].map((d) => `${name}@${d}`) : [];
