import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { WalletInterface } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { walletReady } from '../../utils/walletReady';
import { isFriend as isCallFriend } from '../calls/friends';
import { loadMyProfile, saveMyProfile } from '../calls/bphone';
import { usdToSats, useBsvUsd } from '../money/money';
import { acknowledge, fetchMail, myKey, openMail, sendMail, type SendArgs } from './client';
import { split } from './route';
import { cachedExchangeRate } from '../../utils/wallet';
import {
  addReceived,
  isArchived,
  isInBin,
  isLive,
  isQuarantined,
  isTrustedSender,
  purgeBin,
  restoreFromBin,
  trustSender,
  pinnedFirst,
  restoreFlags,
  setFlags,
  type MailFlags,
  loadMail,
  loadPending,
  saveMail,
  subscribeMail,
  updateMail,
  type MailState,
  type Received,
} from './store';
import { friendlyMailError } from './friendlyError';

let version = 0;
subscribeMail(() => {
  version++;
});

const f = (u: string, i?: RequestInit) => fetch(u, i);

/** The active identity's bMail: boxes, actions, price to reach me. */
export const useBMail = () => {
  const { apiContext } = useServiceContext();
  const wallet = apiContext.wallet as unknown as WalletInterface;
  const [me, setMe] = useState('');
  useEffect(() => {
    let live = true;
    myKey(wallet)
      .then((k) => live && setMe(k))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet]);
  const v = useSyncExternalStore(subscribeMail, () => version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo<MailState>(() => loadMail(me), [me, v]);
  const rate = useBsvUsd();
  const priceSats = usdToSats(state.priceUsd, rate) ?? 0;
  const [newest, setNewest] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Only bPhone friends pin a sender (owner, 9 Oct): writing to someone does not by itself make them a friend.
  const isFriend = useCallback((k: string) => isCallFriend(k), []);
  const boxes = useMemo(() => {
    const blocked = state.blocked ?? [];
    const b = split(
      state.received.filter((r) => isLive(r, blocked)),
      { isFriend, priceSats, newest },
    );
    return {
      inbox: pinnedFirst(b.inbox),
      requests: pinnedFirst(b.requests),
      archive: state.received.filter((r) => isArchived(r, blocked)).sort((a, z) => z.at - a.at),
      quarantine: state.received.filter((r) => isQuarantined(r, blocked)).sort((a, z) => z.at - a.at),
      bin: state.received.filter(isInBin).sort((a, z) => (z.deletedAt ?? 0) - (a.deletedAt ?? 0)),
    };
  }, [state.received, state.blocked, isFriend, priceSats, newest]);

  /** Swipe actions: set flags, returning an undo function. */
  const flag = useCallback(
    (ids: string[], patch: MailFlags) => {
      let prev: Record<string, MailFlags> = {};
      updateMail(me, (s) => {
        const r = setFlags(s, ids, patch);
        prev = r.prev;
        return r.next;
      });
      return () => updateMail(me, (s) => restoreFlags(s, prev));
    },
    [me],
  );
  const block = useCallback(
    (sender: string) => {
      updateMail(me, (s) => ({ ...s, blocked: [...new Set([...(s.blocked ?? []), sender])] }));
      return () => updateMail(me, (s) => ({ ...s, blocked: (s.blocked ?? []).filter((k) => k !== sender) }));
    },
    [me],
  );

  /** Spam: flag it and send the sender's future mail straight to Quarantine (Undo puts both back). */
  const spam = useCallback(
    (r: Received) => {
      const wasBlocked = (loadMail(me).blocked ?? []).includes(r.from);
      const undoFlag = flag([r.id], { spam: true });
      if (!wasBlocked) updateMail(me, (s) => ({ ...s, blocked: [...new Set([...(s.blocked ?? []), r.from])] }));
      return () => {
        undoFlag();
        if (!wasBlocked) updateMail(me, (s) => ({ ...s, blocked: (s.blocked ?? []).filter((k) => k !== r.from) }));
      };
    },
    [me, flag],
  );
  const restore = useCallback((ids: string[]) => updateMail(me, (s) => restoreFromBin(s, ids)), [me]);
  const trust = useCallback((from: string) => updateMail(me, (s) => trustSender(s, from)), [me]);
  const isTrusted = useCallback((from: string) => isTrustedSender(state, from, isFriend), [state, isFriend]);
  // Bin: erase the content of mail deleted more than 30 days ago (local only; money untouched).
  useEffect(() => {
    if (!me) return;
    const s = loadMail(me);
    const next = purgeBin(s);
    if (next !== s) saveMail(me, next);
  }, [me]);

  const refresh = useCallback(async () => {
    if (!me) return;
    setLoading(true);
    setError('');
    try {
      const s = loadMail(me);
      const { items, ack } = await fetchMail(wallet, {
        me,
        sent: s.sent,
        known: new Set(s.received.map((r) => r.id)),
        // Credits already spent by a stored letter: one reply per reply-paid credit.
        creditsUsed: new Set(
          s.received.filter((r) => r.replyCredit && r.env.inReplyTo).map((r) => r.env.inReplyTo as string),
        ),
      });
      updateMail(me, (x) => addReceived(x, items));
      await acknowledge(wallet, ack).catch(() => undefined);
    } catch (e) {
      setError(friendlyMailError(e, { whole: true }));
    } finally {
      setLoading(false);
    }
  }, [me, wallet]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pull my published price once (so it follows me across devices).
  useEffect(() => {
    if (!me) return;
    loadMyProfile(f, me)
      .then((p) => {
        if (p.mail && p.mail.usd !== loadMail(me).priceUsd) updateMail(me, (x) => ({ ...x, priceUsd: p.mail!.usd }));
      })
      .catch(() => undefined);
  }, [me]);

  const open = useCallback(
    async (r: Received) => {
      const sealed = r.opened ?? (await openMail(wallet, r.env));
      updateMail(me, (s) => ({
        ...s,
        received: s.received.map((x) => (x.id === r.id ? { ...x, opened: sealed, read: true } : x)),
      }));
      return sealed;
    },
    [me, wallet],
  );

  const send = useCallback(
    async (a: SendArgs) => {
      const sent = await sendMail(wallet, a);
      updateMail(me, (s) => ({
        ...s,
        sent: [sent, ...s.sent],
        contacts: s.contacts.includes(a.to) ? s.contacts : [...s.contacts, a.to],
        usedCredits: a.usesReplyCredit && a.inReplyTo ? [...s.usedCredits, a.inReplyTo] : s.usedCredits,
      }));
      return sent;
    },
    [me, wallet],
  );

  const setPrice = useCallback(
    async (usd: number) => {
      saveMail(me, { ...loadMail(me), priceUsd: usd });
      const p = await loadMyProfile(f, me);
      await saveMyProfile(f, wallet, { ...p, mail: { usd } });
    },
    [me, wallet],
  );

  const unread = boxes.inbox.filter((r) => !r.read).length;
  return {
    me,
    state,
    boxes,
    priceSats,
    rate,
    newest,
    setNewest,
    loading,
    error,
    refresh,
    open,
    send,
    setPrice,
    unread,
    flag,
    block,
    spam,
    restore,
    trust,
    isTrusted,
  };
};

/**
 * Top-bar badge: unread Inbox mail already fetched plus Inbox-routed mail the notifier saw on the relay (pending).
 * Reads local state only: never fetches or acknowledges, so it cannot steal mail from the notifier or the screen.
 */
export const useBMailUnread = (): number => {
  const { apiContext, isLocked, chromeStorageService } = useServiceContext();
  const wallet = apiContext?.wallet as unknown as WalletInterface | undefined;
  // App-wide (top bar): before a wallet exists or while locked there is no key to ask for (src/utils/walletReady.ts).
  const ready = walletReady(chromeStorageService, isLocked);
  const [me, setMe] = useState('');
  useEffect(() => {
    let live = true;
    if (wallet && ready)
      myKey(wallet)
        .then((k) => live && setMe(k))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet, ready]);
  const v = useSyncExternalStore(subscribeMail, () => version);
  return useMemo(() => {
    if (!me) return 0;
    const s = loadMail(me);
    const priceSats = usdToSats(s.priceUsd, cachedExchangeRate()) ?? 0;
    const isFriend = (k: string) => isCallFriend(k);
    const have = new Set(s.received.map((r) => r.id));
    const unread = split(
      s.received.filter((r) => isLive(r, s.blocked)),
      { isFriend, priceSats },
    ).inbox.filter((r) => !r.read).length;
    return unread + loadPending(me).filter((id) => !have.has(id)).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, v]);
};
