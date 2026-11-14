import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import { cleanBookingRequest, cleanProfile, cleanRate } from '../lib/bphone.js';
import { aliasWrites } from './fixtures/aliasWrites.js';

const ENV = { PAYMAIL_DOMAIN: 'pay.test' };

const memStore = () => {
  const aliases = new Map();
  const profiles = new Map();
  const bookings = new Map();
  return {
    aliases,
    profiles,
    bookings,
    getAlias: async (a) => aliases.get(a) ?? null,
    getAliasByKey: async (k) => [...aliases.values()].find((r) => r.identity_key === k) ?? null,
    getAliasByKeyKind: async (k, kind) =>
      [...aliases.values()].find((r) => r.identity_key === k && (r.kind ?? 'plain') === kind) ?? null,
    listByKey: async (k) => [...aliases.values()].filter((r) => r.identity_key === k),
    ...aliasWrites(aliases),
    getBphone: async (k) => profiles.get(k) ?? null,
    setBphone: async (k, profile) =>
      void profiles.set(k, {
        identity_key: k,
        profile,
        listed: profile.listing.listed,
        category: profile.listing.category,
      }),
    listBphone: async (category, limit) =>
      [...profiles.values()].filter((r) => r.listed && (!category || r.category === category)).slice(0, limit),
    deleteBphone: async (k) => void profiles.delete(k),
    insertBooking: async (r) => void bookings.set(r.id, { ...r }),
    getBooking: async (id) => bookings.get(id) ?? null,
    listBookings: async (k) => [...bookings.values()].filter((b) => b.callee_key === k || b.caller_key === k),
    updateBooking: async (id, patch) => void Object.assign(bookings.get(id), patch),
    deleteByKey: async () => ({ aliases: 0, payments: 0 }),
  };
};

const user = () => {
  const priv = PrivateKey.fromRandom();
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields, timestamp = Date.now()) => {
    const all = { ...fields, identityKey, timestamp: String(timestamp) };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage(action, all), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return { identityKey, timestamp, fields, signature: Utils.toHex(signature) };
  };
  return { priv, identityKey, sign };
};

const therapist = {
  rate: { amount: 2, per: 'minute', asset: { kind: 'bsv' } },
  listing: {
    listed: true,
    title: 'CBT therapist',
    about: 'Evenings and weekends.',
    category: 'therapy',
    hours: [{ day: 1, from: '18:00', to: '21:00' }],
    timezone: 'Europe/London',
    booking: true,
  },
};

describe('profile cleaning', () => {
  test('keeps a good profile, clips text, drops a bad rate', () => {
    const p = cleanProfile({ ...therapist, listing: { ...therapist.listing, about: 'x'.repeat(400) } });
    expect(p.rate).toEqual(therapist.rate);
    expect(p.listing.about.length).toBe(280);
    expect(cleanProfile({ rate: { amount: -2, per: 'minute', asset: { kind: 'bsv' } }, listing: {} }).rate).toBeNull();
    expect(cleanProfile({ listing: { listed: true } })).toBe('A listing needs a title');
    expect(cleanProfile('no')).toBe('profile must be an object');
  });
  test('rates: MNEE and tokens, nothing else', () => {
    expect(cleanRate({ amount: 1.5, per: 'hour', asset: { kind: 'mnee' } })).toEqual({
      amount: 1.5,
      per: 'hour',
      asset: { kind: 'mnee' },
    });
    expect(
      cleanRate({ amount: 3, per: 'call', asset: { kind: 'bsv21', id: `${'b'.repeat(64)}_0`, sym: 'BOB', dec: 0 } }),
    ).toMatchObject({ asset: { sym: 'BOB' } });
    expect(cleanRate({ amount: 3, per: 'call', asset: { kind: 'eth' } })).toBeNull();
    expect(cleanRate({ amount: 3, per: 'day', asset: { kind: 'bsv' } })).toBeNull();
  });
  // b-Aware row 114: the callee's signature over its payout address reaches callers (they refuse an address without).
  test("a payout address keeps its callee's signature; a malformed one is dropped", () => {
    const address = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
    const proof = { timestamp: '1794600000000', signature: '30440220' + 'ab'.repeat(30) };
    expect(cleanRate({ amount: 1, per: 'minute', asset: { kind: 'mnee', address, proof } }).asset).toEqual({
      kind: 'mnee',
      address,
      proof,
    });
    const id = `${'b'.repeat(64)}_0`;
    expect(cleanRate({ amount: 1, per: 'call', asset: { kind: 'bsv21', id, address, proof } }).asset).toMatchObject({
      address,
      proof,
    });
    expect(
      cleanRate({
        amount: 1,
        per: 'minute',
        asset: { kind: 'mnee', address, proof: { timestamp: 'x', signature: 'zz' } },
      }).asset,
    ).toEqual({ kind: 'mnee', address });
    expect(cleanRate({ amount: 1, per: 'minute', asset: { kind: 'mnee', proof } }).asset).toEqual({ kind: 'mnee' });
  });
  test('booking requests need a future time and a sane length', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    expect(cleanBookingRequest({ at: '2026-10-08T11:00:00Z', minutes: 30 }, now)).toBe(
      'Pick a time at least 5 minutes from now',
    );
    expect(cleanBookingRequest({ at: '2026-10-09T11:00:00Z', minutes: 3 }, now)).toMatch(/Length/);
    expect(cleanBookingRequest({ at: '2026-10-09T11:00:00Z', minutes: 30, note: ' hi ' }, now)).toEqual({
      at: '2026-10-09T11:00:00.000Z',
      minutes: 30,
      note: 'hi',
      callerLabel: '',
    });
  });
});

describe('bphone handlers', () => {
  const setup = async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const alice = user();
    const bob = user();
    store.aliases.set('alice', {
      alias: 'alice',
      identity_key: alice.identityKey,
      kind: 'plain',
      display_name: 'Alice',
    });
    return { store, h, alice, bob };
  };

  test('put (signed) → get (public) → directory; unlisted profiles stay out of the directory', async () => {
    const { h, alice, bob } = await setup();
    const put = await h['bphone-put']({}, await alice.sign('bphone-put', { profile: JSON.stringify(therapist) }));
    expect(put[0]).toBe(200);
    expect(put[1].profile.listing.title).toBe('CBT therapist');

    const got = await h['bphone-get']({ key: alice.identityKey });
    expect(got[0]).toBe(200);
    expect(got[1]).toMatchObject({
      key: alice.identityKey,
      paymail: 'alice@pay.test',
      name: 'Alice',
      profile: { rate: therapist.rate },
    });
    expect((await h['bphone-get']({ key: bob.identityKey }))[0]).toBe(404);
    expect((await h['bphone-get']({ key: 'nope' }))[0]).toBe(400);

    // Bob charges but is not listed.
    await h['bphone-put'](
      {},
      await bob.sign('bphone-put', {
        profile: JSON.stringify({ ...therapist, listing: { ...therapist.listing, listed: false } }),
      }),
    );
    const dir = await h['bphone-directory']({});
    expect(dir[1].listings.map((l) => l.key)).toEqual([alice.identityKey]);
    expect((await h['bphone-directory']({ category: 'legal' }))[1].listings).toEqual([]);
    expect((await h['bphone-directory']({ category: 'therapy' }))[1].listings.length).toBe(1);
  });

  test('a bad signature or a bad profile is refused', async () => {
    const { h, alice, bob } = await setup();
    const signed = await alice.sign('bphone-put', { profile: JSON.stringify(therapist) });
    expect((await h['bphone-put']({}, { ...signed, identityKey: bob.identityKey }))[0]).toBe(401);
    expect((await h['bphone-put']({}, await alice.sign('bphone-put', { profile: 'nope' })))[0]).toBe(400);
    expect(
      (
        await h['bphone-put'](
          {},
          await alice.sign('bphone-put', { profile: JSON.stringify({ listing: { listed: true } }) }),
        )
      )[1].error,
    ).toBe('A listing needs a title');
  });

  test('booking: request → both see it → callee confirms → caller cancels', async () => {
    const { h, alice, bob } = await setup();
    await h['bphone-put']({}, await alice.sign('bphone-put', { profile: JSON.stringify(therapist) }));
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const req = await h['bphone-book'](
      {},
      await bob.sign('bphone-book', {
        calleeKey: alice.identityKey,
        at,
        minutes: '30',
        note: 'First session',
        callerLabel: '$bob',
      }),
    );
    expect(req[0]).toBe(200);
    const b = req[1].booking;
    expect(b).toMatchObject({
      calleeKey: alice.identityKey,
      callerKey: bob.identityKey,
      callerLabel: '$bob',
      calleeLabel: 'alice@pay.test',
      minutes: 30,
      status: 'requested',
      rate: therapist.rate,
    });

    const mine = await h['bphone-bookings']({}, await alice.sign('bphone-bookings', {}));
    expect(mine[1].bookings.map((x) => x.id)).toEqual([b.id]);
    const theirs = await h['bphone-bookings']({}, await bob.sign('bphone-bookings', {}));
    expect(theirs[1].bookings.length).toBe(1);

    // The caller cannot confirm their own request.
    expect(
      (await h['bphone-book-act']({}, await bob.sign('bphone-book-act', { id: b.id, action: 'confirm' })))[0],
    ).toBe(400);
    const ok = await h['bphone-book-act']({}, await alice.sign('bphone-book-act', { id: b.id, action: 'confirm' }));
    expect(ok[1].booking.status).toBe('confirmed');
    const cancel = await h['bphone-book-act']({}, await bob.sign('bphone-book-act', { id: b.id, action: 'cancel' }));
    expect(cancel[1].booking.status).toBe('cancelled');
    expect(
      (await h['bphone-book-act']({}, await alice.sign('bphone-book-act', { id: b.id, action: 'confirm' })))[0],
    ).toBe(400);
    // A stranger can do nothing with it.
    const eve = user();
    expect((await h['bphone-book-act']({}, await eve.sign('bphone-book-act', { id: b.id, action: 'cancel' })))[0]).toBe(
      403,
    );
  });

  test('no bookings for someone with no profile, with bookings off, or for yourself', async () => {
    const { h, alice, bob } = await setup();
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const fields = { calleeKey: alice.identityKey, at, minutes: '30' };
    expect((await h['bphone-book']({}, await bob.sign('bphone-book', fields)))[0]).toBe(404);
    await h['bphone-put'](
      {},
      await alice.sign('bphone-put', {
        profile: JSON.stringify({ ...therapist, listing: { ...therapist.listing, booking: false } }),
      }),
    );
    expect((await h['bphone-book']({}, await bob.sign('bphone-book', fields)))[0]).toBe(404);
    await h['bphone-put']({}, await alice.sign('bphone-put', { profile: JSON.stringify(therapist) }));
    expect((await h['bphone-book']({}, await alice.sign('bphone-book', fields)))[0]).toBe(400);
    expect(
      (await h['bphone-book']({}, await bob.sign('bphone-book', { ...fields, at: '2020-01-01T00:00:00Z' })))[0],
    ).toBe(400);
  });
});
