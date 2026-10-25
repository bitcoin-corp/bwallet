import { beforeEach, describe, expect, test } from 'bun:test';
import type { Contact } from '../chat/contacts';
import {
  buildCard,
  businessLabel,
  fetchRoles,
  identityKeyOf,
  opnsCandidates,
  parseBitsignPublic,
  parseRoles,
} from './contactCardData';
import { contactNoteKey, isEmptyNotes, loadNotes, saveNotes } from './contactNotes';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const KEY = '02' + 'a'.repeat(64);
const OTHER = '03' + 'b'.repeat(64);

const contact = (p: Partial<Contact> = {}): Contact => ({
  id: 'x',
  name: 'alice',
  handle: 'alice',
  paymail: 'alice@bwalletx.com',
  identityKey: KEY,
  address: null,
  avatar: null,
  bchatId: null,
  sources: ['friend'],
  ...p,
});

describe('contact card: merging', () => {
  test('main name is the paymail, else $handle', () => {
    expect(buildCard({ contact: contact() }).main).toBe('alice@bwalletx.com');
    expect(buildCard({ contact: contact({ paymail: null }) }).main).toBe('$alice');
  });

  test('avatars: published ones, deduped, https/data only', () => {
    const v = buildCard({
      contact: contact({ avatar: 'https://a/1.png' }),
      profile: { handle: 'alice', displayName: 'Alice', avatarUrl: 'https://a/1.png' },
      paymailProfile: { avatar: 'https://a/2.gif' },
    });
    expect(v.avatars).toEqual(['https://a/1.png', 'https://a/2.gif']);
    expect(buildCard({ contact: contact({ avatar: 'javascript:alert(1)' }) }).avatars).toEqual([]);
  });

  test('title prefers the published display name', () => {
    const v = buildCard({ contact: contact(), profile: { handle: 'alice', displayName: 'Alice A', avatarUrl: null } });
    expect(v.title).toBe('Alice A');
  });

  test('other paymails exclude the main one and never show .gmail names', () => {
    const v = buildCard({
      contact: contact(),
      paymails: [
        { paymail: 'alice@bwalletx.com', kind: 'plain', main: true },
        { paymail: 'al@bwalletx.com', kind: 'plain', main: false },
        { paymail: 'alice.gmail@bwalletx.com', kind: 'gmail', main: false },
        { paymail: 'alicex.x@bwalletx.com', kind: 'x', main: false },
      ],
    });
    expect(v.otherPaymails).toEqual(['al@bwalletx.com', 'alicex.x@bwalletx.com']);
    expect(v.x).toBe('@alicex');
  });

  test('no X unless a .x paymail proves it', () => {
    expect(buildCard({ contact: contact() }).x).toBeNull();
  });

  test('OpNS names count only when bound to their identity key', () => {
    const v = buildCard({
      contact: contact(),
      opns: [{ name: 'alice', pubkey: KEY.toUpperCase() }, { name: 'bob', pubkey: OTHER }, { name: 'held' }],
    });
    expect(v.opnsNames).toEqual(['alice']);
    expect(
      buildCard({ contact: contact({ identityKey: null }), opns: [{ name: 'alice', pubkey: KEY }] }).opnsNames,
    ).toEqual([]);
  });

  test('identity key falls back to the paymail pki key; junk is ignored', () => {
    expect(identityKeyOf({ contact: contact({ identityKey: null }), paymailProfile: { pubkey: OTHER } })).toBe(OTHER);
    expect(identityKeyOf({ contact: contact({ identityKey: 'nope' }) })).toBeNull();
  });

  test('businesses: verified from a register, else "says …"', () => {
    expect(businessLabel({ company: 'Acme Ltd', role: 'Director', verified: true })).toBe('Director · Acme Ltd');
    expect(businessLabel({ company: 'Acme Ltd', role: 'CEO', verified: false })).toBe('says CEO · Acme Ltd');
    expect(buildCard({ contact: contact() }).businesses).toEqual([]);
  });

  test('nothing published → nothing shown', () => {
    const v = buildCard({ contact: contact() });
    expect([v.bio, v.twetch, v.x]).toEqual([null, null, null]);
    expect(v.otherPaymails).toEqual([]);
  });

  test('OpNS candidates: handle and plain aliases only', () => {
    expect(
      opnsCandidates(contact({ handle: 'alice' }), [
        { paymail: 'al-b@bwalletx.com', kind: 'plain', main: false },
        { paymail: 'alicex.x@bwalletx.com', kind: 'x', main: false },
      ]),
    ).toEqual(['alice', 'al-b']);
  });

  test('bit-sign public profile parsing', () => {
    expect(parseBitsignPublic({ handle: 'alice', displayName: 'A', avatarUrl: null, bio: 'hi' })?.bio).toBe('hi');
    expect(parseBitsignPublic({ handle: 'alice', displayName: 'A', avatarUrl: null })).toEqual({
      bio: null,
      handle: 'alice',
      displayName: 'A',
      avatarUrl: null,
    });
    expect(parseBitsignPublic({ error: 'not-found' })).toBeNull();
  });
});

describe('contact notes: local only', () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  });

  test('key: paymail, then $handle, then identity key', () => {
    expect(contactNoteKey(contact())).toBe('alice@bwalletx.com');
    expect(contactNoteKey(contact({ paymail: null }))).toBe('$alice');
    expect(contactNoteKey(contact({ paymail: null, handle: null }))).toBe(KEY);
    expect(contactNoteKey(contact({ paymail: null, handle: null, identityKey: null }))).toBeNull();
  });

  test('saved per account and per contact', () => {
    expect(saveNotes('acct1', 'alice@bwalletx.com', { email: 'a@x.com', phone: '123', text: 'met at conf' })).toBe(
      true,
    );
    expect(loadNotes('acct1', 'alice@bwalletx.com')).toEqual({ email: 'a@x.com', phone: '123', text: 'met at conf' });
    expect(isEmptyNotes(loadNotes('acct2', 'alice@bwalletx.com'))).toBe(true);
    expect(isEmptyNotes(loadNotes('acct1', '$bob'))).toBe(true);
  });

  test('empty notes are removed; long text is capped', () => {
    saveNotes('a', 'c', { email: '', phone: '', text: 'x' });
    expect(mem.size).toBe(1);
    saveNotes('a', 'c', { email: ' ', phone: '', text: '' });
    expect(mem.size).toBe(0);
    saveNotes('a', 'c', { email: '', phone: '', text: 'y'.repeat(9000) });
    expect(loadNotes('a', 'c').text.length).toBe(4000);
  });

  test('storage failures never throw', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    expect(isEmptyNotes(loadNotes('a', 'c'))).toBe(true);
    expect(saveNotes('a', 'c', { email: 'e', phone: '', text: '' })).toBe(false);
    expect(saveNotes(undefined, 'c', { email: 'e', phone: '', text: '' })).toBe(false);
  });
});

describe('roles and bio', () => {
  const json = {
    handle: 'alice',
    roles: [
      {
        ticker: 'BCORP',
        name: 'The Bitcoin Corporation Ltd',
        office: 'secretary',
        office_label: 'Company Secretary',
        appointed_at: '2026-10-01',
        register_url: 'https://www.bchatx.com/r/bcorp',
      },
      { ticker: 'X', name: '', office: '' },
      { ticker: 'EVIL', name: 'Evil', office_label: 'Director', register_url: 'javascript:alert(1)' },
    ],
  };

  test('roles → verified rows with register links (https only)', () => {
    const rows = parseRoles(json);
    expect(rows).toHaveLength(2);
    const v = buildCard({ contact: { handle: 'alice' } as never, businesses: rows });
    expect(v.businesses[0]).toEqual({
      label: 'Company Secretary · The Bitcoin Corporation Ltd',
      verified: true,
      url: 'https://www.bchatx.com/r/bcorp',
    });
    expect(v.businesses[1].url).toBeNull();
    expect(parseRoles({ roles: [] })).toEqual([]);
    expect(parseRoles(null)).toEqual([]);
  });

  test('roles fetch: no credentials; 404 and network errors mean none', async () => {
    let init: RequestInit | undefined;
    const ok = (async (_u: string, i?: RequestInit) => {
      init = i;
      return new Response(JSON.stringify(json));
    }) as never;
    expect(await fetchRoles(ok, 'alice')).toHaveLength(2);
    expect(init?.credentials).toBe('omit');
    expect(await fetchRoles((async () => new Response('', { status: 404 })) as never, 'a')).toEqual([]);
    expect(
      await fetchRoles(
        (async () => {
          throw new Error('offline');
        }) as never,
        'a',
      ),
    ).toEqual([]);
  });

  test('bio comes from the bit-sign profile', () => {
    const v = buildCard({
      contact: { handle: 'alice' } as never,
      profile: { handle: 'alice', displayName: null, avatarUrl: null, bio: '  builder  ' },
    });
    expect(v.bio).toBe('builder');
  });
});
