import { useWithoutHidden } from '../albums/useAlbums';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useServiceContext } from '../../hooks/useServiceContext';
import { checkSize, estimateCost, formatBytes } from '../mint/mint';
import { maxBytesFor, type MintKind } from '../mint/mintKinds';
import { fmtSats, fmtUsd, hasRate, satsToUsd, useBsvUsd } from '../money/money';
import { useWalletMedia, type MediaItem } from '../media/useWalletMedia';
import { thumbUrl } from '../market/thumbs';
import { HubArt } from './HubArt';
import { getTagValue } from '../../utils/format';
import { useRelayxAccount } from '../sweep/useRelayxAccount';
import { loadSavedRelayx } from '../sweep/relayxSaved';
import type { Found } from '../../sweep/relayxRecover';
import { coverOf, groupVault, runCollection, type SubVault, type VaultPiece } from './lib/vaultGroups';
import { DROP_ACCEPT, DROP_UNSUPPORTED, handOff, TILE_LABEL, tileForFile, type DropTile } from './lib/drop';

/**
 * The bMint studio (owner, 19 Oct 2026: "needs dramatically improving"): the bmintx.com look inside the wallet.
 *   DropHero   "You made it. Prove it's yours." + a big drop zone. A dropped file shows as a sealed preview with a
 *              live cost estimate (mint.ts estimateCost, the same maths the confirm sheet uses), then "Mint it" opens
 *              the existing Mint sheet for that type with the file already picked (BmintPage MintOpen → MintSheet file).
 *   Steps      the calm three-step explanation.
 *   Vault      the wallet's real NFTs (media/useWalletMedia, the same list as Wallet › NFTs) plus saved Run NFTs, as
 *              sub-vaults per collection (lib/vaultGroups.ts); gold empty state.
 * Nothing here signs or spends: every mint still goes through MintSheet and the wallet's confirm sheet.
 */

/** The bmintx.com seal: a gold rosette with the b mark. */
export const Seal = ({ className = '' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <linearGradient id="bm-seal-g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffe58a" />
        <stop offset=".55" stopColor="#ffd24d" />
        <stop offset="1" stopColor="#c98f00" />
      </linearGradient>
    </defs>
    <path
      fill="url(#bm-seal-g)"
      d="M50 2l7 8 10-3 3 10 10 2-1 10 9 6-5 9 5 9-9 6 1 10-10 2-3 10-10-3-7 8-7-8-10 3-3-10-10-2 1-10-9-6 5-9-5-9 9-6-1-10 10-2 3-10 10 3z"
    />
    <circle cx="50" cy="50" r="31" fill="none" stroke="#000" strokeOpacity=".35" strokeWidth="2" />
    <g fill="#1a1200">
      <polygon points="45,30 45,56 38,56 38,37" />
      <path fillRule="evenodd" d="M51 41a14 14 0 1 1 0 28a14 14 0 1 1 0-28zm0 8a6 6 0 1 0 0 12a6 6 0 1 0 0-12z" />
    </g>
  </svg>
);

const KIND_OF: Partial<Record<DropTile, MintKind>> = { art: 'picture', music: 'music', video: 'video', '3d': '3d' };

type Dropped = { file: File; tile: DropTile; url: string };

const usePreviewUrl = (file: File | null) => {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
};

const PreviewArt = ({ d }: { d: Dropped }) => {
  if (d.tile === 'art') return <img className="bm-prev-media" src={d.url} alt="" />;
  if (d.tile === 'video') return <video className="bm-prev-media" src={d.url} muted autoPlay loop playsInline />;
  return (
    <span className="bm-prev-art">
      <HubArt id={d.tile} />
    </span>
  );
};

/** Live estimate for one inscription of `bytes` at the wallet's fee rate (editions and covers are priced in the sheet). */
const useEstimate = (bytes: number) => {
  const { chromeStorageService } = useServiceContext();
  const rate = useBsvUsd();
  if (!bytes) return null;
  const cost = estimateCost(bytes, chromeStorageService.getCustomFeeRate(), rate);
  const usd = satsToUsd(cost.totalSats, rate);
  return { cost, main: usd !== null && hasRate(rate) ? `about ${fmtUsd(usd)}` : `about ${fmtSats(cost.totalSats)}` };
};

export const DropHero = ({ name }: { name: string }) => {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [tile, setTile] = useState<DropTile | null>(null);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const url = usePreviewUrl(file);
  const est = useEstimate(file?.size ?? 0);

  const take = (f: File | undefined) => {
    if (!f) return;
    const t = tileForFile(f.type, f.name);
    if (!t) {
      setFile(null);
      setTile(null);
      return setError(DROP_UNSUPPORTED);
    }
    setError('');
    setFile(f);
    setTile(t);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files?.[0]);
  };
  const reset = () => {
    setFile(null);
    setTile(null);
    setError('');
  };
  const mint = () => {
    if (!file || !tile) return;
    handOff(file);
    navigate(`/m/bmint/mint/${tile}`);
  };
  const d: Dropped | null = file && tile ? { file, tile, url } : null;
  const size = d ? checkSize(d.file.size, maxBytesFor(KIND_OF[d.tile])) : null;

  return (
    <section className="bm-hero2" aria-label="Mint something you made">
      <div className="bm-hero2-copy">
        <p className="bm-eyebrow">bMint · your work, on Bitcoin</p>
        <h1>
          You made it.
          <br />
          <span className="bm-shine">Prove it&rsquo;s yours.</span>
        </h1>
        <p className="bm-lede">
          Forever, for about a penny. Art, tracks, clips, models, books and pages get a timestamp on Bitcoin in your own
          name, and land in your vault.
        </p>
        <ol className="bm-steps">
          <li>
            <b>Drop it</b>
            <span>Anything you made, up to 10 MB (50 MB for video and 3D).</span>
          </li>
          <li>
            <b>Seal it</b>
            <span>Check the cost, then confirm in your wallet. Nothing is sent before you do.</span>
          </li>
          <li>
            <b>Keep it</b>
            <span>It sits in your vault as yours: keep it, send it or sell it.</span>
          </li>
        </ol>
      </div>

      {d ? (
        <div className="bm-preview" aria-live="polite">
          <div className="bm-prev-frame">
            <PreviewArt d={d} />
            <span className="bm-prev-shade" />
            <Seal className="bm-seal-stamp" />
            <span className="bm-prev-meta">
              <b>{d.file.name.replace(/\.\w+$/, '') || 'Untitled'}</b>
              <span>
                {TILE_LABEL[d.tile]} · by {name}
              </span>
            </span>
          </div>
          <dl className="bm-prev-facts">
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(d.file.size)}</dd>
            </div>
            <div>
              <dt>Cost to mint</dt>
              <dd className="gold">{est?.main ?? '…'}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{name}</dd>
            </div>
          </dl>
          {size && !size.ok && <p className="bm-drop-err">{size.message}</p>}
          <p className="bm-prev-note">
            Network fee {est ? fmtSats(est.cost.networkSats) : '…'}
            {est && est.cost.feeSats > 0 ? ` + mint fee ${fmtSats(est.cost.feeSats)}` : ''}. Titles, editions and the
            exact total come next; you confirm before anything is sent.
          </p>
          <div className="bm-prev-actions">
            <button type="button" className="bm-btn gold bm-cta" onClick={mint}>
              Mint it
            </button>
            <button type="button" className="bm-btn" onClick={reset}>
              Choose another
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`bm-drop${over ? ' over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <Seal className="bm-drop-seal" />
          <span className="bm-drop-title">Drop anything you made</span>
          <span className="bm-drop-sub">Pictures, music, video, 3D, PDFs and ebooks, one-page sites</span>
          <span className="bm-btn gold bm-cta">Choose a file</span>
          {error && <span className="bm-drop-err">{error}</span>}
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept={DROP_ACCEPT}
        hidden
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </section>
  );
};

/** A wallet NFT or a saved Run NFT as a vault piece. */
const fromMedia = (m: MediaItem): VaultPiece => ({
  key: m.origin,
  name: m.name,
  collection: getTagValue(m.output.tags, 'collection') || getTagValue(m.output.tags, 'collectionId') || '',
  thumb: m.kind === 'images' ? (thumbUrl(m.origin) ?? m.url) : undefined,
  video: m.kind === 'video' ? m.url : undefined,
  kind: m.kind,
  origin: m.origin.replace('.', '_'),
  pending: m.pending,
  flagged: m.flagged,
});
const fromRun = (f: Found): VaultPiece => ({
  key: `run:${f.origin || f.location}`,
  name: f.title,
  collection: runCollection(f),
  thumb: f.art,
  kind: 'run',
});

const KIND_LABEL: Record<string, string> = { images: 'Picture', music: 'Music', video: 'Video', run: 'Run NFT' };

const PieceArt = ({ piece }: { piece?: VaultPiece }) => {
  const [broken, setBroken] = useState(false);
  if (piece?.thumb && !broken) return <img src={piece.thumb} alt="" loading="lazy" onError={() => setBroken(true)} />;
  if (piece?.video) return <video src={piece.video} muted preload="metadata" playsInline />;
  return <HubArt id={piece?.kind === 'music' ? 'music' : 'books'} />;
};

const VaultTile = ({ item }: { item: VaultPiece }) => (
  <Link to="/m/nfts" className={`bm-vtile${item.flagged ? ' flagged' : ''}`}>
    <span className="bm-vart">
      <PieceArt piece={item} />
      {item.pending && <span className="bm-chip bm-vpending">Pending</span>}
      <Seal className="bm-vseal" />
    </span>
    <span className="bm-vcap">
      <b>{item.name}</b>
      <span>{KIND_LABEL[item.kind] ?? 'Piece'}</span>
    </span>
  </Link>
);

/** A sub-vault: one cover for the whole collection, its name and count. */
const SubVaultTile = ({ vault, onOpen }: { vault: SubVault; onOpen: () => void }) => {
  const cover = coverOf(vault);
  return (
    <button type="button" className={`bm-vtile bm-vcoll${cover?.flagged ? ' flagged' : ''}`} onClick={onOpen}>
      <span className="bm-vart">
        <PieceArt piece={cover} />
        <span className="bm-chip bm-vcount">{vault.items.length}</span>
        <Seal className="bm-vseal" />
      </span>
      <span className="bm-vcap">
        <b>{vault.title}</b>
        <span>{vault.items.length === 1 ? '1 piece' : `${vault.items.length} pieces`}</span>
      </span>
    </button>
  );
};

/** Your vault (owner, 20 Oct 2026): sub-vaults per collection; tap one to open its grid. */
export const Vault = ({ name }: { name: string }) => {
  const { items: shownRaw, loading, error, hasMore, loadMore } = useWalletMedia();
  const items = useWithoutHidden(shownRaw);
  const xpub = useRelayxAccount();
  const [open, setOpen] = useState<string | null>(null);
  // Every page, so each sub-vault's count is the real one (Wallet › NFTs does the same).
  useEffect(() => {
    if (hasMore && !loading && !error) void loadMore();
  }, [hasMore, loading, error, loadMore]);
  const pieces = useMemo(() => {
    const run = xpub ? (loadSavedRelayx(xpub)?.result.nfts ?? []) : [];
    return [...items.map(fromMedia), ...run.filter((f) => !f.unread).map(fromRun)];
  }, [items, xpub]);
  const { vaults, loose } = useMemo(() => groupVault(pieces), [pieces]);
  const inside = open ? vaults.find((v) => v.id === open) : undefined;
  return (
    <section className="bm-vault" aria-label="Your vault">
      <div className="bm-vault-h">
        <div>
          {inside ? (
            <button type="button" className="bm-vback" onClick={() => setOpen(null)}>
              ‹ Your vault
            </button>
          ) : (
            <p className="bm-eyebrow">Your vault</p>
          )}
          <h2>{inside ? inside.title : <>Everything you&rsquo;ve sealed, in one place.</>}</h2>
        </div>
        <span className="bm-vault-who">
          {name}
          {pieces.length > 0 && (
            <small>
              {' '}
              · {inside ? inside.items.length : pieces.length}
              {!inside && hasMore ? '+' : ''} pieces
            </small>
          )}
          {pieces.length > 0 && (
            <Link to="/m/nfts" className="bm-vault-all">
              See all
            </Link>
          )}
        </span>
      </div>
      {inside ? (
        <div className="bm-vgrid">
          {inside.items.map((i) => (
            <VaultTile key={i.key} item={i} />
          ))}
        </div>
      ) : pieces.length > 0 ? (
        <div className="bm-vgrid">
          {vaults.map((v) => (
            <SubVaultTile key={v.id} vault={v} onOpen={() => setOpen(v.id)} />
          ))}
          {loose.map((i) => (
            <VaultTile key={i.key} item={i} />
          ))}
        </div>
      ) : loading ? (
        <div className="bm-vgrid">
          {Array.from({ length: 5 }, (_, k) => (
            <span key={k} className="bm-vtile bm-vskel" />
          ))}
        </div>
      ) : (
        <div className="bm-vempty">
          <Seal className="bm-vempty-seal" />
          <b>{error ? "Couldn't open your vault" : 'Your vault is waiting'}</b>
          <span>{error || 'Your first mint lands here, sealed with your name and the time it was made.'}</span>
        </div>
      )}
    </section>
  );
};
