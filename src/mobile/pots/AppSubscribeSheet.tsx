import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { siteName } from '../../services/approvalKind';
import type { AppSubscribeRequest } from './appSubscribe';
import { keyFingerprint } from './merchantSig';
import { isPayingPot, listPots } from './pots';
import { POT_NAME_PLACEHOLDER } from '../storeBuild';

/**
 * The ONE approval sheet for "Subscribe with bWalletX" (docs/SUBSCRIBE-API.md), in the approval-card style: dollars
 * a month as the hero, who it pays, which pot pays it, and one Subscribe button. Nothing is paid by this sheet; the
 * charger (payDue.ts) pays the first month from the chosen pot right after, through the pot's spend limits.
 *
 * Pot only, never the main balance (owner, 18 Oct 2026): with no pot the sheet offers to make one instead. Nothing is
 * pre-chosen for the user when there is more than one pot.
 *
 * Who is asking is the real origin the browser reported, never page text. The merchant name and key both come from
 * the page, so the name is shown as named by that origin and the key is never called "verified"; the sheet only says
 * whether it is the same key the user approved before for this exact origin, or warns when it changed (merchantSig.ts).
 */
export const AppSubscribeSheet = (p: {
  req: AppSubscribeRequest;
  onAnswer: (potId: string | null) => void;
  /** No pot yet: make one called `name` (the request is declined; the app asks again afterwards). */
  onCreatePot: (name: string) => void;
}) => {
  const pots = listPots().filter((pot) => isPayingPot(pot.identityAddress));
  const [potId, setPotId] = useState(pots.length === 1 ? pots[0].identityAddress : '');
  const [potName, setPotName] = useState('');
  const [details, setDetails] = useState(false);
  const site = siteName(p.req.appOrigin);
  const host = p.req.appOrigin.replace(/^https:\/\//, '');
  const trust = p.req.keyTrust;
  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      role="dialog"
      aria-modal="true"
    >
      <ApprovalCard
        site={site}
        siteSub="wants a monthly subscription"
        onClose={() => p.onAnswer(null)}
        hero={<PayHero amount={`$${p.req.usdPerMonth.toFixed(2)}`} sub="a month" badge="SUBSCRIBE" />}
        title={
          <>
            Subscribe to <span style={{ color: CARD.gold }}>{p.req.merchantName}</span>{' '}
            <span style={{ color: CARD.muted, fontSize: '0.7em' }} data-testid="app-subscribe-named-by">
              (as named by {host})
            </span>
          </>
        }
        primary={
          pots.length
            ? { label: 'Subscribe', onClick: () => p.onAnswer(potId), disabled: !potId }
            : { label: 'Make a pot', onClick: () => p.onCreatePot(potName.trim() || 'Subscriptions') }
        }
        secondary={{ label: 'Not now', onClick: () => p.onAnswer(null) }}
        detailsOpen={details}
        onToggleDetails={() => setDetails((d) => !d)}
        details={
          <div className="flex flex-col gap-1" style={{ fontSize: 13, color: CARD.muted }}>
            {p.req.description && <div>{p.req.description}</div>}
            <div>Pays: {p.req.payTo}</div>
            <div>Asked by: {p.req.appOrigin}</div>
            <div>
              Merchant key (supplied by {host}): {p.req.merchantKey}
            </div>
            <div>
              Charged once a month in BSV at that day&apos;s rate, when you open the wallet. A missed month is paid
              once, never stacked. Nothing is locked or paid ahead.
            </div>
          </div>
        }
        testId="app-subscribe-sheet"
      >
        <div style={{ fontSize: 15, color: CARD.ink }} data-testid="app-subscribe-origin">
          Asked by <strong>{host}</strong>
        </div>
        {trust === 'changed' && (
          <div
            role="alert"
            data-testid="app-subscribe-key-changed"
            className="rounded-xl px-3 py-2"
            style={{ background: CARD.redChip, color: CARD.redInk, border: `1px solid ${CARD.red}`, fontSize: 14 }}
          >
            Warning: {host} is using a different merchant key from the one you approved before. Only subscribe if you
            expected this.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {trust === 'same' ? (
            <Chip>Same merchant key as before · {keyFingerprint(p.req.merchantKey)}</Chip>
          ) : trust === 'new' ? (
            <Chip>New to you · key {keyFingerprint(p.req.merchantKey)}</Chip>
          ) : (
            <Chip>Key changed · {keyFingerprint(p.req.merchantKey)}</Chip>
          )}
          <Chip>First month today</Chip>
          <Chip>Cancel any time</Chip>
          <Chip>Paid in BSV</Chip>
        </div>
        {pots.length === 0 && (
          <div className="flex flex-col gap-2" style={{ fontSize: 14 }}>
            <span style={{ color: CARD.muted }}>
              Subscriptions pay only from a pot, never your main balance. Make one, add a little BSV, then subscribe
              again.
            </span>
            <input
              value={potName}
              onChange={(e) => setPotName(e.target.value)}
              placeholder={POT_NAME_PLACEHOLDER}
              maxLength={32}
              aria-label="New pot name"
              className="rounded-xl px-3 py-2"
              style={{ background: CARD.chip, color: CARD.ink, border: 0, fontSize: 14 }}
            />
          </div>
        )}
        {pots.length > 0 && (
          <label className="flex items-center gap-2" style={{ fontSize: 14 }}>
            <span style={{ color: CARD.muted }}>Pays from</span>
            <select
              value={potId}
              onChange={(e) => setPotId(e.target.value)}
              className="flex-1 rounded-xl px-3 py-2"
              style={{ background: CARD.chip, color: CARD.ink, border: 0, fontSize: 14 }}
              aria-label="Pot that pays"
            >
              {pots.length > 1 && (
                <option value="" disabled>
                  Choose a pot
                </option>
              )}
              {pots.map((pot) => (
                <option key={pot.identityAddress} value={pot.identityAddress}>
                  {pot.emoji ? `${pot.emoji} ` : ''}
                  {pot.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </ApprovalCard>
    </div>,
    document.body,
  );
};
