import type { CardPatternId } from '../theme/accents';
import { fieldFormulas } from '../media/vexvoid/pointField';
import { EMOJI_PACK_IDS, isEmojiPack } from '../theme/emojiThemes';
import { emojiArtUri } from './cardPatternsEmoji';
import npgLogo from './editionArt/npg-card-logo.webp';
import npgx1 from './editionArt/npgx-card-1.webp';
import npgx2 from './editionArt/npgx-card-2.webp';
import scammersCard from './editionArt/scammerscartel-dj-card.webp';
import { LEANNE_CARD_ART } from '../theme/leanneArtX';
import { TOKENBLASTER_CARD_ART } from '../theme/tokenblasterShopX';

/**
 * Artist edition card art (owner, 16 Oct 2026). VexVoid: a still of the VexVoid point field (the same formulas as the
 * live hero, media/vexvoid/pointField.ts) drawn as SVG, white points on true black. NPG: official Ninja Punk Girls
 * characters and the white tag logo on black with a pink glow (from ninja-punk-girls-com, compressed). NPGX: the
 * official NPGX logo (red tech font, red X) on black. Each card picks one variant from its id.
 */
export const EDITION_PATTERN_IDS = [
  'vexfield',
  'npg',
  'npgx',
  'scammerscartel',
  'leannethedark',
  'tokenblaster',
  'terrornode',
  ...EMOJI_PACK_IDS,
] as const satisfies readonly CardPatternId[];
export type EditionPatternId = (typeof EDITION_PATTERN_IDS)[number];
export const isEditionPattern = (id: string): id is EditionPatternId =>
  (EDITION_PATTERN_IDS as readonly string[]).includes(id);

const W = 1011;
const H = 637;
/** Formulas used for the still (index into fieldFormulas) and the moment each is frozen at. */
const VEX_STILLS: readonly [number, number][] = [
  [0, 2],
  [2, 5],
  [3, 9],
];

/** One VexVoid still as SVG: one path of 1px points, so it stays small (well under 80 KB). */
export function vexFieldSvg(variant = 0): string {
  const [fi, t] = VEX_STILLS[variant % VEX_STILLS.length] as [number, number];
  const f = fieldFormulas({ t, m1: 1, m2: 1, m3: 1, m4: 1 })[fi];
  const sc = H / 520;
  const pts = new Set<string>();
  const n = 4200;
  const step = f.n / n;
  for (let j = 0; j < n; j++) {
    const i = (j * step) | 0;
    const [px, py] = f.f(i % 300, (i / f.dv) | 0);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    const x = Math.round(W * 0.62 + px * sc);
    const y = Math.round(H * 0.5 + py * sc);
    if (x < 0 || y < 0 || x > W || y > H) continue;
    pts.add(`M${x} ${y}h0`);
    if (f.mirror) pts.add(`M${Math.round(W * 1.24 - x)} ${y}h0`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#000000"/>` +
    `<path d="${[...pts].join('')}" stroke="#FFFFFF" stroke-opacity="0.75" stroke-width="1.6" stroke-linecap="square"/>` +
    `</svg>`
  );
}

const RASTER: Record<
  'npg' | 'npgx' | 'scammerscartel' | 'leannethedark' | 'tokenblaster' | 'terrornode',
  readonly string[]
> = {
  // TokenBlaster's own card art (tokenblaster.lol/brand), empty in a store build.
  tokenblaster: TOKENBLASTER_CARD_ART.tokenblaster ?? [],
  terrornode: TOKENBLASTER_CARD_ART.terrornode ?? [],
  // Scammers Cartel: a crop of the community's own DJ raccoon banner (scammerscartel.com hero-poster).
  scammerscartel: [scammersCard],
  // Leanne The Dark's card art (leanneArtX.ts), empty in a store build.
  leannethedark: LEANNE_CARD_ART,
  // Owner 17 Oct 2026: the NPG card is the pink NPG logo. Characters come later as 3,334 one-per-character NFT packs.
  npg: [npgLogo],
  npgx: [npgx1, npgx2],
};

/** Steady small hash of a card id, so each card keeps its variant. */
export const variantFor = (key: string): number => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

const cache = new Map<string, string>();
/** The edition art for a card: an SVG data URI (VexVoid) or a bundled image URL (NPG, NPGX). */
export function editionArtUri(id: EditionPatternId, key = ''): string {
  const v = variantFor(key);
  // Emoji themes: Twemoji on original card art (cardPatternsEmoji.ts).
  if (isEmojiPack(id)) return emojiArtUri(id, v);
  if (id === 'vexfield') {
    const k = `vex${v % VEX_STILLS.length}`;
    let u = cache.get(k);
    if (!u) {
      u = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(vexFieldSvg(v));
      cache.set(k, u);
    }
    return u;
  }
  const list = RASTER[id];
  return (list[v % list.length] ?? '') as string;
}
