import { describe, expect, test } from 'bun:test';
import {
  loadConnectTheme,
  markSiteConnected,
  parseConnectTheme,
  parsePaths,
  pickSubTheme,
  subThemeUrl,
} from './connectSiteTheme';

const O = 'https://www.tokenblaster.lol';
const base = {
  v: 2,
  name: 'TokenBlaster',
  mode: 'dark',
  accent: '#F5C542',
  bg: '#050505',
  surface: '#141414',
  text: '#FFFFFF',
};
const sub = { ...base, name: 'Assault', accent: '#FF3B30' };

describe('path sub-themes', () => {
  test('targets: same origin /.well-known/*.json only', () => {
    expect(subThemeUrl('/.well-known/bwalletx-theme.assault.json', O)).toBe(
      `${O}/.well-known/bwalletx-theme.assault.json`,
    );
    for (const bad of [
      'https://evil.example/.well-known/x.json',
      '/brand/x.json',
      '/.well-known/x.js',
      '/.well-known/x.json?a=1',
      '/.well-known/../x.json',
      '/.well-known/bwalletx-theme.json',
      'javascript:alert(1)',
    ])
      expect(subThemeUrl(bad, O)).toBeNull();
  });
  test('the validator accepts `paths`; at most 8; a bad map is dropped, the root stays', () => {
    const ok = parseConnectTheme(
      { ...base, paths: { '/arcade/assault': '/.well-known/bwalletx-theme.assault.json' } },
      O,
    );
    expect(ok.theme?.paths).toEqual({ '/arcade/assault': `${O}/.well-known/bwalletx-theme.assault.json` });
    const nine = Object.fromEntries([...Array(9)].map((_, i) => [`/g${i}`, `/.well-known/t${i}.json`]));
    expect(parsePaths(nine, O)).toBeNull();
    const bad = parseConnectTheme({ ...base, paths: { '/a': 'https://evil.example/.well-known/x.json' } }, O);
    expect(bad.theme?.name).toBe('TokenBlaster');
    expect(bad.theme?.paths).toBeUndefined();
    expect(parsePaths({ 'no-slash': '/.well-known/a.json' }, O)).toBeNull();
  });
  test('longest prefix, on a "/" boundary only', () => {
    const p = { '/arcade': 'A', '/arcade/assault': 'B', '/': 'R' };
    expect(pickSubTheme(p, '/arcade/assault')).toBe('B');
    expect(pickSubTheme(p, '/arcade/assault/level-2')).toBe('B');
    expect(pickSubTheme(p, '/arcade/assaulted')).toBe('A');
    expect(pickSubTheme(p, '/arcadey')).toBe('R');
    expect(pickSubTheme({ '/arcade': 'A' }, '/arcadey')).toBeNull();
  });
  test('loads the sub-theme; any failure falls back to the root', async () => {
    const mem = new Map<string, string>();
    const s = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const files: Record<string, unknown> = {
      '/.well-known/bwalletx-theme.json': {
        ...base,
        paths: {
          '/arcade/assault': '/.well-known/bwalletx-theme.assault.json',
          '/arcade/broken': '/.well-known/broken.json',
        },
      },
      '/.well-known/bwalletx-theme.assault.json': sub,
      '/.well-known/broken.json': { ...sub, accent: '#060606' },
    };
    const f = (async (url: string) => {
      const body = files[new URL(url).pathname];
      return {
        ok: body !== undefined,
        url,
        headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body ?? {})).buffer,
      };
    }) as unknown as typeof fetch;
    markSiteConnected('www.tokenblaster.lol', s, f);
    expect((await loadConnectTheme('www.tokenblaster.lol', { s, f, path: '/arcade/assault' }))?.name).toBe('Assault');
    expect((await loadConnectTheme('www.tokenblaster.lol', { s, f, path: '/arcade/broken' }))?.name).toBe(
      'TokenBlaster',
    );
    expect((await loadConnectTheme('www.tokenblaster.lol', { s, f, path: '/' }))?.name).toBe('TokenBlaster');
  });
});
