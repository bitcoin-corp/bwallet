import { ACCENTS, EDITION_PACKS, RETIRED_PACKS, type AccentId } from './accents';

/**
 * Connected-site themes (owner, 23 Oct 2026: "whenever bWalletX connects to a site that declares a theme, the wallet
 * switches to that site's theme, and reverts when disconnected or on another origin").
 *
 * A site declares a theme by id, e.g. `<meta name="bwalletx-theme" content="npgx">` (@bwalletx/connect writes it
 * from its `theme` option). The wallet only ever paints a pack it already bundles (accents.ts): the id picks one,
 * it never carries colours, CSS, fonts or URLs. The theme is worn only while that site is the active tab and has
 * made a wallet request; it is never saved to the account, so the user's own theme comes back on any other origin.
 *
 * Artist / brand editions are locked to their own sites, so another site can't dress the wallet as NPGX or VexVoid.
 */
export const SITE_THEME_META = 'bwalletx-theme';

/** Edition pack → the hosts (and their www.) that may wear it. An edition missing here is worn by no site. */
export const EDITION_HOSTS: Readonly<Record<string, readonly string[]>> = {
  npgx: ['ninjapunkgirlsx.com', 'npg-x.com', 'npgx.website'],
  npg: ['ninjapunkgirls.com', 'ninjapunkgirls.store'],
  vexvoid: ['vexvoid.com', 'vexvoid.store', 'v01d.store'],
  // Hosts only (the meta has no path scope): on bChatX and bMovies only her own pages (/u/leannethedark, her store)
  // put the meta up; every other page there declares its own pack or none.
  leannethedark: ['leannethedark.website', 'bchatx.com', 'chat.bwalletx.com', 'bmovies.app'],
};

const ID = /^[a-z0-9-]{1,32}$/;

/** The host of an https origin (no port, no credentials), lower-case, without a leading www. Null otherwise. */
export function originHost(origin: string | null | undefined): string | null {
  try {
    const u = new URL(origin ?? '');
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch {
    return null;
  }
}

/**
 * The bundled pack a site may wear, or null. `declared` comes from the page, `origin` from Chrome (never the page).
 */
export function siteThemeFor(origin: string | null | undefined, declared: unknown): AccentId | null {
  if (typeof declared !== 'string') return null;
  const want = declared.trim().toLowerCase();
  if (!ID.test(want) || want === 'custom') return null;
  const host = originHost(origin);
  if (!host) return null;
  const id = RETIRED_PACKS[want] ?? want;
  const pack = ACCENTS.find((a) => a.id === id);
  if (!pack) return null;
  if (EDITION_PACKS.some((e) => e.id === pack.id)) {
    return (EDITION_HOSTS[pack.id] ?? []).includes(host) ? pack.id : null;
  }
  return pack.id;
}
