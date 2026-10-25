import { beforeEach, describe, expect, test } from 'bun:test';
import { markAgentAccount } from '../agents/agentAccounts';
import { AgentCallError, checkGrant, handleAgentCall, makeGrant, type AgentDeps } from './agentPairing';
import {
  checkMintBudget,
  describeMintLimits,
  makeMintLimits,
  MintLimitError,
  recordMint,
  sha256Hex,
  UPLOAD_CHUNK_BYTES,
  UploadStore,
} from './mintScope';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
const NOW = Date.UTC(2026, 9, 6);
const codeOf = async (f: () => unknown) => {
  try {
    await f();
    return 'OK';
  } catch (e) {
    return (e as AgentCallError | MintLimitError).code ?? String(e);
  }
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('mint limits', () => {
  test('clamped and described for the approval screen', () => {
    expect(describeMintLimits(makeMintLimits(50, 3))).toBe(
      'This computer may mint up to 50 items, spending at most $3.00.',
    );
    const l = makeMintLimits(10_000, 1e6);
    expect([l.maxItems, l.maxUsd]).toEqual([500, 100]);
    expect(makeMintLimits(0, 0).maxItems).toBe(1);
  });

  test('budget and count are checked before signing; spend is recorded after', async () => {
    let l = makeMintLimits(2, 0.1);
    expect(await codeOf(() => checkMintBudget(l, 0.05))).toBe('OK');
    expect(await codeOf(() => checkMintBudget(l, 0.2))).toBe('BUDGET');
    expect(await codeOf(() => checkMintBudget(l, null))).toBe('NO_PRICE');
    expect(await codeOf(() => checkMintBudget(undefined, 0.01))).toBe('SCOPE');
    l = recordMint(l, { at: 1, name: 'a', txid: 't1', outpoint: 't1_0', usd: 0.06 });
    expect(await codeOf(() => checkMintBudget(l, 0.05))).toBe('BUDGET');
    expect(await codeOf(() => checkMintBudget(l, 0.04))).toBe('OK');
    l = recordMint(l, { at: 2, name: 'b', txid: 't2', outpoint: 't2_0', usd: 0.01 });
    expect(await codeOf(() => checkMintBudget(l, 0))).toBe('LIMIT');
    expect(l.recent.map((r) => r.name)).toEqual(['b', 'a']);
  });
});

describe('chunked upload', () => {
  test('reassembles chunks and checks size + sha256', async () => {
    const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES * 2 + 1000).map((_, i) => i % 251);
    const sha = await sha256Hex(b64(bytes));
    const s = new UploadStore(() => NOW);
    const total = 3;
    for (let i = total - 1; i >= 0; i--)
      s.put({
        uploadId: 'up-123456',
        index: i,
        total,
        bytes: bytes.length,
        sha256: sha,
        data: b64(bytes.subarray(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES)),
      });
    expect(await s.take('up-123456')).toBe(b64(bytes));
    expect(await codeOf(() => s.take('up-123456'))).toBe('NO_UPLOAD');
  });

  test('refuses over 10 MB, bad numbering, a wrong hash and incomplete uploads', async () => {
    const s = new UploadStore(() => NOW);
    const sha = 'a'.repeat(64);
    expect(
      await codeOf(() =>
        s.put({ uploadId: 'up-123456', index: 0, total: 7, bytes: 11 * 1024 * 1024, sha256: sha, data: '' }),
      ),
    ).toBe('TOO_BIG');
    expect(
      await codeOf(() => s.put({ uploadId: 'up-123456', index: 0, total: 5, bytes: 3, sha256: sha, data: 'AAAA' })),
    ).toBe('INVALID');
    s.put({ uploadId: 'up-123456', index: 0, total: 1, bytes: 3, sha256: sha, data: 'AAAA' });
    expect(await codeOf(() => s.take('up-123456'))).toBe('INVALID');
    s.put({
      uploadId: 'up-abcdefg',
      index: 0,
      total: 2,
      bytes: UPLOAD_CHUNK_BYTES + 3,
      sha256: sha,
      data: b64(new Uint8Array(UPLOAD_CHUNK_BYTES)),
    });
    expect(await codeOf(() => s.take('up-abcdefg'))).toBe('INCOMPLETE');
  });
});

describe('paired mint calls', () => {
  beforeEach(() => mem.clear());

  test('mint-only pairings work on a non-agent account; trading does not', async () => {
    const g = makeGrant('1Main', 'b0asex', ['mint'], 7, NOW, makeMintLimits(50, 3));
    expect(g.scopes).toEqual(['read', 'mint']);
    expect(await codeOf(() => checkGrant(g, 'mint', '1Main', NOW))).toBe('OK');
    expect(await codeOf(() => checkGrant(g, 'buy', '1Main', NOW))).toBe('SCOPE');
    const noLimits = makeGrant('1Main', 'b0asex', ['mint'], 7, NOW);
    expect(noLimits.scopes).toEqual(['read']); // mint needs limits
    markAgentAccount('1A', [], NOW);
    expect(await codeOf(() => checkGrant(makeGrant('1A', 'agent', ['trade'], 7, NOW), 'mint', '1A', NOW))).toBe(
      'SCOPE',
    );
  });

  const deps = (over: Partial<AgentDeps> = {}) => {
    const calls: string[] = [];
    const saved: unknown[] = [];
    const d: AgentDeps = {
      ctx: {} as AgentDeps['ctx'],
      currentId: '1Main',
      bsvUsd: async () => 20,
      feeRate: () => 100,
      saveGrant: (g) => saved.push(g),
      mintMedia: async (_ctx, m) => {
        calls.push(m.title);
        return {
          txid: 'f'.repeat(64),
          outpoint: `${'f'.repeat(64)}_0`,
          origin: `${'f'.repeat(64)}_0`,
          networkSats: 2000,
          ...(m.collection.kind === 'new' && { collectionId: `${'e'.repeat(64)}_0` }),
        };
      },
      ...over,
    };
    return { d, calls, saved };
  };
  const mp3 = { base64Content: b64(new Uint8Array(3000)), contentType: 'audio/mpeg', name: 'Echoes in the Abyss' };

  test('mints within the budget and records the actual spend', async () => {
    const g = makeGrant('1Main', 'b0asex', ['mint'], 7, Date.now(), makeMintLimits(2, 3));
    const { d, calls, saved } = deps();
    const r = (await handleAgentCall(
      g,
      'mint',
      { ...mp3, collection: { kind: 'new', name: 'VexVoid Discography' } },
      d,
    )) as Record<string, unknown>;
    expect(calls).toEqual(['Echoes in the Abyss']);
    expect(r.collectionId).toBe(`${'e'.repeat(64)}_0`);
    expect(r.outpoint).toBe(`${'f'.repeat(64)}_0`);
    expect(g.mint!.items).toBe(1);
    expect(g.mint!.spentUsd).toBeGreaterThan(0);
    expect(saved.length).toBe(1);
  });

  test('refuses over count, over budget, bad types and expired pairings before signing', async () => {
    const { d, calls } = deps();
    const g = makeGrant('1Main', 'b0asex', ['mint'], 7, Date.now(), makeMintLimits(1, 3));
    await handleAgentCall(g, 'mint', mp3, d);
    expect(await codeOf(() => handleAgentCall(g, 'mint', mp3, d))).toBe('LIMIT');
    const tiny = makeGrant('1Main', 'b0asex', ['mint'], 7, Date.now(), makeMintLimits(5, 0.01));
    const big = { ...mp3, base64Content: b64(new Uint8Array(1_500_000)) }; // ~$0.03 at 100 sat/kB, $20
    expect(await codeOf(() => handleAgentCall(tiny, 'mint', big, d))).toBe('BUDGET');
    const g2 = makeGrant('1Main', 'b0asex', ['mint'], 7, Date.now(), makeMintLimits(5, 3));
    expect(
      await codeOf(() => handleAgentCall(g2, 'mint', { ...mp3, contentType: 'application/x-msdownload' }, d)),
    ).toBe('TYPE');
    expect(await codeOf(() => handleAgentCall(g2, 'mint', mp3, { ...d, bsvUsd: async () => 0 }))).toBe('NO_PRICE');
    const old = makeGrant('1Main', 'b0asex', ['mint'], 1, Date.now() - 2 * 86_400_000, makeMintLimits(5, 3));
    expect(await codeOf(() => handleAgentCall(old, 'mint', mp3, d))).toBe('EXPIRED');
    expect(calls.length).toBe(1);
  });
});
