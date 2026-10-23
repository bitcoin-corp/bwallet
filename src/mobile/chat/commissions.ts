/**
 * Room COMMISSIONS — pure state for the in-stream Commission card (CommissionCard.tsx).
 *
 * Server: bit-sign feat/room-commissions (src/lib/commission-store.ts). A commission's reward is the room token,
 * locked on chain at posting (locks/tokenEscrow.ts); the poster accepts one delivery (first valid wins) and the
 * poster + room arbiter release it, or after the deadline the poster broadcasts the presigned refund.
 * The server never holds keys. No disputes or vote mode in this version.
 */
import type { RoleKey, WireProposal } from '../locks/tokenEscrow';

export type CommissionStatus = 'draft' | 'open' | 'accepted' | 'released' | 'expired' | 'refunded' | 'cancelled';

export interface CommissionEntry {
  id: string;
  handle: string;
  note: string | null;
  media_id: string | null;
  external_url: string | null;
  content_sha256: string | null;
  payout_address: string;
  status: 'submitted' | 'accepted' | 'rejected' | 'withdrawn';
  submitted_at: string;
}

export interface EscrowRow {
  id: string;
  token_id: string;
  amount: string;
  m: number;
  n: number;
  pubkeys: RoleKey[];
  poster_address: string;
  fund_txid: string | null;
  fund_raw_tx: string | null;
  vout: number | null;
  reserve_vout: number | null;
  refund_after_height: number | null;
  status: 'awaiting_funding' | 'funded' | 'released' | 'refunded';
  settled_txid: string | null;
}

export interface CommissionDetail {
  commission: {
    id: string;
    room_id: string;
    bounty_no: number;
    created_by: string;
    assignee: string | null;
    title: string;
    status: CommissionStatus;
    reward_token_id: string | null;
    reward_ticker: string | null;
    reward_token_raw: string | null;
    deadline_at: string | null;
    film_ref: string | null;
    deliverable_spec: string | null;
    content_rating: 'all_ages' | 'adult';
    contract_doc_hash: string | null;
  };
  terms: string;
  entries: CommissionEntry[];
  escrow: EscrowRow | null;
  proposals: {
    id: string;
    kind: 'release' | 'refund';
    entry_id: string | null;
    status: string;
    txid: string | null;
    ready: boolean;
    body: WireProposal;
  }[];
}

/** A room message that should render as a live Commission card (only the posting; later events stay as lines). */
export const commissionCardNo = (m: {
  event_type?: string | null;
  event_payload?: Record<string, unknown> | null;
}): number | null => {
  if (m.event_type !== 'commission_posted') return null;
  const n = Number(m.event_payload?.bounty_no);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Parse "/commission [$handle] <what>" from the composer. Null when it is not that command. */
export function parseCommissionCommand(text: string): { assignee: string | null; draft: string } | null {
  const m = /^\/commission(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const rest = (m[1] ?? '').trim();
  const h = /^\$([a-z0-9_.-]{1,40})\s*([\s\S]*)$/i.exec(rest);
  return h ? { assignee: h[1].toLowerCase(), draft: h[2].trim() } : { assignee: null, draft: rest };
}

/** "10M" / "2.5k" / "1,000,000" → whole display units (BigInt), then × 10^dec base units. Null when invalid. */
export function parseRewardAmount(input: string, dec: number): bigint | null {
  const s = input.trim().replace(/,/g, '').toLowerCase();
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/.exec(s);
  if (!m) return null;
  const mult = { '': 1n, k: 1_000n, m: 1_000_000n, b: 1_000_000_000n }[m[2] as '' | 'k' | 'm' | 'b'];
  const [int, frac = ''] = m[1].split('.');
  const scale = 10n ** BigInt(dec);
  const fracDigits = frac.length;
  const whole = BigInt(int + frac) * mult * scale;
  const out = whole / 10n ** BigInt(fracDigits);
  if (whole % 10n ** BigInt(fracDigits) !== 0n || out <= 0n) return null;
  return out;
}

export type CardAction =
  | { kind: 'fund' }
  | { kind: 'deliverer-key' }
  | { kind: 'enter' }
  | { kind: 'accept'; entryIds: string[] }
  | { kind: 'broadcast'; proposalId: string; label: string }
  | { kind: 'wait'; label: string }
  | { kind: 'none' };

/** What the card offers ME right now. `height` is the current block height (0 = unknown). */
export function cardAction(d: CommissionDetail, me: string, height: number, now: Date): CardAction {
  const c = d.commission;
  const poster = c.created_by === me;
  const e = d.escrow;
  if (c.status === 'draft') {
    if (c.assignee && c.assignee === me && !e?.pubkeys.some((k) => k.role === 'deliverer'))
      return { kind: 'deliverer-key' };
    if (!poster) return { kind: 'wait', label: 'Waiting for the poster to lock the reward' };
    if (c.assignee && !e?.pubkeys.some((k) => k.role === 'deliverer'))
      return { kind: 'wait', label: `Waiting for $${c.assignee} to sign the terms` };
    return { kind: 'fund' };
  }
  const ready = d.proposals.find(
    (p) =>
      p.ready &&
      p.status !== 'broadcast' &&
      (p.kind === 'release' || (p.kind === 'refund' && height >= (e?.refund_after_height ?? Infinity))),
  );
  if (ready && (poster || d.entries.some((x) => x.id === ready.entry_id && x.handle === me)))
    return {
      kind: 'broadcast',
      proposalId: ready.id,
      label: ready.kind === 'release' ? 'Broadcast the release' : 'Reclaim (refund)',
    };
  if (c.status === 'open') {
    const pastDeadline = !!c.deadline_at && new Date(c.deadline_at).getTime() <= now.getTime();
    if (poster) {
      const open = d.entries.filter((x) => x.status === 'submitted').map((x) => x.id);
      return open.length
        ? { kind: 'accept', entryIds: open }
        : { kind: 'wait', label: pastDeadline ? 'Expired — refund unlocks soon' : 'No deliveries yet' };
    }
    if (pastDeadline) return { kind: 'none' };
    if (c.assignee && c.assignee !== me) return { kind: 'none' };
    if (d.entries.some((x) => x.handle === me)) return { kind: 'wait', label: 'Your delivery is in' };
    return { kind: 'enter' };
  }
  if (c.status === 'expired' && poster) {
    const open = d.entries.filter((x) => x.status === 'submitted').map((x) => x.id);
    if (open.length) return { kind: 'accept', entryIds: open };
    return {
      kind: 'wait',
      label: e?.refund_after_height
        ? `Refund unlocks at block ${e.refund_after_height.toLocaleString('en-GB')}`
        : 'Refund pending',
    };
  }
  if (c.status === 'accepted') return { kind: 'wait', label: 'Accepted — waiting for the arbiter’s co-signature' };
  return { kind: 'none' };
}

export const statusLabel: Record<CommissionStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  accepted: 'Accepted',
  released: 'Released',
  expired: 'Expired',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
};

/** Countdown text for the card. */
export function deadlineText(deadlineAt: string | null, now: Date): string {
  if (!deadlineAt) return '';
  const ms = new Date(deadlineAt).getTime() - now.getTime();
  if (ms <= 0) return 'closed';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}

/** sha256 hex of a file (the delivery's hash; bit-sign finds the uploaded room media by it). */
export async function sha256Hex(file: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 hex of a string (to check the server's terms text against its doc hash before signing). */
export async function sha256Text(s: string): Promise<string> {
  return sha256Hex(new Blob([new TextEncoder().encode(s)]));
}
