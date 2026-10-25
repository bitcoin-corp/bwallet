import { describe, expect, test } from 'bun:test';
import {
  handlePaymail,
  nameBavatarUri,
  nameChips,
  nameIntro,
  nameOrigin,
  shortFrom,
  tokenblasterLaunchUrl,
} from './nameCard';

describe('name card', () => {
  test('intro is one plain sentence with the full name', () => {
    expect(nameIntro('a47')).toBe(
      'This is the name a47. You own it on the Bitcoin SV blockchain, and it works like a web domain or a username you hold yourself.',
    );
  });

  test('origin in human terms', () => {
    expect(nameOrigin({ inNames: true })).toBe('You minted or bought this');
    expect(nameOrigin({ from: '1CqJA7xxxxxxxxxxxxxxxxxxxxxFAtsvX' })).toBe('A gift from 1CqJ…tsvX');
    expect(nameOrigin({ from: '$alice' })).toBe('A gift from $alice');
    expect(nameOrigin({})).toBe('Sent to your wallet');
    expect(shortFrom('alice@bwalletx.com')).toBe('alice@bwalletx.com');
  });

  test('handle paymail only for names a paymail alias can take', () => {
    expect(handlePaymail('a47', 'bwalletx.com')).toBe('a47@bwalletx.com');
    expect(handlePaymail('-bad', 'bwalletx.com')).toBeNull();
    expect(handlePaymail('a'.repeat(40), 'bwalletx.com')).toBeNull();
    expect(handlePaymail('a47', '')).toBeNull();
  });

  test('chips', () => {
    const link = { name: 'a47', tokenId: 'x_0', ticker: 'A47', supply: '1', createdAt: 0, roomTicker: 'A47' };
    const on = (c: ReturnType<typeof nameChips>) => Object.fromEntries(c.map((x) => [x.key, x.on]));
    expect(
      on(nameChips({ name: 'a47', published: true, paymail: 'A47@bwalletx.com', domain: 'bwalletx.com', link })),
    ).toEqual({
      idkey: true,
      handle: true,
      room: true,
      token: true,
    });
    expect(
      on(
        nameChips({
          name: 'a47',
          published: false,
          paymail: 'bob@bwalletx.com',
          domain: 'bwalletx.com',
          link: { ...link, name: 'bob' },
        }),
      ),
    ).toEqual({ idkey: false, handle: false, room: false, token: false });
  });

  test('launch url is prefilled and encoded', () => {
    expect(tokenblasterLaunchUrl('a47')).toBe('https://www.tokenblaster.lol/launch?name=a47&ticker=A47');
  });

  test('bAvatar is a deterministic svg data url', () => {
    const a = nameBavatarUri('a47');
    expect(a.startsWith('data:image/svg+xml')).toBe(true);
    expect(nameBavatarUri('a47')).toBe(a);
    expect(nameBavatarUri('b48')).not.toBe(a);
  });
});
