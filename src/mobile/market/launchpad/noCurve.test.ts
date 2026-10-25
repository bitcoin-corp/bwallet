import { describe, expect, it } from 'bun:test';
import { earnUrl, isNoCurve, safeEarnUrl, TERRORNODE_GAME_URL } from './noCurve';

const T = 'd5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1';
const OTHER = `${'a'.repeat(64)}_1`;

describe('noCurve', () => {
  it('uses the local list as fallback', () => {
    expect(isNoCurve(T)).toBe(true);
    expect(earnUrl(T)).toBe(TERRORNODE_GAME_URL);
    expect(isNoCurve(OTHER)).toBe(false);
    expect(earnUrl(OTHER)).toBeNull();
  });
  it('reads trading:false and earn_url from the API', () => {
    const coin = { trading: false, earn_url: 'https://www.tokenblaster.lol/arcade/x' };
    expect(isNoCurve(OTHER, coin)).toBe(true);
    expect(earnUrl(OTHER, coin)).toBe('https://www.tokenblaster.lol/arcade/x');
    expect(isNoCurve(OTHER, { trading: true })).toBe(false);
  });
  it('rejects unsafe earn urls', () => {
    expect(safeEarnUrl('http://www.tokenblaster.lol/a')).toBeNull();
    expect(safeEarnUrl('https://evil.com/a')).toBeNull();
    expect(safeEarnUrl('javascript:alert(1)')).toBeNull();
    expect(earnUrl(T, { earn_url: 'https://evil.com' })).toBe(TERRORNODE_GAME_URL);
  });
});
