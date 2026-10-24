import { useWithoutHidden } from '../albums/useAlbums';
import { TipButton } from '../tip/TipButton';
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Image as ImageIcon,
  MessageCircle,
  Mic,
  QrCode,
  Search,
  Send,
  Star,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { isNative } from '../native';
import { useContacts } from '../chat/useContacts';
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { dmRooms, payTarget, type Contact } from '../chat/contacts';
import { previewText, roomActivity, roomTitle } from '../chat/messages';
import { requestDm } from '../chat/segmentNav';
import { addFriend, removeFriend } from '../calls/friends';
import { asFavourite, loadFavourites, saveFavourites, toggleFavourite, type Favourite } from '../calls/phone';
import { loadRecents } from '../wallet/send/sendLogic';
import { requestPay } from '../wallet/payNav';
import { setWalletKind } from '../wallet/walletKind';
import { historyCacheKey, readHistoryCache, writeHistoryCache } from '../wallet/historyCache';
import { loadHistoryRows } from '../wallet/historyLoad';
import { parseRecipient, resolveRecipient, VIA_LABEL, type Resolved } from '../names/names';
import { BWALLET_PAYMAIL_DOMAIN } from '../names/config';
import { useAccountNames } from '../names/accountNames';
import { bavatarDataUri } from '../names/avatar';
import { bavatarSvg } from '../bavatar/bavatar';
import { getPersonalLink } from '../names/personalToken';
import { APP_NAME, BSPACES_ENABLED, MARKET_ENABLED } from '../storeBuild';
import { Scanner } from '../scan/Scanner';
import { NftDetail } from '../media/NftDetail';
import { useWalletMedia, type MediaItem } from '../media/useWalletMedia';
import {
  activityLine,
  ago,
  buildFriends,
  cleanBsv,
  findBySlug,
  friendSlug,
  isEmailHandle,
  loadLocal,
  lookalikeWarnings,
  maskEmail,
  parseAddInput,
  paymentsWith,
  recentFor,
  dmFor,
  requestText,
  safeText,
  saveLocal,
  searchFriends,
  sortFriends,
  spaceInviteText,
  suggestions as suggest,
  withLocal,
  type DmInfo,
  type Friend,
  type LocalFriendData,
  type PaymentRow,
  type SortBy,
  type Suggestion,
  type Warning,
} from './model';
import './friends.css';

// A friend's personal token + "Buy & chat": Exchange builds only (the chunk is dropped from store builds).
const FriendToken = MARKET_ENABLED ? lazy(() => import('../exchange/FriendToken')) : null;

const f = (u: string, i?: RequestInit) => fetch(u, i);
const shortKey = (k: string) => `${k.slice(0, 6)}…${k.slice(-6)}`;
const svgUri = (seed: string) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(seed || 'b', { size: 128 }));
const bsv = (sats: number) => `${(Math.abs(sats) / 1e8).toFixed(8).replace(/\.?0+$/, '')} BSV`;

/** Their photo if they published one, else their gold bAvatar (drawn from the identity key; never grey). */
const FriendPic = ({ c, size }: { c: Pick<Contact, 'avatar' | 'identityKey' | 'handle' | 'name'>; size: number }) => {
  const gold = (c.identityKey && bavatarDataUri(c.identityKey)) || svgUri(c.handle || c.name);
  const [src, setSrc] = useState(c.avatar && /^https:\/\//.test(c.avatar) ? c.avatar : gold);
  return (
    <img
      className="fr-pic"
      src={src}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      onError={() => setSrc(gold)}
      style={{ width: size, height: size }}
    />
  );
};

/** Everything this device already knows about the people around this account (no new tracking). */
const useFriendData = () => {
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const acct = account?.addresses?.identityAddress ?? '';
  const contacts = useContacts();
  const names = useAccountNames(acct, '', '', false);
  const recents = useMemo(() => loadRecents(acct), [acct]);
  const [local, setLocalState] = useState<LocalFriendData>(() => loadLocal(acct));
  const [favs, setFavs] = useState<Favourite[]>(() => loadFavourites(acct || 'default'));
  const [dms, setDms] = useState<DmInfo[]>([]);
  const addresses = useMemo(() => {
    const a = account?.addresses;
    return [...new Set([a?.bsvAddress, a?.ordAddress, a?.identityAddress].filter((x): x is string => !!x))];
  }, [account?.addresses]);
  const histKey = historyCacheKey(addresses);
  const [history, setHistory] = useState(() => readHistoryCache(histKey));

  useEffect(() => {
    setLocalState(loadLocal(acct));
    setFavs(loadFavourites(acct || 'default'));
  }, [acct]);

  const session = loadSession();
  useEffect(() => {
    if (!session) return;
    let live = true;
    void new BchatClient(defaultHttp(isNative), session)
      .rooms()
      .then((rooms) => {
        if (!live) return;
        setDms(
          dmRooms(rooms).map((r) => ({
            handle: roomTitle(r, session.handle).replace(/^\$/, ''),
            at: roomActivity(r),
            preview: previewText(r, session.handle),
            unread: r.unread ?? 0,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.handle]);

  const setLocal = (d: LocalFriendData) => {
    setLocalState(d);
    saveLocal(acct, d);
  };
  const toggleFav = (c: Contact) => {
    const next = toggleFavourite(favs, asFavourite(c));
    setFavs(next);
    saveFavourites(acct || 'default', next);
  };
  const payments: PaymentRow[] = useMemo(
    () =>
      (history?.rows ?? []).map((r) => ({
        txid: r.txid,
        time: r.time,
        amountSats: r.amountSats,
        counterparty: r.counterparty,
      })),
    [history],
  );
  const domain = BWALLET_PAYMAIL_DOMAIN;
  const friends = useMemo(
    () =>
      buildFriends(contacts, {
        recents,
        dms,
        payments,
        domain,
        local,
        favourites: new Set(favs.map((x) => x.id)),
      }),
    [contacts, recents, dms, payments, domain, local, favs],
  );
  return {
    acct,
    account,
    names,
    contacts,
    friends,
    recents,
    dms,
    payments,
    history,
    addresses,
    histKey,
    setHistory,
    local,
    setLocal,
    toggleFav,
    domain,
  };
};
type Data = ReturnType<typeof useFriendData>;

/* ── Add friend ─────────────────────────────────────────────────────────────────────── */

type Candidate = { key: string; label: string; resolved: Resolved | null; warnings: Warning[] };

const AddFriend = ({
  data,
  onAdded,
  initial = '',
}: {
  data: Data;
  onAdded: (slug: string) => void;
  initial?: string;
}) => {
  const [text, setText] = useState(initial);
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [cand, setCand] = useState<Candidate | null>(null);

  const lookup = useCallback(
    async (raw: string) => {
      setErr('');
      setCand(null);
      const p = parseAddInput(raw);
      if (p.kind === 'invalid') return setErr(p.reason);
      if (p.kind === 'key') {
        return setCand({
          key: p.key,
          label: shortKey(p.key),
          resolved: null,
          warnings: lookalikeWarnings({ handle: null, key: p.key }, data.contacts),
        });
      }
      setBusy(true);
      try {
        const r = await resolveRecipient(f, parseRecipient(p.query));
        const key = (r.pubkey || '').toLowerCase();
        if (!/^0[23][0-9a-f]{64}$/.test(key))
          throw new Error(`${maskEmail(r.input)} has no identity key, so it can't be saved as a friend.`);
        const handle = r.input.startsWith('$')
          ? r.input.slice(1).toLowerCase()
          : r.input.endsWith(`@${data.domain}`)
            ? r.input.split('@')[0]
            : null;
        setCand({
          key,
          label: r.input,
          resolved: r,
          warnings: lookalikeWarnings({ handle, key }, data.contacts, r.didYouMean),
        });
      } catch (e) {
        setErr(maskEmail(e instanceof Error ? e.message : 'Could not find that name'));
      } finally {
        setBusy(false);
      }
    },
    [data.contacts, data.domain],
  );

  useEffect(() => {
    if (initial) void lookup(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const save = async () => {
    if (!cand) return;
    setBusy(true);
    setErr('');
    try {
      await addFriend({ key: cand.key, name: cand.label, avatar: cand.resolved?.avatar ?? null });
      const handle = cand.label.startsWith('$') ? cand.label.slice(1).toLowerCase() : null;
      setText('');
      setCand(null);
      onAdded(friendSlug({ handle, identityKey: cand.key, address: null, id: `k:${cand.key}` }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const stop = cand?.warnings.some((w) => w.level === 'stop');
  const r = cand?.resolved;
  return (
    <div className="fr-add">
      <form
        className="fr-add-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && text.trim()) void lookup(text);
        }}
      >
        <UserPlus size={16} className="fr-muted shrink-0" />
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCand(null);
            setErr('');
          }}
          placeholder={`Add a friend: $name (${APP_NAME}), paymail, @handle or identity key`}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Add a friend"
        />
        <button type="button" className="fr-iconbtn" title="Scan their QR code" onClick={() => setScan((s) => !s)}>
          <QrCode size={16} />
        </button>
        <button type="submit" className="fr-btn is-gold" disabled={busy || !text.trim()}>
          {busy && !cand ? 'Finding…' : 'Find'}
        </button>
      </form>
      {scan && (
        <div className="fr-scan">
          <Scanner
            onCode={(code) => {
              setScan(false);
              setText(code);
              void lookup(code);
            }}
          />
        </div>
      )}
      {err && <div className="fr-err">{err}</div>}
      {cand && (
        <div className="fr-cand">
          <FriendPic
            c={{ avatar: r?.avatar ?? null, identityKey: cand.key, handle: null, name: cand.label }}
            size={64}
          />
          <div className="min-w-0 flex-1">
            <div className="fr-cand-name">{safeText(r?.displayName) || maskEmail(cand.label)}</div>
            <div className="fr-muted fr-small">
              {maskEmail(cand.label)}
              {r ? ` · ${VIA_LABEL[r.via]}` : ' · identity key only'}
            </div>
            <div
              className="fr-key"
              title="Their identity key. Their bAvatar is drawn from it: a lookalike name draws a different picture."
            >
              Key {shortKey(cand.key)}
            </div>
            {cand.warnings.map((w) => (
              <div key={w.text} className={w.level === 'stop' ? 'fr-err' : 'fr-warn'}>
                {w.text}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <button className="fr-btn is-gold" disabled={busy || stop} onClick={() => void save()}>
              <Check size={14} /> Save friend
            </button>
            <button className="fr-btn" onClick={() => setCand(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/* ── List ───────────────────────────────────────────────────────────────────────────── */

const EmptyArt = () => (
  <div className="fr-empty-art" aria-hidden>
    {['friend-a', 'friend-b', 'friend-c'].map((s) => (
      <img key={s} src={svgUri(s)} alt="" />
    ))}
  </div>
);

const Suggestions = ({
  list,
  onAdd,
  onDismiss,
}: {
  list: Suggestion[];
  onAdd: (s: Suggestion) => void;
  onDismiss: (s: Suggestion) => void;
}) =>
  !list.length ? null : (
    <section className="fr-section">
      <h2 className="fr-h2">People you pay or chat with</h2>
      <div className="fr-sugg">
        {list.map((s) => (
          <div key={s.id} className="fr-sugg-card">
            <FriendPic c={{ avatar: s.avatar ?? null, identityKey: null, handle: s.id, name: s.label }} size={40} />
            <div className="min-w-0 flex-1">
              <div className="fr-clip fr-name">{maskEmail(s.label)}</div>
              <div className="fr-muted fr-small fr-clip">{s.why}</div>
            </div>
            <button className="fr-btn is-gold" onClick={() => onAdd(s)}>
              Add
            </button>
            <button className="fr-iconbtn" title="Not now" aria-label="Dismiss" onClick={() => onDismiss(s)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );

const FriendCard = ({ fr, onOpen, onStar }: { fr: Friend; onOpen: () => void; onStar: () => void }) => (
  <div className="fr-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
    <button
      className={`fr-star${fr.favourite ? ' on' : ''}`}
      aria-label={fr.favourite ? 'Unfavourite' : 'Favourite'}
      onClick={(e) => {
        e.stopPropagation();
        onStar();
      }}
    >
      <Star size={14} fill={fr.favourite ? 'currentColor' : 'none'} />
    </button>
    <FriendPic c={fr.contact} size={72} />
    <div className="fr-name fr-clip">{fr.title}</div>
    <div className="fr-handles fr-clip">
      {fr.dollar && <span>{fr.dollar}</span>}
      {fr.social && <span className="fr-x">{fr.social}</span>}
      {!fr.dollar && !fr.social && <span>{safeText(fr.contact.paymail) || 'Identity key'}</span>}
    </div>
    <div className="fr-muted fr-small fr-clip">{activityLine(fr.activity) || 'No activity yet'}</div>
  </div>
);

/* ── Detail ─────────────────────────────────────────────────────────────────────────── */

const Action = ({
  icon,
  label,
  onClick,
  disabled,
  why,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  why?: string;
}) => (
  <button className="fr-action" onClick={onClick} disabled={disabled} title={disabled ? why : label}>
    {icon}
    <span>{label}</span>
  </button>
);

const NftPicker = ({ to, onClose }: { to: string; onClose: () => void }) => {
  const { items: shownRaw, loading, error, hasMore, loadMore } = useWalletMedia();
  const items = useWithoutHidden(shownRaw);
  const [pick, setPick] = useState<MediaItem | null>(null);
  if (pick) return <NftDetail item={pick} all={items} initialTo={to} onClose={() => setPick(null)} onSent={onClose} />;
  return (
    <div className="fr-sheet" role="dialog" aria-label="Choose an NFT">
      <div className="fr-sheet-head">
        <div className="fr-h2 m-0">Choose an NFT to send to {maskEmail(to)}</div>
        <button className="fr-iconbtn" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {error && <div className="fr-err">{error}</div>}
      {!loading && !items.length && !error && <div className="fr-muted p-6 text-center">You have no NFTs to send.</div>}
      <div className="fr-nfts">
        {items.map((it) => (
          <button key={it.output.outpoint} className="fr-nft" onClick={() => setPick(it)} title={it.name}>
            {it.kind === 'images' || it.kind === 'other' ? (
              <img src={it.url} alt="" loading="lazy" />
            ) : (
              <span className="fr-nft-kind">{it.kind}</span>
            )}
            <span className="fr-clip fr-small">{it.name}</span>
          </button>
        ))}
      </div>
      {hasMore && (
        <button className="fr-btn mx-auto my-3" disabled={loading} onClick={() => loadMore()}>
          {loading ? 'Loading…' : 'More'}
        </button>
      )}
    </div>
  );
};

const FriendDetail = ({ fr, data }: { fr: Friend; data: Data }) => {
  const c = fr.contact;
  const navigate = useNavigate();
  const { handleSelect } = useBottomMenu();
  const { apiContext } = useServiceContext();
  const [panel, setPanel] = useState<'none' | 'request' | 'invite' | 'nft'>('none');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [nick, setNick] = useState(data.local.nicknames[c.id] ?? '');
  const [notes, setNotes] = useState(data.local.notes[c.id] ?? '');
  const [loadingHist, setLoadingHist] = useState(false);
  const [histErr, setHistErr] = useState('');
  const [removing, setRemoving] = useState(false);

  const dm = dmFor(c, data.dms);
  const lastPaid = recentFor(c, data.recents, data.domain);
  const payments = paymentsWith(c, data.payments, data.domain);
  const handle = c.handle;
  // Send: a paymail or address we were given; a $handle friend (saved with its key) goes through the Send card's
  // name resolution, which shows who it is before the approval.
  const sendTo = payTarget(c) ?? (c.handle && c.identityKey ? `$${c.handle}` : null);
  const nftTo = c.handle && c.identityKey ? `$${c.handle}` : c.paymail;
  const myPaymail = data.names.paymail;
  const me = getPersonalLink(data.acct);

  const goChat = () => {
    handleSelect(asMenuItem('chat'));
    navigate('/m/chat');
  };
  const message = (draft?: string) => {
    if (!handle) return;
    requestDm(handle, draft);
    goChat();
  };
  const send = () => {
    if (!sendTo) return;
    requestPay(sendTo);
    setWalletKind('tokens');
    handleSelect(asMenuItem('bsv'));
    navigate('/bsv-wallet');
  };
  const loadHistory = async () => {
    if (!apiContext) return;
    setLoadingHist(true);
    setHistErr('');
    try {
      const rows = await loadHistoryRows({
        addresses: data.addresses,
        identityAddress: data.acct,
        apiContext,
        onProgress: () => undefined,
      });
      const v = { rows, at: Date.now() };
      writeHistoryCache(data.histKey, v);
      data.setHistory(v);
    } catch (e) {
      setHistErr(e instanceof Error ? e.message : 'Could not load history');
    } finally {
      setLoadingHist(false);
    }
  };
  const amountOk = cleanBsv(amount);

  return (
    <div className="fr-detail">
      <div className="fr-hero">
        <FriendPic c={c} size={112} />
        <div className="min-w-0 flex-1">
          <div className="fr-hero-name fr-clip">{fr.title}</div>
          <div className="fr-handles">
            {fr.dollar && <span>{fr.dollar}</span>}
            {fr.social && <span className="fr-x">{fr.social} on X</span>}
            {c.paymail && !c.paymail.startsWith(`${c.handle}@`) && <span>{safeText(c.paymail)}</span>}
          </div>
          {fr.title !== safeText(c.name) && <div className="fr-muted fr-small">{safeText(c.name)}</div>}
          {c.identityKey && (
            <div className="fr-key" title="Identity key: the gold bAvatar is drawn from it.">
              Key {shortKey(c.identityKey)}
            </div>
          )}
          <div className="fr-muted fr-small">
            {c.sources
              .map(
                (s) =>
                  ({ bchat: 'bChat', friend: 'Friend', follow: 'Following', twetch: 'Twetch', handcash: 'HandCash' })[
                    s
                  ],
              )
              .join(' · ')}
          </div>
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <button className={`fr-btn${fr.favourite ? ' is-gold' : ''}`} onClick={() => data.toggleFav(c)}>
            <Star size={14} fill={fr.favourite ? 'currentColor' : 'none'} />{' '}
            {fr.favourite ? 'Favourite' : 'Add to favourites'}
          </button>
          <TipButton
            to={{
              name: fr.dollar || fr.title,
              identityKey: c.identityKey ?? undefined,
              paymail: sendTo && !/^1/.test(sendTo) ? sendTo : undefined,
              address: c.address ?? undefined,
            }}
            context={{ kind: 'person' }}
            className="self-start"
          />
          {c.handle && !isEmailHandle(c.handle) && (
            <a className="fr-btn" href={`https://bwalletx.com/$${c.handle}`} target="_blank" rel="noreferrer">
              View profile
            </a>
          )}
        </div>
      </div>

      {FriendToken && c.handle && (
        <Suspense fallback={null}>
          <FriendToken handle={c.handle} />
        </Suspense>
      )}

      <div className="fr-actions">
        <Action
          icon={<Send size={18} />}
          label="Send"
          onClick={send}
          disabled={!sendTo}
          why="No paymail or address for them yet"
        />
        <Action
          icon={<ArrowDownLeft size={18} />}
          label="Request"
          onClick={() => setPanel(panel === 'request' ? 'none' : 'request')}
          disabled={!handle || !myPaymail}
          why={!handle ? 'Requests go by bChat message: they have no bChat name' : 'Your paymail is not set up yet'}
        />
        <Action
          icon={<MessageCircle size={18} />}
          label="Message"
          onClick={() => message()}
          disabled={!handle}
          why="They have no bChat name to message"
        />
        {BSPACES_ENABLED && (
          <Action
            icon={<Mic size={18} />}
            label="Invite to Space"
            onClick={() => setPanel(panel === 'invite' ? 'none' : 'invite')}
            disabled={!handle}
            why="Invites go by bChat message: they have no bChat name"
          />
        )}
        <Action
          icon={<ImageIcon size={18} />}
          label="Send NFT"
          onClick={() => setPanel('nft')}
          disabled={!nftTo}
          why="NFTs go to a $handle or paymail"
        />
      </div>

      {panel === 'request' && (
        <form
          className="fr-panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (amountOk && myPaymail) message(requestText(myPaymail, amountOk, note));
          }}
        >
          <div className="fr-small fr-muted">
            Puts a payment request in your chat with {fr.title}. You press Send in the chat; they pay from any wallet.
          </div>
          <div className="flex gap-2 flex-wrap">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount in BSV"
              inputMode="decimal"
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What for (optional)"
              maxLength={120}
            />
            <button className="fr-btn is-gold" type="submit" disabled={!amountOk}>
              Open chat with request
            </button>
          </div>
        </form>
      )}
      {panel === 'invite' && BSPACES_ENABLED && (
        <div className="fr-panel">
          <div className="fr-small fr-muted">Puts a Space link in your chat with {fr.title}. You press Send.</div>
          <div className="flex gap-2 flex-wrap">
            <button className="fr-btn is-gold" onClick={() => message(spaceInviteText('LOUNGE', 'the Help Desk'))}>
              The Help Desk
            </button>
            {me?.ticker && (
              <button
                className="fr-btn is-gold"
                onClick={() =>
                  message(spaceInviteText(me.ticker.replace(/^\$/, ''), `my room $${me.ticker.replace(/^\$/, '')}`))
                }
              >
                My room ${me.ticker.replace(/^\$/, '')}
              </button>
            )}
          </div>
        </div>
      )}
      {panel === 'nft' && nftTo && <NftPicker to={nftTo} onClose={() => setPanel('none')} />}

      <div className="fr-cols">
        <section className="fr-section">
          <h2 className="fr-h2">Together</h2>
          <ul className="fr-hist">
            {dm && (
              <li>
                <MessageCircle size={14} className="fr-gold" />
                <button className="fr-link fr-clip" onClick={() => message()}>
                  {dm.preview || 'Chat'}
                </button>
                <span className="fr-muted fr-small">
                  {dm.unread ? `${dm.unread} new · ` : ''}
                  {ago(dm.at)}
                </span>
              </li>
            )}
            {lastPaid && (
              <li>
                <ArrowUpRight size={14} className="fr-gold" />
                <span className="fr-grow">You last paid them</span>
                <span className="fr-muted fr-small">{ago(lastPaid.at)}</span>
              </li>
            )}
            {payments.slice(0, 20).map((p) => (
              <li key={p.txid}>
                {p.amountSats >= 0 ? (
                  <ArrowDownLeft size={14} className="fr-green" />
                ) : (
                  <ArrowUpRight size={14} className="fr-gold" />
                )}
                <a
                  className="fr-link fr-grow"
                  href={`https://whatsonchain.com/tx/${p.txid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {p.amountSats >= 0 ? 'They paid you' : 'You paid them'} {bsv(p.amountSats)}
                </a>
                <span className="fr-muted fr-small">{ago(p.time)}</span>
              </li>
            ))}
            {!dm && !lastPaid && !payments.length && <li className="fr-muted">Nothing yet.</li>}
          </ul>
          {!data.history && (
            <button className="fr-btn" disabled={loadingHist} onClick={() => void loadHistory()}>
              {loadingHist ? 'Loading payments…' : 'Show payments with them'}
            </button>
          )}
          {histErr && <div className="fr-err">{histErr}</div>}
        </section>

        <section className="fr-section">
          <h2 className="fr-h2">Only on this device</h2>
          <label className="fr-small fr-muted" htmlFor="fr-nick">
            Nickname
          </label>
          <input
            id="fr-nick"
            value={nick}
            maxLength={40}
            onChange={(e) => setNick(e.target.value)}
            onBlur={() => data.setLocal(withLocal(data.local, 'nicknames', c.id, nick))}
            placeholder={safeText(c.name)}
          />
          <label className="fr-small fr-muted" htmlFor="fr-note">
            Notes
          </label>
          <textarea
            id="fr-note"
            value={notes}
            maxLength={500}
            rows={4}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => data.setLocal(withLocal(data.local, 'notes', c.id, notes))}
            placeholder="Private notes. Never synced or shared."
          />
          {c.sources.includes('friend') && c.identityKey && (
            <button
              className="fr-btn is-danger"
              disabled={removing}
              onClick={() => {
                setRemoving(true);
                void removeFriend(c.identityKey!)
                  .then(() => navigate('/m/friends'))
                  .catch(() => setRemoving(false));
              }}
            >
              <Trash2 size={14} /> Remove from friends
            </button>
          )}
        </section>
      </div>
    </div>
  );
};

/* ── Page ───────────────────────────────────────────────────────────────────────────── */

const SORTS: [SortBy, string][] = [
  ['recent', 'Recent'],
  ['name', 'Name'],
];

const FriendsPage = () => {
  const data = useFriendData();
  const navigate = useNavigate();
  const { slug } = useParams();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortBy>('recent');
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [adding, setAdding] = useState('');

  const open = (s: string) => navigate(`/m/friends/${encodeURIComponent(s)}`);
  const sugg = useMemo(
    () => suggest(data.contacts, data.recents, data.dms, data.local.dismissed, data.domain),
    [data.contacts, data.recents, data.dms, data.local.dismissed, data.domain],
  );

  if (slug) {
    const fr = findBySlug(data.friends, slug);
    return (
      <div className="fr-page">
        {fr ? (
          <FriendDetail key={fr.contact.id} fr={fr} data={data} />
        ) : (
          <div className="fr-empty">
            <EmptyArt />
            <div className="fr-h2">Not in your friends</div>
            <AddFriend data={data} onAdded={open} initial={decodeURIComponent(slug)} />
          </div>
        )}
      </div>
    );
  }

  const shown = sortFriends(searchFriends(data.friends, query), sort).filter((x) => !onlyFavs || x.favourite);
  return (
    <div className="fr-page">
      <AddFriend key={adding} data={data} onAdded={open} initial={adding} />
      {data.friends.length === 0 ? (
        <div className="fr-empty">
          <EmptyArt />
          <div className="fr-h2">Your friends live here</div>
          <div className="fr-muted fr-small">
            Add someone by their $handle, paymail, @handle or QR code. People you add can be paid, messaged and sent
            NFTs in one tap.
          </div>
        </div>
      ) : (
        <>
          <div className="fr-tools">
            <div className="fr-search">
              <Search size={15} className="fr-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search friends"
                aria-label="Search friends"
              />
            </div>
            <div className="fr-seg" role="group" aria-label="Show">
              <button className={!onlyFavs ? 'on' : ''} onClick={() => setOnlyFavs(false)}>
                All {data.friends.length}
              </button>
              <button className={onlyFavs ? 'on' : ''} onClick={() => setOnlyFavs(true)}>
                Favourites
              </button>
            </div>
            <div className="fr-seg" role="group" aria-label="Sort">
              {SORTS.map(([id, label]) => (
                <button key={id} className={sort === id ? 'on' : ''} onClick={() => setSort(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <div className="fr-muted p-8 text-center">
              {onlyFavs ? 'Star a friend to keep them here.' : 'No one matches.'}
            </div>
          ) : (
            <div className="fr-grid">
              {shown.map((fr) => (
                <FriendCard
                  key={fr.contact.id}
                  fr={fr}
                  onOpen={() => open(friendSlug(fr.contact))}
                  onStar={() => data.toggleFav(fr.contact)}
                />
              ))}
            </div>
          )}
        </>
      )}
      <Suggestions
        list={sugg}
        onAdd={(s) => setAdding(s.input)}
        onDismiss={(s) => data.setLocal({ ...data.local, dismissed: [...data.local.dismissed, s.input] })}
      />
    </div>
  );
};

export default FriendsPage;
