import { describe, expect, test } from 'bun:test';
import {
  cardAction,
  commissionCardNo,
  deadlineText,
  parseCommissionCommand,
  parseRewardAmount,
  sha256Text,
  type CommissionDetail,
} from './commissions';

const now = new Date('2026-10-23T12:00:00Z');
const base = (
  over: Partial<CommissionDetail['commission']> = {},
  rest: Partial<CommissionDetail> = {},
): CommissionDetail => ({
  commission: {
    id: 'c1',
    room_id: 'r1',
    bounty_no: 4,
    created_by: 'ann',
    assignee: null,
    title: 'Scene 4',
    status: 'open',
    reward_token_id: 'a'.repeat(64) + '_0',
    reward_ticker: 'FILM',
    reward_token_raw: '10000000',
    deadline_at: '2026-10-30T12:00:00Z',
    film_ref: null,
    deliverable_spec: 'a clip',
    content_rating: 'all_ages',
    contract_doc_hash: 'ab',
    ...over,
  },
  terms: '',
  entries: [],
  escrow: {
    id: 'e1',
    token_id: 'x',
    amount: '1',
    m: 2,
    n: 2,
    pubkeys: [],
    poster_address: '1x',
    fund_txid: 't',
    fund_raw_tx: '',
    vout: 0,
    reserve_vout: 1,
    refund_after_height: 900_144,
    status: 'funded',
    settled_txid: null,
  },
  proposals: [],
  ...rest,
});
const entry = (handle: string, id = 'n1') => ({
  id,
  handle,
  note: null,
  media_id: null,
  external_url: null,
  content_sha256: null,
  payout_address: '1y',
  status: 'submitted' as const,
  submitted_at: '',
});

describe('commission card', () => {
  test('only the posting renders as a live card', () => {
    expect(commissionCardNo({ event_type: 'commission_posted', event_payload: { bounty_no: 4 } })).toBe(4);
    expect(commissionCardNo({ event_type: 'commission_entry', event_payload: { bounty_no: 4 } })).toBeNull();
  });
  test('/commission parses an optional $assignee', () => {
    expect(parseCommissionCommand('/commission make scene 4')).toEqual({ assignee: null, draft: 'make scene 4' });
    expect(parseCommissionCommand('/commission $Ben edit the trailer')).toEqual({
      assignee: 'ben',
      draft: 'edit the trailer',
    });
    expect(parseCommissionCommand('/bounty x')).toBeNull();
  });
  test('reward amounts', () => {
    expect(parseRewardAmount('10M', 0)).toBe(10_000_000n);
    expect(parseRewardAmount('2.5k', 2)).toBe(250_000n);
    expect(parseRewardAmount('1,000', 0)).toBe(1000n);
    expect(parseRewardAmount('0.001', 2)).toBeNull();
    expect(parseRewardAmount('abc', 0)).toBeNull();
  });
  test('poster funds a draft; others wait', () => {
    expect(cardAction(base({ status: 'draft' }), 'ann', 0, now).kind).toBe('fund');
    expect(cardAction(base({ status: 'draft' }), 'ben', 0, now).kind).toBe('wait');
  });
  test('directed draft: the assignee signs first', () => {
    const d = base({ status: 'draft', assignee: 'ben' });
    expect(cardAction(d, 'ben', 0, now).kind).toBe('deliverer-key');
    expect(cardAction(d, 'ann', 0, now).kind).toBe('wait');
  });
  test('open: entrants enter once, poster accepts', () => {
    expect(cardAction(base(), 'ben', 0, now).kind).toBe('enter');
    expect(cardAction(base({}, { entries: [entry('ben')] }), 'ben', 0, now).kind).toBe('wait');
    expect(cardAction(base({}, { entries: [entry('ben')] }), 'ann', 0, now)).toEqual({
      kind: 'accept',
      entryIds: ['n1'],
    });
    expect(cardAction(base({ assignee: 'cat' }), 'ben', 0, now).kind).toBe('none');
  });
  test('refund is offered only once the block height reaches it', () => {
    const p = {
      id: 'p1',
      kind: 'refund' as const,
      entry_id: null,
      status: 'ready',
      txid: null,
      ready: true,
      body: {} as never,
    };
    const d = base({ status: 'expired' }, { proposals: [p] });
    expect(cardAction(d, 'ann', 900_143, now).kind).toBe('wait');
    expect(cardAction(d, 'ann', 900_144, now)).toEqual({
      kind: 'broadcast',
      proposalId: 'p1',
      label: 'Reclaim (refund)',
    });
  });
  test('a ready release can be broadcast by the poster or the winner', () => {
    const p = {
      id: 'p2',
      kind: 'release' as const,
      entry_id: 'n1',
      status: 'ready',
      txid: null,
      ready: true,
      body: {} as never,
    };
    const d = base({ status: 'accepted' }, { proposals: [p], entries: [entry('ben')] });
    expect(cardAction(d, 'ben', 0, now).kind).toBe('broadcast');
    expect(cardAction(d, 'cat', 0, now).kind).toBe('wait');
  });
  test('deadline text', () => {
    expect(deadlineText('2026-10-30T12:00:00Z', now)).toBe('7 days left');
    expect(deadlineText('2026-10-23T11:00:00Z', now)).toBe('closed');
  });
  test('sha256 of the terms text', async () => {
    expect(await sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
