import { describe, expect, test } from 'bun:test';
import {
  BX_APPS,
  COMMERCIAL_APPS,
  matchesQuery,
  meetsStandard,
  missingStandard,
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
