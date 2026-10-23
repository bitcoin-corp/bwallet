import { bavatarSvg, cleanName } from '../bavatar/bavatar';
import { bchatOrigin } from '../../services/bchatOrigin';

/**
 * A Space participant's default picture: their gold bAvatar, never a letter on a coloured disc (owner,
 * 11 Oct 2026, "gold by default"). The tile only knows the handle, so the bChatX endpoint resolves the
 * handle to its identity key and draws the same art as the wallet card and bChatX profile. If that can't
 * load (offline), faceArtLocal() draws a name-seeded bAvatar on the device.
 */
export const faceArtUrl = (handle: string): string =>
  `${bchatOrigin()}/api/bavatar/${encodeURIComponent(cleanName(handle))}.svg`;

/**
 * A speaker's own uploaded bChatX banner (public endpoint; 404 when they have none). Camera-off tiles try this
 * first so an artist's own banner shows (owner, 11 Oct 2026), and fall back to the gold bAvatar on error.
 */
export const bannerUrl = (handle: string): string =>
  `${bchatOrigin()}/api/public/banner/${encodeURIComponent(cleanName(handle))}`;

const local = new Map<string, string>();
export function faceArtLocal(handle: string): string {
  const k = cleanName(handle);
  let uri = local.get(k);
  if (!uri) {
    uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(k || 'b', { size: 256, label: '' }));
    local.set(k, uri);
  }
  return uri;
}

/** img onError: swap a failed network bAvatar for the local one (once). */
export const fallBackToLocal = (handle: string) => (e: { currentTarget: HTMLImageElement }) => {
  const img = e.currentTarget;
  const next = faceArtLocal(handle);
  if (img.src !== next) img.src = next;
};
