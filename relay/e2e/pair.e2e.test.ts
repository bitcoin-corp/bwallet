/**
 * End-to-end: real relay + TokenBlaster's site side (vendored: relay/e2e/fixtures/site/site.ts)
 * + bWallet's phone side (src/mobile/pair/sessions.ts), with the wallet call stubbed.
 * Run from the bwallet repo: bun test relay/e2e
 */
import { afterAll, expect, mock, test } from 'bun:test';
import http from 'node:http';
import { createRelay } from '../relay.mjs';

const SITE_ORIGIN = 'http://localhost:3000';
const calls: unknown[] = [];

// This test installs browser-ish globals; put the originals back so later test files see a clean runtime.
const g = globalThis as Record<string, unknown>;
const savedGlobals = Object.fromEntries(
  ['location', 'sessionStorage', 'localStorage', 'document', 'WebSocket'].map((k) => [k, g[k]]),
);
afterAll(() => {
  for (const [k, v] of Object.entries(savedGlobals)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

test('QR → scan → same code → connect → request reaches the wallet and the answer comes back', async () => {
  const server = http.createServer();
  const relay = createRelay({ server });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_PAIR_RELAY = `localhost:${port}`;

  // Browser-ish globals. Pages get the Origin header from the browser; add it for the site socket.
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  Object.assign(globalThis, { location: { origin: SITE_ORIGIN }, sessionStorage: mem(), localStorage: mem() });
  (globalThis as { document?: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  const Native = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = class extends Native {
    constructor(url: string) {
      super(url, url.includes('role=site') ? ({ headers: { Origin: SITE_ORIGIN } } as never) : undefined);
    }
  };

  mock.module(new URL('../../src/mobile/dappBrowser.ts', import.meta.url).pathname, () => ({
    handleSiteCall: async (origin: string, _url: string, type: string, params: unknown, paired?: boolean) => {
      expect(paired).toBe(true);
      calls.push({ origin, type, params });
      return { success: true, data: { publicKey: '02' + 'ab'.repeat(32) } };
    },
  }));
  // Keep every real export (other modules import more than appNameFor) and pin only the app name.
  const storeBuildPath = new URL('../../src/mobile/storeBuild.ts', import.meta.url).pathname;
  const realStoreBuild = await import(storeBuildPath);
  mock.module(storeBuildPath, () => ({ ...realStoreBuild, appNameFor: () => 'bWalletX' }));

  const site = await import('./fixtures/site/site.ts');
  const phone = await import('../../src/mobile/pair/sessions.ts');

  const states: { k: string; [x: string]: unknown }[] = [];
  const stop = site.startPairing((s: { k: string }) => states.push(s));
  const until = async (f: () => unknown, ms = 5000) => {
    const t = Date.now();
    while (!f()) {
      if (Date.now() - t > ms) throw new Error('timeout ' + JSON.stringify(states.map((s) => s.k)));
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await until(() => states.find((s) => s.k === 'qr'));
  const link = (states.find((s) => s.k === 'qr') as { link: string }).link;
  expect(link).toStartWith('https://www.bwallet.space/pair?v=1&r=localhost');

  const pending = await phone.beginPairing(link);
  expect(pending.origin).toBe(SITE_ORIGIN);
  await until(() => states.find((s) => s.k === 'code'));
  expect((states.find((s) => s.k === 'code') as { code: string }).code).toBe(pending.code);

  pending.confirm();
  await until(() => states.find((s) => s.k === 'ready'));
  const wallet = (states.find((s) => s.k === 'ready') as { wallet: { getPublicKey: (a: unknown) => Promise<unknown> } })
    .wallet;
  const r = await wallet.getPublicKey({ identityKey: true });
  expect(r).toEqual({ publicKey: '02' + 'ab'.repeat(32) });
  // Audit H1: the call runs under the paired key, not the site's own originator (no inherited grants), and the key
  // names this pairing's channel (b-Aware 24 Oct 2026), so no other pairing claiming the origin shares it.
  const [{ c: ch }] = phone.pairedSites() as { c: string }[];
  const label = 'c' + [...ch].map((x) => x.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  expect(calls).toEqual([
    { origin: `https://localhost.${label}.paired.invalid:3000`, type: 'getPublicKey', params: { identityKey: true } },
  ]);
  expect(phone.pairedSites().map((s: { origin: string }) => s.origin)).toEqual([SITE_ORIGIN]);

  // A QR claiming another origin is refused by the phone (relay reports the real one).
  const forged = link.replace(encodeURIComponent(SITE_ORIGIN), encodeURIComponent('https://tokenblaster.lol'));
  const stop2 = site.startPairing(() => {});
  await expect(phone.beginPairing(forged)).rejects.toThrow();
  stop2();

  stop();
  // stop() leaves a handed-over channel open, and its socket reconnects 2 s after the relay drops it, through
  // whatever WebSocket is global by then: a later test file's fake. Close it for good first.
  site.disconnectPhone();
  // Close the phone's live sessions before the relay goes, so no reconnect timer outlives the test.
  for (const s of phone.pairedSites() as { c: string }[]) phone.forget(s.c, false);
  relay.close();
  server.closeAllConnections?.();
  server.close();
}, 20000);
