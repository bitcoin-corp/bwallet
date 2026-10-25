import { describe, expect, test } from 'bun:test';
import { clearMemepoolCache, fetchMemepoolCoins, memepoolTradeUrl, parseCoin, parsePage } from './memepool';

const ID = 'c47a85208a081baade7b48fd856f9dd51e664f35186cd1502e9f2cb0052848da_1';
const row = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `${i.toString(16).padStart(64, '0')}_1`,
  sym: `C${i}`,
  name: `Coin ${i}`,
  icon: `/memepool/api/icon/${i.toString(16).padStart(64, '0')}_1`,
  priceSats: 1.5,
  mcapSats: 1_500_000_000,
  vol24hSats: 1000,
  change: { h24: -2.5 },
  holders: 7,
  progress: 0.6,
  graduated: false,
  createdAt: 1,
  ...extra,
});
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response;

describe('Memepool listing', () => {
  test('parses a coin and builds the icon url on their origin', () => {
    const c = parseCoin(row(1));
    expect(c?.sym).toBe('C1');
    expect(c?.iconUrl).toBe(`https://txblaster.xyz${row(1).icon}`);
    expect(c?.change24h).toBe(-2.5);
  });

  test('drops malformed rows and unsafe icons', () => {
    expect(parseCoin({ ...row(1), id: 'nope' })).toBeNull();
    expect(parseCoin({ ...row(1), sym: '' })).toBeNull();
    expect(parseCoin(row(1, { icon: 'https://evil.example/x.png' }))?.iconUrl).toBeNull();
    expect(parseCoin(row(1, { priceSats: -3, holders: 'x' }))?.priceSats).toBe(0);
    expect(parsePage({ total: 2, tokens: [row(1), null, 5] }).coins.length).toBe(1);
    expect(parsePage('garbage').coins).toEqual([]);
  });

  test('trade link only from a checked id', () => {
    expect(memepoolTradeUrl(ID)).toBe(`https://txblaster.xyz/memepool/token.html?id=${ID}`);
    expect(memepoolTradeUrl('javascript:alert(1)')).toBe('https://txblaster.xyz/memepool/');
  });

  test('pages until the total, then caches', async () => {
    clearMemepoolCache();
    const urls: string[] = [];
    const f = async (u: string) => {
      urls.push(u);
      const off = Number(new URL(u).searchParams.get('offset'));
      const n = off === 0 ? 96 : 4;
      return json({ total: 100, tokens: Array.from({ length: n }, (_, i) => row(off + i + 1)) });
    };
    const a = await fetchMemepoolCoins('trending', f, 1000);
    expect(a.length).toBe(100);
    expect(urls.length).toBe(2);
    await fetchMemepoolCoins('trending', f, 2000);
    expect(urls.length).toBe(2);
  });

  test('down: keeps the last good list, else throws', async () => {
    clearMemepoolCache();
    const down = async () => json({}, false);
    await expect(fetchMemepoolCoins('new', down, 0)).rejects.toThrow();
    await fetchMemepoolCoins('new', async () => json({ total: 1, tokens: [row(1)] }), 0);
    expect((await fetchMemepoolCoins('new', down, 10 * 60_000)).length).toBe(1);
  });
});
