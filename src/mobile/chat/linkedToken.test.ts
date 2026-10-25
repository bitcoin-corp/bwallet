import { describe, expect, test } from 'bun:test';
import { linkedTokenUrl, parseLinkedToken } from './linkedToken';

const ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_1';

describe('room linked token', () => {
  test('reads a valid linkedToken', () => {
    const t = parseLinkedToken({ linkedToken: { id: ID, symbol: 'TERRORNODE', source: 'blastpad' } });
    expect(t).toEqual({ id: ID, symbol: 'TERRORNODE', source: 'blastpad' });
    expect(linkedTokenUrl(t!)).toBe(`https://www.tokenblaster.lol/launch/${ID}`);
  });
  test('drops missing or malformed fields', () => {
    expect(parseLinkedToken(null)).toBeNull();
    expect(parseLinkedToken({})).toBeNull();
    expect(parseLinkedToken({ linkedToken: 'x' })).toBeNull();
    expect(parseLinkedToken({ linkedToken: { id: 'abc_1', symbol: 'X', source: 'blastpad' } })).toBeNull();
    expect(parseLinkedToken({ linkedToken: { id: ID.toUpperCase(), symbol: 'X', source: 'blastpad' } })).toBeNull();
    expect(parseLinkedToken({ linkedToken: { id: ID, symbol: 'terror', source: 'blastpad' } })).toBeNull();
    expect(parseLinkedToken({ linkedToken: { id: ID, symbol: 'A'.repeat(17), source: 'blastpad' } })).toBeNull();
    expect(parseLinkedToken({ linkedToken: { id: ID, symbol: '$X<b>', source: 'blastpad' } })).toBeNull();
    expect(parseLinkedToken({ linkedToken: { id: ID, symbol: 'X', source: 5 } })).toBeNull();
  });
  test('only BlastPad tokens get an outside link', () => {
    expect(linkedTokenUrl({ id: ID, symbol: 'X', source: 'other' })).toBeNull();
  });
});

describe('no-curve linked token', () => {
  test('$TERRORNODE goes to its game, not a trade page', () => {
    const id = 'd5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1';
    expect(linkedTokenUrl({ id, symbol: 'ASSAULT', source: 'blastpad' })).toBe(
      'https://www.tokenblaster.lol/arcade/terrornode',
    );
  });
});
