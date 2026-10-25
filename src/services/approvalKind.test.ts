import { describe, expect, test } from 'bun:test';
import { approvalKindForSheet, privateTitleLabel, siteName } from './approvalKind';
import { buildSheetModel, type BundleRequest } from './permissionBundle';

const o = 'bchatx.com';
const proto = (id: string, extra: Partial<BundleRequest> = {}): BundleRequest => ({
  requestID: id,
  type: 'protocol',
  originator: o,
  protocolID: [1, 'bchatx auth'],
  ...extra,
});
const kind = (items: BundleRequest[]) => approvalKindForSheet(buildSheetModel({ originator: o, items }));

describe('approvalKindForSheet', () => {
  test('signature anyone can check → SIGN IN', () => {
    expect(kind([proto('a', { counterparty: 'anyone' })])).toBe('signin');
  });
  test('a sign-in protocol for the site → SIGN IN', () => {
    expect(kind([proto('a')])).toBe('signin');
    expect(kind([proto('a', { protocolID: [2, 'bchatx auth'], counterparty: 'self' })])).toBe('signin');
  });
  test('a self key that is not a sign-in protocol is never titled SIGN IN', () => {
    expect(kind([proto('a'), proto('b', { protocolID: [2, 'x'], counterparty: 'self' })])).toBe('connect');
    expect(kind([proto('a', { protocolID: [2, 'bchatx agent history'], counterparty: 'self' })])).toBe('private');
  });
  test('encrypting Ask b history → "Use your wallet keys for your Ask b chats"', () => {
    const model = buildSheetModel({
      originator: o,
      items: [proto('a', { protocolID: [2, 'bchatx agent history'], counterparty: 'self' })],
    });
    expect(approvalKindForSheet(model)).toBe('private');
    expect(privateTitleLabel(model)).toBe('Ask b chats');
  });
  test("a site's first post (bap basket + sigma signature + spend) → one POST sheet, amount kept", () => {
    const items: BundleRequest[] = [
      { requestID: 'b', type: 'basket', originator: o, basket: 'bap' },
      proto('s', { protocolID: [1, 'sigma'], counterparty: 'self' }),
      { requestID: 'p', type: 'spending', originator: o, spending: { satoshis: 120 } },
    ];
    const model = buildSheetModel({ originator: o, items });
    expect(model.purpose).toBe('post');
    expect(approvalKindForSheet(model)).toBe('post');
    expect(model.payment?.satoshis).toBe(120);
    // Risk still wins over a post.
    expect(kind([...items, proto('x', { privileged: true })])).toBe('careful');
  });
  test('sharing keys with a named counterparty is not sign-in → CONNECT', () => {
    expect(kind([proto('a', { protocolID: [2, 'x'], counterparty: '02abc' })])).toBe('connect');
  });
  test('baskets or certificates (no payment) → CONNECT', () => {
    expect(kind([proto('a'), { requestID: 'b', type: 'basket', originator: o, basket: 'tickets' }])).toBe('connect');
    expect(
      kind([
        {
          requestID: 'c',
          type: 'certificate',
          originator: o,
          certificate: { verifier: 'v', certType: 't', fields: ['handle'] },
        },
      ]),
    ).toBe('connect');
  });
  test('payment → PAY, with or without connect lines', () => {
    const pay: BundleRequest = { requestID: 'p', type: 'spending', originator: o, spending: { satoshis: 1000 } };
    expect(kind([pay])).toBe('pay');
    expect(kind([proto('a'), pay])).toBe('pay');
  });
  test('no spending caps: a credit load of any size is one PAY sheet for the full amount', () => {
    // TokenBlaster "Shooting Gallery" credit: ONE createAction for the exact total the player loaded.
    for (const satoshis of [100 * 2_000_000, 500 * 2_000_000]) {
      const pay: BundleRequest = {
        requestID: 'p',
        type: 'spending',
        originator: 'www.tokenblaster.lol',
        spending: { satoshis, lineItems: [{ type: 'output', satoshis, description: 'Shooting Gallery: credit' }] },
      };
      const model = buildSheetModel({ originator: 'www.tokenblaster.lol', items: [pay] });
      expect(approvalKindForSheet(model)).toBe('pay');
      expect(model.payment?.satoshis).toBe(satoshis);
      expect(model.lines.some((l) => l.risky)).toBe(false);
    }
  });
  test('privileged keys or private certificate fields → CAREFUL, even with a payment', () => {
    expect(kind([proto('a', { privileged: true })])).toBe('careful');
    expect(
      kind([
        {
          requestID: 'c',
          type: 'certificate',
          originator: o,
          certificate: { verifier: 'v', certType: 't', fields: ['email'] },
        },
        { requestID: 'p', type: 'spending', originator: o, spending: { satoshis: 1 } },
      ]),
    ).toBe('careful');
  });
  test('a second spend in one bundle is a risky line → CAREFUL', () => {
    const pay = (id: string): BundleRequest => ({
      requestID: id,
      type: 'spending',
      originator: o,
      spending: { satoshis: 5 },
    });
    expect(kind([pay('p1'), pay('p2')])).toBe('careful');
  });
  test('empty sheet → CONNECT', () => {
    expect(kind([])).toBe('connect');
  });
});

describe('siteName', () => {
  test('strips scheme, www and TLD', () => {
    expect(siteName('bchatx.com')).toBe('bchatx');
    expect(siteName('https://www.twetch.com/path')).toBe('twetch');
    expect(siteName('example.co.uk')).toBe('example');
    expect(siteName('shop.example.co.uk')).toBe('shop.example.co.uk');
    expect(siteName('localhost:3000')).toBe('localhost');
  });
  test('never shortens a lookalike host to another site', () => {
    expect(siteName('tokenblaster.com.ab1.io')).toBe('tokenblaster.com.ab1.io');
    expect(siteName('bchatx.com.co.uk')).toBe('bchatx.com.co.uk');
  });
});
