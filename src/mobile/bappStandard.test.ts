import { describe, expect, test } from 'bun:test';
import {
  BX_APPS,
  COMMERCIAL_APPS,
  matchesQuery,
  meetsStandard,
  missingStandard,
  shortLine,
  tileColour,
  TILE_PALETTE,
  standardReport,
  visibleApps,
} from './bappStandard';

describe('bApp standard', () => {
  test('missing parts are listed', () => {
    expect(missingStandard({ token: 'X', room: null, theme: 'x', inWallet: false })).toEqual(['room', 'inWallet']);
    expect(meetsStandard({ token: 'X', room: 'X', theme: 'x', inWallet: true })).toBe(true);
  });
  test('NPG and NPGX are separate entries, NPGX is adult and private', () => {
    const npg = COMMERCIAL_APPS.find((a) => a.id === 'npg');
    const npgx = COMMERCIAL_APPS.find((a) => a.id === 'npgx');
    expect(npg?.adult).toBeFalsy();
    expect(npgx?.adult).toBe(true);
    expect(npgx?.privateOnly).toBe(true);
    expect(npg?.category).not.toBe(npgx?.category);
  });
  test('store build hides adult and private apps', () => {
    const shown = visibleApps(COMMERCIAL_APPS, true).map((a) => a.id);
    expect(shown).not.toContain('npgx');
    expect(shown).not.toContain('zerodice');
    expect(shown).toContain('npg');
  });
  test('ids are unique and every b*X name ends in X', () => {
    const ids = [...BX_APPS, ...COMMERCIAL_APPS].map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of BX_APPS) expect(a.name.endsWith('X')).toBe(true);
  });
  test('search matches name, verb and token', () => {
    const a = BX_APPS[0];
    expect(matchesQuery(a, a.name.toLowerCase())).toBe(true);
    expect(matchesQuery(a, 'zzzz')).toBe(false);
  });
  test('report covers every entry', () => {
    expect(standardReport().length).toBeGreaterThan(BX_APPS.length);
  });
});

describe('bApps cards (owner, 25 Oct 2026)', () => {
  test('one short line per card', () => {
    expect(shortLine('Tokenise your music; holders make the video with you')).toBe('Tokenise your music');
    expect(shortLine('Watch and back films')).toBe('Watch and back films');
    expect(shortLine('Watch and back tokenised films')).toBe('Watch and back tokenised…');
    expect(shortLine('Adults only. The NPGX brand, separate from NPG')).toBe('Adults only');
    const long = shortLine('Mint anything you like here: art, media, coins and archives forever and ever');
    expect(long.length).toBeLessThanOrEqual(25);
    expect(shortLine(undefined)).toBe('');
    for (const a of [...BX_APPS, ...COMMERCIAL_APPS]) expect(shortLine(a.verb).length).toBeLessThanOrEqual(25);
  });
  test('every tile has a bold colour: its brand colour, else one picked from its name (never grey)', () => {
    expect(tileColour('bDojoX', '#C8141C')).toBe('#C8141C');
    const c = tileColour('Some App');
    expect(TILE_PALETTE as readonly string[]).toContain(c);
    expect(tileColour('Some App')).toBe(c);
    expect(tileColour('x', 'not-a-colour')).toMatch(/^#[0-9A-F]{6}$/i);
    for (const a of [...BX_APPS, ...COMMERCIAL_APPS]) expect(a.color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
