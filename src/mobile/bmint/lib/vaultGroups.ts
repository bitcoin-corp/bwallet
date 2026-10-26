/**
 * bMint › Your vault as sub-vaults (owner, 20 Oct 2026): one cover tile per collection instead of every NFT.
 * Pure: 1Sat items group by their collection tag (the same tag Wallet › NFTs groups by, nftLibrary.ts); Run NFTs
 * from the saved RelayX search group by their class, with every NPG series folded into "Ninja Punk Girls".
 * Items without a collection go to "Other", or show on their own when there are only a few.
 */

/** One piece in the vault, from either source. */
export type VaultPiece = {
  key: string;
  name: string;
  /** Collection id ('' = none). */
  collection: string;
  /** Picture for the tile (image URL), when there is one. */
  thumb?: string;
  /** Video URL, for video pieces without a picture. */
  video?: string;
  /** 'images' | 'video' | 'music' | 'other' | 'run'. */
  kind: string;
  /** The inscription origin when it's a 1Sat item (a collection id can point at it). */
  origin?: string;
  pending?: boolean;
  flagged?: boolean;
  /** Encrypted to this wallet (private mint, spec §9): grouped in their own "Private" sub-vault. */
  private?: boolean;
};

export type SubVault = { id: string; title: string; items: VaultPiece[] };

export const OTHER_ID = '__other__';
export const NPG_ID = 'run:npg';
export const PRIVATE_ID = '__private__';
export const PRIVATE_TITLE = 'Private (only you)';
/** "Other" with this many pieces or fewer shows them one by one instead of as a sub-vault. */
export const LOOSE_MAX = 3;

/** "Pixel Fox #12" → "Pixel Fox"; "NPG #0417" → "NPG". */
export const baseName = (name: string) =>
  name
    .replace(/\s*[#№]\s*\d+\s*$/, '')
    .replace(/\s+\d+\s*$/, '')
    .trim() || name;

const short = (id: string) => (id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

/** Collection title: the collection's own inscription if the wallet holds it, else the name most pieces carry. */
const titleFor = (id: string, items: VaultPiece[], byOrigin: Map<string, VaultPiece>) => {
  const parent = byOrigin.get(id.replace('.', '_'));
  if (parent && parent.name) return baseName(parent.name);
  const names = new Map<string, number>();
  for (const i of items) names.set(baseName(i.name), (names.get(baseName(i.name)) ?? 0) + 1);
  const [best] = [...names.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] > items.length / 2 && best[0] !== 'Inscription' ? best[0] : short(id);
};

/** Run collection id for a RelayX NFT: every NPG series is one "Ninja Punk Girls" sub-vault. */
export const runCollection = (f: { title: string; collection: string; n?: number }) =>
  f.n !== undefined || /npg|ninja punk/i.test(f.collection) || /^NPG\b/.test(f.title)
    ? NPG_ID
    : `run:${f.collection || 'RelayX NFTs'}`;

/**
 * Sub-vaults, biggest first, "Other" last; plus the loose pieces shown on their own (a small "Other").
 * A sub-vault the collection's own parent inscription sits in is counted with its children.
 */
export const groupVault = (pieces: VaultPiece[]): { vaults: SubVault[]; loose: VaultPiece[] } => {
  const byOrigin = new Map(pieces.filter((p) => p.origin).map((p) => [p.origin!.replace('.', '_'), p]));
  const ids = new Set(pieces.map((p) => p.collection).filter(Boolean));
  const groups = new Map<string, VaultPiece[]>();
  const priv = pieces.filter((p) => p.private);
  for (const p of pieces) {
    if (p.private) continue;
    // A parent inscription joins its own collection.
    const own = p.origin && ids.has(p.origin) ? p.origin : '';
    const id = p.collection || own || OTHER_ID;
    const list = groups.get(id) ?? [];
    list.push(p);
    groups.set(id, list);
  }
  const other = groups.get(OTHER_ID) ?? [];
  groups.delete(OTHER_ID);
  const vaults: SubVault[] = [...groups.entries()]
    .map(([id, items]) => ({
      id,
      title: id === NPG_ID ? 'Ninja Punk Girls' : id.startsWith('run:') ? id.slice(4) : titleFor(id, items, byOrigin),
      items,
    }))
    .sort((a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title));
  // Private pieces always sit together, first, so it's never unclear which pieces only you can see.
  if (priv.length) vaults.unshift({ id: PRIVATE_ID, title: PRIVATE_TITLE, items: priv });
  if (other.length > LOOSE_MAX) vaults.push({ id: OTHER_ID, title: 'Other', items: other });
  return { vaults, loose: other.length > LOOSE_MAX ? [] : other };
};

/** The cover: the first piece with a picture, else the first piece. */
export const coverOf = (v: SubVault): VaultPiece | undefined => v.items.find((i) => i.thumb) ?? v.items[0];
