import { describe, expect, test } from 'bun:test';
import { categoryOf } from './classify';
import {
  BUNDLED,
  compileKeywords,
  mergeBlocklists,
  metadataFlagsAdult,
  normalizeBlocklist,
  normalizeForMatch,
  remoteBlocklist,
  SafetyFilter,
} from './safety';

const f = new SafetyFilter(BUNDLED);
const blocked = (text: string) => f.check({ texts: [text] }).blocked;

describe('categoryOf', () => {
  test('audio/video/image', () => {
    expect(categoryOf('audio/mpeg')).toBe('music');
    expect(categoryOf('audio/wav')).toBe('music');
    expect(categoryOf('video/mp4')).toBe('video');
    expect(categoryOf('image/png')).toBe('images');
    expect(categoryOf('image/svg+xml')).toBe('images');
    expect(categoryOf('image/gif')).toBe('images');
    expect(categoryOf('IMAGE/WEBP; charset=binary')).toBe('images');
  });
  test('documents', () => {
    for (const t of ['application/pdf', 'text/plain', 'text/markdown', 'text/html', 'application/msword'])
      expect(categoryOf(t)).toBe('documents');
    expect(categoryOf('application/octet-stream', { app: 'bitcoin-writer' })).toBe('documents');
    expect(categoryOf('application/octet-stream', { app: 'other' })).toBeNull();
  });
  test('everything else is unclassifiable (hidden)', () => {
    for (const t of ['application/json', 'application/bsv-20', '', null, undefined, 'image/'])
      expect(categoryOf(t)).toBeNull();
  });
});

describe('keyword matching', () => {
  test('explicit terms are blocked, case-insensitive', () => {
    for (const t of [
      'NSFW drop',
      'xxx',
      'Porn',
      'nude art',
      'Nudes #3',
      'OnlyFans leak',
      'hentai girl',
      'sex',
      'Erotic',
      'Adult collection',
      '18+ only',
      'Sexy Punk',
    ])
      expect(blocked(t)).toBe(true);
  });
  test('unambiguous terms match inside words', () => {
    expect(blocked('myNSFWdrop')).toBe(true);
    expect(blocked('pornstar')).toBe(true);
  });
  // Decisions: whole-word matching avoids place names and ordinary words.
  test('word-boundary false positives are NOT blocked', () => {
    for (const t of [
      'Essex',
      'Sussex Punks',
      'Middlesex',
      'Wessex',
      'adultery (a novel)',
      'Adulting 101',
      'pussycat',
      'cockpit',
      'Dickens',
      'Sextant',
      'Analysis',
    ])
      expect(blocked(t)).toBe(false);
  });
  test('18+ needs its own boundary', () => {
    expect(blocked('Age 18+')).toBe(true);
    expect(blocked('118+2')).toBe(false);
  });
  test('compileKeywords with nothing matches nothing', () => expect(compileKeywords([])).toBeNull());
});

describe('metadata flags', () => {
  test('nsfw / adult / rating', () => {
    expect(metadataFlagsAdult({ nsfw: 'true' })).toBe(true);
    expect(metadataFlagsAdult({ adult: true })).toBe(true);
    expect(metadataFlagsAdult({ rating: 'Explicit' })).toBe(true);
    expect(metadataFlagsAdult({ subTypeData: { contentRating: '18+' } })).toBe(true);
    expect(metadataFlagsAdult({ nsfw: 'false', rating: 'G' })).toBe(false);
    expect(metadataFlagsAdult(null)).toBe(false);
  });
  test('keywords in metadata descriptions are checked', () => {
    expect(f.check({ texts: ['Cool Cats'], map: { subTypeData: { description: 'uncensored hentai' } } }).blocked).toBe(
      true,
    );
  });
});

describe('blocklist ids, hidden list, allowlist', () => {
  const op = 'a'.repeat(64) + '_0';
  const list = mergeBlocklists(
    BUNDLED,
    normalizeBlocklist({
      collections: ['B'.repeat(64) + '.1'],
      outpoints: [op],
      allowCollections: ['c'.repeat(64) + '_0'],
    }),
  );
  const g = new SafetyFilter(list, new Set(['d'.repeat(64) + '_2']));
  test('collection id (dot form normalised)', () =>
    expect(g.check({ collectionId: 'b'.repeat(64) + '_1' }).reason).toBe('id'));
  test('outpoint', () => expect(g.check({ ids: [op] }).blocked).toBe(true));
  test('locally hidden (reported)', () => expect(g.check({ ids: ['d'.repeat(64) + '.2'] }).reason).toBe('hidden'));
  test('clean item passes', () =>
    expect(g.check({ ids: ['e'.repeat(64) + '_0'], texts: ['Bitcoin Punks'] }).blocked).toBe(false));
  test('allowlist only affects blur', () => {
    expect(g.isAllowlisted('c'.repeat(64) + '.0')).toBe(true);
    expect(g.isAllowlisted(null)).toBe(false);
  });
  test('normalize ignores junk', () => {
    const n = normalizeBlocklist({ keywords: ['X', 3, ''], collections: 'nope' });
    expect(n.keywords).toEqual(['x']);
    expect(n.collections).toEqual([]);
  });
});

describe('remote blocklist', () => {
  test('no URL = empty, no fetch', async () => {
    expect((await remoteBlocklist('')).keywords).toEqual([]);
  });
  test('fetched once, cached for an hour', async () => {
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ collections: ['f'.repeat(64) + '_0'] }));
    }) as unknown as typeof fetch;
    try {
      const t = 1_000_000;
      const a = await remoteBlocklist('https://example.test/bl.json', t);
      await remoteBlocklist('https://example.test/bl.json', t + 30 * 60_000);
      expect(a.collections).toEqual(['f'.repeat(64) + '_0']);
      expect(calls).toBe(1);
      await remoteBlocklist('https://example.test/bl.json', t + 61 * 60_000);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('unicode obfuscation', () => {
  test('zero-width, joiner, BOM and soft hyphen inside a word are blocked', () => {
    for (const t of [
      'po\u200brn',
      'por\u200bn',
      'po\u2060rn',
      'po\ufeffrn',
      'p\u200co\u200drn',
      'ns\u00adfw',
      'nude\ufe0f art',
    ])
      expect(blocked(t)).toBe(true);
  });
  test('fullwidth forms are blocked', () => {
    for (const t of ['\uff30\uff2f\uff32\uff2e', '\uff2e\uff33\uff26\uff37', '\uff53\uff45\uff58'])
      expect(blocked(t)).toBe(true);
  });
  test('Cyrillic/Greek lookalike mixes are blocked', () => {
    for (const t of ['\u0440\u03bfrn', 'p\u043ern', '\u0445\u0445\u0445', 'n\u0455fw', 's\u0435x'])
      expect(blocked(t)).toBe(true);
  });
  test('combining marks are ignored', () => {
    expect(blocked('po\u0301rn')).toBe(true);
  });
  test('normalizeForMatch folds without touching the original', () => {
    const original = '\uff30o\u200brn';
    expect(normalizeForMatch(original)).toBe('porn');
    expect(original).toBe('\uff30o\u200brn');
  });
  test('ordinary text is not blocked', () => {
    for (const t of [
      'Essex sunset',
      'Café au lait',
      'Привет, как дела?',
      'Москва — столица России',
      'Καλημέρα κόσμε',
      'Ελληνική τέχνη',
      '日本の風景',
      'emoji 👍🏽 family 👨‍👩‍👧',
      'cockpit view',
    ])
      expect(blocked(t)).toBe(false);
  });
});

describe('nested metadata (b-Aware report)', () => {
  const f = new SafetyFilter({ ...BUNDLED, keywords: ['blockedword'], substrings: [] });
  test('a flag nested deep is caught', () => {
    expect(metadataFlagsAdult({ a: { b: { c: { d: { e: { nsfw: true } } } } } })).toBe(true);
    expect(metadataFlagsAdult({ a: [{ b: [{ rating: 'explicit' }] }] })).toBe(true);
  });
  test('a flag inside a JSON string is caught', () => {
    expect(metadataFlagsAdult({ traits: JSON.stringify({ meta: { adult: 'yes' } }) })).toBe(true);
  });
  test('a keyword nested deep or in JSON-in-string is caught', () => {
    expect(f.check({ map: { a: { b: { c: { d: { e: { f: 'blockedword' } } } } } } }).blocked).toBe(true);
    expect(f.check({ map: { x: JSON.stringify({ y: ['blockedword'] }) } }).blocked).toBe(true);
  });
  test('ordinary metadata passes and a huge object is bounded', () => {
    expect(metadataFlagsAdult({ rating: 'everyone', nsfw: false })).toBe(false);
    const wide: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = 'ok';
    expect(f.check({ map: wide }).blocked).toBe(false);
  });
});
