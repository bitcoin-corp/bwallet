import type { ReactNode } from 'react';
import { trueHost, type WornTheme } from './connectSiteTheme';
import { STRIP, useSiteTheme } from './useSiteTheme';

/**
 * The approval sheet's frame (docs/SITE-THEME.md). On top, always, the wallet's own strip: fixed colours, the true
 * origin host from the request, never from the site's theme. Under it, when the user has connected this site and
 * left its theme on, a banner in the site's colours with its logo. The sheet itself (amounts, recipients,
 * warnings, Approve / Deny) is the children, untouched: a theme can only dress the frame around it.
 */

export const OriginStrip = ({ originator, themed }: { originator: string; themed: boolean }) => (
  <div
    data-testid="bwx-origin-strip"
    className="flex items-center gap-2 px-3"
    style={{
      background: STRIP.bg,
      color: STRIP.text,
      borderBottom: `1px solid ${STRIP.line}`,
      minHeight: 32,
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 12,
      flexShrink: 0,
    }}
  >
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden fill="none" stroke={STRIP.gold} strokeWidth="2.5">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
    <span style={{ color: STRIP.muted }}>bWalletX · request from</span>
    <span className="font-bold truncate" style={{ color: STRIP.text }}>
      {trueHost(originator)}
    </span>
    {themed && (
      <span className="ml-auto whitespace-nowrap" style={{ color: STRIP.muted, fontSize: 10 }}>
        site theme
      </span>
    )}
  </div>
);

export const SiteThemeBanner = ({ theme, originator }: { theme: WornTheme; originator: string }) => (
  <div
    data-testid="bwx-site-banner"
    className="flex items-center gap-3 px-4"
    style={{
      background: theme.artData
        ? `linear-gradient(90deg, ${theme.bg} 35%, ${theme.bg}99), url("${theme.artData}") center / cover`
        : `linear-gradient(135deg, ${theme.bg}, ${theme.surface})`,
      color: theme.text,
      borderBottom: `3px solid ${theme.accent}`,
      minHeight: 60,
      flexShrink: 0,
    }}
  >
    {theme.logoData ? (
      <img src={theme.logoData} alt="" width={36} height={36} style={{ borderRadius: 8, objectFit: 'contain' }} />
    ) : (
      <span
        aria-hidden
        className="flex items-center justify-center font-bold"
        style={{ width: 36, height: 36, borderRadius: 8, background: theme.accent, color: theme.onAccent }}
      >
        {theme.name.slice(0, 1).toUpperCase()}
      </span>
    )}
    <div className="min-w-0">
      <div className="font-bold truncate" style={{ fontSize: 15, color: theme.text }}>
        {theme.name}
      </div>
      <div className="truncate" style={{ fontSize: 11, color: theme.accentHi }}>
        Connected with bWalletX · {trueHost(originator)}
      </div>
    </div>
  </div>
);

/** Wraps an approval sheet. `originator` comes from the request (checked by the background), never from a theme. */
export const SiteThemeFrame = ({
  originator,
  children,
  theme: given,
}: {
  originator: string | undefined;
  children: ReactNode;
  /** For previews and tests; normally loaded for the originator. */
  theme?: WornTheme | null;
}) => {
  const loaded = useSiteTheme(given === undefined ? originator : undefined);
  const theme = given === undefined ? loaded : given;
  if (!originator) return <>{children}</>;
  return (
    <div
      className="flex flex-col w-full h-full"
      style={theme ? { boxShadow: `inset 3px 0 0 ${theme.accent}, inset -3px 0 0 ${theme.accent}` } : undefined}
    >
      <OriginStrip originator={originator} themed={!!theme} />
      {theme && <SiteThemeBanner theme={theme} originator={originator} />}
      <div className="flex-1 min-h-0 flex items-center justify-center relative">{children}</div>
    </div>
  );
};
