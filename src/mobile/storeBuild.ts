/**
 * Store build switch. `pnpm build:mobile:store` (VITE_STORE_BUILD=1) builds the variant shipped through
 * the App Store / Google Play; the default build (direct download / APK) is unchanged. The ios-store and
 * android-play channels (channel.ts) turn it on too.
 *
 * In a store build the wallet never asks the user to pay bCorp to unlock app features, and holding a
 * token never unlocks app functionality (Apple 3.1.1 / 3.1.5, Google Play Payments policy). See
 * docs/STORE-AUDIT.md. Peer-to-peer send / receive, tips and viewing NFTs stay on.
 *
 * Every gate is here so the list of what changes is in one place. Helpers take the flag as a
 * parameter (default STORE_BUILD) so they are unit-tested both ways (storeBuild.test.ts).
 * `import.meta.env.VITE_STORE_BUILD` is written literally so Vite inlines it and Rollup drops the
 * dead branches (the paid b agent endpoints are not in the store bundle).
 */
export const STORE_BUILD: boolean =
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play';

/** b agent: own-key mode only in a store build (no pay-per-message to bCorp). */
export const agentModeFor = <M extends string>(mode: M, store = STORE_BUILD): M | 'own' => (store ? 'own' : mode);

/** Shown in Settings › b agent in place of the mode / daily-limit pickers. */
export const STORE_AGENT_NOTE = 'Use your own AI provider key';

/** Fee addresses that pay bCorp (Mint, Market, ticket resale): none in a store build. */
export const bcorpFeeAddress = (address: string, store = STORE_BUILD): string => (store ? '' : address);

/** Wallet tab switch: no Tickets (token-gated rooms) or Credits (prepaid bCorp credits) in a store build. */
export const STORE_HIDDEN_WALLET_KINDS: readonly string[] = ['tickets', 'credits', 'shares'];
export const walletKindsFor = <T extends readonly [string, ...unknown[]]>(
  kinds: readonly T[],
  store = STORE_BUILD,
): T[] => (store ? kinds.filter((k) => !STORE_HIDDEN_WALLET_KINDS.includes(k[0])) : [...kinds]);

/**
 * Market Tokens sub-filters: no Tickets (room access) in a store build (curve coins: CURVE_COINS_ENABLED). bApps is a plain token filter.
 */
export const STORE_HIDDEN_MARKET_FILTERS: readonly string[] = ['tickets'];
export const marketFiltersFor = <T extends readonly [string, ...unknown[]]>(
  filters: readonly T[],
  store = STORE_BUILD,
): T[] => (store ? filters.filter((f) => !STORE_HIDDEN_MARKET_FILTERS.includes(f[0])) : [...filters]);

/**
 * Market buy / sell / list: off in a store build, where the Market is view-only. App Review rejected
 * build 8 under 3.1.5(iii) (exchange functionality needs a licensed exchange); bWalletX keeps trading.
 */
export const marketTradingEnabled = (store = STORE_BUILD) => !store;

/**
 * Bonding-curve coin trading (Market › Tokens, market/launchpad/): never in a store build, not even as
 * code. A literal env check so Vite inlines it and Rollup drops the lazy import in MarketPage.tsx.
 */
export const CURVE_COINS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Everything tokenblaster.lol (the TokenBlaster owner tile, Home addition, and the 1Sat Ordnance 3D
 * catalogue with its "buy it there" link): bWalletX only, absent from a store build even as data
 * (outside purchase of digital goods: Apple 3.1.1, Play Payments). Literal env check so Vite inlines
 * it and Rollup drops the data and the lazy imports. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const TOKENBLASTER_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Airdrop to holders (issuer tool, 16 Oct 2026, `holderDrop/`): send a token or BSV to every holder of a token
 * in one go. bWalletX only: a token airdrop to a token's holders rewards holding it (STORE-AUDIT 2), so the
 * sheet is a lazy chunk behind this literal env check and not in the store bundle. Same env as STORE_BUILD.
 */
export const HOLDER_DROP_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * bPositive (/m/bpositive, site /bpositive, bit-sign PR #299): journeys with witnesses and pledges between
 * friends. bWalletX only, as the site page says ("Not in the store edition"): a lazy chunk behind this literal
 * env check, with its Apps tile behind the same check, so the store bundle has none of it. Same env as STORE_BUILD.
 */
export const BPOSITIVE_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Owner apps left out of a store build: TokenBlaster sells guns and runs a coin launchpad, so a store
 * app linking to it would point users at outside buying (Apple 3.1.1/3.1.5, Play Payments).
 */
// Folds to [] in a store build, where the tile's data is not in the bundle at all (TOKENBLASTER_ENABLED).
export const STORE_HIDDEN_OWNER_APPS: readonly string[] = TOKENBLASTER_ENABLED ? ['TokenBlaster', 'TERRORNODE'] : [];
export const ownerAppsFor = <T extends { name: string }>(apps: readonly T[], store = STORE_BUILD): T[] =>
  store ? apps.filter((a) => !STORE_HIDDEN_OWNER_APPS.includes(a.name)) : [...apps];

/**
 * The Market / Exchange tab and everything that leads to it (Buy / Get PNEEs / Back PNEEs buttons, token pages'
 * Buy, the Apps tiles for exchanges, swaps, marketplaces and BSV on-ramps): bWalletX only. App Review rejected
 * the iOS store build under 3.1.5(iii) (exchange functionality without licences, plus EEA / MiCA), so the store
 * edition has no Market at all, not even view-only. Literal env check so Vite inlines it and Rollup drops the
 * MarketPage chunk and the gated buttons and data. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const MARKET_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
/**
 * Swap into BSV (ChangeNOW via bit-sign, src/mobile/swap/): bWalletX only. Swapping coins is exchange
 * functionality (Apple 3.1.5(iii), the same rejection as the Market), so the store edition has no Swap card and
 * keeps the plain price card. Literal env check so Vite inlines it and Rollup drops the lazy SwapFlow chunk.
 */
export const SWAP_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
/**
 * Apps tiles left out of a store build: exchanges / swaps (bApps by name, BSVRadar groups by id). The data
 * itself is gated by MARKET_ENABLED in bapps.ts / radarApps.ts, so the name folds to [] in a store build.
 */
export const STORE_HIDDEN_APPS: readonly string[] = MARKET_ENABLED ? ['bExchange'] : [];
export const STORE_HIDDEN_RADAR_GROUPS: readonly string[] = ['market', 'buy'];
export const appsTileShown = (name: string, store = STORE_BUILD) => !store || !STORE_HIDDEN_APPS.includes(name);
export const radarGroupShown = (group: string, store = STORE_BUILD) =>
  !store || !STORE_HIDDEN_RADAR_GROUPS.includes(group);

/** Token-gated chatrooms open (join / start / buy-to-join) only outside a store build. */
export const tokenRoomsEnabled = (store = STORE_BUILD) => !store;
export const STORE_ROOM_NOTE = 'This room is for token holders. Open it in bWalletX or on bchatx.com.';

/**
 * bSpaces (docs/BSPACES-PLAN.md), the full set: Spaces in token rooms, the Spaces home and its tile,
 * New Space, paid entry ("Pay at the door"), tickets. bWalletX only: token rooms are off in a store
 * build (Apple 3.1.1 bars crypto ownership unlocking features) and paid entry is a digital sale.
 * Literal env check so Vite inlines it and Rollup drops the lazy SpacesPage chunk and DoorKeeper.
 */
export const BSPACES_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Free Spaces (owner, 10 Oct 2026): every edition, the store one included, can listen, ask to speak,
 * speak and chat in the bWallet Lounge and other open (non-token) rooms. Nothing is bought, sold or
 * unlocked by holding a token there. Moderation (report / block on people and messages, host remove
 * and mute, the community rules link) is in the Space screen for everyone (Apple 1.2 / Play UGC).
 */
export const FREE_SPACES_ENABLED = true;

/**
 * Space transcription with consent (18 Oct 2026, bit-sign space-transcription-rules). bWalletX only
 * for the parts that turn speech into text: the host's mode switch, the speak-consent tick and the
 * transcript view. A store build still SHOWS the "Transcribing" badge, the listen notice and the
 * "(not transcribed)" labels, because that is disclosure; it never offers the tick, so a store user
 * is never transcribed. Store listings (Apple privacy labels, Play Data safety) must declare audio
 * collection before this flag opens up there.
 */
export const TRANSCRIPTION_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/** An open room (metadata.kind 'open', or an always-open one like the Lounge): no token gate. */
export const isOpenRoom = (room: { ticker?: string | null; metadata?: unknown } | null | undefined): boolean => {
  if (!room) return false;
  const m = room.metadata as { kind?: unknown; tokenGate?: unknown } | null | undefined;
  if (m?.tokenGate) return false;
  return m?.kind === 'open' || String(room.ticker ?? '').toUpperCase() === 'LOUNGE';
};

/** Can this room show its Space (Live now / Join / Start)? bWalletX: any room. Store: open rooms only. */
export const roomSpacesAllowed = (
  room: { ticker?: string | null; metadata?: unknown } | null | undefined,
  store = STORE_BUILD,
): boolean => !store || (FREE_SPACES_ENABLED && isOpenRoom(room));

/** What a store build says where a token room's Space would be. */
export const storeTokenSpaceNote = (symbol?: string | null) =>
  `This room is for ${symbol ? `$${symbol}` : 'token'} holders. Open it in bWalletX or on bchatx.com.`;

/**
 * bPhone paid calls (docs/BPHONE-PLAN.md): charging to receive a call, the directory of people who
 * charge, and paying as you go. bWalletX only: the store edition keeps free voice and video calls
 * but never shows price setting or paid dialling (Apple 3.1.1 / 3.1.3(d) to be settled with a
 * reviewer first). Literal env check so Vite inlines it and Rollup drops the bPhone tab and the
 * pay loop from the store bundle. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const PAID_CALLS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
export const paidCallsEnabled = (store = STORE_BUILD) => !store;

/** Wallet › Mint choices: tokens and media in a store build (no bCorp fee); no chatroom tickets. */
export type MintChoice = 'ticket' | 'token' | 'media';
export const mintChoicesFor = (store = STORE_BUILD): MintChoice[] =>
  store ? ['token', 'media'] : ['ticket', 'token', 'media'];

/** Token indexing fee: paid to the third-party 1Sat overlay (a network cost, like gas), so on everywhere. */
export const indexingEnabled = (_store = STORE_BUILD) => true;

/** Paid features shown outside a store build only: Credits, paid indexing, personal token + room. */
export const paidFeaturesEnabled = (store = STORE_BUILD) => !store;

/** bWalletX = every non-store build (private channels, web, dev); the store app is plain bWallet. */
export const isBWalletX = (store = STORE_BUILD) => !store;
export const appNameFor = (store = STORE_BUILD) => (store ? 'bWallet' : 'bWalletX');

/** The trading tab: "Exchange" in bWalletX (it trades, hence the X), "Market" in the store app (browse only). */
export const marketLabel = (store = STORE_BUILD) => (store ? 'Market' : 'Exchange');

/**
 * "Continue with X / Google" on Create Account: bWalletX only for now. App Review guideline 4.8
 * (offer Sign in with Apple beside a third-party login) may apply; switch on once that's settled.
 */
export const socialLoginEnabled = (store = STORE_BUILD) => !store;

/**
 * Buying crypto: the Buy BSV card / sheet (ChangeNOW, Alchemy Pay, Ramp later), "Get BSV" on an empty wallet and
 * "Get MNEE" (MNEE's referral sign-up). All lead to third-party on-ramps / exchanges, so bWalletX only: the store
 * edition has no buying or exchange (Play financial features declaration: none).
 */
export const buyCryptoEnabled = (store = STORE_BUILD) => !store;

/** The app's own name for user-visible text: "bWallet" in a store build, "bWalletX" otherwise. */
export const APP_NAME = appNameFor();

/**
 * The same gates as plain constants, for JSX: Rollup folds `!STORE_BUILD` at build time, so the store bundle
 * doesn't even contain the hidden screens' text (a function call isn't folded).
 */
// Literal env checks (like the gates above): `!STORE_BUILD` was not folded, so the Buy BSV sheet and its provider
// list were still in the store bundle (store parity, 10 Oct 2026).
/**
 * Sign in with HandCash + "Bring in my HandCash friends" (15 Oct 2026): the same store gate as Continue with X
 * (socialLoginEnabled, guideline 4.8: no Sign in with Apple beside it), as a literal so the store bundle drops it.
 */
export const HANDCASH_SIGNIN_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
/**
 * "Link your accounts" (X / Google / GitHub / LinkedIn / HandCash badges, owner 18 Oct 2026): the same store gate
 * as Continue with X (guideline 4.8 is still unsettled), as a literal so the store bundle drops the screen.
 */
export const LINK_ACCOUNTS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
export const BUY_CRYPTO_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
export const PAID_FEATURES_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Feed bad language (feed/language.ts). Store edition: slurs hidden with no reveal (names read "Hidden
 * name") and swearing always blurred behind "Show anyway"; the Settings toggle is not shown. bWalletX:
 * slur posts and names blurred behind a per-post "Show anyway" / tap; swearing shown unless "Filter
 * strong language" is on. A stored `allowLanguageReveal` (the retired 18+ opt-in) is ignored.
 */
export const languageSettingsEnabled = (store = STORE_BUILD) => !store;
export const languageOptsFor = (
  prefs: { filterStrong: boolean },
  store = STORE_BUILD,
): { store: boolean; filterStrong: boolean } => ({
  store,
  filterStrong: store || prefs.filterStrong,
});

/**
 * Pots and standing orders (docs/POTS-SUBSCRIPTIONS-PLAN.md §5). Pots (labelled sub-accounts: fund, name,
 * cap, Stop/Resume) and standing orders to a person or paymail are P2P transfers, so they are in every build.
 */
export const potsEnabled = (_store = STORE_BUILD) => true;
export const standingOrdersEnabled = (_store = STORE_BUILD) => true;

/**
 * Subscriptions to apps and services (the own-service payees: bChat, $b agent; later "Subscribe with
 * bWalletX" requests, the bridge method, link handler and merchant cards): bWalletX only, absent from a
 * store build even as code (Apple 3.1.1, Play Payments). Literal env check so Vite inlines it and Rollup
 * drops the dead branches. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const SUBSCRIPTIONS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
export const subscriptionsEnabled = (store = STORE_BUILD) => !store;

/**
 * Pots in PNEEs (PR 128): a pot that holds PNEEs (dollar tokens) and pays standing orders in them. bWalletX only
 * (owner, 18 Oct 2026): a dollar-pegged token is kept out of the App Store and Play builds, so the "Pays in"
 * switch, the PNEE copy and the PNEE signing / overlay calls sit behind this literal env check and Rollup drops
 * them. Store builds treat every pot as a BSV pot. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const PNEE_POTS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * The bWalletX 1¢/day billing subscription: never in a store build. Outside one it still needs the signed
 * remote switch and the user's acceptance (config/remoteConfig.ts), and it is OFF today.
 */
export const BILLING_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
export const billingAllowed = (store = STORE_BUILD) => !store;

/**
 * User-visible text that differs in the store edition, which has no personal token / room, token rooms, paid
 * b agent or app/service subscriptions. Written as `STORE_BUILD ? … : …` on constants so Rollup folds them and
 * the bWalletX wording is not in the store bundle (storeBuild.test.ts checks both editions).
 */
export const handleCardText = (hasName: boolean): string =>
  STORE_BUILD
    ? 'A free handle people can pay.'
    : hasName
      ? 'Your personal token and a chat room only holders can enter.'
      : 'A free handle people can pay, plus your own chat room.';
export const MY_TOKENS_DESC = STORE_BUILD
  ? "Tokens this account has minted: list the ones that aren't listed yet"
  : "This account's tokens and their rooms: set up the ones that aren't listed yet";
export const MY_TOKENS_NOTE = STORE_BUILD
  ? 'Listing a token shows it in other wallets and the Market. You confirm the price before anything is sent.'
  : 'Setting up a token’s room lists it in other wallets and the Market and opens its chat room. You confirm the price before anything is sent.';
export const B_AGENT_DESC = STORE_BUILD ? 'Use your own AI key' : 'b, or use your own AI key';
export const SUBSCRIPTIONS_DESC = STORE_BUILD
  ? 'Regular payments to people, from pots you fill'
  : 'Regular payments from pots you fill';
export const POTS_INTRO = STORE_BUILD
  ? 'Put money aside in a pot and set up regular payments from it to a person or paymail. The pot balance is the most they can ever take. Payments go out when you open the app on or after each date; pause any time.'
  : 'Put money aside in a pot and set up subscriptions (regular payments) from it. The pot balance is the most they can ever take. Payments go out when you open the app on or after each date; pause any time.';
export const POT_NAME_PLACEHOLDER = STORE_BUILD ? 'Name (e.g. Rent, Savings)' : 'Name (e.g. Rent, bChat)';

/**
 * Phone layout (src/mobile/phone, docs/PHONE-LAYOUT-PLAN.md §8): swipe screens and dock items left out of a store
 * build. Exchange is the Market, which a store build does not have at all (MARKET_ENABLED above).
 */
export const STORE_HIDDEN_SCREENS: readonly string[] = ['exchange'];
export const screenShown = (id: string, store = STORE_BUILD) => !store || !STORE_HIDDEN_SCREENS.includes(id);
export const screensFor = <T extends { id: string }>(screens: readonly T[], store = STORE_BUILD): T[] =>
  screens.filter((s) => screenShown(s.id, store));
/** Dock items a store build may show: no hidden screens, and no app tile a store build hides (appsTileShown). */
export const dockItemsFor = <T extends { kind: string; id?: string; name?: string }>(
  items: readonly T[],
  store = STORE_BUILD,
): T[] =>
  items.filter((i) =>
    i.kind === 'screen' ? screenShown(i.id ?? '', store) : i.kind === 'app' ? appsTileShown(i.name ?? '', store) : true,
  );
/** Release B (People): no buying or selling a person's tokens or apps in a store build. */
export const peopleSellingEnabled = (store = STORE_BUILD) => !store;

/**
 * Media › "Add a release" (publish music / video as inscriptions): bWalletX only, absent from a store build
 * (creator publishing with paid mint fees). Listening to published releases stays on in both editions.
 */
export const RELEASES_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Media › pay-per-second streaming (the bMusic FIRST 12 demo, media/stream/): bWalletX only, absent from a store
 * build even as code (paying for digital content in-app: Apple 3.1.1, Play Payments). Literal env check so Vite
 * inlines it and Rollup drops the lazy StreamAlbum chunk and the session sweeper.
 */
export const PAY_STREAM_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * bMusic artist programme (docs/ARTIST-PROGRAMME.md): "Join as an artist", sponsored plays, sales share into the
 * listener pot, fan locks behind an artist. bWalletX only and OFF by default: it needs the bMusic server's
 * programme routes, which stay off until the owner says the server is clean (VITE_ARTIST_PROGRAMME=1 to show it).
 * Literal env checks so a store build and a default build drop the code.
 */
export const ARTIST_PROGRAMME_ENABLED: boolean =
  import.meta.env.VITE_ARTIST_PROGRAMME === '1' &&
  !(
    import.meta.env.VITE_STORE_BUILD === '1' ||
    import.meta.env.VITE_CHANNEL === 'ios-store' ||
    import.meta.env.VITE_CHANNEL === 'android-play'
  );

/** Network fees on us (docs/FEE-POT.md): OFF by default, never in a store build (VITE_FEE_POT=1 to try it). */
export const FEE_POT_ENABLED: boolean =
  import.meta.env.VITE_FEE_POT === '1' &&
  !(
    import.meta.env.VITE_STORE_BUILD === '1' ||
    import.meta.env.VITE_CHANNEL === 'ios-store' ||
    import.meta.env.VITE_CHANNEL === 'android-play'
  );

/**
 * bMint Notes (the banknote/coin designer at /bmint/notes): never in a store build, not even as code.
 * A designed "banknote", even minted as art, reads to reviewers as issuing currency (Apple 3.1.5, Play
 * financial services). Literal env check so Vite inlines it and Rollup drops the lazy import in
 * bmint/BmintPage.tsx. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const BMINT_NOTES_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * bShares, share registers for any company (docs/BCORP-PLACEMENT.md): the /m/bshares bApp, the Lock page Vault and the
 * Exchange "Shares" filter. Securities never ship in a store build, not even as code: the lazy imports are dropped.
 * Store grep: `bShares|BCORP-PLACEMENT|bcorp-placement|Restricted · not offered publicly|locked 2-of-2|Partnership shares|bwx partnership`.
 */
export const PLACEMENT_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * bMovies feed (Feed › bMovies: the vertical clip reel from bmovies.app): bWalletX only (web, desktop,
 * direct APK). Clips are tokenised pitches ("Tokenise this"), so the store build leaves it out even
 * as code. Literal env check so Vite inlines it and Rollup drops feed/bmovies/* and its registry
 * entry. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const BMOVIES_FEED_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * bCredits (prepaid credit for b, src/mobile/credits): bWalletX only, absent from a store build even as code
 * (prepaid credit for a digital service is IAP territory: Apple 3.1.1, Play Payments). Literal env check so Vite
 * inlines it and Rollup drops the lazy CreditsPanel chunk and the bCredits path in Ask b.
 */
export const BCREDITS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Feed › bExchange (the token reel: price, 24h change, sparkline, BUY / SELL): bWalletX only, absent from a store
 * build even as code (exchange functionality, Apple 3.1.5(iii); the same rejection as the Market). Literal env
 * check so Vite inlines it and Rollup drops feed/reels/BexReel and its Feed picker entry. Feed › bApps stays in
 * every build, but its Tokenise button (Launchpad) is behind MARKET_ENABLED. Same env as STORE_BUILD.
 */
export const BEX_REEL_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Balance cards (src/mobile/wallet/BalanceCarousel.tsx): the swipe carousel of real balances and the All cards
 * browser. bWalletX only; a lazy chunk behind this inlined flag, so the store bundle has none of it (not even its CSS).
 * Store grep: `bwCardLayer|bw-bcar-`.
 */
export const BALANCE_CARDS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * In-app "Update" for the Android direct APK (update/directUpdate.ts). Only the site
 * APK needs it: Play, the App Store, Ad Hoc iOS and the extension update themselves, and a store app may
 * not install code from outside the store. Literal env check so Vite inlines it and Rollup drops the
 * updater from every other build (STORE-AUDIT.md lists its strings for the store grep).
 */
export const DIRECT_UPDATE_ENABLED: boolean = import.meta.env.VITE_CHANNEL === 'android-direct';

/**
 * Room X invites (chat/xInvites.ts, XInvitesSheet, XInviteClaim): a room host pre-funds one-time keys with the
 * gate token and hands each invitee a link that carries the key. Token transfers that admit someone to a token
 * room, so bWalletX only (token rooms are off in a store build, STORE-AUDIT 2.1). Literal env check so Vite
 * inlines it and Rollup drops the lazy chunks. Store grep: `x-invites|Whoever opens this link|bwx.xinvites`.
 */
export const XINVITES_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * "Find people you follow on X" (wallet/XFollowsImport.tsx): on by default in bWalletX builds (bit-sign #295 live,
 * owner flag + cap set). VITE_X_FOLLOWS_IMPORT=0 turns it off; never in a store build. Still hides on a 404 'disabled'. Literal env
 * check so Vite inlines it and Rollup drops the lazy chunk. Store grep: `x-follows|Find people you follow on X`.
 */
export const X_FOLLOWS_IMPORT_ENABLED: boolean =
  import.meta.env.VITE_X_FOLLOWS_IMPORT !== '0' &&
  import.meta.env.VITE_STORE_BUILD !== '1' &&
  import.meta.env.VITE_CHANNEL !== 'ios-store' &&
  import.meta.env.VITE_CHANNEL !== 'android-play';

/**
 * Get your own theme (16 Oct 2026, `themeOrder/`): order a custom theme edition, $99 a year paid in BSV to bCorp.
 * Paying bCorp for a digital good is Apple 3.1.1 / Play Payments, so it is bWalletX only: the sheet is a lazy
 * chunk behind this literal env check and the store bundle has none of it. Same env as STORE_BUILD.
 */
export const THEME_ORDERS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Theme Store tabs beyond Free (16 Oct 2026, docs/THEME-STORE-PLAN.md): Premium (prices), Holders (token-gated
 * unlocks) and Editions (the $99 order link). Owner: store builds show Free themes only. `themeStore/PaidTabs.tsx`
 * is a lazy chunk behind this literal env check, so the store bundle has none of its text. Same env as STORE_BUILD.
 */
export const THEME_STORE_PAID_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Business agent account (agents/business/): a capped account derived from the owner's seed that a room's
 * business agent pays refunds from, with a daily limit and Stop. It moves money without a per-payment approval,
 * so it is bWalletX only and off in every store build (STORE-AUDIT.md). Literal env check so Vite inlines it and
 * Rollup drops the lazy BizAgentAccount chunk.
 */
export const BIZ_AGENT_ACCOUNT_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * bMail › Agreements (/m/bmail/agreements, was the Bureau at /m/bureau; code in src/mobile/bureau): agreements over
 * bMail (sign with the card signature + identity key, seal a hashes-only receipt on chain), the bMail Agreements box,
 * and the one-time "Import from bit-sign" view (Settings › Tools). bWalletX only (owner, 18 Oct 2026: the
 * desktop app's bureau); absent from a store build even as code. Literal env check so Vite inlines it and Rollup
 * drops the lazy AgreementsPage / AgreementsBox / BitSignImportPage chunks.
 * Store grep: `Review & sign|bwallet.bureau|Seal on chain|Import from bit-sign|bwallet agreement|Needs my signature`.
 */
/**
 * Company offers paid by signature (offer/, 24 Oct 2026): a director composes, the company account seals, the named
 * offeree signs to pay. bWalletX only, never in a store build, not even as code (payment for securities; no "buy
 * shares" anywhere). Literal env check so Rollup drops the lazy OffersPage. Inside bWalletX the screens show only to
 * the company's directors, the company account, and the named offeree of a received offer (offer/useOffers.ts).
 * VITE_OFFERS=0 turns it off in a bWalletX build too.
 */
export const OFFERS_ENABLED: boolean =
  !(
    import.meta.env.VITE_STORE_BUILD === '1' ||
    import.meta.env.VITE_CHANNEL === 'ios-store' ||
    import.meta.env.VITE_CHANNEL === 'android-play'
  ) && import.meta.env.VITE_OFFERS !== '0';

export const BUREAU_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Desktop menu / page titles (owner, 18 Oct 2026): "bSpaces" and "bPeople" in bWalletX; the store edition keeps
 * "Spaces" and "People" ("bSpaces" is on the STORE-AUDIT blocklist). Literal env check so the store bundle never
 * carries the string.
 */
export const SPACES_LABEL: string = BSPACES_ENABLED ? 'bSpaces' : 'Spaces';
export const PEOPLE_LABEL: string = BSPACES_ENABLED ? 'bPeople' : 'People';

/**
 * bTrust (recovery slices, heirs, check-in, co-sign on BSV; owner, 23 Oct 2026): bWalletX only. Kept out of the
 * App Store / Google Play edition like the other money-management features. Literal so the store bundle drops it.
 */
export const BTRUST_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Greeting cards (23 Oct 2026, `cards/`, bwalletx.com/happy-b): Mint › Greeting card makes an AI card paid in BSV
 * to bCorp (the push server's quote), then mints, sends and wears it. Paying bCorp for a digital good is Apple
 * 3.1.1 / Play Payments, so it is bWalletX only: `cards/CardMaker.tsx` is a lazy chunk behind this literal env
 * check, and the Mint tile is behind it too. Same env as STORE_BUILD.
 */
export const GREETING_CARDS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Spicy (18+) image generation in the card / image maker: never in a store build, not even as text (Apple 1.1.4,
 * Play sexual content). Literal env check so Rollup drops `cards/spicy` UI strings. On web it also needs the
 * user's own 18+ switch (cards/spicy.ts). Same env as STORE_BUILD.
 */
export const SPICY_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Names, Rooms and Tickets (owner, 24 Oct 2026): the parts the bit-sign server doesn't support yet (a room
 * inside another room, tickets attached to a room, several tickets per room, burn on entry, collection
 * tickets, "already have one" lookups by identity key). OFF by default: build with VITE_NRT=1 to try it
 * (NAMES-ROOMS-TICKETS-SERVER-SPEC.md). Never in a store build: tickets are token sales / token-gated access.
 * Literal env check so Vite inlines it and Rollup drops the TicketsSheet chunk.
 */
export const NRT_ENABLED: boolean =
  import.meta.env.VITE_NRT === '1' &&
  !(
    import.meta.env.VITE_STORE_BUILD === '1' ||
    import.meta.env.VITE_CHANNEL === 'ios-store' ||
    import.meta.env.VITE_CHANNEL === 'android-play'
  );

/**
 * Envelopes (services/envelopes.ts, #87): a site's earmark it may spend from without a sheet, the Settings ›
 * Envelopes page, Coin return and the envelope offer on pay sheets. bWalletX only: store builds leave out
 * envelopes and streaming payments (Apple 3.1.1, Play Payments). In a store build a site's
 * requestSpendingAuthorization is refused as unsupported and every payment shows its sheet. Literal env check so
 * Vite inlines it and Rollup drops the envelope pages, presets and handlers.
 */
export const ENVELOPES_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
