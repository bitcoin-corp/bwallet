import { describe, expect, test } from 'bun:test';
import { activeSiteRoom, roomKnown, roomTicker, setActiveSiteRoom } from './siteRoom';
import { parseConnectTheme } from '../theme/connectSiteTheme';

const O = 'https://www.tokenblaster.lol';
const base = {
  v: 2,
  name: 'Assault',
  mode: 'dark',
  accent: '#FF3B30',
  bg: '#050505',
  surface: '#141414',
  text: '#FFFFFF',
};

describe('site room', () => {
  test('room is a plain ticker; anything else is dropped, the theme still applies', () => {
    expect(roomTicker('$assault')).toBe('ASSAULT');
    for (const bad of ['', 'a b', 'https://x', '<b>', 'X'.repeat(21), 7]) expect(roomTicker(bad)).toBeNull();
    expect(parseConnectTheme({ ...base, room: 'assault' }, O).theme?.room).toBe('ASSAULT');
    const bad = parseConnectTheme({ ...base, room: 'javascript:1' }, O);
    expect(bad.theme?.name).toBe('Assault');
    expect(bad.theme?.room).toBeUndefined();
  });
  test('only a room the wallet lists is opened', () => {
    expect(roomKnown([{ ticker: '$ASSAULT' }], 'ASSAULT')).toBe(true);
    expect(roomKnown([{ ticker: 'LOUNGE' }], 'ASSAULT')).toBe(false);
  });
  test('follows the active site', () => {
    setActiveSiteRoom({ ticker: 'ASSAULT', origin: O });
    expect(activeSiteRoom()?.ticker).toBe('ASSAULT');
    setActiveSiteRoom(null);
    expect(activeSiteRoom()).toBeNull();
  });
});
