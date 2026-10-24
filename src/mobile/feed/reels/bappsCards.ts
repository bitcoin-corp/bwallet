/**
 * Feed › bApps: a full-screen reel with one card per app in the bApps store (bapps.ts). Pure helpers here; the
 * view is BappsReel.tsx. Owner, 15 Oct 2026: apps are the meta. Each card shows the app (static: icon, plain
 * line, facts, and pages to swipe sideways; no live site in the reel), its builder and one line, then Open (the wallet's restricted bApp frame), Comment, Tip, Contribute
 * (open-source apps only) and Tokenise (the builder only, to the Launchpad prefilled).
 *
 * Sorts are neutral and user-chosen: New, Most paid to builder (rank-by-paying-artists: the total paid to the
 * builder, linear, no self-pay; 0 until the server reports it), A–Z.
 */
import type { BApp } from '../../bapps';
import { MARKET_ENABLED } from '../../storeBuild';

/** Who built an app. Our own suite is built by Bitcoin Corp, paid at the owner's handle. */
export type Builder = { name: string; handle?: string; paymail?: string };

export const BCORP_BUILDER: Builder = { name: 'Bitcoin Corp', handle: 'b0asex', paymail: 'b0asex@bwalletx.com' };

export type AppCard = {
  id: string;
  name: string;
  url: string;
  verb: string;
  icon?: string;
  /** GitHub repo (open source): shows Contribute. */
  source?: string;
  /** Runs in the bApp frame (false: the site refuses framing, so no live preview either). */
  frameable: boolean;
  /** An in-wallet route ('/m/…') rather than a website. */
  internal: boolean;
  builder: Builder;
  /** Position in the store list: lower = added earlier (the store has no dates yet). */
  order: number;
  /** Sats paid to the builder through tips on this app (server tally; 0 until reported). */
  paidSats: number;
  demo: boolean;
  /** Plain-English line: what the app does (BAPP_ABOUT; falls back to the verb). */
  about: string;
};

export type AppSort = 'new' | 'paid' | 'az';

export const APP_SORTS: readonly { id: AppSort; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'paid', label: 'Most paid to builder' },
  { id: 'az', label: 'A–Z' },
];

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Store entries → cards, in store order. */
export const appCards = (apps: readonly BApp[], paid: Record<string, number> = {}): AppCard[] =>
  apps.map((a, i) => {
    const id = slug(a.name);
    return {
      id,
      name: a.name,
      url: a.url,
      verb: a.verb,
      icon: a.icon,
      source: a.source,
      frameable: !a.noFrame && !a.url.startsWith('/'),
      internal: a.url.startsWith('/'),
      builder: BCORP_BUILDER,
      order: i,
      paidSats: Math.max(0, Number(paid[id]) || 0),
      demo: a.status === 'demo',
      about: BAPP_ABOUT[a.name] ?? a.verb,
    };
  });

/** Sorted copy. New = latest added first; Most paid = highest total paid (ties: A–Z); A–Z by name. */
export const sortApps = (cards: readonly AppCard[], sort: AppSort): AppCard[] => {
  const az = (a: AppCard, b: AppCard) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  const out = [...cards];
  if (sort === 'az') return out.sort(az);
  if (sort === 'paid') return out.sort((a, b) => b.paidSats - a.paidSats || az(a, b));
  return out.sort((a, b) => b.order - a.order);
};

/** Contribute: the repo link plus a prefilled "suggest an improvement" issue. Null for closed-source apps. */
export const contributeLinks = (c: Pick<AppCard, 'source' | 'name'>): { repo: string; suggest: string } | null => {
  const s = c.source?.trim();
  if (!s || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(s)) return null;
  const repo = s.replace(/\/$/, '');
  const title = encodeURIComponent(`Suggestion for ${c.name}`);
  const body = encodeURIComponent('What would make this app better?\n\n(Sent from the bWalletX bApps feed.)');
  return { repo, suggest: `${repo}/issues/new?title=${title}&body=${body}` };
};

/** Is the signed-in person this app's builder? Compares paymails ($name = name@bwalletx.com), case-insensitive. */
export const isBuilder = (b: Builder, myNames: readonly (string | null | undefined)[]): boolean => {
  const norm = (s: string) => {
    const t = s.trim().toLowerCase().replace(/^\$/, '');
    return t.includes('@') ? t : `${t}@bwalletx.com`;
  };
  const theirs = [b.handle, b.paymail].filter((x): x is string => !!x).map(norm);
  if (!theirs.length) return false;
  return myNames.some((n) => !!n && theirs.includes(norm(n)));
};

/** Query string the Launchpad reads to prefill its form (launch.ts launchPrefill). */
export const tokeniseQuery = (c: Pick<AppCard, 'name' | 'verb' | 'url' | 'internal'>): string => {
  const sp = new URLSearchParams();
  sp.set('name', c.name.slice(0, 64));
  sp.set('description', c.verb.slice(0, 500));
  if (!c.internal && c.url.startsWith('https://')) sp.set('website', c.url);
  sp.set('category', 'apps');
  return `?${sp.toString()}`;
};

/** Where Comment goes: the app's discussion on bChatX. */
export const commentUrl = (c: Pick<AppCard, 'id'>) => `https://www.bchatx.com/u/${encodeURIComponent(c.id)}`;

/**
 * Plain-English "what it does" for each bApp in the store (bapps.ts), shown on its reel card. One short line each,
 * kept to what the app does today (no promises). Keyed by the app's name; a test checks every bApp has one.
 */
export const BAPP_ABOUT: Readonly<Record<string, string>> = {
  bChatX: 'Group chats, live audio Spaces and feeds, with a room for every token.',
  bMoviesX: 'A feed of films and trailers you can watch, and back by buying their tokens.',
  bMusicX: 'Put your tracks on Bitcoin as tokens; fans who hold them help make the video.',
  bMintX: 'Design and mint your own tokens, notes and media on Bitcoin.',
  bTrust: 'Cut a secret into slices for people you trust, and pass your coins on to your heirs.',
  bPositive: 'Take a journey one day at a time, with three friends as witnesses. Private by default.',
  // Restricted, bWalletX only: the same literal env check as bapps.ts so the store bundle never carries it.
  ...(!(
    import.meta.env.VITE_STORE_BUILD === '1' ||
    import.meta.env.VITE_CHANNEL === 'ios-store' ||
    import.meta.env.VITE_CHANNEL === 'android-play'
  )
    ? {
        ['b' + 'SharesX']: 'Share registers for any company: register of members, director approvals, locked shares.',
      }
    : {}),
  Names: 'Pick a name on Bitcoin that people can pay and find you by.',
  bWriterX: 'A word processor that saves your documents on Bitcoin.',
  bSheets: 'Spreadsheets that save to Bitcoin.',
  bMailX: 'Email where senders can attach a payment and you can set a price to reach you.',
  bDriveX: 'Upload files to Bitcoin and share them.',
  bCalX: 'A calendar whose events are stored on Bitcoin.',
  bCode: 'A code editor for building apps on Bitcoin.',
  bJobsX: 'Post jobs and find work, paid in BSV.',
  bID: 'See and manage your on-chain identity.',
  bSearch: 'Search content stored on Bitcoin.',
  bDNS: 'Register names on Bitcoin and trade them.',
  bVideoX: 'Watch videos and publish your own.',
  bRadioX: 'Listen to Bitcoin radio stations, or run one.',
  bPhotos: 'Turn your photos into NFTs that can be traded.',
  bArt: 'Collect on-chain art and show it in a gallery.',
  bPaint: 'A paint app that inscribes what you make on Bitcoin.',
  b3D: 'Make 3D models and own them on Bitcoin.',
  bBooks: 'Read books, or publish your own.',
  bAgents: 'Set up AI agents and give each one a budget to spend.',
  bSocialX: 'Post and follow people on Bitcoin.',
  bGames: 'Play games where you can stake BSV.',
  ...(MARKET_ENABLED ? { bExchange: 'Trade tokens, with prices from several exchanges in one place.' } : {}),
  bMaps: 'A map of places that accept Bitcoin.',
};

/** One static page of a card's horizontal carousel. */
export type AppPage = { id: 'about' | 'do' | 'start'; title: string; lines: string[] };

/** Short facts under the name: where it runs, open source, demo, who built it. */
export const appFacts = (c: AppCard): string[] => {
  const f = [c.internal ? 'Inside your wallet' : c.frameable ? 'Opens in the wallet' : 'Opens full screen'];
  f.push('Free to open');
  if (c.source) f.push('Open source');
  if (c.demo) f.push('Demo');
  return f;
};

/** The carousel pages for one app: built from the registry, nothing made up. 3 pages each. */
export const appPages = (c: AppCard): AppPage[] => [
  { id: 'about', title: 'What it is', lines: [c.about, `Built by ${c.builder.name}.`] },
  {
    id: 'do',
    title: 'What you can do',
    lines: [c.verb + '.', c.source ? 'The code is public: you can read it and suggest changes.' : 'Closed source.'],
  },
  {
    id: 'start',
    title: 'How to start',
    lines: [
      'Tap Open.',
      c.internal
        ? 'It opens as a page in this wallet.'
        : 'It signs in with this wallet. You approve anything it asks for on one sheet.',
      'Opening is free. Anything that costs BSV asks you first.',
    ],
  },
];

/**
 * Which way a touch is moving, once it has moved far enough: 'x' (browse an app's pages), 'y' (next app), or
 * null (too small to tell). Horizontal wins only when clearly horizontal, so diagonal drags keep scrolling apps.
 */
export const swipeAxis = (dx: number, dy: number, threshold = 10): 'x' | 'y' | null => {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < threshold) return null;
  return ax > ay * 1.2 ? 'x' : 'y';
};
