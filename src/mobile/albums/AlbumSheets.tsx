/**
 * Album UI shared by Wallet › NFTs, the token list and the Exchange (albums.ts has the rules).
 *  - AlbumBar: a wrapping grid of album chips (never a sideways-scrolling strip): All, the user's albums,
 *    "New album", and Hidden last, like Photos.
 *  - AddToAlbumSheet: tick albums for one item or a selection, make a new one inline, Hide / Unhide.
 *  - AlbumNameSheet: name a new album or rename one; the album menu also moves and deletes it.
 */
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Check, EyeOff, Eye, FolderPlus, Minus, Pencil, Trash2, X } from 'lucide-react';
import {
  MAX_ALBUM_NAME,
  createAlbum,
  deleteAlbum,
  isHidden,
  membership,
  moveAlbum,
  renameAlbum,
  setHidden,
  setInAlbum,
  type AlbumState,
  type AlbumView,
  type ItemKey,
} from './albums';

/** Said wherever Hide is offered. */
export const HIDE_NOTE =
  'Hiding only changes what you see here. Nothing is moved, sent or burned: it stays yours on chain.';

type Update = (fn: (s: AlbumState) => AlbumState) => void;

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) =>
  createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button aria-label="Close" className="absolute inset-0 bg-black/60 border-0 cursor-default" onClick={onClose} />
      <div
        className="relative w-full max-w-md rounded-t-2xl px-4 pt-4 flex flex-col gap-3 max-h-[80vh] overflow-y-auto"
        style={{
          background: 'var(--bw-card, #111216)',
          color: 'var(--bw-text, #fff)',
          borderTop: '1px solid var(--bw-line, rgba(255,255,255,0.1))',
          paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-base font-semibold m-0">{title}</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="h-9 w-9 flex items-center justify-center rounded-full bg-transparent border-0 cursor-pointer"
            style={{ color: 'var(--bw-text, #fff)' }}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );

const field =
  'w-full rounded-xl px-3 py-2.5 text-sm outline-none bg-[var(--bw-surface)] border border-[color:var(--bw-line,rgba(255,255,255,0.1))]';
const goldBtn = 'rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-40 border-0 cursor-pointer';

/** One text box + Save. */
const NameForm = ({ initial, cta, onSave }: { initial: string; cta: string; onSave: (name: string) => void }) => {
  const [name, setName] = useState(initial);
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name);
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={MAX_ALBUM_NAME}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        aria-label="Name"
        className={field}
        style={{ color: 'var(--bw-text, #fff)' }}
      />
      <button
        type="submit"
        disabled={!name.trim()}
        className={goldBtn}
        style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent, #010101)' }}
      >
        {cta}
      </button>
    </form>
  );
};

/** New album (optionally filling it with `items`), or rename / move / delete an existing one. */
export const AlbumNameSheet = ({
  state,
  update,
  albumId,
  items = [],
  onDone,
  onClose,
  word = 'album',
}: {
  state: AlbumState;
  update: Update;
  word?: 'album' | 'folder';
  /** Set = edit this album; unset = make a new one. */
  albumId?: string;
  items?: readonly ItemKey[];
  onDone?: (id: string) => void;
  onClose: () => void;
}) => {
  const idx = albumId ? state.albums.findIndex((a) => a.id === albumId) : -1;
  const album = idx >= 0 ? state.albums[idx] : undefined;
  const [confirm, setConfirm] = useState(false);
  if (!album)
    return (
      <Sheet title={`New ${word}`} onClose={onClose}>
        <NameForm
          initial=""
          cta="Create"
          onSave={(name) => {
            let id = '';
            update((s) => {
              const r = createAlbum(s, name, items);
              id = r.id;
              return r.state;
            });
            onDone?.(id);
            onClose();
          }}
        />
      </Sheet>
    );
  const small =
    'flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-semibold bg-[var(--bw-surface)] border-0 cursor-pointer disabled:opacity-40';
  return (
    <Sheet title={album.name} onClose={onClose}>
      <NameForm
        initial={album.name}
        cta="Rename"
        onSave={(name) => {
          update((s) => renameAlbum(s, album.id, name));
          onClose();
        }}
      />
      <div className="grid grid-cols-3 gap-2">
        <button
          className={small}
          style={{ color: 'var(--bw-text, #fff)' }}
          disabled={idx === 0}
          onClick={() => update((s) => moveAlbum(s, album.id, idx - 1))}
        >
          <ArrowUp size={15} /> Up
        </button>
        <button
          className={small}
          style={{ color: 'var(--bw-text, #fff)' }}
          disabled={idx === state.albums.length - 1}
          onClick={() => update((s) => moveAlbum(s, album.id, idx + 1))}
        >
          <ArrowDown size={15} /> Down
        </button>
        <button
          className={small}
          style={{ color: '#F97066' }}
          onClick={() => {
            if (!confirm) return setConfirm(true);
            update((s) => deleteAlbum(s, album.id));
            onClose();
          }}
        >
          <Trash2 size={15} /> {confirm ? 'Sure?' : 'Delete'}
        </button>
      </div>
      <p className="text-xs m-0" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
        Deleting {word === 'album' ? 'an album' : 'a folder'} keeps everything in it. Only the {word} goes.
      </p>
    </Sheet>
  );
};

/** Tick the albums these items belong in; Hide / Unhide them. */
export const AddToAlbumSheet = ({
  state,
  update,
  keys,
  title,
  onClose,
  noHide,
  word = 'album',
}: {
  state: AlbumState;
  update: Update;
  keys: readonly ItemKey[];
  title?: string;
  onClose: () => void;
  /** Lists with their own hide (token Archive, Exchange Hide) leave it to them. */
  noHide?: boolean;
  word?: 'album' | 'folder';
}) => {
  const [naming, setNaming] = useState(false);
  const allHidden = keys.length > 0 && keys.every((k) => isHidden(state, k));
  const label = title ?? (keys.length === 1 ? `Add to ${word}` : `Add ${keys.length} to ${word}`);
  return (
    <Sheet title={label} onClose={onClose}>
      {state.albums.length > 0 && (
        <ul className="flex flex-col gap-1 list-none m-0 p-0">
          {state.albums.map((a) => {
            const m = membership(state, a.id, keys);
            return (
              <li key={a.id}>
                <button
                  role="checkbox"
                  aria-checked={m === 'all' ? true : m === 'some' ? 'mixed' : false}
                  onClick={() => update((s) => setInAlbum(s, a.id, keys, m !== 'all'))}
                  className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm bg-[var(--bw-surface)] border-0 cursor-pointer"
                  style={{ color: 'var(--bw-text, #fff)' }}
                >
                  <span
                    className="h-5 w-5 shrink-0 rounded-md flex items-center justify-center"
                    style={{
                      background: m === 'none' ? 'transparent' : 'var(--bw-accent)',
                      border: '1.5px solid var(--bw-accent)',
                      color: 'var(--bw-on-accent, #010101)',
                    }}
                  >
                    {m === 'all' ? <Check size={13} /> : m === 'some' ? <Minus size={13} /> : null}
                  </span>
                  <span className="flex-1 truncate">{a.name}</span>
                  <span className="text-xs" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
                    {a.items.length}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {naming ? (
        <NameForm
          initial=""
          cta="Create"
          onSave={(name) => {
            update((s) => createAlbum(s, name, keys).state);
            setNaming(false);
          }}
        />
      ) : (
        <button
          onClick={() => setNaming(true)}
          className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold bg-transparent cursor-pointer"
          style={{ color: 'var(--bw-accent)', border: '1px dashed var(--bw-accent)' }}
        >
          <FolderPlus size={16} /> New {word}
        </button>
      )}
      {!noHide && (
        <>
          <button
            onClick={() => {
              update((s) => setHidden(s, keys, !allHidden));
              onClose();
            }}
            className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold bg-[var(--bw-surface)] border-0 cursor-pointer"
            style={{ color: 'var(--bw-text, #fff)' }}
          >
            {allHidden ? <Eye size={16} /> : <EyeOff size={16} />} {allHidden ? 'Unhide' : 'Hide'}
          </button>
          <p className="text-xs m-0" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
            {HIDE_NOTE}
          </p>
        </>
      )}
    </Sheet>
  );
};

/**
 * All · albums · New album · Hidden, as wrapping chips. Tapping the chip of the album already open opens its
 * menu (rename, move, delete).
 */
export const AlbumBar = ({
  state,
  update,
  view,
  onView,
  counts,
  word = 'album',
}: {
  state: AlbumState;
  update: Update;
  view: AlbumView;
  onView: (v: AlbumView) => void;
  counts: { all: number; hidden: number; albums: Record<string, number> };
  /** 'album' (NFTs) or 'folder' (tokens, Exchange). */
  word?: 'album' | 'folder';
}) => {
  const [sheet, setSheet] = useState<{ edit?: string } | null>(null);
  const chip = (on: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full px-3 min-h-[32px] text-xs font-semibold border cursor-pointer ${
      on ? 'border-[color:var(--bw-accent)] bg-[color:var(--bw-accent)]/15 text-[color:var(--bw-accent)]' : ''
    }`;
  const off = {
    borderColor: 'var(--bw-line, rgba(255,255,255,0.1))',
    color: 'var(--bw-text, #D0D5DD)',
    background: 'transparent',
  };
  const Word = word === 'album' ? 'album' : 'folder';
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`${Word}s`}>
      <button
        className={chip(view.kind === 'all')}
        style={view.kind === 'all' ? undefined : off}
        aria-pressed={view.kind === 'all'}
        onClick={() => onView({ kind: 'all' })}
      >
        All {counts.all}
      </button>
      {state.albums.map((a) => {
        const on = view.kind === 'album' && view.id === a.id;
        return (
          <button
            key={a.id}
            className={chip(on)}
            style={on ? undefined : off}
            aria-pressed={on}
            onClick={() => (on ? setSheet({ edit: a.id }) : onView({ kind: 'album', id: a.id }))}
          >
            {a.name} {counts.albums[a.id] ?? 0}
            {on && <Pencil size={11} aria-label={`Edit ${a.name}`} />}
          </button>
        );
      })}
      <button className={chip(false)} style={{ ...off, borderStyle: 'dashed' }} onClick={() => setSheet({})}>
        <FolderPlus size={13} /> New {Word}
      </button>
      {(counts.hidden > 0 || view.kind === 'hidden') && (
        <button
          className={chip(view.kind === 'hidden')}
          style={view.kind === 'hidden' ? undefined : off}
          aria-pressed={view.kind === 'hidden'}
          onClick={() => onView(view.kind === 'hidden' ? { kind: 'all' } : { kind: 'hidden' })}
        >
          <EyeOff size={13} /> Hidden {counts.hidden}
        </button>
      )}
      {sheet && (
        <AlbumNameSheet
          state={state}
          update={update}
          albumId={sheet.edit}
          word={word}
          onDone={(id) => id && onView({ kind: 'album', id })}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
};
