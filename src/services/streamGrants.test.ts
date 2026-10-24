import { describe, expect, test } from 'bun:test';
import {
  addGrant,
  budgetLeft,
  decide,
  emptyStreamState,
  HOUR_MS,
  isSpendingAuthAction,
  MAX_GRANT_MS,
  parseSpendingAuthRequest,
  parseStreamState,
  passCovers,
  publicGrant,
  recordSpend,
  revokeGrant,
  spentLastHour,
  tidy,
  type StreamGrant,
  type StreamState,
} from './streamGrants';

const T0 = 1_800_000_000_000;
const LABEL = 'bmovies stream';

const grant = (over: Partial<StreamGrant> = {}): StreamGrant => ({
  id: 'sg_1',
  originator: 'bmovies.online',
  protocolID: [2, LABEL],
  label: LABEL,
  capSatsPerHour: 10_000,
  expiresAt: T0 + 2 * HOUR_MS,
  createdAt: T0,
  spends: [],
  totalSats: 0,
  ...over,
});

const withGrant = (g = grant(), s: StreamState = emptyStreamState()) => addGrant(s, g);
const q = (over: Partial<Parameters<typeof decide>[1]> = {}) => ({
  originator: 'bmovies.online',
  labels: [LABEL],
  sats: 100,
  now: T0 + 1000,
  ...over,
});

describe('parseSpendingAuthRequest', () => {
  test('accepts the bmovies request; expiry in seconds', () => {
    const r = parseSpendingAuthRequest(
      {
        protocolID: [2, 'bmovies stream'],
        capSatsPerHour: 5000.7,
        expiry: Math.floor((T0 + HOUR_MS) / 1000),
        description: 'x',
      },
      T0,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.protocolID).toEqual([2, 'bmovies stream']);
      expect(r.request.capSatsPerHour).toBe(5000);
      expect(r.request.expiresAt).toBe(T0 + HOUR_MS);
    }
  });
  test('expiry in ms also accepted; clamped to 24h', () => {
    const r = parseSpendingAuthRequest(
      { protocolID: [2, 'bmovies stream'], capSatsPerHour: 1, expiry: T0 + 100 * HOUR_MS },
      T0,
    );
    expect(r.ok && r.request.expiresAt).toBe(T0 + MAX_GRANT_MS);
  });
  test('ignores a page-claimed originator', () => {
    const r = parseSpendingAuthRequest(
      { protocolID: [2, 'bmovies stream'], capSatsPerHour: 1, originator: 'evil.com' },
      T0,
    );
    expect(r.ok && 'originator' in r.request).toBe(false);
  });
  test('rejects bad input', () => {
    expect(parseSpendingAuthRequest({ protocolID: [1, 'bmovies stream'], capSatsPerHour: 1 }, T0).ok).toBe(false);
    expect(parseSpendingAuthRequest({ protocolID: [2, 'ab'], capSatsPerHour: 1 }, T0).ok).toBe(false);
    expect(parseSpendingAuthRequest({ protocolID: [2, 'bmovies stream'], capSatsPerHour: 0 }, T0).ok).toBe(false);
    expect(parseSpendingAuthRequest({ protocolID: [2, 'bmovies stream'], capSatsPerHour: 5, expiry: 1 }, T0).ok).toBe(
      false,
    );
    expect(parseSpendingAuthRequest(null, T0).ok).toBe(false);
  });
});

describe('budget accounting', () => {
  test('rolling one-hour window', () => {
    let s = withGrant();
    s = recordSpend(s, 'sg_1', { at: T0, sats: 6000 });
    expect(decide(s, q({ sats: 4000 })).approve).toBe(true);
    expect(decide(s, q({ sats: 4001 }))).toEqual({ approve: false, reason: 'over-budget' });
    // an hour after the first spend it has rolled out of the window
    const later = T0 + HOUR_MS;
    expect(spentLastHour(s.grants[0], later)).toBe(0);
    expect(decide(s, q({ sats: 10_000, now: later })).approve).toBe(true);
  });
  test('global ceiling caps across grants', () => {
    let s: StreamState = { ...emptyStreamState(), ceilingSatsPerHour: 8000 };
    s = withGrant(grant(), s);
    s = withGrant(grant({ id: 'sg_2', originator: 'other.site' }), s);
    s = recordSpend(s, 'sg_2', { at: T0, sats: 7000 });
    expect(budgetLeft(s, s.grants[0], T0 + 1)).toBe(1000);
    expect(decide(s, q({ sats: 1500 })).approve).toBe(false);
  });
  test('recordSpend prunes and keeps a lifetime total', () => {
    let s = withGrant();
    s = recordSpend(s, 'sg_1', { at: T0, sats: 10 });
    s = recordSpend(s, 'sg_1', { at: T0 + 2 * HOUR_MS - 10, sats: 20 });
    expect(s.grants[0].spends).toHaveLength(1);
    expect(s.grants[0].totalSats).toBe(30);
  });
});

describe('origin binding', () => {
  test('only the grant holder origin is approved', () => {
    const s = withGrant();
    expect(decide(s, q({ originator: 'evil.com' }))).toEqual({ approve: false, reason: 'no-grant' });
    expect(decide(s, q({ originator: undefined })).approve).toBe(false);
    expect(decide(s, q({ originator: 'bmovies.online:8443' })).approve).toBe(false);
  });
  test('pass covers only that originator, its spend cap and its label permission', () => {
    const pass = { grantId: 'sg_1', originator: 'bmovies.online', label: LABEL, maxSats: 500 };
    expect(passCovers(pass, { type: 'spending', originator: 'bmovies.online', spending: { satoshis: 500 } })).toBe(
      true,
    );
    expect(passCovers(pass, { type: 'spending', originator: 'bmovies.online', spending: { satoshis: 501 } })).toBe(
      false,
    );
    expect(passCovers(pass, { type: 'spending', originator: 'evil.com', spending: { satoshis: 1 } })).toBe(false);
    expect(
      passCovers(pass, { type: 'protocol', originator: 'bmovies.online', protocolID: [1, `action label ${LABEL}`] }),
    ).toBe(true);
    expect(passCovers(pass, { type: 'protocol', originator: 'bmovies.online', protocolID: [2, LABEL] })).toBe(false);
    expect(passCovers(pass, { type: 'basket', originator: 'bmovies.online' })).toBe(false);
    expect(passCovers(undefined, { type: 'spending', originator: 'bmovies.online', spending: { satoshis: 1 } })).toBe(
      false,
    );
  });
});

describe('non-matching actions still prompt', () => {
  test('missing label', () => {
    expect(decide(withGrant(), q({ labels: ['something else'] }))).toEqual({ approve: false, reason: 'no-label' });
    expect(decide(withGrant(), q({ labels: undefined }))).toEqual({ approve: false, reason: 'no-label' });
  });
  test('no grants at all', () => {
    expect(decide(emptyStreamState(), q())).toEqual({ approve: false, reason: 'no-grant' });
  });
  test('kill switch', () => {
    expect(decide({ ...withGrant(), paused: true }, q())).toEqual({ approve: false, reason: 'paused' });
  });
});

describe('expiry and revoke', () => {
  test('expired grant no longer approves', () => {
    const s = withGrant();
    expect(decide(s, q({ now: T0 + 2 * HOUR_MS })).approve).toBe(false);
  });
  test('revoke stops approval; a site may revoke only its own', () => {
    const s = withGrant();
    expect(revokeGrant(s, 'sg_1', T0, 'evil.com')).toBeUndefined();
    const r = revokeGrant(s, 'sg_1', T0, 'bmovies.online')!;
    expect(decide(r, q()).approve).toBe(false);
    expect(publicGrant(r.grants[0], r, T0 + 1).active).toBe(false);
    expect(revokeGrant(s, 'nope', T0)).toBeUndefined();
  });
  test('a new grant for the same pair replaces the old one', () => {
    const s = addGrant(withGrant(), grant({ id: 'sg_2', capSatsPerHour: 1 }));
    expect(s.grants).toHaveLength(1);
    expect(s.grants[0].id).toBe('sg_2');
  });
  test('tidy drops grants dead for over a day', () => {
    const s = withGrant();
    expect(tidy(s, T0 + 2 * HOUR_MS + 25 * HOUR_MS).grants).toHaveLength(0);
    expect(tidy(s, T0 + 3 * HOUR_MS).grants).toHaveLength(1);
  });
});

test('parseStreamState tolerates junk; action names', () => {
  expect(parseStreamState('x').grants).toEqual([]);
  expect(parseStreamState({ paused: true, ceilingSatsPerHour: -1 }).paused).toBe(true);
  expect(isSpendingAuthAction('bwxSpendingAuthRequest')).toBe(true);
  expect(isSpendingAuthAction('createAction')).toBe(false);
});

test('options.spendingAuthorization names the protocol, and is stripped before signing', async () => {
  const { streamProtocolOption, withoutStreamOption } = await import('./streamGrants');
  const args = { description: 'tick', options: { noSend: true, spendingAuthorization: { protocolID: [2, LABEL] } } };
  expect(streamProtocolOption(args)).toEqual([LABEL]);
  expect(decide(withGrant(), q({ labels: streamProtocolOption(args) })).approve).toBe(true);
  expect(withoutStreamOption(args).options).toEqual({ noSend: true });
  expect(streamProtocolOption({})).toEqual([]);
});

describe('payee allowlist (audit 24 Oct B2)', () => {
  const A = '76a914' + 'aa'.repeat(20) + '88ac';
  const B = '76a914' + 'bb'.repeat(20) + '88ac';
  test('a request may carry payees; junk is refused, case is folded', () => {
    const ok = parseSpendingAuthRequest(
      { protocolID: [2, LABEL], capSatsPerHour: 1000, payees: [A.toUpperCase(), A] },
      T0,
    );
    expect(ok.ok && ok.request.payees).toEqual([A]);
    expect(parseSpendingAuthRequest({ protocolID: [2, LABEL], capSatsPerHour: 1000, payees: 'x' }, T0).ok).toBe(false);
    expect(parseSpendingAuthRequest({ protocolID: [2, LABEL], capSatsPerHour: 1000, payees: ['zz'] }, T0).ok).toBe(
      false,
    );
    const none = parseSpendingAuthRequest({ protocolID: [2, LABEL], capSatsPerHour: 1000 }, T0);
    expect(none.ok && none.request.payees).toBeUndefined();
  });
  test('a grant with payees covers only calls paying them', () => {
    const s = withGrant(grant({ payees: [A] }));
    expect(decide(s, q({ outputs: [{ satoshis: 100, lockingScript: A }] })).approve).toBe(true);
    expect(decide(s, q({ outputs: [{ satoshis: 100, lockingScript: B }] }))).toEqual({
      approve: false,
      reason: 'payee',
    });
    // A zero-sat data output (OP_RETURN) needs no listing.
    expect(
      decide(
        s,
        q({
          outputs: [
            { satoshis: 100, lockingScript: A },
            { satoshis: 0, lockingScript: '006a' },
          ],
        }),
      ).approve,
    ).toBe(true);
  });
  test('a grant without payees behaves as before', () => {
    expect(decide(withGrant(), q({ outputs: [{ satoshis: 100, lockingScript: B }] })).approve).toBe(true);
  });
});
