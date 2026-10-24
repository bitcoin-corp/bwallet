/**
 * Airdrops inbox (owner, 8 Oct 2026): tokens and NFTs that arrived without the user doing anything.
 *
 * Unsolicited = a History v2 row (wallet/historyEvents.ts) of type 'transfer-in': a 1-sat token or NFT output
 * paid to one of our addresses by a tx we did not fund, with no action record of our own (a purchase, mint,
 * launch, recovery or swap always has one). Pure and persisted per account in localStorage.
 */
import type { Asset } from '../wallet/historyEvents';
import type { HistoryRow, RawTx } from '../wallet/txHistory';
import { dropMarker } from './note';
import { quarantinedNfts, quarantinedTokenIds } from './quarantine';

/** A plain BSV airdrop (holder drop): `qty` is the sats paid to us. */
export type BsvDropAsset = { kind: 'bsv'; id: 'bsv'; qty: string };
export type InboxAsset = Asset | BsvDropAsset;

export type AirdropItem = {
  /** `txid:assetId`, stable across reloads. */
  key: string;
  txid: string;
  time: number;
  asset: InboxAsset;
  /** BSV airdrop: the token whose holders were paid (from the tx's marker), when named. */
  holdersOf?: string;
  /**
   * BSV airdrop: it landed on one of the account's fixed (legacy) addresses, which the balance does not scan, so it
   * must be moved into the balance (Sweep) before it can be spent. False: it is already in the balance.
   */
  needsMove?: boolean;
  /** Who it's from: the token id for a token (one issuer per deploy), else the sending address. */
  issuer: string;
  from: string;
  /** The issuer's note, read from an OP_RETURN in the same tx (note.ts). Plain text, ≤280 chars. */
  note?: string;
  /** NFT: where it sits now, at our address (`txid_vout`). asset.id is the outpoint it came from. */
  outpoint?: string;
  /** The public key the sender revealed when spending (sender.ts): reverse-looked-up to a $name. */
  senderKey?: string;
};

export type InboxState = {
  /** Unix ms the inbox was last opened; items newer than this count toward the badge. */
  seenAt: number;
  kept: string[];
  hidden: string[];
  hiddenIssuers: string[];
  /** Only show airdrops from issuers whose airdrops you kept before. */
  onlyKnown: boolean;
  /** Issuers you chose to trust ("Trust this sender"): their airdrops skip Quarantine. */
  trustedIssuers?: string[];
};
export const emptyInbox = (): InboxState => ({ seenAt: 0, kept: [], hidden: [], hiddenIssuers: [], onlyKnown: false });

/** True for a token or NFT that arrived unsolicited (see top). `hasLocal`: the wallet has an action record for the tx. */
export const isUnsolicited = (row: Pick<HistoryRow, 'type' | 'asset' | 'direction'>, hasLocal: boolean) =>
  !!row.asset && row.type === 'transfer-in' && !hasLocal && row.direction !== 'out';

export const toItems = (rows: HistoryRow[], hasLocal: (txid: string) => boolean): AirdropItem[] => {
  const seen = new Set<string>();
  const out: AirdropItem[] = [];
  for (const r of rows) {
    if (!r.asset || !isUnsolicited(r, hasLocal(r.txid))) continue;
    const key = `${r.txid}:${r.asset.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const issuer = r.asset.kind === 'token' && r.asset.id ? r.asset.id : r.counterparty || r.asset.id;
    out.push({ key, txid: r.txid, time: r.time, asset: r.asset, issuer, from: r.counterparty });
  }
  return out.sort((a, b) => b.time - a.time);
};

/**
 * BSV airdrops (owner, 18 Oct 2026): a payment in that we did not fund, with no action record of our own, whose tx
 * carries the bWalletX airdrop note or marker (note.ts dropMarker). Ordinary payments carry no marker and never
 * show. `legacy`: the account's fixed addresses (ord / pay / identity), which need a Sweep to reach the balance.
 */
export const bsvDropItems = (
  rows: Pick<HistoryRow, 'txid' | 'time' | 'direction' | 'asset' | 'counterparty'>[],
  txs: Map<string, RawTx>,
  opts: { own: Set<string>; legacy: Set<string>; funded: (tx: RawTx) => boolean; hasLocal: (txid: string) => boolean },
): AirdropItem[] => {
  const out: AirdropItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.asset || r.direction !== 'in' || opts.hasLocal(r.txid) || seen.has(r.txid)) continue;
    const tx = txs.get(r.txid);
    if (!tx || opts.funded(tx)) continue;
    const marker = dropMarker(tx.vout);
    if (!marker) continue;
    // Only plain outputs to us (a 1-sat output is a token or NFT, handled by toItems).
    const mine = tx.vout.filter((o) => o.sats > 1 && o.addresses.some((a) => opts.own.has(a)));
    const sats = mine.reduce((n, o) => n + o.sats, 0);
    if (!sats) continue;
    seen.add(r.txid);
    out.push({
      key: `${r.txid}:bsv`,
      txid: r.txid,
      time: r.time,
      asset: { kind: 'bsv', id: 'bsv', qty: String(sats) },
      issuer: marker.tokenId ?? r.counterparty,
      from: r.counterparty,
      ...(marker.tokenId ? { holdersOf: marker.tokenId } : {}),
      needsMove: mine.some((o) => o.addresses.some((a) => opts.legacy.has(a))),
    });
  }
  return out;
};

/** Items still in the inbox: not kept, not hidden, issuer not hidden, and (onlyKnown) from a known issuer. */
export const visibleItems = (items: AirdropItem[], s: InboxState): AirdropItem[] => {
  const kept = new Set(s.kept);
  const hidden = new Set(s.hidden);
  const badIssuers = new Set(s.hiddenIssuers);
  const trusted = new Set(s.trustedIssuers ?? []);
  const knownIssuers = new Set(items.filter((i) => kept.has(i.key)).map((i) => i.issuer));
  return items.filter(
    (i) =>
      !kept.has(i.key) &&
      !hidden.has(i.key) &&
      !badIssuers.has(i.issuer) &&
      !trusted.has(i.issuer) &&
      (!s.onlyKnown || knownIssuers.has(i.issuer)),
  );
};

/**
 * Kept NFTs (kept, or from a trusted sender): out of Quarantine, so Wallet › NFTs must show them (AirdropsInbox
 * and MediaSection list the ones the wallet's own NFT list does not have yet, with the reason).
 */
export const keptNfts = (items: AirdropItem[], s: Pick<InboxState, 'kept' | 'trustedIssuers'>): AirdropItem[] => {
  const kept = new Set(s.kept);
  const trusted = new Set(s.trustedIssuers ?? []);
  return items.filter((i) => i.asset.kind === 'nft' && (kept.has(i.key) || trusted.has(i.issuer)));
};

/** True when the wallet's NFT list (its ordinals basket) already holds this airdrop: same outpoint, or same tx. */
export const inWalletList = (item: Pick<AirdropItem, 'txid' | 'outpoint'>, walletOutpoints: Iterable<string>) => {
  for (const o of walletOutpoints) {
    const op = o.toLowerCase().replace('.', '_');
    if ((item.outpoint && op === item.outpoint.toLowerCase()) || op.split('_')[0] === item.txid.toLowerCase())
      return true;
  }
  return false;
};

/**
 * One line for bMail Inbox / Requests pointing at Quarantine, where airdrops live (owner, 12 Oct 2026: found them
 * "as bMails in my inbox" but they were in Quarantine). null when there are none.
 */
export const airdropPointer = (visible: Pick<AirdropItem, 'asset'>[]): string | null => {
  if (!visible.length) return null;
  const nfts = visible.filter((i) => i.asset.kind === 'nft').length;
  const toks = visible.length - nfts;
  const parts = [
    nfts ? `${nfts} NFT${nfts === 1 ? '' : 's'}` : '',
    toks ? `${toks} token airdrop${toks === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `${parts.join(' and ')} sent to you without asking ${visible.length === 1 ? 'waits' : 'wait'} in Quarantine.`;
};

/** Badge: visible items that arrived after the inbox was last opened. */
export const badgeCount = (items: AirdropItem[], s: InboxState) =>
  visibleItems(items, s).filter((i) => i.time > s.seenAt).length;

export const keep = (s: InboxState, key: string): InboxState => ({ ...s, kept: [...new Set([...s.kept, key])] });
/** Hide one item and every future item from its issuer. */
export const hide = (s: InboxState, item: Pick<AirdropItem, 'key' | 'issuer'>): InboxState => ({
  ...s,
  hidden: [...new Set([...s.hidden, item.key])],
  hiddenIssuers: [...new Set([...s.hiddenIssuers, item.issuer])],
});
/** Hide from the inbox. A BSV airdrop hides only its card (the money is the user's either way); others hide(). */
export const hideItem = (s: InboxState, item: Pick<AirdropItem, 'key' | 'issuer' | 'asset'>): InboxState =>
  item.asset.kind === 'bsv' ? { ...s, hidden: [...new Set([...s.hidden, item.key])] } : hide(s, item);
export const markSeen = (s: InboxState, now = Date.now()): InboxState => ({ ...s, seenAt: now });

// ─── Persistence ─────────────────────────────────────────────────────────────

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const store = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const stateKey = (account: string) => `bw-airdrops:${account}`;
const itemsKey = (account: string) => `bw-airdrops-items:${account}`;

export const loadInbox = (account: string, st: Store | null = store()): InboxState => {
  try {
    const j = JSON.parse(st?.getItem(stateKey(account)) ?? 'null') as Partial<InboxState> | null;
    return { ...emptyInbox(), ...(j ?? {}) };
  } catch {
    return emptyInbox();
  }
};
export const saveInbox = (account: string, s: InboxState, st: Store | null = store()) => {
  try {
    st?.setItem(stateKey(account), JSON.stringify(s));
  } catch {
    /* storage full or blocked: the inbox still works this session */
  }
  emit();
};
export const loadItems = (account: string, st: Store | null = store()): { items: AirdropItem[]; at: number } => {
  try {
    const j = JSON.parse(st?.getItem(itemsKey(account)) ?? 'null') as { items: AirdropItem[]; at: number } | null;
    return j && Array.isArray(j.items) ? j : { items: [], at: 0 };
  } catch {
    return { items: [], at: 0 };
  }
};
export const saveItems = (account: string, items: AirdropItem[], at: number, st: Store | null = store()) => {
  try {
    st?.setItem(itemsKey(account), JSON.stringify({ items: items.slice(0, 500), at }));
  } catch {
    /* ignore */
  }
  emit();
};

/** Token ids the wallet holds by its own doing (History rows that are not unsolicited transfers in). */
const solicitedKey = (account: string) => `bw-airdrops-solicited:${account}`;
/** null until the first History scan since Quarantine shipped (then nothing is quarantined: see quarantineFor). */
export const loadSolicited = (account: string, st: Store | null = store()): string[] | null => {
  try {
    const j = JSON.parse(st?.getItem(solicitedKey(account)) ?? 'null') as unknown;
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
};
export const saveSolicited = (account: string, ids: string[], st: Store | null = store()) => {
  try {
    st?.setItem(solicitedKey(account), JSON.stringify(ids.slice(0, 2000)));
  } catch {
    /* ignore */
  }
};

/**
 * Quarantined token ids for an account (quarantine.ts), from local state only. Until History has been scanned
 * once with Quarantine (solicited unknown) nothing is quarantined, so a token you bought is never hidden by mistake.
 */
export const quarantineFor = (account: string, st: Store | null = store()): Set<string> => {
  const solicited = account ? loadSolicited(account, st) : null;
  return solicited ? quarantinedTokenIds(loadItems(account, st).items, loadInbox(account, st), solicited) : new Set();
};
let activeAccount = '';
/** The account whose Quarantine the send/list paths honour (set by useAirdrops and the wallet page). */
export const setQuarantineAccount = (account: string) => {
  activeAccount = account || activeAccount;
};
export const activeQuarantine = (): Set<string> => quarantineFor(activeAccount);
/** Quarantined NFT outpoints (normalised txid_vout) for the active account. */
export const activeNftQuarantine = (st: Store | null = store()): Set<string> =>
  activeAccount ? quarantinedNfts(loadItems(activeAccount, st).items, loadInbox(activeAccount, st)) : new Set();

/** Kept (or trusted-sender) NFTs for the active account. */
export const activeKeptNfts = (st: Store | null = store()): AirdropItem[] =>
  activeAccount ? keptNfts(loadItems(activeAccount, st).items, loadInbox(activeAccount, st)) : [];

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const subscribeInbox = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
