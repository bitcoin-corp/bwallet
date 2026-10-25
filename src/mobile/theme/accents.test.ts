import { describe, expect, test } from 'bun:test';
import {
  ACCENTS,
  DUO_PACKS,
  EDITION_PACKS,
  MONO_PACKS,
  RETIRED_PACKS,
  TRI_PACKS,
  THEMES,
  accentById,
  accentVars,
  contrast,
  packVars,
  rgbTriplet,
} from './accents';
import { EMOJI_PACK_IDS, EMOJI_THEMES, isEmojiPack } from './emojiThemes';

describe('app accents and packs', () => {
  test('gold is first and the default', () => {
    expect(ACCENTS[0]?.id).toBe('gold');
    expect(ACCENTS[0]?.label).toBe('Gold');
    expect(accentById('nope').id).toBe('gold');
    expect(accentById(null).id).toBe('gold');
    expect(accentById('custom').id).toBe('gold'); // no mix primed yet
  });
  test('at least 8 full packs', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(8);
    for (const id of ['gold', 'executive', 'cyber', 'midnight', 'forest', 'sunset', 'contrast', 'white', 'blue'])
      expect(THEMES.some((t) => t.id === id)).toBe(true);
  });
  test('every pack passes WCAG AA: text, muted and accent on page and surfaces; on-accent on the accent', () => {
    for (const a of ACCENTS) {
      for (const g of [a.bg, a.surface]) {
        expect(contrast(a.text, g)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(a.muted, g)).toBeGreaterThanOrEqual(4.5);
        for (const c of [a.accent, a.hi, a.lo]) expect(contrast(c, g)).toBeGreaterThanOrEqual(4.5);
      }
      for (const c of [a.accent, a.hi, a.lo]) expect(contrast(a.on, c)).toBeGreaterThanOrEqual(4.5);
    }
  });
  test('gold matches the existing tokens (src/accent.css)', () => {
    const v = accentVars(accentById('gold'));
    expect(v['--bw-accent']).toBe('#F5B800');
    expect(v['--bw-accent-hi']).toBe('#FFD24D');
    expect(v['--bw-accent-lo']).toBe('#EAB300');
    expect(rgbTriplet('#F5B800')).toBe('245 184 0');
  });
});

test('no accent uses a colour the bcorp build rewrites', () => {
  for (const a of ACCENTS)
    for (const c of [a.accent, a.hi, a.lo, a.on, a.success, a.text, a.muted, a.bg, a.surface, a.line])
      expect(/A1FF8B|9EFF8A|34D399/i.test(c)).toBe(false);
});

test('every pack maps to a complete variable set', () => {
  const keys = Object.keys(packVars(accentById('gold'))).sort();
  expect(keys).toContain('--bw-text');
  expect(keys).toContain('--bw-line');
  for (const a of ACCENTS) {
    const v = packVars(a);
    expect(Object.keys(v).sort()).toEqual(keys);
    for (const val of Object.values(v)) expect(val.length).toBeGreaterThan(0);
  }
});

test('Mono, Duo and Tri groups: Mono is one hue on white with no dark grounds', () => {
  expect(MONO_PACKS.map((t) => t.id)).toEqual([
    'white',
    'pink',
    'blue',
    'yellow',
    'green',
    'purple',
    'orange',
    'red',
    'teal',
  ]);
  expect(DUO_PACKS[0]?.id).toBe('gold');
  expect(DUO_PACKS.map((t) => t.id)).toEqual(
    expect.arrayContaining(['executive', 'blackwhite', 'whiteblack', 'cyber']),
  );
  expect(TRI_PACKS.length).toBeGreaterThanOrEqual(3);
  expect(MONO_PACKS.length + DUO_PACKS.length + TRI_PACKS.length + EDITION_PACKS.length).toBe(THEMES.length);
  expect(accentById('white').bg).toBe('#FFFFFF');
  for (const a of MONO_PACKS) {
    expect(a.scheme).toBe('light');
    if (!a.paper) expect(a.surface).toBe('#FFFFFF');
    expect(a.nav).toBe(a.paper ? a.bg : '#FFFFFF');
    // Every ground (page, surfaces, button tint) is light: no dark elements (paper stock is coloured, still light).
    for (const g of [a.bg, a.surface, a.surface2, a.tint as string])
      expect(contrast(g, '#000000')).toBeGreaterThan(a.paper ? 9 : 15);
    // AA everywhere: text, muted and every accent stop on page, surfaces and tint (buttons are accent on tint).
    for (const g of [a.bg, a.surface, a.surface2, a.tint as string]) {
      expect(contrast(a.text, g)).toBeGreaterThanOrEqual(7);
      expect(contrast(a.muted, g)).toBeGreaterThanOrEqual(4.5);
      for (const c of [a.accent, a.hi, a.lo, a.success, a.danger]) expect(contrast(c, g)).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('every pack passes AA on its second surface too', () => {
  for (const a of THEMES) {
    expect(contrast(a.text, a.surface2)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(a.muted, a.surface2)).toBeGreaterThanOrEqual(4.5);
  }
});

test('retired packs fall back to the closest new pack', () => {
  expect(RETIRED_PACKS).toEqual({ paper: 'white', monolight: 'white', black: 'blackwhite' });
  for (const [old, now] of Object.entries(RETIRED_PACKS)) {
    expect(THEMES.some((t) => t.id === old)).toBe(false);
    expect(accentById(old).id).toBe(now);
  }
});

describe('paper packs (Pink, Blue, Yellow)', () => {
  test('solid coloured page, cards and buttons in shades of the paper, near-black ink, AA everywhere', () => {
    for (const [id, bg] of [
      ['pink', '#F4A7C0'],
      ['blue', '#8EC5F0'],
      ['yellow', '#F7DA4A'],
    ] as const) {
      const a = accentById(id);
      expect(a.paper).toBe(true);
      expect(a.bg).toBe(bg);
      expect(a.surface).not.toBe('#FFFFFF');
      expect(a.tint).not.toBe('#FFFFFF');
      expect(a.on).toBe(bg);
      expect(a.text).toBe('#111111');
      expect(a.accent).toBe('#111111');
      expect(a.line).toBe('#111111');
      for (const g of [a.bg, a.surface, a.surface2, a.tint as string]) {
        expect(contrast(a.text, g)).toBeGreaterThanOrEqual(7);
        expect(contrast(a.muted, g)).toBeGreaterThanOrEqual(4.5);
      }
      expect(a.pattern).toMatch(/^(grid|field|bauhaus|lines|fold|brush|paper|squares|arcs|dotgrid|horizon|contour)$/);
    }
  });
});

describe('artist editions', () => {
  test('VexVoid, NPG, NPGX and Scammers Cartel: dark, credited, no gold, AA ink on paper', () => {
    expect(EDITION_PACKS.map((a) => a.id)).toEqual([
      'vexvoid',
      'npg',
      'npgx',
      'scammerscartel',
      'leannethedark',
      'tokenblaster',
      'terrornode',
      ...EMOJI_PACK_IDS,
    ]);
    const credits = {
      vexvoid: 'VexVoid edition',
      npg: 'Ninja Punk Girls edition',
      npgx: 'NPGX edition',
      scammerscartel: 'Scammers Cartel edition',
      leannethedark: 'Leanne The Dark edition',
      tokenblaster: 'TokenBlaster edition',
      terrornode: 'TokenBlaster edition',
    };
    // TokenBlaster's packs keep the near-black page from their own theme files (tokenblaster.lol/.well-known).
    const ownBg: Record<string, string> = { tokenblaster: '#0A0A0C', terrornode: '#05090F', leannethedark: '#050102' };
    for (const a of EDITION_PACKS.filter((x) => !isEmojiPack(x.id))) {
      expect(a.edition).toBe(credits[a.id as keyof typeof credits]);
      expect(a.scheme).toBe('dark');
      expect(a.bg).toBe(ownBg[a.id] ?? '#000000');
      for (const g of [a.bg, a.surface, a.surface2]) {
        expect(contrast(a.text, g)).toBeGreaterThanOrEqual(7);
        expect(contrast(a.muted, g)).toBeGreaterThanOrEqual(4.5);
        for (const c of [a.accent, a.hi, a.lo, a.success, a.danger]) expect(contrast(c, g)).toBeGreaterThanOrEqual(4.5);
      }
      for (const v of Object.values(packVars(a))) expect(/F5B800|FFD24D|EAB300/i.test(v)).toBe(false);
    }
    expect(accentById('vexvoid').accent).toBe('#FFFFFF');
    expect(accentById('vexvoid').pattern).toBe('vexfield');
    expect(accentById('npg').pattern).toBe('npg');
    expect(accentById('npg').glow).not.toBe('none');
    expect(accentById('npgx').pattern).toBe('npgx');
    // NPGX is black and red: no green, magenta or cyan.
    expect(accentById('npgx').accent).toBe('#FF2D3A');
    for (const v of Object.values(packVars(accentById('npgx'))))
      expect(/C6FF1A|FF2BD6|00F0FF|0 240 255|255 43 214/i.test(v)).toBe(false);
    // TokenBlaster: accent colours straight from its theme files.
    expect(accentById('tokenblaster').accent).toBe('#FF3B30');
    expect(accentById('tokenblaster').hi).toBe('#FFB800');
    expect(accentById('terrornode').accent).toBe('#FF3B3B');
    expect(accentById('terrornode').hi).toBe('#3FD8E8');
  });
});

describe('emoji themes', () => {
  test('twelve dark packs in the Emoji collection, AA everywhere, each its own accent and art', () => {
    expect(EMOJI_THEMES.length).toBe(12);
    const accents = new Set<string>();
    for (const e of EMOJI_THEMES) {
      const a = accentById(e.id);
      expect(a.id).toBe(e.id);
      expect(a.group).toBe('edition');
      expect(a.edition).toBe('Emoji collection');
      expect(a.scheme).toBe('dark');
      expect(a.pattern).toBe(e.id);
      accents.add(a.accent);
      for (const g of [a.bg, a.surface, a.surface2]) {
        expect(contrast(a.text, g)).toBeGreaterThanOrEqual(7);
        expect(contrast(a.muted, g)).toBeGreaterThanOrEqual(4.5);
        for (const c of [a.accent, a.hi, a.lo, a.success, a.danger]) expect(contrast(c, g)).toBeGreaterThanOrEqual(4.5);
      }
      for (const c of [a.accent, a.hi, a.lo]) expect(contrast(a.on, c)).toBeGreaterThanOrEqual(4.5);
      // Not the default gold: the emoji's own colour.
      for (const v of Object.values(packVars(a))) expect(/F5B800|FFD24D|EAB300/i.test(v)).toBe(false);
    }
    expect(accents.size).toBe(12);
    // Crypto clichés stay out (owner brief, 18 Oct 2026).
    for (const bad of ['rocket', 'gem', 'diamond', 'money', 'chart'])
      expect(EMOJI_THEMES.some((e) => e.id.includes(bad))).toBe(false);
  });
});

test('Pink, Blue and Yellow paper packs resolve no surface token to white', () => {
  const isWhite = (v: string) => /^#(f{3}|f{6})$/i.test(v.trim()) || /^white$/i.test(v.trim());
  for (const id of ['pink', 'blue', 'yellow'] as const) {
    const a = accentById(id);
    expect(a.paper).toBe(true);
    for (const k of ['bg', 'surface', 'surface2', 'tint', 'nav'] as const) {
      expect(isWhite(String(a[k])), `${id}.${k} = ${a[k]}`).toBe(false);
    }
    expect(a.text).toBe('#111111');
    expect(a.accent).toBe('#111111');
  }
});
