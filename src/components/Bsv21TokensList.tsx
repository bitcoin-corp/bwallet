import { IssuerBadge } from '../mobile/issuer/IssuerBadge';
import { useOwnPersonalTokenId, useTokenIcon } from '../mobile/tokens/tokenIcon';
import { normId } from '../mobile/names/personalToken';
import { AnimatePresence, motion } from 'framer-motion';
import { Coins } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DragDropContext, Draggable, Droppable, DropResult } from '@hello-pangea/dnd';
import { ONESAT_MAINNET_CONTENT_URL, type Bsv21Balance } from '@1sat/actions';
import { useServiceContext } from '../hooks/useServiceContext';
import { ChromeStorageObject } from '../services/types/chromeStorage.types';
import { Theme } from '../theme.types';
import { BSV_DECIMAL_CONVERSION, GENERIC_TOKEN_ICON } from '../utils/constants';
import { showAmount } from '../utils/format';
import { isUri } from '../utils/uri';
import { fetchExchangeRate } from '../utils/wallet';
import { AssetRow } from './AssetRow';
import { Show } from './Show';
import { IS_EXTENSION } from '../mobile/extension';
import { TokenSwipe } from '../mobile/wallet/TokenSwipe';
import { useNavigate } from 'react-router-dom';
import { SELL_ENABLED } from '../mobile/sell/sell';
import { marketTradingEnabled } from '../mobile/storeBuild';
import { sellRoute } from '../mobile/exchange/rowActions';
import { UndoToastHost } from '../mobile/swipe/undo';
import { arrange, useTokenRows } from '../mobile/wallet/tokenRows';
import { useListCoin } from '../mobile/wallet/useListCoin';
import { rowMatchesCoin } from '../mobile/wallet/cardFilter';
import { hasFocusHost, setFocusedToken } from '../mobile/wallet/cardFocus';

const resolveIcon = (icon: string) => (isUri(icon) ? icon : `${ONESAT_MAINNET_CONTENT_URL}/${icon}`);

type PriceData = {
  id: string;
  satPrice: number;
};

export type Bsv21TokensListProps = {
  tokens: Bsv21Balance[];
  theme: Theme;
  hideStatusLabels?: boolean;
  onTokenClick: (token: Bsv21Balance) => void;
  /** Swipe actions (phone and web wallet; not the extension). */
  onReceive?: () => void;
  onChat?: (token: Bsv21Balance) => void;
  onLock?: (token: Bsv21Balance) => void;
};

const getTokenName = (b: Bsv21Balance): string => b.sym || 'Null';

/** Your own personal token: pinned under BSV and MNEE, marked YOURS (owner, 4 Oct 2026). */
const YoursChip = () => (
  <span
    className="text-[9px] font-bold rounded px-1.5 py-0.5 mr-1.5"
    style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)', letterSpacing: '0.04em' }}
  >
    YOURS
  </span>
);

/** Token icon: a personal token shows its creator's profile picture (mobile/tokens/tokenIcon). */
const TokenAssetRow = ({ t, usdBalance, still }: { t: Bsv21Balance; usdBalance: number; still?: boolean }) => {
  const icon = useTokenIcon(t.id, getTokenName(t), t.icon ? resolveIcon(t.icon) : GENERIC_TOKEN_ICON);
  return (
    <AssetRow
      animate
      still={still}
      balance={Number(showAmount(t.all.confirmed, t.dec))}
      decimals={t.dec}
      showPointer={true}
      icon={icon.url}
      ticker={getTokenName(t)}
      subline={
        <span className="inline-flex items-center">
          {icon.own && <YoursChip />}
          <IssuerBadge tokenId={t.id} compact />
        </span>
      }
      usdBalance={usdBalance}
    />
  );
};

export const Bsv21TokensList = (props: Bsv21TokensListProps) => {
  const navigate = useNavigate();
  const { tokens: tokensProp, theme, onTokenClick, hideStatusLabels = false } = props;
  const { chromeStorageService, apiContext } = useServiceContext();
  const [priceData, setPriceData] = useState<PriceData[]>([]);
  const [tokens, setTokens] = useState<Bsv21Balance[]>([]);
  const [exchangeRate, setExchangeRate] = useState<number>(0);
  const ownId = useOwnPersonalTokenId();

  useEffect(() => {
    const loadExchangeRate = async () => {
      const rate = await fetchExchangeRate(apiContext.chain, apiContext.wocApiKey);
      setExchangeRate(rate);
    };
    loadExchangeRate();
  }, [apiContext]);

  useEffect(() => {
    const loadSavedTokens = async () => {
      if (!tokensProp.length) {
        setTokens([]);
        return;
      }
      const { account } = chromeStorageService.getCurrentAccountObject();
      if (!account) return;
      const favoriteTokenIds = account?.settings?.favoriteTokens || [];

      const orderedTokens = favoriteTokenIds
        .map((id) => tokensProp.find((token) => token.id === id))
        .filter(Boolean) as Bsv21Balance[];

      // TODO: Re-implement token price fetching with new API
      const data: PriceData[] = [];
      // Favourites first, then every other held token (new ones, e.g. a fresh $NAME, must show too).
      const rest = tokensProp.filter((t) => !orderedTokens.includes(t));
      // Your own personal token always first, under BSV and MNEE.
      const all = [...orderedTokens, ...rest];
      const mine = all.filter((t) => ownId && normId(t.id) === ownId);
      setTokens([...mine, ...all.filter((t) => !mine.includes(t))]);
      setPriceData(data);
    };

    // Re-run when the parent's list changes (e.g. favorites edited in Manage Tokens).
    loadSavedTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokensProp, ownId]);

  const handleOnDragEnd = async (result: DropResult) => {
    if (!result.destination) return;

    const reorderedTokens = Array.from(tokens);
    const [removed] = reorderedTokens.splice(result.source.index, 1);
    reorderedTokens.splice(result.destination.index, 0, removed);
    await saveOrder(reorderedTokens);
  };

  /** Persist the list order (this account's favoriteTokens, on this device). */
  const saveOrder = async (reorderedTokens: Bsv21Balance[]) => {
    setTokens(reorderedTokens);
    const { account } = chromeStorageService.getCurrentAccountObject();
    if (!account) return;
    const key: keyof ChromeStorageObject = 'accounts';

    const favoriteTokens = reorderedTokens.map((t) => t.id).filter((t) => t) as string[];

    const update: Partial<ChromeStorageObject['accounts']> = {
      [account.addresses.identityAddress]: {
        ...account,
        settings: {
          ...account.settings,
          favoriteTokens,
        },
      },
    };

    await chromeStorageService.updateNested(key, update);
  };

  // The MNEE / PNEEs balance card narrows the list to its coin (mobile/wallet/cardFilter.ts).
  const coin = useListCoin();
  const confirmedTokens = tokens.filter((t) => t.all.confirmed > 0n && rowMatchesCoin(t.id, coin));
  const pendingTokens = tokensProp.filter((d) => d.all.pending > 0n && rowMatchesCoin(d.id, coin));
  const rowsState = useTokenRows();
  const usdOf = (t: Bsv21Balance) =>
    (priceData.find((p) => p.id === t.id)?.satPrice ?? 0) *
    (exchangeRate / BSV_DECIMAL_CONVERSION) *
    Number(showAmount(t.all.confirmed, t.dec));

  // Tap a row: with the balance cards on screen it becomes the front card (owner, 15 Oct 2026; × or a swipe puts
  // the normal card back, the list stays where it is). Otherwise the old tap (the token's send screen).
  const openRow = (t: Bsv21Balance) => {
    if (!hasFocusHost()) return onTokenClick(t);
    const name = getTokenName(t);
    setFocusedToken({
      id: t.id,
      name,
      icon: t.icon ? resolveIcon(t.icon) : GENERIC_TOKEN_ICON,
      amount: `${showAmount(t.all.confirmed, t.dec)} ${t.sym || name}`,
      qty: Number(t.all.confirmed) / 10 ** (t.dec ?? 0),
      symbol: t.sym || name,
      decimals: t.dec ?? 0,
      onSend: () => onTokenClick(t),
      onReceive: props.onReceive,
      onLock: props.onLock ? () => props.onLock?.(t) : undefined,
      onRoom: props.onChat ? () => props.onChat?.(t) : undefined,
    });
  };

  // Phone / web wallet: swipe actions, pinned group, archive, iPhone-style reorder (owner, 15 Oct 2026).
  if (!IS_EXTENSION && tokens.length > 0) {
    const groups = arrange(confirmedTokens, (t) => t.id, rowsState.pinned, rowsState.archived);
    const row = (t: Bsv21Balance) => (
      <TokenSwipe
        id={t.id}
        label={getTokenName(t)}
        pinned={rowsState.pinned.includes(t.id)}
        onSend={() => onTokenClick(t)}
        onReceive={() => props.onReceive?.()}
        onChat={() => props.onChat?.(t)}
        onLock={() => props.onLock?.(t)}
        onSell={SELL_ENABLED && marketTradingEnabled() ? () => navigate(sellRoute(t.id)) : undefined}
      >
        <div
          style={{ display: 'flex', justifyContent: 'center', width: '100%' }}
          onClick={() => openRow(t)}
        >
          <TokenAssetRow t={t} usdBalance={usdOf(t)} still />
        </div>
      </TokenSwipe>
    );
    const label = (text: string) => (
      <div className="w-full px-5 pt-3 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: theme.color.global.gray }}>
          {text}
        </span>
      </div>
    );
    return (
      <div className="flex flex-col items-center w-full">
        {groups.pinned.length > 0 && (
          <>
            {label('Pinned')}
            {groups.pinned.map((t) => (
              <div key={t.id} className="w-full">
                {row(t)}
              </div>
            ))}
          </>
        )}
        {groups.pinned.length > 0 && groups.rest.length > 0 && label('Tokens')}
        {groups.rest.map((t) => (
          <div key={t.id} className="w-full">
            {row(t)}
          </div>
        ))}
        {pendingTokens.length > 0 && label('Pending')}
        {pendingTokens.map((b) => (
          <div
            key={b.id}
            style={{ display: 'flex', justifyContent: 'center', width: '100%' }}
            onClick={() => onTokenClick(b)}
          >
            <AssetRow
              animate
              balance={Number(showAmount(b.all.pending, b.dec))}
              decimals={b.dec}
              showPointer={true}
              icon={b.icon ? resolveIcon(b.icon) : GENERIC_TOKEN_ICON}
              ticker={getTokenName(b)}
              subline={<IssuerBadge tokenId={b.id} compact />}
              usdBalance={usdOf(b)}
            />
          </div>
        ))}
        {/* Archived rows live in Wallet › Hidden tokens (HiddenTokens.tsx). */}
        <UndoToastHost />
      </div>
    );
  }

  return (
    <>
      <Show
        when={tokens.length > 0 || hideStatusLabels}
        whenFalseContent={
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center mt-32 w-full gap-3"
          >
            <div
              className="flex items-center justify-center w-12 h-12 rounded-full"
              style={{ backgroundColor: theme.color.global.row }}
            >
              <Coins size={20} style={{ color: theme.color.global.gray }} />
            </div>
            <p className="text-sm text-center" style={{ color: theme.color.global.gray }}>
              {theme.settings.services.bsv21
                ? "You don't have any tokens"
                : 'Wallet configuration does not support tokens!'}
            </p>
          </motion.div>
        }
      >
        <DragDropContext onDragEnd={handleOnDragEnd}>
          <Droppable droppableId="bsv21-list">
            {(provided) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                className="flex flex-col items-center overflow-y-auto overflow-x-hidden w-full"
                style={hideStatusLabels ? undefined : { height: 'calc(100% - 4rem)' }}
              >
                {/* Confirmed section */}
                <Show when={!hideStatusLabels && confirmedTokens.length > 0}>
                  <div className="w-full px-5 pt-3 pb-1">
                    <span
                      className="text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: theme.color.global.gray }}
                    >
                      Confirmed
                    </span>
                  </div>
                </Show>

                <div className="w-full">
                  <AnimatePresence initial={false}>
                    {confirmedTokens.map(
                      (t, index) =>
                        t.id && (
                          <Draggable key={t.id} draggableId={t.id} index={index}>
                            {(provided, snapshot) => {
                              // While dragging, dnd sets position:fixed on the row. Inside a
                              // transformed ancestor (framer-motion) that resolves against the
                              // ancestor, so a held tap made the row jump to the top of the list
                              // and draw over it. Portal the dragged row to <body> instead.
                              const row = (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                {...provided.dragHandleProps}
                                style={{
                                  ...provided.draggableProps.style,
                                  display: 'flex',
                                  justifyContent: 'center',
                                  width: '100%',
                                }}
                                onClick={() => onTokenClick(t)}
                              >
                                <TokenAssetRow
                                  t={t}
                                  usdBalance={
                                    (priceData.find((p) => p.id === t.id)?.satPrice ?? 0) *
                                    (exchangeRate / BSV_DECIMAL_CONVERSION) *
                                    Number(showAmount(t.all.confirmed, t.dec))
                                  }
                                />
                              </div>
                              );
                              return snapshot.isDragging ? createPortal(row, document.body) : row;
                            }}
                          </Draggable>
                        ),
                    )}
                  </AnimatePresence>
                </div>

                {/* Pending section */}
                <Show when={pendingTokens.length > 0}>
                  <Show when={!hideStatusLabels}>
                    <div className="w-full px-5 pt-4 pb-1">
                      <span
                        className="text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: theme.color.global.gray }}
                      >
                        Pending
                      </span>
                    </div>
                  </Show>

                  <div className="w-full">
                    {pendingTokens.map((b) => (
                      <div
                        key={b.id}
                        style={{ display: 'flex', justifyContent: 'center', width: '100%' }}
                        onClick={() => onTokenClick(b)}
                      >
                        <AssetRow
                          animate
                          balance={Number(showAmount(b.all.pending, b.dec))}
                          decimals={b.dec}
                          showPointer={true}
                          icon={b.icon ? resolveIcon(b.icon) : GENERIC_TOKEN_ICON}
                          ticker={getTokenName(b)}
                          subline={<IssuerBadge tokenId={b.id} compact />}
                          usdBalance={
                            (priceData.find((p) => p.id === b.id)?.satPrice ?? 0) *
                            (exchangeRate / BSV_DECIMAL_CONVERSION) *
                            Number(showAmount(b.all.confirmed, b.dec))
                          }
                        />
                      </div>
                    ))}
                  </div>
                </Show>

                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      </Show>
    </>
  );
};
