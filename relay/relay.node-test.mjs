import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createRelay, acceptableOrigin } from './relay.mjs';

const C = 'AAAAAAAAAAAAAAAAAAAAAA'; // 22 chars
const exp = () => Math.floor(Date.now() / 1000) + 120;

async function boot(opts = {}) {
  const server = http.createServer();
  const relay = createRelay({ server, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${server.address().port}`;
  return { base, done: () => (relay.close(), new Promise((r) => server.close(r))) };
}
const open = (url, origin) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
    ws.on('error', reject);
  });
const until = async (fn, ms = 2000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('origins', () => {
  assert.equal(acceptableOrigin('https://tokenblaster.lol'), true);
  assert.equal(acceptableOrigin('http://localhost:3000'), true);
  assert.equal(acceptableOrigin('http://evil.example'), false);
  assert.equal(acceptableOrigin('https://a.b/path'), false);
  assert.equal(acceptableOrigin(undefined), false);
});

test('pairs, tells the phone the verified origin, forwards both ways', async () => {
  const { base, done } = await boot();
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://tokenblaster.lol');
  const phone = await open(`${base}/v1/c/${C}?role=wallet`);
  await until(() => phone.inbox.length && site.inbox.length);
  assert.deepEqual(phone.inbox[0], { t: 'relay', verifiedOrigin: 'https://tokenblaster.lol' });
  assert.deepEqual(site.inbox[0], { t: 'relay', peer: 'joined', role: 'wallet' });
  phone.ws.send(JSON.stringify({ t: 'hello', k: '02ab' }));
  site.ws.send(JSON.stringify({ s: 1, n: 'x', d: 'y' }));
  await until(() => site.inbox.length === 2 && phone.inbox.length === 2);
  assert.deepEqual(site.inbox[1], { t: 'hello', k: '02ab' });
  assert.deepEqual(phone.inbox[1], { s: 1, n: 'x', d: 'y' });
  site.ws.close();
  phone.ws.close();
  await done();
});

test('rejects: no origin, wallet before site, origin change, expired QR', async () => {
  const { base, done } = await boot();
  await assert.rejects(open(`${base}/v1/c/${C}?role=site&e=${exp()}`), /403/);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet`), /404/);
  await assert.rejects(
    open(`${base}/v1/c/${C}?role=site&e=${Math.floor(Date.now() / 1000) - 5}`, 'https://a.lol'),
    /400/,
  );
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://a.lol');
  await assert.rejects(open(`${base}/v1/c/${C}?role=site`, 'https://evil.lol'), /403/);
  site.ws.close();
  await until(() => true);
  await done();
});

test('queues frames while the phone is away (app in background)', async () => {
  const { base, done } = await boot();
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://a.lol');
  const p1 = await open(`${base}/v1/c/${C}?role=wallet`);
  await until(() => p1.inbox.length);
  p1.ws.close();
  await until(() => site.inbox.some((m) => m.peer === 'left'));
  site.ws.send(JSON.stringify({ s: 2, n: 'n', d: 'queued' }));
  await new Promise((r) => setTimeout(r, 50));
  const p2 = await open(`${base}/v1/c/${C}?role=wallet`); // paired: rejoin allowed after QR expiry rules
  await until(() => p2.inbox.length === 2);
  assert.equal(p2.inbox[1].d, 'queued');
  site.ws.close();
  p2.ws.close();
  await done();
});

test('same-phone pairing: wallet joins while the site is away (Safari suspended), frames wait for the site', async () => {
  const { base, done } = await boot();
  const s1 = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://a.lol');
  s1.ws.close();
  await new Promise((r) => setTimeout(r, 50));
  const phone = await open(`${base}/v1/c/${C}?role=wallet`);
  await until(() => phone.inbox.length);
  assert.deepEqual(phone.inbox[0], { t: 'relay', verifiedOrigin: 'https://a.lol' });
  phone.ws.send(JSON.stringify({ t: 'hello', k: '02cd' }));
  await new Promise((r) => setTimeout(r, 50));
  // Origin is still enforced when the site comes back.
  await assert.rejects(open(`${base}/v1/c/${C}?role=site`, 'https://evil.lol'), /403/);
  const s2 = await open(`${base}/v1/c/${C}?role=site`, 'https://a.lol');
  await until(() => s2.inbox.some((m) => m.t === 'hello'));
  assert.deepEqual(
    s2.inbox.find((m) => m.t === 'hello'),
    { t: 'hello', k: '02cd' },
  );
  s2.ws.close();
  phone.ws.close();
  await done();
});

test('unpaired wallet join still refused once the QR has expired (site away or not)', async () => {
  let clock = Date.now();
  const { base, done } = await boot({ now: () => clock });
  const s1 = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://a.lol');
  s1.ws.close();
  clock += 10 * 60_000;
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet`), /410/);
  await done();
});

test('a claimed wallet role admits only its claim; the owner can still reconnect', async () => {
  const { base, done } = await boot();
  const K = 'claimclaimclaimclaim_1'; // 22 chars
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://tokenblaster.lol');
  const phone = await open(`${base}/v1/c/${C}?role=wallet&claim=${K}`);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet`), /403/);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=otherotherotherother_2`), /403/);
  const again = await open(`${base}/v1/c/${C}?role=wallet&claim=${K}`);
  await until(() => phone.ws.readyState === 3);
  await assert.rejects(open(`${base}/v1/c/${C}?role=wallet&claim=bad`), /400/);
  site.ws.close();
  again.ws.close();
  await done();
});

test('an unclaimed role keeps the old behaviour (clients without a claim)', async () => {
  const { base, done } = await boot();
  const site = await open(`${base}/v1/c/${C}?role=site&e=${exp()}`, 'https://tokenblaster.lol');
  const a = await open(`${base}/v1/c/${C}?role=wallet`);
  const b = await open(`${base}/v1/c/${C}?role=wallet`);
  await until(() => a.ws.readyState === 3);
  site.ws.close();
  b.ws.close();
  await done();
});
