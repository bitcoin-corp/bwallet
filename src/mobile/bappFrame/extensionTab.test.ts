import { describe, expect, test } from 'bun:test';
import { originPattern } from './extensionTab';

describe('originPattern', () => {
  test('matches the whole origin', () => {
    expect(originPattern('https://www.bchatx.com/r/NPG?x=1')).toBe('https://www.bchatx.com/*');
  });
  test('rejects non-web urls', () => {
    expect(originPattern('/m/bmint')).toBeNull();
    expect(originPattern('javascript:alert(1)')).toBeNull();
  });
});
