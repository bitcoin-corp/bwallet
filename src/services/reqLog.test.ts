import { describe, expect, test } from 'bun:test';
import { reqLogLine } from './reqLog';

describe('[bwx-req] lines', () => {
  test('prefix, method, host only', () => {
    const l = reqLogLine('received', {
      method: 'createAction',
      origin: 'https://tokenblaster.lol/arcade/terrornode?x=1',
      locked: true,
    });
    expect(l).toBe('[bwx-req] received method=createAction origin=tokenblaster.lol locked');
  });
  test('surface and error, cut short', () => {
    const l = reqLogLine('open failed', { surface: 'popup', error: new Error('x'.repeat(500)) });
    expect(l.startsWith('[bwx-req] open failed surface=popup error=')).toBe(true);
    expect(l.length).toBeLessThan(200);
  });
  test('prints nothing it was not given (no params, keys or amounts fields exist)', () => {
    const l = reqLogLine('queued', { kind: 'bundle', ...({ params: { satoshis: 100000 }, wif: 'L1…' } as object) });
    expect(l).toBe('[bwx-req] queued kind=bundle');
  });
});
