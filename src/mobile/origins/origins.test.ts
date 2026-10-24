import { describe, expect, test } from 'bun:test';
import { HD, Mnemonic } from '@bsv/sdk';
import type { ScannedAssets } from '../../sweep/scanner';
import { fixedKeys } from '../sweep/hd';
import {
  HD_QUICK,
  ORIGINS,
  canRecheck,
  holdingsLine,
  originAddresses,
  scanOrigins,
  shouldAutoScan,
  FRESH_MS,
} from './origins';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const none = (): ScannedAssets => ({
  funding: [],
  ordinals: [],
  opnsNames: [],
  bsv21Tokens: [],
  bsv20Tokens: [],
  locked: [],
  runJigs: [],
  totalBsv: 0,
});

describe('origin addresses', () => {
  test('single keys match the sweep’s fixed keys (same paths, no drift)', () => {
    const fixed = new Set(fixedKeys(WORDS, '').map((k) => k.address));
    const addrs = originAddresses(WORDS);
    for (const id of ['yours', 'relayx', 'twetch'] as const)
      for (const a of addrs.get(id)!) expect(fixed.has(a.address)).toBe(true);
  });

  test('HD origins check the first receive addresses of their account', () => {
    const addrs = originAddresses(WORDS);
    const mb = addrs.get('moneybutton')!;
    expect(mb.length).toBe(HD_QUICK);
    const acct = HD.fromSeed(Mnemonic.fromString(WORDS).toSeed('')).derive("m/44'/0'/0'");
    expect(mb[0].address).toBe(acct.deriveChild(0).deriveChild(0).privKey.toAddress());
    expect(mb[0].path).toBe("m/44'/0'/0'/0/0");
  });

  test('no HandCash or Electrum origin', () => {
    expect(ORIGINS.map((o) => o.name)).toEqual(['Yours', 'RelayX', 'Twetch', 'Money Button', 'SimplyCash']);
  });
});

describe('scanOrigins', () => {
  test('finds holdings per origin, empty otherwise, and scans a shared address once', async () => {
    const addrs = originAddresses(WORDS);
    const yoursOrd = addrs.get('yours')!.find((a) => a.label === 'ordinals')!.address;
    const relayxNft = addrs.get('relayx')!.find((a) => a.label === 'NFTs')!.address;
    const calls: string[] = [];
    const scan = async (address: string) => {
      calls.push(address);
      const a = none();
      if (address === yoursOrd) {
        a.ordinals = [{} as never, {} as never];
        a.totalBsv = 2;
      }
      if (address === relayxNft) a.runJigs = [{} as never];
      return a;
    };
    const r = await scanOrigins(WORDS, scan, 123);
    expect(r.at).toBe(123);
    const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
    expect(by.yours.status).toBe('found');
    expect(by.yours.holdings.ordinals).toBe(2);
    expect(by.relayx.status).toBe('found');
    expect(by.relayx.holdings.runJigs).toBe(1);
    expect(by.twetch.status).toBe('empty');
    expect(by.moneybutton.status).toBe('empty');
    expect(new Set(calls).size).toBe(calls.length);
  });

  test('a failed lookup with nothing found reads as an error, not as empty', async () => {
    const r = await scanOrigins(WORDS, async () => {
      throw new Error('down');
    });
    expect(r.results.every((x) => x.status === 'error')).toBe(true);
  });
});

describe('rate limits and wording', () => {
  test('cached scans are reused; recheck waits a minute', () => {
    const at = 1_000_000;
    expect(shouldAutoScan(null, at)).toBe(true);
    expect(shouldAutoScan({ at, results: [] }, at + 1000)).toBe(false);
    expect(shouldAutoScan({ at, results: [] }, at + FRESH_MS + 1)).toBe(true);
    expect(canRecheck({ at, results: [] }, at + 30_000)).toBe(false);
    expect(canRecheck({ at, results: [] }, at + 60_000)).toBe(true);
  });

  test('holdings line', () => {
    expect(holdingsLine({ sats: 5, ordinals: 1, runJigs: 3, tokens: 2, names: 0 })).toBe(
      '1 NFT · 3 Run NFTs · 2 tokens',
    );
  });
});

describe('card themes', () => {
  test('every origin has an accent; partners can register their own; bad colours refused', async () => {
    const { originTheme, registerOriginTheme } = await import('./origins');
    for (const o of ORIGINS) expect(originTheme(o.id)?.accent).toMatch(/^#[0-9A-F]{6}$/i);
    registerOriginTheme('partner', { accent: '#123456' });
    expect(originTheme('partner')?.accent).toBe('#123456');
    registerOriginTheme('bad', { accent: 'red;x' });
    expect(originTheme('bad')).toBeUndefined();
  });
});

describe('drawer tints', () => {
  test('origin → tint, readable badge, fresh accounts untinted', async () => {
    const { originTint, originFromImport } = await import('./origins');
    const { contrast } = await import('../theme/colour');
    expect(originTint('yours')?.accent).toBe('#2FBF71');
    expect(originTint('twetch')?.accent).toBe('#9B6CFF');
    expect(originTint('relayx')?.accent).toBe('#3B8BEB');
    for (const id of ['yours', 'twetch', 'relayx', 'moneybutton', 'electrum']) {
      const t = originTint(id)!;
      expect(contrast(t.text, t.pill)).toBeGreaterThanOrEqual(4.5);
    }
    expect(originTint(undefined)).toBeUndefined();
    expect(originFromImport('panda')).toBe('yours');
    expect(originFromImport('master')).toBeUndefined();
  });
});
