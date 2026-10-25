/** Store build stand-in for tokenblasterShopX.ts (vite.config.mobile.ts): no TokenBlaster shop or art. */
import type { Shop } from '../themeStore/shops';

export const TOKENBLASTER_CARD_ART: Record<string, readonly string[]> = {};
export const TOKENBLASTER_SHOPS: Shop[] = [];
export const TOKENBLASTER_SHOP_ART: Record<string, { img: string; pos: string }> = {};
