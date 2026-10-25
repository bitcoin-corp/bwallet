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

const { isPairLink, onPairLink, takePairLink } = await import('./links');

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
