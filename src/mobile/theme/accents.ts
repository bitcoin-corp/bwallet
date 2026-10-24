import { contrast, ensureContrast, hexToHsl, hslToHex, mix, pickReadable, rgbTriplet } from './colour';
import { EMOJI_PACK_IDS, EMOJI_THEMES, type EmojiPackId, type EmojiTheme } from './emojiThemes';

export { contrast, rgbTriplet };

/**
 * App themes (Theme → App colours). Owner, 14–15 Oct 2026: first a short accent list, then "a bit lame", then
 * "just a few pastel button colours": so the top row is now THEME PACKS that restyle the whole app (page,
 * surfaces, text, muted text, lines, nav, inputs, buttons, accent, success/danger, shadows, corners, heading
 * weight), each a complete token set written to CSS variables on <html> plus <html data-bw-theme / data-bw-pack>.
 * No forked components: every screen reads the same variables (src/themes.css maps the common utility classes).
 * Gold sets nothing, so the default look is byte-for-byte the one before packs. The plain accents stay under
 * "More colours" and change the accent only. The colour mixer (mixer.ts) derives a 'custom' pack at runtime.
 * Every pack keeps WCAG AA (accents.test.ts): text, muted text and accent on page and surfaces, and on-accent on
 * the accent stops, all at least 4.5:1.
 */
export type PackId =
  | 'gold'
  | 'executive'
  | 'cyber'
  | 'midnight'
  | 'forest'
  | 'sunset'
  | 'contrast'
  | 'pastel'
  | 'nautical'
  | 'white'
  | 'blackwhite'
  | 'whiteblack'
  | 'blue'
  | 'red'
  | 'green'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'teal'
  | 'yellow'
  | 'vexvoid'
  | 'npg'
  | 'npgx'
  | 'scammerscartel'
  | EmojiPackId;
export type AccentId = PackId | 'silver' | 'rose' | 'emerald' | 'sapphire' | 'violet' | 'custom';

export type CardPatternId =
  | 'topo'
  | 'guilloche'
  | 'cypher'
  | 'clouds'
  | 'waves'
  | 'hex'
  | 'stripes'
  | 'halftone'
  | 'circuit'
  | 'chevron'
  | 'starburst'
  | 'grid'
  | 'field'
  | 'bauhaus'
  | 'lines'
  | 'fold'
  | 'brush'
  | 'paper'
  | 'squares'
  | 'arcs'
  | 'dotgrid'
  | 'horizon'
  | 'contour'
  | 'vexfield'
  | 'npg'
  | 'npgx'
  | 'scammerscartel'
  | EmojiPackId;

export interface Accent {
  id: AccentId;
  label: string;
  /** 'theme' = a full pack (top row); 'colour' = accent only (More colours); 'custom' = the colour mixer. */
  kind: 'theme' | 'colour' | 'custom';
  /** Packs only: 'mono' = one hue on white; 'duo' = two-colour packs; 'tri' = three-colour palettes. */
  group?: 'mono' | 'duo' | 'tri' | 'edition';
  /** Edition packs: the artist credit shown in Theme (e.g. "VexVoid edition"). */
  edition?: string;
  /** Mono packs on coloured paper stock (Pink, Blue, Yellow): page, cards and buttons are all shades of the colour. */
  paper?: boolean;
  /** Mono packs: the light hue tint behind buttons, selected tabs and chips (defaults to surface2). */
  tint?: string;
  /** One line under the pack's name. */
  blurb?: string;
  /** Light or dark base (sets color-scheme for form controls and scrollbars). */
  scheme: 'dark' | 'light';
  /** Main accent: buttons, active tabs, icons. */
  accent: string;
  /** Lighter stop: gradient tops, bright text, hover. */
  hi: string;
  /** Deeper stop: gradient bottoms. */
  lo: string;
  /** Text on the accent. */
  on: string;
  /** Page background. */
  bg: string;
  /** Raised surfaces: sheets, rows, cards, inputs. */
  surface: string;
  /** Second surface: hover, chips, nested fills. */
  surface2: string;
  /** Tab bar and top bars. */
  nav: string;
  /** Body text. */
  text: string;
  /** Secondary text. */
  muted: string;
  /** Hairlines and outlines. */
  line: string;
  success: string;
  danger: string;
  /** Shadow under raised things. */
  shadow: string;
  /** Border on cards and buttons ('transparent' = none). */
  trim: string;
  /** Extra glow on accent buttons ('none' = none). */
  glow: string;
  /** Font for amounts and labels. */
  fontNum: string;
  /** Font for headings. */
  fontHead: string;
  /** Heading weight. */
  weightHead: number;
  /** Corner radius of buttons. */
  radius: string;
  /** Corner radius of cards and sheets. */
  radiusCard: string;
  /** The card pattern this pack suggests (Design your card › Patterns). */
  pattern: CardPatternId;
}

export const DEFAULT_ACCENT: AccentId = 'gold';

const SANS = 'inherit';
const MONO = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const SERIF = "'Cormorant Garamond', 'Iowan Old Style', Georgia, 'Times New Roman', serif";
/** The Gold look (today's app), the base every pack starts from. */
const BASE: Omit<Accent, 'id' | 'label' | 'accent' | 'hi' | 'lo'> = {
  kind: 'colour',
  scheme: 'dark',
  on: '#010101',
  bg: '#010101',
  surface: '#17191E',
  surface2: '#1F2128',
  nav: '#000000',
  text: '#FFFFFF',
  muted: '#98A2B3',
  line: '#2B2F36',
  success: '#3DDC97',
  danger: '#F97066',
  shadow: '0 10px 30px rgb(0 0 0 / 0.5)',
  trim: 'transparent',
  glow: 'none',
  fontNum: SANS,
  fontHead: SANS,
  weightHead: 700,
  radius: '12px',
  radiusCard: '16px',
  pattern: 'topo',
};

/**
 * MONO (owner, 15 Oct 2026: "a fully white mono-tone theme with NO dark elements"): one hue on white. Page
 * white or near-white, surfaces white, the balance cards white with a faint hue pattern, buttons a light hue
 * tint with hue ink and a hairline (themes.css, [data-bw-tone='mono']). Text, muted text and the accent stops are
 * derived with ensureContrast so each pack passes AA on the page, the surfaces and the tint by construction
 * (accents.test.ts checks it again).
 */
function mono(id: PackId, label: string, blurb: string, h: number, s: number, pattern: CardPatternId): Accent {
  const bg = s ? hslToHex({ h, s: s * 0.5, l: 98.5 }) : '#FFFFFF';
  const surface = '#FFFFFF';
  const surface2 = hslToHex({ h, s: s * 0.6, l: 97 });
  const tint = hslToHex({ h, s: Math.min(s, 90), l: 94 });
  const grounds = [bg, surface, surface2, tint];
  const accent = ensureContrast(hslToHex({ h, s, l: 45 }), grounds, 4.5);
  const hi = ensureContrast(hslToHex({ h, s, l: 42 }), grounds, 4.5);
  const lo = ensureContrast(hslToHex({ h, s, l: 36 }), grounds, 4.5);
  return {
    ...BASE,
    id,
    kind: 'theme',
    group: 'mono',
    label,
    blurb,
    scheme: 'light',
    accent,
    hi,
    lo,
    on: pickReadable(['#FFFFFF', '#000000'], [accent, hi, lo]),
    bg,
    surface,
    surface2,
    tint,
    nav: '#FFFFFF',
    text: ensureContrast(hslToHex({ h, s: s * 0.4, l: 12 }), grounds, 7),
    muted: ensureContrast(hslToHex({ h, s: s * 0.25, l: 42 }), grounds, 4.5),
    line: hslToHex({ h, s: s * 0.5, l: 90 }),
    success: ensureContrast('#15803D', grounds, 4.5),
    danger: ensureContrast('#B91C1C', grounds, 4.5),
    shadow: '0 1px 2px rgb(0 0 0 / 0.04), 0 6px 18px rgb(0 0 0 / 0.06)',
    trim: s ? `hsl(${h} ${s}% 40% / 0.22)` : 'rgb(0 0 0 / 0.1)',
    pattern,
  };
}

/**
 * White (owner, 16 Oct 2026: "WHITE … no grey fills"): black ink instead of grey. Accent fills are solid black with
 * white text; the Mono tint buttons become white with a black outline; selected tabs read black.
 */
const WHITE: Accent = {
  ...mono('white', 'White', 'All white, black ink', 220, 0, 'grid'),
  accent: '#000000',
  hi: '#1A1A1A',
  lo: '#000000',
  on: '#FFFFFF',
  // Light grey buttons with black ink (owner preferred them to dark grey, 16 Oct 2026).
  tint: '#F2F2F2',
  surface2: '#F5F5F5',
  text: '#0A0A0A',
  muted: '#595959',
  line: '#E3E3E3',
  trim: 'rgb(0 0 0 / 0.35)',
};

/**
 * Paper stock (owner, 16 Oct 2026): the whole page is a solid colour, like coloured paper; ink is near-black, cards
 * and buttons are the same paper (shades of it) with black hairlines (themes.css Mono rules), card art is the White designs. They
 * replace the old one-hue Pink and Blue tints (same ids, so saved choices carry over).
 */
function paperPack(id: PackId, label: string, blurb: string, bg: string, pattern: CardPatternId): Accent {
  // Owner, 16 Oct 2026: never white surfaces on paper. White's structure with the paper replacing white: cards and
  // sheets a touch lighter than the page, inset fills and tint buttons a touch darker, #111 ink and hairlines.
  const p = hexToHsl(bg);
  const shade = (dl: number) => hslToHex({ ...p, l: p.l + dl });
  return {
    ...WHITE,
    id,
    label,
    blurb,
    paper: true,
    bg,
    nav: bg,
    surface: shade(6),
    surface2: shade(-4),
    tint: shade(-6),
    accent: '#111111',
    hi: '#111111',
    lo: '#000000',
    on: bg,
    text: '#111111',
    muted: '#3D3D3D',
    line: '#111111',
    trim: '#111111',
    success: '#06401C',
    danger: '#6E0B0B',
    pattern,
  };
}

const MONO_TONES: readonly Accent[] = [
  WHITE,
  paperPack('pink', 'Pink', 'Pink paper, black ink', '#F4A7C0', 'arcs'),
  paperPack('blue', 'Blue', 'Blue paper, black ink', '#8EC5F0', 'lines'),
  paperPack('yellow', 'Yellow', 'Yellow paper, black ink', '#F7DA4A', 'bauhaus'),
  mono('green', 'Green', 'White and green', 150, 55, 'hex'),
  mono('purple', 'Purple', 'White and purple', 270, 60, 'clouds'),
  mono('orange', 'Orange', 'White and orange', 24, 85, 'chevron'),
  mono('red', 'Red', 'White and red', 356, 70, 'starburst'),
  mono('teal', 'Teal', 'White and teal', 178, 65, 'topo'),
];

/**
 * Artist editions (owner, 16 Oct 2026): VexVoid, Ninja Punk Girls and NPGX. Dark packs with their own card art
 * (cardPatternsEdition.ts: a still VexVoid point field, official NPG art, the official NPGX red X logo) and a credit in Theme.
 * No gold anywhere. The owner's own art, so they ship in every build (store included).
 */
const EDITIONS: readonly Accent[] = [
  {
    ...BASE,
    id: 'vexvoid',
    kind: 'theme',
    group: 'edition',
    edition: 'VexVoid edition',
    label: 'VexVoid',
    blurb: 'White ink on true black',
    accent: '#FFFFFF',
    hi: '#FFFFFF',
    lo: '#E6E6E6',
    on: '#000000',
    bg: '#000000',
    surface: '#000000',
    surface2: '#0D0D0D',
    nav: '#000000',
    text: '#FFFFFF',
    muted: '#B3B3B3',
    line: '#5C5C5C',
    success: '#E6E6E6',
    danger: '#FF8A80',
    shadow: 'none',
    trim: 'rgb(255 255 255 / 0.7)',
    glow: 'none',
    fontNum: MONO,
    fontHead: MONO,
    weightHead: 500,
    radius: '0px',
    radiusCard: '2px',
    pattern: 'vexfield',
  },
  {
    ...BASE,
    id: 'npg',
    kind: 'theme',
    group: 'edition',
    edition: 'Ninja Punk Girls edition',
    label: 'Ninja Punk Girls',
    blurb: 'Hot pink neon on black',
    accent: '#FF2E93',
    hi: '#FF6BB5',
    lo: '#F2167F',
    on: '#000000',
    bg: '#000000',
    surface: '#12060D',
    surface2: '#1C0A15',
    nav: '#000000',
    text: '#FFFFFF',
    muted: '#E0B3CB',
    line: '#4A1834',
    success: '#7CFFB2',
    danger: '#FF8A80',
    shadow: '0 0 24px rgb(255 46 147 / 0.18)',
    trim: 'rgb(255 46 147 / 0.65)',
    glow: '0 0 16px rgb(255 46 147 / 0.65), 0 0 3px rgb(255 46 147 / 0.95)',
    weightHead: 800,
    radius: '8px',
    radiusCard: '12px',
    pattern: 'npg',
  },
  {
    ...BASE,
    id: 'npgx',
    kind: 'theme',
    group: 'edition',
    edition: 'NPGX edition',
    label: 'NPGX',
    blurb: 'Black and red',
    accent: '#FF2D3A',
    hi: '#FF5A63',
    lo: '#F0202E',
    on: '#000000',
    bg: '#000000',
    surface: '#0D0506',
    surface2: '#170809',
    nav: '#000000',
    text: '#FFFFFF',
    muted: '#C9C9C9',
    line: '#5A1A1E',
    success: '#7EE2A8',
    danger: '#FF8A80',
    shadow: '0 0 24px rgb(255 45 58 / 0.15)',
    trim: 'rgb(255 45 58 / 0.7)',
    glow: '0 0 16px rgb(255 45 58 / 0.65), 0 0 3px rgb(255 45 58 / 0.95)',
    fontNum: MONO,
    fontHead: MONO,
    weightHead: 800,
    radius: '2px',
    radiusCard: '4px',
    pattern: 'npgx',
  },
  {
    // ScammersCartel (owner, 18 Oct 2026): the first community on bChatX. The name is an in-joke, so the pack is too:
    // yellow and orange glow on black, with the community's own DJ raccoon banner on the card.
    ...BASE,
    id: 'scammerscartel',
    kind: 'theme',
    group: 'edition',
    edition: 'Scammers Cartel edition',
    label: 'Scammers Cartel',
    blurb: 'The DJ raccoon: yellow glow on black',
    accent: '#FFC400',
    hi: '#FFD84D',
    lo: '#F0A800',
    on: '#000000',
    bg: '#000000',
    surface: '#110A03',
    surface2: '#1C1105',
    nav: '#000000',
    text: '#FFFFFF',
    muted: '#D9C3A0',
    line: '#4D3208',
    success: '#7CFFB2',
    danger: '#FF8A65',
    shadow: '0 0 24px rgb(255 140 0 / 0.18)',
    trim: 'rgb(255 196 0 / 0.6)',
    glow: '0 0 16px rgb(255 140 0 / 0.55), 0 0 3px rgb(255 196 0 / 0.9)',
    weightHead: 800,
    radius: '10px',
    radiusCard: '14px',
    pattern: 'scammerscartel',
  },
];

/** Duo cross-overs: black surfaces with a white accent, and the reverse. Square-ish and stark. */
const CROSS_OVERS: readonly Accent[] = [
  {
    ...BASE,
    id: 'blackwhite',
    kind: 'theme',
    group: 'duo',
    label: 'Black/White',
    blurb: 'Black, white buttons',
    accent: '#FFFFFF',
    hi: '#FFFFFF',
    lo: '#EDEDED',
    on: '#000000',
    bg: '#000000',
    surface: '#0B0B0B',
    surface2: '#161616',
    nav: '#000000',
    text: '#FFFFFF',
    muted: '#B3B3B3',
    line: '#2A2A2A',
    success: '#7EE2A8',
    danger: '#FF8A80',
    shadow: 'none',
    trim: 'rgb(255 255 255 / 0.2)',
    radius: '6px',
    radiusCard: '8px',
    pattern: 'stripes',
  },
  {
    ...BASE,
    id: 'whiteblack',
    kind: 'theme',
    group: 'duo',
    label: 'White/Black',
    blurb: 'White, black buttons',
    scheme: 'light',
    accent: '#000000',
    hi: '#262626',
    lo: '#000000',
    on: '#FFFFFF',
    bg: '#FFFFFF',
    surface: '#F7F7F7',
    surface2: '#EEEEEE',
    nav: '#FFFFFF',
    text: '#0A0A0A',
    muted: '#5C5C5C',
    line: '#DEDEDE',
    success: '#15803D',
    danger: '#B91C1C',
    shadow: '0 4px 16px rgb(0 0 0 / 0.08)',
    trim: 'rgb(0 0 0 / 0.14)',
    radius: '6px',
    radiusCard: '8px',
    pattern: 'stripes',
  },
];

/**
 * Emoji themes (owner, 18 Oct 2026; emojiThemes.ts): twelve $1 Store packs, each the emoji's colour on a dark ground
 * tinted by it, with Twemoji card art (cardPatternsEmoji.ts). Sold like the editions (group 'edition', credit
 * "Emoji collection"), so owning, applying and the card art follow the same paths. Every stop is pushed to AA by
 * ensureContrast, so each pack passes by construction (accents.test.ts checks again).
 */
function emojiPack(e: EmojiTheme): Accent {
  const bg = e.bg;
  const surface = mix(bg, e.accent, 0.08);
  const surface2 = mix(bg, e.accent, 0.14);
  const grounds = [bg, surface, surface2];
  const accent = ensureContrast(e.accent, grounds, 4.5);
  const hi = ensureContrast(mix(accent, '#FFFFFF', 0.3), grounds, 4.5);
  const lo = ensureContrast(mix(accent, '#000000', 0.1), grounds, 4.5);
  const rgb = rgbTriplet(accent);
  return {
    ...BASE,
    id: e.id,
    kind: 'theme',
    group: 'edition',
    edition: 'Emoji collection',
    label: e.label,
    blurb: e.blurb,
    accent,
    hi,
    lo,
    on: pickReadable([bg, '#000000', '#FFFFFF'], [accent, hi, lo]),
    bg,
    surface,
    surface2,
    nav: bg,
    text: '#FFFFFF',
    muted: ensureContrast(mix('#C8CCD4', accent, 0.3), grounds, 4.5),
    line: mix(bg, accent, 0.3),
    shadow: `0 0 24px rgb(${rgb} / 0.14)`,
    trim: `rgb(${rgb} / 0.45)`,
    weightHead: 800,
    radius: '14px',
    radiusCard: '18px',
    pattern: e.id,
  };
}
const EMOJI_PACKS: readonly Accent[] = EMOJI_THEMES.map(emojiPack);

// Never use upstream's greens (#A1FF8B, #9EFF8A, #34D399) here: vite.brand.ts bcorpColours rewrites them to
// the accent variables at build time, which would make an accent point at itself.
export const ACCENTS: readonly Accent[] = [
  {
    ...BASE,
    id: 'gold',
    kind: 'theme',
    group: 'duo',
    label: 'Gold',
    blurb: 'Black and gold, the original',
    accent: '#F5B800',
    hi: '#FFD24D',
    lo: '#EAB300',
  },
  ...MONO_TONES,
  ...CROSS_OVERS,
  ...EDITIONS,
  ...EMOJI_PACKS,
  {
    ...BASE,
    id: 'executive',
    kind: 'theme',
    group: 'duo',
    label: 'Executive',
    blurb: 'Crisp black and white',
    accent: '#FFFFFF',
    hi: '#FFFFFF',
    lo: '#E4E4E4',
    on: '#000000',
    bg: '#000000',
    surface: '#0E0E0E',
    surface2: '#191919',
    nav: '#000000',
    text: '#FFFFFF',
    muted: '#A3A3A3',
    line: '#2E2E2E',
    success: '#7EE2A8',
    danger: '#FF8A80',
    shadow: 'none',
    trim: 'rgb(255 255 255 / 0.28)',
    fontNum: MONO,
    weightHead: 600,
    radius: '2px',
    radiusCard: '4px',
    pattern: 'guilloche',
  },
  {
    ...BASE,
    id: 'cyber',
    kind: 'theme',
    group: 'duo',
    label: 'Cyberpunk',
    blurb: 'Neon magenta and cyan',
    accent: '#FF2BD6',
    hi: '#FF8AEB',
    lo: '#F000C8',
    on: '#07040F',
    bg: '#07040F',
    surface: '#130A24',
    surface2: '#1D0F35',
    nav: '#05020B',
    text: '#F5F0FF',
    muted: '#A99BD1',
    line: '#3B2163',
    success: '#3DF5FF',
    danger: '#FF5C7A',
    shadow: '0 0 24px rgb(255 43 214 / 0.18)',
    trim: 'rgb(0 240 255 / 0.55)',
    glow: '0 0 14px rgb(255 43 214 / 0.55), 0 0 2px rgb(0 240 255 / 0.9)',
    fontNum: MONO,
    fontHead: MONO,
    weightHead: 700,
    radius: '3px',
    radiusCard: '6px',
    pattern: 'circuit',
  },
  {
    ...BASE,
    id: 'midnight',
    kind: 'theme',
    group: 'duo',
    label: 'Midnight',
    blurb: 'Deep navy, cool blue',
    accent: '#6EA8FF',
    hi: '#A5C8FF',
    lo: '#5B9BFA',
    on: '#060B1A',
    bg: '#060B1A',
    surface: '#0E1730',
    surface2: '#16213F',
    nav: '#050916',
    text: '#E8EEFF',
    muted: '#93A3C8',
    line: '#22325A',
    success: '#5EE6B0',
    danger: '#FF8A8A',
    shadow: '0 12px 32px rgb(0 0 0 / 0.55)',
    trim: 'rgb(110 168 255 / 0.25)',
    pattern: 'topo',
  },
  {
    ...BASE,
    id: 'forest',
    kind: 'theme',
    group: 'duo',
    label: 'Forest',
    blurb: 'Pine, moss and fern',
    accent: '#8FD19E',
    hi: '#B9E6C3',
    lo: '#7CC48D',
    on: '#07110C',
    bg: '#07110C',
    surface: '#0F1E16',
    surface2: '#17291F',
    nav: '#050D09',
    text: '#EAF4EC',
    muted: '#9DB5A5',
    line: '#24392C',
    success: '#8FD19E',
    danger: '#FF8F7A',
    shadow: '0 12px 30px rgb(0 0 0 / 0.5)',
    trim: 'rgb(143 209 158 / 0.22)',
    radiusCard: '18px',
    pattern: 'hex',
  },
  {
    ...BASE,
    id: 'sunset',
    kind: 'theme',
    group: 'tri',
    label: 'Sunset',
    blurb: 'Coral, plum and amber',
    accent: '#FF8A5B',
    hi: '#FFB38A',
    lo: '#FF7A5C',
    on: '#1A0B12',
    bg: '#1A0B12',
    surface: '#2A1220',
    surface2: '#36182A',
    nav: '#140810',
    text: '#FFF1EA',
    muted: '#D9AFA9',
    line: '#4A2235',
    success: '#7FE0B0',
    danger: '#FF8080',
    shadow: '0 12px 32px rgb(40 0 20 / 0.5)',
    trim: 'rgb(255 138 91 / 0.28)',
    glow: '0 6px 20px rgb(255 120 80 / 0.35)',
    radius: '999px',
    radiusCard: '20px',
    pattern: 'starburst',
  },
  {
    ...BASE,
    id: 'contrast',
    kind: 'theme',
    group: 'duo',
    label: 'High contrast',
    blurb: 'Maximum legibility',
    accent: '#FFE600',
    hi: '#FFF27A',
    lo: '#FFD600',
    on: '#000000',
    bg: '#000000',
    surface: '#000000',
    surface2: '#1A1A1A',
    nav: '#000000',
    text: '#FFFFFF',
    muted: '#E6E6E6',
    line: '#FFFFFF',
    success: '#7CFFB2',
    danger: '#FF9E9E',
    shadow: 'none',
    trim: '#FFFFFF',
    weightHead: 800,
    radius: '8px',
    radiusCard: '10px',
    pattern: 'chevron',
  },
  {
    ...BASE,
    id: 'pastel',
    kind: 'theme',
    group: 'tri',
    label: 'Pastel',
    blurb: 'Mint, baby blue, blush',
    accent: '#9FD8FF',
    hi: '#FFD1E3',
    lo: '#A8EBCF',
    on: '#1E1A33',
    bg: '#1E1A33',
    surface: '#2B2647',
    surface2: '#363056',
    nav: '#1A1630',
    text: '#F7F3FF',
    muted: '#C8BFE6',
    line: '#463F6E',
    success: '#A8EBCF',
    danger: '#FFA3B5',
    shadow: '0 12px 30px rgb(10 0 30 / 0.45)',
    trim: 'rgb(255 209 227 / 0.35)',
    radius: '999px',
    radiusCard: '22px',
    pattern: 'clouds',
  },
  {
    ...BASE,
    id: 'nautical',
    kind: 'theme',
    group: 'tri',
    label: 'Nautical',
    blurb: 'White, navy and signal red',
    scheme: 'light',
    accent: '#C8102E',
    hi: '#B00E28',
    lo: '#9E0C24',
    on: '#FFFFFF',
    bg: '#F7F9FC',
    surface: '#FFFFFF',
    surface2: '#EEF3FA',
    nav: '#FFFFFF',
    text: '#0B1B33',
    muted: '#4A5B75',
    line: '#D6E0EE',
    success: '#0F6B3E',
    danger: '#B42318',
    shadow: '0 1px 2px rgb(11 27 51 / 0.06), 0 6px 18px rgb(11 27 51 / 0.08)',
    trim: 'rgb(11 27 51 / 0.18)',
    fontHead: SERIF,
    weightHead: 600,
    radius: '10px',
    radiusCard: '14px',
    pattern: 'stripes',
  },
  { ...BASE, id: 'silver', label: 'Silver', accent: '#C3CAD4', hi: '#E6EAF0', lo: '#A7B0BC' },
  { ...BASE, id: 'rose', label: 'Rose', accent: '#FF7AA2', hi: '#FFA8C2', lo: '#F2588A' },
  { ...BASE, id: 'emerald', label: 'Emerald', accent: '#3DDC97', hi: '#6EE7B7', lo: '#1FBF83' },
  { ...BASE, id: 'sapphire', label: 'Blue', accent: '#5AA8FF', hi: '#93C6FF', lo: '#3D8EF0' },
  { ...BASE, id: 'violet', label: 'Purple', accent: '#B197FC', hi: '#D0BFFF', lo: '#9775FA' },
];

export const THEMES = ACCENTS.filter((a) => a.kind === 'theme');
/** The Theme sheet's three groups: Mono (one hue on white), Duo (Gold first) and Tri. */
export const MONO_PACKS = THEMES.filter((a) => a.group === 'mono');
export const DUO_PACKS = THEMES.filter((a) => a.group === 'duo');
export const TRI_PACKS = THEMES.filter((a) => a.group === 'tri');
/** Artist editions (Theme › Editions), each with its credit. */
export const EDITION_PACKS = THEMES.filter((a) => a.group === 'edition');

/**
 * Packs removed in the Mono/Duo/Tri tidy (15 Oct 2026) and the closest pack that replaced each, so an account
 * that saved one lands somewhere sensible. The old dark single tones kept their ids (blue, red …) as Mono packs.
 */
export const RETIRED_PACKS: Readonly<Record<string, AccentId>> = {
  paper: 'white',
  monolight: 'white',
  black: 'blackwhite',
};
export const MORE_COLOURS = ACCENTS.filter((a) => a.kind === 'colour');

let custom: Accent | null = null;
/** The colour mixer's current pack (accent.ts sets it); accentById('custom') returns it. */
export const setCustomAccent = (a: Accent | null): void => {
  custom = a;
};
/** The pack 'custom' paints right now (accent.ts keeps it across a connected site's look). */
export const getCustomAccent = (): Accent | null => custom;

export const accentById = (id: string | null | undefined): Accent => {
  const want = (id && RETIRED_PACKS[id]) || id;
  return (want === 'custom' && custom) || ACCENTS.find((a) => a.id === want) || (ACCENTS[0] as Accent);
};

/** The Gold look every pack and the mixer start from (for tests and the mixer). */
export const BASE_LOOK = BASE;

/** The CSS custom properties for one accent (src/accent.css holds the gold defaults). */
export const accentVars = (a: Accent): Record<string, string> => ({
  '--bw-accent': a.accent,
  '--bw-accent-hi': a.hi,
  '--bw-accent-lo': a.lo,
  '--bw-accent-rgb': rgbTriplet(a.accent),
  '--bw-accent-hi-rgb': rgbTriplet(a.hi),
  '--bw-accent-lo-rgb': rgbTriplet(a.lo),
  '--bw-on-accent': a.on,
  '--bw-bg': a.bg,
  '--bw-surface': a.surface,
  '--bw-trim': a.trim,
  '--bw-glow': a.glow,
  '--bw-font-num': a.fontNum,
  '--bw-font-head': a.fontHead,
  '--bw-radius-btn': a.radius,
});

/**
 * The full pack: accentVars plus the whole-app tokens. Only full packs and the mixer set these; Gold and the
 * accent-only colours leave them unset so every var(--bw-text, <old colour>) falls back to today's look.
 */
export const packVars = (a: Accent): Record<string, string> => ({
  ...accentVars(a),
  '--bw-pack-bg': a.bg,
  '--bw-bg-rgb': rgbTriplet(a.bg),
  '--bw-card': a.surface,
  '--bw-card2': a.surface2,
  '--bw-nav': a.nav,
  '--bw-text': a.text,
  '--bw-text-rgb': rgbTriplet(a.text),
  '--bw-muted': a.muted,
  '--bw-line': a.line,
  '--bw-success': a.success,
  '--bw-danger': a.danger,
  '--bw-shadow': a.shadow,
  '--bw-radius-card': a.radiusCard,
  '--bw-weight-head': String(a.weightHead),
  '--bw-tint': a.tint ?? a.surface2,
});

/** Every variable any pack may set (so switching packs can clear the previous one's). */
export const ALL_VARS = Object.keys(packVars(ACCENTS[0] as Accent));

/** Editions and Emoji themes sold in the Store ($1 each, owner 17-18 Oct 2026): only buyers get them, never in the free picker. */
export const PAID_EDITIONS: readonly string[] = ['vexvoid', 'npg', 'npgx', 'scammerscartel', ...EMOJI_PACK_IDS];
