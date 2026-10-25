import { describe, expect, test } from 'bun:test';
import { KeyDeriver, P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';

const ENV = { PAYMAIL_DOMAIN: 'pay.test' };

const memStore = () => {
  const aliases = new Map();
  const pays = new Map();
  return {
    aliases,
    pays,
    getAlias: async (a) => aliases.get(a) ?? null,
    getAliasByKey: async (k) =>
      [...aliases.values()].find((r) => r.identity_key === k && (r.kind ?? 'plain') === 'plain') ??
      [...aliases.values()].find((r) => r.identity_key === k) ??
      null,
    countUncollected: async (a) => [...pays.values()].filter((p) => p.alias === a && p.status === 'received').length,
    deleteAlias: async (a) => {
      for (const [r, p] of pays) if (p.alias === a) pays.delete(r);
      aliases.delete(a);
    },
    appsStore: new Map(),
    getApps: async function (k) {
      return this.appsStore.get(k) ?? [];
    },
    setApps: async function (k, a) {
      this.appsStore.set(k, a);
    },
    listSocial: async (kind) =>
      [...aliases.values()]
        .filter((r) => (r.kind ?? 'plain') === kind)
        .map((r) => ({ alias: r.alias, display_name: r.display_name ?? null })),
    listByKey: async (k) => [...aliases.values()].filter((r) => r.identity_key === k),
    getAliasByKeyKind: async (k, kind) =>
      [...aliases.values()].find((r) => r.identity_key === k && (r.kind ?? 'plain') === kind) ?? null,
    upsertAlias: async (r) => (aliases.set(r.alias, { ...r }), r),
    renameAlias: async (from, to) => {
      const r = aliases.get(from);
      aliases.delete(from);
      aliases.set(to, { ...r, alias: to });
      for (const p of pays.values()) if (p.alias === from) p.alias = to;
    },
    forwards: new Map(),
    getForward: async function (a) {
      return this.forwards.get(a) ?? null;
    },
    putForward: async function (r) {
      this.forwards.set(r.from_alias, { ...r });
    },
    deleteForward: async function (a) {
      this.forwards.delete(a);
    },
    retargetForwards: async function (from, to) {
      for (const r of this.forwards.values()) if (r.to_alias === from) r.to_alias = to;
    },
    insertPayment: async (r) => void pays.set(r.reference, { ...r }),
    getPayment: async (ref) => pays.get(ref) ?? null,
    updatePayment: async (ref, patch) => void Object.assign(pays.get(ref), patch),
    listInbox: async (k) => [...pays.values()].filter((p) => p.identity_key === k && p.status === 'received'),
    listHistory: async (k) => [...pays.values()].filter((p) => p.identity_key === k),
    countRecentPayments: async () => 0,
    deleteByKey: async (k) => {
      let a = 0;
      let p = 0;
      for (const [key, r] of aliases) if (r.identity_key === k) (aliases.delete(key), a++);
      for (const [ref, r] of pays) if (r.identity_key === k) (pays.delete(ref), p++);
      return { aliases: a, payments: p };
    },
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

describe('capabilities', () => {
  test('lists the bsvalias BRFCs on the configured domain', () => {
    const c = pm.capabilities(ENV).capabilities;
    expect(c.pki).toBe('https://pay.test/api/paymail/id/{alias}@{domain.tld}');
    for (const k of ['f12f968c92d6', 'a9f510c16bde', '2a40af698840', '5f1323cddf31', '5c55a7fdb7bb', 'ordAddress'])
      expect(c[k]).toContain('{alias}@{domain.tld}');
  });
  test('defaults to bwallet-nine.vercel.app', () => expect(pm.domain({})).toBe('bwallet-nine.vercel.app'));
  test('parseHandle only accepts our domain', () => {
    expect(pm.parseHandle('Alice@pay.test', ENV)).toBe('alice');
    expect(pm.parseHandle('alice@other.test', ENV)).toBeNull();
    expect(pm.parseHandle('-x@pay.test', ENV)).toBeNull();
  });
});

describe('register', () => {
  test('signed registration, then pki / verify / profile / ord', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const ord = PrivateKey.fromRandom().toAddress();
    const [s, r] = await h.register({}, await u.sign('register', { alias: 'alice', ordAddress: ord, name: 'Alice' }));
    expect(s).toBe(200);
    expect(r.paymail).toBe('alice@pay.test');
    expect((await h.pki({ handle: 'alice@pay.test' }))[1].pubkey).toBe(u.identityKey);
    expect((await h.verify({ handle: 'alice@pay.test', pubkey: u.identityKey }))[1].match).toBe(true);
    expect((await h.verify({ handle: 'alice@pay.test', pubkey: '02' + '1'.repeat(64) }))[1].match).toBe(false);
    expect((await h.profile({ handle: 'alice@pay.test' }))[1].name).toBe('Alice');
    // No picture of her own: the profile points at her generated bAvatar, by identity key.
    expect((await h.profile({ handle: 'alice@pay.test' }))[1].avatar).toBe(
      `https://www.bchatx.com/api/bavatar/${u.identityKey}.png`,
    );
    expect((await h.ord({ handle: 'alice@pay.test' }))[1].address).toBe(ord);
    expect((await h.lookup({ key: u.identityKey }))[1].paymail).toBe('alice@pay.test');
  });

  test('rejects a bad signature, an expired one, and someone else taking the alias', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const body = await u.sign('register', { alias: 'bob' });
    expect((await h.register({}, { ...body, fields: { alias: 'eve' } }))[0]).toBe(401);
    expect((await h.register({}, await u.sign('register', { alias: 'bob' }, Date.now() - 600_000)))[0]).toBe(401);
    expect((await h.register({}, body))[0]).toBe(200);
    const v = user();
    expect((await h.register({}, await v.sign('register', { alias: 'bob' })))[0]).toBe(409);
    expect((await h.register({}, await v.sign('register', { alias: 'admin' })))[0]).toBe(400);
  });

  test('social names (b0asex.x, theirname.gmail) need bit-sign to confirm the key', async () => {
    const store = memStore();
    const allowed = new Map(); // alias → key bit-sign would confirm
    // Stands in for bit-sign's ticket check: the ticket names the X account it proved.
    const socialCheck = async (alias, social) => (social && allowed.get(alias) === social.ticket ? null : 'no');
    const h = pm.makeHandlers({ store, env: ENV, socialCheck });
    const u = user();
    const v = user();
    expect((await h.register({}, await u.sign('register', { alias: 'b0asex.x' })))[0]).toBe(403);
    allowed.set('b0asex.x', 'ticket-b0asex');
    const social = { ticket: 'ticket-b0asex', secret: 's' };
    expect(
      (
        await h.register(
          {},
          { ...(await v.sign('register', { alias: 'b0asex.x' })), social: { ticket: 'other', secret: 's' } },
        )
      )[0],
    ).toBe(403);
    const [s, r] = await h.register({}, { ...(await u.sign('register', { alias: 'b0asex.x' })), social });
    expect(s).toBe(200);
    expect(r.paymail).toBe('b0asex.x@pay.test');
    expect((await h.pki({ handle: 'B0aseX.X@pay.test' }))[1].pubkey).toBe(u.identityKey);
    // Plain names never call bit-sign; a lookalike plain name stays separate.
    expect((await h.register({}, await v.sign('register', { alias: 'b0asex' })))[0]).toBe(200);
    // A wallet with a plain name keeps it when it adds its verified X name.
    const w = user();
    expect((await h.register({}, await w.sign('register', { alias: 'wplain' })))[0]).toBe(200);
    allowed.set('w-x.x', 'ticket-w');
    expect(
      (
        await h.register(
          {},
          { ...(await w.sign('register', { alias: 'w-x.x' })), social: { ticket: 'ticket-w', secret: 's' } },
        )
      )[0],
    ).toBe(200);
    expect(store.aliases.has('wplain')).toBe(true);
    expect(store.aliases.get('w-x.x').kind).toBe('x');
    // Its owner can update the profile (e.g. publish a photo) without a fresh X sign-in; the name is kept.
    expect(
      (await h.register({}, await w.sign('register', { alias: 'w-x.x', avatar: 'https://img.test/a.png' })))[0],
    ).toBe(200);
    expect(store.aliases.get('w-x.x').avatar).toBe('https://img.test/a.png');
    // Nobody else can, without proof.
    expect((await h.register({}, await v.sign('register', { alias: 'w-x.x' })))[0]).toBe(403);
    // The wallet already had a plain name it chose, so that stays its main name; the X name also receives.
    expect((await h.lookup({ key: w.identityKey }))[1].alias).toBe('wplain');
    // Market › Social: every kind of name, tagged with its kind.
    const people = (await h.social({ provider: 'all' }))[1].accounts;
    expect(people.find((a) => a.alias === 'w-x.x')?.kind).toBe('x');
    expect(people.find((a) => a.alias === 'wplain')?.kind).toBe('plain');
    expect((await h.social({ provider: 'x' }))[1].accounts.every((a) => a.kind === 'x')).toBe(true);
    // Both names are listed, so neither receives invisibly.
    expect((await h.lookup({ key: w.identityKey }))[1].names).toEqual([
      { paymail: 'wplain@pay.test', kind: 'plain', main: true },
      { paymail: 'w-x.x@pay.test', kind: 'x', main: false },
    ]);
    // Users choose their handle (owner, 9 Oct 2026): a plain rename keeps the X name receiving.
    expect((await h.register({}, await w.sign('register', { alias: 'wother' })))[0]).toBe(200);
    expect(store.aliases.has('wother')).toBe(true);
    expect(store.aliases.has('wplain')).toBe(false);
    expect(store.aliases.get('w-x.x').kind).toBe('x');
    // A wallet with only a verified X name can still choose a plain handle.
    const x = user();
    allowed.set('xonly.x', 'ticket-x');
    expect(
      (
        await h.register(
          {},
          { ...(await x.sign('register', { alias: 'xonly.x' })), social: { ticket: 'ticket-x', secret: 's' } },
        )
      )[0],
    ).toBe(200);
    expect((await h.register({}, await x.sign('register', { alias: 'chosen' })))[0]).toBe(200);
    expect((await h.lookup({ key: x.identityKey }))[1].alias).toBe('chosen');
    expect((await h.pki({ handle: 'xonly.x@pay.test' }))[1].pubkey).toBe(x.identityKey);
    // New .gmail names are no longer issued (they published the address), even with a valid proof.
    allowed.set('someone.gmail', 'ticket-g');
    expect(
      (
        await h.register(
          {},
          { ...(await x.sign('register', { alias: 'someone.gmail' })), social: { ticket: 'ticket-g', secret: 's' } },
        )
      )[0],
    ).toBe(403);
    // Apps › Add app: signed save and load, https only.
    const apps = JSON.stringify([{ url: 'https://zanaadu.com', name: 'Zanaadu' }]);
    expect((await h.appsPut({}, await w.sign('apps-put', { apps })))[0]).toBe(200);
    expect((await h.appsGet({}, await w.sign('apps-get', {})))[1].apps).toEqual([
      { url: 'https://zanaadu.com/', name: 'Zanaadu' },
    ]);
    expect(
      (await h.appsPut({}, await w.sign('apps-put', { apps: JSON.stringify([{ url: 'http://x.com' }]) })))[0],
    ).toBe(400);
    // Unlink: only the owner can, and the next name becomes main.
    expect((await h.unlink({}, await v.sign('unlink', { alias: 'w-x.x' })))[0]).toBe(404);
    expect((await h.unlink({}, await w.sign('unlink', { alias: 'w-x.x' })))[0]).toBe(200);
    expect(store.aliases.has('w-x.x')).toBe(false);
    expect((await h.lookup({ key: w.identityKey }))[1].alias).toBe('wother');
    // Once taken, the same X name can't be registered to a second wallet.
    expect((await h.register({}, { ...(await v.sign('register', { alias: 'b0asex.x' })), social }))[0]).toBe(409);
    expect(pm.socialAliasFor('x', 'B0ase_X')).toBe('b0ase-x.x');
    expect(pm.socialAliasFor('google', 'their.name+t@gmail.com')).toBe('theirname.gmail');
    expect(pm.socialAliasFor('google', 'a@corp.com')).toBeNull();
    expect((await h.register({}, await v.sign('register', { alias: 'evil.com' })))[0]).toBe(400);
  });

  test('one alias per identity: re-registering renames', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'one' }));
    await h.register({}, await u.sign('register', { alias: 'two' }));
    expect(store.aliases.has('one')).toBe(false);
    expect(store.aliases.get('two').identity_key).toBe(u.identityKey);
  });
});

describe('P2P receive → inbox → wallet can spend', () => {
  test('end to end with BRC-29 derivation against the anyone key', async () => {
    const store = memStore();
    const broadcasts = [];
    const h = pm.makeHandlers({ store, env: ENV, broadcast: async (tx) => void broadcasts.push(tx.id('hex')) });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'carol' }));

    const [s, dest] = await h.p2pDestination({ handle: 'carol@pay.test' }, { satoshis: 1234 });
    expect(s).toBe(200);
    expect(dest.outputs).toHaveLength(1);

    // Sender builds a tx paying the destination (no inputs needed for this check).
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 5 });
    tx.addOutput({ lockingScript: new P2PKH().lock('1BoatSLRHtKNngkdXEeobR76b53LETtpyT'), satoshis: 1 });
    tx.addOutput({ lockingScript: Script.fromHex(dest.outputs[0].script), satoshis: 1234 });

    // Wrong amount is refused.
    const bad = new Transaction();
    bad.addOutput({ lockingScript: Script.fromHex(dest.outputs[0].script), satoshis: 1000 });
    expect((await h.receive({ handle: 'carol@pay.test' }, { hex: bad.toHex(), reference: dest.reference }))[0]).toBe(
      400,
    );

    const [rs, rr] = await h.receive({ handle: 'carol@pay.test' }, { hex: tx.toHex(), reference: dest.reference });
    expect(rs).toBe(200);
    expect(rr.txid).toBe(tx.id('hex'));
    expect(broadcasts).toEqual([tx.id('hex')]);
    // Idempotent re-delivery; a different tx for the same reference is refused.
    expect((await h.receive({ handle: 'carol@pay.test' }, { hex: tx.toHex(), reference: dest.reference }))[0]).toBe(
      200,
    );
    expect((await h.receive({ handle: 'carol@pay.test' }, { hex: bad.toHex(), reference: dest.reference }))[0]).toBe(
      409,
    );

    // Inbox requires the owner's signature.
    expect((await h.inbox({}, await user().sign('inbox', {})))[1].payments).toHaveLength(0);
    const [is, inbox] = await h.inbox({}, await u.sign('inbox', {}));
    expect(is).toBe(200);
    expect(inbox.payments).toHaveLength(1);
    const p = inbox.payments[0];
    expect(p.outputs[0].vout).toBe(2);

    // The wallet derives the matching key: identity priv, counterparty = anyone (BRC-29 wallet payment).
    const child = new KeyDeriver(u.priv).derivePrivateKey(
      pm.BRC29,
      `${p.outputs[0].derivationPrefix} ${p.outputs[0].derivationSuffix}`,
      inbox.senderIdentityKey,
    );
    expect(new P2PKH().lock(child.toAddress()).toHex()).toBe(dest.outputs[0].script);

    const [as, ar] = await h.ack({}, await u.sign('ack', { references: p.reference }));
    expect(as).toBe(200);
    expect(ar.collected).toBe(1);
    expect((await h.inbox({}, await u.sign('inbox', {})))[1].payments).toHaveLength(0);
    // Restore from seed: history still returns the collected payment with its derivation, only to its owner.
    const [hs, hist] = await h.history({}, await u.sign('history', {}));
    expect(hs).toBe(200);
    expect(hist.payments).toHaveLength(1);
    expect(hist.payments[0].status).toBe('collected');
    expect(hist.payments[0].outputs[0].derivationPrefix).toBe(p.outputs[0].derivationPrefix);
    expect((await h.history({}, await user().sign('history', {})))[1].payments).toHaveLength(0);
    expect((await h.history({}, await u.sign('inbox', {})))[0]).toBe(401);
  });

  test('unknown reference / unknown alias', async () => {
    const h = pm.makeHandlers({ store: memStore(), env: ENV });
    expect((await h.p2pDestination({ handle: 'nobody@pay.test' }, { satoshis: 1 }))[0]).toBe(404);
    expect((await h.receive({ handle: 'nobody@pay.test' }, { hex: '00', reference: 'x' }))[0]).toBe(404);
  });
});

describe('multiple domains', () => {
  const MULTI = {
    PAYMAIL_DOMAIN: 'b0ase.com',
    PAYMAIL_DOMAINS: ' bwallet-nine.vercel.app, B0ASE.com ,,old.test',
    PAYMAIL_BASE_URL: 'https://pay.b0ase.com/',
  };

  test('primary first, de-duplicated, lower-cased', () => {
    expect(pm.domains(MULTI)).toEqual(['b0ase.com', 'bwallet-nine.vercel.app', 'old.test']);
    expect(pm.domain(MULTI)).toBe('b0ase.com');
    expect(pm.domain({ PAYMAIL_DOMAINS: 'a.test,b.test' })).toBe('a.test');
  });

  test('capabilities use PAYMAIL_BASE_URL, not the paymail domain', () => {
    const c = pm.capabilities(MULTI).capabilities;
    for (const v of Object.values(c)) expect(v.startsWith('https://pay.b0ase.com/api/paymail/')).toBe(true);
    expect(pm.baseUrl({ PAYMAIL_DOMAIN: 'b0ase.com' })).toBe('https://b0ase.com');
  });

  test('parseHandle accepts every listed domain only', () => {
    expect(pm.parseHandle('alice@b0ase.com', MULTI)).toBe('alice');
    expect(pm.parseHandle('alice@bwallet-nine.vercel.app', MULTI)).toBe('alice');
    expect(pm.parseHandle('alice@old.test', MULTI)).toBe('alice');
    expect(pm.parseHandle('alice@pay.b0ase.com', MULTI)).toBeNull();
  });

  test('one alias resolves to the same record on every domain; register uses the primary', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: MULTI });
    const u = user();
    const [, r] = await h.register({}, await u.sign('register', { alias: 'alice' }));
    expect(r.paymail).toBe('alice@b0ase.com');
    for (const d of ['b0ase.com', 'bwallet-nine.vercel.app', 'old.test']) {
      const [s, pki] = await h.pki({ handle: `alice@${d}` });
      expect(s).toBe(200);
      expect(pki.pubkey).toBe(u.identityKey);
      expect(pki.handle).toBe(`alice@${d}`);
      expect((await h.verify({ handle: `alice@${d}`, pubkey: u.identityKey }))[1].match).toBe(true);
    }
    expect((await h.pki({ handle: 'alice@elsewhere.test' }))[0]).toBe(404);
    expect((await h.lookup({ key: u.identityKey }))[1].paymail).toBe('alice@b0ase.com');
  });

  test('aliases are unique across domains', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: MULTI });
    expect((await h.register({}, await user().sign('register', { alias: 'bob' })))[0]).toBe(200);
    // Same alias under an old domain's env is still the same record → taken.
    const old = pm.makeHandlers({ store, env: { PAYMAIL_DOMAIN: 'old.test', PAYMAIL_DOMAINS: 'b0ase.com' } });
    expect((await old.register({}, await user().sign('register', { alias: 'bob' })))[0]).toBe(409);
  });

  test('P2P destination works through an old domain', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: MULTI });
    await h.register({}, await user().sign('register', { alias: 'carol' }));
    const [s, out] = await h.p2pDestination({ handle: 'carol@bwallet-nine.vercel.app' }, { satoshis: 1000 });
    expect(s).toBe(200);
    expect(store.pays.get(out.reference).alias).toBe('carol');
  });
});

describe('production config: bwallet.space primary, b0ase.com legacy', () => {
  const PROD = {
    PAYMAIL_DOMAIN: 'bwallet.space',
    PAYMAIL_DOMAINS: 'b0ase.com',
    PAYMAIL_BASE_URL: 'https://pay.bwallet.space',
  };

  test('domains, base URL and capabilities', () => {
    expect(pm.domains(PROD)).toEqual(['bwallet.space', 'b0ase.com']);
    expect(pm.domain(PROD)).toBe('bwallet.space');
    expect(pm.baseUrl(PROD)).toBe('https://pay.bwallet.space');
    for (const v of Object.values(pm.capabilities(PROD).capabilities)) {
      expect(v.startsWith('https://pay.bwallet.space/api/paymail/')).toBe(true);
    }
  });

  test('new names register on bwallet.space; legacy b0ase.com addresses still resolve', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: PROD });
    const u = user();
    const [, r] = await h.register({}, await u.sign('register', { alias: 'dave' }));
    expect(r.paymail).toBe('dave@bwallet.space');
    for (const d of ['bwallet.space', 'b0ase.com']) {
      const [s, pki] = await h.pki({ handle: `dave@${d}` });
      expect(s).toBe(200);
      expect(pki.handle).toBe(`dave@${d}`);
    }
    expect(pm.parseHandle('dave@pay.bwallet.space', PROD)).toBeNull();
    expect((await h.lookup({ key: u.identityKey }))[1].paymail).toBe('dave@bwallet.space');
  });

  test('a name claimed under b0ase.com stays the same record on bwallet.space', async () => {
    const store = memStore();
    const old = pm.makeHandlers({ store, env: { PAYMAIL_DOMAIN: 'b0ase.com' } });
    const u = user();
    await old.register({}, await u.sign('register', { alias: 'erin' }));
    const h = pm.makeHandlers({ store, env: PROD });
    expect((await h.pki({ handle: 'erin@bwallet.space' }))[1].pubkey).toBe(u.identityKey);
    const [s] = await h.p2pDestination({ handle: 'erin@b0ase.com' }, { satoshis: 1000 });
    expect(s).toBe(200);
    expect((await h.register({}, await user().sign('register', { alias: 'erin' })))[0]).toBe(409);
  });
});

describe('delete (account deletion)', () => {
  test('a signed delete removes the alias and its inbox; others are untouched', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const v = user();
    await h.register({}, await u.sign('register', { alias: 'gone' }));
    await h.register({}, await v.sign('register', { alias: 'stays' }));
    store.pays.set('r1', { reference: 'r1', identity_key: u.identityKey, alias: 'gone', status: 'collected' });
    expect((await h.delete({}, await u.sign('delete', { confirm: 'nope' })))[0]).toBe(400);
    const [s, r] = await h.delete({}, await u.sign('delete', { confirm: 'DELETE' }));
    expect(s).toBe(200);
    expect(r).toMatchObject({ deleted: true, alias: 'gone', aliases: 1, payments: 1 });
    expect(store.aliases.has('gone')).toBe(false);
    expect(store.aliases.has('stays')).toBe(true);
    expect((await h.pki({ handle: 'gone@pay.test' }))[0]).toBe(404);
  });

  test('refuses a delete signed by another key', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const v = user();
    await h.register({}, await u.sign('register', { alias: 'mine' }));
    const forged = { ...(await v.sign('delete', { confirm: 'DELETE' })), identityKey: u.identityKey };
    expect((await h.delete({}, forged))[0]).toBe(401);
    expect(store.aliases.has('mine')).toBe(true);
  });
});

describe('reserved names (owner, 9 Oct 2026)', () => {
  test('company and product names refuse, with or without a social suffix', () => {
    for (const a of [
      'bcorp',
      'bcorp.x',
      'bcorp.gmail',
      'bwallet',
      'bwalletx.x',
      'bchatx',
      'npg.x',
      'admin.gmail',
      'satoshi.x',
      'bsv',
      'craigwright.x',
    ])
      expect(pm.validAlias(a)).toBe('That alias is reserved');
  });
  test('ordinary names, including look-alikes, still pass', () => {
    for (const a of ['b0asex.x', 'alice', 'bcorpfan', 'theirname.gmail', 'craig.x'])
      expect(pm.validAlias(a)).toBeNull();
  });
});

describe("everything after a dot is the system's", () => {
  test('people can never claim .agent, .bot or any other dotted name', () => {
    for (const a of [
      'vexvoid.agent',
      'VexVoid.AGENT',
      'someone.bot',
      'alex.1111',
      'shop.com',
      'vexvoid\u2024agent',
      'vexvoid\uFF0Eagent',
      'vex\u200Bvoid.agent',
      'vexvoid\u3002bot',
    ])
      expect(pm.validAlias(a)).toBe(pm.dotRefusal(a) || 'expected a refusal');
  });
  test('the ticket-gated social names still pass the dot rule', () => {
    for (const a of ['b0asex.x', 'theirname.gmail']) expect(pm.dotRefusal(a)).toBeNull();
    expect(pm.SYSTEM_TLDS).toEqual(expect.arrayContaining(['agent', 'bot', 'x', 'gmail']));
  });
  test('plain names are untouched', () => {
    for (const a of ['vexvoid', 'vexvoid-agent', 'bot']) expect(pm.dotRefusal(a)).toBeNull();
  });
});

describe('renamed handles keep receiving', () => {
  test('an old name answers as the new one via bit-sign', async () => {
    const store = memStore();
    const h0 = pm.makeHandlers({ store, env: ENV });
    const u = user();
    expect((await h0.register({}, await u.sign('register', { alias: 'newname' })))[0]).toBe(200);
    const h = pm.makeHandlers({ store, env: ENV, renamed: async (a) => (a === 'oldname' ? 'newname' : null) });
    const [s, r] = await h.pki({ handle: 'oldname@pay.test' });
    expect(s).toBe(200);
    expect(r.pubkey).toBe(u.identityKey);
    expect(r.handle).toBe('newname@pay.test');
    expect((await h.pki({ handle: 'nobody@pay.test' }))[0]).toBe(404);
  });

  test('a wallet rename forwards the old name for 90 days, then releases it', async () => {
    const store = memStore();
    let t = Date.now();
    const h = pm.makeHandlers({ store, env: ENV, now: () => t });
    const u = user();
    const other = user();
    expect((await h.register({}, await u.sign('register', { alias: 'firstname' })))[0]).toBe(200);
    expect((await h.register({}, await u.sign('register', { alias: 'secondname' })))[0]).toBe(200);
    for (const fn of ['pki', 'profile', 'p2pDestination'].filter((k) => h[k])) {
      const [s] = await h[fn]({ handle: 'firstname@pay.test' }, { satoshis: 1000 });
      expect(s).toBe(200);
    }
    const [s, r] = await h.pki({ handle: 'firstname@pay.test' });
    expect(s).toBe(200);
    expect(r.pubkey).toBe(u.identityKey);
    expect(r.handle).toBe('secondname@pay.test');
    // Nobody else can take it while it forwards.
    expect((await h.register({}, await other.sign('register', { alias: 'firstname' })))[0]).toBe(409);
    // A second rename keeps both old names pointing at the newest.
    expect((await h.register({}, await u.sign('register', { alias: 'thirdname' })))[0]).toBe(200);
    expect((await h.pki({ handle: 'firstname@pay.test' }))[1].handle).toBe('thirdname@pay.test');
    expect((await h.pki({ handle: 'secondname@pay.test' }))[1].handle).toBe('thirdname@pay.test');
    const fw = await store.getForward('firstname');
    expect(Date.parse(fw.expires_at) - t).toBe(pm.FORWARD_MS);
    // After 90 days it's released.
    t += pm.FORWARD_MS + 1000;
    expect((await h.pki({ handle: 'firstname@pay.test' }))[0]).toBe(404);
    expect(await store.getForward('firstname')).toBeNull();
    t = Date.now(); // signatures are checked against real time
    expect((await h.register({}, await other.sign('register', { alias: 'firstname' })))[0]).toBe(200);
  });

  test('a permanent extra name (no expiry) receives for the wallet', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    expect((await h.register({}, await u.sign('register', { alias: 'mainname' })))[0]).toBe(200);
    await store.putForward({
      from_alias: 'extraname',
      to_alias: 'mainname',
      identity_key: u.identityKey,
      expires_at: null,
    });
    const [s, r] = await h.pki({ handle: 'extraname@pay.test' });
    expect(s).toBe(200);
    expect(r.pubkey).toBe(u.identityKey);
    // A forward whose key doesn't own the target is ignored.
    await store.putForward({
      from_alias: 'spoof',
      to_alias: 'mainname',
      identity_key: user().identityKey,
      expires_at: null,
    });
    expect((await h.pki({ handle: 'spoof@pay.test' }))[0]).toBe(404);
  });

  test('bitsignRenamed reads the public profile API', async () => {
    const f = async (url) => ({
      ok: true,
      json: async () => ({ handle: url.endsWith('/oldname') ? 'NewName' : 'same' }),
    });
    expect(await pm.bitsignRenamed('oldname', { BITSIGN_PUBLIC_URL: 'https://bs.test/' }, f)).toBe('newname');
    expect(await pm.bitsignRenamed('same', {}, f)).toBeNull();
    expect(await pm.bitsignRenamed('b0asex.x', {}, f)).toBeNull();
    expect(await pm.bitsignRenamed('x', {}, async () => ({ ok: false }))).toBeNull();
  });
});

// ---- anti-squatting (owner, 10 Oct 2026) ----
const antiStore = () => {
  const s = memStore();
  s.events = [];
  s.fees = new Set();
  s.lastRename = async (k) =>
    s.events
      .filter((e) => e.identity_key === k && e.kind === 'rename')
      .map((e) => e.created_at)
      .sort()
      .pop() ?? null;
  s.countIpClaims = async (ip, since) => s.events.filter((e) => e.ip_hash === ip && e.created_at >= since).length;
  s.recordNameEvent = async (r) => void s.events.push({ ...r, created_at: new Date(s.clock()).toISOString() });
  s.useFeeTx = async (r) => (s.fees.has(r.txid) ? false : (s.fees.add(r.txid), true));
  s.retireToForward = async (from, to, k, exp) => {
    await s.putForward({ from_alias: from, to_alias: to, identity_key: k, expires_at: exp });
    for (const p of s.pays.values()) if (p.alias === from) p.alias = to;
    s.aliases.delete(from);
  };
  s.clock = () => Date.now();
  return s;
};
const DAY = 86_400_000;

describe('name limits', () => {
  test('first claim is free of the cooldown; one rename per 30 days with a dated message', async () => {
    const store = antiStore();
    let t = Date.now();
    store.clock = () => t;
    const h = pm.makeHandlers({ store, env: ENV, now: () => t });
    const u = user();
    expect((await h.register({}, await u.sign('register', { alias: 'first' }, t), { ip: '1.1.1.1' }))[0]).toBe(200);
    expect((await h.register({}, await u.sign('register', { alias: 'second' }, t), { ip: '1.1.1.1' }))[0]).toBe(200);
    const [s, r] = await h.register({}, await u.sign('register', { alias: 'third' }, t), { ip: '1.1.1.1' });
    expect(s).toBe(429);
    expect(r.error).toMatch(/^You can change your name again on \d+ \w+ \d{4}\.$/);
    // A profile update of its own name is not a change.
    expect((await h.register({}, await u.sign('register', { alias: 'second', name: 'Me' }, t), {}))[0]).toBe(200);
    t += 31 * DAY;
    expect((await h.register({}, await u.sign('register', { alias: 'third' }, t), { ip: '2.2.2.2' }))[0]).toBe(200);
  });

  test('caps new names per IP per day (hashed IP)', async () => {
    const store = antiStore();
    const h = pm.makeHandlers({ store, env: { ...ENV, PAYMAIL_NAMES_PER_IP_DAY: '2' } });
    for (const a of ['ipa', 'ipb'])
      expect((await h.register({}, await user().sign('register', { alias: a }), { ip: '9.9.9.9' }))[0]).toBe(200);
    const [s, r] = await h.register({}, await user().sign('register', { alias: 'ipc' }), { ip: '9.9.9.9' });
    expect(s).toBe(429);
    expect(r.error).toMatch(/Too many new names/);
    expect(store.events[0].ip_hash).not.toContain('9.9.9.9');
    expect((await h.register({}, await user().sign('register', { alias: 'ipc' }), { ip: '8.8.8.8' }))[0]).toBe(200);
  });

  test('an expired forward is released; a live one blocks others', async () => {
    const store = antiStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const owner = user();
    await store.putForward({
      from_alias: 'held',
      to_alias: 'x1',
      identity_key: owner.identityKey,
      expires_at: new Date(Date.now() + DAY).toISOString(),
    });
    await store.putForward({
      from_alias: 'gone',
      to_alias: 'x1',
      identity_key: owner.identityKey,
      expires_at: new Date(Date.now() - 1).toISOString(),
    });
    expect((await h.register({}, await user().sign('register', { alias: 'held' })))[0]).toBe(409);
    expect((await h.register({}, await user().sign('register', { alias: 'gone' })))[0]).toBe(200);
    expect(await store.getForward('gone')).toBeNull();
  });

  test('a .gmail-only wallet that picks a name: the .gmail name becomes a 90-day forward', async () => {
    const store = antiStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    await store.upsertAlias({ kind: 'gmail', alias: 'someone.gmail', identity_key: u.identityKey });
    expect((await h.lookup({ key: u.identityKey }))[1].alias).toBe('someone.gmail');
    expect((await h.register({}, await u.sign('register', { alias: 'someone' })))[0]).toBe(200);
    expect(store.aliases.has('someone.gmail')).toBe(false);
    const fw = await store.getForward('someone.gmail');
    expect(fw.to_alias).toBe('someone');
    expect(Date.parse(fw.expires_at) - Date.now()).toBeGreaterThan(89 * DAY);
    expect((await h.pki({ handle: 'someone.gmail@pay.test' }))[1].pubkey).toBe(u.identityKey);
    expect(store.events[0].kind).toBe('claim');
  });
});

describe('1 cent name fee', () => {
  const FEE_ADDR = PrivateKey.fromRandom().toAddress();
  const FENV = { ...ENV, BWALLET_NAME_FEE_ADDRESS: FEE_ADDR };
  const RATE = 50; // $50/BSV → 1¢ = 20,000 sats
  const payTx = (sats, to = FEE_ADDR) => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new P2PKH().lock(to), satoshis: sats });
    return tx;
  };
  const mockChain = (txs) => ({
    tx: async (id) => txs.find((t) => t.id('hex') === id) ?? null,
    bsvUsd: async () => RATE,
  });

  test('config: off without the env var, on with it', async () => {
    expect((await pm.makeHandlers({ store: memStore(), env: ENV }).config())[1].nameFee).toBeNull();
    expect((await pm.makeHandlers({ store: memStore(), env: FENV }).config())[1].nameFee).toEqual({
      address: FEE_ADDR,
      usd: 0.01,
    });
  });

  test('no fee configured: claims work as before', async () => {
    const h = pm.makeHandlers({ store: antiStore(), env: ENV, feeChain: mockChain([]) });
    expect((await h.register({}, await user().sign('register', { alias: 'freebie' })))[0]).toBe(200);
  });

  test('needs a paying txid, allows 20% slippage, refuses reuse and underpayment', async () => {
    const good = payTx(16_500); // ≥ 80% of 20,000
    const low = payTx(15_000);
    const wrong = payTx(30_000, PrivateKey.fromRandom().toAddress());
    const store = antiStore();
    const h = pm.makeHandlers({ store, env: FENV, feeChain: mockChain([good, low, wrong]) });
    const [s0, r0] = await h.register({}, await user().sign('register', { alias: 'paid' }));
    expect(s0).toBe(402);
    expect(r0.nameFee.address).toBe(FEE_ADDR);
    expect((await h.register({}, await user().sign('register', { alias: 'paid', feeTxid: low.id('hex') })))[0]).toBe(
      402,
    );
    expect((await h.register({}, await user().sign('register', { alias: 'paid', feeTxid: wrong.id('hex') })))[0]).toBe(
      402,
    );
    const u = user();
    const [s1, r1] = await h.register({}, await u.sign('register', { alias: 'paid', feeTxid: good.id('hex') }));
    expect(s1).toBe(200);
    expect(r1.feeTxid).toBe(good.id('hex'));
    expect((await h.register({}, await user().sign('register', { alias: 'paid2', feeTxid: good.id('hex') })))[0]).toBe(
      409,
    );
    // Updating your own name's profile pays nothing.
    expect((await h.register({}, await u.sign('register', { alias: 'paid', name: 'P' })))[0]).toBe(200);
  });

  test('a tx the indexers have not seen is accepted from the app once our broadcast takes it', async () => {
    const tx = payTx(20_000);
    const sent = [];
    const h = pm.makeHandlers({
      store: antiStore(),
      env: FENV,
      feeChain: mockChain([]),
      broadcast: async (t) => void sent.push(t.id('hex')),
    });
    const body = { ...(await user().sign('register', { alias: 'fresh', feeTxid: tx.id('hex') })), feeTx: tx.toHex() };
    expect((await h.register({}, body))[0]).toBe(200);
    expect(sent).toEqual([tx.id('hex')]);
  });
});

describe('b_feedback 67: destinations the payer can check', () => {
  test('each P2P output carries the derivation that re-derives its script from the identity key', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'dora' }));
    const [s, dest] = await h.p2pDestination({ handle: 'dora@pay.test' }, { satoshis: 500 });
    expect(s).toBe(200);
    const o = dest.outputs[0];
    expect(typeof o.derivationPrefix).toBe('string');
    expect(typeof o.derivationSuffix).toBe('string');
    expect(o.senderIdentityKey).toBe(new PrivateKey(1).toPublicKey().toString());
    const pub = new KeyDeriver(new PrivateKey(1)).derivePublicKey(
      [2, '3241645161d8'],
      `${o.derivationPrefix} ${o.derivationSuffix}`,
      u.identityKey,
      false,
    );
    expect(o.script).toBe(new P2PKH().lock(pub.toAddress()).toHex());
  });

  test('ord answers carry the owner-signed proof; a bad proof is refused', async () => {
    const store = memStore();
    store.setOrdProof = async (alias, proof) => void (store.aliases.get(alias).ord_proof = proof);
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const ord = PrivateKey.fromRandom().toAddress();
    const proof = await u.sign('ord', { ordAddress: ord });
    const body = await u.sign('register', { alias: 'eve', ordAddress: ord });
    const bad = {
      timestamp: String(proof.timestamp),
      signature: (await user().sign('ord', { ordAddress: ord })).signature,
    };
    expect((await h.register({}, { ...body, ordProof: bad }))[0]).toBe(400);
    const good = { timestamp: String(proof.timestamp), signature: proof.signature };
    expect((await h.register({}, { ...body, ordProof: good }))[0]).toBe(200);
    const [, r] = await h.ord({ handle: 'eve@pay.test' });
    expect(r.address).toBe(ord);
    expect(r.ordProof).toEqual(good);
    // The address changed without a new proof: the old proof is not served for it.
    store.aliases.get('eve').ord_address = PrivateKey.fromRandom().toAddress();
    expect((await h.ord({ handle: 'eve@pay.test' }))[1].ordProof).toBeUndefined();
  });
});

describe('reserved alias held for a designated key', () => {
  const setup = () => {
    const owner = user();
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV, reservedOwners: { bwalletx: owner.identityKey } });
    return { owner, store, h };
  };
  test('the real allowlist maps bwalletx to the brand key only', () => {
    expect(pm.RESERVED_OWNERS).toEqual({
      bwalletx: '029c1abd9470d485719c512c0d704e6ccf6c1533461eb5884a5d09a6dc3dca55b7',
    });
  });
  test('availability shows Reserved for everyone else, and for no key at all', async () => {
    const { h } = setup();
    const other = user();
    for (const key of [undefined, other.identityKey]) {
      const [s, r] = await h.available({ alias: 'bwalletx', key });
      expect(s).toBe(200);
      expect(r.available).toBe(false);
      expect(r.reason).toBe('reserved');
      expect(r.message).toContain('kept for the bWalletX team');
    }
    expect((await h.available({ alias: 'admin', key: other.identityKey }))[1].reason).toBe('reserved');
    expect((await h.available({ alias: 'freename', key: other.identityKey }))[1].available).toBe(true);
    expect((await h.available({ alias: 'a.b', key: other.identityKey }))[1].reason).toBe('invalid');
  });
  test('availability is open for the designated key', async () => {
    const { h, owner } = setup();
    expect((await h.available({ alias: 'bwalletx', key: owner.identityKey }))[1]).toEqual({
      alias: 'bwalletx',
      available: true,
      reason: null,
    });
  });
  test('the designated key claims it with a valid signature; others are refused', async () => {
    const { h, owner, store } = setup();
    const other = user();
    expect((await h.register({}, await other.sign('register', { alias: 'bwalletx' })))[1].error).toBe(
      'That alias is reserved',
    );
    const [s, r] = await h.register({}, await owner.sign('register', { alias: 'bwalletx' }));
    expect(s).toBe(200);
    expect(r.paymail).toBe('bwalletx@pay.test');
    expect(store.aliases.get('bwalletx').identity_key).toBe(owner.identityKey);
    expect((await h.available({ alias: 'bwalletx', key: owner.identityKey }))[1].reason).toBe('mine');
    expect((await h.available({ alias: 'bwalletx', key: other.identityKey }))[1].reason).toBe('reserved');
  });
  test('a forged signature for the designated key fails', async () => {
    const { h, owner, store } = setup();
    const forger = user();
    const body = await forger.sign('register', { alias: 'bwalletx' });
    const [s, r] = await h.register({}, { ...body, identityKey: owner.identityKey });
    expect(s).toBe(401);
    expect(r.error).toBe('Bad signature');
    expect(store.aliases.has('bwalletx')).toBe(false);
  });
  test('the social form bwalletx.x stays reserved even for the designated key', async () => {
    const { h, owner } = setup();
    expect((await h.register({}, await owner.sign('register', { alias: 'bwalletx.x' })))[0]).toBe(400);
  });
});
