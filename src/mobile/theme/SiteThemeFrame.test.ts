import { describe, expect, it } from 'bun:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteThemeFrame } from './SiteThemeFrame';
import { STRIP } from './useSiteTheme';
import type { WornTheme } from './connectSiteTheme';

const THEME: WornTheme = {
  origin: 'https://emberandbean.example',
  name: 'Ember & Bean',
  mode: 'dark',
  accent: '#E8B04A',
  accentHi: '#F6D08A',
  onAccent: '#000000',
  bg: '#0F2A1F',
  surface: '#173A2C',
  text: '#F5EBDD',
};

const stripOf = (html: string) => html.slice(html.indexOf('bwx-origin-strip'), html.indexOf('bwx-site-banner'));

describe('SiteThemeFrame', () => {
  it('shows the true origin in the fixed wallet strip, and the banner in the site colours', () => {
    const html = renderToStaticMarkup(
      h(SiteThemeFrame, { originator: 'emberandbean.example', theme: THEME }, h('button', null, 'Approve 0.001 BSV')),
    );
    const strip = stripOf(html);
    expect(strip).toContain('emberandbean.example');
    expect(strip).toContain(STRIP.bg);
    for (const c of [THEME.bg, THEME.accent, THEME.text, THEME.surface]) expect(strip).not.toContain(c);
    expect(html).toContain('bwx-site-banner');
    expect(html).toContain('Ember &amp; Bean');
    expect(html).toContain(THEME.accent);
  });

  it('never restyles the sheet itself (amounts, Approve)', () => {
    const html = renderToStaticMarkup(
      h(SiteThemeFrame, { originator: 'emberandbean.example', theme: THEME }, h('button', null, 'Approve 0.001 BSV')),
    );
    expect(html).toContain('<button>Approve 0.001 BSV</button>');
  });

  it('a theme name cannot replace the origin: the strip uses the request originator', () => {
    const html = renderToStaticMarkup(
      h(SiteThemeFrame, { originator: 'evil.example', theme: { ...THEME, name: 'bwalletx com' } }, h('span')),
    );
    expect(stripOf(html)).toContain('evil.example');
    expect(stripOf(html)).not.toContain('bwalletx com');
  });

  it('with no theme (off, not connected) only the wallet strip shows', () => {
    const html = renderToStaticMarkup(
      h(SiteThemeFrame, { originator: 'emberandbean.example', theme: null }, h('span')),
    );
    expect(html).toContain('bwx-origin-strip');
    expect(html).not.toContain('bwx-site-banner');
  });
});
