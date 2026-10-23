import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackClose } from '../backStack';
import { parseUsdInput } from '../money/money';
import { POT_NAME_PLACEHOLDER, SUBSCRIPTIONS_ENABLED } from '../storeBuild';
import { ownServicePayees, addSubscription, subProblem, usdToPnee, type NewSub, type Period } from './pots';
import { reschedulePotReminders } from './notifyPots';
import { clearSubscribeRequest, requestLabel, type SubscribeRequest } from './subscribeLink';
import { ErrorActions } from '../errors/ErrorActions';
import { resolvePayee } from './potSend';
import { keyFingerprint, type PayeeDestination } from './payeeBinding';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = '#17191E';
const input = 'rounded-lg px-3 py-2 text-sm text-white outline-none border w-full';
const field = { background: 'var(--bw-bg)', borderColor: LINE };

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[420] flex items-end" style={{ background: '#000a' }} onClick={onClose}>
      <div
        className="w-full rounded-t-2xl p-4 flex flex-col gap-3 max-h-[90vh] overflow-y-auto"
        style={{ background: CARD, paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-bold text-white">{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

/** Pots › New pot: a name, then Add account makes the pot's own account (fresh keys). */
export const CreatePotSheet = ({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) => {
  const [name, setName] = useState('');
  return (
    <Sheet title="New pot" onClose={onClose}>
      <p className="text-xs m-0" style={{ color: MUTED }}>
        A pot is a separate account with its own keys. Subscriptions pay from it, and whatever you put in it is the most
        they can ever take. Pause or empty it any time.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={POT_NAME_PLACEHOLDER}
        maxLength={32}
        className={input}
        style={field}
      />
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => onCreate(name.trim())}
        className="rounded-xl py-3 font-bold border-0"
        style={{ background: GOLD, color: '#000', opacity: name.trim() ? 1 : 0.5 }}
      >
        Create pot
      </button>
    </Sheet>
  );
};

const PERIODS: [Exclude<Period, object>, string][] = [
  ['week', 'Weekly'],
  ['month', 'Monthly'],
  ['year', 'Yearly'],
  ['day', 'Daily'],
];

const today = () => new Date().toISOString().slice(0, 10);

/** A standing order on a pot: to a person / paymail everywhere, or to one of our services in bWalletX. */
export const AddOrderSheet = ({
  potId,
  potName,
  balanceUsd,
  bsvUsd,
  onClose,
  request,
  unit = 'BSV',
}: {
  potId: string;
  potName: string;
  balanceUsd: number | null;
  bsvUsd: number;
  /** What the pot pays in: a PNEE pot's orders are kept in PNEEs (cents), so $5 is 500 PNEEs. */
  unit?: 'BSV' | 'PNEE';
  onClose: () => void;
  /** A subscribe link from one of our services (subscribeLink.ts): prefills service, amount, period, memo. */
  request?: SubscribeRequest | null;
}) => {
  const req = SUBSCRIPTIONS_ENABLED ? (request ?? null) : null;
  const [service, setService] = useState(req?.service ?? '');
  const [to, setTo] = useState('');
  const [label, setLabel] = useState('');
  const [usd, setUsd] = useState(req ? String(req.usd) : '');
  const [period, setPeriod] = useState<Exclude<Period, object>>(req?.period ?? 'month');
  const [start, setStart] = useState(today());
  const [max, setMax] = useState('');
  const [error, setError] = useState('');
  /** The paymail as resolved and verified for the confirm card: what gets pinned on the order. */
  const [checked, setChecked] = useState<(PayeeDestination & { forTo: string }) | null>(null);
  const [checking, setChecking] = useState(false);

  const servicePayees = ownServicePayees();
  const svc = servicePayees.find((p) => p.service === service);
  const recipient = to.trim();
  const payee = svc
    ? { name: svc.name, service: svc.service }
    : {
        name: label.trim() || recipient,
        ...(recipient.includes('@') || recipient.startsWith('$')
          ? {
              paymail: recipient,
              ...(checked?.forTo === recipient && checked.pubkey ? { pinnedKey: checked.pubkey } : {}),
            }
          : { address: recipient }),
      };
  const needsCheck = 'paymail' in payee && !!payee.paymail && checked?.forTo !== recipient;
  const amount = parseUsdInput(usd);
  const startAt = Date.parse(`${start}T12:00:00Z`);
  const n: NewSub = {
    potId,
    payee,
    amount:
      unit === 'PNEE' ? { value: usdToPnee(amount ?? 0), currency: 'PNEE' } : { value: amount ?? 0, currency: 'USD' },
    period,
    start: startAt,
    maxCount: max.trim() ? Number(max) : null,
    ...(req && svc && req.service === svc.service ? { memo: req.memo } : {}),
  };

  const save = async () => {
    const p = subProblem(n);
    if (p) return setError(p);
    if (needsCheck) {
      // Resolve and verify the paymail now, show who it is, and pin that key on Set up.
      setChecking(true);
      setError('');
      try {
        setChecked({ ...(await resolvePayee(n.payee, { ignorePin: true })), forTo: recipient });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setChecking(false);
      }
      return;
    }
    try {
      addSubscription(n, bsvUsd);
      void reschedulePotReminders();
      if (req) {
        clearSubscribeRequest();
        if (req.returnUrl) window.open(req.returnUrl, '_blank', 'noopener');
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet title={`Subscription from ${potName}`} onClose={onClose}>
      {req && (
        <p className="text-xs m-0" style={{ color: MUTED }}>
          {requestLabel(req)} asked for this subscription. Check the amount, then Set up. Nothing is paid until you do.
        </p>
      )}
      {SUBSCRIPTIONS_ENABLED && servicePayees.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {[{ service: '', name: 'A person' }, ...servicePayees].map((p) => (
            <button
              key={p.service || 'person'}
              type="button"
              onClick={() => setService(p.service)}
              className="rounded-full px-3 py-1.5 text-xs font-bold border-0"
              style={{
                background: service === p.service ? GOLD : LINE,
                color: service === p.service ? '#000' : '#fff',
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      {!svc && (
        <>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Paymail or address"
            className={input}
            style={field}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name (optional)"
            maxLength={32}
            className={input}
            style={field}
          />
        </>
      )}
      <input
        value={usd}
        onChange={(e) => setUsd(e.target.value)}
        placeholder="Amount in $"
        inputMode="decimal"
        className={input}
        style={field}
      />
      <div className="flex gap-2 flex-wrap">
        {PERIODS.map(([p, l]) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className="rounded-full px-3 py-1.5 text-xs font-bold border-0"
            style={{ background: period === p ? GOLD : LINE, color: period === p ? '#000' : '#fff' }}
          >
            {l}
          </button>
        ))}
      </div>
      <label className="text-xs flex flex-col gap-1" style={{ color: MUTED }}>
        First payment
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={input} style={field} />
      </label>
      <input
        value={max}
        onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))}
        placeholder="Number of payments (blank = until stopped)"
        inputMode="numeric"
        className={input}
        style={field}
      />
      <p className="text-xs m-0" style={{ color: MUTED }}>
        Paid when you open the app on or after each date. At most{' '}
        {balanceUsd !== null ? `$${balanceUsd.toFixed(2)}` : 'the pot balance'} can ever be taken: the pot balance.
        Pause or cancel any time.
      </p>
      {!svc && checked?.forTo === recipient && (
        <div
          className="rounded-lg p-2 text-xs flex flex-col gap-0.5"
          style={{ background: LINE }}
          data-testid="payee-check"
        >
          <div className="text-white">Pays {recipient}</div>
          <div style={{ color: MUTED }}>To address {checked.address}</div>
          <div style={{ color: MUTED }}>
            {checked.pubkey
              ? `Wallet key ${keyFingerprint(checked.pubkey)}. If this paymail ever points elsewhere, payments stop until you confirm.`
              : 'This paymail shows no wallet key, so a change of wallet can’t be detected.'}
          </div>
        </div>
      )}
      {error && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs" style={{ color: '#FDA29B' }}>
            {error}
          </div>
          <ErrorActions message={String(error)} />
        </div>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={checking}
        className="rounded-xl py-3 font-bold border-0"
        style={{ background: GOLD, color: '#000' }}
      >
        {checking ? 'Checking…' : needsCheck ? 'Check payee' : 'Set up'}
      </button>
    </Sheet>
  );
};
