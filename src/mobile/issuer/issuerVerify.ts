import { Transaction } from '@bsv/sdk';
import { BCHAT_ORIGIN } from '../chat/api';
import { lookupPaymail } from '../names/paymail';
import type { Fetch } from '../names/names';
import { isTokenId, normTokenId, verifyIssueTx } from './issuer';
import { officialToken } from '../tokens/officialTokens';

/**
 * "Issued by $handle ✓": given a token id, fetch its deploy/mint tx, verify the issuer
 * signature locally (issuer.ts — nothing trusted), then resolve the signing identity key to a
 * name: bit-sign's issuer registry (handle + KYC, which bit-sign itself re-verified from the
 * tx), falling back to the key's bwallet paymail. Cached in memory + localStorage.
 */
export interface IssuerInfo {
  tokenId: string;
  status: 'verified' | 'unverified' | 'unknown';
  identityKey?: string;
  handle?: string | null;
  paymail?: string | null;
  kyc?: boolean;
  /** bit-sign has the issuer on record (independent server-side verification). */
  registered?: boolean;
  ticker?: string | null;
  /** First-party token pinned by exact id in the wallet (tokens/officialTokens): the issuer's name. */
  official?: string;
  reason?: string;
  at: number;
}

export const WOC_TX_HEX = (txid: string) => `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`;
export const REGISTRY = `${BCHAT_ORIGIN}/api/bitsign/issuers`;
const VERIFIED_TTL = 24 * 3600_000;
const UNVERIFIED_TTL = 3600_000;
const UNKNOWN_TTL = 5 * 60_000;
const LS = 'bwallet.issuer.v1.';

const mem = new Map<string, IssuerInfo>();
// WhatsOnChain rate-limits; a wallet list can ask for dozens of tokens at once.
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>, max = 2): Promise<T> {
  if (active >= max) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
const inflight = new Map<string, Promise<IssuerInfo>>();

const ttl = (i: IssuerInfo) =>
  i.status === 'verified' ? VERIFIED_TTL : i.status === 'unverified' ? UNVERIFIED_TTL : UNKNOWN_TTL;

/** A first-party token (exact id compiled into the wallet): vouched for by the wallet, not the mint tx. */
function officialIssuer(id: string, now: number): IssuerInfo | null {
  const o = officialToken(id);
  return o ? { tokenId: id, status: 'verified', official: o.issuer, registered: true, at: now } : null;
}

export function cachedIssuer(tokenId: string, now = Date.now()): IssuerInfo | null {
  const id = normTokenId(tokenId);
  const off = officialIssuer(id, now);
  if (off) return off;
  let i = mem.get(id) ?? null;
  if (!i) {
    try {
      const raw = globalThis.localStorage?.getItem(LS + id);
      if (raw) i = JSON.parse(raw) as IssuerInfo;
    } catch {
      /* storage blocked */
    }
  }
  if (!i || now - i.at > ttl(i)) return null;
  mem.set(id, i);
  return i;
}

function store(i: IssuerInfo) {
  mem.set(i.tokenId, i);
  try {
    if (i.status !== 'unknown') globalThis.localStorage?.setItem(LS + i.tokenId, JSON.stringify(i));
  } catch {
    /* storage blocked */
  }
}

export const clearIssuerCache = () => mem.clear();

type RegistryRow = { handle?: string | null; kyc_verified?: boolean; identity_key?: string; verified?: boolean };

async function registryLookup(f: Fetch, tokenId: string): Promise<RegistryRow | null> {
  try {
    const r = await f(`${REGISTRY}/${tokenId}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { issuer?: RegistryRow };
    return j?.issuer ?? null;
  } catch {
    return null;
  }
}

export async function verifyIssuer(tokenId: string, f: Fetch = fetch, now = Date.now()): Promise<IssuerInfo> {
  const id = normTokenId(tokenId);
  if (!isTokenId(id)) return { tokenId: id, status: 'unknown', reason: 'not a token id', at: now };
  const off = officialIssuer(id, now);
  if (off) return off;
  const hit = cachedIssuer(id, now);
  if (hit) return hit;
  const running = inflight.get(id);
  if (running) return running;
  const p = (async (): Promise<IssuerInfo> => {
    let tx: Transaction;
    try {
      const hex = await limited(async () => {
        const r = await f(WOC_TX_HEX(id.split('_')[0]), { signal: AbortSignal.timeout(12_000) });
        if (!r.ok) throw new Error(`tx ${r.status}`);
        return (await r.text()).trim();
      });
      tx = Transaction.fromHex(hex);
    } catch (e) {
      return { tokenId: id, status: 'unknown', reason: String((e as Error)?.message || e), at: now };
    }
    const v = verifyIssueTx(tx, id);
    if (!v.ok) return { tokenId: id, status: 'unverified', reason: v.reason, at: now };
    const [reg, paymail] = await Promise.all([
      registryLookup(f, id),
      lookupPaymail(f, v.identityKey).catch(() => undefined),
    ]);
    // Only trust the registry's name if it agrees on WHO signed.
    const agree = reg && (!reg.identity_key || reg.identity_key.toLowerCase() === v.identityKey);
    return {
      tokenId: id,
      status: 'verified',
      identityKey: v.identityKey,
      handle: (agree && reg?.handle) || (paymail ? paymail.split('@')[0] : null),
      paymail: paymail ?? null,
      kyc: !!(agree && reg?.kyc_verified),
      registered: !!agree,
      ticker: v.ticker,
      at: now,
    };
  })();
  inflight.set(id, p);
  try {
    const i = await p;
    store(i);
    return i;
  } finally {
    inflight.delete(id);
  }
}

/** Badge text. */
export function issuerLabel(i: IssuerInfo | null | undefined): { text: string; verified: boolean } {
  if (!i || i.status === 'unknown') return { text: 'Checking issuer…', verified: false };
  if (i.status !== 'verified') return { text: 'Unverified issuer', verified: false };
  if (i.official) return { text: `Issued by ${i.official} · official`, verified: true };
  const who = i.handle ? `$${i.handle.replace(/^\$/, '')}` : `${i.identityKey?.slice(0, 8)}…`;
  return { text: `Issued by ${who}${i.kyc ? ' · KYC' : ''}`, verified: true };
}

/** "Several tokens use $TESTY — check the issuer" when one ticker maps to more than one token id. */
export function sharedTickerWarning(ticker: string | null | undefined, tokenIds: Iterable<string>): string | null {
  const ids = new Set([...tokenIds].map(normTokenId));
  if (!ticker || ids.size < 2) return null;
  return `Several tokens use $${ticker.replace(/^\$/, '').toUpperCase()} — check the issuer`;
}

/** Group token ids by ticker (case-insensitive) → tickers shared by 2+ ids. */
export function duplicateTickers(
  items: Iterable<{ ticker?: string | null; tokenId?: string | null }>,
): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  for (const it of items) {
    const t = (it.ticker || '').replace(/^\$/, '').toUpperCase();
    if (!t || !it.tokenId) continue;
    if (!by.has(t)) by.set(t, new Set());
    by.get(t)!.add(normTokenId(it.tokenId));
  }
  for (const [t, s] of by) if (s.size < 2) by.delete(t);
  return by;
}

/**
 * After a broadcast: ask bit-sign to verify + record the issuer (best-effort, never throws).
 * The indexer may not have the tx for a few seconds, so it retries; `rawtx` (hex) skips the wait.
 */
export async function registerIssuer(
  tokenId: string,
  opts: { rawtx?: string; f?: Fetch; delays?: number[] } = {},
): Promise<boolean> {
  const f = opts.f ?? fetch;
  const id = normTokenId(tokenId);
  for (const d of opts.delays ?? [3000, 20_000, 90_000]) {
    await new Promise((r) => setTimeout(r, d));
    try {
      const r = await f(`${REGISTRY}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: id, ...(opts.rawtx ? { rawtx: opts.rawtx } : {}) }),
      });
      if (r.ok) return true;
      if (r.status === 400 || r.status === 422) return false; // unsigned / not ours: retrying won't help
    } catch {
      /* network: retry */
    }
  }
  return false;
}
