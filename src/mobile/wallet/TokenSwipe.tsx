/**
 * Wallet token rows with Telegram-style swipe actions (owner, 15 Oct 2026), on the shared SwipeRow.
 *  - Swipe LEFT: Send · Receive · Chat (full swipe = Send).
 *  - Swipe RIGHT: Pin · Lock · Folder (albums, 24 Oct 2026) · Archive (full swipe = Archive, with an Undo toast).
 *  - No long-press menu (owner, 15 Oct 2026): the swipes give every action. The tray matches the row's height.
 * Pins and archive are per device (tokenRows.ts). Not in the browser extension (no Chat tab there).
 */
import { useState, type ReactNode } from 'react';
import { Archive, ArrowDownLeft, ArrowUpRight, FolderPlus, Lock, MessageCircle, Pin, PinOff, Tag } from 'lucide-react';
import { SwipeRow, type SwipeAction } from '../swipe/SwipeRow';
import { showUndo, UndoToastHost } from '../swipe/undo';
import { IS_EXTENSION } from '../extension';
import { readPinned, setArchived, setPinned, togglePin } from './tokenRows';
import './tokenRows.css';

const ENABLED = !IS_EXTENSION;

export type TokenSwipeProps = {
  /** Stable row id: 'bsv', 'mnee' or the BSV-21 token id. */
  id: string;
  label: string;
  pinned: boolean;
  /** BSV and MNEE stay listed: no Archive. */
  noArchive?: boolean;
  onSend: () => void;
  onReceive: () => void;
  onChat: () => void;
  /** Omitted: no Lock in the tray (rows that can't lock in this build). */
  onLock?: () => void;
  /** Omitted: no Sell in the tray (BSV, MNEE, builds where listing is off). Opens List for sale. */
  onSell?: () => void;
  /** Omitted: no Folder in the tray. Opens the add-to-folder sheet (albums/AlbumSheets.tsx). */
  onFolder?: () => void;
  children: ReactNode;
};

export const TokenSwipe = (p: TokenSwipeProps) => {
  if (!ENABLED) return <>{p.children}</>;
  const left: SwipeAction[] = [
    { id: 'chat', label: 'Chat', color: '#2f6fed', icon: <MessageCircle size={18} />, onPress: p.onChat },
    { id: 'receive', label: 'Receive', color: '#1f9d55', icon: <ArrowDownLeft size={18} />, onPress: p.onReceive },
    { id: 'send', label: 'Send', color: '#e0a400', icon: <ArrowUpRight size={18} />, onPress: p.onSend },
  ];
  if (p.onSell)
    left.splice(left.length - 1, 0, {
      id: 'sell',
      label: 'Sell',
      color: '#d9480f',
      icon: <Tag size={18} />,
      onPress: p.onSell,
    });
  const right: SwipeAction[] = [
    {
      id: 'pin',
      label: p.pinned ? 'Unpin' : 'Pin',
      color: '#c9971a',
      icon: p.pinned ? <PinOff size={18} /> : <Pin size={18} />,
      onPress: () => setPinned(togglePin(readPinned(), p.id)),
    },
  ];
  if (p.onLock)
    right.push({ id: 'lock', label: 'Lock', color: '#7c5cff', icon: <Lock size={18} />, onPress: p.onLock });
  if (p.onFolder)
    right.push({
      id: 'folder',
      label: 'Folder',
      color: '#8a6d1f',
      icon: <FolderPlus size={18} />,
      onPress: p.onFolder,
    });
  if (!p.noArchive)
    right.push({
      id: 'archive',
      label: 'Archive',
      color: '#5b616b',
      icon: <Archive size={18} />,
      removes: true,
      onPress: () => {
        setArchived(p.id, true);
        showUndo(`${p.label} archived`, () => setArchived(p.id, false));
      },
    });
  return (
    <div className="bw-token-swipe relative">
      <SwipeRow
        label={p.label}
        rowId={`token-${p.id}`}
        leftActions={left}
        rightActions={right}
        fullSwipeLeft="send"
        fullSwipeRight={p.noArchive ? undefined : 'archive'}
        noMenu
      >
        {p.children}
      </SwipeRow>
      {p.pinned && (
        <span className="bw-pin-mark" aria-label="Pinned">
          <Pin size={11} fill="currentColor" />
        </span>
      )}
    </div>
  );
};

/** "Archived (n)" at the end of the token list: tap to show, each row has Unarchive. */
export const ArchivedTokens = ({ rows }: { rows: { id: string; node: ReactNode }[] }) => {
  const [open, setOpen] = useState(false);
  if (!ENABLED) return null;
  return (
    <>
      <UndoToastHost />
      {rows.length > 0 && (
        <div className="w-full px-4 pt-3">
          <button
            type="button"
            className="text-xs font-semibold uppercase tracking-wider bg-transparent border-0 cursor-pointer"
            style={{ color: '#8e8e89' }}
            onClick={() => setOpen((o) => !o)}
          >
            Archived ({rows.length}) {open ? '▾' : '▸'}
          </button>
          {open &&
            rows.map((r) => (
              <div key={r.id} className="flex items-center w-full opacity-70">
                <div className="flex-1 min-w-0">{r.node}</div>
                <button
                  type="button"
                  className="text-xs font-bold px-3 py-2 bg-transparent border-0 cursor-pointer"
                  style={{ color: 'var(--bw-accent, #f5b800)' }}
                  onClick={() => setArchived(r.id, false)}
                >
                  Unarchive
                </button>
              </div>
            ))}
        </div>
      )}
    </>
  );
};
