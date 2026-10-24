import { useCallback, useEffect, useRef, useState } from 'react';
import type { WalletOutput } from '@bsv/sdk';
import { listOrdinals, syncAddresses } from '@1sat/actions';
import { legacyOrdVisible, takeInLegacyOrd, takenInLegacy } from '../../services/legacyOrd';
import { activeKeptNfts } from '../airdrops/inbox';
import { onMinted } from '../mint/mint';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getOutputName, getTagValue } from '../../utils/format';
import { dedupeByOrigin, isMediaOutput, kindOf, type MediaKind } from './media';
import { playQueue } from './player';
import { safety } from '../market/safety';
import { cachedMeta, resolveMeta } from './resolveMeta';
import { countNew } from './nftActions';
import { txidOf, walletTxStates } from './unbroadcast';

/** One of the wallet's non-fungible inscriptions, streamed from ORDFS. */
export type MediaItem = {
  output: WalletOutput;
  name: string;
  type?: string;
  kind: MediaKind;
  /** Inscription origin (`<txid>_<n>` or `.n`); the outpoint when unknown. */
  origin: string;
  url: string;
  flagged: boolean;
  /** Its transaction is signed and queued but not on chain yet (unbroadcast.ts PENDING_ON_CHAIN): not owned yet. */
  pending?: boolean;
};

const PAGE = 50;

/** listOrdinals with two quick retries: a phone waking or switching networks often fails once. */
const listWithRetry = async (ctx: Parameters<typeof listOrdinals.execute>[0], limit: number, offset: number) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await listOrdinals.execute(ctx, { limit, offset });
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
};

/** What the user sees when loading fails (the raw error goes to the console). */
export const mediaErrorText = (e: unknown) => {
  console.warn('[media] listOrdinals failed:', e);
  return "Couldn't load your NFTs. Check your connection and pull down to try again.";
};

/**
 * The wallet's media inscriptions, paged from listOrdinals. Shared by Wallet › NFTs (MediaSection)
 * and the Media page (MediaPage). A new mint restarts the list from the top.
 */
export const useWalletMedia = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // NFTs from mints/sends the network never saw are hidden (unbroadcast.ts); how many, for a one-line note.
  const [hiddenUnbroadcast, setHiddenUnbroadcast] = useState(0);
  const offChain = useRef<Set<string>>(new Set());
  const pendingTx = useRef<Set<string>>(new Set());
  const toItem = useCallback(
    (o: WalletOutput): MediaItem => {
      // NFTs from other sites/markets can lack these tags: fall back to the indexer (resolveMeta.ts).
      const meta = cachedMeta(o.outpoint);
      const type = getTagValue(o.tags, 'type') || meta?.type;
      const origin = getTagValue(o.tags, 'origin') || meta?.origin || o.outpoint;
      const tagged = getOutputName(o, '');
      return {
        output: o,
        name: tagged || meta?.name || 'Inscription',
        type,
        kind: kindOf(type),
        origin,
        // Your own items are never hidden; ones the Market filter would block are blurred (tap to reveal).
        flagged: safety().check({ ids: [o.outpoint, origin], texts: [getOutputName(o, '')] }).blocked,
        url: `${apiContext.services!.ordfs.getContentUrl(origin)}?outpoint=${o.outpoint}`,
        pending: pendingTx.current.has(txidOf(o.outpoint)),
      };
    },
    [apiContext],
  );

  const loadOffChain = useCallback(async () => {
    try {
      const states = await walletTxStates(apiContext.wallet);
      offChain.current = states.offChain;
      pendingTx.current = states.pending;
    } catch (e) {
      console.warn('[media] listActions for unbroadcast check failed:', e);
    }
  }, [apiContext]);
  /** Media outputs that are really on chain, counting the ones left out. */
  const visible = useCallback(
    (outputs: WalletOutput[], reset: boolean) => {
      const media = outputs.filter(isMediaOutput);
      // NFTs from the legacy ord address stay in bMail › Quarantine until kept (services/legacyOrd.ts).
      const legacy = takenInLegacy();
      const kept = legacy.size ? activeKeptNfts() : [];
      const keep = media.filter(
        (o) => !offChain.current.has(txidOf(o.outpoint)) && legacyOrdVisible(o.outpoint, legacy, kept),
      );
      setHiddenUnbroadcast((n) => (reset ? 0 : n) + media.length - keep.length);
      return dedupeByOrigin(keep.map(toItem));
    },
    [toItem],
  );

  // Repair: look up NFTs missing their type or origin, then redraw them with their real image.
  useEffect(() => {
    const missing = items
      .filter((i) => !getTagValue(i.output.tags, 'type') || !getTagValue(i.output.tags, 'origin'))
      .filter((i) => !cachedMeta(i.output.outpoint))
      .map((i) => i.output.outpoint);
    if (!missing.length) return;
    let live = true;
    void resolveMeta(missing).then((n) => {
      if (live && n) setItems((prev) => dedupeByOrigin(prev.map((i) => toItem(i.output))));
    });
    return () => {
      live = false;
    };
  }, [items, toItem]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      if (offset === 0) await loadOffChain();
      const { outputs } = await listWithRetry(apiContext, PAGE, offset);
      setError('');
      const next = visible(outputs, offset === 0);
      setItems((prev) => dedupeByOrigin([...prev, ...next]));
      setOffset((n) => n + outputs.length);
      setHasMore(outputs.length === PAGE);
    } catch (e) {
      setError(mediaErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [apiContext, offset, hasMore, loading, loadOffChain, visible]);

  useEffect(() => {
    void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => onMinted(() => setReloadKey((k) => k + 1)), []);
  useEffect(() => {
    if (!reloadKey) return;
    setLoading(true);
    loadOffChain()
      .then(() => listWithRetry(apiContext, PAGE, 0))
      .then(({ outputs }) => {
        setError('');
        setItems(visible(outputs, true));
        setOffset(outputs.length);
        setHasMore(outputs.length === PAGE);
      })
      .catch((e) => setError(mediaErrorText(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  /** Re-reads the first page (pull to refresh). */
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  /**
   * Refresh button: the wallet's real address sync (as BsvWallet refreshUtxos), then the list from
   * the top; the repair effect above re-runs for anything still missing metadata. Resolves to how
   * many NFTs are new and whether the sync itself worked.
   */
  const refresh = useCallback(async (): Promise<{ added: number; synced: boolean }> => {
    let synced = true;
    try {
      const { account } = chromeStorageService.getCurrentAccountObject();
      const count = (account?.settings?.maxKeyIndex ?? 4) + 1;
      await syncAddresses.execute(apiContext, { count });
    } catch (e) {
      synced = false;
      console.warn('[media] syncAddresses failed:', e);
    }
    // NFTs sent to the legacy ord address (paymail ordinals): services/legacyOrd.ts.
    await takeInLegacyOrd(apiContext).catch((e) => console.warn('[media] legacy ord sync failed:', e));
    const before = itemsRef.current.map((i) => i.output.outpoint);
    setLoading(true);
    try {
      await loadOffChain();
      const { outputs } = await listWithRetry(apiContext, PAGE, 0);
      const next = visible(outputs, true);
      setError('');
      setItems(next);
      setOffset(outputs.length);
      setHasMore(outputs.length === PAGE);
      return {
        added: countNew(
          before,
          next.map((i) => i.output.outpoint),
        ),
        synced,
      };
    } catch (e) {
      setError(mediaErrorText(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, [apiContext, chromeStorageService, loadOffChain, visible]);

  return { items, hasMore, loading, error, loadMore, reload, refresh, hiddenUnbroadcast };
};

/** Queues every music item in `list` and starts at `item`. */
export const playMusic = (list: MediaItem[], item: MediaItem) => {
  const music = list.filter((i) => i.kind === 'music');
  playQueue(
    music.map((i) => ({ id: i.output.outpoint, title: i.name, url: i.url })),
    Math.max(0, music.indexOf(item)),
  );
};
