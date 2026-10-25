import { bappIconUrl } from './brand/bappIcons';
import { STORE_BUILD } from './storeBuild';
import { EXCHANGE_BAPPS } from './exchangeAppsX';
/**
 * The bApps store (Apps › bApps): The Bitcoin Corporation's own apps. Edit here.
 * status: 'live' = the site answered 200 with a real page when checked
 * (2026-10-01); 'demo' = not yet live. Demo apps are shown, labelled Demo.
 * icon: every bApp uses the minimal line icon set (brand/bappIcons), so the grid reads as one family.
 */
export type BAppGroup = 'featured' | 'work' | 'media' | 'social';

export type BApp = {
  name: string; // the b-name
  url: string;
  verb: string; // one line: what you do there
  group: BAppGroup;
  status: 'live' | 'demo';
  icon?: string;
  /** GitHub repo URL when open source; omit for closed source. */
  source?: string;
  /**
   * Opens full screen instead of inside bWallet's frame: the site sends X-Frame-Options or
   * CSP frame-ancestors that refuse the wallet (checked 2026-10-02). Remove once the site
   * allows `frame-ancestors capacitor://localhost https://localhost` (docs/BAPP-FRAME.md).
   * Sites without this flag are still probed at open time and fall back automatically.
   */
  noFrame?: boolean;
  /**
   * How the app is shown inside the wallet on a wide screen: 'mobile' = phone-width column,
   * 'desktop' (default) = the full width. The person can switch per app (BappFrameHost).
   */
  layout?: 'mobile' | 'desktop';
  /** bWalletX only: never listed in the store edition (bWallet). */
  privateOnly?: boolean;
  /** Restricted bApp (bShares): the badge text, e.g. "Restricted · members only"; the app itself checks membership. */
  restricted?: string;
  /**
   * Also runs in-frame in the web and Desktop wallets, without a header probe (browsers can't read
   * cross-origin headers). Only for sites that send CSP frame-ancestors allowing https://web.bwalletx.com
   * and https://desktop.bwalletx.com (bappFrame.ts WEB_FRAME_ORIGINS).
   */
  webFrame?: boolean;
};

const suite = (repo: string) => `https://github.com/bitcoin-apps-suite/${repo}`;

export const BAPP_GROUPS: { id: BAppGroup; label: string }[] = [
  { id: 'featured', label: 'Featured' },
  { id: 'work', label: 'Work' },
  { id: 'media', label: 'Media' },
  { id: 'social', label: 'Social & money' },
];

export const BAPPS: BApp[] = [
  // Featured
  {
    // bChatX signs in over XDM (WalletClient 'XDM') when framed; deep link: /bapp/bchatx?to=/u/<name> (BappLinkPage).
    name: 'bChatX',
    url: 'https://www.bchatx.com',
    webFrame: true,
    verb: 'Chat rooms, Spaces and feeds for every token',
    group: 'featured',
    status: 'live',
    icon: bappIconUrl('bchatx'),
  },
  {
    // One entry per product (24 Oct 2026): the live b*X site, not bmovies.app.
    name: 'bMoviesX',
    url: 'https://www.bmoviesx.com',
    verb: 'Watch and back tokenised films',
    group: 'featured',
    status: 'live',
    icon: bappIconUrl('bmovies'),
  },
  {
    name: 'bMusicX',
    url: 'https://bmusicx.com',
    // frame-ancestors doesn't list the wallet (24 Oct 2026).
    noFrame: true,
    verb: 'Tokenise your music; fans who hold it make the video with you',
    group: 'featured',
    status: 'live',
    icon: bappIconUrl('bmusic'),
  },
  {
    name: 'bMintX',
    // A tile opens the tool that works (owner, 24 Oct 2026): the in-wallet minter; bmintx.com lives inside it.
    url: '/m/bmint',
    verb: 'Design, stamp and mint tokens, currency and media on-chain',
    group: 'featured',
    status: 'live',
    icon: bappIconUrl('bmint'),
  },
  // bTrust (btrust/BTrustPage.tsx): recovery slices, passing on, papers. bWalletX only (BTRUST_ENABLED, owner 23 Oct 2026).
  // Literal env check (not the imported flag) so Rollup drops the entry from the store bundle.
  ...(!(
    import.meta.env.VITE_STORE_BUILD === '1' ||
    import.meta.env.VITE_CHANNEL === 'ios-store' ||
    import.meta.env.VITE_CHANNEL === 'android-play'
  )
    ? [
        {
          name: 'bTrust',
          url: '/m/btrust',
          verb: 'Recovery slices and passing your coins on to your heirs',
          group: 'featured' as const,
          status: 'live' as const,
          icon: bappIconUrl('btrust'),
        },
      ]
    : []),
  // bShares (docs/BCORP-PLACEMENT.md): share registers for any company; first register in testing is The Bitcoin
  // Corporation Ltd. For registered members and directors. Restricted, never in the store edition (no route or tile there: PLACEMENT_ENABLED).
  // Literal env check (not the imported flag) so Rollup drops the entry from the store bundle.
  ...(!(
    import.meta.env.VITE_STORE_BUILD === '1' ||
    import.meta.env.VITE_CHANNEL === 'ios-store' ||
    import.meta.env.VITE_CHANNEL === 'android-play'
  )
    ? [
        {
          // The in-wallet register (members only, the screen checks); bsharesx.com lives inside it.
          name: 'bSharesX',
          url: '/m/bshares',
          verb: 'Share registers for any company',
          group: 'featured' as const,
          status: 'live' as const,
          icon: bappIconUrl('bshares'),
          privateOnly: true,
        },
      ]
    : []),
  // bPositive (bpositive/BPositivePage.tsx): bWalletX only, like its route (BPOSITIVE_ENABLED). Literal env check.
  ...(!(
    import.meta.env.VITE_STORE_BUILD === '1' ||
    import.meta.env.VITE_CHANNEL === 'ios-store' ||
    import.meta.env.VITE_CHANNEL === 'android-play'
  )
    ? [
        {
          name: 'bPositive',
          url: '/m/bpositive',
          verb: 'One day at a time, with three friends who have your back',
          group: 'featured' as const,
          status: 'live' as const,
          icon: bappIconUrl('bpositive'),
        },
      ]
    : []),
  {
    name: 'Names',
    // The Name Store (names/store/NameStorePage.tsx): get your name on Bitcoin.
    url: '/m/names',
    verb: 'Get your name on Bitcoin. Yours forever',
    group: 'featured',
    status: 'live',
    icon: bappIconUrl('names'),
  },
  {
    name: 'bWriterX',
    url: 'https://bwriterx.com',
    verb: 'Write and save documents on-chain',
    group: 'featured',
    status: 'live',
    icon: bappIconUrl('bwriter'),
  },
  // Work
  {
    name: 'bSheets',
    url: 'https://bitcoin-spreadsheet.vercel.app',
    verb: 'Spreadsheets saved on-chain',
    group: 'work',
    status: 'live',
    icon: bappIconUrl('bsheets'),
    source: suite('bitcoin-spreadsheet'),
  },
  {
    name: 'bMailX',
    // The in-wallet mailbox (bmail/BMailScreen.tsx); bmailx.com lives inside it.
    url: '/m/bmail',
    verb: 'Send email that pays and gets paid',
    group: 'work',
    status: 'live',
    icon: bappIconUrl('bmail'),
  },
  {
    name: 'bDriveX',
    url: 'https://bdrivex.com',
    verb: 'Store and share files on-chain',
    group: 'work',
    status: 'live',
    icon: bappIconUrl('bdrive'),
  },
  {
    name: 'bCalX',
    // The in-wallet calendar of scheduled Spaces (spaces/CalendarPage.tsx); bcalx.com lives inside it.
    // The store edition has no Spaces calendar (BSPACES_ENABLED), so it opens bcalx.com. Literal env check.
    url: !(
      import.meta.env.VITE_STORE_BUILD === '1' ||
      import.meta.env.VITE_CHANNEL === 'ios-store' ||
      import.meta.env.VITE_CHANNEL === 'android-play'
    )
      ? '/m/calendar'
      : 'https://bcalx.com',
    verb: 'Keep a calendar on Bitcoin',
    group: 'work',
    status: 'live',
    icon: bappIconUrl('bcal'),
  },
  {
    name: 'bCode',
    url: 'https://bitcoin-code.vercel.app',
    verb: 'Build apps on Bitcoin',
    group: 'work',
    status: 'live',
    icon: bappIconUrl('bcode'),
    source: suite('bitcoin-code'),
  },
  {
    name: 'bJobsX',
    url: 'https://bjobsx.com',
    verb: 'Find work and hire, paid in BSV',
    group: 'work',
    status: 'live',
    icon: bappIconUrl('bjobs'),
  },
  {
    name: 'bID',
    url: 'https://bitcoin-identity.vercel.app',
    verb: 'Manage your on-chain identity',
    group: 'work',
    status: 'live',
    icon: bappIconUrl('bid'),
    source: suite('bitcoin-identity'),
  },
  {
    name: 'bSearch',
    url: 'https://bitcoin-search.vercel.app',
    verb: 'Search what lives on-chain',
    group: 'work',
    status: 'live',
    icon: bappIconUrl('bsearch'),
    source: suite('bitcoin-search'),
  },
  {
    name: 'bDNS',
    url: 'https://bitcoin-dns.vercel.app',
    verb: 'Register and trade names on Bitcoin',
    group: 'work',
    status: 'live',
    icon: bappIconUrl('bdns'),
    source: suite('bitcoin_dns'),
  },
  // Media
  {
    name: 'bVideoX',
    url: 'https://bvideox.com',
    verb: 'Watch and publish video',
    group: 'media',
    status: 'live',
    // Connect bWalletX (owner, 25 Oct 2026): bvideox.com signs in with @bwalletx/connect 0.5.0, which looks for the
    // in-app browser's injected wallet (window.CWI / brc100 announce) and has no in-frame (XDM) route. Inside the
    // wallet frame it found nothing and fell back to the pairing QR. Full screen gets the injected wallet. Remove once
    // the site loads a @bwalletx/connect that also tries XDM when framed (bwalletx-connect PR).
    noFrame: true,
    icon: bappIconUrl('bvideo'),
  },
  {
    name: 'bRadioX',
    url: 'https://bradiox.com',
    verb: 'Listen to and run Bitcoin radio',
    group: 'media',
    status: 'live',
    icon: bappIconUrl('bradio'),
  },
  {
    name: 'bPhotos',
    url: 'https://bitcoin-photos.vercel.app',
    verb: 'Turn photos into tradable NFTs',
    group: 'media',
    status: 'live',
    icon: bappIconUrl('bphotos'),
    source: suite('bitcoin-photos'),
  },
  {
    name: 'bArt',
    url: 'https://bitcoin-art.vercel.app',
    verb: 'Collect and show on-chain art',
    group: 'media',
    status: 'live',
    icon: bappIconUrl('bart'),
    source: suite('bitcoin-art'),
  },
  {
    name: 'bPaint',
    url: 'https://bitcoin-paint.vercel.app',
    verb: 'Paint and inscribe your work',
    group: 'media',
    status: 'live',
    icon: bappIconUrl('bpaint'),
    source: suite('bitcoin-paint'),
  },
  {
    name: 'b3D',
    url: 'https://bitcoin-3d.vercel.app',
    verb: 'Model and own 3D designs',
    group: 'media',
    status: 'live',
    icon: bappIconUrl('b3d'),
    source: suite('bitcoin-3d'),
  },
  {
    name: 'bBooks',
    url: 'https://bitcoin-books-bay.vercel.app',
    verb: 'Read and publish books',
    group: 'media',
    status: 'live',
    icon: bappIconUrl('bbooks'),
    source: suite('bitcoin-books'),
  },
  // Social & money
  {
    // bAgents (owner, 6 Oct 2026; docs/BAGENTS-PLAN.md): the home for agent accounts. The only origin the wallet's
    // BWX agent bridge answers (bappFrame/bwxBridge.ts). Agent trading stays out of the store edition.
    name: 'bAgents',
    url: 'https://agents.bwalletx.com',
    verb: 'Run your AI agents and their budgets',
    group: 'featured',
    status: 'live',
    icon: bappIconUrl('bagents'),
    privateOnly: true,
  },
  {
    name: 'bSocialX',
    url: 'https://bsocialx.com',
    verb: 'Post and follow on Bitcoin',
    group: 'social',
    status: 'live',
    icon: bappIconUrl('bsocial'),
  },
  {
    name: 'bGames',
    url: 'https://bitcoin-gaming.vercel.app',
    verb: 'Play games with real stakes',
    group: 'social',
    status: 'live',
    icon: bappIconUrl('bgames'),
    source: suite('bitcoin-gaming'),
  },
  // bWalletX only (exchangeAppsX.ts; a store build has an empty stand-in).
  ...EXCHANGE_BAPPS,
  {
    name: 'bMaps',
    url: 'https://bitcoin-maps.vercel.app',
    verb: 'Find places that take Bitcoin',
    group: 'social',
    status: 'live',
    icon: bappIconUrl('bmaps'),
    source: suite('bitcoin-maps'),
  },
];

/**
 * Not ready (checked 24 Oct 2026: the site answered 404): shown as a non-tappable "Coming" chip with gold
 * bApp art, never as a tile. Move an entry back into BAPPS once its site answers 200 with a real page.
 */
export const COMING_BAPPS: { name: string; verb: string; icon: string }[] = [
  { name: 'bEdu', verb: 'Learn and teach courses', icon: bappIconUrl('bedu') },
];

export const bappsIn = (group: BAppGroup) => BAPPS.filter((a) => a.group === group && !(STORE_BUILD && a.privateOnly));
