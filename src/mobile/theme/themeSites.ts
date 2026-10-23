/**
 * The owner's family sites that may offer a bWalletX theme (docs/SITE-THEMES.md). A copy of site/lib/themeSites.js
 * (served at bwalletx.com/api/theme-sites); themeSites.test.ts keeps the two equal. Only these hosts are ever asked
 * for /.well-known/bwalletx-theme.json, so a random page can't push colours into the wallet.
 */
export interface ThemeSite {
  /** The id the site's theme file must carry. */
  id: string;
  host: string;
}

export const THEME_SITES: readonly ThemeSite[] = [
  { id: 'bwalletx', host: 'bwalletx.com' },
  { id: 'bwalletx-web', host: 'web.bwalletx.com' },
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
  { id: 'tokenblaster', host: 'tokenblaster.com' },
  { id: 'bchatx', host: 'bchatx.com' },
];

/** Other hosts that serve the same deployment as a family site (same theme file): chat.bwalletx.com is bChatX. */
const SITE_ALIASES: Record<string, string> = { 'chat.bwalletx.com': 'bchatx.com' };

/**
 * The family site for a URL or bare host (connect requests carry a host, the browser a URL): the exact host or its
 * www. subdomain. A URL must be https. Ports, other subdomains and look-alikes don't match.
 */
export function familySite(urlOrHost: string | null | undefined): ThemeSite | null {
  const raw = (urlOrHost ?? '').trim();
  if (!raw) return null;
  let host: string;
  if (raw.includes('://')) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
      host = u.hostname;
    } catch {
      return null;
    }
  } else {
    if (!/^[a-z0-9.-]+$/i.test(raw)) return null;
    host = raw;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  host = SITE_ALIASES[host] ?? host;
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  return THEME_SITES.find((s) => s.host === bare) ?? null;
}
