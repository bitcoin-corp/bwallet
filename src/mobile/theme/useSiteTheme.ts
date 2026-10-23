import { useEffect, useState } from 'react';
import { CONNECT_THEME_EVENT, loadConnectTheme, shouldWearSiteTheme, type WornTheme } from './connectSiteTheme';

// The wallet's strip: constants on purpose, so no theme (site or user) can restyle it.
export const STRIP = { bg: '#0B0B0D', text: '#FFFFFF', muted: '#98A2B3', gold: '#F5C542', line: '#2B2F36' } as const;

export function useSiteTheme(originator: string | undefined): WornTheme | null {
  const [theme, setTheme] = useState<WornTheme | null>(null);
  useEffect(() => {
    if (!originator) return;
    let live = true;
    const refresh = () => {
      if (!shouldWearSiteTheme(originator)) {
        setTheme(null);
        return;
      }
      void loadConnectTheme(originator).then((t) => live && setTheme(t));
    };
    refresh();
    window.addEventListener(CONNECT_THEME_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      live = false;
      window.removeEventListener(CONNECT_THEME_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [originator]);
  return theme;
}
