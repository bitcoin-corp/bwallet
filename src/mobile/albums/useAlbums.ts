/** Albums and hidden flags for the signed-in identity, live across every list (albumsStore.ts). */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { nftKey, type AlbumState } from './albums';
import { loadAlbums, onAlbums, updateAlbums } from './albumsStore';

export const useAlbumAccount = (): string | null => {
  const { chromeStorageService } = useServiceContext();
  try {
    return chromeStorageService.getCurrentAccountObject()?.account?.addresses?.identityAddress ?? null;
  } catch {
    return null;
  }
};

export const useAlbums = () => {
  const account = useAlbumAccount();
  const [state, setState] = useState<AlbumState>(() => loadAlbums(account));
  useEffect(() => {
    setState(loadAlbums(account));
    return onAlbums(() => setState(loadAlbums(account)));
  }, [account]);
  const update = useCallback((fn: (s: AlbumState) => AlbumState) => updateAlbums(account, fn), [account]);
  return [state, update] as const;
};

/** Drop NFTs the user hid (albums.ts) from a list or picker; the Hidden album in Wallet › NFTs still shows them. */
export const useWithoutHidden = <T extends { origin: string }>(items: T[]): T[] => {
  const [state] = useAlbums();
  return useMemo(() => {
    if (!state.hidden.length) return items;
    const hidden = new Set(state.hidden);
    return items.filter((i) => !hidden.has(nftKey(i.origin)));
  }, [items, state.hidden]);
};
