import { useContext, useEffect, useState } from 'react';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { asMenuItem } from '../tabs/tabs';
import { requestRoomByTicker } from './segmentNav';
import { sharedChatClient } from './sharedRooms';
import { roomKnown, siteLabel, useActiveSiteRoom } from './siteRoom';
import { useCardBalance } from '../wallet/balanceStore';
import { money, useBsvUsd } from '../money/money';

/**
 * The connected game's room is one tap away, never opened by itself (owner, 25 Oct 2026: connecting to a site such as
 * tokenblaster.lol must not switch the wallet to its room; the site's theme still applies). A small chip shows while
 * that site is the active tab, the room is one the wallet lists, and chat is signed in. Tapping it opens the room.
 */
export const SiteRoomChip = () => {
  const handleSelect = useContext(BottomMenuContext)?.handleSelect;
  const r = useActiveSiteRoom();
  const [known, setKnown] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => {
    setKnown(null);
    if (!r) return;
    let live = true;
    const client = sharedChatClient();
    if (!client.current) return; // not signed in to chat: no chip
    void client
      .rooms()
      .catch(() => [])
      .then((rooms) => {
        if (live && roomKnown(rooms, r.ticker)) setKnown(r.ticker);
      });
    return () => {
      live = false;
    };
  }, [r]);
  if (!handleSelect || !r || known !== r.ticker || hidden === r.ticker) return null;
  const site = siteLabel(r.origin);
  return (
    <button
      type="button"
      data-testid="bwx-site-room-chip"
      onClick={() => {
        setHidden(r.ticker);
        handleSelect(asMenuItem('chat'));
        requestRoomByTicker(r.ticker, false);
      }}
      className="fixed z-[900] border-0 rounded-full px-3 py-1.5 text-xs font-semibold"
      style={{
        top: 8,
        right: 8,
        background: 'var(--bw-surface, #17191E)',
        color: 'var(--bw-text, #FFFFFF)',
        border: '1px solid var(--bw-line, #2B2F36)',
      }}
    >
      Open {site} room
    </button>
  );
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
