import { afterEach, expect, mock, test } from 'bun:test';
// Live answers from pay.bwallet.space, 25 Oct 2026 (owner's iPhone send to bwalletX@ / bwalletX.X@bwalletX.com).
import pki from '../mobile/names/testdata/paymail-bwalletx-x/pki.json';
import p2p from '../mobile/names/testdata/paymail-bwalletx-x/p2p.json';
import caps from '../mobile/names/testdata/paymail-bwalletx-x/bsvalias.json';

// As the mobile build defines it (vite.config.mobile.ts), so bwalletx.com counts as our domain.
const realConfig = await import('../mobile/names/config');
mock.module('../mobile/names/config', () => ({
  ...realConfig,
  BWALLET_PAYMAIL_DOMAIN: 'bwalletx.com',
  BWALLET_PAYMAIL_API: 'https://pay.bwallet.space',
}));
const { resolvePaymail, destinationFor, parseRecipient } = await import('../mobile/names/names');
const { sendBsv } = await import('./guardedSendBsv');

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const notFound = () => new Response('{"error":"not-found"}', { status: 404 });
const posts: string[] = [];
const live = async (u: string | URL | Request, i?: RequestInit) => {
  const url = String(u);
  if (i?.method === 'POST') posts.push(url);
  if (url.includes('dns.google') || url.includes('manifest.json')) return ok({});
  if (url.endsWith('/.well-known/bsvalias')) return ok(caps);
  const known = /\/bwalletx\.x@bwalletx\.com$/i.test(url);
  if (!known) return notFound();
  if (url.includes('/id/')) return ok(pki);
  if (url.includes('/p2p-destination/')) return ok(p2p);
  return notFound();
};
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  posts.length = 0;
});

test('bwalletX.X@bwalletX.com (any case) resolves with a signed binding and passes the destination check', async () => {
  const p = parseRecipient('bwalletX.X@bwalletX.com');
  expect(p).toEqual({ kind: 'paymail', paymail: 'bwalletx.x@bwalletx.com' });
  const r = await resolvePaymail(live as never, 'bwalletx.x@bwalletx.com');
  expect(r.nameBinding).toBe('signed');
  expect(r.external).toBeUndefined();
  expect(destinationFor(r, 'bsv')).toEqual({ ok: true, to: 'bwalletx.x@bwalletx.com' });

  globalThis.fetch = live as never;
  const wallet = {
    createAction: async () => {
      throw new Error('reached-signing');
    },
  };
  const res = await sendBsv.execute({ wallet } as never, {
    requests: [{ paymail: 'bwalletx.x@bwalletx.com', satoshis: 1000 }],
  });
  expect(res.error).toBe('reached-signing'); // every #97 check passed; only the (fake) wallet stopped it
});

test('an alias our host does not know is "no such user" at lookup, not a 404 at send', async () => {
  await expect(resolvePaymail(live as never, 'bwalletx@bwalletx.com')).rejects.toThrow(
    'No bWalletX user called bwalletx@bwalletx.com',
  );
  globalThis.fetch = live as never;
  const res = await sendBsv.execute({ wallet: {} } as never, {
    requests: [{ paymail: 'bwalletx@bwalletx.com', satoshis: 1000 }],
  });
  expect(res.error).toBe('Payment refused: No bWalletX user called bwalletx@bwalletx.com. Nothing was sent.');
  expect(posts).toEqual([]); // never asked the host for a destination
});
