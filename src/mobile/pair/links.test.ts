import { describe, expect, mock, test } from 'bun:test';

// Native app: a cold start hands the link over via getLaunchUrl, a warm one via appUrlOpen.
const COLD = 'https://www.bwallet.space/pair?v=1&c=cold';
let urlOpen: ((e: { url: string }) => void) | undefined;
// The launch URL is held until the cold-start test releases it, so the result never depends on how many microtasks
// have run or on which test (bun --randomize) goes first.
let releaseLaunch!: () => void;
const launch = new Promise<{ url: string }>((r) => (releaseLaunch = () => r({ url: COLD })));
// bun's mock.module is process-wide, so keep the real exports (registerPlugin etc.) for later test files.
const realCore = { ...(await import('@capacitor/core')) };
mock.module('@capacitor/core', () => ({
  ...realCore,
  Capacitor: { ...realCore.Capacitor, isNativePlatform: () => true },
}));
// Keep the real exports: bun module mocks are process-wide, and a partial mock left behind breaks later files that
// import other names from it.
const realCapApp = { ...(await import('@capacitor/app')) };
mock.module('@capacitor/app', () => ({
  ...realCapApp,
  App: {
    addListener: (ev: string, fn: (e: { url: string }) => void) => {
      if (ev === 'appUrlOpen') urlOpen = fn;
      return Promise.resolve({ remove: () => undefined });
    },
    getLaunchUrl: () => launch,
  },
}));

const { isPairLink, onPairLink, pairLinkFrom, takePairLink } = await import('./links');

describe('pairLinkFrom (pair.html "Open in the app" and the web wallet entry)', () => {
  const Q = 'v=1&r=relay.bwallet.space&c=abc&ret=https%3A%2F%2Fx.example%2F&rid=r1d_r1d_r1d_r1d_r1d_r1';
  test('the https link, bwalletx://pair and the web wallet bwxpair entry all become the https pairing link', () => {
    const https = `https://www.bwallet.space/pair?${Q}`;
    expect(pairLinkFrom(https)).toBe(https);
    expect(pairLinkFrom(`bwalletx://pair?${Q}`)).toBe(https);
    expect(pairLinkFrom(`https://web.bwalletx.com/m/settings?bwxpair=1&${Q}`)).toBe(https);
  });
  test('other links are not pairing links', () => {
    expect(pairLinkFrom('bwalletx://social#x')).toBeNull();
    expect(pairLinkFrom('bwallet://evil.example/pair')).toBeNull();
    expect(pairLinkFrom('https://web.bwalletx.com/m/settings?bwxauth=1')).toBeNull();
    expect(pairLinkFrom('not a url')).toBeNull();
  });
});

describe('isPairLink', () => {
  test('accepts the pairing links bit-sign and bWalletX produce', () => {
    expect(
      isPairLink(
        'https://www.bwallet.space/pair?v=1&r=relay.bwallet.space&c=abc&k=02aa&o=https%3A%2F%2Fbit-sign.online&e=1',
      ),
    ).toBe(true);
    expect(isPairLink('https://bwallet.space/pair?v=1')).toBe(true);
  });
  test('rejects other hosts and paths', () => {
    expect(isPairLink('https://www.bwallet.space/social#x')).toBe(false);
    expect(isPairLink('https://www.bwallet.space/pairing?v=1')).toBe(false);
    expect(isPairLink('https://evil.example/pair?v=1')).toBe(false);
    expect(isPairLink('https://www.bwallet.space.evil.example/pair')).toBe(false);
    expect(isPairLink('not a url')).toBe(false);
  });
});

describe('app link routing', () => {
  test('cold start: launch URL is held for the pairing screen', async () => {
    const offered = new Promise<void>((r) => {
      const off = onPairLink(() => (off(), r()));
    });
    releaseLaunch();
    await offered;
    expect(takePairLink()).toBe(COLD);
    expect(takePairLink()).toBeNull();
  });
  test('warm: appUrlOpen pair link notifies listeners; other URLs are ignored', () => {
    let hits = 0;
    const off = onPairLink(() => hits++);
    urlOpen?.({ url: 'https://www.bwallet.space/social#t=1' });
    expect(hits).toBe(0);
    expect(takePairLink()).toBeNull();
    const warm = 'https://www.bwallet.space/pair?v=1&c=warm';
    urlOpen?.({ url: warm });
    expect(hits).toBe(1);
    expect(takePairLink()).toBe(warm);
    off();
  });
});
