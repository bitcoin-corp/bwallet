/**
 * b-Aware 25 Oct 2026: a peer that names the CLI origin (any program can set that Origin header) got a CLI pairing,
 * and with it an agent grant, from the general scanner or a link that opened the app. A CLI pairing is now accepted
 * only when the owner started it from Agents or Settings, and only a CLI pairing can carry an agent grant.
 */
import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { PAIR_VERSION, pairUrl } from '../../pair/protocol';
import { stubGlobals } from '../../testing/stubGlobals';
import { CLI_ORIGIN, makeGrant } from './agentPairing';

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const mem = new Map<string, string>();
stubGlobals({
  WebSocket: FakeWS,
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
  document: { visibilityState: 'visible', addEventListener: () => undefined },
});

const sessions = (await import('./sessions?forgedCliPair' as string)) as typeof import('./sessions');
const KEY = 'bwallet.pair.sessions';
const stored = () => JSON.parse(mem.get(KEY) ?? '[]') as { origin: string; agent?: unknown }[];

const link = (o: string, c: string) =>
  pairUrl({
    v: PAIR_VERSION,
    r: 'relay.bwallet.space',
    c,
    k: PrivateKey.fromRandom().toPublicKey().toString(),
    o,
    e: Math.floor(Date.now() / 1000) + 120,
  });

describe('forged CLI pairing', () => {
  test('a CLI link from the general scanner or an opened link is refused before connecting', async () => {
    const before = FakeWS.all.length;
    await expect(sessions.beginPairing(link(CLI_ORIGIN, 'c'.repeat(22)))).rejects.toThrow(/Agents/);
    expect(FakeWS.all.length).toBe(before); // never even reached the relay
    expect(stored()).toEqual([]);
  });

  test('from Agents/Settings the CLI pairing still works (the owner chose it)', async () => {
    const pending = sessions.beginPairing(link(CLI_ORIGIN, 'd'.repeat(22)), { allowCli: true });
    FakeWS.all.at(-1)!.deliver({ t: 'relay', verifiedOrigin: CLI_ORIGIN });
    const p = await pending;
    expect(p.cli).toBe(true);
    p.confirm(makeGrant('acct', 'Agent', ['read'], 1));
    expect(stored().some((s) => s.origin === CLI_ORIGIN && s.agent)).toBe(true);
  });

  test('a website pairing cannot be handed an agent grant', async () => {
    mem.clear();
    const site = 'https://pairtest.example';
    const pending = sessions.beginPairing(link(site, 'e'.repeat(22)), { allowCli: true });
    FakeWS.all.at(-1)!.deliver({ t: 'relay', verifiedOrigin: site });
    const p = await pending;
    expect(p.cli).toBe(false);
    p.confirm(makeGrant('acct', 'Agent', ['read', 'mint'], 1));
    expect(stored()).toEqual([]);
  });
});
