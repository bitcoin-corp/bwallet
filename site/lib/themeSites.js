// The owner's "family" sites (docs/SITE-THEMES.md): each may publish /.well-known/bwalletx-theme.json, and the
// wallet offers that theme (never applies it) when the site is opened in the wallet, signs in with bWalletX, or
// asks to connect. Only hosts on this list are ever fetched, so a random page can't push colours.
// Served read-only at /api/theme-sites. The wallet keeps a copy in src/mobile/theme/themeSites.ts (a test keeps
// the two equal). Match is the exact host or its www. subdomain, https only. id = the theme file's required id.
'use strict';

/** @type {{ id: string, host: string }[]} */
const THEME_SITES = [
  { id: 'bwalletx', host: 'bwalletx.com' },
  { id: 'bwalletx-web', host: 'web.bwalletx.com' },
  // Proxies to vexvoid.com/race; the race serves its own theme file at race.bwalletx.com later.
  { id: 'bacc-race', host: 'race.bwalletx.com' },
  { id: 'b0ase', host: 'b0ase.com' },
  { id: 'b0-x', host: 'b0-x.com' },
  { id: 'bdnsx', host: 'bdnsx.com' },
  { id: 'dnsdex', host: 'dns-dex.com' },
  { id: 'clawdex', host: 'claw-dex.com' },
  { id: 'repodex', host: 'repo-dex.com' },
  { id: 'gitdex', host: 'git-dex.com' },
  { id: 'bit-sign', host: 'bit-sign.online' },
  { id: 'bitdns', host: 'bitdns.website' },
  { id: 'path402', host: 'path402.com' },
  { id: 'path401', host: 'path401.com' },
  { id: 'path403', host: 'path403.com' },
  { id: 'box402', host: 'box402.com' },
  { id: 'vexvoid', host: 'vexvoid.com' },
  { id: 'vexvoid-store', host: 'vexvoid.store' },
  { id: 'v01d', host: 'v01d.store' },
  { id: 'npg', host: 'ninjapunkgirls.com' },
  { id: 'npg-store', host: 'ninjapunkgirls.store' },
  { id: 'npgx', host: 'npgx.website' },
  { id: 'bmovies', host: 'bmovies.online' },
  { id: 'bmovies-app', host: 'bmovies.app' },
  { id: 'tokenblaster', host: 'tokenblaster.com' },
  { id: 'bchatx', host: 'bchatx.com' },
];

module.exports = { THEME_SITES };
