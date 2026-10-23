/**
 * Right after a Mint / Launch: "List some for sale?" (market plan PR 1). Opens the Sell sheet for the new token
 * with its launch curve as the price reference. The held amount is re-read from the wallet (a vested share is
 * locked and not listable); until then nothing can be listed.
 */
import { useEffect, useState } from 'react';
import { Tag } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { marketTradingEnabled } from '../storeBuild';
import type { Curve } from '../../lib/curves';
import { curveHash } from '../../lib/curves';
import { SELL_ENABLED } from './sell';
import { SellSheet } from './SellSheet';

export const ListAfterMint = ({
  tokenId,
  symbol,
  dec,
  curve,
}: {
  tokenId: string;
  symbol: string;
  dec: number;
  curve?: Curve | null;
}) => {
  const { apiContext } = useServiceContext();
  const [held, setHeld] = useState<bigint | null>(null);
  const [open, setOpen] = useState(false);
  const [listed, setListed] = useState(false);
  useEffect(() => {
    let live = true;
    heldBsv21Balances(apiContext)
      .then((b) => {
        const t = b.find((x) => x.id.replace('.', '_') === tokenId.replace('.', '_'));
        if (live) setHeld(t ? t.all.confirmed + t.all.pending : 0n);
      })
      .catch(() => live && setHeld(0n));
    return () => {
      live = false;
    };
  }, [apiContext, tokenId]);
  if (!SELL_ENABLED || !marketTradingEnabled()) return null;
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3" style={{ borderColor: '#2b2f36' }}>
      <div className="text-sm font-bold text-white">List some for sale?</div>
      <p className="text-xs m-0" style={{ color: '#98A2B3' }}>
        {listed
          ? 'Listed. It shows on the token page and 1sat.market; cancel any time from My listings.'
          : 'Put some on the market at your own price. People can then buy them in one tap and join the room.'}
      </p>
      {!listed && (
        <button
          type="button"
          disabled={!held}
          onClick={() => setOpen(true)}
          className="h-11 rounded-xl text-sm font-bold flex items-center justify-center gap-2 border cursor-pointer bg-transparent disabled:opacity-40"
          style={{ borderColor: '#3a2f0c', color: 'var(--bw-accent-hi)' }}
        >
          <Tag size={14} />{' '}
          {held === null ? 'Checking your balance…' : held ? 'List for sale' : 'Waiting for the tokens to arrive'}
        </button>
      )}
      {open && held ? (
        <SellSheet
          target={{
            tokenId,
            symbol,
            dec,
            heldRaw: held,
            curve: curve ? { curve, hash: curveHash(curve) } : undefined,
          }}
          onClose={() => setOpen(false)}
          onListed={() => setListed(true)}
        />
      ) : null}
    </div>
  );
};
