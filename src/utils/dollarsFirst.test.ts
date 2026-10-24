import { describe, expect, it } from 'bun:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DollarAmount } from '../components/DollarAmount';
import { PayHero } from '../components/approval/ApprovalHeroes';
import { dollarsFirst, dollarsInline, fmtDollars, priceFrom, PRICE_LOADING, PRICE_UNAVAILABLE } from './dollarsFirst';

const OK = priceFrom(30, true); // $30 a BSV

describe('dollars first', () => {
  it('formats cents under a dollar and dollars above', () => {
    expect(fmtDollars(0.04)).toBe('4¢');
    expect(fmtDollars(0.995)).toBe('100¢');
    expect(fmtDollars(0.0039)).toBe('0.39¢');
    expect(fmtDollars(1.5)).toBe('$1.50');
    expect(fmtDollars(12345.6)).toBe('$12,346');
  });

  it('puts the dollar figure first and the sats underneath', () => {
    // 133,334 sats at $30 = $0.04
    expect(dollarsFirst(133_334, OK)).toEqual({ main: '4¢', sub: '133,334 sats' });
    expect(dollarsFirst(10_000_000, OK)).toEqual({ main: '$3.00', sub: '10,000,000 sats' });
  });

  it('says the price is loading, never sats-only, until a rate settles', () => {
    const loading = priceFrom(0, false);
    expect(loading.status).toBe('loading');
    expect(dollarsFirst(3412, loading)).toEqual({ main: PRICE_LOADING, sub: '3,412 sats' });
  });

  it('shows sats with "($ price unavailable)" when no rate came back', () => {
    const none = priceFrom(undefined, true);
    expect(dollarsFirst(3412, none)).toEqual({ main: '3,412 sats', sub: PRICE_UNAVAILABLE });
    expect(dollarsInline(3412, none)).toBe('3,412 sats');
    expect(dollarsInline(133_334, OK)).toBe('4¢');
  });

  it('renders large dollars over small muted sats', () => {
    const html = renderToStaticMarkup(h(DollarAmount, { sats: 133_334, price: OK, size: 28 }));
    expect(html.indexOf('4¢')).toBeLessThan(html.indexOf('133,334 sats'));
    expect(html).toContain('font-size:28px');
    expect(html).toContain('font-size:12px');
    const hero = renderToStaticMarkup(h(PayHero, { amount: PRICE_LOADING, sub: '3,412 sats' }));
    expect(hero).toContain(PRICE_LOADING);
    expect(hero).toContain('min(44px, 6vh)');
  });
});
