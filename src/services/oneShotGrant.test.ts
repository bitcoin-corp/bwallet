import { describe, expect, test } from 'bun:test';
import { oneShotGrant, ONE_SHOT_SECONDS } from './oneShotGrant';

describe('b-Aware 25 Oct: one-call grants expire', () => {
  test('oneShotGrant carries an expiry about a minute ahead (UNIX seconds)', () => {
    const now = Date.UTC(2026, 9, 25);
    const g = oneShotGrant('r1', now);
    expect(g).toMatchObject({ requestID: 'r1', ephemeral: true });
    expect(g.expiry).toBe(now / 1000 + ONE_SHOT_SECONDS);
  });
});
