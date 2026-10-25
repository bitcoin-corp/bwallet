import { describe, expect, it } from 'bun:test';
import {
  markSiteConnected,
  parseConnectTheme,
  pickSubTheme,
  setSiteThemesOn,
  type WornTheme,
} from '../theme/connectSiteTheme';
import {
  loadRoomLook,
  rememberRoomSite,
  roomOwnerOrigin,
  roomHeaderBackground,
  roomLookFrom,
  roomSite,
} from './roomLook';

const O = 'https://www.tokenblaster.lol';
const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const BASE = {
  v: 2,
  name: 'TokenBlaster',
  mode: 'dark',
  accent: '#FF3B30',
  accentHi: '#FFB800',
  bg: '#0A0A0C',
  surface: '#121317',
  text: '#F2EFE6',
};
const worn = (extra: Record<string, unknown>, data: Partial<WornTheme> = {}): WornTheme => {
  const p = parseConnectTheme({ ...BASE, ...extra }, O);
  if (!p.theme) throw new Error(p.error);
  return { ...p.theme, origin: O, ...data };
};
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';

describe('roomArt in the theme file', () => {
  it('accepts a same-origin roomArt and refuses another origin', () => {
    expect(parseConnectTheme({ ...BASE, roomArt: '/brand/room.jpg' }, O).theme?.roomArt).toBe(`${O}/brand/room.jpg`);
    expect(parseConnectTheme({ ...BASE, roomArt: 'https://evil.example/x.jpg' }, O).theme).toBeUndefined();
  });
});

describe('roomLookFrom', () => {
  it('only dresses the room the theme names', () => {
    const t = worn({ room: 'ASSAULT' }, { logoData: PNG, artData: JPG });
    expect(roomLookFrom(t, 'TOKENBLASTER')).toBeNull();
    const l = roomLookFrom(t, '$assault');
    expect(l?.host).toBe('www.tokenblaster.lol');
    expect(l?.logoData).toBe(PNG);
    expect(l?.artData).toBe(JPG);
    expect(roomLookFrom(worn({}), 'ASSAULT')).toBeNull();
  });
  it('prefers roomArt over cardArt, and the header keeps a readable overlay', () => {
    const l = roomLookFrom(worn({ room: 'ASSAULT' }, { artData: JPG, roomArtData: PNG }), 'ASSAULT')!;
    expect(l.artData).toBe(PNG);
    const bg = roomHeaderBackground(l);
    expect(bg.startsWith('linear-gradient(180deg, #0A0A0CE6')).toBe(true);
    expect(bg).toContain(PNG);
    // Anything that is not a wallet-fetched image is never put in CSS.
    expect(roomHeaderBackground({ ...l, artData: 'https://x")' })).not.toContain('url(');
  });
});

describe('room → site memory', () => {
  it('works for whatever path the tab ends up on (e.g. after a redirect)', async () => {
    const s = mem();
    markSiteConnected(O, s, (async () => new Response('', { status: 404 })) as unknown as typeof fetch);
    const paths = { '/arcade/terrornode': `${O}/.well-known/bwalletx-theme.assault.json` };
    expect(pickSubTheme(paths, '/arcade/terrornode/level-2')).toBe(paths['/arcade/terrornode']);
    rememberRoomSite('ASSAULT', O, '/arcade/terrornode', s);
    expect(roomSite('assault', s)?.path).toBe('/arcade/terrornode');
    const seen: (string | null | undefined)[] = [];
    const load = (async (_o: string, o: { path?: string | null }) => {
      seen.push(o.path);
      return worn({ room: 'ASSAULT' });
    }) as never;
    // No owner on the room, or another site as owner: never dressed.
    expect(await loadRoomLook('ASSAULT', { s, load })).toBeNull();
    expect(await loadRoomLook('ASSAULT', { s, load, owner: 'https://other.example' })).toBeNull();
    seen.length = 0;
    expect((await loadRoomLook('ASSAULT', { s, load, owner: O }))?.name).toBe('TokenBlaster');
    expect(seen).toEqual(['/arcade/terrornode']);
    setSiteThemesOn(false, s);
    expect(await loadRoomLook('ASSAULT', { s, load, owner: O })).toBeNull();
  });
  it('an unknown room or an unconnected site gets no look', async () => {
    const s = mem();
    expect(await loadRoomLook('NOPE', { s })).toBeNull();
    rememberRoomSite('ASSAULT', 'https://other.example', null, s);
    expect(await loadRoomLook('ASSAULT', { s })).toBeNull();
  });
});

describe('room ownership', () => {
  it('reads the room owner from metadata.site as an origin', () => {
    expect(roomOwnerOrigin({ site: 'https://www.tokenblaster.lol/arcade' })).toBe(O);
    expect(roomOwnerOrigin({ site: 'tokenblaster.lol' })).toBeNull();
    expect(roomOwnerOrigin({ site: 'javascript:alert(1)' })).toBeNull();
    expect(roomOwnerOrigin(null)).toBeNull();
    expect(roomOwnerOrigin({ site: 'https://abc.paired.invalid' })).toBeNull();
  });
});

describe('serverRoomLook', () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const fakeFetch = (files: Record<string, unknown>) =>
    (async (url: string) => {
      const v = files[url];
      if (v === undefined)
        return { ok: false, url, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
      const bytes = v instanceof Uint8Array ? v : new TextEncoder().encode(JSON.stringify(v));
      const type = v instanceof Uint8Array ? 'image/png' : 'application/json';
      return { ok: true, url, headers: new Headers({ 'content-type': type }), arrayBuffer: async () => bytes.buffer };
    }) as unknown as typeof fetch;

  it('ATTACK: a room claiming a site whose theme file does not name it stays plain', async () => {
    const { serverRoomLook } = await import('./roomLook');
    // A scam room sets metadata.site = tokenblaster.lol and TokenBlaster's colours; the site's file names another room.
    const files = { [`${O}/.well-known/bwalletx-theme.json`]: { ...BASE, room: 'TOKENBLASTER' } };
    const meta = { site: O, look: { ...BASE, name: 'TokenBlaster' } };
    expect(await serverRoomLook('SCAM', meta, { s: mem(), f: fakeFetch(files) })).toBeNull();
    // No theme file at all: plain too.
    expect(await serverRoomLook('SCAM', meta, { s: mem(), f: fakeFetch({}) })).toBeNull();
  });

  it('wears metadata.look without any connection once the site names the room, images only from metadata.site', async () => {
    const { serverRoomLook } = await import('./roomLook');
    const meta = { site: O, look: { ...BASE, name: 'Assault on Terrornode', logo: '/brand/a.png' } };
    const proof = { [`${O}/.well-known/bwalletx-theme.json`]: { ...BASE, room: 'ASSAULT' } };
    const l = await serverRoomLook('ASSAULT', meta, {
      s: mem(),
      f: fakeFetch({ ...proof, [`${O}/brand/a.png`]: png }),
    });
    expect(l?.name).toBe('Assault on Terrornode');
    expect(l?.logoData?.startsWith('data:image/png;base64,')).toBe(true);
    const bad = { site: O, look: { ...BASE, logo: 'https://evil.example/a.png' } };
    // A look with a foreign picture fails parseConnectTheme; the site has no theme file either: no look.
    expect(await serverRoomLook('ASSAULT', bad, { s: mem(), f: fakeFetch({}) })).toBeNull();
    expect(await serverRoomLook('ASSAULT', { look: BASE }, { s: mem(), f: fakeFetch({}) })).toBeNull();
  });

  it('falls back to the site theme file, matching the sub-theme that names the room', async () => {
    const { serverRoomLook } = await import('./roomLook');
    const files = {
      [`${O}/.well-known/bwalletx-theme.json`]: {
        ...BASE,
        room: 'TOKENBLASTER',
        paths: { '/arcade/assault': '/.well-known/bwalletx-theme.assault.json' },
      },
      [`${O}/.well-known/bwalletx-theme.assault.json`]: { ...BASE, name: 'Assault on Terrornode', room: 'ASSAULT' },
    };
    const l = await serverRoomLook('ASSAULT', { site: O }, { s: mem(), f: fakeFetch(files) });
    expect(l?.name).toBe('Assault on Terrornode');
    expect(l?.ticker).toBe('ASSAULT');
    const other = await serverRoomLook('NOPE', { site: O }, { s: mem(), f: fakeFetch(files) });
    expect(other).toBeNull();
  });
});
