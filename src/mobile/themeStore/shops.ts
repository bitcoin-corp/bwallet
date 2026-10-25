import npgBanner from '../wallet/art/npg/npg-1.webp';
import npgLogo from '../../web/themes/icon-npg-192.png';
import npgxLogo from '../../web/themes/icon-npgx-192.png';
import { EMOJI_PACK_IDS } from '../theme/emojiThemes';
import { emojiArtUri, emojiTileUri } from '../wallet/cardPatternsEmoji';
import scammersCard from '../wallet/editionArt/scammerscartel-dj-card.webp';
import scammersBg from '../wallet/editionArt/scammerscartel-dj-bg.webp';
import vexArt from '../media/featured/vexvoid-cover.jpg';
import { TOKENBLASTER_SHOPS } from '../theme/tokenblasterShopX';

/**
 * Shops in the Store mall (owner, 17 Oct 2026): every item sits in one shop and one department, so people can
 * browse by shop (NPG, VexVoid…) or by department (Themes…). Shops are ours to start; anyone can open one later,
 * after b reviews it. Other brands (Zoide, Twetch, Treechat) only with their say-so: we hold the name, they claim it.
 */
export interface Shop {
  id: string;
  name: string;
  owner: string;
  blurb: string;
  logo: string;
  /** Banner picture, or a solid colour when there is none. */
  banner?: string;
  /** A CSS background for the banner (wins over `banner`), e.g. the logo on a pattern. */
  bannerCss?: string;
  colour: string;
  /** Picture printed on this shop's receipts (storeReceipt/art.ts); the logo when absent. */
  receiptArt?: string;
  /** Theme pack ids this shop sells (Store › Themes lists the same items). */
  themes: readonly string[];
  /** Outside pages the shop links to (Play, Launchpad…), opened in the browser. */
  links?: readonly { label: string; href: string }[];
  /** Things on the way, shown as plain status lines with no buy button (owner rule: pages show live / coming). */
  coming?: readonly string[];
  /**
   * Things sold elsewhere (a token on a launchpad), shown with outside links only: no buy flow in the wallet.
   * `tokenId` (a BSV-21 id) adds a Chat button for the token's room when token rooms are on.
   */
  items?: readonly ShopItem[];
}

export interface ShopItem {
  id: string;
  name: string;
  icon: string;
  /** Optional strip above the item: a CSS background (art, or a logo on art). */
  bannerCss?: string;
  line: string;
  links: readonly { label: string; href: string }[];
  tokenId?: string;
}

const ALL_SHOPS: readonly Shop[] = [
  {
    id: 'npg',
    name: 'Ninja Punk Girls',
    owner: 'bWalletX',
    blurb: 'Themes and art from the NPG universe',
    logo: npgLogo,
    banner: npgBanner,
    colour: '#FF2E93',
    themes: ['npg'],
  },
  // TokenBlaster (owner, 25 Oct 2026): bWalletX only, empty in a store build (theme/tokenblasterShopX.store.ts).
  ...TOKENBLASTER_SHOPS,
  {
    id: 'npgx',
    name: 'NPGX',
    owner: 'bWalletX',
    blurb: 'Black and red',
    logo: npgxLogo,
    // The NPGX logo on the theme's red grid.
    bannerCss: `center / contain no-repeat url(${npgxLogo}), linear-gradient(rgba(255,0,64,.22) 1px, transparent 1px) 0 0 / 16px 16px, linear-gradient(90deg, rgba(255,0,64,.22) 1px, transparent 1px) 0 0 / 16px 16px, #000`,
    colour: '#FF2D3A',
    themes: ['npgx'],
  },
  {
    id: 'vexvoid',
    name: 'VexVoid',
    owner: 'bWalletX',
    blurb: 'White ink on true black',
    logo: vexArt,
    banner: vexArt,
    colour: '#000000',
    themes: ['vexvoid'],
  },
  {
    // ScammersCartel (owner, 18 Oct 2026): the first community on bChatX (scammerscartel.com). An ironic name, a playful look.
    id: 'scammerscartel',
    name: 'Scammers Cartel',
    owner: 'bWalletX',
    blurb: 'The DJ raccoon: yellow glow on black',
    logo: scammersCard,
    bannerCss: `center / cover no-repeat url(${scammersBg}), #000`,
    colour: '#FFD400',
    themes: ['scammerscartel'],
  },
  {
    // Emoji themes (owner, 18 Oct 2026): Twemoji art (CC-BY 4.0, credited on each item), $1 each.
    id: 'emoji',
    name: 'Emoji',
    owner: 'bWalletX',
    blurb: 'Twelve emoji looks, $1 each',
    logo: emojiTileUri('emoji-cool', 96),
    bannerCss: `center / cover no-repeat url("${emojiArtUri('emoji-rainbow')}"), #08060F`,
    colour: '#B18CFF',
    themes: EMOJI_PACK_IDS,
  },
];

/** Shops not ready for release (owner, 19 Oct 2026): Scammers Cartel waits for the community's real banner. */
export const HIDDEN_SHOPS: readonly string[] = ['scammerscartel'];
export const SHOPS: readonly Shop[] = ALL_SHOPS.filter((s) => !HIDDEN_SHOPS.includes(s.id));
// Owners of a hidden shop's theme keep it working, so look-ups use the full list.
export const shopById = (id: string) => ALL_SHOPS.find((s) => s.id === id);
