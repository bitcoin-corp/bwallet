import { describe, expect, test } from 'bun:test';
import { pickPrimary } from './accountName';
import { nameCandidates } from './accountNames';

describe('primary name (24 Oct 2026)', () => {
  test('paymail name first, then OpNS names, no repeats', () => {
    expect(nameCandidates('b0asey', ['richardwboase', 'B0ASEY'])).toEqual(['b0asey', 'richardwboase']);
    expect(nameCandidates('', ['richardwboase'])).toEqual(['richardwboase']);
  });
  test('the chosen name wins only while the identity still has it', () => {
    const names = ['b0asey', 'richardwboase'];
    expect(pickPrimary(names, 'richardwboase')).toBe('richardwboase');
    expect(pickPrimary(names, 'RichardWBoase')).toBe('richardwboase');
    expect(pickPrimary(names, 'someoneelse')).toBe('');
    expect(pickPrimary(names, '')).toBe('');
  });
});
