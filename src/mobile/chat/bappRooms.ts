/**
 * bApps and their rooms: the one registry for the Chat tab's "bApps" filter and /chat/bapps.
 *
 * Owner, 18 Oct 2026: every bApp's room is VISIBLE to everyone, and walking in costs a penny ticket
 * (~1¢). Free entry gave no reason to care about the room; a 1p ticket is low friction and makes you
 * a member. How the ticket is paid (BappTicket.tsx):
 *   - the bApp's token is launched + indexed and its issuer has curve sales open → buy ONE curve
 *     listing (~1¢, the personal-token model: gentle curve on unique holders, Supporter #n badge,
 *     peer-to-peer resale only). Holding the token is membership (its room is token-gated);
 *   - otherwise → a 1¢ door fee straight to the room's payee (bit-sign /rooms/[ticker]/ticket).
 *
 * Rooms carry no app/brand marker bWalletX reads, so this list is the source of truth. BMOVIES is a bApp
 * ticker (kept out of "Rooms"); its card is back with the ONE MODEL overhaul (BMOVIES_ONE_MODEL, bmovies-ONE-MODEL.md):
 * the card's site is bmovies.app, and each film's own room is its $TICKER room, linked from /film/<TICKER>. BMUSICX is
 * the $BMUSICX holders' room. The Help Desk (LOUNGE) is not a bApp room: it stays the pinned card.
 */
import bradioIcon from '../brand/bradio-icon.png';
import bmusicIcon from '../brand/bmusic-icon.png';
import bmailIcon from '../brand/apps/bmail.png';
import bcalIcon from '../brand/apps/bcal.png';
import bjobsIcon from '../brand/apps/bjobs.png';
import bstoreIcon from '../brand/apps/bstore.png';
import bnewsIcon from '../brand/apps/bnews.svg';
import { bappIconUrl } from '../brand/bappIcons';
import { BMOVIES_ONE_MODEL, BMOVIES_ORIGIN } from '../feed/bmovies/bmovies';

/** A bApp token's default sale terms: the personal-token curve (exchange/curveSales.ts), so a launch picks it up. */
export interface BappCurve {
  mode: 'curve';
  /** First listing's price, US cents. */
  start_usd_cents: number;
  /** Price doubles every this many unique holders (1¢ × 2^(holders/step)). */
  step_holders: number;
  /** Tokens per listing. */
  pack: number;
  /** A ticket is one listing per person. */
  max_per_buyer: number;
}

export const BAPP_DEFAULT_CURVE: BappCurve = {
  mode: 'curve',
  start_usd_cents: 1,
  step_holders: 1000,
  pack: 1,
  max_per_buyer: 1,
};

export interface Bapp {
  id: string;
  name: string;
  /** Bundled icon; null → gold bAvatar art seeded by the ticker (gold-by-default). */
  icon: string | null;
  purpose: string;
  /** The bApp's own site, when it has one. */
  site: string | null;
  /** Its room's ticker in bit-sign. */
  ticker: string;
  /** Its BSV-21 token id once launched AND indexed; null → the ticket is a 1¢ door fee. */
  tokenId: string | null;
  curve: BappCurve;
}

const bapp = (b: Omit<Bapp, 'tokenId' | 'curve'> & Partial<Pick<Bapp, 'tokenId' | 'curve'>>): Bapp => ({
  tokenId: null,
  curve: BAPP_DEFAULT_CURVE,
  ...b,
});

export const BAPPS: readonly Bapp[] = [
  bapp({
    id: 'bradio',
    name: 'bRadio',
    icon: bradioIcon,
    purpose: 'Live shows, interviews and podcasts.',
    site: 'https://bradiox.com',
    ticker: 'BRADIO',
  }),
  bapp({
    id: 'bmusic',
    name: 'bMusic',
    icon: bmusicIcon,
    purpose: 'New tracks, listening parties and the artists behind them.',
    site: 'https://bmusicx.com',
    ticker: 'BMUSIC',
  }),
  bapp({
    id: 'bmail',
    name: 'bMail',
    icon: bmailIcon,
    purpose: 'Tokenised mail, price-to-reach and inbox tips.',
    site: 'https://bmailx.com',
    ticker: 'BMAIL',
  }),
  bapp({
    id: 'bcal',
    name: 'bCal',
    icon: bcalIcon,
    purpose: 'Paid bookings, shared calendars and what’s on.',
    site: 'https://bcalx.com',
    ticker: 'BCAL',
  }),
  bapp({
    id: 'bstore',
    name: 'bStore',
    icon: bstoreIcon,
    purpose: 'Themes, icons and packs for bWalletX, and their makers.',
    site: null,
    ticker: 'BSTORE',
  }),
  bapp({
    id: 'bjobs',
    name: 'bJobs',
    icon: bjobsIcon,
    purpose: 'Micro-jobs for people and agents, paid on completion.',
    site: 'https://bjobsx.com',
    ticker: 'BJOBS',
  }),
  bapp({
    id: 'bnews',
    name: 'bNews',
    icon: bnewsIcon,
    purpose: 'The stories on chain today, and the talk around them.',
    site: 'https://bnewsx.com',
    ticker: 'BNEWS',
  }),
  ...(BMOVIES_ONE_MODEL
    ? [
        bapp({
          id: 'bmovies',
          name: 'bMovies',
          icon: bappIconUrl('bmovies'),
          purpose: 'Films you can watch, back and hold. Each film has its own $TICKER room.',
          site: BMOVIES_ORIGIN,
          ticker: 'BMOVIES',
        }),
      ]
    : []),
];

/** The one film page for a film room's ticker (ONE MODEL): rooms link here, and the film page links back. */
export const bmoviesFilmUrl = (ticker: string): string => `${BMOVIES_ORIGIN}/film/${encodeURIComponent(norm(ticker))}`;

/** Tickers kept out of "Rooms" and shown under "bApps": the registry, plus bMovies and $BMUSICX holders. */
export const BAPP_ROOM_TICKERS: readonly string[] = [...new Set([...BAPPS.map((b) => b.ticker), 'BMOVIES', 'BMUSICX'])];

const norm = (t: string | null | undefined) => (t ?? '').replace(/^\$/, '').toUpperCase();

export const isBappRoom = (ticker: string | null | undefined): boolean => BAPP_ROOM_TICKERS.includes(norm(ticker));

export const bappForTicker = (ticker: string | null | undefined): Bapp | null =>
  BAPPS.find((b) => b.ticker === norm(ticker)) ?? null;
