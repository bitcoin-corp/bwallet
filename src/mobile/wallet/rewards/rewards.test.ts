import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TERRORNODE_GAME_URL } from '../../market/launchpad/noCurve';
import { RewardCards } from './RewardCards';
import { coinsById, earnLabel, formatAmount, pickRewards, rewardInfo, unlockLine, type Reward } from './rewards';

const T = 'd5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1';
const OTHER = `${'a'.repeat(64)}_0`;
const SAFE = 'https://www.tokenblaster.lol/arcade/other';

describe('rewardInfo detection order', () => {
  it('1: category reward wins, even with trading true', () => {
    expect(rewardInfo(OTHER, { category: 'reward', trading: true, earn_url: SAFE })).toEqual({
      source: 'category',
      earnUrl: SAFE,
      game: null,
    });
  });
  it('2: trading false needs a safe earn_url', () => {
    expect(rewardInfo(OTHER, { trading: false, earn_url: SAFE })?.source).toBe('trading');
    expect(rewardInfo(OTHER, { trading: false, earn_url: 'https://evil.com/x' })).toBeNull();
    expect(rewardInfo(OTHER, { trading: false, earn_url: 'http://www.tokenblaster.lol/x' })).toBeNull();
    expect(rewardInfo(OTHER, { trading: false })).toBeNull();
  });
  it('3: local list is the fallback, API before it', () => {
    expect(rewardInfo(T)).toEqual({ source: 'local', earnUrl: TERRORNODE_GAME_URL, game: 'Assault on Terrornode' });
    expect(rewardInfo(T, { trading: false, earn_url: SAFE })?.source).toBe('trading');
    expect(rewardInfo(T, { category: 'reward' })?.earnUrl).toBe(TERRORNODE_GAME_URL);
    expect(rewardInfo(OTHER, { trading: true })).toBeNull();
    expect(rewardInfo(OTHER)).toBeNull();
  });
  it('unsafe earn_url never replaces the local link', () => {
    expect(rewardInfo(T, { category: 'reward', earn_url: 'javascript:alert(1)' })?.earnUrl).toBe(TERRORNODE_GAME_URL);
  });
  it('generic: any game name from the API', () => {
    expect(earnLabel(rewardInfo(OTHER, { category: 'reward', game: 'Space Run' })?.game ?? null)).toBe(
      'Play Space Run',
    );
    expect(earnLabel(null)).toBe('Play to earn more');
  });
});

describe('pickRewards', () => {
  const held = [
    { id: T, symbol: 'TERRORNODE', dec: 0, amountRaw: '1250', icon: null },
    { id: OTHER, symbol: 'COIN', dec: 0, amountRaw: '5', icon: null },
    { id: `${'b'.repeat(64)}_0`, symbol: 'ZERO', dec: 0, amountRaw: '0', icon: null },
  ];
  it('keeps only held rewards and attaches rooms', () => {
    const rooms = new Map([[T, 'TERRORNODE']]);
    const r = pickRewards(held, coinsById([{ token_id: OTHER, trading: true }]), rooms);
    expect(r.map((x) => x.symbol)).toEqual(['TERRORNODE']);
    expect(unlockLine(r[0])).toBe('Unlocks the $TERRORNODE room');
  });
  it('formats amounts', () => {
    expect(formatAmount('1250', 0)).toBe('1,250');
    expect(formatAmount('1250', 2)).toBe('12.5');
  });
});

describe('RewardCards', () => {
  const reward: Reward = {
    id: T,
    symbol: 'TERRORNODE',
    dec: 0,
    amountRaw: '1250',
    icon: null,
    source: 'local',
    earnUrl: TERRORNODE_GAME_URL,
    game: 'Assault on Terrornode',
    room: 'TERRORNODE',
  };
  const render = (showUnlock = true, showEarn = true) =>
    renderToStaticMarkup(
      createElement(RewardCards, { rewards: [reward], showUnlock, showEarn, onSend: () => {}, onEarn: () => {} }),
    );
  it('renders amount, unlock, earn and send', () => {
    const html = render();
    expect(html).toContain('Rewards');
    expect(html).toContain('1,250');
    expect(html).toContain('Unlocks the $TERRORNODE room');
    expect(html).toContain('Play Assault on Terrornode');
    expect(html).toContain('Send TERRORNODE');
  });
  it('has no buy, sell, price or value wording', () => {
    const html = render().replace(/<[^>]+>/g, ' ');
    expect(html).not.toMatch(/\b(buy|sell|price|value|invest)/i);
  });
  it('store build: no unlock line, no game link, send stays', () => {
    const html = render(false, false);
    expect(html).not.toContain('Unlocks');
    expect(html).not.toContain('Play ');
    expect(html).toContain('Send TERRORNODE');
  });
  it('renders nothing with no rewards', () => {
    expect(
      renderToStaticMarkup(
        createElement(RewardCards, {
          rewards: [],
          showUnlock: true,
          showEarn: true,
          onSend: () => {},
          onEarn: () => {},
        }),
      ),
    ).toBe('');
  });
  it('is mounted on the Wallet Tokens view behind an error boundary', () => {
    const cfg = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'vite.config.mobile.ts'), 'utf8');
    expect(cfg).toContain('<SectionBoundary name="Rewards"><RewardsSection /></SectionBoundary>');
  });
});
