import { useMemo, useState } from 'react';
import type { AvatarPlace } from '../names/animatedAvatar';
import { useAvatarPlayback } from '../names/useAvatarPlayback';
import { useRoomIcon } from './roomIcon';
import { defaultPictures } from './roomArt';

/**
 * The chat avatar for rooms and people (room lists, DM rows, the open chat header). Never a letter disc:
 * the picture given, else the token icon, else the person's photo, their gold bAvatar from bChatX, then a
 * bAvatar drawn on the device (chat/roomArt.ts). A DM passes the other person's handle as `issuer`.
 */
export const ChatAvatar = ({
  title,
  size = 48,
  roomKey,
  src,
  issuer,
  fallback,
  place = 'list',
}: {
  title: string;
  size?: number;
  /** Playback (names/animatedAvatar.ts): lists show a still frame; the open chat header animates. */
  place?: AvatarPlace;
  roomKey?: string | null;
  /** A picture to use as is: a room's metadata.icon, a person's avatar. */
  src?: string | null;
  /**
   * Used when there is no `src` and no token icon, before the generated pictures: a connected game's logo for its
   * room or its agent (chat/roomLook.ts). Only a wallet-fetched data: image.
   */
  fallback?: string | null;
  /** A token room's issuer handle, when known: its default picture is theirs. */
  issuer?: string | null;
}) => {
  // Token / collection rooms show the token's icon; with none, the issuer's photo or gold bAvatar (chat/roomArt.ts).
  const tokenIcon = useRoomIcon(src ? null : roomKey);
  const candidates = useMemo(
    () => [
      ...[src || tokenIcon, fallback && fallback.startsWith('data:image/') ? fallback : null].filter(
        (u): u is string => !!u,
      ),
      ...defaultPictures(title, issuer),
    ],
    [src, tokenIcon, fallback, title, issuer],
  );
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const icon = candidates.find((u) => !failed.has(u)) ?? candidates[candidates.length - 1];
  const play = useAvatarPlayback(icon, place);
  return (
    <img
      {...play.handlers}
      src={play.src}
      alt=""
      onError={() => setFailed((cur) => (cur.has(icon) ? cur : new Set(cur).add(icon)))}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="rounded-full object-cover shrink-0"
      style={{ width: size, height: size, background: '#16181c' }}
    />
  );
};
