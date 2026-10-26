import { describe, expect, test } from 'bun:test';
import { createCipheriv } from 'node:crypto';
import { PrivateKey, ProtoWallet, PublicKey, Script, Utils } from '@bsv/sdk';
import V from './vectors.json';
import * as r from './records';

(globalThis as Record<string, unknown>).__MINT_FEE_ADDRESS__ = '';
const pm = await import('./privateMint');

/** Spec §8 / §9.7: test root key 1, BRC-2 key from the wallet, the IV fixed only so the vector is reproducible. */
const wallet = new ProtoWallet(new PrivateKey(1));
const hex = Utils.toHex;
const bin = (h: string) => Utils.toArray(h, 'hex');
const symKey = (keyID: string) =>
  (wallet as unknown as { keyDeriver: { deriveSymmetricKey: (...a: unknown[]) => unknown } }).keyDeriver
    .deriveSymmetricKey(r.ARCHIVE_PROTOCOL, keyID, 'self')
    .toArray('be', 32) as number[];
const fixedIv =
  (iv: string): r.Encrypt =>
  async (pt, keyID) => {
    const c = createCipheriv('aes-256-gcm', Buffer.from(symKey(keyID)), Buffer.from(bin(iv)));
    const body = Buffer.concat([c.update(Buffer.from(pt)), c.final()]);
    return [...bin(iv), ...body, ...c.getAuthTag()];
  };
/** Pushes after OP_FALSE OP_RETURN of a script read from hex (the SDK keeps that tail as one blob). */
const tail = (h: string) => {
  const c = Script.fromHex(h).chunks;
  return (c[1].data?.length ? Script.fromBinary(c[1].data).chunks : c.slice(2)).map((x) => x.data ?? []);
};
const decrypt = async (ct: number[], keyID: string) =>
  (await wallet.decrypt({ ciphertext: ct, protocolID: r.ARCHIVE_PROTOCOL, keyID, counterparty: 'self' })).plaintext;

describe('X record test vectors (spec §8)', () => {
  for (const [name, v] of [
    ['vector 1', V.x1],
    ['vector 2', V.x2],
  ] as const) {
    test(name, async () => {
      const rec = JSON.parse(v.json);
      const pt = r.xPlaintext(rec);
      expect(pt.length).toBe(384);
      expect(Utils.toUTF8(pt).trimEnd()).toBe(v.json);
      expect(hex(symKey(v.kid))).toBe(v.key);
      const ct = await fixedIv(v.iv)(pt, v.kid);
      expect(ct.length).toBe(432);
      expect(hex(ct)).toBe(v.ct);
      expect(await decrypt(bin(v.ct), v.kid)).toEqual(pt);
      const script = r.xRecordScript(ct, v.kid);
      expect(script.toHex()).toBe(v.script);
      expect(script.toBinary().length).toBe(619);
      expect(r.parseXPlaintext(await decrypt(ct, v.kid))).toEqual({ v: 1, source: 'x', ...rec });
    });
  }
});

describe('media record test vector (spec §9.7)', () => {
  const v = V.media;
  const file = bin(v.png);
  test('header, plaintext, key, ciphertext, lock and script byte for byte', async () => {
    const h = r.mediaHeader('picture', 'image/png', 'dot.png', file);
    expect(JSON.stringify(h)).toBe(v.header);
    const pt = r.mediaHeadPlaintext(h, file);
    expect(pt.length).toBe(1024);
    expect(hex(pt)).toBe(v.plaintext);
    expect(hex(symKey(v.kid))).toBe(v.key);
    const ct = await fixedIv(v.iv)(pt, v.kid);
    expect(ct.length).toBe(1072);
    expect(hex(ct)).toBe(v.ct);
    const { publicKey } = await wallet.getPublicKey({
      protocolID: r.ARCHIVE_PROTOCOL,
      keyID: r.lockKeyID(v.kid),
      counterparty: 'self',
    });
    expect(publicKey).toBe(v.lockPub);
    const lock = PublicKey.fromString(publicKey).toHash() as number[];
    expect(r.mediaHeadScript(ct, lock, v.kid, 1).toHex()).toBe(v.script);
  });
  test('the vector reads back: decrypt, parse, reassemble, sha256', async () => {
    const parsed = r.parseMediaScript(Script.fromHex(v.script))!;
    expect(parsed.map).toEqual({ app: 'bmintx', type: 'media', v: '1', enc: 'brc2', kid: v.kid, n: '1' });
    const head = r.parseMediaHead(await decrypt(parsed.ciphertext, v.kid))!;
    expect(head.header.name).toBe('dot.png');
    expect(r.assembleMedia(head.header, head.body, [])).toEqual(file);
  });
  test('planPrivateMedia with the vector IV gives the vector script', async () => {
    const plan = await pm.planPrivateMedia(
      wallet as never,
      { file, mime: 'image/png', name: 'dot.png', kind: 'picture' },
      { encrypt: fixedIv(v.iv), kid: v.kid },
    );
    expect(plan.outputs.length).toBe(1);
    expect(plan.outputs[0].lockingScript).toBe(v.script);
    expect(plan.outputs[0].satoshis).toBe(1);
    expect(plan.outputs[0].basket).toBe(pm.PRIVATE_BASKET);
  });
});

describe('chunked media (§9.4)', () => {
  test('n chunks, keyID "<kid> <i>", same lock, seal last, round trip', async () => {
    const file = Array.from({ length: r.CHUNK_SIZE * 2 + 1000 }, (_, i) => (i * 7) & 255);
    const plan = await pm.planPrivateMedia(wallet as never, { file, mime: 'video/mp4', name: 'v.mp4', kind: 'video' });
    expect(plan.header.chunks).toBe(3);
    expect(plan.outputs.length).toBe(4); // head, chunk 1, chunk 2, seal
    const recs = plan.outputs.slice(0, 3).map((o) => r.parseMediaScript(Script.fromHex(o.lockingScript))!);
    expect(recs.map((x) => x.map.type)).toEqual(['media', 'media-chunk', 'media-chunk']);
    expect(recs[0].map.n).toBe('3');
    expect(recs[2].map.i).toBe('2');
    // The P2PKH lock is the same per-record key on every part.
    const lockOf = (h: string) => h.slice(h.indexOf('6876a914') + 8, h.indexOf('6876a914') + 48);
    expect(new Set(plan.outputs.slice(0, 3).map((o) => lockOf(o.lockingScript))).size).toBe(1);
    // A chunk opened with the wrong index fails GCM.
    await expect(decrypt(recs[1].ciphertext, r.chunkKeyID(plan.kid, 2))).rejects.toThrow();
    const head = r.parseMediaHead(await decrypt(recs[0].ciphertext, plan.kid))!;
    const chunks = [
      await decrypt(recs[1].ciphertext, r.chunkKeyID(plan.kid, 1)),
      await decrypt(recs[2].ciphertext, r.chunkKeyID(plan.kid, 2)),
    ];
    expect(r.assembleMedia(head.header, head.body, chunks)).toEqual(file);
    // Seal: MAP archive-seal n 3 kid <kid> | BRC3 <pubkey> <sig over sha256(ct_1‖ct_2‖ct_3)>.
    const seal = tail(plan.outputs[3].lockingScript).map((d) => Utils.toUTF8(d));
    expect(seal.slice(0, 12)).toEqual([
      r.MAP_PREFIX,
      'SET',
      'app',
      'bmintx',
      'type',
      'archive-seal',
      'v',
      '1',
      'n',
      '3',
      'kid',
      plan.kid,
    ]);
    expect(seal[13]).toBe('BRC3');
    const ok = await wallet.verifySignature({
      protocolID: r.ARCHIVE_PROTOCOL,
      keyID: r.sealKeyID(plan.kid),
      counterparty: 'self',
      forSelf: true,
      data: r.sealData(recs.map((x) => x.ciphertext)),
      signature: Utils.toArray(seal[15], 'hex'),
    });
    expect(ok.valid).toBe(true);
    expect(plan.outputs[3].satoshis).toBe(0);
  });
  test('a single record has no seal', async () => {
    const plan = await pm.planPrivateMedia(wallet as never, {
      file: [1, 2, 3],
      mime: 'image/png',
      name: 'a',
      kind: 'picture',
    });
    expect(plan.outputs.length).toBe(1);
  });
  test('no cleartext in any output', async () => {
    const marker = Utils.toArray('SECRET-PICTURE-BYTES', 'utf8');
    const file = [...marker, ...marker];
    const plan = await pm.planPrivateMedia(wallet as never, {
      file,
      mime: 'image/png',
      name: 'secret.png',
      kind: 'picture',
    });
    for (const o of plan.outputs) {
      expect(o.lockingScript).not.toContain(hex(marker));
      expect(o.lockingScript).not.toContain(hex(Utils.toArray('secret.png', 'utf8')));
      expect(o.lockingScript).not.toContain(hex(Utils.toArray('image/png', 'utf8')));
    }
  });
});

describe('reveal post shapes', () => {
  const pushes = (s: Script) => s.chunks.slice(2).map((c) => (c.data ? Utils.toUTF8(c.data) : `op:${c.op}`));
  const outpoint = `${'ab'.repeat(32)}:0`;
  test('X reveal (§6): B text/markdown, MAP key order, context url', () => {
    const rec = JSON.parse(V.x1.json);
    const s = r.xRevealScript({ ...rec, reply_url: 'https://x.com/a/status/9' }, outpoint);
    expect(pushes(s)).toEqual([
      r.B_PREFIX,
      'hello world',
      'text/markdown',
      'UTF-8',
      '|',
      r.MAP_PREFIX,
      'SET',
      'app',
      'bChat',
      'type',
      'post',
      'context',
      'url',
      'url',
      'https://x.com/a/status/9',
      'source',
      'x',
      'source_id',
      '1000000000000000001',
      'source_at',
      '2014-03-03T10:00:00.000Z',
      'source_url',
      'https://x.com/b0aseX/status/1000000000000000001',
      'reveal',
      outpoint,
    ]);
  });
  test('X reveal: a revealed parent wins over reply_url', () => {
    const rec = JSON.parse(V.x2.json);
    const p = pushes(r.xRevealScript({ ...rec, reply_url: 'https://x.com/z' }, outpoint, 'cd'.repeat(32)));
    expect(p.slice(11, 15)).toEqual(['context', 'tx', 'tx', 'cd'.repeat(32)]);
    expect(p).not.toContain('https://x.com/z');
  });
  test('reveal ids are checked', () => {
    expect(() => r.xRevealScript(JSON.parse(V.x1.json), 'abc:0')).toThrow();
    expect(() => r.mediaRevealInlineScript([1], 'image/png', 'a', `${'AB'.repeat(32)}:0`)).toThrow();
  });
  test('small media reveal (§9.6): B bytes mime binary name, MAP app bChat type post reveal', () => {
    const p = pushes(r.mediaRevealInlineScript([0x41, 0x42], 'image/png', 'dot.png', outpoint));
    expect(p).toEqual([
      r.B_PREFIX,
      'AB',
      'image/png',
      'binary',
      'dot.png',
      '|',
      r.MAP_PREFIX,
      'SET',
      'app',
      'bChat',
      'type',
      'post',
      'reveal',
      outpoint,
    ]);
  });
  test('large media reveal (§9.6): clear inscription MAP + referencing post', () => {
    expect(r.mediaRevealInscriptionMap(outpoint)).toEqual({ app: 'bmintx', type: 'media-reveal', reveal: outpoint });
    const ins = `${'ef'.repeat(32)}_0`;
    expect(pushes(r.mediaRevealRefScript(ins, 'video/mp4', outpoint))).toEqual([
      r.MAP_PREFIX,
      'SET',
      'app',
      'bChat',
      'type',
      'post',
      'media_0',
      `${ins}|video/mp4`,
      'reveal',
      outpoint,
    ]);
  });
  test('inline only for small images and videos', () => {
    expect(r.revealsInline('image/png', 250 * 1024)).toBe(true);
    expect(r.revealsInline('image/png', 250 * 1024 + 1)).toBe(false);
    expect(r.revealsInline('video/mp4', 1024 * 1024)).toBe(true);
    expect(r.revealsInline('audio/mpeg', 10)).toBe(false);
  });
});

describe('mintPrivate source x (§5)', () => {
  const rec = JSON.parse(V.x1.json);
  test('250 records per tx, seal last, labels, txids returned', async () => {
    const plans = pm.planXMint(Array.from({ length: 251 }, () => rec));
    expect(plans.map((p) => p.records.length)).toEqual([250, 1]);
    const calls: { outputs: { lockingScript: string; satoshis: number }[]; labels: string[]; options: unknown }[] = [];
    const ctx = {
      wallet: new Proxy(wallet, {
        get(t, prop) {
          if (prop === 'createAction')
            return async (args: (typeof calls)[number]) => {
              calls.push(args);
              return { txid: String(calls.length).padStart(64, '0') };
            };
          const v = Reflect.get(t, prop);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }),
    };
    const txids = await pm.mintPrivateX(ctx as never, plans);
    expect(txids.length).toBe(2);
    expect(calls[0].outputs.length).toBe(251); // 250 records + seal
    expect(calls[0].labels).toEqual(['bmintx archive', `bmintx batch ${plans[0].batchKid}`]);
    expect(calls[0].options).toMatchObject({ randomizeOutputs: false, acceptDelayedBroadcast: true });
    const sealPushes = tail(calls[1].outputs[1].lockingScript).map((d) => Utils.toUTF8(d));
    expect(sealPushes.slice(0, 12)).toEqual([
      r.MAP_PREFIX,
      'SET',
      'app',
      'bmintx',
      'type',
      'archive-seal',
      'v',
      '1',
      'n',
      '1',
      'kid',
      plans[1].batchKid,
    ]);
    // The seal verifies over sha256 of the ciphertexts.
    const ct = tail(calls[1].outputs[0].lockingScript)[1];
    const ok = await wallet.verifySignature({
      protocolID: r.ARCHIVE_PROTOCOL,
      keyID: r.sealKeyID(plans[1].batchKid),
      counterparty: 'self',
      forSelf: true,
      data: r.sealData([ct]),
      signature: Utils.toArray(sealPushes[15], 'hex'),
    });
    expect(ok.valid).toBe(true);
    // Records carry only ciphertext: the text is nowhere in clear.
    for (const o of calls[0].outputs) expect(o.lockingScript).not.toContain(hex(Utils.toArray('hello world', 'utf8')));
  });
  test('bad items are refused before anything is built', () => {
    expect(() => pm.planXMint([{ ...rec, text: 5 }])).toThrow('Item 1');
    expect(() => pm.planXMint([])).toThrow();
  });
  test('180,000-byte cap splits big batches', () => {
    const long = { ...rec, text: 'x'.repeat(4000) };
    const plans = pm.planXMint(Array.from({ length: 60 }, () => long));
    expect(plans.length).toBeGreaterThan(1);
    for (const p of plans)
      expect(p.records.reduce((s, x) => s + r.xRecordBytes(x.plaintext.length), 0)).toBeLessThanOrEqual(180_000);
  });
});

describe('wallet.mintPrivate request (§10)', () => {
  const base = JSON.parse(V.x1.json);
  const items = (n: number, tag = '') =>
    Array.from({ length: n }, (_, i) => ({ ...base, x_id: String(1000 + i), text: `post ${i}${tag}` }));
  const memStore = () => {
    const m = new Map<string, unknown>();
    return {
      get: (k: string) => (m.get(k) as never) ?? null,
      set: (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    };
  };
  const ctxWith = (failAt = Infinity) => {
    let n = 0;
    return {
      calls: () => n,
      ctx: {
        wallet: new Proxy(wallet, {
          get(t, prop) {
            if (prop === 'createAction')
              return async () => {
                if (++n >= failAt) throw new Error('broadcast failed');
                return { txid: String(n).padStart(64, 'a') };
              };
            const v = Reflect.get(t, prop);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        }),
      } as never,
    };
  };
  const env = (store: ReturnType<typeof memStore>, ok = true) => ({
    originator: 'bchatx.com',
    identityKey: '02abc',
    satsPerKb: 100,
    store,
    confirm: async () => ok,
  });
  test('one sheet, records per item, then the same request returns the stored result without minting', async () => {
    const store = memStore();
    const c = ctxWith();
    let sheets = 0;
    const e = {
      ...env(store),
      confirm: async (s: { posts: number; txs: number }) => (sheets++, s.posts === 300 && s.txs === 2),
    };
    const req = { source: 'x', requestId: 'req-00000001', items: items(300) };
    const r1 = await pm.handleMintPrivate(c.ctx, req, e);
    expect(sheets).toBe(1);
    expect(r1.complete).toBe(true);
    expect(r1.records.length).toBe(300);
    expect(r1.records[250]).toEqual({ x_id: '1250', outpoint: `${'2'.padStart(64, 'a')}:0` });
    expect(r1.txids.length).toBe(2);
    const r2 = await pm.handleMintPrivate(c.ctx, req, e);
    expect(r2).toEqual(r1);
    expect(c.calls()).toBe(2);
    expect(sheets).toBe(1);
  });
  test('same requestId with different items: REQUEST_ID_REUSED, nothing minted', async () => {
    const store = memStore();
    const c = ctxWith();
    await pm.handleMintPrivate(c.ctx, { source: 'x', requestId: 'req-00000002', items: items(2) }, env(store));
    const before = c.calls();
    await expect(
      pm.handleMintPrivate(c.ctx, { source: 'x', requestId: 'req-00000002', items: items(2, '!') }, env(store)),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
    expect(c.calls()).toBe(before);
    // Scoped per originator: another site may use the same id.
    const other = await pm.handleMintPrivate(
      c.ctx,
      { source: 'x', requestId: 'req-00000002', items: items(2, '!') },
      { ...env(store), originator: 'bmintx.com' },
    );
    expect(other.complete).toBe(true);
  });
  test('declined: USER_REFUSED, nothing minted', async () => {
    const c = ctxWith();
    await expect(
      pm.handleMintPrivate(c.ctx, { source: 'x', requestId: 'req-00000003', items: items(3) }, env(memStore(), false)),
    ).rejects.toMatchObject({ code: 'USER_REFUSED' });
    expect(c.calls()).toBe(0);
  });
  test('partial run: complete false + stoppedAt; resume mints only the rest', async () => {
    const store = memStore();
    const req = { source: 'x', requestId: 'req-00000004', items: items(300) };
    const r1 = await pm.handleMintPrivate(ctxWith(2).ctx, req, env(store));
    expect(r1).toMatchObject({ complete: false, stoppedAt: 250 });
    expect(r1.records.length).toBe(250);
    const c = ctxWith();
    const r2 = await pm.handleMintPrivate(c.ctx, req, env(store));
    expect(c.calls()).toBe(1);
    expect(r2.complete).toBe(true);
    expect(r2.records.length).toBe(300);
    expect(new Set(r2.records.map((r) => r.x_id)).size).toBe(300);
  });
  test('cap and shape checks', async () => {
    const c = ctxWith();
    await expect(
      pm.handleMintPrivate(
        c.ctx,
        { source: 'x', requestId: 'req-00000005', items: new Array(25_001).fill(base) },
        env(memStore()),
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_ITEMS' });
    await expect(
      pm.handleMintPrivate(c.ctx, { source: 'y', requestId: 'req-00000005', items: [base] }, env(memStore())),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(pm.handleMintPrivate(c.ctx, { source: 'x', items: [base] }, env(memStore()))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('private by default', () => {
  test('mint sheets default to private; public only by choice or for types §9 has no kind for', () => {
    expect(r.mintIsPrivate(false, null)).toBe(true);
    for (const m of ['image/png', 'audio/mpeg', 'video/mp4', 'model/gltf-binary'])
      expect(r.mintIsPrivate(false, m)).toBe(true);
    expect(r.mintIsPrivate(true, 'image/png')).toBe(false);
    expect(r.mintIsPrivate(false, 'application/pdf')).toBe(false);
    expect(r.mintIsPrivate(false, 'model/x', '3d')).toBe(true);
  });
  test('bAvatar mints privately by default: one 1-sat encrypted record, no clear SVG on chain', async () => {
    const { mintBavatar } = await import('../bavatar/mintBavatar');
    const calls: { outputs: { lockingScript: string; satoshis: number }[]; labels: string[] }[] = [];
    const ctx = {
      wallet: new Proxy(wallet, {
        get(t, prop) {
          if (prop === 'createAction')
            return async (a: (typeof calls)[number]) => (calls.push(a), { txid: 'c'.repeat(64) });
          const v = Reflect.get(t, prop);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }),
    };
    let recorded = '';
    const client = {
      recordBavatarMint: async (t: string) => void (recorded = t),
      sponsorBavatar: async () => undefined,
    };
    const txid = await mintBavatar(ctx as never, {
      identityKey: '02' + 'ab'.repeat(32),
      payAddress: '',
      mine: { handle: 'alice', number: 7, founding: true, edition: 1000, minted: null, sponsored: false },
      client: client as never,
    });
    expect(txid).toBe('c'.repeat(64));
    expect(recorded).toBe(txid);
    expect(calls.length).toBe(1);
    expect(calls[0].labels).toEqual(['bmintx media']);
    expect(calls[0].outputs[0].satoshis).toBe(1);
    const rec = r.parseMediaScript(Script.fromHex(calls[0].outputs[0].lockingScript))!;
    const head = r.parseMediaHead(await decrypt(rec.ciphertext, rec.map.kid))!;
    expect(head.header.kind).toBe('bavatar');
    expect(head.header.mime).toBe('image/svg+xml');
    expect(calls[0].outputs[0].lockingScript).not.toContain(hex(Utils.toArray('<svg', 'utf8')));
  });
});
