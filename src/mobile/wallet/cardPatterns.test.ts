import { describe, expect, test } from 'bun:test';
import { PATTERNS, patternSvg, patternUri } from './cardPatterns';
import { THEMES, accentById } from '../theme/accents';
import { editionArtUri, isEditionPattern, vexFieldSvg } from './cardPatternsEdition';

describe('card patterns', () => {
  test('every pattern is valid, card-sized SVG with no NaN and no external refs', () => {
    expect(PATTERNS.length).toBeGreaterThanOrEqual(8);
    for (const p of PATTERNS) {
      const svg = patternSvg(p.id, '#F5B800');
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1011" height="637"')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).not.toContain('NaN');
      expect(svg).not.toMatch(/href=|url\((?!#)/);
      expect(svg.length).toBeGreaterThan(300);
    }
  });
  test('follows the accent colour it is given', () => {
    const violet = accentById('violet').accent;
    for (const p of PATTERNS) expect(patternSvg(p.id, violet)).toContain(violet);
    expect(patternUri('hex', violet)).toContain(encodeURIComponent(violet));
  });
  test('each theme suggests a real pattern', () => {
    for (const t of THEMES) expect(PATTERNS.some((p) => p.id === t.pattern) || isEditionPattern(t.pattern)).toBe(true);
  });
});

describe('edition card art', () => {
  test('VexVoid still: white points on true black, small, no NaN', () => {
    for (const v of [0, 1, 2]) {
      const svg = vexFieldSvg(v);
      expect(svg).toContain('fill="#000000"');
      expect(svg).toContain('stroke="#FFFFFF"');
      expect(svg).not.toContain('NaN');
      expect(svg.length).toBeGreaterThan(5_000);
      expect(svg.length).toBeLessThan(80_000);
    }
    expect(patternUri('vexfield', '#fff', 'a')).toStartWith('data:image/svg+xml');
  });
  test('NPG and NPGX use bundled art, steady per card', () => {
    expect(editionArtUri('npg', 'card-1')).toBe(editionArtUri('npg', 'card-1'));
    expect(String(editionArtUri('npg', 'x'))).toMatch(/npg-card-/);
    expect(String(editionArtUri('npgx', 'x'))).toMatch(/npgx-card-/);
    expect(String(editionArtUri('tokenblaster', 'x'))).toMatch(/tokenblaster-main-card/);
    expect(String(editionArtUri('terrornode', 'x'))).toMatch(/tokenblaster-assault-card/);
  });
  test('edition art files stay under 120 KB', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const dir = new URL('./editionArt/', import.meta.url).pathname;
    const files = readdirSync(dir);
    expect(files.length).toBe(8); // NPG logo card + 2 NPGX + Scammers Cartel card and shop banner + TokenBlaster 2 cards + logo
    for (const f of files) expect(statSync(dir + f).size).toBeLessThan(120_000);
  });
});
