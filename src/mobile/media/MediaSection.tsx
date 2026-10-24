import { useWithoutHidden } from '../albums/useAlbums';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileQuestion, Music, Play, RefreshCw, Send } from 'lucide-react';
import type { MediaKind } from './media';
import { pauseAudio } from './player';
import { Blurred } from '../market/NftCard';
import { NftDetail } from './NftDetail';
import { VideoPoster } from './VideoPoster';
import { refreshMessage } from './nftActions';
import { playMusic, useWalletMedia, type MediaItem } from './useWalletMedia';
import { getTagValue } from '../../utils/format';
import type { Weapon } from '../three3d/ordnance';
import { TOKENBLASTER_ENABLED } from '../storeBuild';
import { KeptAirdrops } from '../airdrops/AirdropNft';
import { inWalletList, keptNfts } from '../airdrops/inbox';
import { useAirdrops } from '../airdrops/useAirdrops';
import { BavatarKeep } from '../nfts/BavatarKeep';
import { isBavatarItem } from '../names/pictureSource';

// 1Sat Ordnance guns (tokenblaster.lol): bWalletX only, not in a store build even as code.
const WeaponTile = TOKENBLASTER_ENABLED
  ? lazy(() => import('../three3d/OrdnanceGrid').then((m) => ({ default: m.WeaponTile })))
  : null;
const LazyCabinet = TOKENBLASTER_ENABLED ? lazy(() => import('../three3d/Cabinet')) : null;

/**
 * Wallet › NFTs: the wallet's non-fungible inscriptions as a media library, filtered by kind,
 * with an audio queue player (MiniPlayer) and a video player, streamed from ORDFS.
 * Tapping an image / video / document opens NftDetail (viewer, set as avatar, send); Refresh syncs
 * the addresses and reloads. Bulk send / cancel listings stay in upstream's Ordinals manager (/ord-wallet).
 */
type Filter = 'all' | MediaKind | '3d';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'music', label: 'Music' },
  { id: 'video', label: 'Video' },
  { id: 'images', label: 'Images' },
  { id: 'other', label: 'Other' },
  { id: '3d', label: '3D' },
];
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

export const MediaSection = () => {
  const navigate = useNavigate();
  const { items: shownRaw, hasMore, loading, error, loadMore, reload, refresh, hiddenUnbroadcast } = useWalletMedia();
  const items = useWithoutHidden(shownRaw);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');
  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshNote('');
    try {
      const { added, synced } = await refresh();
      setRefreshNote(refreshMessage(added, synced));
    } catch {
      setRefreshNote('');
    } finally {
      setRefreshing(false);
    }
  };
  const [filter, setFilter] = useState<Filter>('all');
  // NFTs kept from bMail › Quarantine that the wallet's list doesn't hold yet (shown with the reason).
  const drops = useAirdrops();
  const keptPending = useMemo(() => {
    if (loading && !items.length) return [];
    const have = items.map((i) => i.output.outpoint);
    return keptNfts(drops.items, drops.state).filter((i) => !inWalletList(i, have));
  }, [drops.items, drops.state, items, loading]);
  const [open, setOpen] = useState<MediaItem | null>(null);

  // 3D: genuine 1Sat Ordnance guns (origin listed by tokenblaster.lol as paid), keyed by outpoint.
  const [guns, setGuns] = useState<Map<string, Weapon>>(new Map());
  const [cabinet, setCabinet] = useState<Weapon | null>(null);
  useEffect(() => {
    if (!TOKENBLASTER_ENABLED || !items.length) return;
    let live = true;
    import('../three3d/ordnance')
      .then(({ loadIssued, loadWeapons, normOutpoint }) =>
        Promise.all([loadIssued(), loadWeapons()]).then(([issued, weapons]) => ({ issued, weapons, normOutpoint })),
      )
      .then(({ issued, weapons, normOutpoint }) => {
        const byId = new Map(weapons.map((w) => [w.id, w]));
        const m = new Map<string, Weapon>();
        items.forEach((i) => {
          const origin = normOutpoint(getTagValue(i.output.tags, 'origin') || i.output.outpoint);
          const w = byId.get(issued.get(origin) ?? '');
          if (w) m.set(i.output.outpoint, w);
        });
        if (live) setGuns(m);
      })
      .catch(() => undefined); // tokenblaster.lol down: they just show as images
    return () => {
      live = false;
    };
  }, [items]);

  const shown = useMemo(
    () =>
      filter === 'all'
        ? items
        : filter === '3d'
          ? items.filter((i) => guns.has(i.output.outpoint))
          : items.filter((i) => i.kind === filter),
    [items, filter, guns],
  );
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: items.length, music: 0, video: 0, images: 0, other: 0, '3d': guns.size };
    items.forEach((i) => c[i.kind]++);
    return c;
  }, [items, guns]);

  const tap = (item: MediaItem) => {
    if (item.kind === 'music') return playMusic(shown, item);
    if (item.kind === 'video') pauseAudio();
    setOpen(item);
  };

  const tile = (item: MediaItem) => {
    const gun = guns.get(item.output.outpoint);
    return gun && WeaponTile ? (
      <Suspense key={item.output.outpoint} fallback={null}>
        <WeaponTile weapon={gun} onOpen={() => setCabinet(gun)} sub="Verified" />
      </Suspense>
    ) : (
      <button
        key={item.output.outpoint}
        onClick={() => tap(item)}
        className="relative rounded-xl overflow-hidden bg-[var(--bw-surface)] border border-white/5"
        style={{ aspectRatio: '1/1' }}
      >
        <Blurred forceBlur={item.flagged}>
          {item.kind === 'images' && (
            <img src={item.url} alt={item.name} loading="lazy" className="w-full h-full object-cover" />
          )}
          {item.kind === 'video' && <VideoPoster outpoint={item.origin || item.output.outpoint} title={item.name} />}
          {(item.kind === 'music' || item.kind === 'other') && (
            <div className="w-full h-full flex items-center justify-center">
              {item.kind === 'music' ? (
                <Music size={28} style={{ color: '#A1FF8B' }} />
              ) : (
                <FileQuestion size={28} style={{ color: '#98A2B3' }} />
              )}
            </div>
          )}
        </Blurred>
        {(item.kind === 'music' || item.kind === 'video') && (
          <Play size={14} className="absolute top-1.5 right-1.5" color="#fff" fill="#fff" />
        )}
        {item.pending && (
          <span className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold text-[color:var(--bw-accent)]">
            Pending
          </span>
        )}
        <div
          className={`absolute bottom-0 inset-x-0 bg-black/60 px-1.5 py-1 text-[10px] text-white text-left ${ELLIPSIS}`}
        >
          {item.name}
        </div>
      </button>
    );
  };

  return (
    <div className="w-full flex flex-col">
      <div className="w-full px-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-widest text-[#98A2B3]">Media</span>
          <div className="flex items-center gap-2">
            {refreshNote && <span className="text-[11px] text-[#98A2B3]">{refreshNote}</span>}
            <button
              aria-label="Refresh NFTs"
              onClick={() => void doRefresh()}
              disabled={refreshing}
              className="flex items-center gap-1 rounded-lg bg-[var(--bw-surface)] px-3 py-1.5 text-xs font-semibold text-white"
            >
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
            <button
              onClick={() => navigate('/ord-wallet')}
              className="flex items-center gap-1 rounded-lg bg-[var(--bw-surface)] px-3 py-1.5 text-xs font-semibold text-white"
            >
              <Send size={12} /> Send / List
            </button>
          </div>
        </div>
        {/* Your bAvatar, minted or not (nfts/BavatarKeep): replacing the card picture never loses it. */}
        <BavatarKeep
          mintedOutpoint={items.find((i) => isBavatarItem(i.name))?.output.outpoint.replace('.', '_')}
          onOpen={(op) => navigate(`/m/nfts/${op}`)}
        />
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.filter((f) => f.id !== '3d' || guns.size > 0).map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
              style={{
                background: filter === f.id ? '#A1FF8B' : '#17191E',
                color: filter === f.id ? '#010101' : '#98A2B3',
              }}
            >
              {f.label} {counts[f.id] > 0 ? counts[f.id] : ''}
            </button>
          ))}
        </div>
        {error && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--bw-surface)] px-3 py-2">
            <p className="text-xs text-[#98A2B3]">{error}</p>
            <button onClick={reload} className="shrink-0 text-xs font-semibold text-[color:var(--bw-accent-hi)]">
              Try again
            </button>
          </div>
        )}
        <KeptAirdrops pending={keptPending} />
        {!loading && shown.length === 0 && !keptPending.length && items.length > 0 && (
          <p className="text-sm text-[#98A2B3] text-center py-10">Nothing in this filter.</p>
        )}
        {/* Empty by default for most people (owner, 14 Oct 2026): point at the store, not at a blank grid. */}
        {!loading && items.length === 0 && !keptPending.length && (
          <div className="rounded-2xl p-5 flex flex-col gap-3 text-center" style={{ background: '#101114' }}>
            <p className="text-sm text-white font-semibold m-0">Nothing here yet.</p>
            <p className="text-xs text-[#98A2B3] m-0">
              Music, video and pictures you buy or mint live here and play from here.
            </p>
            <div className="flex flex-wrap justify-center gap-2 mt-1">
              <button
                type="button"
                onClick={() => navigate('/m/media/browse')}
                className="rounded-xl px-4 py-2 text-sm font-bold"
                style={{ background: 'var(--bw-accent-hi)', color: '#1a1300' }}
              >
                Browse the store
              </button>
              <button
                type="button"
                onClick={() => navigate('/m/bmint')}
                className="rounded-xl px-4 py-2 text-sm font-semibold text-white"
                style={{ border: '1px solid #2b2f36' }}
              >
                Mint your own
              </button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">{shown.map(tile)}</div>
        {hasMore && (
          <button
            onClick={() => void loadMore()}
            disabled={loading}
            className="rounded-xl bg-[var(--bw-surface)] py-2.5 text-xs font-semibold text-[#98A2B3]"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
        {hiddenUnbroadcast > 0 && (
          <p className="text-[11px] text-center text-[#98A2B3]">
            {hiddenUnbroadcast} item{hiddenUnbroadcast === 1 ? '' : 's'} from a mint or send that never reached the
            blockchain
            {hiddenUnbroadcast === 1 ? ' is' : ' are'} hidden: there is nothing on chain to send.
          </p>
        )}
        {/* A refresh at the bottom too, where the eye ends up after scrolling (owner, 12 Oct 2026). */}
        <button
          onClick={() => void doRefresh()}
          disabled={refreshing}
          className="flex items-center justify-center gap-2 rounded-xl bg-[var(--bw-surface)] py-2.5 text-xs font-semibold text-white"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing NFTs…' : 'Refresh NFTs'}
        </button>
      </div>

      {open && <NftDetail item={open} all={items} onClose={() => setOpen(null)} onSent={reload} />}
      {cabinet && LazyCabinet && (
        <Suspense fallback={null}>
          <LazyCabinet weapon={cabinet} owned onClose={() => setCabinet(null)} />
        </Suspense>
      )}
    </div>
  );
};
