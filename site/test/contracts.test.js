// Exchange › Contracts catalogue: a paid listing must be signed by its author (owner, 14 Nov 2026, b-Aware row 115;
// the wallet side is src/mobile/contracts/contractNft.ts). These drive the real publish route (api/contracts.js)
// with the chain and the database answered in memory; every key is a throwaway made here.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { LockingScript, MerklePath, OP, P2PKH, PrivateKey, ProtoWallet, Transaction, Utils } from '@bsv/sdk';
import K from '../lib/strategyKeys.js';
import C from '../lib/contracts.js';
import api from '../api/contracts.js';

// ---- the signature, written out from the spec (not the module under test) ----
const sorted = (v) =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted(v[k])]),
        )
      : v;
const bytesToSign = (env) => {
  const { authorSig: _s, ...rest } = env;
  return Utils.toArray(JSON.stringify(sorted(rest)), 'utf8');
};
const person = (n) => {
  const priv = new PrivateKey(n);
  return { wallet: new ProtoWallet(priv), key: priv.toPublicKey().toString(), address: priv.toAddress() };
};
const ann = person(11);
const mallory = person(12);
/** The wallet's own publish: the author's key and handle, then the signature over the rest. */
const signAs = async (who, env, over = {}) => {
  const unsigned = { ...env, author: { ...env.author, identityKey: who.key, handle: 'ann@bwallet.space', ...over } };
  const { signature } = await who.wallet.createSignature({
    data: bytesToSign(unsigned),
    protocolID: [2, 'bwallet contract'],
    keyID: '1',
    counterparty: 'anyone',
  });
  return { ...unsigned, authorSig: Utils.toHex(signature) };
};
const listing = (who, priceUsd = 5, over = {}) => ({
  format: 'bwalletx.contract-nft/1',
  contract: { format: 'bwalletx.contract/1', name: 'NDA', version: '1', network: 'mainnet', summary: 's' },
  description: 'A plain NDA',
  author: { name: 'Ann Lawyer', address: who.address },
  sale: { priceUsd, copies: 10, payTo: who.address },
  ...over,
});

// ---- the chain and the catalogue tables, in memory ----
const txs = new Map();
/** txid → { height, index } once "mined"; anything else is unconfirmed. */
const positions = new Map();
let table = [];
/** The catalogue saw older rows an hour ago, a millisecond apart (the route stamps a new listing with now). */
const BASE = Date.now() - 3_600_000;
let clock = 0;
const queries = [];
const urls = [];
/** txids whose chain lookup fails (the API is down for them). */
const down = new Set();
/** PostgREST's `in.("a","b")` list, as the route quotes it. */
const inList = (v) => [...v.slice(4, -1).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
const fakeDb = async (url, init = {}) => {
  const u = new URL(url);
  const q = u.searchParams;
  if (u.pathname === '/rest/v1/bwallet_contract_copies')
    return init.method === 'POST' ? new Response('', { status: 201 }) : new Response('[]', { status: 200 });
  if (u.pathname !== '/rest/v1/bwallet_contracts') throw new Error(`unexpected fetch ${u.pathname}`);
  if (init.method === 'POST') {
    const row = JSON.parse(init.body);
    if (table.some((r) => r.origin === row.origin)) return new Response('{}', { status: 409 });
    table.push({ ...row, created_at: new Date(BASE + clock++).toISOString() });
    return new Response('', { status: 201 });
  }
  const name = q.get('envelope->contract->>name');
  if (name) queries.push(name);
  if (name) urls.push(u.search);
  const names = name?.startsWith('in.') ? inList(name) : name ? [name.slice(3)] : null;
  const out = table
    .filter((r) => !names || names.includes(r.envelope.contract.name))
    .filter((r) => !q.get('origin') || q.get('origin') === `eq.${r.origin}`)
    .filter((r) => !q.get('body_hash') || q.get('body_hash') === `eq.${r.body_hash}`)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) * (q.get('order')?.endsWith('desc') ? -1 : 1));
  return new Response(JSON.stringify(out), { status: 200 });
};
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
let saved;
beforeAll(() => {
  saved = { chain: { ...K.chain }, fetch: globalThis.fetch, env: ENV_KEYS.map((k) => process.env[k]) };
  K.chain.tx = async (txid) => txs.get(txid) ?? null;
  K.chain.spent = async () => false;
  K.chain.origin = async () => null;
  K.chain.position = async (txid) => {
    if (down.has(txid)) throw new Error('Chain position unavailable');
    return positions.get(txid) ?? null;
  };
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
  globalThis.fetch = fakeDb;
});
afterAll(() => {
  Object.assign(K.chain, saved.chain);
  globalThis.fetch = saved.fetch;
  ENV_KEYS.forEach((k, i) => {
    if (saved.env[i] === undefined) delete process.env[k];
    else process.env[k] = saved.env[i];
  });
});
beforeEach(() => {
  table = [];
  queries.length = 0;
  urls.length = 0;
  down.clear();
});

const inscribed = (body, to) => {
  const data = Utils.toArray(body, 'utf8');
  return new LockingScript([
    { op: OP.OP_FALSE },
    { op: OP.OP_IF },
    { op: 3, data: Utils.toArray('ord', 'utf8') },
    { op: OP.OP_1 },
    { op: C.CONTRACT_TYPE.length, data: Utils.toArray(C.CONTRACT_TYPE, 'utf8') },
    { op: OP.OP_0 },
    { op: OP.OP_PUSHDATA2, data },
    { op: OP.OP_ENDIF },
    ...new P2PKH().lock(to).chunks,
  ]);
};
let ip = 0;
const call = async (req) => {
  const res = {
    statusCode: 0,
    out: null,
    setHeader() {},
    end(s) {
      this.out = s ? JSON.parse(s) : null;
    },
  };
  await api({ url: '/api/contracts', headers: { 'x-forwarded-for': `10.0.0.${ip++}` }, ...req }, res);
  return [res.statusCode, res.out];
};
const proof = (action, outpoint, key) => {
  const message = K.proofMessage(action, outpoint, Date.now());
  return {
    outpoint,
    message,
    pubkey_hex: key.toPublicKey().toString(),
    signature: Utils.toHex(key.sign(Utils.toArray(message, 'utf8')).toDER()),
  };
};
/** Mint `env` to a fresh key (mined at `pos`, or unconfirmed) and publish it the way the wallet does. */
const mint = (env, pos) => {
  const minter = PrivateKey.fromRandom();
  const tx = new Transaction();
  tx.addOutput({ lockingScript: inscribed(JSON.stringify(env), minter.toAddress()), satoshis: 1 });
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 2 });
  const txid = tx.id('hex');
  txs.set(txid, tx);
  if (pos) positions.set(txid, pos);
  return { outpoint: `${txid}_0`, minter };
};
const publishMinted = ({ outpoint, minter }) =>
  call({ method: 'POST', body: { action: 'publish', ...proof('publish', outpoint, minter) } });
/** [status, body, { outpoint, minter }] */
const publish = async (env, pos) => {
  const m = mint(env, pos);
  return [...(await publishMinted(m)), m];
};
/** Origins the catalogue serves (GET), and one listing by origin. */
const served = async () => (await call({ method: 'GET' }))[1].contracts.map((c) => c.origin);
const getOne = async (origin) => (await call({ method: 'GET', url: `/api/contracts?origin=${origin}` }))[0];
/** The author's own original, registered as a copy (claim): 200 when the catalogue serves it. */
const claimOriginal = ({ outpoint, minter }) =>
  call({ method: 'POST', body: { action: 'claim', ...proof('unlock', outpoint, minter) } });
/** A row from before this check, put straight into the table (as an older catalogue stored it). */
const oldRow = (env) => {
  const m = mint(env);
  const body = JSON.stringify(env);
  table.push({
    origin: m.outpoint,
    envelope: env,
    body,
    body_hash: createHash('sha256').update(body).digest('hex'),
    created_at: new Date(BASE + clock++).toISOString(),
  });
  return m;
};

describe('contract catalogue: paid listings are signed by their author', () => {
  test('a genuine signed paid listing is listed', async () => {
    const [status, out] = await publish(await signAs(ann, listing(ann)));
    expect(status).toBe(200);
    expect(out.ok).toBe(true);
    expect(table).toHaveLength(1);
    expect(table[0].envelope.author.identityKey).toBe(ann.key);
  });

  test('an unsigned paid listing is refused, telling the author to update (owner, 14 Nov 2026)', async () => {
    const [status, out] = await publish(listing(ann));
    expect(status).toBe(400);
    // Older wallets show this text as it is, after minting.
    expect(out.error).toBe(
      "This contract wasn't listed: paid contracts now carry your signature. Update bWalletX (5.2.57 or later) and publish it again.",
    );
    expect(table).toHaveLength(0);
  });

  test('a bad signature is refused', async () => {
    const env = await signAs(ann, listing(ann));
    const last = (parseInt(env.authorSig.slice(-2), 16) ^ 1).toString(16).padStart(2, '0');
    expect((await publish({ ...env, authorSig: env.authorSig.slice(0, -2) + last }))[0]).toBe(400);
    expect((await publish({ ...env, authorSig: 'ab'.repeat(35) }))[0]).toBe(400);
    expect((await publish({ ...env, authorSig: 'not hex' }))[0]).toBe(400);
    expect(table).toHaveLength(0);
  });

  test('a field changed after signing is refused (price, copies, payee, text)', async () => {
    const env = await signAs(ann, listing(ann));
    expect((await publish({ ...env, sale: { ...env.sale, priceUsd: 50 } }))[0]).toBe(400);
    expect((await publish({ ...env, sale: { ...env.sale, copies: 1000 } }))[0]).toBe(400);
    expect((await publish({ ...env, description: 'A different NDA' }))[0]).toBe(400);
    // Redirecting the money needs both the payee and the author's address changed: the signature covers both.
    const to = mallory.address;
    expect(
      (await publish({ ...env, author: { ...env.author, address: to }, sale: { ...env.sale, payTo: to } }))[0],
    ).toBe(400);
    expect((await publish({ ...env, author: { ...env.author, handle: 'mallory@bwallet.space' } }))[0]).toBe(400);
    expect(table).toHaveLength(0);
  });

  test("the wrong key is refused: another key's signature, or another author's key claimed", async () => {
    // Mallory signs but claims Ann's key.
    const claimsAnn = await signAs(mallory, listing(ann), { identityKey: ann.key });
    expect((await publish(claimsAnn))[0]).toBe(400);
    // Ann's genuine signature with the key swapped for Mallory's.
    const env = await signAs(ann, listing(ann));
    expect((await publish({ ...env, author: { ...env.author, identityKey: mallory.key } }))[0]).toBe(400);
    expect(table).toHaveLength(0);
  });

  test("a signed paid listing that pays anyone but the author's address is refused", async () => {
    const env = await signAs(ann, listing(ann, 5, { sale: { priceUsd: 5, copies: 10, payTo: mallory.address } }));
    const [status, out] = await publish(env);
    expect(status).toBe(400);
    expect(out.error).toContain('author’s address');
    expect(table).toHaveLength(0);
  });

  test('a malformed identity key is refused', async () => {
    const upper = ann.key.toUpperCase();
    const uncompressed = new PrivateKey(11).toPublicKey().encode(false, 'hex');
    for (const bad of [upper, uncompressed, `04${ann.key.slice(2)}`, ann.key.slice(0, 64), 42]) {
      // Signed over the bad claim by Ann's real key: only the key's shape is wrong.
      const unsigned = { ...listing(ann), author: { ...listing(ann).author, identityKey: bad } };
      const { signature } = await ann.wallet.createSignature({
        data: bytesToSign(unsigned),
        protocolID: [2, 'bwallet contract'],
        keyID: '1',
        counterparty: 'anyone',
      });
      expect((await publish({ ...unsigned, authorSig: Utils.toHex(signature) }))[0]).toBe(400);
    }
    expect(table).toHaveLength(0);
  });

  test('a clone under another key is refused; the earliest listing stays', async () => {
    expect((await publish(await signAs(ann, listing(ann))))[0]).toBe(200);
    // Same contract and description, Mallory's own key, address and payee: a valid signed listing on its own.
    const clone = await signAs(mallory, listing(mallory));
    const [status, out] = await publish(clone);
    expect(status).toBe(409);
    expect(out.error).toContain('Someone listed this text moments before you');
    expect(table).toHaveLength(1);
    expect(table[0].envelope.author.identityKey).toBe(ann.key);
    // The lookup asked only for listings of this contract's name (as PostgREST reads the encoded query).
    expect(queries).toContain('eq.NDA');
    // Key order in the descriptor doesn't hide a clone.
    const reordered = await signAs(
      mallory,
      listing(mallory, 5, {
        contract: { summary: 's', network: 'mainnet', version: '1', name: 'NDA', format: 'bwalletx.contract/1' },
      }),
    );
    expect((await publish(reordered))[0]).toBe(409);
    // Ann listing it again, and Mallory listing a different contract, are fine.
    expect((await publish(await signAs(ann, listing(ann, 7))))[0]).toBe(200);
    expect((await publish(await signAs(mallory, listing(mallory, 5, { description: 'Mallory’s NDA' }))))[0]).toBe(200);
  });

  test('an unsigned free clone under another address is refused', async () => {
    expect((await publish(listing(ann, 0)))[0]).toBe(200);
    expect((await publish(listing(mallory, 0)))[0]).toBe(409);
    expect(table).toHaveLength(1);
  });

  test('a free unsigned listing is still listed, as before', async () => {
    const [status, out] = await publish(listing(ann, 0));
    expect(status).toBe(200);
    expect(out.ok).toBe(true);
    expect(table[0].envelope.authorSig).toBeUndefined();
  });

  test('a free listing from the wallet (signed) is listed', async () => {
    expect((await publish(await signAs(ann, listing(ann, 0))))[0]).toBe(200);
  });
});

describe('contract catalogue: who keeps a contract (review of 2e409da3)', () => {
  test("an unsigned free listing doesn't block the real author's signed listing", async () => {
    const [, , squat] = await publish(listing(mallory, 0));
    const [status, , anns] = await publish(await signAs(ann, listing(ann)));
    expect(status).toBe(200);
    expect((await served()).sort()).toEqual([squat.outpoint, anns.outpoint].sort());
  });

  test("an unsigned free copy under the author's own name and address is refused after a signed listing", async () => {
    expect((await publish(await signAs(ann, listing(ann))))[0]).toBe(200);
    const [status, out] = await publish(listing(ann, 0));
    expect(status).toBe(409);
    expect(out.error).toContain('Someone listed this text moments before you');
    expect(table).toHaveLength(1);
  });

  test('the earliest on chain stays, not the first to reach the catalogue (front-running)', async () => {
    // Ann mints first (block 100); Mallory copies it from the chain, mints later (block 101) and lists first.
    const anns = mint(await signAs(ann, listing(ann)), { height: 100, index: 5 });
    const [first, , mal] = await publish(await signAs(mallory, listing(mallory)), { height: 101, index: 0 });
    expect(first).toBe(200);
    expect((await publishMinted(anns))[0]).toBe(200);
    expect(await served()).toEqual([anns.outpoint]);
    expect(await getOne(mal.outpoint)).toBe(404);
    expect(await getOne(anns.outpoint)).toBe(200);
    expect(await claimOriginal(mal)).toEqual([404, { error: 'This contract isn’t listed' }]);
    expect((await claimOriginal(anns))[0]).toBe(200);
    // And Mallory can't list her copy again.
    expect((await publish(await signAs(mallory, listing(mallory)), { height: 102, index: 0 }))[0]).toBe(409);
  });

  test('in one block, the catalogue saw it first wins, not the position in the block', async () => {
    // A copier who sees the original in the mempool can get an earlier position in the same block.
    const [first, , anns] = await publish(await signAs(ann, listing(ann)), { height: 100, index: 9 });
    expect(first).toBe(200);
    const [status, out] = await publish(await signAs(mallory, listing(mallory)), { height: 100, index: 2 });
    expect(status).toBe(409);
    expect(out.error).toBe('This contract is already listed by another author');
    expect(await served()).toEqual([anns.outpoint]);
  });

  test('an unconfirmed listing ranks after a confirmed one; two unconfirmed: the catalogue saw it first', async () => {
    const [, , anns] = await publish(await signAs(ann, listing(ann)));
    expect((await publish(await signAs(mallory, listing(mallory)), { height: 100, index: 0 }))[0]).toBe(200);
    expect(await served()).not.toContain(anns.outpoint);
    table = [];
    expect((await publish(await signAs(ann, listing(ann))))[0]).toBe(200);
    expect((await publish(await signAs(mallory, listing(mallory))))[0]).toBe(409);
  });

  test('older rows: an unsigned or badly signed paid listing is never served or counted; free ones still are', async () => {
    const unsigned = oldRow(listing(ann, 5, { contract: { ...listing(ann).contract, name: 'Old' } }));
    const signed = await signAs(ann, listing(ann, 5, { contract: { ...listing(ann).contract, name: 'Forged' } }));
    const forged = oldRow({ ...signed, sale: { ...signed.sale, priceUsd: 500 } });
    const free = oldRow(listing(ann, 0, { contract: { ...listing(ann).contract, name: 'Free' } }));
    expect(await served()).toEqual([free.outpoint]);
    expect(await getOne(unsigned.outpoint)).toBe(404);
    expect(await getOne(forged.outpoint)).toBe(404);
    expect(await claimOriginal(unsigned)).toEqual([404, { error: 'This contract isn’t listed' }]);
    expect(await claimOriginal(forged)).toEqual([404, { error: 'This contract isn’t listed' }]);
    expect((await claimOriginal(free))[0]).toBe(200);
  });

  test("an older unsigned paid copy doesn't block the author's signed listing", async () => {
    oldRow(listing(mallory));
    expect((await publish(await signAs(ann, listing(ann))))[0]).toBe(200);
  });

  test('names with PostgREST punctuation are quoted in the catalogue lookup', async () => {
    const odd = 'a,b) "c" \\d';
    const [, , m] = await publish(listing(ann, 0, { contract: { ...listing(ann).contract, name: odd } }));
    expect(await served()).toEqual([m.outpoint]);
  });
});

describe('contract catalogue: when the chain can’t be checked (re-review of f3ff8a37)', () => {
  const txidOf = (m) => m.outpoint.split('_')[0];

  test('a failed lookup for the original never serves the copy: none of that contract is served', async () => {
    // Ann earlier on chain, Mallory listed first; both rows are in the catalogue.
    const anns = mint(await signAs(ann, listing(ann)), { height: 100, index: 5 });
    const [, , mal] = await publish(await signAs(mallory, listing(mallory)), { height: 101, index: 0 });
    const annsRow = await signAs(ann, listing(ann));
    table.push({
      origin: anns.outpoint,
      envelope: annsRow,
      body: '',
      body_hash: 'x',
      created_at: new Date().toISOString(),
    });
    // An unrelated contract is still served.
    const [, , other] = await publish(listing(ann, 0, { contract: { ...listing(ann).contract, name: 'Other' } }));
    down.add(txidOf(anns));
    expect(await served()).toEqual([other.outpoint]);
    expect(await getOne(mal.outpoint)).toBe(503);
    expect(await getOne(anns.outpoint)).toBe(503);
    expect((await claimOriginal(mal))[0]).toBe(503);
    // The failure wasn't kept as a position: once the lookup works, the original is served.
    down.clear();
    expect((await served()).sort()).toEqual([anns.outpoint, other.outpoint].sort());
    // And now that the order is proven, a later failure doesn't hide it.
    down.add(txidOf(anns));
    down.add(txidOf(mal));
    expect((await served()).sort()).toEqual([anns.outpoint, other.outpoint].sort());
  });

  test('publish answers 503 and lists nothing when the chain can’t be checked', async () => {
    const [, , mal] = await publish(await signAs(mallory, listing(mallory)), { height: 101, index: 0 });
    const anns = mint(await signAs(ann, listing(ann)), { height: 100, index: 5 });
    down.add(txidOf(anns));
    expect(await publishMinted(anns)).toEqual([
      503,
      { error: 'Couldn’t check the chain just now. Nothing was listed; try again shortly.' },
    ]);
    expect(table).toHaveLength(1);
    // The same outpoint can be published again once the chain answers.
    down.clear();
    expect((await publishMinted(anns))[0]).toBe(200);
    expect(await served()).toEqual([anns.outpoint]);
    expect(await getOne(mal.outpoint)).toBe(404);
  });

  test('the author beaten while unconfirmed is told to try again, and the same outpoint lists once it confirms first', async () => {
    const [, , mal] = await publish(await signAs(mallory, listing(mallory)));
    const [status, out, anns] = await publish(await signAs(ann, listing(ann)));
    expect(status).toBe(409);
    expect(out.error).toBe(
      'Someone listed this text moments before you. Try again in a few minutes, once your contract has confirmed.',
    );
    positions.set(txidOf(anns), { height: 100, index: 3 });
    positions.set(txidOf(mal), { height: 101, index: 0 });
    // "Unconfirmed" is asked again after a minute.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect((await publishMinted(anns))[0]).toBe(200);
      expect(await served()).toEqual([anns.outpoint]);
      expect(await publishMinted(anns)).toEqual([409, { error: 'Already published' }]);
    } finally {
      Date.now = realNow;
    }
  });

  test('the list judges a page against older listings, earliest first (so a limit never cuts an original)', async () => {
    await publish(listing(ann, 0));
    urls.length = 0;
    await served();
    const q = urls.find((u) => decodeURIComponent(u).includes('name=in.('));
    expect(q).toContain('order=created_at.asc');
  });
});

describe('contract names the catalogue lookup must survive', () => {
  const named = (name) => listing(ann, 0, { contract: { ...listing(ann).contract, name } });
  test('a name with a lone surrogate is not a contract inscription (400, not a crash)', async () => {
    expect((await publish(named('x\ud800')))[0]).toBe(400);
    expect((await publish(named('ok \ud83d\ude00')))[0]).toBe(200);
  });
  test("an older row with such a name doesn't take the catalogue down", async () => {
    oldRow(named('\ud800'));
    const [, , good] = await publish(named('Fine'));
    expect(await served()).toEqual([good.outpoint]);
  });
});

describe('where an origin sits on chain (strategyKeys chain.position)', () => {
  const withFetch = async (answer, fn) => {
    const before = globalThis.fetch;
    globalThis.fetch = async (url) => answer(String(url));
    try {
      return await fn();
    } finally {
      globalThis.fetch = before;
    }
  };
  const minedTx = () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 5 });
    const txid = tx.id('hex');
    // Fourth of four in block 975470: its sibling at level 0, the left pair's hash at level 1.
    tx.merklePath = new MerklePath(975470, [
      [
        { offset: 2, hash: 'aa'.repeat(32) },
        { offset: 3, hash: txid, txid: true },
      ],
      [{ offset: 0, hash: 'bb'.repeat(32) }],
    ]);
    return { tx, txid };
  };

  test('from the 1Sat BEEF: block height and position in the block', async () => {
    const { tx, txid } = minedTx();
    const pos = await withFetch(
      (u) =>
        u.endsWith(`/beef/${txid}`) ? new Response(new Uint8Array(tx.toBEEF())) : new Response('', { status: 404 }),
      () => saved.chain.position(txid),
    );
    expect(pos).toEqual({ height: 975470, index: 3 });
  });

  test('else from JungleBus; unconfirmed is null; "couldn’t check" throws, never null', async () => {
    const txid = 'cd'.repeat(32);
    const at = (answer) => withFetch(answer, () => saved.chain.position(txid));
    const none = new Response('', { status: 404 });
    const jb =
      (body, beef = () => new Response('', { status: 404 })) =>
      (u) =>
        u.includes('junglebus') ? new Response(JSON.stringify(body)) : beef();
    expect(await at(jb({ id: txid, block_height: 975470, block_index: 1 }))).toEqual({ height: 975470, index: 1 });
    // Known and not mined: unconfirmed.
    expect(await at(jb({ id: txid, block_height: 0 }))).toBeNull();
    // A source that fails, with no block from the other: not "unconfirmed".
    await expect(at(jb({ id: txid, block_height: 0 }, () => new Response('', { status: 500 })))).rejects.toThrow();
    await expect(at((u) => (u.includes('junglebus') ? new Response('', { status: 502 }) : none))).rejects.toThrow();
    await expect(at(jb({ id: 'ef'.repeat(32), block_height: 9 }))).rejects.toThrow();
    // No source knows it.
    await expect(at(() => new Response('', { status: 404 }))).rejects.toThrow();
    await expect(
      at(() => {
        throw new Error('offline');
      }),
    ).rejects.toThrow();
    // A block from one source is enough, whatever the other does.
    expect(await at(jb({ id: txid, block_height: 7 }, () => new Response('', { status: 500 })))).toEqual({
      height: 7,
      index: null,
    });
  });
});
