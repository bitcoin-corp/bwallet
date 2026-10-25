import { describe, expect, test } from 'bun:test';
import { PNEE_ICON, PNEE_TOKEN_ID } from '../notes/pnee';
import { officialToken, placeholderTokenIcon, tokenIconUrl } from './officialTokens';
import { issuerLabel, verifyIssuer } from '../issuer/issuerVerify';

const FAKE = 'aa'.repeat(32) + '_0';

describe('official tokens', () => {
  test('official PNEE (exact id, any case/separator) gets the PNEE art', () => {
    expect(officialToken(PNEE_TOKEN_ID)?.icon).toBe(PNEE_ICON);
    expect(tokenIconUrl(PNEE_TOKEN_ID.toUpperCase().replace('_', '.'), 'PNEE', null)).toBe(PNEE_ICON);
  });
  test('a lookalike "PNEE" with another id never gets the official art', () => {
    const url = tokenIconUrl(FAKE, 'PNEE', null);
    expect(url).not.toBe(PNEE_ICON);
    expect(url).toBe(placeholderTokenIcon('PNEE'));
    expect(decodeURIComponent(url)).toContain('>P</text>');
    expect(decodeURIComponent(url)).not.toMatch(/#(d4af37|FFC93C|F29A1F)/i);
  });
  test('on-chain icon wins for other tokens; placeholder is never blank', () => {
    expect(tokenIconUrl(FAKE, 'X', 'abc_0')).toContain('/abc_0');
    expect(tokenIconUrl(FAKE, '', null)).toContain('data:image/svg+xml');
    expect(decodeURIComponent(placeholderTokenIcon('<b'))).not.toContain('<b');
  });
  test('official PNEE shows as verified without fetching the mint tx', async () => {
    const f = (() => {
      throw new Error('no fetch');
    }) as unknown as typeof fetch;
    const i = await verifyIssuer(PNEE_TOKEN_ID, f);
    expect(i.status).toBe('verified');
    expect(issuerLabel(i)).toEqual({ text: 'Issued by bWalletX · official', verified: true });
  });
});
