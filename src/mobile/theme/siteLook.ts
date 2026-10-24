import { BASE_LOOK, type Accent } from './accents';
import { contrast, ensureContrast, mix } from './colour';
import {
  CONNECT_THEME_EVENT,
  loadConnectTheme,
  rememberSitePath,
  shouldWearSiteTheme,
  type WornTheme,
} from './connectSiteTheme';
import { wearSiteLook } from './accent';

/**
 * The whole extension view in a connected site's colours (docs/SITE-THEME.md "The whole view"). Built only from a
 * theme that already passed parseConnectTheme (#RRGGBB colours, contrast checked): no CSS, fonts or images from the
 * site reach the page. Derived shades are checked again so secondary text stays readable.
 */
export function siteLookAccent(t: WornTheme): Accent {
  const light = t.mode === 'light';
  const lifted = mix(t.surface, t.text, 0.06);
  const surface2 = contrast(t.text, lifted) >= 4.5 ? lifted : t.surface;
  return {
    ...BASE_LOOK,
    id: 'custom',
    kind: 'theme',
    label: t.name,
    scheme: t.mode,
    ...(light ? { paper: true } : {}),
    accent: t.accent,
    hi: t.accentHi,
    lo: mix(t.accent, t.bg, 0.3),
    on: t.onAccent,
    bg: t.bg,
    surface: t.surface,
    surface2,
    nav: t.bg,
    text: t.text,
    muted: ensureContrast(mix(t.text, t.surface, 0.35), [t.bg, t.surface, surface2], 4.5),
    line: mix(t.surface, t.text, 0.15),
  };
}

let shown: string | null = null;
let shownPath: string | null = null;
let seq = 0;

/**
 * The panel's active tab is this connected site (origin from Chrome via the background), or null. Wears its look
 * while the user has the site connected and its theme switched on; anything else puts the user's own theme back.
 */
export async function wearActiveSite(origin: string | null, path: string | null = null): Promise<void> {
  shown = origin;
  shownPath = path;
  if (origin) rememberSitePath(origin, path);
  const mine = ++seq;
  if (!origin || !shouldWearSiteTheme(origin)) return wearSiteLook(null);
  const t = await loadConnectTheme(origin, { path }).catch(() => null);
  if (mine !== seq) return;
  wearSiteLook(t ? siteLookAccent(t) : null);
}

// A switch flipped, a site revoked, or its theme arrived: look again.
if (typeof window !== 'undefined') {
  try {
    window.addEventListener(CONNECT_THEME_EVENT, () => void wearActiveSite(shown, shownPath));
  } catch {
    /* no window */
  }
}
