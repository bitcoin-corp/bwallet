import { beforeEach, describe, expect, it } from 'bun:test';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

// A Map-backed localStorage (bun has none), installed before the modules load.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const { bavatarDataUri, pickAvatar } = await import('./avatar');
const { adoptLinkedProfile, isBavatarItem, linkedSocial, nftPictureUrl, pictureState, setPicture, socialHandle } =
  await import('./pictureSource');
const { takePictureReturn, socialReturnWaiting } = await import('../social/socialLogin');

const ID = '1Accountaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY = '02' + 'ab'.repeat(32);
const TX = 'c'.repeat(64);
const X_PIC = 'https://pbs.twimg.com/profile_images/1/me_400x400.jpg';

type Acct = {
  addresses: { identityAddress: string };
  pubKeys: { identityPubKey: string };
  icon?: string;
  settings: { socialProfile: { avatar: string; displayName: string } };
};
const makeStorage = () => {
  const accounts: Record<string, Acct> = {
    [ID]: {
      addresses: { identityAddress: ID },
      pubKeys: { identityPubKey: KEY },
      settings: { socialProfile: { avatar: '', displayName: 'me' } },
    },
  };
  return {
    accounts,
    getAllAccounts: () => Object.values(accounts),
    getCurrentAccountObject: () => ({ account: accounts[ID] }),
    updateNested: async (_k: string, v: Record<string, Acct>) => void Object.assign(accounts, v),
  };
};
// What the card, chat and paymail read: avatar.ts pickAvatar over the account, else the bAvatar.
const shown = (s: ReturnType<typeof makeStorage>) => {
  const a = s.accounts[ID];
  return (
    pickAvatar({ local: store.get(`bwallet.avatar.${ID}`), socialAvatar: a.settings.socialProfile.avatar }) ||
    bavatarDataUri(a.pubKeys.identityPubKey)
  );
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asStorage = (s: ReturnType<typeof makeStorage>) => s as any;

beforeEach(() => store.clear());

describe('Your picture: source switching', () => {
  it('starts on the gold bAvatar, never grey', () => {
    const s = makeStorage();
    expect(pictureState(ID).source).toBe('bavatar');
    expect(shown(s)).toBe(bavatarDataUri(KEY));
    expect(shown(s).startsWith('data:image/svg+xml')).toBe(true);
  });

  it('linking X records the handle and uses its photo everywhere', async () => {
    const s = makeStorage();
    const url = await adoptLinkedProfile(asStorage(s), ID, { provider: 'x', name: 'b0asex', avatar: X_PIC });
    expect(url).toBe(X_PIC);
    expect(linkedSocial(ID)?.handle).toBe('@b0asex');
    expect(pictureState(ID).source).toBe('x');
    expect(s.accounts[ID].settings.socialProfile.avatar).toBe(X_PIC);
    expect(s.accounts[ID].icon).toBe(X_PIC);
    expect(shown(s)).toBe(X_PIC);
  });

  it('the bAvatar is kept after switching to X, and one tap brings it back', async () => {
    const s = makeStorage();
    await adoptLinkedProfile(asStorage(s), ID, { provider: 'x', name: 'b0asex', avatar: X_PIC });
    expect(bavatarDataUri(KEY)).not.toBe(''); // still drawable from the key while X is on
    await setPicture(asStorage(s), ID, { source: 'bavatar' });
    expect(pictureState(ID).source).toBe('bavatar');
    expect(shown(s)).toBe(bavatarDataUri(KEY));
    // and the linked X stays linked for a one-tap switch back
    await setPicture(asStorage(s), ID, { source: 'x' });
    expect(shown(s)).toBe(X_PIC);
  });

  it('an NFT becomes an https ORDFS picture (chat + paymail can serve it)', async () => {
    const s = makeStorage();
    const url = await setPicture(asStorage(s), ID, { source: 'nft', origin: `${TX}.0` });
    expect(url).toBe(`https://ordfs.network/content/${TX}_0`);
    expect(nftPictureUrl(`${TX}_0`)).toBe(url);
    expect(pictureState(ID)).toEqual({ source: 'nft', url, outpoint: `${TX}_0` });
    expect(shown(s)).toBe(url);
  });

  it('X without a link does nothing', async () => {
    const s = makeStorage();
    expect(await setPicture(asStorage(s), ID, { source: 'x' })).toBe('');
    expect(shown(s)).toBe(bavatarDataUri(KEY));
  });

  it('handles: X as @name, Google as display name', () => {
    expect(socialHandle({ provider: 'x', name: '@me' })).toBe('@me');
    expect(socialHandle({ provider: 'google', name: 'me@gmail.com', display: 'Me' })).toBe('Me');
    expect(socialHandle({ provider: 'google', name: 'me@gmail.com' })).toBe('me');
  });
});

describe('NFT library: Your bAvatar', () => {
  it('recognises the minted bAvatar by its inscription name', () => {
    expect(isBavatarItem('$b0asex · bWalletX #007')).toBe(true);
    expect(isBavatarItem('$b0asex · bWalletX #1234')).toBe(true);
    expect(isBavatarItem('Some picture')).toBe(false);
    expect(isBavatarItem(undefined)).toBe(false);
  });
});

describe('picture sign-in return', () => {
  const pending = (purpose?: 'picture') =>
    store.set(
      'bwallet.social',
      JSON.stringify({
        provider: 'x',
        secret: 's',
        at: Date.now(),
        ticket: 't',
        returned: true,
        owner: ID,
        profile: { provider: 'x', name: 'b0asex', avatar: X_PIC, alias: null },
        ...(purpose ? { purpose } : {}),
      }),
    );
  it('goes to the card once, never to Settings › Connect', () => {
    pending('picture');
    expect(socialReturnWaiting(ID)).toBe(false);
    expect(takePictureReturn(ID)?.avatar).toBe(X_PIC);
    expect(takePictureReturn(ID)).toBeNull();
  });
  it('a Settings › Connect sign-in is not taken by the card', () => {
    pending();
    expect(takePictureReturn(ID)).toBeNull();
    expect(socialReturnWaiting(ID)).toBe(true);
  });
});
