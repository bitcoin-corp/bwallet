import { describe, expect, test } from 'bun:test';
import { BMOVIES_ONE_MODEL, BMOVIES_ORIGIN, filmUrl, registerUrl } from './bmovies';
import { bmoviesFilmUrl, isBappRoom } from '../../chat/bappRooms';
import { familySite } from '../../theme/themeSites';

const minted = { offerId: 'off-1', ticker: 'weird', registered: true };
const unminted = { offerId: 'off-2', ticker: 'WEIRD', registered: false };

describe('ONE MODEL deep links (bmovies-ONE-MODEL.md)', () => {
  test('ships off until bmovies.app turns ONE_MODEL_REDIRECTS on', () => {
    expect(BMOVIES_ONE_MODEL).toBe(false);
  });
  test('a minted clip opens the one film page, resuming where the viewer was', () => {
    expect(filmUrl(minted, 12.7)).toBe(`${BMOVIES_ORIGIN}/film/WEIRD?t=12`);
    expect(filmUrl(minted, 0, 'buy')).toBe(`${BMOVIES_ORIGIN}/film/WEIRD?t=0&action=buy`);
    expect(filmUrl({ ...minted, ticker: '$abc' }, null, 'sell')).toBe(`${BMOVIES_ORIGIN}/film/ABC?action=sell`);
    expect(filmUrl(minted)).toBe(`${BMOVIES_ORIGIN}/film/WEIRD`);
  });
  test('an unminted clip falls back to its feed card, never with an action', () => {
    expect(filmUrl(unminted, 5, 'buy')).toBe(`${BMOVIES_ORIGIN}/feed?focus=off-2&t=5`);
    expect(filmUrl({ ...unminted, skin: 'bmusic' })).toBe(`${BMOVIES_ORIGIN}/feed?focus=off-2&skin=bmusic`);
    expect(filmUrl({ ...minted, ticker: 'bad ticker!' }, 3)).toBe(`${BMOVIES_ORIGIN}/feed?focus=off-1&t=3`);
  });
  test('junk times are dropped', () => {
    expect(filmUrl(minted, -4)).toBe(`${BMOVIES_ORIGIN}/film/WEIRD`);
    expect(filmUrl(minted, Number.NaN)).toBe(`${BMOVIES_ORIGIN}/film/WEIRD`);
  });
  test('one claim path on bmovies.app', () => {
    expect(registerUrl({ id: 'x', offerId: 'off-2', tweetUrl: null })).toBe(`${BMOVIES_ORIGIN}/claim/off-2`);
  });
  test('film rooms link to the film page; BMOVIES stays a bApp room', () => {
    expect(bmoviesFilmUrl('$weird')).toBe(`${BMOVIES_ORIGIN}/film/WEIRD`);
    expect(isBappRoom('BMOVIES')).toBe(true);
  });
  test('bmovies.app (and www.) may offer a theme', () => {
    expect(familySite('https://www.bmovies.app/film/X')?.id).toBe('bmovies-app');
    expect(familySite('bmovies.app')?.id).toBe('bmovies-app');
  });
});
