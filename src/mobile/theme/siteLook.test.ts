import { describe, expect, test } from 'bun:test';
import { contrast } from './colour';
import { parseConnectTheme, type WornTheme } from './connectSiteTheme';
import { siteLookAccent } from './siteLook';
import { currentAccentId, wearSiteLook, wearingSiteLook } from './accent';
import { accentById } from './accents';

const worn = (v: Record<string, unknown>): WornTheme => {
  const p = parseConnectTheme(v, 'https://shop.example');
  if (!p.theme) throw new Error('bad');
  return { ...p.theme, origin: 'https://shop.example' };
};

describe('siteLookAccent', () => {
  const dark = worn({
    v: 2,
    name: 'Ember',
    mode: 'dark',
    accent: '#E8B04A',
    bg: '#0F2A1F',
    surface: '#173A2C',
    text: '#F5EBDD',
  });
  const light = worn({
    v: 2,
    name: 'Paper',
    mode: 'light',
    accent: '#B4261A',
    bg: '#FFFFFF',
    surface: '#F6F6F6',
    text: '#111111',
  });
  test('keeps the validated colours and stays readable', () => {
    for (const t of [dark, light]) {
      const a = siteLookAccent(t);
      expect(a.bg).toBe(t.bg);
      expect(a.accent).toBe(t.accent);
      expect(a.scheme).toBe(t.mode);
      for (const g of [a.bg, a.surface, a.surface2]) {
        expect(contrast(a.text, g)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(a.muted, g)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  test('worn over the view and put back', () => {
    const before = currentAccentId();
    wearSiteLook(siteLookAccent(dark));
    expect(wearingSiteLook()).toBe(true);
    expect(accentById('custom').label).toBe('Ember');
    wearSiteLook(null);
    expect(wearingSiteLook()).toBe(false);
    expect(currentAccentId()).toBe(before);
  });
});
