/** Hooks for Exchange token-row actions (TokenRowActions.tsx renders them). */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, FolderPlus, Info, MessageCircle, Pin, PinOff, ShoppingCart, Tag } from 'lucide-react';
import type { SwipeAction } from '../swipe/SwipeRow';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { useBackClose } from '../backStack';
import { buyRoute, chatDecision, heldTokenIds, infoRoute, sellRoute, tokenActionIds } from './rowActions';
import { loadRowPrefs, onRowPrefs, saveRowPrefs, toggleHidden, togglePinned, type RowPrefs } from './rowPrefs';
import { HoldHint } from './TokenRowActions';
import { useAlbums } from '../albums/useAlbums';
import { AddToAlbumSheet } from '../albums/AlbumSheets';
import { tokenKey, type ItemKey } from '../albums/albums';

/** Exchange rows file under the same key as the wallet's token rows, so one folder holds both (albums.ts). */
export const exchangeKey = (id: string): ItemKey => tokenKey(id.replace('.', '_'));

/** Tray colours (theme tokens only), shared by every Exchange list. */
export const TRAY = {
  primary: { color: 'var(--bw-accent)', fg: 'var(--bw-on-accent)' },
  second: { color: 'var(--bw-accent-lo)', fg: 'var(--bw-text)' },
  plain: { color: 'var(--bw-card2, var(--bw-card))', fg: 'var(--bw-text)' },
} as const;

/** Open an on-chain record (whatsonchain) outside the app. */
export const openExternal = (url: string) => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* no window (tests) */
  }
};

/** Token IDs this wallet holds; null while loading or when the wallet cannot be read. */
export const useHeldTokenIds = (): ReadonlySet<string> | null => {
  const { apiContext } = useServiceContext();
  const [held, setHeld] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    let live = true;
    heldBsv21Balances(apiContext)
      .then((b) => live && setHeld(heldTokenIds(b)))
      .catch(() => live && setHeld(new Set()));
    return () => {
      live = false;
    };
  }, [apiContext]);
  return held;
};

/** Exchange pins and hides for the signed-in account (keyed by identity address), live across every list. */
export const useRowPrefs = () => {
  const { chromeStorageService } = useServiceContext();
  let account: string | null = null;
  try {
    account = chromeStorageService.getCurrentAccountObject()?.account?.addresses?.identityAddress ?? null;
  } catch {
    /* no account yet */
  }
  const [prefs, setPrefs] = useState<RowPrefs>(() => loadRowPrefs(account));
  useEffect(() => {
    setPrefs(loadRowPrefs(account));
    return onRowPrefs(() => setPrefs(loadRowPrefs(account)));
  }, [account]);
  const update = useCallback(
    (fn: (p: RowPrefs) => RowPrefs) => saveRowPrefs(account, fn(loadRowPrefs(account))),
    [account],
  );
  return [prefs, update] as const;
};

type HintTarget = { id: string; title: string };

/** Shared state for one list: the held set and the "Hold some to enter" sheet. */
export const useTokenRowActions = () => {
  const navigate = useNavigate();
  const { handleSelect } = useBottomMenu();
  const held = useHeldTokenIds();
  const [prefs, updatePrefs] = useRowPrefs();
  const [hint, setHint] = useState<HintTarget | null>(null);
  useBackClose(!!hint, () => setHint(null));
  // Folders (24 Oct 2026): the row menu's "Add to folder" files a token you buy, sell or watch.
  const [albums, updateAlbums] = useAlbums();
  const [filing, setFiling] = useState<HintTarget | null>(null);
  useBackClose(!!filing, () => setFiling(null));

  const openRoom = useCallback(
    (roomKey: string) => {
      requestChatRoom(roomKey);
      handleSelect(asMenuItem('chat'));
    },
    [handleSelect],
  );

  // Holdings were still loading when Chat was tapped: open the room as soon as they say we hold it.
  useEffect(() => {
    if (!hint) return;
    const d = chatDecision(hint.id, held);
    if (d.kind === 'open') {
      setHint(null);
      openRoom(d.roomKey);
    }
  }, [hint, held, openRoom]);

  /** Chat: the token's room when this wallet holds the token ID, else the "Hold some to enter" sheet. */
  const chatAction = (id: string, title: string): SwipeAction => ({
    id: 'chat',
    label: 'Chat',
    icon: <MessageCircle size={18} />,
    color: 'var(--bw-accent)',
    fg: 'var(--bw-on-accent)',
    onPress: () => {
      const d = chatDecision(id, held);
      if (d.kind === 'open') openRoom(d.roomKey);
      else setHint({ id, title });
    },
  });

  /** Swipe left: Buy · Sell (only when this wallet holds the token ID) · Chat. */
  const actionsFor = (id: string, title: string): SwipeAction[] =>
    tokenActionIds(id, held).map((a): SwipeAction => {
      if (a === 'chat') return chatAction(id, title);
      if (a === 'sell')
        return {
          id: a,
          label: 'Sell',
          icon: <Tag size={18} />,
          ...TRAY.second,
          onPress: () => navigate(sellRoute(id)),
        };
      return {
        id: a,
        label: 'Buy',
        icon: <ShoppingCart size={18} />,
        ...TRAY.primary,
        onPress: () => navigate(buyRoute(id)),
      };
    });

  /** Swipe right: Pin / Unpin · Hide / Unhide (per account, every Exchange list). */
  const sideActionsFor = (id: string): SwipeAction[] => {
    const pinned = prefs.pinned.includes(id);
    const hidden = prefs.hidden.includes(id);
    return [
      {
        id: 'pin',
        label: pinned ? 'Unpin' : 'Pin',
        icon: pinned ? <PinOff size={18} /> : <Pin size={18} />,
        ...TRAY.primary,
        onPress: () => updatePrefs((p) => togglePinned(p, id)),
      },
      {
        id: 'hide',
        label: hidden ? 'Unhide' : 'Hide',
        icon: hidden ? <Eye size={18} /> : <EyeOff size={18} />,
        ...TRAY.plain,
        removes: true,
        onPress: () => updatePrefs((p) => toggleHidden(p, id)),
      },
    ];
  };

  const infoAction = (id: string): SwipeAction => ({
    id: 'info',
    label: 'Info',
    icon: <Info size={18} />,
    ...TRAY.plain,
    onPress: () => navigate(infoRoute(id)),
  });

  const folderAction = (id: string, title: string): SwipeAction => ({
    id: 'folder',
    label: 'Add to folder',
    icon: <FolderPlus size={18} />,
    ...TRAY.plain,
    onPress: () => setFiling({ id, title }),
  });

  /** Everything TokenSwipeRow needs for a token row; the menu lists Buy, Sell, Chat, Pin, Hide, Folder, Info. */
  const rowFor = (id: string, title: string, left: SwipeAction[] = actionsFor(id, title)) => {
    const right = sideActionsFor(id);
    return {
      actions: left,
      rightActions: right,
      menuActions: [...left, ...right, folderAction(id, title), infoAction(id)],
      pinned: prefs.pinned.includes(id),
    };
  };

  const folderSheet = filing ? (
    <AddToAlbumSheet
      state={albums}
      update={updateAlbums}
      keys={[exchangeKey(filing.id)]}
      title={`Add ${filing.title} to folder`}
      word="folder"
      noHide
      onClose={() => setFiling(null)}
    />
  ) : null;

  const holdSheet = hint ? (
    <HoldHint
      title={hint.title}
      checking={held === null}
      onBuy={() => {
        const id = hint.id;
        setHint(null);
        navigate(buyRoute(id));
      }}
      onClose={() => setHint(null)}
    />
  ) : null;
  const sheet = (
    <>
      {holdSheet}
      {folderSheet}
    </>
  );

  return {
    actionsFor,
    sideActionsFor,
    infoAction,
    folderAction,
    albums,
    updateAlbums,
    rowFor,
    chatAction,
    sheet,
    held,
    openRoom,
    prefs,
    updatePrefs,
  };
};
