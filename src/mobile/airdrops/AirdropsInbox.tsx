/**
 * Wallet › Airdrops: tokens and NFTs that arrived unsolicited (inbox.ts). Keep / Hide per item. Nothing in
 * here renders inscription markup or opens issuer links (notes are React text, links never clickable): NFTs show a
 * resized image; tapping it opens a viewer that uses only <img>, <video>, <audio> or plain text (AirdropNft.tsx).
 * Keep on an NFT syncs the address so the wallet takes the NFT into its list, then says where it went.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Coins, EyeOff, Flag, ShieldAlert } from 'lucide-react';
import { listOrdinals, syncAddresses } from '@1sat/actions';
import { takeInLegacyOrd } from '../../services/legacyOrd';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { avatarFor } from '../chat/avatars';
import { requestChatRoom } from '../chat/nav';
import { requestDm } from '../chat/segmentNav';
import { tokenKey } from '../chat/tokenRooms';
import { safeName } from '../feed/language';
import { IssuerBadge } from '../issuer/IssuerBadge';
import { useIssuer } from '../issuer/useIssuer';
import { STORE_BUILD, tokenRoomsEnabled } from '../storeBuild';
import { ReportSheet } from '../ugc/UgcSheets';
import { SwipeRow } from '../swipe/SwipeRow';
import { showUndo } from '../swipe/undo';
import { hideItem, inWalletList, keep, markSeen, type AirdropItem } from './inbox';
import { fetchExchangeRate } from '../../utils/wallet';
import { NftThumb, NftViewer, useSenderName } from './AirdropNft';
import { trustIssuer } from './quarantine';
import { keptIssuers, noteSegments, noteView, replyDraft } from './note';
import { useAirdrops } from './useAirdrops';
import { ErrorActions } from '../errors/ErrorActions';

const CARD = '#17191E';
const MUTED = '#98A2B3';
const GOLD = 'var(--bw-accent-hi)';
const short = (s: string) => (s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);

/** The issuer: avatar + $handle (verified badge for tokens) or a short address. */
const useIssuerName = (item: AirdropItem) => {
  const info = useIssuer(item.asset.kind === 'token' ? item.asset.id : (item.holdersOf ?? null));
  // NFTs (and tokens without a verified issuer): the sender's $name from their key or address (sender.ts).
  const sender = useSenderName(item, item.asset.kind === 'nft');
  const verified = info?.status === 'verified' && info.handle ? info.handle.replace(/^\$/, '') : null;
  const handle = verified ?? (item.asset.kind === 'nft' ? sender.handle : null);
  return {
    handle,
    verified: info?.status === 'verified',
    label: handle ? `$${safeName(handle)}` : item.asset.kind === 'nft' ? sender.label : short(item.from || item.issuer),
  };
};

const Avatar = ({ handle }: { handle: string | null }) => {
  const url = handle ? avatarFor(handle) : null;
  const [bad, setBad] = useState(false);
  if (url && !bad)
    return <img src={url} alt="" onError={() => setBad(true)} className="w-9 h-9 rounded-full object-cover shrink-0" />;
  return (
    <div className="w-9 h-9 rounded-full bg-[#2b2f36] flex items-center justify-center shrink-0 text-sm font-bold text-white">
      {handle ? handle[0].toUpperCase() : '?'}
    </div>
  );
};

/** The note as plain text: React text nodes only, links shown but never clickable. */
const NoteBody = ({ text, issuerKept, label }: { text: string; issuerKept: boolean; label: string }) => {
  const v = noteView(text, { issuerKept, store: STORE_BUILD });
  const [open, setOpen] = useState(!v.collapsed);
  const [reveal, setReveal] = useState(false);
  if (v.language === 'hide-final')
    return (
      <p className="text-[11px] italic m-0" style={{ color: MUTED }}>
        Note hidden by the language filter.
      </p>
    );
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-left text-[11px] underline"
        style={{ color: MUTED }}
      >
        Note from {label}: show
      </button>
    );
  const blurred = v.language === 'blur' && !reveal;
  return (
    <div
      className="rounded-lg px-3 py-2 text-[13px] leading-snug text-white whitespace-pre-wrap break-words"
      style={{ background: '#22252c' }}
    >
      <span style={blurred ? { filter: 'blur(5px)', userSelect: 'none' } : undefined}>
        {noteSegments(text).map((seg, n) =>
          seg.link ? (
            <span key={n} style={{ color: '#9fb3c8' }} title="Links in notes are never opened by the wallet">
              {seg.text}
            </span>
          ) : (
            <span key={n}>{seg.text}</span>
          ),
        )}
      </span>
      {blurred && (
        <button
          type="button"
          onClick={() => setReveal(true)}
          className="block text-[11px] underline mt-1"
          style={{ color: MUTED }}
        >
          Strong language: show anyway
        </button>
      )}
    </div>
  );
};

const Row = ({
  item,
  issuerKept,
  onKeep,
  onHide,
  onTrust,
  onLeave,
  usdPerBsv = 0,
}: {
  item: AirdropItem;
  usdPerBsv?: number;
  issuerKept: boolean;
  onKeep: () => void;
  onHide: () => void;
  onTrust: () => void;
  onLeave: () => void;
}) => {
  const { handleSelect } = useBottomMenu();
  const who = useIssuerName(item);
  const [reporting, setReporting] = useState(false);
  const [viewing, setViewing] = useState(false);
  const symbol = item.asset.kind === 'token' ? item.asset.symbol : undefined;
  const reply = () => {
    if (!who.handle) return;
    requestDm(who.handle, replyDraft(symbol));
    handleSelect(asMenuItem('chat'));
    onLeave();
  };
  const roomKey = item.asset.kind === 'token' && tokenRoomsEnabled() ? tokenKey('bsv21', item.asset.id) : null;
  const room = roomKey
    ? () => {
        requestChatRoom(roomKey);
        handleSelect(asMenuItem('chat'));
        onLeave();
      }
    : null;
  const small = 'min-h-[44px] rounded-lg px-3.5 py-2 text-sm font-semibold bg-[#2b2f36] text-white';
  return (
    <div className="flex flex-col gap-2 rounded-xl px-3 py-3" style={{ background: CARD }}>
      <div className="flex items-center gap-2">
        <Avatar handle={who.handle} />
        <div className="min-w-0 flex-1 flex flex-col">
          <span className="text-sm font-semibold text-white overflow-hidden text-ellipsis whitespace-nowrap">
            {who.label}
          </span>
          {item.asset.kind === 'token' || item.holdersOf ? (
            <IssuerBadge tokenId={item.asset.kind === 'token' ? item.asset.id : item.holdersOf!} compact />
          ) : (
            <span className="text-[11px]" style={{ color: MUTED }}>
              {who.handle ? 'bWallet name, not verified by an issuer' : 'Unknown sender'}
            </span>
          )}
        </div>
        <span className="text-[10px] shrink-0" style={{ color: '#667085' }}>
          {new Date(item.time).toLocaleDateString()}
        </span>
      </div>
      {item.note && <NoteBody text={item.note} issuerKept={issuerKept} label={who.label} />}
      <div className="flex items-center gap-3">
        {item.asset.kind === 'nft' ? (
          <NftThumb item={item} onOpen={() => setViewing(true)} />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-[#2b2f36] flex items-center justify-center shrink-0">
            <Coins size={18} color={MUTED} />
          </div>
        )}
        {item.asset.kind === 'nft' ? (
          <button
            type="button"
            onClick={() => setViewing(true)}
            className="min-w-0 flex-1 text-left text-sm font-semibold text-white overflow-hidden text-ellipsis whitespace-nowrap"
          >
            NFT from {who.label} <span style={{ color: GOLD }}>· View</span>
          </button>
        ) : item.asset.kind === 'bsv' ? (
          <div className="min-w-0 flex-1 flex flex-col">
            <span className="text-sm font-semibold text-white">
              {usdPerBsv ? `$${((Number(item.asset.qty) / 1e8) * usdPerBsv).toFixed(2)} · ` : ''}
              {Number(item.asset.qty).toLocaleString()} sats
            </span>
            <span className="text-[11px]" style={{ color: MUTED }}>
              BSV airdrop{item.holdersOf ? ' to token holders' : ''}.{' '}
              {item.needsMove
                ? 'It reached your ordinals address: move it into your balance to spend it.'
                : 'Already in your balance.'}
            </span>
          </div>
        ) : (
          <div className="min-w-0 flex-1 text-sm font-semibold text-white overflow-hidden text-ellipsis whitespace-nowrap">
            {`${item.asset.qty ? `${Number(item.asset.qty).toLocaleString()} ` : ''}$${item.asset.symbol ?? short(item.asset.id)}`}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onKeep}
          className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-bold"
          style={{ background: GOLD, color: '#010101' }}
        >
          {item.asset.kind === 'bsv' && item.needsMove ? 'Move to balance' : 'Keep'}
        </button>
        <button type="button" onClick={onHide} className={small}>
          Hide
        </button>
        <button type="button" onClick={onTrust} className={small}>
          Trust this sender
        </button>
        {who.handle && (
          <button type="button" onClick={reply} className={small}>
            Reply
          </button>
        )}
        {room && (
          <button type="button" onClick={room} className={small}>
            Open room
          </button>
        )}
        <button type="button" onClick={() => setReporting(true)} className={small} aria-label="Report issuer">
          <Flag size={12} />
        </button>
      </div>
      {viewing && <NftViewer item={item} onClose={() => setViewing(false)} />}
      {reporting && (
        <ReportSheet
          title={`Report ${who.label}`}
          report={{
            kind: 'user',
            target: who.handle ? `$${who.handle}` : item.issuer,
            content: item.note,
            details: `airdrop tx ${item.txid}; issuer ${item.issuer}`,
          }}
          onClose={() => setReporting(false)}
          onSent={() => {
            setReporting(false);
            onHide();
          }}
        />
      )}
    </div>
  );
};

type KeptStatus = 'checking' | 'in' | 'pending';

/** Takes kept NFTs into the wallet's list: the address sync the NFTs tab's Refresh runs, then a look at the list. */
const useKeepNft = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  return async (item: AirdropItem): Promise<KeptStatus> => {
    try {
      const count = (chromeStorageService.getCurrentAccountObject().account?.settings?.maxKeyIndex ?? 4) + 1;
      await syncAddresses.execute(apiContext, { count });
    } catch (e) {
      console.warn('[airdrops] syncAddresses after Keep failed:', e);
    }
    // A kept NFT at the legacy ord address joins the list too (services/legacyOrd.ts).
    await takeInLegacyOrd(apiContext).catch((e) => console.warn('[airdrops] legacy ord sync failed:', e));
    try {
      const { outputs } = await listOrdinals.execute(apiContext, { limit: 200, offset: 0 });
      return inWalletList(
        item,
        outputs.map((o) => o.outpoint),
      )
        ? 'in'
        : 'pending';
    } catch {
      return 'pending';
    }
  };
};

/** After Keep: where the NFT went, with a link. Never just gone; if the wallet can't list it yet, why. */
const KeptNotice = ({
  item,
  status,
  onOpenNfts,
  onDismiss,
}: {
  item: AirdropItem;
  status: KeptStatus;
  onOpenNfts: () => void;
  onDismiss: () => void;
}) => {
  const who = useSenderName(item);
  const [viewing, setViewing] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-3" style={{ background: '#0c2a1c' }} role="status">
      <NftThumb item={item} onOpen={() => setViewing(true)} />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <span className="text-sm font-semibold text-white">
          {status === 'checking' ? 'Moving to your NFTs…' : 'Moved to your NFTs'}
        </span>
        <span className="text-[11px] leading-snug" style={{ color: MUTED }}>
          {status === 'pending'
            ? `From ${who.label}. The wallet hasn't indexed it yet (the transaction may still be unconfirmed), so NFTs shows it under "Kept airdrops" until it does. It's safe at your address.`
            : `From ${who.label}.`}
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onOpenNfts}
            className="min-h-[44px] rounded-lg px-3.5 py-2 text-sm font-bold"
            style={{ background: GOLD, color: '#010101' }}
          >
            Open in NFTs
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="min-h-[44px] rounded-lg px-3.5 py-2 text-sm font-semibold bg-[#2b2f36] text-white"
          >
            OK
          </button>
        </div>
      </div>
      {viewing && <NftViewer item={item} onClose={() => setViewing(false)} />}
    </div>
  );
};

/** The airdrops list, shown inside bMail › Quarantine. */
export const AirdropsList = ({ onLeave }: { onLeave: () => void }) => {
  const { items, visible, state, loading, error, update } = useAirdrops();
  const { handleSelect } = useBottomMenu();
  const keepNft = useKeepNft();
  const navigate = useNavigate();
  const { apiContext } = useServiceContext();
  const [usdPerBsv, setUsdPerBsv] = useState(0);
  const hasBsv = visible.some((i) => i.asset.kind === 'bsv');
  useEffect(() => {
    if (!hasBsv) return;
    fetchExchangeRate(apiContext.chain, apiContext.wocApiKey)
      .then((r) => r && setUsdPerBsv(r))
      .catch(() => undefined);
  }, [hasBsv, apiContext]);
  const [kept, setKept] = useState<{ item: AirdropItem; status: KeptStatus }[]>([]);
  const openNfts = () => {
    handleSelect('ords' as Parameters<typeof handleSelect>[0]);
    onLeave();
  };
  /** Keep (also Trust): an NFT gets a notice and is taken into the wallet's list. */
  const afterKeep = (i: AirdropItem) => {
    // A BSV airdrop on a fixed address: the Sweep moves it into the balance (it signs with that address's key).
    if (i.asset.kind === 'bsv' && i.needsMove) {
      onLeave();
      navigate('/sweep');
      return;
    }
    if (i.asset.kind !== 'nft') return;
    setKept((k) => [{ item: i, status: 'checking' }, ...k.filter((x) => x.item.key !== i.key)]);
    void keepNft(i).then((status) => setKept((k) => k.map((x) => (x.item.key === i.key ? { ...x, status } : x))));
  };
  const known = keptIssuers(items, state.kept);
  // Opening the mailbox clears the badge (items stay listed until Keep or Hide).
  useEffect(() => update((s) => markSeen(s)), [update]);
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex gap-2 rounded-xl p-3 text-[11px] leading-relaxed"
        style={{ background: '#2a1408', color: '#FEC84B' }}
      >
        <ShieldAlert size={16} className="shrink-0 mt-0.5" />
        <span>
          Quarantined tokens and NFTs: sent to you without asking. They are not in your balance and are never spent with
          your own coins. Keep moves one into your holdings (it stays at the same address); Hide keeps it here, out of
          sight, with everything else from that sender. Never enter your recovery words on a site a token sends you to.
        </span>
      </div>
      <label className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
        <input
          type="checkbox"
          checked={state.onlyKnown}
          onChange={(e) => update((s) => ({ ...s, onlyKnown: e.target.checked }))}
        />
        Only show airdrops from issuers I&apos;ve kept before
      </label>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[#F97066] m-0">{error}</p>
          <ErrorActions message={String(error)} />
        </div>
      )}
      {kept.map((k) => (
        <KeptNotice
          key={k.item.key}
          item={k.item}
          status={k.status}
          onOpenNfts={openNfts}
          onDismiss={() => setKept((x) => x.filter((y) => y.item.key !== k.item.key))}
        />
      ))}
      {/* Empty: bMail's "Quarantine is empty" note covers it (counted with the letters). */}
      {!visible.length && loading && (
        <p className="text-xs text-center py-4 m-0" style={{ color: MUTED }}>
          Checking your history…
        </p>
      )}
      {visible.map((i) => {
        // Swipe (bMail rows): left = Hide (undoable), right = Keep (undoable). Buttons stay on the card too.
        const doKeep = () => {
          update((s) => keep(s, i.key));
          afterKeep(i);
          showUndo('Kept', () => {
            update((s) => ({ ...s, kept: s.kept.filter((k) => k !== i.key) }));
            setKept((x) => x.filter((y) => y.item.key !== i.key));
          });
        };
        const doHide = () => {
          const issuerWasHidden = state.hiddenIssuers.includes(i.issuer);
          update((s) => hideItem(s, i));
          showUndo('Hidden', () =>
            update((s) => ({
              ...s,
              hidden: s.hidden.filter((k) => k !== i.key),
              hiddenIssuers: issuerWasHidden ? s.hiddenIssuers : s.hiddenIssuers.filter((x) => x !== i.issuer),
            })),
          );
        };
        const label =
          i.asset.kind === 'token'
            ? `$${i.asset.symbol ?? short(i.asset.id)} airdrop`
            : i.asset.kind === 'bsv'
              ? 'BSV airdrop'
              : 'NFT airdrop';
        return (
          <SwipeRow
            key={i.key}
            rowId={i.key}
            label={label}
            leftActions={[
              {
                id: 'hide',
                label: 'Hide',
                icon: <EyeOff size={18} />,
                color: '#D92D20',
                removes: true,
                onPress: doHide,
              },
            ]}
            rightActions={[
              {
                id: 'keep',
                label: 'Keep',
                icon: <Check size={18} />,
                color: '#12B76A',
                removes: true,
                onPress: doKeep,
              },
            ]}
            fullSwipeLeft="hide"
            fullSwipeRight="keep"
          >
            <Row
              item={i}
              usdPerBsv={usdPerBsv}
              issuerKept={known.has(i.issuer)}
              onLeave={onLeave}
              onKeep={() => {
                update((s) => keep(s, i.key));
                afterKeep(i);
              }}
              onTrust={() => {
                update((s) => trustIssuer(keep(s, i.key), i.issuer));
                afterKeep(i);
                showUndo('Trusted: their tokens skip Quarantine', () =>
                  update((s) => ({
                    ...s,
                    kept: s.kept.filter((k) => k !== i.key),
                    trustedIssuers: (s.trustedIssuers ?? []).filter((x) => x !== i.issuer),
                  })),
                );
              }}
              onHide={() => update((s) => hideItem(s, i))}
            />
          </SwipeRow>
        );
      })}
    </div>
  );
};
