import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { fiatLabel, unitPriceLabel, bsvLabel } from './exchangeData';
import { openExternal } from './useTokenRowActions';
import { TokenRoomStore } from './TokenRoomStore';
import { MEMEPOOL_SORTS, fetchMemepoolCoins, memepoolTradeUrl, type MemepoolCoin, type MemepoolSort } from './memepool';
import { MemepoolTradeSheet } from './memepool/TradeSheet';

/**
 * Exchange › Memepool: every coin on TX Blaster's MEMEPOOL launchpad. "Buy or sell" trades it from this wallet
 * (memepool/TradeSheet.tsx, owner 25 Oct 2026); "Open on Memepool" opens their coin page. The Exchange is bWalletX
 * only (MARKET_ENABLED), so none of this ships in a store build.
 */
const MUTED = '#98A2B3';
const GOLD = '#F5C518';

const CoinIcon = ({ c }: { c: MemepoolCoin }) => {
  const [bad, setBad] = useState(false);
  if (c.iconUrl && !bad)
    return (
      <img
        src={c.iconUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBad(true)}
        className="w-10 h-10 rounded-full object-cover shrink-0"
      />
    );
  return (
    <span
      className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-sm font-extrabold"
      style={{ background: GOLD, color: '#000' }}
    >
      {c.sym.slice(0, 1).toUpperCase()}
    </span>
  );
};

const money = (sats: number, rate: number) => fiatLabel(sats, rate) || bsvLabel(sats);

export const MemepoolMarket = ({ rate }: { rate: number }) => {
  const [sort, setSort] = useState<MemepoolSort>('trending');
  const [coins, setCoins] = useState<MemepoolCoin[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);
  const [trading, setTrading] = useState<MemepoolCoin | null>(null);

  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchMemepoolCoins(sort)
      .then((c) => live && setCoins(c))
      .catch(() => {
        if (!live) return;
        setFailed(true);
        setCoins((prev) => prev ?? []);
      });
    return () => {
      live = false;
    };
  }, [sort, tick]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = coins ?? [];
    return s ? list.filter((c) => `${c.sym} ${c.name} ${c.id}`.toLowerCase().includes(s)) : list;
  }, [coins, q]);

  return (
    <div className="flex flex-col gap-3 w-full">
      <p className="text-xs m-0" style={{ color: MUTED }}>
        Coins launched on Memepool by TX Blaster. Prices come from each coin's bonding curve. Buy or sell from your
        wallet, up to 1 BSV a trade.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2" role="group" aria-label="Sort Memepool coins">
        {MEMEPOOL_SORTS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={sort === id}
            onClick={() => setSort(id)}
            className="rounded-xl px-3 py-2 text-sm font-bold cursor-pointer border"
            style={{
              background: sort === id ? GOLD : 'var(--bw-surface)',
              color: sort === id ? '#000' : 'var(--bw-text, #fff)',
              borderColor: sort === id ? GOLD : '#2b2f36',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name or ticker"
        aria-label="Search Memepool coins"
        className="w-full rounded-xl px-3 py-2 text-sm bg-[var(--bw-surface)] border border-[#2b2f36] text-white"
      />
      {coins === null ? (
        <p className="text-sm text-center py-8" style={{ color: MUTED }}>
          Loading Memepool coins…
        </p>
      ) : failed && !coins.length ? (
        <div className="text-sm text-center py-8 flex flex-col items-center gap-2" style={{ color: MUTED }}>
          <span>Memepool isn't answering right now.</span>
          <button
            type="button"
            onClick={() => setTick((t) => t + 1)}
            className="text-xs font-bold bg-transparent border-0 cursor-pointer"
            style={{ color: GOLD }}
          >
            Try again
          </button>
        </div>
      ) : !shown.length ? (
        <p className="text-sm text-center py-8" style={{ color: MUTED }}>
          No coins match.
        </p>
      ) : (
        <>
          <p className="text-[11px] m-0" style={{ color: MUTED }}>
            {shown.length} coin{shown.length === 1 ? '' : 's'}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((c) => (
              <div
                key={c.id}
                className="flex flex-col gap-2 rounded-2xl bg-[var(--bw-surface)] border border-[#2b2f36] p-3 min-w-0"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <CoinIcon c={c} />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-bold text-white overflow-hidden text-ellipsis whitespace-nowrap">
                      {c.name}
                    </span>
                    <span className="text-xs" style={{ color: MUTED }}>
                      ${c.sym}
                      {c.graduated ? ' · Graduated' : ''}
                    </span>
                  </div>
                  <div className="flex flex-col items-end shrink-0">
                    <span className="text-sm font-bold" style={{ color: GOLD }}>
                      {unitPriceLabel(c.priceSats)}
                    </span>
                    {c.change24h !== null && (
                      <span className="text-xs" style={{ color: c.change24h >= 0 ? '#32D583' : '#F97066' }}>
                        {c.change24h >= 0 ? '+' : ''}
                        {c.change24h.toFixed(1)}% today
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" style={{ color: MUTED }}>
                  <span>Value {money(c.mcapSats, rate)}</span>
                  <span>Traded today {money(c.vol24hSats, rate)}</span>
                  <span>
                    {c.holders} holder{c.holders === 1 ? '' : 's'}
                  </span>
                  {!c.graduated && <span>Curve {Math.round(c.progress * 100)}% full</span>}
                </div>
                <button
                  type="button"
                  onClick={() => setTrading(c)}
                  className="flex items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-bold cursor-pointer border-0"
                  style={{ background: GOLD, color: '#000' }}
                >
                  Buy or sell
                </button>
                <button
                  type="button"
                  onClick={() => openExternal(memepoolTradeUrl(c.id))}
                  className="flex items-center justify-center gap-1.5 bg-transparent border-0 text-xs font-bold cursor-pointer"
                  style={{ color: MUTED }}
                >
                  Open on Memepool <ExternalLink size={12} />
                </button>
                <TokenRoomStore id={c.id} sym={c.sym} />
              </div>
            ))}
          </div>
        </>
      )}
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        Listed from txblaster.xyz. bWalletX doesn't run Memepool: each coin's pool is held by their server. Memecoins
        can go to zero.
      </p>
      {trading && <MemepoolTradeSheet coin={trading} rate={rate} onClose={() => setTrading(null)} />}
    </div>
  );
};
