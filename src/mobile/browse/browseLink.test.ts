import { describe, expect, test } from 'bun:test';
import { parseBrowseLink } from './browseLink';

const T = 'https://www.tokenblaster.lol/terrornode?x=1';
const enc = encodeURIComponent(T);

describe('Open in bWallet browse links', () => {
  test('the universal link and the app scheme open an https page', () => {
    expect(parseBrowseLink(`https://www.bwallet.space/browse?url=${enc}`)).toBe(T);
    expect(parseBrowseLink(`https://bwallet.space/browse?url=${enc}`)).toBe(T);
    expect(parseBrowseLink(`bwalletx://browse?url=${enc}`)).toBe(T);
  });
  test('ATTACK: only https targets, no userinfo, only our link shapes', () => {
    for (const u of [
      'http://www.tokenblaster.lol/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'bwalletx://pair?v=1',
      'https://user:pw@www.tokenblaster.lol/',
      `https://${'a'.repeat(2100)}.example/`,
      'nope',
    ])
      expect(parseBrowseLink(`https://www.bwallet.space/browse?url=${encodeURIComponent(u)}`)).toBeNull();
    expect(parseBrowseLink(`https://evil.example/browse?url=${enc}`)).toBeNull();
    expect(parseBrowseLink(`https://www.bwallet.space/browsex?url=${enc}`)).toBeNull();
    expect(parseBrowseLink(`bwalletx://social?url=${enc}`)).toBeNull();
    expect(parseBrowseLink('https://www.bwallet.space/browse')).toBeNull();
    expect(parseBrowseLink(null)).toBeNull();
  });
});
