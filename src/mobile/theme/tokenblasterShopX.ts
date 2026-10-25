/**
 * The TokenBlaster shop and its art (bWalletX only): a store build swaps this file for tokenblasterShopX.store.ts
 * (vite.config.mobile.ts), so none of it, pictures included, is in the store bundle. Logos and card art are
 * TokenBlaster's own /brand files, bundled as webp. The packs themselves are in tokenblasterX.ts.
 */
import type { Shop } from '../themeStore/shops';
import mainCard from '../wallet/editionArt/tokenblaster-main-card.webp';
import assaultCard from '../wallet/editionArt/tokenblaster-assault-card.webp';
import mainLogo from '../wallet/editionArt/tokenblaster-logo.webp';

/** Card art per pack pattern (cardPatternsEdition.ts). */
export const TOKENBLASTER_CARD_ART: Record<string, readonly string[]> = {
  tokenblaster: [mainCard],
  terrornode: [assaultCard],
};

/** The TokenBlaster shop (shops.ts), listed right after NPG. */
export const TOKENBLASTER_SHOPS: Shop[] = [
  {
    id: 'tokenblaster',
    name: 'TokenBlaster',
    owner: 'bWalletX',
    blurb: 'Games on the live chain, and a place to launch your own coin',
    logo: mainLogo,
    banner: mainCard,
    colour: '#0A0A0C',
    receiptArt: mainCard,
    themes: ['tokenblaster', 'terrornode'],
    links: [
      { label: 'Play', href: 'https://www.tokenblaster.lol' },
      { label: 'Launchpad', href: 'https://www.tokenblaster.lol/launch' },
    ],
    // Pages show live / coming status (owner rule). No merch source yet: tokenblaster.lol is adding merch_url.
    coming: ['Merch: coming', 'Terrornode ammo: coming soon'],
  },
];

/** Sharp art for the home Store showcase (StoreShowcase.tsx). */
export const TOKENBLASTER_SHOP_ART: Record<string, { img: string; pos: string }> = {
  tokenblaster: { img: mainCard, pos: '0% 40%' },
};
