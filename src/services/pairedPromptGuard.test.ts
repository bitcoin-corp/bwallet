import { describe, expect, test } from 'bun:test';
import { pairedOrigin } from './originKey';
import { isPairedOriginator, pairedGrantAllowed, takePendingFor } from './pairedPromptGuard';

const SITE = 'https://shop.example';
const PAIRED = pairedOrigin(SITE);
const now = 1_800_000_000_000;
const session = (over: Record<string, unknown> = {}) => ({ origin: SITE, lastUsed: now - 1000, ...over });

type Entry = { request: { originator?: string }; granted?: boolean; denied?: boolean };

/** The approve path in background.ts, reduced: approve grants only if the guard allows it. */
const approve = (map: Map<string, Entry>, id: string, sessions: unknown[]) => {
  const e = map.get(id);
  if (!e) return 'no-prompt';
  map.delete(id);
  if (!pairedGrantAllowed(e.request.originator, sessions as never, now)) return 'refused';
  return 'granted';
};

describe('paired prompt guard', () => {
  test('recognises paired originators only', () => {
    expect(isPairedOriginator(PAIRED)).toBe(true);
    expect(isPairedOriginator(SITE)).toBe(false);
    expect(isPairedOriginator(undefined)).toBe(false);
  });

  test('non-paired originators are never blocked', () => {
    expect(pairedGrantAllowed(SITE, [], now)).toBe(true);
  });

  test('paired originator needs a current matching session', () => {
    expect(pairedGrantAllowed(PAIRED, [session()], now)).toBe(true);
    expect(pairedGrantAllowed(PAIRED, [], now)).toBe(false);
    expect(pairedGrantAllowed(PAIRED, [session({ lastUsed: now - 25 * 3600_000 })], now)).toBe(false);
    expect(pairedGrantAllowed(PAIRED, [session({ origin: 'https://other.example' })], now)).toBe(false);
    expect(pairedGrantAllowed(PAIRED, [session({ agent: { expiresAt: now - 1 } })], now)).toBe(false);
    expect(pairedGrantAllowed(PAIRED, [session({ agent: { expiresAt: now + 1 } })], now)).toBe(true);
  });

  test('takePendingFor removes only that originator', () => {
    const m = new Map<string, Entry>([
      ['a', { request: { originator: PAIRED } }],
      ['b', { request: { originator: SITE } }],
      ['c', { request: { originator: PAIRED } }],
    ]);
    expect(takePendingFor(m, PAIRED).map(([id]) => id)).toEqual(['a', 'c']);
    expect([...m.keys()]).toEqual(['b']);
  });

  test('forget during an open prompt: approving afterwards grants nothing; re-pair prompts again', () => {
    const pending = new Map<string, Entry>([['r1', { request: { originator: PAIRED } }]]);
    let sessions: unknown[] = [session()];
    // Forget: session removed, revoke-all denies the originator's open prompts.
    sessions = [];
    takePendingFor(pending, PAIRED);
    expect(approve(pending, 'r1', sessions)).toBe('no-prompt');
    // Even if the prompt had survived, approve-time check refuses without a session.
    pending.set('r2', { request: { originator: PAIRED } });
    expect(approve(pending, 'r2', sessions)).toBe('refused');
    // Re-pair: no grant was written, so the next call prompts again and can be approved.
    sessions = [session()];
    pending.set('r3', { request: { originator: PAIRED } });
    expect(approve(pending, 'r3', sessions)).toBe('granted');
  });
});
