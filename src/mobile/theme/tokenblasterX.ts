/**
 * TokenBlaster in the Store (owner, 25 Oct 2026: "Create a tokenblaster.lol store and put it in the bwalletX.com store
 * by default"). bWalletX only: a store build swaps this file for tokenblasterX.store.ts (vite.config.mobile.ts), so
 * the packs are not in the store bundle at all (TOKENBLASTER_ENABLED, STORE-AUDIT). No pictures here: accents.ts is
 * also loaded by the Vite config (splash.ts), so the shop and its art live in tokenblasterShopX.ts.
 *
 * Colours come from TokenBlaster's own theme files (tokenblaster.lol/.well-known/bwalletx-theme.json and
 * bwalletx-theme.assault.json); the logos and card art are their /brand files, bundled here as webp.
 */
import type { Accent } from './accents';

const MONO = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** The two packs, built on the shared BASE (accents.ts passes it in). */
export const tokenblasterEditions = (base: Omit<Accent, 'id' | 'label' | 'accent' | 'hi' | 'lo'>): Accent[] => [
  {
    // The main TokenBlaster look: arcade red and amber on near-black.
    ...base,
    id: 'tokenblaster',
    kind: 'theme',
    group: 'edition',
    edition: 'TokenBlaster edition',
    label: 'TokenBlaster',
    blurb: 'Arcade red and amber on black',
    accent: '#FF3B30',
    hi: '#FFB800',
    lo: '#FA3F35',
    on: '#000000',
    bg: '#0A0A0C',
    surface: '#121317',
    surface2: '#1A1B21',
    nav: '#0A0A0C',
    text: '#F2EFE6',
    muted: '#B8B3A6',
    line: '#3A2A26',
    success: '#7EE2A8',
    danger: '#FF8A80',
    shadow: '0 0 24px rgb(255 59 48 / 0.14)',
    trim: 'rgb(255 184 0 / 0.6)',
    glow: '0 0 14px rgb(255 59 48 / 0.5)',
    fontNum: MONO,
    fontHead: MONO,
    weightHead: 800,
    radius: '6px',
    radiusCard: '8px',
    pattern: 'tokenblaster',
  },
  {
    // Assault on Terrornode, TokenBlaster's arcade shooter: red and ice blue on deep navy.
    ...base,
    id: 'terrornode',
    kind: 'theme',
    group: 'edition',
    edition: 'TokenBlaster edition',
    label: 'Assault on Terrornode',
    blurb: 'Red and ice blue on deep navy',
    accent: '#FF3B3B',
    hi: '#3FD8E8',
    lo: '#FA3F3F',
    on: '#000000',
    bg: '#05090F',
    surface: '#0A121C',
    surface2: '#111B27',
    nav: '#05090F',
    text: '#E8F1F6',
    muted: '#A6B6C2',
    line: '#1E3442',
    success: '#7EE2A8',
    danger: '#FF8A80',
    shadow: '0 0 24px rgb(63 216 232 / 0.12)',
    trim: 'rgb(63 216 232 / 0.55)',
    glow: '0 0 14px rgb(63 216 232 / 0.45)',
    fontNum: MONO,
    fontHead: MONO,
    weightHead: 800,
    radius: '6px',
    radiusCard: '8px',
    pattern: 'terrornode',
  },
];
