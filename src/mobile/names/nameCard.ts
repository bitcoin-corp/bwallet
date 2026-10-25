/**
 * The Name card (owner, 25 Oct 2026): an application/op-ns NFT explained in plain English, with its status and what
 * the holder can do with it. Pure helpers here; the view is OpnsNameActions.tsx.
 */
import { bavatarSvg } from '../bavatar/bavatar';
import { PAYMAIL_ALIAS_RE } from './paymail';
import { personalKey, personalTicker, type PersonalLink } from './personalToken';

/** One plain sentence: what this thing is. */
export const nameIntro = (name: string) =>
  `This is the name ${name}. You own it on the Bitcoin SV blockchain, and it works like a web domain or a username you hold yourself.`;

/** A short address for people ("1CqJ…tsvX"); $names and paymails are kept whole. */
export const shortFrom = (from: string) =>
  /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(from) ? `${from.slice(0, 4)}…${from.slice(-4)}` : from;

/**
 * Who it came from, in human terms. `inNames` = it sits in the wallet's OpNS names basket, which only mints and buys
 * fill; a name that arrived from someone else lands with the NFTs instead.
 */
export const nameOrigin = (o: { inNames?: boolean; from?: string | null }) =>
  o.from ? `A gift from ${shortFrom(o.from)}` : o.inNames ? 'You minted or bought this' : 'Sent to your wallet';

/** The $handle paymail this name would be, or null when a paymail alias can't take it (too long, odd characters). */
export const handlePaymail = (name: string, domain: string) =>
  domain && PAYMAIL_ALIAS_RE.test(name) ? `${name}@${domain}` : null;

export type NameChip = { key: 'idkey' | 'handle' | 'room' | 'token'; label: string; on: boolean };

/** Status chips: identity key linked, used as the $handle, room open, token launched. */
export const nameChips = (s: {
  name: string;
  /** opns:published on the wallet's copy (registerOpns signed the identity key onto it). */
  published: boolean;
  /** This wallet's current paymail. */
  paymail: string;
  domain: string;
  /** The wallet's personal token link (personalToken.ts), when it was minted under this name. */
  link: PersonalLink | null;
}): NameChip[] => {
  const pm = handlePaymail(s.name, s.domain);
  const own = !!s.link && personalKey(s.link.name) === s.name;
  return [
    { key: 'idkey', label: 'Identity key', on: s.published },
    { key: 'handle', label: '$handle', on: !!pm && s.paymail.toLowerCase() === pm },
    { key: 'room', label: 'Room', on: own && !!s.link?.roomTicker },
    { key: 'token', label: 'Token', on: own },
  ];
};

/** TokenBlaster's launch page, prefilled with the name and its ticker. */
export const tokenblasterLaunchUrl = (name: string) => {
  const q = new URLSearchParams({ name });
  const t = personalTicker(name);
  if (t) q.set('ticker', t);
  return `https://www.tokenblaster.lol/launch?${q.toString()}`;
};

/** The gold bAvatar seeded by this name, as a data URL for the account picture. */
export const nameBavatarUri = (name: string) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(name, { size: 256, label: name }));
