import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestMarketToken } from './nav';
import { MARKET_ENABLED } from '../storeBuild';
import { openExternal } from '../exchange/useTokenRowActions';
import { linkedTokenUrl, parseLinkedToken } from './linkedToken';
import { earnUrl } from '../market/launchpad/noCurve';

/**
 * "$SYMBOL" chip in a room's header for its display-only linked token. Opens the token in the Exchange (the
 * Market token page, where BlastPad tokens trade); BlastPad's own page when the Exchange can't be reached.
 * Hidden in store builds, which have no Exchange. A no-curve token (earned by playing, noCurve.ts) opens its game
 * instead, never a trade sheet.
 */
export const LinkedTokenChip = ({ metadata, color }: { metadata: unknown; color?: string }) => {
  const { handleSelect } = useBottomMenu();
  const token = parseLinkedToken(metadata);
  if (!MARKET_ENABLED || !token) return null;
  const open = () => {
    const earn = earnUrl(token.id);
    if (earn) {
      openExternal(earn);
      return;
    }
    try {
      requestMarketToken({ kind: 'bsv21', id: token.id });
      handleSelect(asMenuItem('market'));
    } catch {
      const url = linkedTokenUrl(token);
      if (url) openExternal(url);
    }
  };
  return (
    <button
      type="button"
      onClick={open}
      data-testid="linked-token-chip"
      className="mt-0.5 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold active:opacity-60"
      style={{ borderColor: '#3a2f0c', color: color ?? 'var(--bw-accent-hi)' }}
    >
      ${token.symbol}
    </button>
  );
};
