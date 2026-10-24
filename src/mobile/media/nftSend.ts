/**
 * Two-step NFT send (owner, 12 Oct 2026: "three clicks could be two"): 1) pick the recipient, 2) one "Send to <name>"
 * button. Pure state → button, so the rules are testable.
 */
export type NftSendState = {
  /** Resolved destination address ('' until the name box resolves one). */
  to: string;
  /** Name the box resolved ($b0asey, a paymail, or the address itself). */
  name?: string;
  status: 'empty' | 'typing' | 'loading' | 'error' | 'ready';
  busy: boolean;
  /** false = the NFT's transaction never reached the network (unbroadcast.ts): it can't be sent. */
  onChain: boolean | null;
  /** The resolved recipient is this wallet (its identity key or one of its addresses): nothing to send. */
  isSelf?: boolean;
  /** Queued for the network but not on chain yet ('sending' / 'unprocessed'): Send unlocks once it lands. */
  pending?: boolean;
};

export type NftSendButton = { label: string; enabled: boolean };

const shortAddr = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);

export const SELF_SEND_TEXT = "That's you — it's already in your wallet";
export const PENDING_SEND_TEXT = 'Still going out — Send unlocks in a moment';
export const PENDING_CARD_TEXT = 'Your card is still going out — Send unlocks in a moment';

export const nftSendButton = (s: NftSendState): NftSendButton => {
  if (s.pending) return { label: PENDING_SEND_TEXT, enabled: false };
  if (s.onChain === false) return { label: 'Not on the blockchain yet', enabled: false };
  if (s.busy) return { label: 'Sending…', enabled: false };
  if (s.status === 'loading') return { label: 'Finding…', enabled: false };
  if (s.status !== 'ready' || !s.to) return { label: 'Choose who gets it', enabled: false };
  if (s.isSelf) return { label: SELF_SEND_TEXT, enabled: false };
  const who = s.name && s.name !== s.to ? s.name : shortAddr(s.to);
  return { label: `Send to ${who}`, enabled: true };
};

export type OwnKeys = { identityPubKey?: string; addresses?: string[] };

/** True when the recipient (resolved identity key or destination address) belongs to this wallet. */
export const isSelfRecipient = (r: { to?: string; pubkey?: string; ordAddress?: string }, own: OwnKeys): boolean => {
  const key = (r.pubkey || '').toLowerCase();
  if (key && own.identityPubKey && key === own.identityPubKey.toLowerCase()) return true;
  const mine = new Set((own.addresses || []).filter(Boolean));
  return [r.to, r.ordAddress].some((a) => !!a && mine.has(a));
};

/** "Use as my bAvatar" only while the image NFT is still ours: not sent, not burned, not still going out. */
export const canUseAsAvatar = (kind: string, s: { sent: boolean; burned: boolean; pending: boolean }) =>
  kind === 'images' && !s.sent && !s.burned && !s.pending;

export { shortAddr };
