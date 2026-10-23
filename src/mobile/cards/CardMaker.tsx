import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import CardGenerating from './CardGenerating';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { useServiceContext } from '../../hooks/useServiceContext';
import {
  cardFile,
  cardTitle,
  CardError,
  COMING_SOON,
  finishInFlight,
  generateOnce,
  getPrice,
  getQuote,
  limitsFrom,
  MAX_PROMPT,
  OCCASIONS,
  payCardQuote,
  recipientHandle,
  type CardPayment,
  type CardPrice,
  type CardQuote,
  type CardResult,
  clearInFlight,
  inFlightDone,
  loadInFlight,
  saveInFlight,
  type MakeKind,
  type Occasion,
  priceFor,
} from './api';
import { SPICY_ENABLED } from '../storeBuild';
import { isWebApp } from '../webApp';
import {
  adultConfirmedThisSession,
  adultOptIn,
  adultSettingShown,
  confirmAdultThisSession,
  setAdultOptIn,
  spicyAvailable,
} from './spicy';

/**
 * Mint › Greeting card (bwalletx.com/happy-b). Make it: occasion, who it's for, a prompt, the price from /price shown
 * before anything is paid. Pay: ONE approval sheet with the server's amount and address, then /generate with the
 * txid. Mint it: the image goes to the normal Picture mint (onMint), title prefilled. bWalletX only (lazy chunk
 * behind GREETING_CARDS_ENABLED). With no card service (503) it says "Cards are coming soon" and offers nothing to pay.
 */

const f: typeof fetch = (u, i) => fetch(u, i);
const GOLD = '#F5C542';
const BORDER = 'rgba(255,255,255,0.12)';

type State =
  | { k: 'form' }
  | { k: 'quoting' }
  | { k: 'ready'; quote: CardQuote }
  | { k: 'paying'; quote: CardQuote }
  | { k: 'making'; pay: CardPayment; at: number }
  | { k: 'made'; pay: CardPayment; card: CardResult; at: number }
  | { k: 'failed'; pay: CardPayment; msg: string; canRetry: boolean }
  | { k: 'error'; msg: string; quote?: CardQuote };

const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(2).replace(/\.00$/, '')}`;

export default function CardMaker({
  onBack,
  onMint,
}: {
  onBack: () => void;
  /** Hand the card to the Picture mint (the user pays the normal mint fee there). */
  onMint: (file: File, title: string, to: string) => void;
}) {
  const { apiContext } = useServiceContext();
  const [price, setPrice] = useState<CardPrice | null>(null);
  const [closed, setClosed] = useState(false);
  const [priceErr, setPriceErr] = useState('');
  const [make_, setMake] = useState<MakeKind>('card');
  const [model, setModel] = useState('');
  const [spicy, setSpicy] = useState(false);
  const [adultOk, setAdultOk] = useState(() => SPICY_ENABLED && adultConfirmedThisSession());
  const [optIn, setOptIn] = useState(() => SPICY_ENABLED && adultOptIn());
  const [revealed, setRevealed] = useState(false);
  const web = isWebApp();
  const [inFlight, setInFlight] = useState(() => loadInFlight());
  const [occasion, setOccasion] = useState<Occasion | ''>('Birthday');
  const [to, setTo] = useState('');
  const [prompt, setPrompt] = useState('');
  const [st, setSt] = useState<State>({ k: 'form' });
  const [retries, setRetries] = useState(1);
  const [handing, setHanding] = useState(false);
  const [details, setDetails] = useState(false);

  useEffect(() => {
    getPrice(f)
      .then((p) => {
        setPrice(p);
        setModel(p.models?.[0]?.id ?? '');
      })
      .catch((e) => {
        if (e instanceof CardError && e.code === 'unavailable') setClosed(true);
        else setPriceErr(e instanceof Error ? e.message : "Couldn't get the price");
      });
  }, []);

  const chosen = price?.models?.find((m) => m.id === model);
  const canSpicy = SPICY_ENABLED && spicyAvailable(chosen, { web, optIn });
  const wantSpicy = canSpicy && spicy && adultOk;
  const kind = price ? (price.kinds.find((k) => k.id === make_) ?? price.kinds[0]) : undefined;
  const shownSats = price ? priceFor(price, make_, model || undefined) : undefined;
  // USD only for the kind's own price (display only; sats are what is paid).
  const shownUsd = kind && shownSats === kind.sats ? usd(kind.usd) : '';
  const canAsk = !!price && !closed && prompt.trim().length > 0 && (st.k === 'form' || st.k === 'error');

  const ask = async () => {
    if (!price) return;
    setSt({ k: 'quoting' });
    try {
      const quote = await getQuote(f, {
        prompt,
        kind: make_,
        model: model || undefined,
        occasion,
        to,
        spicy: wantSpicy,
      });
      setSt({ k: 'ready', quote });
    } catch (e) {
      if (e instanceof CardError && e.code === 'unavailable') {
        setClosed(true);
        return setSt({ k: 'form' });
      }
      setSt({ k: 'error', msg: e instanceof Error ? e.message : 'Something went wrong' });
    }
  };

  /** `resume`: "Finish your card" for an earlier payment, which may still be unsent in this wallet. */
  const make = async (pay: CardPayment, left: number, resume = false) => {
    const at = Date.now();
    setSt({ k: 'making', pay, at });
    const r = resume ? await finishInFlight(f, apiContext.wallet, pay, left) : await generateOnce(f, pay, left);
    if (inFlightDone(r)) {
      clearInFlight();
      setInFlight(null);
    }
    if (r.ok) return setSt({ k: 'made', pay, card: r.card, at });
    const msg =
      r.error instanceof CardError && r.error.code === 'refund_needed'
        ? `${r.error.message} Reference: ${pay.quoteId}`
        : r.error.message;
    setSt({ k: 'failed', pay, msg, canRetry: r.canRetry });
  };

  const confirmPay = async () => {
    if (st.k !== 'ready' || !price) return;
    const { quote } = st;
    setSt({ k: 'paying', quote });
    let pay: CardPayment;
    try {
      pay = await payCardQuote(apiContext, quote, limitsFrom(price));
    } catch (e) {
      return setSt({ k: 'error', msg: e instanceof Error ? e.message : 'Payment failed', quote });
    }
    saveInFlight(pay);
    setRetries(1);
    setRevealed(false);
    await make(pay, 1);
  };

  const retry = () => {
    if (st.k !== 'failed' || !st.canRetry || retries < 1) return;
    setRetries(0);
    void make(st.pay, 0);
  };

  const mintIt = async () => {
    if (st.k !== 'made') return;
    setHanding(true);
    const title = make_ === 'card' ? cardTitle(occasion, to) : prompt.trim().slice(0, 60) || 'My picture';
    try {
      onMint(await cardFile(f, st.card, title), title, make_ === 'card' ? recipientHandle(to) : '');
    } catch (e) {
      setPriceErr(e instanceof Error ? e.message : "Couldn't download the card");
    } finally {
      setHanding(false);
    }
  };

  // ONE approval sheet: amount and address straight from the quote, one Pay button.
  if (st.k === 'ready' || st.k === 'paying' || (st.k === 'error' && st.quote)) {
    const quote = st.quote!;
    const busy = st.k === 'paying';
    const dollars = kind && kind.sats === quote.sats ? usd(kind.usd) : `${quote.sats.toLocaleString()} sats`;
    const what = make_ === 'card' ? 'card' : 'picture';
    return createPortal(
      <div
        className="fixed inset-0 z-[1110] flex flex-col"
        data-testid="card-pay-sheet"
        style={{
          background: CARD.bg,
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <ApprovalCard
          ours
          site="bWalletX"
          siteSub={make_ === 'card' ? 'Greeting card' : 'AI picture'}
          onClose={() => setSt({ k: 'form' })}
          closeLabel="Close"
          closeDisabled={busy}
          hero={<PayHero amount={dollars} sub={`${quote.sats.toLocaleString()} sats`} />}
          title={<>Pay for your {what}</>}
          primary={{
            label: busy ? 'Paying…' : `Pay ${dollars}`,
            onClick: () => void confirmPay(),
            disabled: busy,
            busy,
          }}
          secondary={{ label: 'Not now', onClick: () => setSt({ k: 'form' }), disabled: busy }}
          details={
            <span>
              {quote.sats.toLocaleString()} sats to {quote.payTo} for one AI {what}
              {chosen ? ` (${chosen.label})` : ''}. The price holds until{' '}
              {new Date(quote.expiresAt).toLocaleTimeString()}. If the card fails to come out you get one free retry;
              minting it afterwards costs the normal network fee.
            </span>
          }
          detailsOpen={details}
          onToggleDetails={() => setDetails(!details)}
          error={st.k === 'error' ? st.msg : undefined}
        >
          <div className="flex flex-col" style={{ gap: 8 }}>
            <div style={{ fontSize: 13, color: CARD.soft }}>
              To <span style={{ fontFamily: 'monospace', color: '#fff', wordBreak: 'break-all' }}>{quote.payTo}</span>
            </div>
            <div className="flex flex-wrap" style={{ gap: 8 }}>
              <Chip>{make_ === 'card' ? occasion || 'Card' : 'Picture'}</Chip>
              {chosen && <Chip>{chosen.label}</Chip>}
              <Chip>Paid in BSV</Chip>
            </div>
          </div>
        </ApprovalCard>
      </div>,
      document.body,
    );
  }

  const chip = (on: boolean) => ({
    borderColor: on ? GOLD : BORDER,
    background: on ? GOLD : 'transparent',
    color: on ? '#1a1400' : '#ccc',
  });
  const input = 'w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent';

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="card-maker">
      <button
        type="button"
        onClick={onBack}
        className="self-start flex items-center gap-1 bg-transparent border-0 cursor-pointer text-xs"
        style={{ color: '#aaa' }}
      >
        <ArrowLeft size={14} /> Back
      </button>
      <p className="m-0 font-bold" style={{ color: GOLD }}>
        Make it. Mint it. Send it. Wear it.
      </p>

      {closed ? (
        <div className="rounded-xl border p-3" style={{ borderColor: GOLD }}>
          <b>{COMING_SOON}.</b> Nothing to pay yet.
        </div>
      ) : st.k === 'made' || st.k === 'making' || st.k === 'failed' ? (
        <div className="flex flex-col gap-3">
          {(st.k === 'making' || st.k === 'made') && (
            <CardGenerating
              key={st.at}
              startedAt={st.at}
              imageUrl={st.k === 'made' ? st.card.imageUrl : undefined}
              alt={make_ === 'card' ? cardTitle(occasion, to) : 'Your picture'}
              blurred={st.k === 'made' && SPICY_ENABLED && !!st.card.spicy && !revealed}
            >
              {st.k === 'made' && SPICY_ENABLED && st.card.spicy && (
                <>
                  <span
                    className="absolute top-2 left-2 rounded-full px-2 py-0.5 text-[11px] font-bold"
                    style={{ background: '#b91c1c', color: '#fff' }}
                  >
                    18+
                  </span>
                  {!revealed && (
                    <button
                      type="button"
                      onClick={() => setRevealed(true)}
                      className="absolute inset-0 bg-transparent border-0 cursor-pointer text-sm font-bold"
                      style={{ color: '#fff' }}
                    >
                      18+ · Tap to reveal
                    </button>
                  )}
                </>
              )}
            </CardGenerating>
          )}
          {st.k === 'made' && (
            <>
              <button
                type="button"
                disabled={handing}
                onClick={() => void mintIt()}
                className="h-11 rounded-xl font-bold border-0 cursor-pointer disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #FFE27A, #E0A800)', color: '#1a1400' }}
              >
                {handing ? 'Getting it ready…' : 'Mint it'}
              </button>
              <p className="text-xs m-0" style={{ color: '#999' }}>
                Mint it: a 1-sat NFT in your wallet, in your name, for the normal network fee.
                {make_ === 'card' ? ' Then you can send it to their $name.' : ''}
              </p>
            </>
          )}
          {st.k === 'failed' && (
            <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: '#2A1414', color: '#fca5a5' }}>
              <span>{st.msg}</span>
              {st.canRetry && (
                <button
                  type="button"
                  onClick={retry}
                  className="self-start flex items-center gap-1 rounded-lg px-3 py-2 text-xs font-bold border-0 cursor-pointer"
                  style={{ background: GOLD, color: '#1a1400' }}
                >
                  <RotateCcw size={14} /> Try again (free)
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {inFlight && (
            <div className="rounded-xl border p-3 flex flex-col gap-2" style={{ borderColor: GOLD }}>
              <span>You paid for a card that hasn&apos;t come out yet.</span>
              <button
                type="button"
                onClick={() => {
                  setRetries(1);
                  void make({ quoteId: inFlight.quoteId, txid: inFlight.txid }, 1, true);
                }}
                className="self-start rounded-lg px-3 py-2 text-xs font-bold border-0 cursor-pointer"
                style={{ background: GOLD, color: '#1a1400' }}
              >
                Finish your card
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-1 rounded-xl p-1 border" style={{ borderColor: BORDER }} role="tablist">
            {(
              [
                ['card', 'Greeting card'],
                ['image', 'Any picture'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={make_ === id}
                onClick={() => setMake(id)}
                className="rounded-lg py-2 text-xs font-bold border-0 cursor-pointer"
                style={
                  make_ === id ? { background: GOLD, color: '#1a1400' } : { background: 'transparent', color: '#ccc' }
                }
              >
                {label}
              </button>
            ))}
          </div>
          {make_ === 'card' && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Occasion">
              {OCCASIONS.map((o) => (
                <button
                  key={o}
                  type="button"
                  aria-pressed={occasion === o}
                  onClick={() => setOccasion(occasion === o ? '' : o)}
                  className="rounded-full border px-3 py-1.5 text-xs font-bold cursor-pointer"
                  style={chip(occasion === o)}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          {make_ === 'card' && (
            <input
              className={input}
              style={{ borderColor: BORDER, color: '#fff' }}
              placeholder="Who's it for? (a name or $name)"
              aria-label="Who's it for?"
              value={to}
              maxLength={60}
              onChange={(e) => setTo(e.target.value)}
            />
          )}
          <textarea
            className={input}
            style={{ borderColor: BORDER, color: '#fff' }}
            placeholder="What should it show? A cat in a party hat on a gold beach…"
            aria-label="What should the card show?"
            rows={3}
            value={prompt}
            maxLength={MAX_PROMPT}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="text-xs" style={{ color: '#999' }}>
            {prompt.length}/{MAX_PROMPT}
          </div>
          {!!price?.models?.length && (
            <label className="flex flex-col gap-1 text-xs" style={{ color: '#bbb' }}>
              Model
              <select
                className={input}
                style={{ borderColor: BORDER, color: '#fff', background: '#111' }}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setSpicy(false);
                }}
              >
                {price.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.sats.toLocaleString()} sats
                  </option>
                ))}
              </select>
            </label>
          )}
          {canSpicy && (
            <div className="flex flex-col gap-2 rounded-xl border p-3" style={{ borderColor: BORDER }}>
              <label className="flex items-center gap-2 text-xs" style={{ color: '#ddd' }}>
                <input
                  type="checkbox"
                  checked={spicy}
                  disabled={!adultOk}
                  onChange={(e) => setSpicy(e.target.checked)}
                />
                Spicy (18+)
              </label>
              {!adultOk && (
                <button
                  type="button"
                  onClick={() => {
                    confirmAdultThisSession();
                    setAdultOk(true);
                  }}
                  className="self-start rounded-lg px-3 py-1.5 text-xs font-bold border cursor-pointer bg-transparent"
                  style={{ borderColor: BORDER, color: '#ddd' }}
                >
                  I&apos;m 18 or over
                </button>
              )}
            </div>
          )}
          {shownSats ? (
            <p className="m-0 text-xs" style={{ color: '#ccc' }}>
              Price: <b style={{ color: GOLD }}>{shownUsd || `${shownSats.toLocaleString()} sats`}</b>
              {shownUsd ? ` (${shownSats.toLocaleString()} sats)` : ''}, plus the network fee to mint it.
            </p>
          ) : (
            !priceErr && (
              <p className="m-0 text-xs" style={{ color: '#999' }}>
                Getting the price…
              </p>
            )
          )}
          {st.k === 'error' && <p style={{ color: '#ff6b6b' }}>{st.msg}</p>}
          <button
            type="button"
            disabled={!canAsk}
            onClick={() => void ask()}
            className="h-11 rounded-xl font-bold border-0 cursor-pointer disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, #FFE27A, #E0A800)', color: '#1a1400' }}
          >
            {st.k === 'quoting' ? 'Checking…' : 'Make it'}
          </button>
        </>
      )}
      {priceErr && <p style={{ color: '#ff6b6b' }}>{priceErr}</p>}
      {SPICY_ENABLED && adultSettingShown({ web }) && st.k === 'form' && (
        <label className="flex items-center gap-2 text-[11px]" style={{ color: '#777' }}>
          <input
            type="checkbox"
            checked={optIn}
            onChange={(e) => {
              setAdultOptIn(e.target.checked);
              setOptIn(e.target.checked);
              if (!e.target.checked) setSpicy(false);
            }}
          />
          Show 18+ options (this browser)
        </label>
      )}
    </div>
  );
}
