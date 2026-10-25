import { describe, expect, it } from 'bun:test';
import { roomEmoji, roomListBackdrop, type RoomLook } from './roomLook';

const LOOK: RoomLook = {
  ticker: 'TERRORNODE',
  host: 'www.tokenblaster.lol',
  name: 'TERRORNODE',
  mode: 'dark',
  accent: '#FF1A2E',
  accentHi: '#1AD8FF',
  onAccent: '#000000',
  bg: '#0A0204',
  surface: '#1C0609',
  text: '#F6ECEE',
  artData: 'data:image/jpeg;base64,AAAA',
};

describe('roomListBackdrop', () => {
  it('fades the room art into the room background', () => {
    const b = roomListBackdrop(LOOK)!;
    expect(b).toContain('url("data:image/jpeg;base64,AAAA") center top');
    expect(b).toContain('#0A0204A6 0%');
    expect(b).toContain('#0A0204 100%');
  });
  it('is null without art or with art that is not a data: image', () => {
    expect(roomListBackdrop(null)).toBeNull();
    expect(roomListBackdrop({ ...LOOK, artData: undefined })).toBeNull();
    expect(roomListBackdrop({ ...LOOK, artData: 'https://evil.example/x.jpg' })).toBeNull();
    expect(roomListBackdrop({ ...LOOK, artData: 'data:image/png;base64,AA");background:red' })).toBeNull();
  });
});

describe('roomEmoji', () => {
  it('takes a short pictograph run', () => {
    expect(roomEmoji({ look: { emoji: '👁️' } })).toBe('👁️');
    expect(roomEmoji({ look: { emoji: '👩‍🚀' } })).toBe('👩‍🚀');
  });
  it('ignores text, markup and junk', () => {
    expect(roomEmoji({ look: { emoji: 'hi' } })).toBeNull();
    expect(roomEmoji({ look: { emoji: '<b>👁️</b>' } })).toBeNull();
    expect(roomEmoji({ look: { emoji: '1' } })).toBeNull();
    expect(roomEmoji({ look: { emoji: '️' } })).toBeNull();
    expect(roomEmoji({ look: {} })).toBeNull();
    expect(roomEmoji(null)).toBeNull();
  });
});
