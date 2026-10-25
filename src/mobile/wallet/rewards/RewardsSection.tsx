import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useTheme } from '../../../hooks/useTheme';
import { SendBsv21View } from '../../../components/SendBsv21View';
import type { Bsv21Balance } from '@1sat/actions';
import { heldBsv21Balances } from '../../airdrops/heldBalances';
import { walletHoldings } from '../../chat/holdings';
import { BchatClient, defaultHttp, loadSession } from '../../chat/api';
import { parseLookup, tokenKey } from '../../chat/tokenRooms';
import { fetchCoins } from '../../market/launchpad/api';
import { openDappBrowser } from '../../dappBrowser';
import { isNative } from '../../native';
import { TOKENBLASTER_ENABLED, tokenRoomsEnabled } from '../../storeBuild';
import { RewardCards } from './RewardCards';
import { coinsById, pickRewards, type HeldToken, type Reward, type RewardCoinFlags } from './rewards';

/** Wallet › Tokens: the Rewards card (game-earned tokens). Renders nothing when you hold none. */
export const RewardsSection = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [sending, setSending] = useState<Bsv21Balance | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const held: HeldToken[] = (await walletHoldings(apiContext)).flatMap((h) =>
        h.kind === 'bsv21'
          ? [{ id: h.id, symbol: h.symbol, dec: h.dec, amountRaw: h.amountRaw, icon: h.icon ?? null }]
          : [],
      );
      const coins: RewardCoinFlags[] = TOKENBLASTER_ENABLED ? await fetchCoins().catch(() => []) : [];
      const first = pickRewards(held, coinsById(coins));
      if (live) setRewards(first);
      // Which room each reward opens (rooms whose tokenGate is bsv21:<id>); signed-in only.
      const session = tokenRoomsEnabled() ? loadSession(identityAddress) : null;
      if (!session || !first.length) return;
      const client = new BchatClient(defaultHttp(isNative), session);
      const rooms = new Map<string, string>();
      await Promise.all(
        first.map(async (r) => {
          const key = tokenKey('bsv21', r.id);
          const look = key ? parseLookup(await client.tokenRoom(key).catch(() => null)) : null;
          if (look?.room) rooms.set(r.id.toLowerCase().replace('.', '_'), look.room.name || look.room.ticker);
        }),
      );
      if (live) setRewards(pickRewards(held, coinsById(coins), rooms));
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiContext, identityAddress]);

  const send = async (r: Reward) => {
    const id = r.id.toLowerCase().replace('.', '_');
    const all = await heldBsv21Balances(apiContext).catch(() => []);
    const info = all.find((b) => (b.id || '').toLowerCase().replace('.', '_') === id);
    if (info) setSending(info);
  };

  if (sending) {
    return createPortal(
      <div className="fixed inset-0 z-[160] flex" style={{ background: theme.color.global.walletBackground }}>
        <SendBsv21View token={{ isConfirmed: true, info: sending }} onBack={() => setSending(null)} />
      </div>,
      document.body,
    );
  }

  return (
    <RewardCards
      rewards={rewards}
      showUnlock={tokenRoomsEnabled()}
      showEarn={TOKENBLASTER_ENABLED}
      onSend={(r) => void send(r)}
      onEarn={(url) => void openDappBrowser(url)}
    />
  );
};
