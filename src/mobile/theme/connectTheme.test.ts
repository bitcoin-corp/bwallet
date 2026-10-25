import { describe, expect, it } from 'bun:test';
import { originHost, siteThemeFor } from './connectTheme';

describe('siteThemeFor', () => {
  it('lets NPGX wear its edition on its own hosts', () => {
    expect(siteThemeFor('https://www.ninjapunkgirlsx.com', 'npgx')).toBe('npgx');
    expect(siteThemeFor('https://npg-x.com', 'NPGX')).toBe('npgx');
  });

  it('refuses an edition on any other site', () => {
    expect(siteThemeFor('https://evil.example', 'npgx')).toBeNull();
    expect(siteThemeFor('https://ninjapunkgirlsx.com.evil.example', 'npgx')).toBeNull();
    expect(siteThemeFor('https://leannethedark.website', 'leannethedark')).toBe('leannethedark');
    expect(siteThemeFor('https://www.bchatx.com', 'leannethedark')).toBe('leannethedark');
    expect(siteThemeFor('https://bmovies.app', 'leannethedark')).toBe('leannethedark');
    expect(siteThemeFor('https://leannethedark.website.evil.example', 'leannethedark')).toBeNull();
    expect(siteThemeFor('https://bdnsx.com', 'leannethedark')).toBeNull();
    expect(siteThemeFor('https://bdnsx.com', 'vexvoid')).toBeNull();
  });

  it('lets any https site pick a plain bundled pack', () => {
    expect(siteThemeFor('https://example.com', 'pink')).toBe('pink');
  });

  it('refuses unknown ids, custom, non-strings and anything that is not a bare id', () => {
    expect(siteThemeFor('https://example.com', 'nope')).toBeNull();
    expect(siteThemeFor('https://example.com', 'custom')).toBeNull();
    expect(siteThemeFor('https://example.com', { accent: '#fff' })).toBeNull();
    expect(siteThemeFor('https://example.com', 'url(https://x)')).toBeNull();
    expect(siteThemeFor('https://example.com', '')).toBeNull();
  });

  it('refuses http, ports and missing origins', () => {
    expect(siteThemeFor('http://ninjapunkgirlsx.com', 'npgx')).toBeNull();
    expect(siteThemeFor('https://ninjapunkgirlsx.com:8443', 'npgx')).toBeNull();
    expect(siteThemeFor(undefined, 'pink')).toBeNull();
  });
});

describe('originHost', () => {
  it('strips www and lower-cases', () => {
    expect(originHost('https://WWW.NPG-X.com')).toBe('npg-x.com');
  });
});
