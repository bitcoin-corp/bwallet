/** Store build stand-in for leanneX.ts (vite.config.mobile.ts): no Leanne The Dark pack. */
import type { Accent } from './accents';

export const leanneEditions = (
  _base: Omit<Accent, 'id' | 'label' | 'accent' | 'hi' | 'lo'>,
  _serif: string,
): Accent[] => [];
