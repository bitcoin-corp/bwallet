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
