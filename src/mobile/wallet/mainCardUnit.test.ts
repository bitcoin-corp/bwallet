import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cardBsv, MAIN_CARD_UNIT } from './walletCardText';
import { cardValueText } from './cardValue';

const read = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8');

// Owner, 25 Oct 2026: "$b" appears on the main wallet card only; everything else still says "BSV".
describe('main wallet card unit', () => {
  test('cardBsv defaults to BSV and takes the main card label', () => {
    expect(MAIN_CARD_UNIT).toBe('$b');
    expect(cardBsv(1234567)).toBe('BSV 0.01234567');
    expect(cardBsv(1234567, MAIN_CARD_UNIT)).toBe('$b 0.01234567');
  });

  test('the main card (WalletCard) uses $b for its amount and switch', () => {
    const src = read('WalletCard.tsx');
    expect(src).not.toMatch(/cardBsv\(animSats\)/);
    expect(src).toContain('cardBsv(animSats, MAIN_CARD_UNIT)');
    expect(src).toContain('<CardUnitSwitch fx={fx} bsvLabel={MAIN_CARD_UNIT} />');
  });

  test('other cards keep BSV', () => {
    expect(read('CardUnitSwitch.tsx')).toContain("bsvLabel = 'BSV'");
    expect(read('BalanceCarousel.tsx')).toContain('<CardUnitSwitch fx={ctx.fx} />');
    expect(cardValueText({ usd: 0, sats: 1e8, unpriced: 0 }, 'bsv', 50, { code: 'USD', rate: 1 } as never)).toBe(
      'BSV 1.00',
    );
  });
});
