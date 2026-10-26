import { describe, expect, test } from 'bun:test';
import { returnHint, switchBackHint } from './doneHint';

describe('PairSheet done hint with a return', () => {
  test('apps go back on their own; the web wallet asks for a tap and to stay open', () => {
    expect(returnHint('www.tokenblaster.lol', false)).toContain('Taking you back to www.tokenblaster.lol');
    expect(returnHint('www.tokenblaster.lol', true)).toContain('Tap Return to carry on at www.tokenblaster.lol');
    expect(returnHint('www.tokenblaster.lol', true)).toContain('Keep this tab open');
  });
});

describe('PairSheet done hint', () => {
  test('iOS says Safari, others "your browser", with the host', () => {
    expect(switchBackHint('www.bchatx.com', true)).toContain('switch back to Safari to carry on at www.bchatx.com');
    expect(switchBackHint('www.bchatx.com', false)).toContain(
      'switch back to your browser to carry on at www.bchatx.com',
    );
  });
});
