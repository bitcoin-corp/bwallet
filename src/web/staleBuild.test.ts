import { describe, expect, test } from 'bun:test';
import { installStaleBuildCheck, type StaleEnv } from './staleBuild';

const setup = (live: string, opts: { playing?: boolean; unlocked?: { v: boolean } } = {}) => {
  const listeners: Record<string, (() => void)[]> = {};
  const on = (k: string, f: () => void) => (listeners[k] ||= []).push(f);
  let t = 1_000_000;
  const fetched: string[] = [];
  const assigned: string[] = [];
  const pushed: string[] = [];
  const offers: number[] = [];
  const media = { paused: !opts.playing, ended: false };
  const env: StaleEnv = {
    doc: {
      visibilityState: 'visible',
      querySelector: () => ({ getAttribute: () => '/assets/main-OLD.js' }) as unknown as Element,
      querySelectorAll: () => [media] as unknown as NodeListOf<Element>,
      addEventListener: (k: string, f: () => void) => on(k, f),
    } as unknown as StaleEnv['doc'],
    win: {
      addEventListener: (k: string, f: () => void) => on(k, f),
      history: { pushState: (_d: unknown, _u: string, url?: string | URL | null) => void pushed.push(String(url)) },
      location: { assign: (u: string | URL) => void assigned.push(String(u)) },
    } as unknown as StaleEnv['win'],
    fetchText: async (u) => {
      fetched.push(u);
      return `<script type="module" src="/assets/${live}"></script>`;
    },
    now: () => t,
    offer: () => void offers.push(t),
    unlocked: opts.unlocked ? () => opts.unlocked!.v : undefined,
  };
  const api = installStaleBuildCheck(env)!;
  const fire = async (k: string) => {
    for (const f of listeners[k] || []) f();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { env, api, fire, fetched, assigned, pushed, tick: (ms: number) => (t += ms), media, offers };
};

describe('stale build check', () => {
  test('focus with a newer build out never reloads the page', async () => {
    const s = setup('main-NEW.js');
    await s.fire('visibilitychange');
    await s.fire('focus');
    expect(s.api.stale()).toBe(true);
    expect(s.assigned).toEqual([]);
  });

  test('checks at most once a minute', async () => {
    const s = setup('main-OLD.js');
    await s.fire('visibilitychange');
    await s.fire('focus');
    await s.fire('visibilitychange');
    expect(s.fetched.length).toBe(1);
    s.tick(60_000);
    await s.fire('focus');
    expect(s.fetched.length).toBe(2);
  });

  test('the newer build loads on the next navigation, not while media plays', async () => {
    const s = setup('main-NEW.js', { playing: true });
    await s.fire('focus');
    s.env.win.history.pushState(null, '', '/media/a');
    expect(s.assigned).toEqual([]);
    expect(s.pushed).toEqual(['/media/a']);
    s.media.paused = true;
    s.env.win.history.pushState(null, '', '/feed');
    expect(s.assigned).toEqual(['/feed']);
  });

  test('never swaps the build in on navigation while the wallet is unlocked (the key is memory-only)', async () => {
    const unlocked = { v: true };
    const s = setup('main-NEW.js', { unlocked });
    await s.fire('focus');
    s.env.win.history.pushState(null, '', '/feed');
    expect(s.assigned).toEqual([]);
    expect(s.pushed).toEqual(['/feed']);
    expect(s.offers.length).toBe(1);
    unlocked.v = false;
    s.env.win.history.pushState(null, '', '/home');
    expect(s.assigned).toEqual(['/home']);
  });

  test('same build: navigation stays in place', async () => {
    const s = setup('main-OLD.js');
    await s.fire('focus');
    s.env.win.history.pushState(null, '', '/x');
    expect(s.pushed).toEqual(['/x']);
    expect(s.assigned).toEqual([]);
  });

  test('a newer build is offered once (tap to update), never applied by itself', async () => {
    const s = setup('main-NEW.js');
    await s.fire('pageshow');
    expect(s.offers.length).toBe(1);
    s.tick(60_000);
    await s.fire('focus');
    expect(s.offers.length).toBe(1);
    expect(s.assigned).toEqual([]);
  });

  test('the same build offers nothing', async () => {
    const s = setup('main-OLD.js');
    await s.fire('pageshow');
    expect(s.fetched.length).toBe(1);
    expect(s.offers).toEqual([]);
  });
});
