import { beforeEach, describe, expect, it } from 'bun:test';

// Minimal localStorage for bun.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
import { ownedAcrossWallet, recalledOwned, rememberOwned } from './ownedAcross';
import { yourThemes } from '../theme/yourThemes';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const B0ASEY = '02cbe7d893a7515c726c9f069cdd56d379662c7634a4ba8eaf2279fcea76686ed8';
const OTHER = '026607f69e27c84eb19bfbc430575c46abec2a587712eac91b3b3f58e7f262b59b';

describe('bought themes follow the wallet', () => {
  beforeEach(() => localStorage.clear());

  it('remembers and recalls per identity key', () => {
    rememberOwned(B0ASEY, ['npgx', 'npgx', 'vexvoid']);
    expect(recalledOwned(B0ASEY.toUpperCase())).toEqual(['npgx', 'vexvoid']);
    expect(recalledOwned(OTHER)).toEqual([]);
  });

  it('adds packs bought on other accounts, tagged with that account', () => {
    rememberOwned(OTHER, ['npg', 'npgx']);
    const m = ownedAcrossWallet(
      B0ASEY,
      ['npgx'],
      [
        { identityKey: B0ASEY, name: 'b0asey' },
        { identityKey: OTHER, name: 'b0ase' },
      ],
    );
    expect(m.get('npgx')).toBeNull();
    expect(m.get('npg')).toBe('b0ase');
    expect(m.has('vexvoid')).toBe(false);
  });

  it('lists owned editions with their card art pattern', () => {
    const list = yourThemes(new Map([['npgx', null]]));
    expect(list.map((x) => x.a.id)).toEqual(['npgx']);
    expect(list[0].a.pattern).toBe('npgx');
  });
});
