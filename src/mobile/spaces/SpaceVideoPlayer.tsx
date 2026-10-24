/**
 * The synced Space video (spaceVideo.ts): everyone in the Space watches the same clip at the same
 * moment. Edge to edge, playsInline, autoplay muted with a tap for sound. Staff get host controls.
 * Live updates come as LiveKit data packets (topic 'space-video'); mesh Spaces poll every 10 s.
 * Album Spaces: the host runs an ordered list; everyone sees "now playing n/N" and the track list,
 * and a staff phone moves the room to the next track when a video ends (album_goto, version-guarded).
 * Tickets are the room's existing door (door.ts / DoorButton), not a new payment.
 */
import { useWithoutHidden } from '../albums/useAlbums';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatApiError, type BchatClient } from '../chat/api';
import { useWalletMedia } from '../media/useWalletMedia';
import type { SpaceMedia } from './media';
import {
  ALBUM_MAX,
  albumCursor,
  isTimedAlbum,
  isAllowedVideoSrc,
  MESH_POLL_MS,
  moveItem,
  nowPlaying,
  needsReseek,
  newerVideo,
  ordinalSrc,
  parseSpaceVideo,
  parseVideoPacket,
  positionOf,
  type AlbumDraftItem,
  type SpaceVideo,
  type VideoAction,
} from './spaceVideo';

type Props = {
  client: BchatClient;
  ticker: string;
  media: SpaceMedia;
  /** Space transport: 'sfu' gets data packets; anything else polls. */
  transport: string;
  /** Room staff (host / moderator): shows the controls until the server refuses a PATCH. */
  staff: boolean;
};

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const SpaceVideoPlayer = ({ client, ticker, media, transport, staff }: Props) => {
  const [video, setVideo] = useState<SpaceVideo | null>(null);
  const videoRef = useRef<SpaceVideo | null>(null);
  const el = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(true);
  const [mayControl, setMayControl] = useState(staff);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => setMayControl(staff), [staff]);

  const take = useCallback((raw: unknown, at = Date.now()) => {
    const next = newerVideo(videoRef.current, parseSpaceVideo(raw, at));
    if (next !== videoRef.current) {
      videoRef.current = next;
      setVideo(next);
    }
  }, []);

  const fetchNow = useCallback(async () => {
    try {
      take(await client.spaceVideo(ticker));
    } catch {
      /* the next packet or poll catches up */
    }
  }, [client, ticker, take]);

  // First read, then packets (SFU) or a 10 s poll (mesh).
  useEffect(() => {
    void fetchNow();
    const off = media.onData((topic, payload) => {
      const next = newerVideo(videoRef.current, parseVideoPacket(topic, payload, Date.now()));
      if (next !== videoRef.current) {
        videoRef.current = next;
        setVideo(next);
      }
    });
    const id = transport === 'sfu' ? null : setInterval(() => void fetchNow(), MESH_POLL_MS);
    return () => {
      off();
      if (id) clearInterval(id);
    };
  }, [media, transport, fetchNow]);

  // Timed album: the track index follows the clock between packets (albumCursor).
  const [trackIndex, setTrackIndex] = useState<number | null>(null);

  // Keep the element on the room's clock: state changes and a 1 s drift check.
  const sync = useCallback(() => {
    const v = videoRef.current;
    const e = el.current;
    let ms: number;
    let ended: boolean;
    if (v && isTimedAlbum(v.album)) {
      const c = albumCursor(v, Date.now())!;
      setTrackIndex(c.index);
      ms = c.ms;
      ended = c.stopped;
      if (!e || e.dataset.track !== String(c.index)) return; // the element for this track mounts next render
    } else {
      setTrackIndex(null);
      if (!v?.item || !e) return;
      const durMs = Number.isFinite(e.duration) ? e.duration * 1000 : undefined;
      ({ ms, ended } = positionOf(v, Date.now(), durMs));
    }
    if (needsReseek(e.currentTime * 1000, ms)) {
      try {
        e.currentTime = ms / 1000;
      } catch {
        /* not seekable yet; retried on loadedmetadata */
      }
    }
    if (v.state === 'playing' && !ended) {
      if (e.paused) void e.play().catch(() => undefined);
    } else if (!e.paused) e.pause();
  }, []);
  useEffect(() => {
    sync();
    if (!video?.item) return;
    const id = setInterval(sync, 1000);
    return () => clearInterval(id);
  }, [video, sync]);

  const act = async (body: VideoAction) => {
    try {
      const r = (await client.spaceVideoAction(ticker, { ...body, if_version: videoRef.current?.version })) as {
        video?: unknown;
      };
      if (r?.video) take(r.video);
    } catch (e) {
      const status = e instanceof ChatApiError ? e.status : 0;
      if (status === 401 || status === 403) {
        setMayControl(false);
        setNote('Only the host and moderators can control the video.');
      } else if (status === 409) {
        take((e as ChatApiError).data);
        setNote('Someone changed the video first. Try again.');
      } else if (status === 429) setNote('Too many changes. Wait a moment.');
      else setNote(e instanceof Error ? e.message : 'Could not change the video.');
    }
  };

  // Untimed album: ANY viewer reports the end (album_next, bit-sign #297). A 409 (stale_index: someone
  // beat us; too_early: under 20 s in) is expected and ignored; the packet/poll brings the next track.
  const advancedFor = useRef(-1);
  const onEnded = () => {
    const v = videoRef.current;
    if (v?.album) {
      if (isTimedAlbum(v.album) || advancedFor.current === v.version) return;
      advancedFor.current = v.version;
      client
        .spaceVideoAction(ticker, { action: 'album_next', from_index: v.album.index })
        .then((r) => {
          const out = r as { video?: unknown } | null;
          if (out?.video) take(out.video);
        })
        .catch(() => void fetchNow());
      return;
    }
    if (!v?.loop) el.current?.pause();
  };

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(''), 4000);
    return () => clearTimeout(id);
  }, [note]);

  const timedIndex = video?.album && isTimedAlbum(video.album) ? (trackIndex ?? video.album.index) : null;
  const item = timedIndex !== null && video?.album ? (video.album.items[timedIndex] ?? null) : (video?.item ?? null);
  return (
    <>
      {item && (
        <div className="relative w-full shrink-0" style={{ background: '#000' }}>
          <video
            key={`${timedIndex ?? ''}-${item.src}`}
            ref={el}
            data-track={timedIndex ?? undefined}
            src={item.src}
            poster={item.poster}
            playsInline
            autoPlay
            muted={muted}
            preload="auto"
            onLoadedMetadata={sync}
            onEnded={onEnded}
            className="block w-full"
            style={{ maxHeight: '45vh', objectFit: 'contain', background: '#000' }}
            aria-label={item.title ?? 'Space video'}
          />
          {muted && (
            <button
              onClick={() => {
                setMuted(false);
                if (el.current) {
                  el.current.muted = false;
                  if (videoRef.current?.state === 'playing') void el.current.play().catch(() => undefined);
                }
              }}
              className="absolute left-3 bottom-3 rounded-full px-3 py-1.5 text-xs font-semibold"
              style={{ background: 'rgb(0 0 0 / .6)', color: 'var(--bw-text)', border: '1px solid var(--bw-line)' }}
            >
              Tap for sound
            </button>
          )}
          {item.title && (
            <div
              className="absolute left-3 top-2 right-16 text-xs font-semibold overflow-hidden whitespace-nowrap text-ellipsis"
              style={{ color: 'var(--bw-text)', textShadow: '0 1px 2px #000' }}
            >
              {item.title}
            </div>
          )}
        </div>
      )}
      {video?.album && <TrackList video={video} />}
      {mayControl && (
        <HostControls
          video={video}
          open={controlsOpen}
          setOpen={setControlsOpen}
          act={act}
          setNote={setNote}
          position={() => (el.current ? el.current.currentTime * 1000 : 0)}
        />
      )}
      {note && (
        <p role="status" className="text-center text-xs m-0 py-1" style={{ color: 'var(--bw-muted)' }}>
          {note}
        </p>
      )}
    </>
  );
};

const btn = 'rounded-lg px-3 h-9 text-xs font-semibold disabled:opacity-50';
const btnStyle = { background: 'var(--bw-surface)', color: 'var(--bw-text)', border: '1px solid var(--bw-line)' };
const goldStyle = { background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' };

const HostControls = ({
  video,
  open,
  setOpen,
  act,
  setNote,
  position,
}: {
  video: SpaceVideo | null;
  open: boolean;
  setOpen: (o: boolean) => void;
  act: (b: VideoAction) => Promise<void>;
  setNote: (n: string) => void;
  position: () => number;
}) => {
  const [url, setUrl] = useState('');
  const [picking, setPicking] = useState(false);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (b: VideoAction) => {
    setBusy(true);
    await act(b);
    setBusy(false);
  };
  const loop = !!video?.loop;
  const has = !!video?.item;
  const state = video?.state ?? 'stopped';

  if (!open)
    return (
      <div className="flex justify-end px-3 py-1">
        <button onClick={() => setOpen(true)} className={btn} style={btnStyle}>
          {has ? 'Video controls' : 'Play a video'}
        </button>
      </div>
    );

  const playUrl = () => {
    const src = url.trim();
    if (!isAllowedVideoSrc(src)) {
      setNote('Use an https video link (mp4, webm, mov, m3u8…) or an ordinal.');
      return;
    }
    void run({ action: 'play', item: { kind: 'url', src }, loop });
    setUrl('');
  };

  return (
    <div
      className="px-3 py-2 flex flex-col gap-2"
      style={{ background: 'var(--bw-card)', borderTop: '1px solid var(--bw-line)' }}
    >
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste an https video link"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 rounded-lg px-3 h-9 text-sm"
          style={{ background: 'var(--bw-bg)', color: 'var(--bw-text)', border: '1px solid var(--bw-line)' }}
        />
        <button onClick={playUrl} disabled={busy || !url.trim()} className={btn} style={goldStyle}>
          Play
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setPicking((p) => !p)} className={btn} style={btnStyle}>
          {picking ? 'Hide my videos' : 'My video NFTs'}
        </button>
        <button onClick={() => setAlbumOpen((o) => !o)} className={btn} style={albumOpen ? goldStyle : btnStyle}>
          {video?.album ? 'Edit album' : 'Album'}
        </button>
        {has && state === 'playing' && (
          <button disabled={busy} onClick={() => void run({ action: 'pause' })} className={btn} style={btnStyle}>
            Pause
          </button>
        )}
        {has && state === 'paused' && (
          <button disabled={busy} onClick={() => void run({ action: 'resume' })} className={btn} style={btnStyle}>
            Resume
          </button>
        )}
        {has && (
          <>
            <button
              disabled={busy}
              onClick={() => void run({ action: 'seek', position_ms: Math.max(0, Math.round(position() - 10_000)) })}
              className={btn}
              style={btnStyle}
            >
              −10s
            </button>
            <button
              disabled={busy}
              onClick={() => void run({ action: 'seek', position_ms: Math.round(position() + 10_000) })}
              className={btn}
              style={btnStyle}
            >
              +10s
            </button>
            <button
              disabled={busy}
              onClick={() => void run({ action: 'seek', position_ms: 0 })}
              className={btn}
              style={btnStyle}
            >
              Restart
            </button>
            <button disabled={busy} onClick={() => void run({ action: 'stop' })} className={btn} style={btnStyle}>
              Stop
            </button>
          </>
        )}
        {!video?.album && (
          <button
            role="switch"
            aria-checked={loop}
            disabled={busy}
            onClick={() => void run({ action: 'set_loop', loop: !loop })}
            className={btn}
            style={loop ? goldStyle : btnStyle}
          >
            Loop {loop ? 'on' : 'off'}
          </button>
        )}
        <button onClick={() => setOpen(false)} className={btn} style={btnStyle}>
          Close
        </button>
      </div>
      {has && (
        <p className="text-[11px] m-0" style={{ color: 'var(--bw-muted)' }}>
          {state} · {fmt(position())}
        </p>
      )}
      {albumOpen && <AlbumEditor video={video} run={run} busy={busy} setNote={setNote} />}
      {picking && (
        <OrdinalPicker
          onPick={(origin, title) => {
            setPicking(false);
            void run({
              action: 'play',
              item: { kind: 'ordinal', src: ordinalSrc(origin), outpoint: origin.replace('.', '_'), title },
              loop,
            });
          }}
        />
      )}
    </div>
  );
};

/** The wallet's own video inscriptions (mounted only when opened, so lists load on demand). */
const OrdinalPicker = ({ onPick }: { onPick: (origin: string, title: string) => void }) => {
  const { items: shownRaw, loading, error } = useWalletMedia();
  const items = useWithoutHidden(shownRaw);
  const vids = items.filter((i) => i.kind === 'video' && !i.pending && !i.flagged);
  if (error)
    return (
      <p className="text-xs m-0" style={{ color: 'var(--bw-muted)' }}>
        {error}
      </p>
    );
  if (!vids.length)
    return (
      <p className="text-xs m-0" style={{ color: 'var(--bw-muted)' }}>
        {loading ? 'Loading your videos…' : 'No video NFTs in this wallet.'}
      </p>
    );
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1 max-h-48 overflow-y-auto">
      {vids.map((i) => (
        <li key={i.origin}>
          <button
            onClick={() => onPick(i.origin, i.name)}
            className="w-full text-left rounded-lg px-3 py-2 text-sm overflow-hidden whitespace-nowrap text-ellipsis"
            style={btnStyle}
          >
            {i.name || i.origin.slice(0, 12)}
          </button>
        </li>
      ))}
    </ul>
  );
};

/** Everyone: "Now playing n/N" and the run, current track marked. */
const TrackList = ({ video }: { video: SpaceVideo }) => {
  const [open, setOpen] = useState(false);
  const np = nowPlaying(video);
  if (!np || !video.album) return null;
  return (
    <div className="px-3 py-1.5" style={{ borderBottom: '1px solid var(--bw-line)' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left text-xs bg-transparent border-0 p-0"
        style={{ color: 'var(--bw-text)' }}
      >
        <span className="font-semibold shrink-0" style={{ color: 'var(--bw-accent)' }}>
          Now playing {np.n}/{np.total}
        </span>
        <span className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis">{np.title}</span>
        <span style={{ color: 'var(--bw-muted)' }}>{open ? 'Hide' : 'Tracks'}</span>
      </button>
      {open && (
        <ol className="m-0 mt-1 pl-5 flex flex-col gap-0.5 max-h-40 overflow-y-auto text-xs">
          {video.album.items.map((it, i) => (
            <li
              key={`${i}-${it.src}`}
              aria-current={i === np.index ? 'true' : undefined}
              className="overflow-hidden whitespace-nowrap text-ellipsis"
              style={{
                color: i === np.index ? 'var(--bw-accent)' : 'var(--bw-muted)',
                fontWeight: i === np.index ? 600 : 400,
              }}
            >
              {it.title || `Video ${i + 1}`}
            </li>
          ))}
        </ol>
      )}
      {video.album.repeat && (
        <p className="text-[11px] m-0 mt-0.5" style={{ color: 'var(--bw-muted)' }}>
          On repeat
        </p>
      )}
    </div>
  );
};

/** Host: build the run (links or own video NFTs), reorder it, then start it in the room. */
const AlbumEditor = ({
  video,
  run,
  busy,
  setNote,
}: {
  video: SpaceVideo | null;
  run: (b: VideoAction) => Promise<void>;
  busy: boolean;
  setNote: (n: string) => void;
}) => {
  const [draft, setDraft] = useState<AlbumDraftItem[]>(() =>
    (video?.album?.items ?? []).map((i) => ({
      kind: i.kind,
      src: i.kind === 'ordinal' && i.outpoint ? i.outpoint : i.src,
      ...(i.outpoint ? { outpoint: i.outpoint } : {}),
      ...(i.title ? { title: i.title } : {}),
    })),
  );
  const [repeat, setRepeat] = useState(video?.album?.repeat ?? true);
  const [url, setUrl] = useState('');
  const [picking, setPicking] = useState(false);
  const add = (it: AlbumDraftItem) => {
    if (draft.length >= ALBUM_MAX) {
      setNote(`An album holds up to ${ALBUM_MAX} videos.`);
      return;
    }
    setDraft((d) => [...d, it]);
  };
  const addUrl = () => {
    const src = url.trim();
    if (!isAllowedVideoSrc(src)) {
      setNote('Use an https video link (mp4, webm, mov, m3u8…) or an ordinal.');
      return;
    }
    add({ kind: 'url', src, title: decodeURIComponent(src.split('/').pop() || '').slice(0, 120) || undefined });
    setUrl('');
  };
  const live = !!video?.album;
  return (
    <div className="flex flex-col gap-2 rounded-lg p-2" style={{ border: '1px solid var(--bw-line)' }}>
      <p className="text-xs m-0 font-semibold" style={{ color: 'var(--bw-text)' }}>
        Album Space
      </p>
      <p className="text-[11px] m-0" style={{ color: 'var(--bw-muted)' }}>
        Your videos play in order for everyone in the room. Entry uses this room&rsquo;s ticket at the door.
      </p>
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Add an https video link"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 rounded-lg px-3 h-9 text-sm"
          style={{ background: 'var(--bw-bg)', color: 'var(--bw-text)', border: '1px solid var(--bw-line)' }}
        />
        <button onClick={addUrl} disabled={!url.trim()} className={btn} style={btnStyle}>
          Add
        </button>
      </div>
      <button onClick={() => setPicking((p) => !p)} className={btn} style={btnStyle}>
        {picking ? 'Hide my videos' : 'Add my video NFTs'}
      </button>
      {picking && (
        <OrdinalPicker
          onPick={(origin, title) =>
            add({ kind: 'ordinal', src: origin.replace('.', '_'), outpoint: origin.replace('.', '_'), title })
          }
        />
      )}
      {draft.length > 0 && (
        <ol className="m-0 p-0 list-none flex flex-col gap-1">
          {draft.map((it, i) => (
            <li key={`${i}-${it.src}`} className="flex items-center gap-1">
              <span className="w-5 text-[11px] text-right shrink-0" style={{ color: 'var(--bw-muted)' }}>
                {i + 1}
              </span>
              <span
                className="flex-1 min-w-0 text-xs overflow-hidden whitespace-nowrap text-ellipsis"
                style={{ color: 'var(--bw-text)' }}
              >
                {it.title || it.src}
              </span>
              <button
                aria-label={`Move ${i + 1} up`}
                disabled={i === 0}
                onClick={() => setDraft((d) => moveItem(d, i, i - 1))}
                className="rounded px-2 h-7 text-xs disabled:opacity-30"
                style={btnStyle}
              >
                ↑
              </button>
              <button
                aria-label={`Move ${i + 1} down`}
                disabled={i === draft.length - 1}
                onClick={() => setDraft((d) => moveItem(d, i, i + 1))}
                className="rounded px-2 h-7 text-xs disabled:opacity-30"
                style={btnStyle}
              >
                ↓
              </button>
              <button
                aria-label={`Remove ${i + 1}`}
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                className="rounded px-2 h-7 text-xs"
                style={btnStyle}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          role="switch"
          aria-checked={repeat}
          onClick={() => setRepeat((r) => !r)}
          className={btn}
          style={repeat ? goldStyle : btnStyle}
        >
          {repeat ? 'On repeat' : 'Play once'}
        </button>
        <button
          disabled={busy || !draft.length}
          onClick={() => void run({ action: 'set_album', items: draft, repeat, index: 0 })}
          className={btn}
          style={goldStyle}
        >
          {live ? 'Update album' : 'Start album'}
        </button>
        {live && (
          <button disabled={busy} onClick={() => void run({ action: 'clear_album' })} className={btn} style={btnStyle}>
            End album
          </button>
        )}
      </div>
    </div>
  );
};
