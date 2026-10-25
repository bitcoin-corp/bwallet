/** Store build stand-in for tokenblasterX.ts (vite.config.mobile.ts): no TokenBlaster packs. */
import type { Accent } from './accents';

export const tokenblasterEditions = (_base: Omit<Accent, 'id' | 'label' | 'accent' | 'hi' | 'lo'>): Accent[] => [];
