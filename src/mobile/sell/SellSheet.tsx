import { IssuerBadge } from '../issuer/IssuerBadge';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tag, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { fetchExchangeRate } from '../../utils/wallet';
import { createListing, overlayFeePerOutput } from './sellActions';
import {
  DEFAULT_FEE_PER_OUTPUT,
  buildListingScript,
  fromRaw,
  indexingFeeSats,
  listingTxBytes,
  networkFeeSats,
  perTokenSats,
  toRaw,
  totalPriceSats,
  validateSell,
} from './sell';
import { fmtSats, hasRate, money, satsNote } from '../money/money';
import { checkListable, type CustodyVerdict } from './custodyGuard';
import { curvePriceUsd, tokenCurve, type TokenCurve } from '../market/tokenPage';
import { usd as usdLabel } from '../../lib/curves';
import { FUND_FEE_RATE, fetchFund, fundFeeSats, hasFundFee, type Fund } from '../p2p/fundFee';

const GOLD = 'var(--bw-accent-hi)';
const BG = '#17191E';
const LINE = '#2b2f36';
// Any valid addresses: only used to size the listing script for the fee estimate.
const SIZE_ADDR = '1BitcoinEaterAddressDontSendf59kuE';

export type SellTarget = {
  tokenId: string;
  symbol: string;
  dec: number;
  heldRaw: bigint;
  isTicket?: boolean;
  /** The launch curve when the caller already has it (Mint); otherwise read from the deploy tx. */
  curve?: TokenCurve;
  /** The room this token unlocks, if any: warn when the listing would leave you holding none. */
  room?: string;
};

const ERR: Record<string, string> = {
  quantity: 'Enter how many to sell',
  'over-balance': "That's more than you hold",
  price: 'Enter a price (at least 1 sat in total)',
};

/** Bottom sheet: list some of a BSV-21 token (a ticket, a $NAME token, any token) for sale. */
export const SellSheet = ({
  target,
  onClose,
  onListed,
}: {
  target: SellTarget;
  onClose: () => void;
  onListed?: (amountRaw: bigint) => void;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [qty, setQty] = useState(
    target.heldRaw === 1n * 10n ** BigInt(target.dec) ? fromRaw(target.heldRaw, target.dec) : '',
  );
  const [price, setPrice] = useState('');
  const [rate, setRate] = useState(0);
  const [fpo, setFpo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [curve, setCurve] = useState<TokenCurve | undefined>(target.curve);
  const [custody, setCustody] = useState<CustodyVerdict | null>(null);
  const [lots, setLots] = useState('1');
  // Reward tokens: buyers pay a 5% indexing fee to the token's index fund (fundFee.ts). Unreachable = no listing.
  const fundFee = hasFundFee(target.tokenId);
  const [fund, setFund] = useState<Fund | null | undefined>(undefined);
  useEffect(() => {
    if (fundFee) void fetchFund(target.tokenId).then(setFund);
  }, [fundFee, target.tokenId]);
  useBackClose(!busy, onClose);

  useEffect(() => {
    void fetchExchangeRate(apiContext.chain, apiContext.wocApiKey).then(setRate);
    void overlayFeePerOutput(apiContext, target.tokenId).then(setFpo);
    if (target.curve === undefined) void tokenCurve(target.tokenId).then(setCurve);
    // Never list tokens this wallet holds for someone else (custodyGuard.ts).
    void checkListable(apiContext.wallet, target.tokenId).then(setCustody);
  }, [apiContext, target.tokenId, target.curve]);
  const curveNow = curve ? curvePriceUsd(curve.curve, null) : null;

  const unit = target.isTicket ? 'ticket' : `$${target.symbol}`;
  const qtyRaw = toRaw(qty, target.dec);
  // USD-first: the price field is dollars and cents when the rate is known, sats otherwise.
  const usdMode = hasRate(rate);
  const perToken = perTokenSats(price, rate);
  // The field's unit flips if the rate arrives after typing: clear it rather than reinterpret it.
  useEffect(() => setPrice(''), [usdMode]);
  // "Sell in lots": BSV-21 listings are all-or-nothing, so split into N equal listings.
  const n = Math.max(1, Math.min(20, Math.floor(Number(lots) || 1)));
  const lotRaw = qtyRaw && qtyRaw % BigInt(n) === 0n ? qtyRaw / BigInt(n) : null;
  const lotsError = !!qtyRaw && n > 1 && !lotRaw;
  const lotPrice = lotRaw ? totalPriceSats(lotRaw, target.dec, perToken) : 0;
  const total = lotPrice * n;
  const error = qty || price ? validateSell(qtyRaw, target.heldRaw, total) : null;
  const perOut = fpo ?? DEFAULT_FEE_PER_OUTPUT;
  const indexing = qtyRaw ? indexingFeeSats(qtyRaw, target.heldRaw, perOut) + (n - 1) * perOut : 0;
  const losesRoom = !!target.room && !!qtyRaw && qtyRaw >= target.heldRaw;
  const network = useMemo(() => {
    if (!qtyRaw || total < 1) return 0;
    const len = buildListingScript(target.tokenId, qtyRaw, SIZE_ADDR, SIZE_ADDR, total).toBinary().length;
    return networkFeeSats(listingTxBytes(2, len, qtyRaw < target.heldRaw), chromeStorageService.getCustomFeeRate());
  }, [qtyRaw, total, target.tokenId, target.heldRaw, chromeStorageService]);
  const ready =
    !!qtyRaw &&
    !!lotRaw &&
    lotPrice >= 1 &&
    !validateSell(qtyRaw, target.heldRaw, total) &&
    custody?.ok === true &&
    (!fundFee || !!fund);

  const confirm = async () => {
    if (!ready || !qtyRaw || !lotRaw) return;
    setBusy(true);
    try {
      await createListing(apiContext, {
        tokenId: target.tokenId,
        symbol: target.symbol,
        dec: target.dec,
        amount: lotRaw,
        priceSats: lotPrice,
        maxOverlayFee: indexing,
        lots: n,
      });
      addSnackbar(`Listed ${qty} ${unit} for ${money(total, rate)}${usdMode ? ` (${fmtSats(total)})` : ''}`, 'success');
      onListed?.(qtyRaw);
      onClose();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Listing failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, value: string, sub = '') => (
    <div className="flex justify-between text-sm">
      <span className="text-[#98A2B3]">{label}</span>
      <span className="text-white text-right">
        {value}
        {sub && <span className="block text-[11px] text-[#667085]">{sub}</span>}
      </span>
    </div>
  );

  const input =
    'w-full h-11 rounded-xl px-3 text-base text-white outline-none border bg-[#0F1013] focus:border-[color:var(--bw-accent-hi)]';

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-end bg-black/60" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-label={`Sell ${unit}`}
        className="w-full rounded-t-2xl px-5 pt-5 flex flex-col gap-3 border-t"
        style={{ background: BG, borderColor: LINE, paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-base font-bold text-white">
            <Tag size={16} color={GOLD} /> Sell {target.isTicket ? 'tickets' : `$${target.symbol}`}
          </div>
          <button aria-label="Close" onClick={onClose} disabled={busy} className="p-1">
            <X size={18} color="#98A2B3" />
          </button>
        </div>
        <IssuerBadge tokenId={target.tokenId} />

        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-xs text-[#98A2B3]">
            <span>Quantity</span>
            <button
              type="button"
              className="font-bold"
              style={{ color: GOLD }}
              onClick={() => setQty(fromRaw(target.heldRaw, target.dec))}
            >
              Max {fromRaw(target.heldRaw, target.dec)}
            </button>
          </span>
          <input
            inputMode={target.dec > 0 ? 'decimal' : 'numeric'}
            value={qty}
            onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setQty(e.target.value)}
            placeholder="1"
            className={input}
            style={{ borderColor: LINE }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-[#98A2B3]">
            Price per {target.isTicket ? 'ticket' : 'token'} {usdMode ? '(US$)' : '(sats — USD price unavailable)'}
          </span>
          <div className="relative">
            {usdMode && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-base text-[#98A2B3]">$</span>}
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) =>
                (usdMode ? /^\d*(\.\d{0,2})?$/ : /^\d*\.?\d*$/).test(e.target.value) && setPrice(e.target.value)
              }
              placeholder={usdMode ? '1.00' : '1000'}
              className={input}
              style={{ borderColor: LINE, paddingLeft: usdMode ? '1.5rem' : undefined }}
            />
          </div>
          {usdMode && perToken > 0 && (
            <span className="text-[11px] text-[#667085]">{satsNote(Math.round(perToken), rate)} each</span>
          )}
          {curveNow !== null && (
            <span className="flex items-center justify-between text-[11px] text-[#98A2B3]">
              <span>
                Launch curve price: <span className="text-white">{usdLabel(curveNow)}</span> (floor{' '}
                {usdLabel(curve!.curve.floorUsd)})
              </span>
              {usdMode && (
                <button
                  type="button"
                  className="font-bold"
                  style={{ color: GOLD }}
                  onClick={() => setPrice(curveNow >= 0.01 ? curveNow.toFixed(2) : '0.01')}
                >
                  Use it
                </button>
              )}
            </span>
          )}
        </label>

        <div className="flex flex-col gap-1.5 rounded-xl p-3" style={{ background: '#0F1013' }}>
          {row('You receive when sold', money(total, rate), satsNote(total, rate))}
          {n > 1 && !!lotRaw && row('Lots', `${n} × ${fromRaw(lotRaw, target.dec)}`, `${money(lotPrice, rate)} each`)}
          {fundFee &&
            total > 0 &&
            row(
              `Buyers also pay (${FUND_FEE_RATE * 100}% indexing fee)`,
              money(fundFeeSats(lotPrice) * n, rate),
              'to the index fund, on top of your price',
            )}
          {row('Network fee', `~${money(network, rate)}`)}
          {row(
            'Indexing fee',
            money(indexing, rate),
            qtyRaw && qtyRaw < target.heldRaw ? 'listing + your change' : 'listing',
          )}
          <div className="h-px my-1" style={{ background: LINE }} />
          {row('You pay now', `~${money(network + indexing, rate)}`, satsNote(network + indexing, rate))}
        </div>

        <p className="text-[11px] leading-relaxed text-[#667085] m-0">
          Your {unit} go into an on-chain listing (1Sat OrdLock) visible on the Market and 1sat.market. Cancel any time
          from My listings to get them back.
        </p>

        <label className="flex items-center justify-between gap-3 text-xs text-[#98A2B3]">
          <span>Sell in lots (each lot is one listing, bought whole)</span>
          <input
            inputMode="numeric"
            value={lots}
            onChange={(e) => /^\d{0,2}$/.test(e.target.value) && setLots(e.target.value)}
            aria-label="Number of lots"
            className="w-16 h-9 rounded-lg px-2 text-base text-white outline-none border bg-[#0F1013] text-center"
            style={{ borderColor: LINE }}
          />
        </label>
        {fundFee && (
          <p className="text-[11px] leading-relaxed m-0" style={{ color: GOLD }}>
            Buyers pay a 5% indexing fee on top; you receive your full price. 5% keeps ${target.symbol} trading.
          </p>
        )}
        {fundFee && fund === null && (
          <p className="text-xs text-[#F97066] m-0">
            Couldn't reach the token's index fund, so listing is off for now.
          </p>
        )}
        {fund?.low && <p className="text-xs text-[#FDB022] m-0">The ${target.symbol} index fund is running low.</p>}
        {!!qtyRaw && qtyRaw < target.heldRaw && (
          <p className="text-[11px] text-[#667085] m-0">
            Listing part of your balance adds a change output (one more indexing fee). Selling all avoids it.
          </p>
        )}
        {losesRoom && <p className="text-xs text-[#FDB022] m-0">You&apos;ll lose access to the {target.room} room.</p>}
        {lotsError && <p className="text-xs text-[#F97066] m-0">The quantity must split evenly into {n} lots.</p>}
        {error && <p className="text-xs text-[#F97066] m-0">{ERR[error]}</p>}
        {custody && !custody.ok && <p className="text-xs text-[#F97066] m-0">{custody.reason}</p>}

        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void confirm()}
          className="h-12 rounded-xl text-sm font-bold disabled:opacity-40"
          style={{ background: GOLD, color: '#010101' }}
        >
          {busy ? 'Listing…' : 'Confirm listing'}
        </button>
      </div>
    </div>,
    document.body,
  );
};
