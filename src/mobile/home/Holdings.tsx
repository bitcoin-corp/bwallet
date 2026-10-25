import { useMemo, useState, useSyncExternalStore } from 'react';
import { placeholderTokenIcon, tokenIconUrl } from '../tokens/officialTokens';
import { useTokenIcon } from '../tokens/tokenIcon';
import bsvCoin from '../../assets/bsv-coin.svg';
import { useWalletFeed } from '../wide/walletFeed';
import { PNEE_TOKEN_ID } from '../notes/pnee';
import { getDisplayCurrency, onDisplayCurrencyChange, formatFiat, currentFx } from '../../utils/displayCurrency';

const useCurrency = () => useSyncExternalStore(onDisplayCurrencyChange, getDisplayCurrency, getDisplayCurrency);

/** Prices the app actually has: BSV (the wallet's rate), MNEE ($1 stablecoin), PNEEs (1 = $0.01). Others: none. */
type Row = { id: string; sym: string; icon?: string; amt: number; price: number | null; usd: number | null };
type SortKey = 'sym' | 'amt' | 'price' | 'usd';

/** A holding's picture, as on the phone (Bsv21TokensList): BSV's coin, an on-chain icon resolved to a URL, a
 *  personal token's creator photo, else the generic token art. Never a raw outpoint (it broke as an image). */
const TokIcon = ({ row }: { row: Row }) => {
  const onchain = tokenIconUrl(row.id, row.sym, row.icon);
  const icon = useTokenIcon(row.id === 'bsv' || row.id === 'mnee' ? undefined : row.id, row.sym, onchain);
  const [broken, setBroken] = useState(false);
  if (row.id === 'bsv') return <img className="ww-tok" src={bsvCoin} alt="" />;
  if (row.id === 'mnee' && !row.icon) return <span className="ww-tok">{row.sym.slice(0, 2)}</span>;
  return (
    <img
      className="ww-tok"
      src={broken ? placeholderTokenIcon(row.sym) : icon.url}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
};

/** Holdings (Desktop home module): every balance the Wallet page loaded, sortable. The wide layout only. */
const Holdings = () => {
  const feed = useWalletFeed();
  useCurrency();
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'usd', desc: true });
  const rows = useMemo<Row[]>(() => {
    if (!feed) return [];
    const r: Row[] = [
      {
        id: 'bsv',
        sym: 'BSV',
        amt: feed.bsvBalance,
        price: feed.exchangeRate || null,
        usd: feed.exchangeRate ? feed.bsvBalance * feed.exchangeRate : null,
      },
    ];
    if (feed.mneeBalance) r.push({ id: 'mnee', sym: 'MNEE', amt: feed.mneeBalance, price: 1, usd: feed.mneeBalance });
    for (const t of feed.bsv21s) {
      const amt = Number(t.amt) / 10 ** (t.dec || 0);
      const price = t.id === PNEE_TOKEN_ID ? 0.01 : null;
      r.push({
        id: t.id,
        sym: t.sym || t.id.slice(0, 8),
        icon: t.icon,
        amt,
        price,
        usd: price === null ? null : amt * price,
      });
    }
    return r;
  }, [feed]);
  const sorted = [...rows].sort((a, b) => {
    const v =
      sort.k === 'sym'
        ? a.sym.localeCompare(b.sym)
        : sort.k === 'amt'
          ? a.amt - b.amt
          : (a[sort.k] ?? -1) - (b[sort.k] ?? -1);
    return sort.desc ? -v : v;
  });
  const total = rows.reduce((s, r) => s + (r.usd ?? 0), 0);
  const th = (k: SortKey, label: string, right = false) => (
    <th className={right ? 'r' : ''} onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : true }))}>
      {label}
      {sort.k === k && <span className="ww-sort">{sort.desc ? '↓' : '↑'}</span>}
    </th>
  );
  return (
    <div className="ww-panel ww-flush bw-home-holdings">
      <div className="ww-panel-head">
        <span>Holdings</span>
        <span className="ww-muted ww-small">
          {feed
            ? `${formatFiat(total, currentFx())} priced · ${rows.length} assets · click a column to sort`
            : 'Loading…'}
        </span>
      </div>
      <table className="ww-table">
        <thead>
          <tr>
            {th('sym', 'Asset')}
            {th('amt', 'Amount', true)}
            {th('price', 'Price', true)}
            {th('usd', 'Value', true)}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => (
            <tr key={t.id}>
              <td>
                <TokIcon row={t} />
                <b>{t.sym}</b>
              </td>
              <td className="r mono">{t.amt.toLocaleString('en-GB', { maximumFractionDigits: 8 })}</td>
              <td className="r mono">
                {t.price === null ? <span className="ww-muted">—</span> : formatFiat(t.price, currentFx())}
              </td>
              <td className="r mono">
                {t.usd === null ? <span className="ww-muted">—</span> : formatFiat(t.usd, currentFx())}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default Holdings;
