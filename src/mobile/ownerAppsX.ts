/** bWalletX-only owner app tiles (TokenBlaster). A store build swaps this file for ownerAppsX.store.ts. */
import type { RadarApp } from './radarApps';
import owner_tokenblaster from './brand/apps/tokenblaster.png';
import owner_terrornode from './brand/apps/terrornode.png';

export const TOKENBLASTER_APPS: RadarApp[] = [
  {
    // Owner, 26 Oct 2026: the game goes on the wallet home in place of TokenBlaster.
    name: 'TERRORNODE',
    url: 'https://www.tokenblaster.lol/arcade/terrornode',
    desc: 'The arcade shooter on BSV: play, earn $TERRORNODE',
    group: 'tools',
    icon: owner_terrornode,
    source: 'owner',
  },
  {
    name: 'TokenBlaster',
    url: 'https://www.tokenblaster.lol/blast',
    desc: 'Load your token into the gun and blast it at the chain',
    group: 'tools',
    icon: owner_tokenblaster,
    source: 'owner',
  },
];
