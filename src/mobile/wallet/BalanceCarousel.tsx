import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { BookUser, CalendarDays, PenLine, X } from 'lucide-react';
import { BCREDITS_ENABLED, BUY_CRYPTO_ENABLED, PLACEMENT_ENABLED, STORE_BUILD } from '../storeBuild';
import { PNEE_ICON, PNEE_TOKEN_ID } from '../notes/pnee';
import { requestWalletAction } from '../phone/walletAction';
import { MNEE_ICON_URL } from '../../utils/constants';
import { getListCoin, getWalletKind, setWalletKind, setWalletView, subscribeWalletKind } from './walletKind';
import { cardForView, filterForCard } from './cardFilter';
import {
  clearFocusedToken,
  getFocusedToken,
  registerFocusHost,
  subscribeFocusedToken,
  type FocusedToken,
} from './cardFocus';
import { CardBalance, CardSkin } from './CardSkin';
import { useCardBalance } from './balanceStore';
import {
  EMPTY_VALUE,
  cardValueText,
  creditsUsd,
  formatTokenAmount,
  hasNoPrice,
  sumHoldings,
  unpricedNote,
  useCardUnit,
  useHeldTokens,
  type CardValue,
} from './cardValue';
import { CardUnitSwitch } from './CardUnitSwitch';
import { useDisplayCurrency } from '../../hooks/useDisplayCurrency';
import { latestUsdPerGbp, type Fx } from '../../utils/displayCurrency';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';
import { useServiceContext } from '../../hooks/useServiceContext';
import { tokenTrades } from '../exchange/exchangeData';
import { useCardThemed } from './cardLook';
import { skinFor } from './cardSkins';
import { publishBalance } from './balanceStore';
import { useBshares } from '../placement/useBshares';
import { requestCreditsSheet } from '../credits/creditsNav';
import { BuyBsvSheet } from './BuyBsv';
import { holdersRoomsEnabled, openHoldersRoom, type HoldersCoin } from './holdersRoom';
import { routeFor } from '../tabs/tabs';
import { AddressBook } from './AddressBook';
import { allCardsSwipe, opensAddressBook } from './addressBookGesture';
import { BCal } from './BCal';
import { subscribeAllCards } from './allCardsOpen';
import './balanceCards.css';

/**
 * Balance cards: the wallet card as a swipe carousel, one card per kind of balance, always shown with its REAL
 * balance (0.00 included, from balanceStore, published by the screens that already read it). Every card but BSV
 * (which is the real WalletCard with its own pen) has the pen flip icon: the back says what the balance is and its
 * buttons open real screens (Send/Receive, Credits Top up/History, the bShares register, Tickets, Tokens, Buy BSV
 * where allowed). bCredits has "View contract" with the decided terms. No mock money: nothing here signs or spends.
 * Long-press opens All cards.
 */

const TICKETS_CARD_ENABLED = !STORE_BUILD;

const readMnee = (): number | null => {
  try {
    const raw = localStorage.getItem('bwallet:mnee-balance');
    if (raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
};

type BackButton = { label: string; run: () => void; primary?: boolean };
type CardDef = {
  id: string;
  title: string;
  /** Front line before a real balance is known: a 0.00 in the card's unit (or a label for Top up). */
  sub: string;
  /** Second front line (who issues it). */
  issuer: string;
  colour: string;
  logo: ReactNode;
  /** Back of the card: what the balance is for, in true words. */
  backLines: string[];
  /** Back buttons: each opens a real screen. */
  backButtons: BackButton[];
  /** "View contract" sheet (bCredits only, the decided terms). */
  agreement?: Agreement;
  /** A tapped token's card: its real balance, already formatted (instead of balanceStore). */
  amount?: string;
  /** A tapped token's card: its value (whole units at the last sale), for the fiat/BSV line. */
  value?: CardValue;
  /** A tapped token's card: its balance in its own units, for the line under the value. */
  units?: Units;
};

/** A balance in its own units: whole-unit amount, symbol and decimals ("1,000 SCAM" under the value). */
type Units = { qty: number; symbol: string; decimals: number };

/** Decimals each built-in card's own units show with (counts are whole; MNEE and PNEEs are cents). */
const UNIT_DECIMALS: Record<string, number> = { mnee: 2, pnee: 2 };
/** Unit names when a card has not published its balance yet. */
const UNIT_NAMES: Record<string, string> = {
  tokens: 'tokens',
  btickets: 'tickets',
  bshares: 'shares',
  bcredits: 'bCredits',
  mnee: 'MNEE',
  pnee: 'PNEEs',
};

/** Cards whose front is a balance (all but Top up): they show a fiat/BSV value and the shared switch. */
const VALUED = new Set(['tokens', 'btickets', 'bshares', 'bcredits', 'mnee', 'pnee']);

/** What the card fronts need to price a balance: BSV price, display currency, the Tokens card's sum. */
type ValueCtx = { rate: number; fx: Fx; tokens: CardValue | null };
const CardValueContext = createContext<ValueCtx>({ rate: 0, fx: { currency: 'USD', usdPerUnit: 1 }, tokens: null });

/**
 * A card's value from its real balance (balanceStore): MNEE and PNEEs are dollars, a bCredit is 1p, Tokens is the
 * sum of each held token at its last sale. Tickets and bShares have no price here, so they count as unpriced.
 */
const valueFor = (id: string, amount: number, tokens: CardValue | null): CardValue => {
  switch (id) {
    case 'mnee':
    case 'pnee':
      return { ...EMPTY_VALUE, usd: Math.max(0, amount) };
    case 'bcredits': {
      const usd = creditsUsd(amount, latestUsdPerGbp()?.rate ?? null);
      return usd === null ? { ...EMPTY_VALUE, unpriced: 1 } : { ...EMPTY_VALUE, usd };
    }
    case 'tokens':
      return tokens ?? EMPTY_VALUE;
    case 'btickets':
      return { ...EMPTY_VALUE, unpriced: Math.max(0, Math.round(amount)) };
    case 'bshares':
      return { ...EMPTY_VALUE, unpriced: amount > 0 ? 1 : 0 };
    default:
      return EMPTY_VALUE;
  }
};

/**
 * The value block, laid out exactly like the BSV card (WalletCard): the amount left-aligned on the middle row
 * (.bw-wcard-centre / .bw-wcard-usd, "N unpriced" in .bw-wcard-sats under it) and the fiat/BSV switch bottom-right
 * (.bw-wcard-bottom › .bw-wcard-addrline › .bw-wcard-unit).
 */
const CardValueFront = ({
  id,
  live,
  value,
  units,
}: {
  id: string;
  live: boolean;
  value?: CardValue;
  units?: Units;
}) => {
  const ctx = useContext(CardValueContext);
  const unit = useCardUnit();
  const bal = useCardBalance(id, live);
  const v = value ?? valueFor(id, bal?.amount ?? 0, ctx.tokens);
  const own = units ?? {
    qty: bal?.amount ?? 0,
    symbol: bal?.unit || UNIT_NAMES[id] || '',
    decimals: UNIT_DECIMALS[id] ?? 0,
  };
  const amountLine = formatTokenAmount(own.qty, own.symbol, own.decimals);
  // The rule (owner, 16 Oct 2026): big line = value ($ or BSV per the switch), the token amount always under it.
  // No price at all → the token amount is the big line and "No price yet" sits under it.
  const noPrice = hasNoPrice(v);
  const text = noPrice ? amountLine : cardValueText(v, unit, ctx.rate, ctx.fx);
  const note = noPrice ? '' : unpricedNote(v);
  return (
    <>
      <span className="bw-wcard-centre" style={{ position: 'relative' }}>
        <span className={`bw-wcard-usd${unit === 'bsv' && !noPrice ? ' is-bsv' : ''}`}>{text}</span>
        <span className="bw-wcard-sats bw-bc-units">{noPrice ? 'No price yet' : amountLine}</span>
        {note && <span className="bw-wcard-sats">{note}</span>}
      </span>
      <span className="bw-wcard-bottom" style={{ position: 'relative' }}>
        <span className="bw-wcard-bl">
          <span className="bw-wcard-addrline">
            <span className="bw-wcard-addrslot" />
            <CardUnitSwitch fx={ctx.fx} />
          </span>
        </span>
      </span>
    </>
  );
};

type Prices = Record<string, number | null | undefined>;

/** A tapped token row as a card: real balance and icon; the back's buttons are the row's existing actions. */
const tokenCard = (t: FocusedToken, prices: Prices): CardDef => ({
  id: `tok-${t.id}`,
  title: t.name,
  sub: t.amount,
  amount: t.amount,
  value: sumHoldings([{ amount: t.qty ?? 0, usdEach: t.id === PNEE_TOKEN_ID ? 1 : null, satsEach: prices[t.id] }]),
  units: { qty: t.qty ?? 0, symbol: t.symbol ?? t.name, decimals: t.decimals ?? 0 },
  issuer: 'BSV-21 token',
  colour: '#14161f',
  logo: <img src={t.icon} alt="" width={22} height={22} style={{ borderRadius: 11 }} />,
  backLines: ['A BSV-21 token held in this wallet’s keys.'],
  backButtons: [
    { label: 'Send', run: t.onSend, primary: true },
    ...(t.onReceive ? [{ label: 'Receive', run: t.onReceive }] : []),
    ...(t.onLock ? [{ label: 'Lock', run: t.onLock }] : []),
    ...(t.onRoom ? [{ label: 'Room', run: t.onRoom }] : []),
  ],
});

/*
 * Not here on purpose: Stop, running-contract lines, spent counters and a live tick-down. They need a running
 * contract on the server (bit-sign debiting a balance as it is used), which does not exist yet; they come with
 * the server debit. Until then a card shows only its real balance and opens real screens.
 */

const FlipBtn = ({ onFlip, back }: { onFlip: () => void; back: boolean }) => (
  <button
    type="button"
    className="bw-wcard-penflip"
    aria-label={back ? 'Flip card to the front' : 'Flip card'}
    title="Flip card"
    onClick={(e) => {
      e.stopPropagation();
      onFlip();
    }}
  >
    <PenLine size={20} aria-hidden="true" />
  </button>
);

const cardStyle = (c: CardDef) => {
  const ink = skinFor(c.id, c.colour).ink;
  return {
    position: 'relative' as const,
    width: '100%',
    overflow: 'hidden',
    background: c.colour,
    color: ink,
    border: 0,
    textAlign: 'left' as const,
    ['--bc-ink' as string]: ink,
  };
};

const CardHead = ({ c }: { c: CardDef }) => (
  <span className="bw-bc-top" style={{ position: 'relative' }}>
    <span className="bw-bc-logo">{c.logo}</span>
    <span className="bw-bc-head">
      <b>{c.title}</b>
      <small>{c.issuer}</small>
    </span>
  </span>
);

/**
 * A balance card's front, exactly as the carousel shows it. The All cards browser renders this same component, so
 * a card never loses its design (or its theme) there. `live` keeps the balance subscribed.
 */
const CardFront = ({ c, live = true, onFlip }: { c: CardDef; live?: boolean; onFlip?: () => void }) => (
  <>
    <CardSkin id={c.id} colour={c.colour} />
    {onFlip && <FlipBtn onFlip={onFlip} back={false} />}
    <CardHead c={c} />
    {c.value || (c.amount === undefined && VALUED.has(c.id)) ? (
      <CardValueFront id={c.id} live={live} value={c.value} units={c.units} />
    ) : (
      <span style={{ position: 'relative' }}>
        {c.amount !== undefined ? (
          <span className="bw-skin-bal bw-bc-amt">{c.amount}</span>
        ) : (
          <CardBalance id={c.id} live={live} fallback={c.sub} className="bw-skin-bal bw-bc-amt" />
        )}
      </span>
    )}
  </>
);

const FlipCard = ({ c }: { c: CardDef }) => {
  const [flipped, setFlipped] = useState(false);
  const [turning, setTurning] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const themed = useCardThemed(c.id);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const flip = () => {
    setTurning(true);
    timers.current.push(
      window.setTimeout(() => setFlipped((f) => !f), 220),
      window.setTimeout(() => setTurning(false), 440),
    );
  };
  const style = cardStyle(c);
  const theme = themed ? ' is-themed' : '';
  if (flipped)
    return (
      <div className={`bw-bc bw-bc-back${theme}${turning ? ' is-turning' : ''}`} style={style} onClick={flip}>
        <CardSkin id={c.id} colour={c.colour} />
        <FlipBtn onFlip={flip} back />
        <CardHead c={c} />
        <span className="bw-bc-terms" style={{ position: 'relative' }}>
          {c.backLines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
        <span className="bw-bc-actions" style={{ position: 'relative' }}>
          {c.backButtons.map((b) => (
            <button
              type="button"
              key={b.label}
              className={b.primary ? 'bw-bc-stop is-top' : 'bw-bc-contact'}
              onClick={(e) => {
                e.stopPropagation();
                b.run();
              }}
            >
              {b.label}
            </button>
          ))}
          {c.agreement && (
            <button
              type="button"
              className="bw-bc-contact"
              onClick={(e) => {
                e.stopPropagation();
                setSheetOpen(true);
              }}
            >
              View contract
            </button>
          )}
        </span>
        {sheetOpen && c.agreement && <AgreementSheet a={c.agreement} onClose={() => setSheetOpen(false)} />}
      </div>
    );
  return (
    <div
      className={`bw-bc${theme}${turning ? ' is-turning' : ''}`}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`${c.title}: flip for details`}
      onClick={flip}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && flip()}
    >
      <CardFront c={c} onFlip={flip} />
    </div>
  );
};

/** The All cards browser's copy of a card: the carousel's own front (same skin, theme, ink), not interactive. */
const StaticCard = ({ c, live }: { c: CardDef; live: boolean }) => {
  const themed = useCardThemed(c.id);
  return (
    <div className={`bw-bc${themed ? ' is-themed' : ''}`} style={cardStyle(c)}>
      <CardFront c={c} live={live} onFlip={() => undefined} />
    </div>
  );
};

/** The bCredits contract: the decided terms, as a one-page NDS instrument (bit-sign's signable HTML). */
type Agreement = { title: string; ref: string; file: string; issuer: string; clauses: [string, string][] };

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ndsHtml = (a: Agreement) => {
  const manifest = {
    nds: '1.0',
    documentTitle: a.title,
    documentRef: a.ref,
    canonical: { algo: 'sha-256', over: 'rendered-pdf' },
    resolution: 'dom-anchor',
    signatureFields: [
      { id: 'issuer', role: 'Issuer', name: a.issuer, party: 'issuer', required: true, order: 1 },
      { id: 'holder', role: 'Customer', name: 'You', party: 'customer', required: true, order: 2 },
    ],
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)}</title>
<script type="application/npg-sig-manifest+json">
${JSON.stringify(manifest, null, 2)}
</script>
<style>
body{margin:0;background:#0b0b0d;font-family:'Times New Roman',serif;font-size:16px;line-height:1.5;color:#111}
.sheet{background:#fff;margin:12px;padding:20px 18px;border-radius:6px;border-top:4px solid #ffd24d}
h1{font-size:21px;margin:0 0 4px}.ref{font-size:12px;color:#555;font-family:ui-monospace,Menlo,monospace}
.parties{border-top:1px solid #ccc;border-bottom:1px solid #ccc;padding:8px 0;margin:10px 0}
ol{padding-left:22px}li{margin-bottom:8px}
.execution{display:flex;flex-direction:column;gap:18px;margin-top:18px}
.sig-line{border-bottom:1px solid #000;min-height:56px}.sig-caption{font-size:13px;color:#333}
.note{font-size:12px;color:#555;margin-top:14px}
</style></head><body><div class="sheet">
<h1>${esc(a.title)}</h1><div class="ref">${esc(a.ref)}</div>
<div class="parties"><b>Between</b> ${esc(a.issuer)} (the issuer)<br><b>and</b> you, the holder of this wallet</div>
<ol>${a.clauses.map(([h, t]) => `<li><b>${esc(h)}.</b> ${esc(t)}</li>`).join('')}</ol>
<div class="execution">
<div class="sig-block"><div class="sig-line" data-sig-anchor="issuer"></div><div class="sig-caption">${esc(a.issuer)}</div></div>
<div class="sig-block"><div class="sig-line" data-sig-anchor="holder"></div><div class="sig-caption">You</div></div>
</div>
<div class="note">Unsigned. You accept these terms when you top up; the signature lines are for bit-sign.</div>
</div></body></html>`;
};

const AgreementSheet = ({ a, onClose }: { a: Agreement; onClose: () => void }) => {
  const html = ndsHtml(a);
  const save = () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = a.file;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
  };
  return (
    <Layer onClose={onClose}>
      <div className="bw-ag" onClick={(e) => e.stopPropagation()}>
        <iframe className="bw-ag-doc" title={a.title} sandbox="" srcDoc={html} />
        <div className="bw-ag-btns">
          <button type="button" onClick={save}>
            Save contract (.nds.html)
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Layer>
  );
};

/** The bCredits terms as decided (matches bit-sign creditsTerms() and CREDITS_TERMS_FALLBACK). */
const BCREDITS_AGREEMENT: Agreement = {
  title: 'bCredits contract',
  ref: 'BCORP-BCREDITS-1',
  file: 'bcredits-contract.nds.html',
  issuer: 'The Bitcoin Corporation Ltd',
  clauses: [
    ['Issuer', 'bCredits are issued by The Bitcoin Corporation Ltd.'],
    ['Price', '1 bCredit = 1p. You pay in BSV at the BSV/GBP rate when you top up.'],
    [
      'What they pay for',
      'bCredits are spent only on b, the bWalletX agent. Each b reply costs what it costs to run × 1.35, rounded up to whole bCredits. b never runs you into debt.',
    ],
    ['Today', 'Talking to b is free for now, so Ask b does not spend bCredits or BSV.'],
    ['Top-ups', 'Each top-up is up to £20.'],
    ['Expiry', 'bCredits do not expire.'],
    ['Refunds', 'bCredits are non-refundable except where the law requires.'],
    ['Transfers', 'bCredits cannot be cashed out, sent to anyone or spent anywhere else.'],
  ],
};

const Layer = ({ onClose, children, sheet = false }: { onClose: () => void; children: ReactNode; sheet?: boolean }) => {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = 'hidden';
    let popped = false;
    try {
      window.history.pushState({ bwCardLayer: true }, '');
    } catch {
      /* ignore */
    }
    const onPop = () => {
      popped = true;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      body.style.overflow = prev;
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      if (!popped && (window.history.state as { bwCardLayer?: boolean } | null)?.bwCardLayer) window.history.back();
    };
  }, []);
  const startY = useRef<number | null>(null);
  return createPortal(
    <div
      className={`bw-layer${sheet ? ' is-sheet' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onTouchStart={(e) => {
        const sc = (e.target as HTMLElement).closest('.bw-layer-scroll');
        const onTile = (e.target as HTMLElement).closest('.bw-eg-tile');
        startY.current = !onTile && (!sc || sc.scrollTop <= 0) ? e.touches[0].clientY : null;
      }}
      onTouchEnd={(e) => {
        if (startY.current !== null && e.changedTouches[0].clientY - startY.current > 120) onClose();
        startY.current = null;
      }}
    >
      {children}
    </div>,
    document.body,
  );
};

const reducedMotionTm = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
const TimeMachine = ({
  cards,
  bsvCard,
  start,
  onPick,
  onClose,
  onBook,
  onCalendar,
}: {
  cards: CardDef[];
  /** The carousel's own BSV card (the real WalletCard with the user's design), shown as is. */
  bsvCard: ReactNode;
  start: number;
  onPick: (i: number) => void;
  onClose: () => void;
  onBook: () => void;
  onCalendar: () => void;
}) => {
  const [focus, setFocus] = useState(start);
  const [reduced] = useState(reducedMotionTm);
  const t0 = useRef<{ x: number; y: number; f: number } | null>(null);
  const clamp = (f: number) => Math.max(0, Math.min(cards.length - 1, f));
  return (
    <Layer onClose={onClose}>
      <div
        className={`bw-tm${reduced ? ' is-flat' : ''}`}
        onWheel={(e) => setFocus((f) => clamp(f + e.deltaY / 240))}
        onTouchStart={(e) => (t0.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, f: focus })}
        onTouchMove={(e) => {
          if (!t0.current || reduced) return;
          const dx = e.touches[0].clientX - t0.current.x;
          const dy = t0.current.y - e.touches[0].clientY;
          if (Math.abs(dx) > Math.abs(dy)) return;
          setFocus(clamp(t0.current.f + dy / 120));
        }}
        onTouchEnd={(e) => {
          const s0 = t0.current;
          t0.current = null;
          if (!reduced) setFocus((f) => Math.round(f));
          if (!s0) return;
          const t = e.changedTouches[0];
          const go = allCardsSwipe({ dx: t.clientX - s0.x, dy: t.clientY - s0.y });
          if (go === 'book') onBook();
          else if (go === 'calendar') onCalendar();
        }}
      >
        <div className="bw-tm-stars" />
        <div className="bw-tm-head">
          <b>All cards</b>
        </div>
        <div className="bw-tm-stage">
          {cards.map((c, i) => {
            const o = i - focus;
            const style = reduced
              ? undefined
              : {
                  transform: `translate(-50%, -50%) translate3d(0, ${-o * 46}px, ${-o * 260}px) scale(${o < 0 ? 1 - o * 0.25 : 1})`,
                  opacity: o < -0.9 ? 0 : Math.max(0, 1 - o * 0.16),
                  zIndex: 1000 - Math.round(o * 10),
                  pointerEvents: (o < -0.5 ? 'none' : 'auto') as 'none' | 'auto',
                  filter: o > 0.5 ? `brightness(${Math.max(0.45, 1 - o * 0.1)})` : undefined,
                };
            const pick = () => (reduced || Math.abs(o) < 0.5 ? onPick(i) : setFocus(i));
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                aria-label={c.title}
                className="bw-tm-card"
                style={style}
                onClick={pick}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && pick()}
              >
                <div className="bw-tm-inner">
                  {c.id === 'bsv' ? bsvCard : <StaticCard c={c} live={Math.abs(o) < 2.5} />}
                </div>
              </div>
            );
          })}
        </div>
        {/* Visible doors (owner, 15 Oct 2026): Address book on the left (a right pull opens it), bCal on the right
            (a left swipe), so the buttons teach the swipe directions. Theme tokens only. */}
        <div className="bw-tm-doors">
          <button type="button" onClick={onBook}>
            <BookUser size={16} aria-hidden="true" />
            <span>Address book</span>
          </button>
          {/* Close sits between the doors in the theme's own colours (owner, 17 Oct 2026). */}
          <button type="button" onClick={onClose}>
            <X size={16} aria-hidden="true" />
            <span>Close</span>
          </button>
          <button type="button" onClick={onCalendar}>
            <CalendarDays size={16} aria-hidden="true" />
            <span>Calendar</span>
          </button>
        </div>
        <p className="bw-tm-hint">
          Swipe up and down to fly through · tap a card to land on it · swipe sideways for Friends or bCal
        </p>
      </div>
    </Layer>
  );
};

export const BalanceCarousel = ({ bsvCard }: { bsvCard: ReactNode }) => {
  const navigate = useNavigate();
  const [active, setActive] = useState(0);
  const [tm, setTm] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  // Address book (owner, 15 Oct 2026): pull right past the first card, or the notebook button.
  const [book, setBook] = useState(false);
  // bCal (owner, 15 Oct 2026): the All cards browser's other sideways swipe.
  const [cal, setCal] = useState(false);
  const pull0 = useRef<{ x: number; y: number; left: number } | null>(null);
  const [mnee, setMnee] = useState<number | null>(readMnee);
  const track = useRef<HTMLDivElement>(null);
  const shares = useBshares();

  // Card values (owner, 15 Oct 2026): the BSV price and Settings › Currency the BSV card uses, and each held
  // token's last sale on the 1Sat market (exchangeData.ts) for the Tokens card's sum. No price → unpriced.
  const fx = useDisplayCurrency();
  const { apiContext } = useServiceContext();
  const [rate, setRate] = useState(cachedExchangeRate);
  useEffect(() => {
    if (!apiContext) return;
    let on = true;
    void fetchExchangeRate(apiContext.chain, apiContext.wocApiKey)
      .then((r) => on && r > 0 && setRate(r))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [apiContext]);
  const held = useHeldTokens();
  const focusedNow = useSyncExternalStore(subscribeFocusedToken, getFocusedToken, getFocusedToken);
  const [prices, setPrices] = useState<Prices>({});
  const priceIds = [...(held ?? []).map((h) => h.id), ...(focusedNow ? [focusedNow.id] : [])]
    .filter((id) => id !== PNEE_TOKEN_ID)
    .join(',');
  useEffect(() => {
    if (!priceIds) return;
    let on = true;
    for (const id of priceIds.split(',')) {
      void tokenTrades(id, 1).then((t) => {
        const last = t[t.length - 1]?.satsPerToken;
        if (on) setPrices((p) => (id in p ? p : { ...p, [id]: last && last > 0 ? last : null }));
      });
    }
    return () => {
      on = false;
    };
  }, [priceIds]);
  const tokensValue = useMemo(
    () =>
      held
        ? sumHoldings(
            held.map((h) => ({
              amount: h.amount,
              usdEach: h.id === PNEE_TOKEN_ID ? 1 : null,
              satsEach: prices[h.id],
            })),
          )
        : null,
    [held, prices],
  );
  const valueCtx = useMemo(() => ({ rate, fx, tokens: tokensValue }), [rate, fx, tokensValue]);

  // MNEE: the wallet's real balance (BsvWallet shares the last fetch), read only.
  useEffect(() => {
    const read = () => {
      const v = readMnee();
      setMnee(v);
      if (v !== null) publishBalance('mnee', v, 'MNEE');
    };
    read();
    window.addEventListener('bwallet:mnee-balance', read);
    return () => window.removeEventListener('bwallet:mnee-balance', read);
  }, []);

  // bShares: the register's real count (0 for a non-member), once bit-sign has answered.
  useEffect(() => {
    if (!PLACEMENT_ENABLED || shares.loading || shares.error) return;
    publishBalance(
      'bshares',
      (shares.me?.holdings ?? []).reduce((n, h) => n + h.shares, 0),
      'shares',
    );
  }, [shares.loading, shares.error, shares.me]);

  // Every kind of balance always has its card (owner, 15 Oct 2026), showing the real balance (0.00 included). Tap or
  // the pen flips it; the back says what it is and its buttons open the real screens. Nothing here signs or spends.
  const showTokens = () => setWalletKind('tokens');
  // MNEE / PNEEs holders' rooms (bWalletX; a store build has no token rooms).
  const holdersBtn = (coin: HoldersCoin): BackButton[] =>
    holdersRoomsEnabled()
      ? [{ label: 'Holders room', run: () => openHoldersRoom(coin, () => navigate(routeFor('chat') ?? '/m/chat')) }]
      : [];
  const cards: CardDef[] = [
    {
      id: 'bsv',
      title: 'BSV',
      sub: '0.00 BSV',
      issuer: 'Your wallet',
      colour: '#16161a',
      logo: '₿',
      backLines: [],
      backButtons: [],
    },
    {
      id: 'tokens',
      title: 'Tokens',
      sub: '0.00 tokens',
      issuer: 'BSV-21 tokens in this wallet',
      colour: '#14161f',
      logo: '◎',
      backLines: [
        'The BSV-21 tokens this wallet holds, counted from the chain.',
        'Send, receive or open each one from the Tokens list.',
      ],
      backButtons: [{ label: 'Open tokens', run: showTokens, primary: true }],
    },
  ];
  if (TICKETS_CARD_ENABLED)
    cards.push({
      id: 'btickets',
      title: 'bTickets',
      sub: '0.00 tickets',
      issuer: 'Tokens that open rooms',
      colour: '#1f1414',
      logo: '✦',
      backLines: [
        'Tokens you hold that get you into a room: a Space, a chat or a show.',
        'Holding the token is the ticket. Open the room from My tickets.',
      ],
      backButtons: [{ label: 'My tickets', run: () => setWalletKind('tickets'), primary: true }],
    });
  if (PLACEMENT_ENABLED)
    cards.push({
      id: 'bshares',
      title: 'bShares',
      sub: '0.00 shares',
      issuer: 'Share registers for any company',
      colour: '#23200f',
      logo: '§',
      backLines: shares.me
        ? [
            `Your shares in ${shares.me.company.name}, as recorded on its Register of Members (bit-sign).`,
            'Restricted: not offered publicly.',
          ]
        : [
            'Share registers for any company: register of members, director approvals, locked shares.',
            'You are not on a register yet.',
          ],
      backButtons: shares.me ? [{ label: 'Open register', run: () => navigate('/m/bshares'), primary: true }] : [],
    });
  if (BCREDITS_ENABLED)
    cards.push({
      id: 'bcredits',
      title: 'Credits',
      sub: '0.00 bCredits',
      issuer: 'bCredits — pay for b · The Bitcoin Corporation Ltd',
      colour: '#1a1608',
      logo: '¢',
      backLines: [
        'Credits: one card for every credit type. bCredits — pay for b: prepay for b, the bWalletX agent. 1 bCredit = 1p.',
        'Each b reply costs what it costs to run × 1.35. Top-ups up to £20. No expiry.',
      ],
      backButtons: [
        {
          label: 'Top up',
          primary: true,
          run: () => {
            setWalletKind('credits');
            requestCreditsSheet('topup');
          },
        },
        {
          label: 'History',
          run: () => {
            setWalletKind('credits');
            requestCreditsSheet('history');
          },
        },
      ],
      agreement: BCREDITS_AGREEMENT,
    });
  cards.push(
    {
      id: 'mnee',
      title: 'MNEE',
      sub: `${(mnee ?? 0).toFixed(2)} MNEE`,
      issuer: 'USD stablecoin on BSV · issued by MNEE',
      colour: '#0f2a1f',
      logo: <img src={MNEE_ICON_URL} alt="" width={22} height={22} style={{ borderRadius: 11 }} />,
      backLines: ['A US dollar stablecoin on BSV: 1 MNEE is meant to be worth $1.', 'Held in this wallet’s keys.'],
      backButtons: [
        { label: 'Send', run: () => requestWalletAction('send'), primary: true },
        { label: 'Receive', run: () => requestWalletAction('receive') },
        ...holdersBtn('mnee'),
      ],
    },
    {
      id: 'pnee',
      title: 'PNEEs',
      sub: '0.00 PNEEs',
      issuer: 'Penny Notes · BSV-21',
      colour: '#1d1430',
      logo: <img src={PNEE_ICON} alt="" width={22} height={22} style={{ borderRadius: 11 }} />,
      backLines: ['Penny Notes: a BSV-21 token counted in US cents.', 'Held in this wallet’s keys.'],
      backButtons: [
        { label: 'Send', run: () => requestWalletAction('send'), primary: true },
        { label: 'Receive', run: () => requestWalletAction('receive') },
        ...holdersBtn('pnee'),
      ],
    },
    {
      id: 'topup',
      title: 'Top up',
      sub: 'Add BSV to your wallet',
      issuer: 'Fund this wallet',
      colour: '#2a2208',
      logo: '+',
      backLines: BUY_CRYPTO_ENABLED
        ? ['Receive BSV from another wallet or an exchange, or buy some with a card.']
        : ['Receive BSV from another wallet or an exchange.'],
      backButtons: [
        { label: 'Receive', run: () => requestWalletAction('receive'), primary: true },
        ...(BUY_CRYPTO_ENABLED ? [{ label: 'Buy BSV', run: () => setBuyOpen(true) }] : []),
      ],
    },
  );

  // Card ⇄ list sync (owner, 15 Oct 2026). A swipe that settles on a card shows that card's list (cardFilter.ts);
  // a chip (or any other view change) scrolls to the matching card. `pending` is a scroll we started: its
  // in-between cards never touch the list.
  const ids = cards.map((c) => c.id);
  const idsKey = ids.join(',');
  const activeRef = useRef(0);
  const pending = useRef<number | null>(null);
  const settle = useRef<number | null>(null);
  const goTo = useCallback((i: number) => {
    const el = track.current;
    if (!el || i < 0) return;
    pending.current = i;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  }, []);
  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    activeRef.current = i;
    setActive(i);
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      settle.current = null;
      const at = activeRef.current;
      if (pending.current !== null) {
        if (pending.current === at) pending.current = null;
        return;
      }
      const id = ids[at];
      if (!id) return;
      const f = filterForCard(id);
      setWalletView(f.kind, f.coin);
    }, 140);
  };
  useEffect(
    () => () => {
      if (settle.current !== null) window.clearTimeout(settle.current);
    },
    [],
  );
  const kind = useSyncExternalStore(subscribeWalletKind, getWalletKind, getWalletKind);
  const coin = useSyncExternalStore(subscribeWalletKind, getListCoin, getListCoin);
  useEffect(() => {
    const list = idsKey.split(',');
    const at = pending.current ?? activeRef.current;
    const i = cardForView({ kind, coin }, list, list[at]);
    if (i !== null && i !== at) goTo(i);
  }, [kind, coin, idsKey, goTo]);

  // Tap a token row: it becomes the front card until × or a swipe (cardFocus.ts).
  useEffect(() => registerFocusHost(), []);
  const focused = useSyncExternalStore(subscribeFocusedToken, getFocusedToken, getFocusedToken);
  const swipe0 = useRef<{ x: number; y: number } | null>(null);
  const press = useRef<number | null>(null);
  const startPress = () => {
    press.current = window.setTimeout(() => setTm(true), 600);
  };
  const endPress = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };
  useEffect(() => () => endPress(), []);
  // The Wallet's "All cards" button (BuyBsv.tsx) opens the browser too; the long-press stays.
  useEffect(() => subscribeAllCards(() => setTm(true)), []);

  return (
    <CardValueContext.Provider value={valueCtx}>
      <div className="bw-bcar">
        <div className="bw-bcar-stage">
          <div
            ref={track}
            className="bw-bcar-track"
            style={focused ? { visibility: 'hidden' } : undefined}
            onScroll={onScroll}
            onTouchStart={(e) => {
              pull0.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, left: e.currentTarget.scrollLeft };
              startPress();
            }}
            onTouchEnd={(e) => {
              endPress();
              const p = pull0.current;
              pull0.current = null;
              if (!p || focused) return;
              const t = e.changedTouches[0];
              if (opensAddressBook(p.left, { dx: t.clientX - p.x, dy: t.clientY - p.y })) setBook(true);
            }}
            onTouchMove={endPress}
            onContextMenu={(e) => {
              e.preventDefault();
              setTm(true);
            }}
          >
            {cards.map((c) => (
              <div className="bw-bcar-slide" key={c.id}>
                {c.id === 'bsv' ? (
                  <div className="bw-bcar-bsv">{bsvCard}</div>
                ) : (
                  <div className="bw-bcar-wrap">
                    <FlipCard c={c} />
                  </div>
                )}
              </div>
            ))}
          </div>
          {focused && (
            <div
              className="bw-bcar-focus"
              onTouchStart={(e) => (swipe0.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
              onTouchEnd={(e) => {
                const s0 = swipe0.current;
                swipe0.current = null;
                if (!s0) return;
                const dx = e.changedTouches[0].clientX - s0.x;
                const dy = e.changedTouches[0].clientY - s0.y;
                if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) clearFocusedToken();
              }}
            >
              <div className="bw-bcar-wrap">
                <FlipCard key={focused.id} c={tokenCard(focused, prices)} />
              </div>
              <button
                type="button"
                className="bw-bcar-unfocus"
                aria-label="Back to your cards"
                onClick={clearFocusedToken}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
        <div style={{ position: 'relative', minHeight: 26 }}>
          {cards.length > 1 && (
            <div className="bw-bcar-dots" aria-label={`Card ${active + 1} of ${cards.length}`}>
              {cards.map((c, i) => (
                <button
                  type="button"
                  key={c.id}
                  aria-label={c.title}
                  className={i === active ? 'is-on' : ''}
                  onClick={() => goTo(i)}
                />
              ))}
            </div>
          )}
        </div>
        {book && <AddressBook onClose={() => setBook(false)} />}
        {cal && <BCal onClose={() => setCal(false)} />}
        {BUY_CRYPTO_ENABLED && buyOpen && (
          <BuyBsvSheet
            onClose={() => setBuyOpen(false)}
            onReceive={() => {
              setBuyOpen(false);
              requestWalletAction('receive');
            }}
          />
        )}
        {tm && (
          <TimeMachine
            cards={cards}
            bsvCard={bsvCard}
            start={active}
            onBook={() => {
              setTm(false);
              setBook(true);
            }}
            onCalendar={() => {
              setTm(false);
              setCal(true);
            }}
            onClose={() => setTm(false)}
            onPick={(i) => {
              setTm(false);
              window.setTimeout(() => goTo(i), 60);
            }}
          />
        )}
      </div>
    </CardValueContext.Provider>
  );
};
