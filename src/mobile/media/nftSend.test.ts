import { describe, expect, test } from 'bun:test';
import { canUseAsAvatar, isSelfRecipient, nftSendButton, PENDING_SEND_TEXT, SELF_SEND_TEXT } from './nftSend';

const base = { to: '', status: 'empty' as const, busy: false, onChain: true };

describe('nftSendButton', () => {
  test('waits for a recipient', () => {
    expect(nftSendButton(base)).toEqual({ label: 'Choose who gets it', enabled: false });
    expect(nftSendButton({ ...base, status: 'loading' }).enabled).toBe(false);
  });
  test('one button names the recipient', () => {
    expect(
      nftSendButton({ ...base, status: 'ready', to: '1GipmJoVtDx5326yuJ2rWQyHaSb95ro5tS', name: '$b0asey' }),
    ).toEqual({
      label: 'Send to $b0asey',
      enabled: true,
    });
    expect(nftSendButton({ ...base, status: 'ready', to: '1GipmJoVtDx5326yuJ2rWQyHaSb95ro5tS' }).label).toBe(
      'Send to 1GipmJ…5ro5tS',
    );
  });
  test('never sends an NFT the network never saw, or twice at once', () => {
    expect(nftSendButton({ ...base, status: 'ready', to: '1abc', onChain: false })).toEqual({
      label: 'Not on the blockchain yet',
      enabled: false,
    });
    expect(nftSendButton({ ...base, status: 'ready', to: '1abc', busy: true }).enabled).toBe(false);
  });
});

describe('self-send and pending', () => {
  const ready = { ...base, status: 'ready' as const, to: '1abc', name: '$b0asey' };
  test("won't send to yourself", () => {
    expect(nftSendButton({ ...ready, isSelf: true })).toEqual({ label: SELF_SEND_TEXT, enabled: false });
    expect(nftSendButton({ ...ready, isSelf: false }).enabled).toBe(true);
  });
  test('a pending mint waits, then unlocks', () => {
    expect(nftSendButton({ ...ready, pending: true, onChain: false })).toEqual({
      label: PENDING_SEND_TEXT,
      enabled: false,
    });
    expect(nftSendButton({ ...ready, pending: false, onChain: true }).enabled).toBe(true);
  });
  test('isSelfRecipient matches identity key or own address', () => {
    const own = { identityPubKey: '02AB', addresses: ['1me', '1myord'] };
    expect(isSelfRecipient({ to: '1other', pubkey: '02ab' }, own)).toBe(true);
    expect(isSelfRecipient({ to: '1myord' }, own)).toBe(true);
    expect(isSelfRecipient({ to: '1other', ordAddress: '1me' }, own)).toBe(true);
    expect(isSelfRecipient({ to: '1other', pubkey: '03cd' }, own)).toBe(false);
    expect(isSelfRecipient({ to: '' }, { addresses: [''] })).toBe(false);
  });
});

describe('canUseAsAvatar', () => {
  const ours = { sent: false, burned: false, pending: false };
  test('only an image NFT still held', () => {
    expect(canUseAsAvatar('images', ours)).toBe(true);
    expect(canUseAsAvatar('video', ours)).toBe(false);
    expect(canUseAsAvatar('images', { ...ours, sent: true })).toBe(false);
    expect(canUseAsAvatar('images', { ...ours, burned: true })).toBe(false);
    expect(canUseAsAvatar('images', { ...ours, pending: true })).toBe(false);
  });
});
