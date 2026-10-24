import { useWithoutHidden } from '../albums/useAlbums';
import { useEffect, useMemo, useState } from 'react';
import { Film } from 'lucide-react';
import { useWalletMedia, type MediaItem } from '../media/useWalletMedia';
import { thumbUrl } from '../market/thumbs';
import { cachedPoster, loadVideoPoster } from '../media/videoCover';
import { cardNftChoices } from './cardVideoFrame';

/** Video tile: the clip's embedded cover when it has one, else gold art (never a grey box). */
function VideoThumb({ m }: { m: MediaItem }) {
  const op = m.origin.replace('.', '_');
  const [p, setP] = useState<string | null | undefined>(() => cachedPoster(op));
  useEffect(() => {
    if (m.pending) return;
    let live = true;
    void loadVideoPoster(op)
      .then((u) => live && setP(u))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [op, m.pending]);
  return (
    <>
      {p ? <img src={p} alt="" loading="lazy" draggable={false} /> : <span className="bw-cdes-vidgold" />}
      <span className="bw-cdes-vidbadge" aria-hidden="true">
        <Film size={12} />
      </span>
    </>
  );
}

/**
 * Card designer › My NFTs (owner, 12 Oct 2026): the account's picture NFTs, from the same list as Wallet › NFTs
 * (useWalletMedia / listOrdinals), shown as resized thumbnails and paged with "Load more". Raster images and video clips
 * (a frame of a clip goes on the card, CardFramePicker); NFTs the Market filter would block are left out here.
 */
export function CardNftGrid({
  selected,
  busy,
  onPick,
}: {
  selected: string | null;
  busy: string | null;
  onPick: (m: MediaItem) => void;
}) {
  const { items: shownRaw, hasMore, loading, error, loadMore } = useWalletMedia();
  const items = useWithoutHidden(shownRaw);
  const pics = useMemo(() => cardNftChoices(items), [items]);
  return (
    <div className="bw-cdes-nfts">
      {pics.length > 0 && (
        <div className="bw-cdes-lib" aria-label="My NFTs">
          {pics.map((i) => {
            const op = i.output.outpoint;
            return (
              <div key={op} className={`bw-cdes-libitem${selected === op ? ' is-on' : ''}`}>
                <button
                  type="button"
                  className="bw-cdes-libpic"
                  aria-label={`Put ${i.name} on the card`}
                  aria-pressed={selected === op}
                  aria-busy={busy === op}
                  disabled={!!busy}
                  onClick={() => onPick(i)}
                >
                  {i.kind === 'video' ? (
                    <VideoThumb m={i} />
                  ) : (
                    <img
                      src={thumbUrl(op) ?? i.url}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      onError={(e) => {
                        if (e.currentTarget.src !== i.url) e.currentTarget.src = i.url;
                      }}
                    />
                  )}
                  {busy === op && <span className="bw-cdes-libbusy" aria-hidden="true" />}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <p className="bw-cdes-imgerr" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && !pics.length && !hasMore && (
        <p className="bw-cdes-empty">No picture or video NFTs in this wallet yet.</p>
      )}
      {loading && <p className="bw-cdes-empty">Loading your NFTs…</p>}
      {hasMore && !loading && (
        <button type="button" className="bw-cdes-artback" onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </div>
  );
}
