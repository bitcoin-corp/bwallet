import { describe, expect, it } from 'bun:test';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

const { removeAccountPhoto } = await import('./socialAvatar');
const { getLocalAvatar, setLocalAvatar } = await import('./avatar');

const A = '1AccountAaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '1AccountBbbbbbbbbbbbbbbbbbbbbbbbbb';
const acct = (id: string, photo: string) => ({
  addresses: { identityAddress: id },
  icon: photo,
  settings: { socialProfile: { displayName: id, avatar: photo } },
});

describe('Remove photo', () => {
  it("clears only this account's photo (local, icon, social), never another account's", async () => {
    const accounts: Record<string, ReturnType<typeof acct>> = {
      [A]: acct(A, 'https://pbs.twimg.com/a.jpg'),
      [B]: acct(B, 'https://pbs.twimg.com/b.jpg'),
    };
    const storage = {
      getAllAccounts: () => Object.values(accounts),
      updateNested: async (_k: string, u: Record<string, ReturnType<typeof acct>>) => void Object.assign(accounts, u),
    } as unknown as ChromeStorageService;
    setLocalAvatar(A, 'data:image/jpeg;base64,AAAA');
    setLocalAvatar(B, 'data:image/jpeg;base64,BBBB');

    await removeAccountPhoto(storage, A);

    expect(getLocalAvatar(A)).toBe('');
    expect(accounts[A].settings.socialProfile.avatar).toBe('');
    expect(accounts[A].icon).toContain('yours-org-light');
    expect(getLocalAvatar(B)).toBe('data:image/jpeg;base64,BBBB');
    expect(accounts[B].settings.socialProfile.avatar).toBe('https://pbs.twimg.com/b.jpg');
  });
});
