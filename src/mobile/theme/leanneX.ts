/**
 * Leanne The Dark (owner, 25 Oct 2026): bWalletX only, deliberately. A store build swaps this file for
 * leanneX.store.ts (vite.config.mobile.ts), so neither the pack nor its card art is in the App Store / Play bundle.
 * No pictures here: accents.ts is also loaded by the Vite config, so the card art lives in leanneArtX.ts.
 */
import type { Accent } from './accents';

export const leanneEditions = (
  base: Omit<Accent, 'id' | 'label' | 'accent' | 'hi' | 'lo'>,
  serif: string,
): Accent[] => [
  {
    // Leanne The Dark (owner, 25 Oct 2026): worn while her sites are connected (connectTheme.ts EDITION_HOSTS), never
    // keyed to a token ($LEANNE is not minted). Her brand reds (#c81e3a, #8a0f22) are below AA on her near-black page,
    // so they dress lines, trim and glow; buttons and text use lighter reds from her own favicon's ink.
    ...base,
    id: 'leannethedark',
    kind: 'theme',
    group: 'edition',
    edition: 'Leanne The Dark edition',
    label: 'Leanne The Dark',
    blurb: 'Dark art, on-chain.',
    accent: '#EF4A60',
    hi: '#FF6B80',
    lo: '#E8394F',
    on: '#000000',
    bg: '#050102',
    surface: '#0A0203',
    surface2: '#140508',
    nav: '#050102',
    text: '#F5EDEE',
    muted: '#D9BFC3',
    line: '#4A0F1A',
    success: '#7EE2A8',
    danger: '#FF8A80',
    shadow: '0 0 24px rgb(200 30 58 / 0.16)',
    trim: 'rgb(200 30 58 / 0.65)',
    glow: '0 0 16px rgb(200 30 58 / 0.55), 0 0 3px rgb(138 15 34 / 0.9)',
    fontHead: serif,
    weightHead: 600,
    radius: '4px',
    radiusCard: '8px',
    pattern: 'leannethedark',
  },
];
