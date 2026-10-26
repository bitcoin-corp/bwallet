/**
 * bMail (owner, 9 Oct 2026): the top-bar mailbox. Pay to send (postage), Penny post by default, friends free and on
 * top, unstamped mail in Requests; tokens and NFTs sent without asking (airdrops) in Quarantine, with a pointer to
 * them from Inbox and Requests and counted on the Quarantine tab, so the badge and the boxes agree. Postage is utility: a stamp to reach someone.
 */
import {
  Archive as TabArchive,
  Inbox as TabInbox,
  MailQuestion as TabRequests,
  Send as TabSent,
  ShieldAlert as TabQuarantine,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { BUREAU_ENABLED } from '../storeBuild';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  Ban,
  ChevronLeft,
  Mail,
  MailOpen,
  Mailbox,
  PenSquare,
  Pin,
  PinOff,
  RefreshCw,
  Reply,
  Settings,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { SwipeRow, type SwipeAction } from '../swipe/SwipeRow';
import { showUndo, UndoToastHost } from '../swipe/undo';
import { binDaysLeft } from './store';
import { mailSegments } from './links';
import { listShortcut } from '../swipe/listKeys';
import { useBackClose } from '../backStack';
import { isFriend as isCallFriend } from '../calls/friends';
import { AirdropsList } from '../airdrops/AirdropsInbox';
import { quarantineIsEmpty, quarantineTotal } from './quarantineCount';
import { airdropPointer } from '../airdrops/inbox';
import { useAirdrops } from '../airdrops/useAirdrops';
import { fetchPeerBPhone } from '../calls/bphone';
import { shortKey } from '../calls/machine';
import { getFriends } from '../calls/friends';
import { resolveCallee } from '../calls/peer';
import { money, parseUsdInput, satsToUsd, usdToSats } from '../money/money';
import { BODY_MAX, SUBJECT_MAX } from './envelope';
import {
  agoLabel,
  amountOf,
  EXAMPLE_SWIPE,
  EXAMPLES,
  EXAMPLES_BELOW,
  examplesAllowed,
  examplesHidden,
  filterExamples,
  hiddenExampleIds,
  hideExample,
  markSwipeHintSeen,
  swipeHintSeen,
  unhideExample,
  fmtCents,
  setExamplesHidden,
  sortExamples,
  tokenLabel,
  totalCents,
  type ExampleMail,
  type TokenAttach,
  type StampKind,
} from './examples';
import {
  FILTERS,
  filterMail,
  PENNY_POST_USD,
  quote,
  sortMail,
  isPinned,
  TIERS,
  type MailFilter,
  type SortMode,
  type TierId,
} from './route';
import type { Received, Sent } from './store';
import { OPEN_BMAIL_EVENT, takeBMailComposeTo, takeBMailDraft, takeBMailMeeting } from './store';
import { canJoinMeeting, findMeetingLink, MEETING_EARLY_MS } from './meeting';
import { takeRouteFrom } from '../push/register';
import { useBMail } from './useBMail';
import { PULL_THRESHOLD, usePullToRefresh } from './usePullToRefresh';
import { BMAIL_OFFLINE_ACTION, friendlyMailError } from './friendlyError';
import { ErrorActions } from '../errors/ErrorActions';
import { APP_NAME } from '../storeBuild';
import { isNative } from '../native';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { WalletInterface } from '@bsv/sdk';
import type { Sealed, SealedOrdinal } from './envelope';
import {
  deliveriesFor,
  hideReceipt,
  internalizeSealedOrdinal,
  keepReceipt,
  receiptAccepted,
  receiptHidden,
} from './ordinalReceipt';
import { loadInbox } from '../airdrops/inbox';
import { notifyMinted } from '../mint/mint';
import { accountNamesFor } from '../names/accountNames';
import { shareText } from '../chat/shareLink';

const MUTED = '#98A2B3';
const GOLD = 'var(--bw-accent-hi)';
/** Pinned letters: orange-gold border + pin icon. */
const PIN = '#F79009';
const f = (u: string, i?: RequestInit) => fetch(u, i);
// bMail › Agreements box (bWalletX only; the chunk is not built for the stores).
const AgreementsBox = BUREAU_ENABLED ? lazy(() => import('../bureau/AgreementsBox')) : null;

type Tab = 'inbox' | 'requests' | 'sent' | 'archive' | 'quarantine' | 'bin';
/** `body`: a compose link's pre-filled text (meeting.ts); the user still reviews and presses Send (owner, 26 Oct 2026). */
type Draft = { to?: string; toLabel?: string; subject?: string; body?: string; inReplyTo?: string; credit?: boolean };

const btn = 'min-h-[44px] rounded-lg px-4 py-2 text-sm font-semibold bg-[#2b2f36] text-white';
const gold = 'min-h-[44px] rounded-lg px-4 py-2 text-sm font-bold';
/** Round top-bar back button (same ring style as the wallet top bar), 44px touch target. */
const roundBtn = 'w-11 h-11 shrink-0 rounded-full flex items-center justify-center bg-transparent cursor-pointer';
const RING_STYLE = { border: '1px solid rgba(255,255,255,0.18)' };
const iconBtn = 'w-11 h-11 shrink-0 flex items-center justify-center rounded-full';

const ago = (at: number) => agoLabel(Math.max(1, Math.round((Date.now() - at) / 60_000)));

const CHIP: Record<StampKind, { label: string; color: string }> = {
  free: { label: 'Friend · free', color: '#6CE9A6' },
  penny: { label: 'Penny post', color: GOLD },
  priority: { label: 'Priority', color: '#FDB022' },
  reply: { label: 'Reply paid', color: '#7CD4FD' },
  signed: { label: 'Signed', color: '#BDB4FE' },
  paytoopen: { label: 'Pay to open', color: '#FD6F8E' },
  none: { label: 'Unstamped', color: MUTED },
};

const Chip = ({ kind, text }: { kind: StampKind; text?: string }) => (
  <span
    className="rounded-full px-1.5 py-[1px] text-[10px] font-semibold whitespace-nowrap"
    style={{ color: CHIP[kind].color, border: `1px solid ${CHIP[kind].color}55` }}
  >
    {text ?? CHIP[kind].label}
  </span>
);

const Avatar = ({ label, color }: { label: string; color: string }) => (
  <span
    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
    style={{ background: color }}
  >
    {(label.replace(/^[$@]/, '')[0] ?? '?').toUpperCase()}
  </span>
);

const keyColor = (k: string) => `hsl(${parseInt(k.slice(2, 6), 16) % 360} 45% 42%)`;
const oneLine = (s: string) => s.replace(/\s+/g, ' ');
const ONE = 'overflow-hidden text-ellipsis whitespace-nowrap';

/** Stamp chips for a real received mail. */
const chipsFor = (r: Received, rate: number, friend: boolean): { kind: StampKind; text?: string }[] => {
  const out: { kind: StampKind; text?: string }[] = [];
  if (r.replyCredit) out.push({ kind: 'reply' });
  else if (r.verifiedSats > 0) {
    const pri = rate > 0 && (r.verifiedSats / 1e8) * rate > 0.015;
    out.push({
      kind: pri ? 'priority' : 'penny',
      text: `${pri ? 'Priority' : 'Penny post'} ${money(r.verifiedSats, rate)}`,
    });
  } else if (friend) out.push({ kind: 'free' });
  else out.push({ kind: 'none', text: r.verifyNote ? 'Stamp not valid' : 'Unstamped' });
  if (r.env.replyPaidSats && !r.replyCredit) out.push({ kind: 'reply' });
  return out;
};

/** Reader stamp: a postage stamp (perforated edge, .bw-mail-stamp) in the stamp kind's colour. */
const PostStamp = ({ kind, text }: { kind: StampKind; text?: string }) => (
  <span className="bw-mail-stamp" style={{ color: CHIP[kind].color }}>
    <span>{text ?? CHIP[kind].label}</span>
  </span>
);

const Stamp = ({ r, rate }: { r: Received; rate: number }) => (
  <div className="flex flex-wrap gap-2 pt-1">
    {chipsFor(r, rate, false).map((c) => (
      <PostStamp key={c.kind} kind={c.kind} text={c.text} />
    ))}
  </div>
);

type Amount = { main: string; eq?: string; note: string; zero?: boolean; example?: boolean };

/**
 * Loud "EXAMPLE" badge (owner, 19 Oct: unmistakable, not a small grey tag) on example rows, senders and amounts,
 * so nobody reads an example as real mail or real money.
 */
const ExampleBadge = ({ text = 'Example' }: { text?: string }) => (
  <span
    className="shrink-0 rounded px-1.5 py-[1px] text-[10px] font-extrabold uppercase tracking-wider"
    style={{ background: '#FDB022', color: '#1a1300' }}
  >
    {text}
  </span>
);

/** Big right-aligned amount for real mail: verified postage. TODO(bmail tokens): token outputs are not parsed yet. */
const realAmount = (r: Received, rate: number, friend: boolean): Amount => {
  const c = chipsFor(r, rate, friend)[0];
  const note = c ? (c.text ?? CHIP[c.kind].label).replace(/ \$.*$/, '').replace(/ [\d.,]+ sats$/, '') : '';
  return {
    main: money(r.verifiedSats, rate),
    note: r.env.replyPaidSats && !r.replyCredit ? `${note} · reply paid` : note,
    zero: r.verifiedSats <= 0,
  };
};

const Row = ({
  avatar,
  title,
  bold,
  subject,
  preview,
  chips,
  time,
  tag,
  onOpen,
  extra,
  amount,
  pinned,
}: {
  pinned?: boolean;
  amount?: Amount;
  avatar: ReactNode;
  title: string;
  bold: boolean;
  subject: string;
  preview: string;
  chips: ReactNode;
  time: string;
  tag?: string;
  onOpen?: () => void;
  extra?: ReactNode;
}) => (
  <button
    type="button"
    onClick={onOpen}
    className={`bw-mail-card flex w-full items-start gap-3 px-3 py-3 text-left${bold ? ' is-unread' : ''}`}
    // Pinned (owner, 9 Oct): an orange-gold border so a pinned letter stands out at the top of the list.
    style={pinned ? { border: `1.5px solid ${PIN}`, boxShadow: `0 0 0 1px ${PIN}33` } : undefined}
    data-pinned={pinned ? '' : undefined}
  >
    {avatar}
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className={`flex items-center gap-1.5${tag ? ' flex-wrap' : ''}`}>
        {bold && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: GOLD }} />}
        {/* Example senders wrap to a second line rather than cut off "· example" on a phone. */}
        <span
          className={`${tag ? 'min-w-0 break-words' : ONE} text-sm text-white ${bold ? 'font-bold' : 'font-medium'}`}
        >
          {title}
        </span>
        {pinned && <Pin size={12} color={PIN} aria-label="Pinned" className="shrink-0" />}
        {tag && <ExampleBadge text={tag} />}
        {!amount && (
          <span className="ml-auto shrink-0 text-[11px]" style={{ color: MUTED }}>
            {time}
          </span>
        )}
      </div>
      <div className={`${ONE} text-[13px] text-white ${bold ? 'font-semibold' : ''}`}>
        {tag && <span className="font-extrabold uppercase tracking-wide text-[#FDB022]">{tag}: </span>}
        {subject || '(no subject)'}
      </div>
      <div className={`${ONE} text-xs`} style={{ color: MUTED }}>
        {preview}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">{chips}</div>
      {extra}
    </div>
    {amount && (
      <div className="flex max-w-[38%] shrink-0 flex-col items-end gap-0.5 text-right">
        {amount.example && <ExampleBadge />}
        <span
          className={`text-lg font-bold leading-tight tabular-nums${amount.example ? ' line-through decoration-1' : ''}`}
          style={{ color: amount.zero ? MUTED : GOLD }}
        >
          {amount.main}
        </span>
        {amount.eq && (
          <span className="text-[10px] tabular-nums" style={{ color: MUTED }}>
            ≈ {amount.eq}
          </span>
        )}
        <span className="text-[10px] leading-tight" style={{ color: MUTED }}>
          {amount.note}
        </span>
        <span className="text-[10px]" style={{ color: '#667085' }}>
          {time}
        </span>
      </div>
    )}
  </button>
);

const TokenChips = ({ tokens, example }: { tokens: TokenAttach[]; example?: boolean }) => (
  <>
    {tokens.map((t) => (
      <span
        key={t.symbol}
        className="rounded-md px-1.5 py-[1px] text-[10px] font-bold whitespace-nowrap"
        style={{ color: '#C3B5FD', background: '#C3B5FD1f', border: '1px solid #C3B5FD44' }}
      >
        {tokenLabel(t)}
        {example ? ' (example)' : ''}
      </span>
    ))}
  </>
);

const MailRow = ({
  r,
  rate,
  friend,
  label,
  onOpen,
}: {
  r: Received;
  rate: number;
  friend: boolean;
  label: string;
  onOpen: () => void;
}) => (
  <Row
    avatar={<Avatar label={label} color={keyColor(r.from)} />}
    title={label}
    bold={!r.read}
    subject={r.opened ? r.opened.subject : 'Sealed letter'}
    preview={r.opened ? oneLine(r.opened.body) : 'Only you can open it. Tap to open.'}
    chips={chipsFor(r, rate, friend).map((c) => (
      <Chip key={c.kind} kind={c.kind} text={c.text} />
    ))}
    time={ago(r.at)}
    onOpen={onOpen}
    pinned={!!r.pinned}
    amount={realAmount(r, rate, friend)}
    extra={
      // verifiedSats is only set once the postage is internalized into the wallet (client.ts verifyPostage), so the
      // money is already mine: say so, so nobody keeps a letter around for the sake of its $0.03 (owner, 9 Oct).
      r.verifiedSats > 0 ? (
        <div className="mt-1 text-[10px] font-semibold" style={{ color: '#6CE9A6' }}>
          +{money(r.verifiedSats, rate)} received · in your wallet
        </div>
      ) : undefined
    }
  />
);

const centsChip = (k: StampKind, cents: number, pnee?: boolean) =>
  k === 'penny' || k === 'priority' || k === 'reply' || k === 'paytoopen'
    ? `${CHIP[k].label} ${pnee ? `${cents} ${cents === 1 ? 'PNEE' : 'PNEEs'}` : `${cents}¢`}`
    : undefined;

const TokenFacts = ({ t }: { t: NonNullable<ExampleMail['token']> }) => (
  <div className="mt-1 text-[11px]" style={{ color: t.spreading ? '#6CE9A6' : MUTED }}>
    {t.spreading ? 'Spreading · ' : ''}${t.symbol} · {t.holders.toLocaleString('en-US')} holders ·{' '}
    {t.forwards.toLocaleString('en-US')} forwards
  </div>
);

const exAmount = (e: ExampleMail): Amount => ({
  ...amountOf(e),
  note: `${amountOf(e).note} · not real`,
  zero: totalCents(e) === 0,
  example: true,
});

const ExampleRow = ({ e, onOpen }: { e: ExampleMail; onOpen: () => void }) => (
  <Row
    avatar={<Avatar label={e.name} color={e.color} />}
    title={`${e.name} · example`}
    bold={!!e.unread}
    subject={e.subject}
    preview={oneLine(e.body)}
    chips={
      <>
        {e.tokens && <TokenChips tokens={e.tokens} example />}
        {e.stamps.map((k) => (
          <Chip key={k} kind={k} text={centsChip(k, e.cents, e.pnee)} />
        ))}
        {e.action && (
          <span className="text-[10px] font-semibold text-white" style={{ opacity: 0.8 }}>
            · {e.action}
          </span>
        )}
      </>
    }
    time={agoLabel(e.ago)}
    tag="Example"
    onOpen={onOpen}
    amount={exAmount(e)}
    extra={e.token && <TokenFacts t={e.token} />}
  />
);

const ExampleReader = ({ e, onHide, onDelete }: { e: ExampleMail; onHide: () => void; onDelete: () => void }) => (
  <div className="flex flex-col gap-3">
    <div className="bw-mail-seg flex items-start gap-2 rounded-xl p-3 text-xs" style={{ color: MUTED }}>
      <ExampleBadge />
      This shows what a bMail looks like. It is not real mail, so nothing here can be paid, signed or answered.
    </div>
    <div className="bw-mail-card flex items-center gap-3 p-4">
      <Avatar label={e.name} color={e.color} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <ExampleBadge /> {e.name}
        </span>
        <span className="text-[11px]" style={{ color: MUTED }}>
          {e.handle} · {agoLabel(e.ago)} ago
        </span>
      </div>
      <div className="flex flex-col items-end gap-0.5 text-right">
        <span className="text-xl font-bold tabular-nums" style={{ color: totalCents(e) ? GOLD : MUTED }}>
          {amountOf(e).main} <span className="text-xs font-extrabold uppercase text-[#FDB022]">example</span>
        </span>
        {amountOf(e).eq && (
          <span className="text-[10px]" style={{ color: MUTED }}>
            ≈ {amountOf(e).eq}
          </span>
        )}
        <span className="text-[10px]" style={{ color: MUTED }}>
          {amountOf(e).note}
        </span>
      </div>
    </div>
    <div className="flex flex-wrap gap-2">
      {e.stamps.map((k) => (
        <PostStamp key={k} kind={k} text={centsChip(k, e.cents, e.pnee)} />
      ))}
    </div>
    {(totalCents(e) > 0 || e.invoiceCents) && (
      <div className="bw-mail-card p-3 flex flex-col gap-1 text-xs">
        <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>
          Money in this mail (example: nothing was paid)
        </div>
        <div className="flex justify-between text-white">
          <span>Postage{e.pnee ? ' (PNEE)' : ''}</span>
          <span className="tabular-nums">
            {e.pnee ? `${e.cents} ${e.cents === 1 ? 'PNEE' : 'PNEEs'} · ${fmtCents(e.cents)}` : fmtCents(e.cents)}
          </span>
        </div>
        {!!e.attachedCents && (
          <div className="flex justify-between text-white">
            <span>Payment attached</span>
            <span className="tabular-nums">{fmtCents(e.attachedCents)}</span>
          </div>
        )}
        {!!e.invoiceCents && (
          <div className="flex justify-between text-white">
            <span>Invoice (asks you to pay)</span>
            <span className="tabular-nums">{fmtCents(e.invoiceCents)}</span>
          </div>
        )}
      </div>
    )}
    {!!e.tokens?.length && (
      <div className="bw-mail-card p-3 flex flex-col gap-2">
        <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>
          Tokens attached (example: none arrived)
        </div>
        {e.tokens.map((t) => (
          <div key={t.symbol} className="flex items-center gap-2">
            <span className="flex-1 text-sm font-semibold text-white">{tokenLabel(t)} (example)</span>
            <button type="button" disabled className={btn} style={{ opacity: 0.45 }}>
              Keep
            </button>
            <button type="button" disabled className={btn} style={{ opacity: 0.45 }}>
              Hide
            </button>
          </div>
        ))}
      </div>
    )}
    <div className="bw-mail-card bw-mail-letter flex flex-col gap-3">
      <div className="text-lg font-bold text-white">
        <span className="font-extrabold text-[#FDB022]">EXAMPLE: </span>
        {e.subject}
      </div>
      <div className="bw-mail-body whitespace-pre-wrap break-words">{e.body}</div>
      {e.token && <TokenFacts t={e.token} />}
    </div>
    {e.action && (
      <button type="button" disabled className={gold} style={{ background: GOLD, opacity: 0.45 }}>
        {e.action} (example)
      </button>
    )}
    <div className="flex gap-2">
      <button type="button" className={`${btn} flex-1`} onClick={onDelete}>
        Delete this example
      </button>
      <button type="button" className={`${btn} flex-1`} onClick={onHide}>
        Delete all examples
      </button>
    </div>
  </div>
);

/**
 * "Join meeting" for a letter that links a bChatX room (owner, 26 Oct 2026). On from 10 minutes before its stated
 * start (always on when none is stated). Opens the room in the app; Desktop and the extension also open the bChatX
 * page (PushEngine.tsx), always the canonical https://www.bchatx.com/room/<TICKER> rebuilt from the ticker.
 */
const JoinMeeting = ({ body }: { body: string }) => {
  const link = useMemo(() => findMeetingLink(body), [body]);
  const [now, setNow] = useState(() => Date.now());
  const open = link ? canJoinMeeting(link.startsAt, now) : false;
  useEffect(() => {
    if (!link?.startsAt || open) return;
    const t = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(60_000, Math.max(1_000, link.startsAt - MEETING_EARLY_MS - Date.now())),
    );
    return () => window.clearTimeout(t);
  }, [link, open, now]);
  if (!link) return null;
  const when = link.startsAt
    ? new Date(link.startsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={!open}
        onClick={() => takeRouteFrom({ segment: 'rooms', ticker: link.ticker, openUrl: link.url })}
        className={gold}
        style={{ background: GOLD, opacity: open ? 1 : 0.5 }}
      >
        Join meeting
      </button>
      {when && (
        <span className="text-[11px]" style={{ color: MUTED }}>
          {open ? `Started or starting at ${when}` : `Opens 10 minutes before ${when}`}
        </span>
      )}
    </div>
  );
};

const Reader = ({
  r,
  label,
  rate,
  open,
  creditUsed,
  onReply,
  trusted,
  onTrust,
}: {
  r: Received;
  label: string;
  rate: number;
  open: (r: Received) => Promise<Sealed>;
  creditUsed: boolean;
  onReply: (d: Draft) => void;
  /** Links are clickable only from a trusted sender (links.ts). */
  trusted: boolean;
  onTrust: () => void;
}) => {
  const [mail, setMail] = useState(r.opened ?? null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const doOpen = () => {
    setBusy(true);
    open(r)
      .then(setMail)
      .catch((e) => setErr(friendlyMailError(e, { fallback: BMAIL_OFFLINE_ACTION })))
      .finally(() => setBusy(false));
  };
  const credit = !!r.env.replyPaidSats && r.verifiedSats > 0 && !creditUsed;
  return (
    <div className="flex flex-col gap-3">
      <div className="bw-mail-card p-4 flex flex-col gap-1.5">
        <div className="text-sm text-white font-semibold">From {label}</div>
        <div className="text-[11px] break-all" style={{ color: MUTED }}>
          {r.from}
        </div>
        <Stamp r={r} rate={rate} />
        {r.verifyNote && <div className="text-[11px] text-[#F97066]">{r.verifyNote}</div>}
        {r.env.postage && (
          <div className="text-[10px] break-all" style={{ color: '#667085' }}>
            Postage tx {r.env.postage.txid}
          </div>
        )}
      </div>
      {r.erased ? (
        <p className="text-xs m-0" style={{ color: MUTED }}>
          This letter was in the Bin for 30 days, so its content was erased from this device.
        </p>
      ) : !mail ? (
        <button type="button" disabled={busy} onClick={doOpen} className={gold} style={{ background: GOLD }}>
          {busy ? 'Opening…' : 'Open'}
        </button>
      ) : (
        <div className="bw-mail-card bw-mail-letter flex flex-col gap-3">
          <div className="text-lg font-bold text-white">{mail.subject || '(no subject)'}</div>
          <div className="bw-mail-body whitespace-pre-wrap break-words">
            {mailSegments(mail.body, trusted).map((seg, n) =>
              seg.href ? (
                <a key={n} href={seg.href} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                  {seg.text}
                </a>
              ) : seg.link ? (
                <span key={n} style={{ color: '#9fb3c8' }} title="Links work once you trust the sender">
                  {seg.text}
                </span>
              ) : (
                <span key={n}>{seg.text}</span>
              ),
            )}
          </div>
          {mail.ordinal && <ReceivedNft r={r} ordinal={mail.ordinal} />}
          <JoinMeeting body={mail.body} />
          {!trusted && mailSegments(mail.body, false).some((x) => x.link) && (
            <div className="flex items-center gap-2 text-[11px]" style={{ color: MUTED }}>
              <span className="flex-1">Links from senders you haven&apos;t trusted are shown as text only.</span>
              <button
                type="button"
                onClick={onTrust}
                className="min-h-[44px] rounded-lg px-3 text-xs font-semibold bg-[#2b2f36] text-white"
              >
                Trust sender
              </button>
            </div>
          )}
        </div>
      )}
      {err && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[#F97066] m-0">{err}</p>
          <ErrorActions message={String(err)} />
        </div>
      )}
      {mail && (
        <button
          type="button"
          className={btn}
          onClick={() =>
            onReply({
              to: r.from,
              toLabel: label,
              subject: mail.subject.startsWith('Re:') ? mail.subject : `Re: ${mail.subject}`,
              inReplyTo: r.id,
              credit,
            })
          }
        >
          {credit ? 'Reply (postage prepaid by sender)' : 'Reply'}
        </button>
      )}
    </div>
  );
};

const Compose = ({
  draft,
  rate,
  myPriceSats,
  send,
  onDone,
}: {
  draft: Draft;
  rate: number;
  myPriceSats: number;
  send: ReturnType<typeof useBMail>['send'];
  onDone: () => void;
}) => {
  const [to, setTo] = useState(draft.toLabel ?? '');
  const [peer, setPeer] = useState<{ key: string; label: string; priceSats: number } | null>(
    draft.to ? { key: draft.to, label: draft.toLabel ?? shortKey(draft.to), priceSats: 0 } : null,
  );
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.body ?? '');
  const [tier, setTier] = useState<TierId | 'free'>(draft.credit ? 'free' : 'standard');
  const [replyPaid, setReplyPaid] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const lookup = async () => {
    setErr('');
    setBusy('Looking up…');
    try {
      const p = await resolveCallee(f, to.trim());
      const card = await fetchPeerBPhone(f, p.key).catch(() => null);
      const usd = card?.profile.mail?.usd ?? PENNY_POST_USD;
      const priceSats = usdToSats(usd, rate) ?? 0;
      setPeer({ key: p.key, label: p.label, priceSats });
      return { key: p.key, label: p.label, priceSats };
    } catch (e) {
      setErr(friendlyMailError(e, { fallback: BMAIL_OFFLINE_ACTION }));
      return null;
    } finally {
      setBusy('');
    }
  };
  // Reply targets an identity key directly: price defaults to Penny post.
  const priceSats = peer?.priceSats || usdToSats(PENNY_POST_USD, rate) || 0;
  const q =
    tier === 'free' ? { stamp: 0, replyPaid: 0, total: 0 } : quote(priceSats, tier, replyPaid ? myPriceSats : 0);
  const go = async () => {
    const p = peer ?? (await lookup());
    if (!p) return;
    if (!body.trim()) return setErr('Write something');
    setBusy('Sending…');
    setErr('');
    try {
      await send({
        to: p.key,
        toLabel: p.label,
        sealed: { subject: subject.trim(), body },
        sats: q.total,
        replyPaidSats: q.replyPaid,
        inReplyTo: draft.inReplyTo,
        usesReplyCredit: draft.credit && tier === 'free',
      });
      onDone();
    } catch (e) {
      setErr(friendlyMailError(e, { fallback: BMAIL_OFFLINE_ACTION }));
    } finally {
      setBusy('');
    }
  };
  const input = 'w-full rounded-lg px-3 py-2 text-sm text-white bg-[#22252c] outline-none';
  return (
    <div className="flex flex-col gap-2">
      <input
        className={input}
        placeholder={`To: $name (${APP_NAME}), paymail or name`}
        value={to}
        disabled={!!draft.to}
        onChange={(e) => {
          setTo(e.target.value);
          setPeer(null);
        }}
        onBlur={() => to.trim() && !peer && void lookup()}
      />
      <input
        className={input}
        placeholder="Subject"
        maxLength={SUBJECT_MAX}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <textarea
        className={`${input} min-h-[140px]`}
        placeholder="Message (sealed: only they can open it)"
        maxLength={BODY_MAX}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="text-xs" style={{ color: MUTED }}>
        Postage
      </div>
      <div className="flex gap-2">
        {[
          ...(draft.credit
            ? [{ id: 'free' as const, label: 'Reply paid' }]
            : [{ id: 'free' as const, label: 'No stamp' }]),
          ...TIERS.map((t) => ({ id: t.id, label: t.label })),
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tier === t.id}
            onClick={() => setTier(t.id)}
            className="min-h-[44px] flex-1 rounded-xl py-2 text-sm font-semibold"
            style={
              tier === t.id ? { background: GOLD, color: '#1a1300' } : { border: '1px solid #2b2f36', color: '#fff' }
            }
          >
            {t.label}
            {t.id !== 'free' && (
              <div className="text-[10px] font-normal opacity-80">{money(quote(priceSats, t.id).stamp, rate)}</div>
            )}
          </button>
        ))}
      </div>
      {tier !== 'free' && (
        <label className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
          <input type="checkbox" checked={replyPaid} onChange={(e) => setReplyPaid(e.target.checked)} />
          Reply paid: include their return postage ({money(myPriceSats, rate)}) so answering costs them nothing
        </label>
      )}
      <div className="rounded-xl p-3 text-xs" style={{ background: 'rgba(10,10,11,0.72)', color: '#fff' }}>
        {peer
          ? `${peer.label} · price to reach: ${money(priceSats, rate)}`
          : 'Price to reach: Penny post (1¢) unless they set one'}
        <br />
        {tier === 'free'
          ? draft.credit
            ? 'Free: the sender prepaid your reply.'
            : 'No stamp: lands in their Requests unless you are a contact.'
          : `You pay ${money(q.total, rate)} postage to them, from your wallet, when you send.`}
      </div>
      {err && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[#F97066] m-0">{err}</p>
          <ErrorActions message={String(err)} />
        </div>
      )}
      <button type="button" disabled={!!busy} onClick={() => void go()} className={gold} style={{ background: GOLD }}>
        {busy || (q.total ? `Send · ${money(q.total, rate)}` : 'Send')}
      </button>
    </div>
  );
};

const SentRow = ({ s, rate }: { s: Sent; rate: number }) => (
  <Row
    avatar={<Avatar label={s.toLabel} color={keyColor(s.to)} />}
    title={`To ${s.toLabel}`}
    bold={false}
    subject={s.subject}
    preview={oneLine(s.body)}
    chips={
      <>
        {s.sats ? (
          <Chip kind="penny" text={`Postage ${money(s.sats - s.replyPaidSats, rate)}`} />
        ) : (
          <Chip kind="none" />
        )}
        {s.replyPaidSats > 0 && <Chip kind="reply" text={`Reply paid ${money(s.replyPaidSats, rate)}`} />}
      </>
    }
    time={ago(s.at)}
  />
);

const PriceSettings = ({
  usd,
  rate,
  save,
  onDone,
}: {
  usd: number;
  rate: number;
  save: (usd: number) => Promise<void>;
  onDone: () => void;
}) => {
  const [v, setV] = useState(String(usd));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseUsdInput(v);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-bold text-white">Price to reach me</div>
      <div className="text-xs" style={{ color: MUTED }}>
        Strangers who put at least this much postage on their mail land in your Inbox, highest first. Less goes to
        Requests. Contacts always write free. Default: Penny post (1¢).
      </div>
      <input
        className="w-full rounded-lg px-3 py-2 text-sm text-white bg-[#22252c] outline-none"
        inputMode="decimal"
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      {n !== null && (
        <div className="text-xs" style={{ color: MUTED }}>
          ≈ {money(usdToSats(n, rate) ?? 0, rate)}
        </div>
      )}
      {err && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[#F97066] m-0">{err}</p>
          <ErrorActions message={String(err)} />
        </div>
      )}
      <button
        type="button"
        disabled={busy || n === null || n > 100}
        className={gold}
        style={{ background: GOLD }}
        onClick={() => {
          if (n === null) return;
          setBusy(true);
          save(n)
            .then(onDone)
            .catch((e) =>
              setErr(
                `Saved on this device; not published. ${friendlyMailError(e, { fallback: BMAIL_OFFLINE_ACTION })}`,
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        Save
      </button>
    </div>
  );
};

/** Best label for an identity key: Calls friend name, a label I sent to, their bPhone paymail/name, else short key. */
const useNames = (keys: string[], sent: Sent[]) => {
  const [remote, setRemote] = useState<Record<string, string>>({});
  const joined = [...new Set(keys)].sort().join(',');
  useEffect(() => {
    let live = true;
    for (const k of joined ? joined.split(',') : []) {
      if (remote[k] || getFriends().some((x) => x.key === k)) continue;
      fetchPeerBPhone(f, k)
        .then((p) => {
          const label = p?.paymail ? `$${p.paymail.split('@')[0]}` : p?.name;
          if (live && label) setRemote((m) => ({ ...m, [k]: label }));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return (k: string) =>
    getFriends().find((x) => x.key === k)?.name ||
    remote[k] ||
    sent.find((s) => s.to === k && !/…/.test(s.toLabel))?.toLabel ||
    shortKey(k);
};

const WEEK_MS = 7 * 24 * 3600 * 1000;

/**
 * One-time swipe hint (owner, 19 Oct): the first example slides left to show a red Delete, then back.
 * prefers-reduced-motion: no movement, the hint just counts as seen.
 */
const SwipeHint = ({ children, onDone }: { children: ReactNode; onDone: () => void }) => {
  const reduced = (() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return true;
    }
  })();
  useEffect(() => {
    const t = setTimeout(onDone, reduced ? 0 : 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (reduced) return <>{children}</>;
  return (
    <div className="relative overflow-hidden rounded-2xl" data-swipe-hint="">
      <style>{`@keyframes bwMailHint{0%,15%{transform:translateX(0)}40%,70%{transform:translateX(-96px)}95%,100%{transform:translateX(0)}}`}</style>
      <div
        aria-hidden
        className="absolute inset-y-0 right-0 flex w-24 flex-col items-center justify-center gap-1 text-xs font-bold text-white"
        style={{ background: '#D92D20' }}
      >
        <Trash2 size={18} />
        Delete
      </div>
      <div className="relative" style={{ animation: 'bwMailHint 2.4s ease-in-out 0.4s 1 both' }}>
        {children}
      </div>
    </div>
  );
};

const Empty = ({ title, text }: { title: string; text: string }) => (
  <div className="bw-mail-card flex flex-col items-center gap-2 px-6 py-8 text-center">
    <Mailbox size={28} color={GOLD} />
    <div className="text-sm font-bold text-white">{title}</div>
    <div className="text-xs leading-relaxed" style={{ color: MUTED }}>
      {text}
    </div>
  </div>
);

export const BMailScreen = ({ onClose, initialTab = 'inbox' }: { onClose: () => void; initialTab?: Tab }) => {
  const m = useBMail();
  const drops = useAirdrops();
  const dropsLine = airdropPointer(drops.visible);
  const quarantineCount = quarantineTotal(m.boxes.quarantine.length, drops.visible.length);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [reading, setReading] = useState<Received | null>(null);
  const [example, setExample] = useState<ExampleMail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [settings, setSettings] = useState(false);
  const [meetingWanted, setMeetingWanted] = useState<string | null>(null);
  // Examples are remembered per account (owner, 19 Oct): Delete all / Delete one persist; Settings brings them back.
  const { chromeStorageService } = useServiceContext();
  const acct = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [exVer, setExVer] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hideEx = useMemo(() => examplesHidden(acct), [acct, exVer]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const goneExamples = useMemo(() => hiddenExampleIds(acct), [acct, exVer]);
  const myAddress = accountNamesFor(acct).paymail;
  useBackClose(true, onClose);
  // Settle any postage the wallet still holds as unsent though the chain has it (rate-limited in the wallet).
  useEffect(() => {
    sendMessageAsync({ action: 'STORAGE_RECONCILE_POSTAGE' }).catch(() => undefined);
  }, []);
  // Scan › person page › "Send a bMail": open on a new mail to them (store.openBMailTo).
  useEffect(() => {
    const take = () => {
      const to = takeBMailComposeTo();
      if (to) setDraft({ toLabel: to });
      // A compose link (bChatX meeting invite): the fields filled in, the recipient still looked up on Send.
      const d = takeBMailDraft();
      if (d) setDraft({ toLabel: d.to, subject: d.subject, body: d.body });
      // A meeting_invite tap before the meeting: the Inbox, on that invite when it has been opened here before.
      const ticker = takeBMailMeeting();
      if (ticker) {
        setDraft(null);
        setTab('inbox');
        setMeetingWanted(ticker);
      }
    };
    take();
    window.addEventListener(OPEN_BMAIL_EVENT, take);
    return () => window.removeEventListener(OPEN_BMAIL_EVENT, take);
  }, []);
  // The invite for a tapped meeting_invite: the newest opened letter linking that bChatX room. Unopened letters can't
  // be matched (their subject and body are sealed), so then the Inbox simply stays open.
  useEffect(() => {
    if (!meetingWanted) return;
    const hit = [...m.boxes.inbox, ...m.boxes.requests]
      .filter((r) => r.opened && findMeetingLink(r.opened.body)?.ticker === meetingWanted)
      .sort((a, b) => b.at - a.at)[0];
    if (hit) setReading(hit);
    if (hit || !m.loading) setMeetingWanted(null);
  }, [meetingWanted, m.boxes, m.loading]);
  // bPhone friends only (owner, 9 Oct): people I wrote to are not pinned for that alone.
  const isContact = (k: string) => isCallFriend(k);
  const myPriceSats = m.priceSats;
  const sub = reading || draft || settings || example;
  const back = () => {
    setReading(null);
    setExample(null);
    setDraft(null);
    setSettings(false);
  };
  // Android Back closes the open sub-view first (registered after bMail's own closer, so it pops first).
  useBackClose(!!sub, back);
  // Bin (owner, 9 Oct): not a tab, a trash icon in the bMail header; Back returns to the tab it was opened from.
  const [binFrom, setBinFrom] = useState<Tab>(initialTab === 'bin' ? 'inbox' : initialTab);
  const openBin = () => {
    if (tab !== 'bin') setBinFrom(tab);
    setTab('bin');
  };
  const leaveBin = () => setTab(binFrom);
  useBackClose(tab === 'bin' && !sub, leaveBin);
  const subTitle = draft
    ? draft.inReplyTo
      ? 'Reply'
      : 'New mail'
    : settings
      ? 'Settings'
      : example
        ? 'Example'
        : 'Mail';
  // Swipe right from the left edge (first 24px) goes back.
  const edgeStart = useRef<{ x: number; y: number } | null>(null);
  const edge = {
    start: (e: TouchEvent) => {
      const t = e.touches[0];
      edgeStart.current = t && t.clientX <= 24 ? { x: t.clientX, y: t.clientY } : null;
    },
    end: (e: TouchEvent) => {
      const s0 = edgeStart.current;
      edgeStart.current = null;
      const t = e.changedTouches[0];
      if (s0 && t && t.clientX - s0.x > 60 && Math.abs(t.clientY - s0.y) < 50) back();
    },
  };
  const nameOf = useNames(
    m.state.received.map((r) => r.from),
    m.state.sent,
  );
  const showEx = examplesAllowed(isNative) && !hideEx && m.state.received.length + m.state.sent.length < EXAMPLES_BELOW;
  const hideExamples = () => {
    setExamplesHidden(true, acct);
    setExVer((v) => v + 1);
    setExample(null);
    exUndo(
      'Examples deleted',
      () => {
        setExamplesHidden(false, acct);
        goneExamples.forEach((id) => hideExample(id, acct));
        setExVer((v) => v + 1);
      },
      true,
    );
  };
  // When the clean empty inbox takes over, Undo sits inside it (a toast would cover its buttons on a phone).
  const [inlineUndo, setInlineUndo] = useState<{ text: string; undo: () => void } | null>(null);
  useEffect(() => {
    if (!inlineUndo) return;
    const t = setTimeout(() => setInlineUndo(null), 6000);
    return () => clearTimeout(t);
  }, [inlineUndo]);
  const exUndo = (text: string, undo: () => void, emptiesList: boolean) => {
    const realMail = tab === 'requests' ? view('requests').length : view('inbox').length;
    if (emptiesList && !realMail && tab === 'inbox') setInlineUndo({ text, undo });
    else showUndo(text, undo);
  };
  const deleteExample = (id: string, verb = 'deleted') => {
    hideExample(id, acct);
    setExVer((v) => v + 1);
    setExample(null);
    exUndo(
      `Example ${verb}`,
      () => {
        unhideExample(id, acct);
        setExVer((v) => v + 1);
      },
      exInbox.filter((x) => !goneExamples.includes(x.id)).length <= 1,
    );
  };
  const showExamplesAgain = () => {
    setExamplesHidden(false, acct);
    setExVer((v) => v + 1);
  };
  const examplesOff = examplesAllowed(isNative) && (hideEx || goneExamples.length > 0);
  // One-time swipe hint on the first example row (respects prefers-reduced-motion: no animation, seen anyway).
  const [hint, setHint] = useState(() => !swipeHintSeen());
  const shareAddress = () => {
    if (myAddress) void shareText(`Write to me on bMail: ${myAddress}`);
  };
  const [now] = useState(() => Date.now());
  const week = useMemo(() => {
    const recent = m.state.received.filter((r) => now - r.at < WEEK_MS && r.verifiedSats > 0);
    return { sats: recent.reduce((a, r) => a + r.verifiedSats, 0), n: recent.length };
  }, [m.state.received, now]);
  const [sort, setSort] = useState<SortMode>('paid');
  const [filter, setFilter] = useState<MailFilter>('all');
  const mode: SortMode = tab !== 'requests' && sort === 'spreading' ? 'paid' : sort;
  // sortMail puts my pinned letters first (then friends, then the chosen sort) in every sort mode.
  const group = (r: Received) => (r.pinned ? 0 : isPinned(r, isContact) ? 1 : 2);
  const view = (box: 'inbox' | 'requests') => sortMail(filterMail(m.boxes[box], filter), mode, isContact);
  // Swipe to organise (owner, 9 Oct): left tray Reply · Archive · Delete (full = Archive), right tray Read · Pin ·
  // Quarantine (full = toggle read); Spam / Block in the … menu. Every destructive action has Undo.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const replyTo = (r: Received) => {
    if (r.opened)
      setDraft({
        to: r.from,
        toLabel: nameOf(r.from),
        subject: r.opened.subject.startsWith('Re:') ? r.opened.subject : `Re: ${r.opened.subject}`,
        inReplyTo: r.id,
        credit: !!r.env.replyPaidSats && r.verifiedSats > 0 && !m.state.usedCredits.includes(r.id),
      });
    // Still sealed: open it in the reader, which has the Reply button once it is unsealed.
    else setReading(r);
  };
  const undoable = (text: string, undo: () => void) => showUndo(text, undo);
  // Paid letters: the postage was internalized into the wallet when the letter arrived (client.ts verifyPostage), so
  // deleting or archiving it does not touch the money. The toast says so (owner, 9 Oct: "where did the money go?").
  const keepsPostage = (ids: string[]) => {
    const sats = m.state.received
      .filter((r) => ids.includes(r.id))
      .reduce((a, r) => a + Math.max(0, r.verifiedSats), 0);
    return sats > 0 ? ` · the ${money(sats, m.rate)} postage stays in your wallet` : '';
  };
  const archive = (ids: string[]) =>
    undoable(
      `${ids.length > 1 ? `Archived ${ids.length}` : 'Archived'}${keepsPostage(ids)}`,
      m.flag(ids, { archived: true }),
    );
  const unarchive = (ids: string[]) => undoable('Moved to Inbox', m.flag(ids, { archived: false }));
  const remove = (ids: string[]) =>
    undoable(
      `${ids.length > 1 ? `Deleted ${ids.length}` : 'Deleted'}${keepsPostage(ids)}`,
      m.flag(ids, { deleted: true }),
    );
  const mailActions = (r: Received, inArchive: boolean) => {
    const left: SwipeAction[] = [
      { id: 'reply', label: 'Reply', icon: <Reply size={18} />, color: '#475467', onPress: () => replyTo(r) },
      inArchive
        ? {
            id: 'unarchive',
            label: 'Inbox',
            icon: <ArchiveRestore size={18} />,
            color: '#12B76A',
            removes: true,
            onPress: () => unarchive([r.id]),
          }
        : {
            id: 'archive',
            label: 'Archive',
            icon: <Archive size={18} />,
            color: '#12B76A',
            removes: true,
            onPress: () => archive([r.id]),
          },
      {
        id: 'delete',
        label: 'Delete',
        icon: <Trash2 size={18} />,
        color: '#D92D20',
        removes: true,
        onPress: () => remove([r.id]),
      },
    ];
    const right: SwipeAction[] = [
      {
        id: 'read',
        label: r.read ? 'Unread' : 'Read',
        icon: r.read ? <Mail size={18} /> : <MailOpen size={18} />,
        color: '#2E90FA',
        onPress: () => void m.flag([r.id], { read: !r.read }),
      },
      {
        id: 'pin',
        label: r.pinned ? 'Unpin' : 'Pin',
        icon: r.pinned ? <PinOff size={18} /> : <Pin size={18} />,
        color: '#B54708',
        onPress: () => void m.flag([r.id], { pinned: !r.pinned }),
      },
      {
        id: 'quarantine',
        label: 'Quarantine',
        icon: <ShieldAlert size={18} />,
        color: '#7A2E0E',
        removes: true,
        // Same as Spam: this letter goes to Quarantine and so does their future mail (Undo puts both back).
        onPress: () =>
          undoable(
            `Quarantined · future mail from ${nameOf(r.from)} goes to Quarantine${keepsPostage([r.id])}`,
            m.spam(r),
          ),
      },
    ];
    const more: SwipeAction[] = [
      {
        id: 'spam',
        label: 'Spam',
        icon: <ShieldAlert size={14} />,
        color: '#7A2E0E',
        removes: true,
        onPress: () => undoable('Marked as spam: future mail from them goes to Quarantine', m.spam(r)),
      },
      {
        id: 'block',
        label: `Block ${nameOf(r.from)}`,
        icon: <Ban size={14} />,
        color: '#7A271A',
        removes: true,
        onPress: () => undoable(`Blocked ${nameOf(r.from)}`, m.block(r.from)),
      },
    ];
    return { left, right, more, fullLeft: inArchive ? 'unarchive' : 'archive', fullRight: 'read' };
  };
  const swipeMail = (r: Received, row: ReactNode, inArchive = false) => {
    const a = mailActions(r, inArchive);
    return (
      <SwipeRow
        rowId={r.id}
        label={`mail from ${nameOf(r.from)}`}
        leftActions={a.left}
        rightActions={a.right}
        moreActions={a.more}
        fullSwipeLeft={a.fullLeft}
        fullSwipeRight={a.fullRight}
        selected={selected.has(r.id)}
        onSelect={(on) =>
          setSelected((s) => {
            const n = new Set(s);
            if (on) n.add(r.id);
            else n.delete(r.id);
            return n;
          })
        }
      >
        {row}
      </SwipeRow>
    );
  };
  const listKeys = (e: React.KeyboardEvent<HTMLDivElement>) =>
    listShortcut(e, (id, key) => {
      const r = m.state.received.find((x) => x.id === id);
      if (!r) return;
      if (key === 'archive') (r.archived ? unarchive : archive)([id]);
      if (key === 'delete') remove([id]);
      if (key === 'read') m.flag([id], { read: !r.read });
    });
  const sel = [...selected].filter((id) => m.state.received.some((r) => r.id === id));
  const exView = (box: 'inbox' | 'requests') =>
    showEx
      ? sortExamples(
          filterExamples(
            EXAMPLES.filter((e) => e.box === box),
            filter,
          ),
          mode,
        )
      : [];
  const exInbox = exView('inbox');
  const exRequests = exView('requests');
  // Value in view: verified postage on real mail this week, plus example amounts shown (labelled as examples).
  const inView =
    tab !== 'inbox' && tab !== 'requests'
      ? null
      : (() => {
          const real = view(tab).filter((r) => now - r.at < WEEK_MS && r.verifiedSats > 0);
          const ex = tab === 'inbox' ? exInbox : exRequests;
          const usd =
            (satsToUsd(
              real.reduce((a, r) => a + r.verifiedSats, 0),
              m.rate,
            ) ?? 0) +
            ex.reduce((a, e) => a + totalCents(e), 0) / 100;
          return { usd, n: real.length + ex.filter((e) => totalCents(e) > 0).length, ex: ex.length > 0 };
        })();

  const scroller = useRef<HTMLDivElement>(null);
  const ptr = usePullToRefresh(scroller, !sub, m.refresh);
  const ptrShow = ptr.pull > 0 || ptr.refreshing;
  const ptrH = ptr.refreshing ? 40 : ptr.pull;

  // In-frame sub-views (reader, settings, example) sit in the content area; Compose is a full-screen sheet over the bars.
  const inFrameSub = !draft && !!(reading || settings || example);
  const subHeader = (top: string) => (
    <div
      className="bw-mail-bar sticky top-0 z-10 grid grid-cols-[44px_1fr_44px] items-center gap-2 px-3 pb-2"
      style={{ paddingTop: top }}
    >
      <button type="button" aria-label="Back" onClick={back} className={roundBtn} style={RING_STYLE}>
        <ChevronLeft size={22} color="#fff" />
      </button>
      <h2 className="m-0 truncate text-center text-base font-bold text-white">{subTitle}</h2>
      <span aria-hidden />
    </div>
  );

  return (
    <div
      ref={scroller}
      className="relative flex min-h-0 w-full flex-1 flex-col overflow-y-auto"
      style={{ overscrollBehaviorY: 'contain' }}
      onTouchStart={inFrameSub ? edge.start : undefined}
      onTouchEnd={inFrameSub ? edge.end : undefined}
    >
      {draft &&
        createPortal(
          <div
            className="fixed inset-0 z-[220] flex flex-col overflow-y-auto"
            style={{ background: '#0d0e11', overscrollBehaviorY: 'contain' }}
            onTouchStart={edge.start}
            onTouchEnd={edge.end}
          >
            {subHeader('calc(env(safe-area-inset-top) + 8px)')}
            <div className="flex flex-col gap-2 px-4 pb-24">
              <Compose
                draft={draft}
                rate={m.rate}
                myPriceSats={myPriceSats}
                send={m.send}
                onDone={() => {
                  back();
                  setTab('sent');
                }}
              />
            </div>
          </div>,
          document.body,
        )}
      {inFrameSub ? (
        subHeader('8px')
      ) : (
        <div className="bw-mail-bar sticky top-0 z-10 flex items-center gap-1 px-3 pb-2" style={{ paddingTop: 8 }}>
          {/* Ticking mail turns this row into the selection bar (owner, 9 Oct 2026), like Mail. */}
          {sel.length > 0 ? (
            <div
              className="flex flex-1 items-center gap-2 text-sm text-white"
              role="toolbar"
              aria-label="Selected mail"
            >
              <span className="flex-1">{sel.length} selected</span>
              <button
                type="button"
                className="min-h-[40px] rounded-lg px-3 font-semibold"
                style={{ background: '#12B76A' }}
                onClick={() => {
                  (tab === 'archive' ? unarchive : archive)(sel);
                  setSelected(new Set());
                }}
              >
                {tab === 'archive' ? 'Move to Inbox' : 'Archive'}
              </button>
              <button
                type="button"
                className="min-h-[40px] rounded-lg px-3 font-semibold"
                style={{ background: '#D92D20' }}
                onClick={() => {
                  remove(sel);
                  setSelected(new Set());
                }}
              >
                Delete
              </button>
              <button
                type="button"
                className="min-h-[40px] px-2"
                style={{ color: MUTED }}
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
            </div>
          ) : (
            <>
              <Mailbox size={18} color={GOLD} />
              <h2 className="text-base font-bold text-white flex-1 m-0">bMail</h2>
              <button
                type="button"
                aria-label={m.boxes.bin.length ? `Bin, ${m.boxes.bin.length} letters` : 'Bin'}
                title="Bin"
                onClick={openBin}
                className={`${iconBtn} relative`}
              >
                <Trash2 size={16} color={MUTED} />
                {m.boxes.bin.length > 0 && (
                  <span
                    className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full px-1 text-center text-[10px] font-bold leading-4"
                    style={{ background: GOLD, color: '#1a1300' }}
                  >
                    {m.boxes.bin.length > 99 ? '99+' : m.boxes.bin.length}
                  </span>
                )}
              </button>
              <button type="button" aria-label="Refresh" onClick={() => void m.refresh()} className={iconBtn}>
                <RefreshCw size={16} color={MUTED} className={m.loading ? 'animate-spin' : ''} />
              </button>
              <button type="button" aria-label="bMail settings" onClick={() => setSettings(true)} className={iconBtn}>
                <Settings size={16} color={MUTED} />
              </button>
            </>
          )}
        </div>
      )}
      {ptrShow && (
        <div
          role="status"
          aria-live="polite"
          className="flex shrink-0 items-center justify-center gap-2 overflow-hidden text-[11px] motion-safe:transition-[height] motion-safe:duration-150"
          style={{ height: ptrH, color: ptr.armed || ptr.refreshing ? GOLD : MUTED }}
        >
          <RefreshCw
            size={14}
            color={ptr.armed || ptr.refreshing ? GOLD : MUTED}
            className={ptr.refreshing ? 'motion-safe:animate-spin' : ''}
            style={ptr.refreshing ? undefined : { transform: `rotate(${(ptr.pull / PULL_THRESHOLD) * 270}deg)` }}
          />
          <span>{ptr.refreshing ? 'Refreshing…' : ptr.armed ? 'Release to refresh' : 'Pull to refresh'}</span>
        </div>
      )}
      <UndoToastHost />
      {/* Owner, 9 Oct: a gold floating New mail button above the dock (same compose as before); Bin is in the header. */}
      {!inFrameSub && !draft && (
        <button
          type="button"
          onClick={() => setDraft({})}
          aria-label="New mail"
          title="New mail"
          className="fixed right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full shadow-xl"
          style={{
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + var(--dock-h, 3.75rem) + 16px)',
            background: GOLD,
          }}
        >
          <PenSquare size={22} color="#1a1300" />
        </button>
      )}
      <div
        className={`flex flex-col gap-2 px-4 pb-24${sel.length ? ' bw-swipe-selecting' : ''}`}
        onKeyDown={inFrameSub ? undefined : listKeys}
      >
        {settings ? (
          <>
            <PriceSettings usd={m.state.priceUsd} rate={m.rate} save={m.setPrice} onDone={back} />
            {examplesOff && (
              <button
                type="button"
                className="min-h-[44px] self-start px-1 text-xs underline"
                style={{ color: MUTED }}
                onClick={() => {
                  showExamplesAgain();
                  back();
                }}
              >
                Show examples again
              </button>
            )}
          </>
        ) : example ? (
          <ExampleReader e={example} onHide={hideExamples} onDelete={() => deleteExample(example.id)} />
        ) : reading ? (
          <Reader
            r={m.state.received.find((x) => x.id === reading.id) ?? reading}
            label={nameOf(reading.from)}
            rate={m.rate}
            open={m.open}
            creditUsed={m.state.usedCredits.includes(reading.id)}
            trusted={m.isTrusted(reading.from)}
            onTrust={() => m.trust(reading.from)}
            onReply={(d) => {
              setReading(null);
              setDraft(d);
            }}
          />
        ) : null}
        {!inFrameSub && (
          <>
            {/* Fixed height, one line per text row (owner, 15 Oct 2026: switching boxes must not resize this card or
                move the mailbox row; only the list below changes). Long values truncate instead of wrapping. */}
            <div className="bw-mail-card bw-mail-hero flex h-[92px] shrink-0 items-center gap-3 overflow-hidden px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[11px] uppercase leading-4 tracking-wide" style={{ color: MUTED }}>
                  {inView ? 'In view · postage this week' : 'Postage received this week'}
                </span>
                <span className="truncate text-2xl font-bold tabular-nums leading-8" style={{ color: GOLD }}>
                  {inView ? fmtCents(Math.round(inView.usd * 100)) : money(week.sats, m.rate)}
                </span>
                <span className="truncate text-[11px] leading-4" style={{ color: MUTED }}>
                  {inView ? inView.n : week.n} stamped
                  {inView?.ex ? ' · includes examples' : ''}
                </span>
              </div>
              {/* Tap to change it (owner, 14 Oct 2026: the price to reach you should be configurable from the banner). */}
              <button
                type="button"
                onClick={() => setSettings(true)}
                aria-label={`Price to reach you: ${money(m.priceSats, m.rate)}. Change it`}
                className="flex max-w-[45%] shrink-0 flex-col items-end whitespace-nowrap text-[11px] leading-4 rounded-xl px-2 py-1 -mr-2 bg-transparent border-0 cursor-pointer"
                style={{ color: MUTED }}
              >
                <span>Price to reach you</span>
                <span className="max-w-full truncate text-sm font-semibold leading-5 text-white">
                  {money(m.priceSats, m.rate)}
                </span>
                <span style={{ color: GOLD }}>Change ›</span>
              </button>
            </div>
            {tab === 'bin' ? (
              <div className="flex min-h-[60px] items-center gap-2">
                <button
                  type="button"
                  onClick={leaveBin}
                  className="flex min-h-[44px] items-center gap-1 rounded-xl px-3 text-sm font-semibold text-white"
                  style={{ border: '1px solid #2b2f36' }}
                >
                  <ChevronLeft size={16} /> Back
                </button>
                <span className="text-base font-bold text-white">Bin</span>
              </div>
            ) : (
              <div
                className={`grid ${AgreementsBox ? 'grid-cols-3 min-[480px]:grid-cols-6' : 'grid-cols-5'} gap-1.5`}
                role="tablist"
                aria-label="Mailboxes"
              >
                {/* Fixed boxes with icons; nothing scrolls sideways (owner, 14 Oct 2026: a left-right filter
                    row "smacks of trying to squeeze everything in"). The count sits on the icon. Agreements
                    (bWalletX) is the sixth: two rows of three on a phone. */}
                {(
                  [
                    ['inbox', 'Inbox', TabInbox, m.unread],
                    ['requests', 'Requests', TabRequests, m.boxes.requests.length],
                    ['sent', 'Sent', TabSent, 0],
                    ['archive', 'Archive', TabArchive, 0],
                    ['quarantine', 'Quarantine', TabQuarantine, quarantineCount],
                  ] as const
                ).map(([id, label, Icon, n]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    aria-label={n ? `${label}, ${n}` : label}
                    onClick={() => setTab(id)}
                    className="relative h-[60px] flex flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1.5 text-[10px] font-semibold"
                    style={
                      tab === id
                        ? { background: GOLD, color: '#1a1300' }
                        : { border: '1px solid #2b2f36', color: '#fff' }
                    }
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
                    {n > 0 && (
                      <span
                        className="absolute top-1 right-1 min-w-[16px] rounded-full px-1 text-[9px] font-bold leading-4 text-center"
                        style={
                          tab === id ? { background: '#1a1300', color: GOLD } : { background: GOLD, color: '#1a1300' }
                        }
                      >
                        {n > 99 ? '99+' : n}
                      </span>
                    )}
                  </button>
                ))}
                {AgreementsBox && (
                  <Suspense fallback={null}>
                    <AgreementsBox gold={GOLD} />
                  </Suspense>
                )}
              </div>
            )}
            {(tab === 'inbox' || tab === 'requests') && (
              <>
                <div className="bw-mail-seg flex rounded-xl p-0.5">
                  {(
                    [
                      ['paid', 'Most paid'],
                      ['newest', 'Newest'],
                      ['friends', 'Friends'],
                      ...(tab === 'requests' ? ([['spreading', 'Spreading']] as const) : []),
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={mode === id}
                      onClick={() => setSort(id)}
                      className="min-h-[44px] flex-1 rounded-lg py-2 text-xs font-semibold"
                      style={mode === id ? { background: '#2b2f36', color: GOLD } : { color: MUTED }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {FILTERS.map((x) => (
                    <button
                      key={x.id}
                      type="button"
                      aria-pressed={filter === x.id}
                      onClick={() => setFilter(x.id)}
                      className="min-h-[44px] shrink-0 rounded-full px-3.5 py-2 text-xs font-semibold"
                      style={
                        filter === x.id
                          ? { background: GOLD, color: '#1a1300' }
                          : { border: '1px solid #2b2f36', color: '#fff' }
                      }
                    >
                      {x.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            {m.error && <p className="text-xs text-[#F97066] m-0">{m.error}</p>}
            {tab === 'inbox' && (
              <>
                {dropsLine && (
                  <button
                    type="button"
                    onClick={() => setTab('quarantine')}
                    className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs"
                    style={{ background: '#2a1408', color: '#FEC84B' }}
                  >
                    <ShieldAlert size={14} className="shrink-0" />
                    <span className="flex-1">{dropsLine}</span>
                    <span className="font-semibold shrink-0">Open</span>
                  </button>
                )}
                {view('inbox').map((r, i, all) => (
                  <div key={r.id} className="flex flex-col gap-1">
                    {(i === 0 ? group(r) < 2 : group(all[i - 1]) !== group(r)) && (
                      <span
                        className="text-[10px] font-semibold uppercase tracking-wide px-1"
                        style={{ color: ['#F79009', '#6CE9A6', MUTED][group(r)] }}
                      >
                        {['Pinned', 'Friends', 'Everyone else'][group(r)]}
                      </span>
                    )}
                    {swipeMail(
                      r,
                      <MailRow
                        r={r}
                        rate={m.rate}
                        friend={isContact(r.from)}
                        label={nameOf(r.from)}
                        onOpen={() => setReading(r)}
                      />,
                    )}
                  </div>
                ))}
                {!view('inbox').length && !exInbox.filter((e) => !goneExamples.includes(e.id)).length && (
                  <div className="bw-mail-card flex flex-col items-center gap-3 px-6 py-8 text-center">
                    <Mailbox size={28} color={GOLD} />
                    <div className="text-sm font-bold text-white">
                      {m.loading ? 'Checking for mail…' : 'Your bMail inbox.'}
                    </div>
                    <div className="text-xs leading-relaxed" style={{ color: MUTED }}>
                      Mail to your $name arrives here. Senders pay a tiny stamp, so spam doesn't pay.
                    </div>
                    <div className="flex w-full max-w-xs flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        className={`${gold} flex-1`}
                        style={{ background: GOLD, color: '#1a1300' }}
                        onClick={() => setDraft({})}
                      >
                        Write a letter
                      </button>
                      <button type="button" className={`${btn} flex-1`} disabled={!myAddress} onClick={shareAddress}>
                        Share your address
                      </button>
                    </div>
                    {inlineUndo ? (
                      <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-white">
                        <span>{inlineUndo.text}</span>
                        <button
                          type="button"
                          className="min-h-[44px] px-2 font-bold"
                          style={{ color: GOLD }}
                          onClick={() => {
                            inlineUndo.undo();
                            setInlineUndo(null);
                          }}
                        >
                          Undo
                        </button>
                      </div>
                    ) : (
                      examplesOff && (
                        <button
                          type="button"
                          className="min-h-[44px] px-2 text-xs underline"
                          style={{ color: MUTED }}
                          onClick={showExamplesAgain}
                        >
                          Show examples again
                        </button>
                      )
                    )}
                  </div>
                )}
              </>
            )}
            {tab === 'requests' && (
              <>
                {dropsLine && (
                  <button
                    type="button"
                    onClick={() => setTab('quarantine')}
                    className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs"
                    style={{ background: '#2a1408', color: '#FEC84B' }}
                  >
                    <ShieldAlert size={14} className="shrink-0" />
                    <span className="flex-1">{dropsLine}</span>
                    <span className="font-semibold shrink-0">Open</span>
                  </button>
                )}
                {view('requests').map((r) => (
                  <div key={r.id} className="flex flex-col gap-1">
                    {swipeMail(
                      r,
                      <MailRow
                        r={r}
                        rate={m.rate}
                        friend={false}
                        label={nameOf(r.from)}
                        onOpen={() => setReading(r)}
                      />,
                    )}
                    {r.verifiedSats > 0 && (
                      <span className="text-[10px] px-2" style={{ color: MUTED }}>
                        Below your price to reach ({money(m.priceSats, m.rate)}): the sender can pay the difference.
                      </span>
                    )}
                  </div>
                ))}
                {!view('requests').length && !exRequests.filter((e) => !goneExamples.includes(e.id)).length && (
                  <Empty
                    title="Requests"
                    text="Unstamped mail and promotions wait here. Tokens and NFTs from senders you haven't accepted wait in Quarantine."
                  />
                )}
              </>
            )}
            {tab === 'sent' &&
              (m.state.sent.length ? (
                m.state.sent.map((s) => <SentRow key={s.id} s={s} rate={m.rate} />)
              ) : (
                <Empty
                  title="Nothing sent yet"
                  text="Write to a $handle or paymail. Your letter is sealed so only they can open it, and the stamp (1¢ by default) is paid to them from your wallet as you send."
                />
              ))}
            {tab === 'archive' &&
              (m.boxes.archive.length ? (
                m.boxes.archive.map((r) => (
                  <div key={r.id}>
                    {swipeMail(
                      r,
                      <MailRow
                        r={r}
                        rate={m.rate}
                        friend={isContact(r.from)}
                        label={nameOf(r.from)}
                        onOpen={() => setReading(r)}
                      />,
                      true,
                    )}
                  </div>
                ))
              ) : (
                <Empty
                  title="Archive is empty"
                  text="Swipe a letter left to archive it (or press e on a keyboard). Archived mail stays here, out of your Inbox, until you move it back."
                />
              ))}
            {(tab === 'inbox' || tab === 'requests') &&
              (tab === 'inbox' ? exInbox : exRequests).some((e) => !goneExamples.includes(e.id)) && (
                <>
                  <button
                    type="button"
                    onClick={hideExamples}
                    className="mt-2 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl text-sm font-bold text-white"
                    style={{ background: '#D92D20' }}
                  >
                    <Trash2 size={18} /> Delete all examples
                  </button>
                  <p className="m-0 px-1 text-[11px]" style={{ color: MUTED }}>
                    <span className="font-extrabold text-[#FDB022]">EXAMPLES</span> show what bMail looks like in use.
                    They are not real mail and no money or tokens arrived. Swipe one left to delete it.
                  </p>
                  {(tab === 'inbox' ? exInbox : exRequests)
                    .filter((e) => !goneExamples.includes(e.id))
                    .map((e, i) => {
                      // Examples swipe like real mail (same trays as mailActions) so the gesture can be tried before
                      // any real mail arrives. Archive / Delete / Quarantine hide that example (remembered per account).
                      const look: Record<string, { icon: ReactNode; color: string }> = {
                        reply: { icon: <Reply size={18} />, color: '#475467' },
                        archive: { icon: <Archive size={18} />, color: '#12B76A' },
                        delete: { icon: <Trash2 size={18} />, color: '#D92D20' },
                        read: { icon: <MailOpen size={18} />, color: '#2E90FA' },
                        pin: { icon: <Pin size={18} />, color: '#B54708' },
                        quarantine: { icon: <ShieldAlert size={18} />, color: '#7A2E0E' },
                      };
                      const toAction = (a: (typeof EXAMPLE_SWIPE.left)[number]): SwipeAction => ({
                        id: a.id,
                        label: a.label,
                        ...look[a.id],
                        removes: a.removes,
                        onPress: () =>
                          a.removes
                            ? deleteExample(
                                e.id,
                                a.id === 'delete' ? 'deleted' : a.id === 'quarantine' ? 'quarantined' : 'archived',
                              )
                            : setExample(e),
                      });
                      const row = (
                        <SwipeRow
                          key={e.id}
                          rowId={e.id}
                          label={`example mail from ${e.name}`}
                          leftActions={EXAMPLE_SWIPE.left.map(toAction)}
                          rightActions={EXAMPLE_SWIPE.right.map(toAction)}
                          fullSwipeLeft={EXAMPLE_SWIPE.fullLeft}
                          fullSwipeRight={EXAMPLE_SWIPE.fullRight}
                        >
                          <ExampleRow e={e} onOpen={() => setExample(e)} />
                        </SwipeRow>
                      );
                      return i === 0 && hint ? (
                        <SwipeHint
                          key={e.id}
                          onDone={() => {
                            markSwipeHintSeen();
                            setHint(false);
                          }}
                        >
                          {row}
                        </SwipeHint>
                      ) : (
                        row
                      );
                    })}
                </>
              )}
            {tab === 'quarantine' && (
              <>
                <p className="m-0 px-1 text-[11px] leading-relaxed" style={{ color: MUTED }}>
                  Mail you marked as spam or from senders you blocked, and tokens and NFTs from senders you have not
                  accepted. Mail stays sealed until you open it. Quarantined tokens are not in your balance and are
                  never spent with your own coins. Nothing here is burned or moved.
                </p>
                {quarantineIsEmpty(m.boxes.quarantine.length, drops.visible.length) && (
                  <Empty
                    title="Quarantine is empty"
                    text="Swipe a letter right and tap Quarantine (or use … › Spam or Block): that letter and their future mail land here, sealed. Tokens and NFTs from senders you haven't accepted wait here too, out of your balance."
                  />
                )}
                {m.boxes.quarantine.map((r) => (
                  <div key={r.id} className="flex flex-col gap-1">
                    <MailRow r={r} rate={m.rate} friend={false} label={nameOf(r.from)} onOpen={() => setReading(r)} />
                    <div className="flex gap-1.5 px-1">
                      <button
                        type="button"
                        className="min-h-[44px] rounded-lg px-3 text-xs font-semibold bg-[#2b2f36] text-white"
                        onClick={() => {
                          m.flag([r.id], { spam: false });
                          m.trust(r.from);
                        }}
                      >
                        Not spam: trust {nameOf(r.from)}
                      </button>
                      <button
                        type="button"
                        className="min-h-[44px] rounded-lg px-3 text-xs font-semibold bg-[#2b2f36] text-white"
                        onClick={() => remove([r.id])}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                <AirdropsList onLeave={onClose} />
              </>
            )}
            {tab === 'bin' &&
              (m.boxes.bin.length ? (
                m.boxes.bin.map((r) => (
                  <div key={r.id} className="flex flex-col gap-1">
                    <MailRow r={r} rate={m.rate} friend={false} label={nameOf(r.from)} onOpen={() => setReading(r)} />
                    <div className="flex items-center gap-2 px-1">
                      <button
                        type="button"
                        className="min-h-[44px] rounded-lg px-3 text-xs font-semibold"
                        style={{ background: GOLD, color: '#1a1300' }}
                        onClick={() => m.restore([r.id])}
                      >
                        Restore
                      </button>
                      <span className="text-[11px]" style={{ color: MUTED }}>
                        Erased from this device in {binDaysLeft(r)} days
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <Empty
                  title="Bin is empty"
                  text="Deleted mail waits here for 30 days so you can restore it, then its content is erased from this device. Postage you received stays yours."
                />
              ))}
          </>
        )}
      </div>
    </div>
  );
};

/**
 * An NFT that came with this letter (send to a public key). From a trusted sender it goes straight into
 * Wallet › NFTs; otherwise it waits in Quarantine (airdrops rules) until Keep. Nothing is spent either way.
 */
const ReceivedNft = ({ r, ordinal }: { r: Received; ordinal: SealedOrdinal }) => {
  const { chromeStorageService, apiContext } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const valid = deliveriesFor(ordinal, r.env.to, r.from).length > 0;
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'hidden'>(() =>
    receiptHidden(loadInbox(account), ordinal.txid) ? 'hidden' : 'idle',
  );
  const [err, setErr] = useState('');
  const accepted = receiptAccepted(loadInbox(account), ordinal.txid, r.from);
  const receive = async (keep: boolean) => {
    setState('busy');
    setErr('');
    try {
      if (keep) keepReceipt(account, ordinal.txid);
      await internalizeSealedOrdinal(apiContext.wallet as unknown as WalletInterface, ordinal, r.from, r.env.to, {
        getBeef: async (txid) => Array.from(await apiContext.services!.beef.getBeef(txid)),
      });
      setState('done');
      notifyMinted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState('idle');
    }
  };
  useEffect(() => {
    if (valid && accepted && state === 'idle' && !err) void receive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, accepted]);
  if (!valid)
    return <div className="text-[11px] text-[#F97066]">This letter mentions an NFT that isn&apos;t for you.</div>;
  if (state === 'hidden') return null;
  return (
    <div data-testid="received-nft" className="flex flex-col gap-2 rounded-lg border border-white/10 p-3">
      <div className="text-sm font-semibold text-white">{ordinal.name || 'An NFT'} came with this letter</div>
      {state === 'done' ? (
        <div className="text-xs text-[#A1FF8B]">It&apos;s in Wallet › NFTs.</div>
      ) : accepted ? (
        <div className="text-xs" style={{ color: MUTED }}>
          {state === 'busy' ? 'Adding it to your NFTs…' : 'Adding it to your NFTs.'}
        </div>
      ) : (
        <>
          <div className="text-xs" style={{ color: MUTED }}>
            In Quarantine: you haven&apos;t trusted this sender, so it stays out of your NFTs until you Keep it.
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={state === 'busy'}
              onClick={() => void receive(true)}
              className="min-h-[44px] flex-1 rounded-lg text-xs font-semibold text-black disabled:opacity-50"
              style={{ background: GOLD }}
            >
              {state === 'busy' ? 'Keeping…' : 'Keep'}
            </button>
            <button
              type="button"
              onClick={() => {
                hideReceipt(account, ordinal.txid);
                setState('hidden');
              }}
              className="min-h-[44px] flex-1 rounded-lg text-xs font-semibold bg-[#2b2f36] text-white"
            >
              Hide
            </button>
          </div>
        </>
      )}
      {err && <div className="text-[11px] text-[#F97066]">{err}</div>}
    </div>
  );
};
