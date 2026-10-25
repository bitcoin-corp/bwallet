import { useCallback, useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { cancelListing, myListings, overlayFeePerOutput, type MyListing } from './sellActions';
import { CANCEL_TX_BYTES, fromRaw, networkFeeSats, onListingsChanged, removeRecord } from './sell';
import { moneyNow } from '../money/money';
import { ConfirmSheet } from '../p2p/ConfirmSheet';

const GOLD = 'var(--bw-accent-hi)';
const STATUS: Record<MyListing['status'], { label: string; color: string }> = {
  live: { label: 'On sale', color: '#A1FF8B' },
  indexing: { label: 'Indexing…', color: GOLD },
  gone: { label: 'Sold or closed', color: '#98A2B3' },
};

/** My BSV-21 listings (tickets, $NAME tokens) made in bWallet, with Cancel (tokens come back). */
export const MyTokenListings = ({ emptyText, tokenId }: { emptyText?: string; tokenId?: string }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [rows, setRows] = useState<MyListing[] | null>(null);
  const [busy, setBusy] = useState('');
  // One sheet before a cancel: what comes back and what it costs (the tx is checked against this).
  const [asking, setAsking] = useState<{ l: MyListing; overlay: number | null } | null>(null);
  const network = networkFeeSats(CANCEL_TX_BYTES, chromeStorageService.getCustomFeeRate());

  const ask = (l: MyListing) => {
    setAsking({ l, overlay: null });
    void overlayFeePerOutput(apiContext, l.tokenId).then((f) =>
      setAsking((a) => (a && a.l.outpoint === l.outpoint ? { l, overlay: f ?? 0 } : a)),
    );
  };

  const load = useCallback(() => {
    void myListings().then((r) => setRows(tokenId ? r.filter((l) => l.tokenId === tokenId) : r));
  }, [tokenId]);
  useEffect(() => {
    load();
    return onListingsChanged(load);
  }, [load]);

  const cancel = async (l: MyListing, overlay: number) => {
    setBusy(l.outpoint);
    setAsking(null);
    try {
      await cancelListing(apiContext, l, overlay);
      addSnackbar(`Listing cancelled: ${fromRaw(BigInt(l.amount), l.dec)} $${l.symbol} back in your wallet`, 'success');
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Cancel failed', 'error');
    } finally {
      setBusy('');
    }
  };

  if (rows === null) return <p className="text-xs text-[#98A2B3] text-center py-4">Loading your listings…</p>;
  if (!rows.length) return emptyText ? <p className="text-xs text-[#98A2B3] text-center py-4">{emptyText}</p> : null;

  return (
    <div className="flex flex-col gap-2">
      {rows.map((l) => {
        const s = STATUS[l.status];
        return (
          <div
            key={l.outpoint}
            className="flex items-center gap-3 rounded-xl border border-[#2b2f36] bg-[var(--bw-surface)] px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white overflow-hidden text-ellipsis whitespace-nowrap">
                {fromRaw(BigInt(l.amount), l.dec)} ${l.symbol}
              </div>
              <div className="text-xs text-[#98A2B3]">
                {moneyNow(l.priceSats)} · <span style={{ color: s.color }}>{s.label}</span>
              </div>
            </div>
            {l.status === 'gone' ? (
              <button
                onClick={() => removeRecord(l.outpoint)}
                className="rounded-lg px-3 py-1.5 text-xs font-bold bg-[#2b2f36] text-white"
              >
                Hide
              </button>
            ) : (
              <button
                disabled={!!busy}
                onClick={() => ask(l)}
                className="rounded-lg px-3 py-1.5 text-xs font-bold border disabled:opacity-40"
                style={{ background: 'var(--bw-surface)', borderColor: '#3a2f0c', color: GOLD }}
              >
                {busy === l.outpoint ? 'Cancelling…' : 'Cancel listing'}
              </button>
            )}
          </div>
        );
      })}
      {asking && (
        <ConfirmSheet
          title={`Cancel listing: ${fromRaw(BigInt(asking.l.amount), asking.l.dec)} $${asking.l.symbol}`}
          rows={[
            ['Tokens back to you', `${fromRaw(BigInt(asking.l.amount), asking.l.dec)} $${asking.l.symbol}`],
            ['Indexing fee', asking.overlay === null ? '…' : moneyNow(asking.overlay)],
            ['Network fee', `~${moneyNow(network)}`],
          ]}
          action="Cancel listing"
          disabled={asking.overlay === null}
          onConfirm={() => asking.overlay !== null && void cancel(asking.l, asking.overlay)}
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  );
};
