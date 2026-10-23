/**
 * Link previews (OG image + title) for links to OUR OWN sites in the Feed.
 *
 * Feed link cards never fetch pages (privacy: a third-party link would learn who scrolled past
 * it). Our own sites are the exception, as on bChatX's web feed (bit-sign PR #68): bit-sign's
 * GET /api/bitsign/unfurl fetches own-host pages for signed-out callers and returns their OG
 * data; it allows web.bwalletx.com / desktop.bwalletx.com by CORS, and the phone apps call it
 * through the native HTTP layer. Other hosts stay plain cards.
 */
import { Capacitor } from '@capacitor/core';
import { BCHAT_ORIGIN, defaultHttp, type Http } from '../chat/api';

/** Keep in step with bit-sign src/lib/own-hosts.ts. */
const OWN_HOSTS = new Set([
  'bwalletx.com',
  'www.bwalletx.com',
  'web.bwalletx.com',
  'desktop.bwalletx.com',
  'bchatx.com',
  'www.bchatx.com',
  'chat.bwalletx.com',
  'bmovies.app',
  'www.bmovies.app',
  'bitcoinchat.online',
  'www.bitcoinchat.online',
  'bit-sign.online',
  'www.bit-sign.online',
]);

export function isOwnHost(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && OWN_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type OgPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site: string | null;
};

/** Parse bit-sign's `{ previews: [...] }`; only `ok` rows with something to show, https images only. */
export function parsePreviews(data: unknown): OgPreview[] {
  const list = (data as { previews?: unknown })?.previews;
  if (!Array.isArray(list)) return [];
  const out: OgPreview[] = [];
  for (const p of list as Record<string, unknown>[]) {
    if (!p || p.ok !== true || typeof p.url !== 'string') continue;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const img = str(p.image_url);
    const image = img && /^https:\/\//i.test(img) ? img : null;
    const title = str(p.title);
    if (!title && !image) continue;
    out.push({ url: p.url, title, description: str(p.description), image, site: str(p.site_name) });
  }
  return out;
}

const cache = new Map<string, Promise<OgPreview | null>>();

/** OG preview of an own-site link (null for other hosts or when unavailable). Cached per session. */
export function ownLinkPreview(
  url: string,
  http: Http = defaultHttp(Capacitor.isNativePlatform()),
): Promise<OgPreview | null> {
  if (!isOwnHost(url)) return Promise.resolve(null);
  let p = cache.get(url);
  if (!p) {
    p = http({ method: 'GET', url: `${BCHAT_ORIGIN}/api/bitsign/unfurl?url=${encodeURIComponent(url)}`, headers: {} })
      .then((r) =>
        r.status === 200
          ? (parsePreviews(r.data).find((x) => x.url === url) ?? parsePreviews(r.data)[0] ?? null)
          : null,
      )
      .catch(() => null);
    p.then((v) => {
      if (!v) cache.delete(url); // retry next time the card mounts
    });
    cache.set(url, p);
  }
  return p;
}
