import { useCallback, useEffect, useMemo, useState } from 'react';
import { assertOrdLockV2 } from '../market/ordlockVersion';
import { buyBsv21 } from '@1sat/actions';
import { ArrowLeft, Star } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import {
  clearMarketCache,
  formatAmount,
  roomMarket,
  roomMeta,
  type Listing,
  type RoomMarket,
  type RoomMeta,
} from '../market/indexer';
import { marketFeeOptions, marketFeeSats, MARKET_FEE_RATE } from '../market/fee';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../market/walletOutpoint';
import { showOnWallet } from '../tokens/indexFund';
import { IndexerFundPanel } from '../tokens/IndexerFundPanel';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { MyTokenListings } from '../sell/MyTokenListings';
import { SellSheet, type SellTarget } from '../sell/SellSheet';
import { SELL_ENABLED } from '../sell/sell';
import { marketTradingEnabled } from '../storeBuild';
import { useBackClose } from '../backStack';
import { purchaseError } from './purchase';
import { checkedPurchaseContext } from '../p2p/checkedPurchase';
import { FUND_FEE_RATE, fetchFund, fundFeeOptions, fundFeeSats, hasFundFee, type Fund } from '../p2p/fundFee';
import { overlayFeePerOutput } from '../sell/sellActions';
import { NO_CURVE_LINE, isNoCurve } from '../market/launchpad/noCurve';
import { BUY_ANCHOR, SELL_ANCHOR } from './rowActions';
import { useLocation } from 'react-router-dom';
import { TokenIcon } from './TokenIcon';
import { TokenIdentity } from '../tokens/TokenIdPanel';
import { PriceChart } from './PriceChart';
import { TokenFacts } from './TokenFacts';
import { STALE_LISTING_MESSAGE, dropSpent, listingSpendState, nextAsk } from '../market/tokenPage';
import { chartSeries } from './chartSeries';
import { TokenLabelsRow } from './Categories';
import { LAUNCH_DISCLAIMER, localLaunches } from './launch/launch';
import { registryLaunches } from './launch/launchNet';
import { CreatorVesting } from './launch/VestingSection';
import {
  addHistory,
  bsvLabel,
  chainTip,
  changeLabel,
  dayStats,
  fiatLabel,
  loadHistory,
  tokenTrades,
  unitPriceLabel,
  type Trade,
} from './exchangeData';

const GOLD = 'var(--bw-accent)';
const GREEN = '#A1FF8B';
const RED = '#FF6B6B';
const MUTED = '#98A2B3';
const CARD = 'rounded-2xl bg-[var(--bw-surface)] border border-[#2b2f36]';
const TRADING = marketTradingEnabled();

/** Both units: "0.0012 BSV · $0.06". */
const Money = ({ sats, rate }: { sats: number; rate: number }) => {
  const f = fiatLabel(sats, rate);
  return (
    <>
      {bsvLabel(sats)}
      {f && <span style={{ color: MUTED }}> · {f}</span>}
    </>
  );
};

type Pending = { listing: Listing; perToken: number };

/** /exchange/<token>: chart, order book (live 1Sat listings), buy + sell, your listings and buys. */
/** A coin made on our Launchpad (this device's or the shared registry's launches) shows the Launchpad disclaimer. */
const useLaunched = (id: string): boolean => {
  const [launched, setLaunched] = useState(() => localLaunches().some((l) => l.tokenId === id.toLowerCase()));
  useEffect(() => {
    let live = true;
    if (launched) return;
    void registryLaunches().then((r) => live && r.some((l) => l.tokenId === id.toLowerCase()) && setLaunched(true));
    return () => {
      live = false;
    };
  }, [id, launched]);
  return launched;
};

export const TradeView = ({
  id,
  rate,
  fav,
  onFav,
  onBack,
  onPick,
}: {
  id: string;
  rate: number;
  fav: boolean;
  onFav: () => void;
  onBack: () => void;
  /** Open another token by id (ticker-collision picker). */
  onPick: (id: string) => void;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const ref = useMemo(() => ({ kind: 'bsv21' as const, id, key: `bsv21:${id}` }), [id]);
  const [meta, setMeta] = useState<RoomMeta | null | undefined>(undefined);
  const launched = useLaunched(id);
  const [market, setMarket] = useState<RoomMarket | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tip, setTip] = useState(0);
  const [held, setHeld] = useState<bigint | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [selling, setSelling] = useState<SellTarget | null>(null);
  const [histRev, setHistRev] = useState(0);
  // Listings found already bought before a buy (stale 1Sat rows): dropped from the book (plan §2.4).
  const [spent, setSpent] = useState<ReadonlySet<string>>(new Set());
  // The token's indexing fee per output: shown on the buy sheet, and the purchase may not pay more.
  const [overlayFee, setOverlayFee] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    setOverlayFee(undefined);
    void overlayFeePerOutput(apiContext, id).then(setOverlayFee);
  }, [apiContext, id]);
  // Reward tokens: the buyer pays a 5% indexing fee to the token's GorillaPool index fund (fundFee.ts).
  const fundFee = hasFundFee(id);
  const [fund, setFund] = useState<Fund | null | undefined>(undefined);
  useEffect(() => {
    if (!fundFee) return;
    setFund(undefined);
    void fetchFund(id).then(setFund);
  }, [id, fundFee]);
  useBackClose(!!pending && !busy, () => setPending(null));

  const load = useCallback(() => {
    void roomMeta('bsv21', id).then(setMeta);
    void roomMarket(ref, 50).then(setMarket);
    void tokenTrades(id).then(setTrades);
    void chainTip().then(setTip);
    heldBsv21Balances(apiContext)
      .then((b) => {
        const t = b.find((x) => x.id === id);
        setHeld(t ? t.all.confirmed + t.all.pending : 0n);
      })
      .catch(() => setHeld(null));
  }, [id, ref, apiContext]);
  useEffect(() => {
    setMeta(undefined);
    setMarket(null);
    setTrades([]);
    load();
  }, [load]);
  // Exchange row "Buy" / "Sell" (rowActions.buyRoute / sellRoute) lands on the Buy or Sell panel.
  const { hash } = useLocation();
  useEffect(() => {
    const anchor = [BUY_ANCHOR, SELL_ANCHOR].find((a) => hash === `#${a}`);
    if (!anchor) return;
    const t = setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }), 80);
    return () => clearTimeout(t);
  }, [id, hash]);

  const dec = meta?.dec ?? 0;
  const sym = meta?.sym ?? id.slice(0, 8);
  const perToken = (l: Listing) => l.priceSats / (Number(l.amount ?? 0) / 10 ** dec || 1);
  const asks = useMemo(
    () =>
      dropSpent(
        [...(market?.listings ?? [])].sort((a, b) => perToken(a) - perToken(b)),
        spent,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [market, dec, spent],
  );
  const best = asks.find((l) => l.buyable);
  const stats = dayStats(trades, tip);
  const price = stats.last ?? market?.floorSats ?? null;
  // histRev: re-read after a buy.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mine = useMemo(() => loadHistory().filter((h) => h.tokenId === id), [id, histRev]);

  const buy = async ({ listing }: Pending) => {
    if (!TRADING) return;
    if (fundFee && !fund) {
      addSnackbar("Couldn't reach the token's index fund. Try again in a moment.", 'error');
      return;
    }
    setBusy(true);
    try {
      const outpoint = walletOutpoint(listing.outpoint);
      // Pre-buy: is the listing still there? 1Sat's search can lag a sale by minutes.
      if ((await listingSpendState(listing.outpoint)) === 'spent') {
        setSpent((s) => new Set([...s, listing.outpoint.replace('.', '_')]));
        const next = nextAsk(asks, listing.outpoint);
        addSnackbar(STALE_LISTING_MESSAGE, 'info');
        setPending(next ? { listing: next, perToken: perToken(next) } : null);
        clearMarketCache();
        load();
        return;
      }
      await assertOrdLockV2(outpoint);
      // Checked before signing: exact price to the seller, tokens to our key, fees no more than shown.
      const checked = await checkedPurchaseContext(apiContext, {
        tokenId: id,
        outpoint,
        amount: BigInt(listing.amount ?? '0'),
        priceSats: listing.priceSats,
        maxOverlayFee: overlayFee ?? 0,
        ...(fundFee && fund
          ? { fee: { address: fund.address, sats: fundFeeSats(listing.priceSats), required: true } }
          : {}),
      });
      const res = await buyBsv21.execute(purchaseContext(checked, outpoint), {
        tokenId: id,
        outpoint,
        amount: listing.amount ?? '0',
        ...(fundFee && fund ? fundFeeOptions(fund) : marketFeeOptions()),
        ...MODULE_FINISHES,
      });
      if (!res.txid || res.error) {
        addSnackbar(purchaseError(res.error), 'error');
        return;
      }
      void showOnWallet(chromeStorageService, id);
      addHistory({
        txid: res.txid,
        tokenId: id,
        symbol: sym,
        amountLabel: listing.label,
        totalSats: listing.priceSats + (fundFee ? fundFeeSats(listing.priceSats) : marketFeeSats(listing.priceSats)),
        at: Date.now(),
      });
      setHistRev((n) => n + 1);
      addSnackbar(`Bought ${listing.label}`, 'success');
      setPending(null);
      clearMarketCache();
      load();
    } catch (e) {
      addSnackbar(purchaseError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeColor = stats.change === null ? MUTED : stats.change >= 0 ? GREEN : RED;
  const fee = pending
    ? fundFee
      ? fundFeeSats(pending.listing.priceSats)
      : marketFeeSats(pending.listing.priceSats)
    : 0;

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* Header: token, last price, 24h */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="All markets"
          className="w-9 h-9 grid place-items-center rounded-full bg-[var(--bw-surface)] border-0 cursor-pointer"
        >
          <ArrowLeft size={18} color="#fff" />
        </button>
        <TokenIcon icon={meta?.icon} sym={sym} size={36} />
        <div className="min-w-0 flex-1">
          <div className="text-lg font-extrabold text-white">{meta === null ? 'Unknown token' : `$${sym}`}</div>
          <div className="mt-1">
            <TokenLabelsRow id={id} />
          </div>
        </div>
        <button
          type="button"
          onClick={onFav}
          aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
          className="w-9 h-9 grid place-items-center rounded-full bg-[var(--bw-surface)] border-0 cursor-pointer"
        >
          <Star size={18} color={GOLD} fill={fav ? GOLD : 'none'} />
        </button>
      </div>
      <TokenIdentity tokenId={id} ticker={meta?.sym ?? null} onPick={onPick} />
      {isNoCurve(id) && (
        <p className="text-sm m-0" style={{ color: GOLD }} data-testid="earned-by-playing">
          {NO_CURVE_LINE}. Buy from players below, or list yours for sale.
        </p>
      )}
      {launched && (
        <p className="text-[11px] m-0" style={{ color: MUTED }}>
          Launched on the bWalletX Launchpad. {LAUNCH_DISCLAIMER}
        </p>
      )}
      <TokenFacts tokenId={id} sym={sym} dec={dec} rate={rate} priceSats={price} held={held} />
      <IndexerFundPanel tokenId={id} ticker={sym} />
      {launched && <CreatorVesting tokenId={id} />}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          ['Price / token', price === null ? '—' : unitPriceLabel(price), price === null ? '' : fiatLabel(price, rate)],
          ['24h', changeLabel(stats.change), ''],
          ['24h volume', bsvLabel(stats.volume), fiatLabel(stats.volume, rate)],
          ['For sale', market ? `${market.live} listing${market.live === 1 ? '' : 's'}` : '…', ''],
        ].map(([k, v, sub], i) => (
          <div key={k} className={`${CARD} px-3 py-2.5`}>
            <div className="text-[11px]" style={{ color: MUTED }}>
              {k}
            </div>
            <div className="text-sm font-bold" style={{ color: i === 1 ? changeColor : '#fff' }}>
              {v}
            </div>
            {sub && (
              <div className="text-[11px]" style={{ color: MUTED }}>
                {sub}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4 min-w-0">
          <div className={`${CARD} p-3`}>
            <div className="text-xs font-bold mb-1" style={{ color: MUTED }}>
              {trades.length >= 2 ? `Price per token, last ${trades.length} trades` : 'Price per token'}
            </div>
            <PriceChart series={chartSeries(trades, { lowestAsk: market?.floorSats })} priceLabel={unitPriceLabel} />
          </div>

          {/* Order book: sell orders (live listings), cheapest first */}
          <div className={`${CARD} p-3`}>
            <div className="text-sm font-bold text-white mb-2">
              {isNoCurve(id) ? 'Listings from players' : 'Order book'}
            </div>
            {market === null ? (
              <p className="text-xs py-3" style={{ color: MUTED }}>
                Loading listings…
              </p>
            ) : !asks.length ? (
              <p className="text-xs py-3" style={{ color: MUTED }}>
                Nobody is selling ${sym} right now.
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: MUTED }}>
                    <th className="text-left font-semibold py-1">Price / token</th>
                    <th className="text-right font-semibold">Amount</th>
                    <th className="text-right font-semibold">Total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {asks.map((l) => (
                    <tr key={l.outpoint} className="border-t border-[#2b2f36]">
                      <td className="py-1.5" style={{ color: RED }}>
                        {unitPriceLabel(perToken(l))}
                      </td>
                      <td className="text-right text-white">{l.amount ? formatAmount(BigInt(l.amount), dec) : '—'}</td>
                      <td className="text-right text-white">
                        <Money sats={l.priceSats} rate={rate} />
                      </td>
                      <td className="text-right pl-2">
                        {TRADING && l.buyable ? (
                          <button
                            type="button"
                            onClick={() => setPending({ listing: l, perToken: perToken(l) })}
                            className="rounded-lg px-2.5 py-1 text-xs font-bold border-0 cursor-pointer"
                            style={{ background: GREEN, color: '#010101' }}
                          >
                            Buy
                          </button>
                        ) : (
                          <span style={{ color: MUTED }}>{l.buyable ? '' : 'Not indexed'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className={`${CARD} p-3`}>
            <div className="text-sm font-bold text-white mb-2">Recent trades</div>
            {!trades.length ? (
              <p className="text-xs" style={{ color: MUTED }}>
                No trades yet.
              </p>
            ) : (
              <div className="flex flex-col text-xs">
                {[...trades]
                  .reverse()
                  .slice(0, 12)
                  .map((t, i) => (
                    <div key={i} className="flex justify-between py-1 border-t border-[#2b2f36]">
                      <span className="text-white">{unitPriceLabel(t.satsPerToken)}</span>
                      <span style={{ color: MUTED }}>
                        {t.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} · block {t.height}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* Buy / sell panel */}
        <div className="flex flex-col gap-4">
          <div id={BUY_ANCHOR} className={`${CARD} p-4 flex flex-col gap-3 scroll-mt-4`}>
            <div className="text-sm font-bold text-white">Buy ${sym}</div>
            {!TRADING ? (
              <p className="text-xs" style={{ color: MUTED }}>
                Trading isn't available in this edition.
              </p>
            ) : best ? (
              <>
                <div className="text-xs" style={{ color: MUTED }}>
                  Best price: <span className="text-white">{best.label}</span> for{' '}
                  <span className="text-white">
                    <Money sats={best.priceSats} rate={rate} />
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setPending({ listing: best, perToken: perToken(best) })}
                  className="rounded-xl py-3 text-sm font-extrabold border-0 cursor-pointer"
                  style={{ background: GREEN, color: '#010101' }}
                >
                  Buy at best price
                </button>
                <div className="text-[11px]" style={{ color: MUTED }}>
                  Or pick any listing in the order book.
                </div>
              </>
            ) : (
              <p className="text-xs" style={{ color: MUTED }}>
                {market === null ? 'Loading…' : 'No listing can be bought in-app right now.'}
              </p>
            )}
          </div>

          <div id={SELL_ANCHOR} className={`${CARD} p-4 flex flex-col gap-3 scroll-mt-4`}>
            <div className="text-sm font-bold text-white">Sell ${sym}</div>
            <div className="text-xs" style={{ color: MUTED }}>
              You hold <span className="text-white">{held === null ? '…' : `${formatAmount(held, dec)} $${sym}`}</span>
            </div>
            {SELL_ENABLED && TRADING && held !== null && held > 0n ? (
              <button
                type="button"
                onClick={() => setSelling({ tokenId: id, symbol: sym, dec, heldRaw: held })}
                className="rounded-xl py-3 text-sm font-extrabold border-0 cursor-pointer"
                style={{ background: RED, color: '#010101' }}
              >
                Sell (list for sale)
              </button>
            ) : (
              <div className="text-[11px]" style={{ color: MUTED }}>
                {held === 0n
                  ? 'Buy some first to sell it here.'
                  : !SELL_ENABLED
                    ? 'Listing is paused in this build.'
                    : ''}
              </div>
            )}
          </div>

          <div className={`${CARD} p-4 flex flex-col gap-2`}>
            <div className="text-sm font-bold text-white">Your open orders</div>
            <MyTokenListings tokenId={id} emptyText={`No ${'$' + sym} listings of yours.`} />
          </div>

          <div className={`${CARD} p-4 flex flex-col gap-2`}>
            <div className="text-sm font-bold text-white">Your buys</div>
            {!mine.length ? (
              <p className="text-xs" style={{ color: MUTED }}>
                Nothing bought here yet on this device.
              </p>
            ) : (
              mine.slice(0, 10).map((h) => (
                <a
                  key={h.txid}
                  href={`https://whatsonchain.com/tx/${h.txid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex justify-between text-xs no-underline"
                >
                  <span className="text-white">{h.amountLabel}</span>
                  <span style={{ color: MUTED }}>{bsvLabel(h.totalSats)}</span>
                </a>
              ))
            )}
          </div>
        </div>
      </div>

      {pending && (
        <div
          className="fixed inset-0 z-[200] flex items-end md:items-center justify-center bg-black/60"
          onClick={() => !busy && setPending(null)}
        >
          <div
            className="w-full md:max-w-[420px] rounded-t-2xl md:rounded-2xl bg-[var(--bw-surface)] px-5 pt-5 flex flex-col gap-3"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-base font-bold text-white">Buy {pending.listing.label}</div>
            <div className="flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between" style={{ color: MUTED }}>
                <span>Price per token</span>
                <span className="text-white">{unitPriceLabel(pending.perToken)}</span>
              </div>
              <div className="flex justify-between" style={{ color: MUTED }}>
                <span>Price (to seller)</span>
                <span className="text-white">
                  <Money sats={pending.listing.priceSats} rate={rate} />
                </span>
              </div>
              <div className="flex justify-between" style={{ color: MUTED }}>
                <span>
                  {fundFee
                    ? `Indexing fee (${FUND_FEE_RATE * 100}%, to the $${sym} index fund)`
                    : `Marketplace fee (${MARKET_FEE_RATE * 100}%)`}
                </span>
                <span className="text-white">{fee ? <Money sats={fee} rate={rate} /> : 'None'}</span>
              </div>
              {fundFee && (
                <p className="m-0 text-[11px]" style={{ color: MUTED }}>
                  This is what keeps the token tradeable. The seller gets their full price.
                  {fund === null && " Couldn't reach the index fund, so buying is off for now."}
                  {fund?.low && ' The index fund is running low.'}
                </p>
              )}
              <div className="flex justify-between" style={{ color: MUTED }}>
                <span>Overlay fee</span>
                <span className="text-white">
                  {overlayFee === undefined ? '…' : overlayFee ? <Money sats={overlayFee} rate={rate} /> : 'None'}
                </span>
              </div>
              <div className="flex justify-between" style={{ color: MUTED }}>
                <span>Network fee</span>
                <span className="text-white">a few sats</span>
              </div>
              <div className="flex justify-between border-t border-[#2b2f36] pt-1.5 font-semibold">
                <span className="text-white">Total</span>
                <span style={{ color: GREEN }}>
                  <Money sats={pending.listing.priceSats + fee + (overlayFee ?? 0)} rate={rate} /> + network fee
                </span>
              </div>
            </div>
            <button
              type="button"
              disabled={busy || overlayFee === undefined || (fundFee && !fund)}
              onClick={() => void buy(pending)}
              className="rounded-xl py-3 text-sm font-extrabold border-0 cursor-pointer disabled:opacity-50"
              style={{ background: GREEN, color: '#010101' }}
            >
              {busy ? 'Buying…' : `Buy for ${bsvLabel(pending.listing.priceSats + fee + (overlayFee ?? 0))}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPending(null)}
              className="py-2 text-xs border-0 bg-transparent cursor-pointer"
              style={{ color: MUTED }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {SELL_ENABLED && selling && (
        <SellSheet target={selling} onClose={() => setSelling(null)} onListed={() => (setSelling(null), load())} />
      )}
    </div>
  );
};
