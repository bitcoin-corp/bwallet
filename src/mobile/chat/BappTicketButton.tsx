/**
 * "Enter · 1p" on a bApp room card (bappRooms.ts), and its ONE approval sheet (one-sheet-permissions,
 * OG-card style). bWalletX only: loaded lazily behind BSPACES_ENABLED, so a store build carries none of it.
 *
 *  - The bApp's token is launched + indexed with curve sales open → buy ONE curve listing (~1¢) with
 *    buyBsv21, report it (Supporter #n); holding the token is membership.
 *  - Otherwise → a 1¢ door fee straight to the room's payee, then bit-sign verifies it and seats you.
 *  - A room that is free to walk into (bRadio Lounge today) just joins.
 *
 * Words: "ticket" and "member", never investment wording.
 */
import { useEffect, useState } from 'react';
import { buyBsv21 } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getErrorMessage } from '../../utils/tools';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { MintHero } from '../../components/approval/ApprovalHeroes';
import { CARD } from '../../components/approval/cardTheme';
import { celebrateSend } from '../../components/sent/sent';
import { useBackClose } from '../backStack';
import { loadSession } from './api';
import type { Bapp } from './bappRooms';
import { checkTicket, fetchTicketCard, recordTicket, ticketLabel, ticketRequests, type TicketCard } from './bappTicket';
import { fetchQuote, pickCurveListing, recordPurchase, supporterBadge, centsLabel } from '../exchange/curveSales';
import { roomMarket, clearMarketCache, type Listing } from '../market/indexer';
import { marketFeeOptions } from '../market/fee';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../market/walletOutpoint';
import { assertOrdLockV2 } from '../market/ordlockVersion';
import { purchaseError } from '../exchange/purchase';
import { FullSheet } from './FullSheet';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Sheet =
  | { kind: 'door'; usd: number; sats: number; payee: string }
  | { kind: 'curve'; cents: number; supporter: number | null; listing: Listing };

export const BappTicketButton = ({
  bapp,
  me,
  member,
  onEnter,
  onJoinFree,
}: {
  bapp: Bapp;
  /** My bChatX handle (null = signed out: the card still shows, the button asks to sign in). */
  me: string | null;
  member: boolean;
  /** Open the room (I'm in now). */
  onEnter: () => void;
  /** Walk into a free room. */
  onJoinFree: () => Promise<void>;
}) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [card, setCard] = useState<TicketCard | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useBackClose(!!sheet, () => !busy && setSheet(null));

  useEffect(() => {
    let live = true;
    fetchTicketCard(bapp.ticker, loadSession()?.token ?? null)
      .then((c) => live && setCard(c))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bapp.ticker, me]);

  const isIn = member || !!card?.member;
  const members = card?.room.members;

  const start = async () => {
    setError('');
    if (isIn) return onEnter();
    if (!me) return addSnackbar('Sign in to chat first', 'info');
    setBusy('…');
    try {
      if (card?.room.open_join) {
        await onJoinFree();
        return;
      }
      // A launched bApp token: buy one curve listing.
      if (bapp.tokenId) {
        const q = await fetchQuote(bapp.tokenId).catch(() => null);
        if (q && !q.ok && q.reason === 'already_bought') return onEnter();
        if (q?.ok) {
          const m = await roomMarket({ kind: 'bsv21', id: bapp.tokenId, key: `bsv21:${bapp.tokenId}` }, 50).catch(
            () => null,
          );
          const l = pickCurveListing(q.listings, m?.listings ?? []);
          if (l)
            return setSheet({ kind: 'curve', cents: q.price_usd_cents * q.pack, supporter: q.supporter, listing: l });
        }
      }
      // The door fee.
      const fresh = await fetchTicketCard(bapp.ticker, loadSession()?.token ?? null);
      setCard(fresh);
      if (fresh?.member) return onEnter();
      const c = checkTicket(fresh, bapp.ticker, me);
      if (!c.ok) throw new Error(c.why);
      setSheet({ kind: 'door', usd: c.usd, sats: c.pay.sats, payee: fresh?.ticket?.payee ?? '' });
    } catch (e) {
      addSnackbar(errText(e), 'error');
    } finally {
      setBusy('');
    }
  };

  const payDoor = async () => {
    if (!me) return;
    setBusy('Paying…');
    setError('');
    try {
      // Re-read and re-check right before paying: the quote is never older than this tap.
      const fresh = await fetchTicketCard(bapp.ticker, loadSession()?.token ?? null);
      const c = checkTicket(fresh, bapp.ticker, me);
      if (!c.ok) throw new Error(c.why);
      const res = await sendBsv.execute(apiContext, { requests: ticketRequests(c.pay) });
      if (!res.txid || res.error) throw new Error(getErrorMessage(res.error) || 'Payment failed');
      setBusy('Getting your ticket…');
      const rec = await recordTicket(bapp.ticker, res.txid, loadSession()?.token ?? null);
      if (!rec.ok)
        throw new Error(
          `Paid, but the ticket isn’t recorded yet: ${rec.error ?? ''} Tap Allow again later; the same payment counts.`,
        );
      setSheet(null);
      celebrateSend(res.txid, {
        amount: { kind: 'token', display: ticketLabel(c.usd).replace('Enter · ', ''), ticker: '' },
        recipients: [bapp.name],
        title: 'You’re in!',
      });
      addSnackbar(`You’re a member of ${card?.room.name ?? bapp.name}`, 'success');
      onEnter();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const buyCurve = async (l: Listing) => {
    if (!bapp.tokenId) return;
    setBusy('Buying…');
    setError('');
    try {
      const outpoint = walletOutpoint(l.outpoint);
      await assertOrdLockV2(outpoint);
      const res = await buyBsv21.execute(purchaseContext(apiContext, outpoint), {
        tokenId: bapp.tokenId,
        outpoint,
        amount: l.amount ?? '0',
        ...marketFeeOptions(),
        ...MODULE_FINISHES,
      });
      if (!res.txid || res.error) throw new Error(purchaseError(res.error));
      clearMarketCache();
      const rec = await recordPurchase(bapp.tokenId, res.txid);
      const badge = supporterBadge(rec?.supporter);
      setSheet(null);
      addSnackbar(`You’re a member of ${bapp.name}${badge ? ` · ${badge}` : ''}`, 'success');
      onEnter();
    } catch (e) {
      setError(purchaseError(e));
    } finally {
      setBusy('');
    }
  };

  const label = isIn ? 'Open' : card?.room.open_join ? 'Join' : ticketLabel(card?.ticket?.usd ?? 0.01);

  return (
    <>
      <div className="flex items-center gap-2 shrink-0">
        {typeof members === 'number' && (
          <span className="text-[11px] hidden sm:inline" style={{ color: MUTED }}>
            {members} member{members === 1 ? '' : 's'}
          </span>
        )}
        <button
          type="button"
          data-testid={`bapp-enter-${bapp.id}`}
          onClick={(e) => (e.stopPropagation(), void start())}
          disabled={!!busy && !sheet}
          className="rounded-xl px-3 py-1.5 text-xs font-extrabold border-0 cursor-pointer disabled:opacity-50 whitespace-nowrap"
          style={
            isIn
              ? { background: 'transparent', color: GOLD, border: `1px solid ${GOLD}` }
              : { background: GOLD, color: '#1a1300' }
          }
        >
          {busy && !sheet ? '…' : label}
        </button>
      </div>
      {sheet && (
        <FullSheet>
          <ApprovalCard
            ours
            site="bWalletX"
            siteSub={`${bapp.name} room`}
            onClose={() => !busy && setSheet(null)}
            closeDisabled={!!busy}
            hero={
              <MintHero
                image={bapp.icon ?? undefined}
                alt={bapp.name}
                number={
                  sheet.kind === 'door' ? ticketLabel(sheet.usd).replace('Enter · ', '') : centsLabel(sheet.cents)
                }
                badge="TICKET"
              />
            }
            title={
              <>
                Enter <span style={{ color: CARD.gold }}>{card?.room.name ?? bapp.name}</span>
              </>
            }
            primary={{
              label: busy || 'Allow',
              onClick: () => void (sheet.kind === 'door' ? payDoor() : buyCurve(sheet.listing)),
              busy: !!busy,
              disabled: !!busy,
            }}
            secondary={{ label: 'Not now', onClick: () => setSheet(null), disabled: !!busy }}
            error={error || undefined}
            details={
              <div className="text-[12px] break-all" style={{ color: CARD.soft }}>
                {sheet.kind === 'door' ? (
                  <>
                    <div>Ticket: {sheet.sats.toLocaleString('en-US')} sats, paid once</div>
                    <div>To: {sheet.payee || bapp.name}</div>
                  </>
                ) : (
                  <>
                    <div>
                      One ${bapp.ticker} from {bapp.name}’s own supply ({sheet.listing.label})
                    </div>
                    <div>Holding it is your membership</div>
                  </>
                )}
                <div className="mt-1">{bapp.purpose}</div>
              </div>
            }
          >
            <div className="flex flex-wrap gap-2">
              <Chip>One-off ticket</Chip>
              <Chip>You become a member</Chip>
              {sheet.kind === 'curve' && sheet.supporter ? <Chip>{supporterBadge(sheet.supporter)}</Chip> : null}
              <Chip>Plus a tiny network fee</Chip>
            </div>
          </ApprovalCard>
        </FullSheet>
      )}
    </>
  );
};

export default BappTicketButton;
