import { describe, expect, it, test } from 'bun:test';
import {
  baseName,
  coverOf,
  groupVault,
  NPG_ID,
  OTHER_ID,
  PRIVATE_ID,
  runCollection,
  type VaultPiece,
} from './vaultGroups';

const p = (key: string, name: string, collection = '', extra: Partial<VaultPiece> = {}): VaultPiece => ({
  key,
  name,
  collection,
  kind: 'images',
  origin: key,
  ...extra,
});

describe('vault sub-vaults', () => {
  it('strips edition numbers', () => {
    expect(baseName('Pixel Fox #12')).toBe('Pixel Fox');
    expect(baseName('Gun 7')).toBe('Gun');
    expect(baseName('#1')).toBe('#1');
  });

  it('groups by collection, names from the pieces, biggest first, Other last', () => {
    const pieces = [
      p('a', 'Pixel Fox #1', 'c1_0'),
      p('b', 'Pixel Fox #2', 'c1_0'),
      p('c', 'Gun #1', 'c2_0'),
      ...['d', 'e', 'f', 'g'].map((k) => p(k, `Loose ${k}`)),
    ];
    const { vaults, loose } = groupVault(pieces);
    expect(vaults.map((v) => [v.title, v.items.length])).toEqual([
      ['Pixel Fox', 2],
      ['Gun', 1],
      ['Other', 4],
    ]);
    expect(vaults[2].id).toBe(OTHER_ID);
    expect(loose).toEqual([]);
  });

  it('shows a small Other as loose pieces', () => {
    const { vaults, loose } = groupVault([p('a', 'X', 'c'), p('b', 'Y')]);
    expect(vaults.map((v) => v.id)).toEqual(['c']);
    expect(loose.map((l) => l.key)).toEqual(['b']);
  });

  it('puts a held parent inscription in its collection and takes its name', () => {
    const { vaults } = groupVault([p('par_0', 'Foxes'), p('a', 'Fox #1', 'par_0'), p('b', 'Fox #2', 'par_0')]);
    expect(vaults).toHaveLength(1);
    expect(vaults[0].title).toBe('Foxes');
    expect(vaults[0].items).toHaveLength(3);
  });

  it('folds every NPG series into one Run sub-vault', () => {
    expect(runCollection({ title: 'NPG #0417', collection: 'NPG Series 2', n: 417 })).toBe(NPG_ID);
    expect(runCollection({ title: 'KAZUYO', collection: 'Ninja Punk Girls' })).toBe(NPG_ID);
    expect(runCollection({ title: 'Thing', collection: 'Coolbits' })).toBe('run:Coolbits');
    const { vaults } = groupVault([p('r1', 'NPG #1', NPG_ID, { kind: 'run', origin: undefined })]);
    expect(vaults[0].title).toBe('Ninja Punk Girls');
  });

  it('covers with the first piece that has a picture', () => {
    const v = { id: 'c', title: 'c', items: [p('a', 'A'), p('b', 'B', 'c', { thumb: 'u' })] };
    expect(coverOf(v)?.key).toBe('b');
  });
});

describe('private pieces', () => {
  test('go in their own Private sub-vault, first, never mixed into collections or loose', () => {
    const { vaults, loose } = groupVault([
      { key: 'a', name: 'A', collection: 'c1', kind: 'images' },
      { key: 'b', name: 'B', collection: 'c1', kind: 'images' },
      { key: 'p1', name: 'P1', collection: '', kind: 'images', private: true },
      { key: 'p2', name: 'P2', collection: 'c1', kind: 'video', private: true },
    ]);
    expect(vaults[0].id).toBe(PRIVATE_ID);
    expect(vaults[0].items.map((i) => i.key)).toEqual(['p1', 'p2']);
    expect(vaults.find((v) => v.id === 'c1')!.items.map((i) => i.key)).toEqual(['a', 'b']);
    expect(loose).toEqual([]);
  });
});
