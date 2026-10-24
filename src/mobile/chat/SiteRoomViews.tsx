import { useContext, useEffect, useRef } from 'react';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { asMenuItem } from '../tabs/tabs';
import { requestRoomByTicker } from './segmentNav';
import { sharedChatClient } from './sharedRooms';
import { activeSiteRoom, onSiteRoom, roomKnown, useActiveSiteRoom } from './siteRoom';
import { useCardBalance } from '../wallet/balanceStore';
import { money, useBsvUsd } from '../money/money';

/**
 * Opens the connected game's room (siteRoom.ts) when it becomes the active site, and goes back home when the site
 * disconnects or the user moves to a tab with nothing connected. Unknown room or no chat session: nothing happens,
 * the normal home screen stays.
 */
export const SiteRoomEngine = () => {
  const handleSelect = useContext(BottomMenuContext)?.handleSelect;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!handleSelect) return;
    let seq = 0;
    const go = async () => {
      const mine = ++seq;
      const r = activeSiteRoom();
      if (!r) {
        if (opened.current) handleSelect(asMenuItem('bsv'));
        opened.current = null;
        return;
      }
      if (opened.current === r.ticker) return;
      const client = sharedChatClient();
      if (!client.current) return; // not signed in to chat: home stays
      const rooms = await client.rooms().catch(() => []);
      if (mine !== seq || activeSiteRoom()?.ticker !== r.ticker || !roomKnown(rooms, r.ticker)) return;
      opened.current = r.ticker;
      handleSelect(asMenuItem('chat'));
      requestRoomByTicker(r.ticker, false);
    };
    void go();
    return onSiteRoom(() => void go());
  }, [handleSelect]);
  return null;
};

/**
 * The short balance card above the connected game's room: dollars big, BSV small. In the site's look (CSS
 * variables set by siteLook.ts). Last known balance (published by the wallet card).
 */
export const SiteRoomBalance = ({ ticker }: { ticker: string }) => {
  const r = useActiveSiteRoom();
  const b = useCardBalance('bsv', true);
  const rate = useBsvUsd();
  if (!r || r.ticker !== ticker.replace(/^\$/, '').toUpperCase() || !b) return null;
  const sats = b.amount;
  return (
    <div
      data-testid="bwx-site-room-balance"
      className="flex items-baseline justify-between px-4 shrink-0"
      style={{
        minHeight: 52,
        paddingTop: 8,
        paddingBottom: 8,
        background: 'var(--bw-surface, #17191E)',
        color: 'var(--bw-text, #FFFFFF)',
        borderBottom: '1px solid var(--bw-line, #2B2F36)',
      }}
    >
      <span style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1 }}>
        {rate > 0 ? money(sats, rate) : `${(sats / 1e8).toFixed(8)} BSV`}
      </span>
      {rate > 0 && (
        <span style={{ fontSize: 13, color: 'var(--bw-muted, #98A2B3)' }}>{(sats / 1e8).toFixed(8)} BSV</span>
      )}
    </div>
  );
};
