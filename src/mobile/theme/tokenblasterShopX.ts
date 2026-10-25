/**
 * The TokenBlaster shop and its art (bWalletX only): a store build swaps this file for tokenblasterShopX.store.ts
 * (vite.config.mobile.ts), so none of it, pictures included, is in the store bundle. Logos and card art are
 * TokenBlaster's own /brand files, bundled as webp. The packs themselves are in tokenblasterX.ts.
 */
import type { Shop } from '../themeStore/shops';
import mainCard from '../wallet/editionArt/tokenblaster-main-card.webp';
import assaultCard from '../wallet/editionArt/tokenblaster-assault-card.webp';
import mainLogo from '../wallet/editionArt/tokenblaster-logo.webp';
import mainBanner from '../wallet/editionArt/tokenblaster-banner.webp';
import terrornodeBanner from '../wallet/editionArt/terrornode-banner.webp';
import terrornodeLogo from '../wallet/editionArt/terrornode-logo.webp';
import terrornodeIcon from '../wallet/editionArt/terrornode-token-icon.webp';

/** $TERRORNODE: one receipt per shot in Assault on Terrornode, no curve trading (owner, 25 Oct 2026). Icon at _0. */
export const TERRORNODE_TOKEN_ID = 'd5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1';

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
    banner: mainBanner,
    colour: '#0A0A0C',
    receiptArt: mainCard,
    themes: ['tokenblaster', 'terrornode'],
    links: [
      { label: 'Play', href: 'https://www.tokenblaster.lol' },
      { label: 'Launchpad', href: 'https://www.tokenblaster.lol/launch' },
    ],
    // Pages show live / coming status (owner rule). No merch source yet: tokenblaster.lol is adding merch_url.
    coming: ['Merch: coming'],
    // Earned by playing, not bought: outside link to the game only, no investment wording.
    items: [
      {
        id: 'terrornode-ammo',
        name: '$TERRORNODE',
        icon: terrornodeIcon,
        bannerCss: `center / auto 84% no-repeat url(${terrornodeLogo}), center / cover no-repeat url(${terrornodeBanner}), #000`,
        line: 'Every shot earns you a $TERRORNODE receipt, paid to your paymail when you finish playing.',
        links: [
          {
            label: 'Play Assault on Terrornode to earn $TERRORNODE',
            href: 'https://www.tokenblaster.lol/arcade/terrornode',
          },
        ],
        tokenId: TERRORNODE_TOKEN_ID,
      },
    ],
  },
];

/** Sharp art for the home Store showcase (StoreShowcase.tsx). */
export const TOKENBLASTER_SHOP_ART: Record<string, { img: string; pos: string }> = {
  tokenblaster: { img: mainCard, pos: '0% 40%' },
};
