/**
 * Apps the owner ships with bWalletX (Apps tab, alongside BSVRadar and Metanet apps). Add one with
 *   pnpm add-app <url> [group]        (group: market social media tools money explore learn games; default tools)
 * which fetches the site's name, tagline and icon (saved as a 96px PNG beside the others) and appends
 * it here. Edit by hand freely; keep the markers.
 */
import type { RadarApp } from './radarApps';
import { ownerAppsFor, TOKENBLASTER_ENABLED } from './storeBuild';
import { TOKENBLASTER_APPS } from './ownerAppsX';
import owner_budz_lol from './brand/apps/radar/owner-budz-lol.png';
import owner_budgirls_pro from './brand/apps/radar/owner-budgirls-pro.png';
import owner_zanaadu_com from './brand/apps/radar/owner-zanaadu-com.png';
import owner_gzone_rocks from './brand/apps/radar/owner-gzone-rocks.png';
import owner_gmehl_rocks from './brand/apps/radar/owner-gmehl-rocks.png';
import owner_uwutv_space from './brand/apps/radar/owner-uwutv-space.png';
import owner_twetch_rocks from './brand/apps/radar/owner-twetch-rocks.png';
import owner_aigf_pro from './brand/apps/radar/owner-aigf-pro.png';
import owner_1satsocial_online from './brand/apps/radar/owner-1satsocial-online.png';
import owner_zerodice_online from './brand/apps/radar/owner-zerodice-online.png';
import owner_ninjapunkgirls_online from './brand/apps/radar/owner-ninjapunkgirls-online.png';
import owner_tankscope_pro from './brand/apps/radar/owner-tankscope-pro.png';
import owner_vexvoid_com from './brand/apps/radar/owner-vexvoid-com.png';
// ADD-APP:IMPORTS

const ALL_OWNER_APPS: RadarApp[] = [
  {
    name: 'BUDZ',
    url: 'https://budz.lol',
    desc: 'BUDZ — twelve strains, twelve tokens. Every strain gets a ticker and a room: hold the one ',
    group: 'social',
    icon: owner_budz_lol,
    source: 'owner',
  },
  {
    name: 'BUDGIRLS',
    url: 'https://budgirls.pro',
    desc: 'BUDGIRLS — cannabis influencers, tokenised. Pick your girl and hold her ticker to get into',
    group: 'social',
    icon: owner_budgirls_pro,
    source: 'owner',
  },
  {
    name: 'Zanaadu',
    url: 'https://zanaadu.com',
    desc: 'Post, engage, and earn on a social network where every upvote pays creators directly. Stor',
    group: 'social',
    icon: owner_zanaadu_com,
    source: 'owner',
  },
  {
    name: 'GZONE.ROCKS',
    url: 'https://gzone.rocks',
    desc: 'GZONE.ROCKS — THE GZONE RBL. The battles from the league, tokenised: watch, pick your favo',
    group: 'media',
    icon: owner_gzone_rocks,
    source: 'owner',
  },
  {
    name: 'GMEHL.ROCKS',
    url: 'https://gmehl.rocks',
    desc: 'GMEHL.ROCKS — the Gavin Mehl channel. His videos, auto-syndicated and tokenised: watch, ba',
    group: 'media',
    icon: owner_gmehl_rocks,
    source: 'owner',
  },
  {
    name: 'UWUTV',
    url: 'https://uwutv.space',
    desc: 'UWUTV — a video vending machine for $UWU. Make unicorn-grade UWU commercials with AI, give',
    group: 'media',
    icon: owner_uwutv_space,
    source: 'owner',
  },
  {
    name: 'TWETCH.ROCKS',
    url: 'https://twetch.rocks',
    desc: 'TWETCH.ROCKS — the social feed where your handle is an AGENT and every post is a ticker. Y',
    group: 'social',
    icon: owner_twetch_rocks,
    source: 'owner',
  },
  {
    name: 'AIGF',
    url: 'https://aigf.pro',
    desc: 'AI Girlfriends — choose your girl, back her token, make her famous. Each girlfriend is a t',
    group: 'social',
    icon: owner_aigf_pro,
    source: 'owner',
  },
  {
    name: '1satsocial',
    url: 'https://1satsocial.online',
    desc: 'Every BSV-21 token, BSV-20 tick and 1Sat Ordinals collection gets its own group chat. Only',
    group: 'social',
    icon: owner_1satsocial_online,
    source: 'owner',
  },
  {
    name: 'Zero Dice',
    url: 'https://zerodice.online',
    desc: '$ZERODICE — a token with an autonomous agent attached. Zero Dice, the techno DJ anime hero',
    group: 'games',
    icon: owner_zerodice_online,
    source: 'owner',
  },
  {
    name: 'Ninja Punk Girls',
    url: 'https://ninjapunkgirls.online',
    desc: 'Collect, trade, and battle with unique Ninja Punk Girls NFTs in the ultimate cyberpunk gam',
    group: 'games',
    icon: owner_ninjapunkgirls_online,
    source: 'owner',
  },
  {
    name: 'TankScope',
    url: 'https://tankscope.pro',
    desc: 'Field capture and customer reporting for route-based aquarium service businesses. Per-tank',
    group: 'tools',
    icon: owner_tankscope_pro,
    source: 'owner',
  },
  // bWalletX only: not even as data in a store build (TOKENBLASTER_ENABLED; vite.config.mobile.ts swaps
  // ownerAppsX.ts for ownerAppsX.store.ts there, so its icon is not emitted either).
  ...(TOKENBLASTER_ENABLED ? TOKENBLASTER_APPS : []),
  {
    name: 'VexVoid',
    url: 'https://www.vexvoid.com/',
    desc: 'VexVoid — music and audio-visual releases. Listen, watch and collect',
    group: 'media',
    icon: owner_vexvoid_com,
    source: 'owner',
  },
  // ADD-APP:ENTRIES
];
/** Store builds leave out apps that sell or trade (storeBuild.ts). */
export const OWNER_APPS: RadarApp[] = ownerAppsFor(ALL_OWNER_APPS);
