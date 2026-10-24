/**
 * bMail routing and ranking (pure). Owner, 9 Oct 2026: "Penny post": the default price to reach anyone is 1¢.
 * Friends write free and sit on top; strangers who paid at least my price land in Inbox ranked by verified
 * postage, highest first; everything else (unstamped, under-priced, unverified, airdrops) goes to Requests.
 */

export const PENNY_POST_USD = 0.01;
/** Postage tiers as multiples of the recipient's price (owner, 9 Oct). */
export const TIERS = [
  { id: 'standard', label: 'Standard', mult: 1 },
  { id: 'priority', label: 'Priority', mult: 3 },
  // TODO(bmail receipts): Certified = price + receipt fee, needs signed open receipts (BMAIL.md §5.2).
] as const;
export type TierId = (typeof TIERS)[number]['id'];

export type MailMeta = {
  id: string;
  from: string;
  at: number;
  /** Postage verified on receipt (0 = unstamped or failed verification). */
  verifiedSats: number;
  /** A reply that uses a reply-paid credit I prepaid: counts as stamped. */
  replyCredit?: boolean;
};

/**
 * Whether an incoming letter may ride on a reply-paid credit I prepaid: it cites a letter I sent to this sender with
 * reply-paid postage, and that credit has not paid for another letter already. One credit, one reply (b-Aware report,
 * 24 Oct 2026: one credit was replayable forever). `used` holds the ids of my letters whose credit is spent.
 */
export const replyCreditOk = (
  env: { from: string; inReplyTo?: string; usesReplyCredit?: boolean },
  sent: readonly { id: string; to: string; replyPaidSats: number }[],
  used: ReadonlySet<string>,
): boolean => {
  if (!env.usesReplyCredit || !env.inReplyTo || used.has(env.inReplyTo)) return false;
  return sent.some((s) => s.id === env.inReplyTo && s.to === env.from && s.replyPaidSats > 0);
};

export type Box = 'inbox' | 'requests';

export const route = (m: MailMeta, o: { isFriend: (key: string) => boolean; priceSats: number }): Box => {
  if (o.isFriend(m.from) || m.replyCredit) return 'inbox';
  if (m.verifiedSats > 0 && m.verifiedSats >= o.priceSats) return 'inbox';
  return 'requests';
};

/** Friends first (newest first among them), then by verified postage highest first, ties newest. */
export const rank = <T extends MailMeta>(mail: T[], o: { isFriend: (key: string) => boolean; newest?: boolean }): T[] =>
  [...mail].sort((a, b) => {
    if (o.newest) return b.at - a.at;
    const fa = o.isFriend(a.from) || !!a.replyCredit ? 1 : 0;
    const fb = o.isFriend(b.from) || !!b.replyCredit ? 1 : 0;
    if (fa !== fb) return fb - fa;
    if (!fa && a.verifiedSats !== b.verifiedSats) return b.verifiedSats - a.verifiedSats;
    return b.at - a.at;
  });

export const split = <T extends MailMeta>(
  mail: T[],
  o: { isFriend: (key: string) => boolean; priceSats: number; newest?: boolean },
): { inbox: T[]; requests: T[] } => {
  const inbox: T[] = [];
  const requests: T[] = [];
  for (const m of mail) (route(m, o) === 'inbox' ? inbox : requests).push(m);
  return { inbox: rank(inbox, o), requests: rank(requests, o) };
};

/** The sender's quote: tier sats from the recipient's price, plus optional reply-paid credit (my own price). */
export const quote = (priceSats: number, tier: TierId, replyPaidSats = 0) => {
  const mult = TIERS.find((t) => t.id === tier)?.mult ?? 1;
  const stamp = Math.max(1, Math.ceil(priceSats * mult));
  return { stamp, replyPaid: replyPaidSats, total: stamp + replyPaidSats };
};

/** Weighting controls on Inbox / Requests (owner, 9 Oct: "any filters for weighting?"). */
export type SortMode = 'paid' | 'newest' | 'friends' | 'spreading';
export type MailFilter = 'all' | 'paid' | 'tokens' | 'contracts' | 'invoices' | 'receipts';
export const FILTERS: { id: MailFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'paid', label: 'Paid' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'receipts', label: 'Receipts' },
];

/** The amount a mail row shows: verified postage (stamp + reply-paid + attached payment, all in verifiedSats). */
export const shownSats = (m: MailMeta): number => Math.max(0, m.verifiedSats);

/** Friends and reply-paid replies: free, and always pinned on top of the Inbox (owner rule). */
export const isPinned = (m: MailMeta, isFriend: (key: string) => boolean): boolean =>
  isFriend(m.from) || !!m.replyCredit;

/**
 * Sort real mail. Letters I pinned (swipe → Pin) come first, then friends (and reply-paid replies) in a group, then
 * everyone else; every group follows the chosen sort. Most paid = verified postage highest first (ties newest);
 * Newest = time only. "Friends" is a filter: only my pins and friends. Spreading needs token holder/forward counts
 * real mail does not carry yet, so it falls back to newest. TODO(bmail tokens): rank by holders/forwards.
 */
export const sortMail = <T extends MailMeta & { pinned?: boolean }>(
  mail: T[],
  mode: SortMode,
  isFriend: (key: string) => boolean,
): T[] => {
  // The amount the row shows (verified postage, reply-paid included): Most paid sorts by exactly that.
  const by = mode === 'paid' ? (a: T, b: T) => shownSats(b) - shownSats(a) || b.at - a.at : (a: T, b: T) => b.at - a.at;
  const byTime = (a: T, b: T) => b.at - a.at;
  const mine = mail.filter((m) => m.pinned).sort(mode === 'friends' ? byTime : by);
  const friends = mail.filter((m) => !m.pinned && isPinned(m, isFriend)).sort(mode === 'friends' ? byTime : by);
  if (mode === 'friends') return [...mine, ...friends];
  const rest = mail.filter((m) => !m.pinned && !isPinned(m, isFriend)).sort(by);
  return [...mine, ...friends, ...rest];
};

/**
 * Filter real mail. Only "Paid" can be told from the envelope today; tokens, contracts, invoices and receipts are not
 * parsed from real mail yet, so those filters show nothing real. TODO(bmail tokens/docs): envelope fields for these.
 */
export const filterMail = <T extends MailMeta>(mail: T[], f: MailFilter): T[] =>
  f === 'all' ? mail : f === 'paid' ? mail.filter((m) => m.verifiedSats > 0 || !!m.replyCredit) : [];
