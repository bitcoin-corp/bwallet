import type { OneSatContext } from '@1sat/actions';
import { fetchExchangeRate } from '../../utils/wallet';
import { getAgentAccount } from '../agents/agentAccounts';
import {
  buildRows,
  missingParents,
  ownOutputs,
  ratesByDay,
  withRates,
  type HistoryRow,
  type LocalInfo,
  type RawTx,
} from './txHistory';
import {
  fetchAccountTxs,
  fetchDailyRates,
  fetchLocalInfo,
  fetchTokenSymbols,
  fetchTxs,
  type Progress,
} from './txHistoryFetch';
import { classifyEvent, findListings } from './historyEvents';
import { appsByTxid, loadConnectionLog } from './connectionLog';
import { cacheBsvUsd } from './fiatRates';
import { withPurposes } from './purpose/purpose';

/**
 * The account's whole history as statement rows with the BSV/USD rate on each day (History screen, and the
 * Portfolio vs market screen). Address index + the wallet's own action log, fees, token/NFT/lock events, symbols.
 */
export const loadHistoryRows = async ({
  addresses,
  identityAddress,
  apiContext,
  onProgress,
  now = Date.now(),
}: {
  addresses: string[];
  identityAddress?: string;
  apiContext: OneSatContext;
  onProgress: (p: Progress) => void;
  now?: number;
}): Promise<HistoryRow[]> => {
  const setProgress = onProgress;
  const addrs = { identityAddress };
  const key = apiContext.wocApiKey || undefined;
  const [local, connLog] = await Promise.all([
    fetchLocalInfo(apiContext.wallet?.listActions?.bind(apiContext.wallet) as Parameters<typeof fetchLocalInfo>[0]),
    loadConnectionLog(),
  ]);
  // The wallet's own action log adds txs the address index can miss (inscription outputs).
  const txs = await fetchAccountTxs(addresses, key, setProgress, local.keys());
  // Pots and agent accounts: unlabelled outgoing payments are pot payments / agent spend.
  const kind = getAgentAccount(addrs?.identityAddress)?.kind;
  const own = new Set(addresses);
  // Wallet-funded txs spend coins on the wallet's derived keys: load those parents for the fee.
  const parents = missingParents(txs, local as Map<string, LocalInfo>);
  const extra = new Map<string, number>();
  if (parents.length) {
    setProgress({ phase: 'Fees', done: 0, total: parents.length });
    for (const t of await fetchTxs(parents.slice(0, 2000), key))
      for (const o of t.vout) extra.set(`${t.txid}:${o.n}`, o.sats);
  }
  let rows = buildRows(txs, own, local as Map<string, LocalInfo>, now, extra);
  if (kind)
    rows = rows.map((r) =>
      r.direction === 'out' && r.label === 'send' ? { ...r, label: kind === 'pot' ? 'pot payment' : 'agent spend' } : r,
    );
  // History v2: token / NFT / game / subscription / app events (historyEvents.ts).
  const byId = new Map<string, RawTx>(txs.map((t) => [t.txid, t]));
  const prev = ownOutputs([...byId.values()], own);
  const ctx = {
    own,
    prev,
    listings: findListings([...byId.values()], prev),
    appByTxid: appsByTxid(connLog),
    accountKind: kind,
  };
  rows = rows.map((r) => classifyEvent(r, byId.get(r.txid), local.get(r.txid), ctx));
  // Txs only the action log knew about that move nothing on these addresses (BRC-100 derived keys) are noise here.
  rows = rows.filter((r) => r.amountSats !== 0 || r.feeSats !== 0 || r.asset || r.direction === 'self');
  setProgress({ phase: 'Token names', done: 0, total: 1 });
  // Symbols and decimals (so "89131856" reads "0.89131856", as in the token list).
  const ids = [...new Set(rows.map((r) => (r.asset?.kind === 'token' ? r.asset.id : '')).filter(Boolean))];
  const syms = ids.length ? await fetchTokenSymbols(ids) : new Map<string, { sym?: string; dec?: number }>();
  if (syms.size)
    rows = rows.map((r) => {
      const t = r.asset ? syms.get(r.asset.id) : undefined;
      return r.asset && t
        ? { ...r, asset: { ...r.asset, symbol: r.asset.symbol ?? t.sym, dec: r.asset.dec ?? t.dec } }
        : r;
    });
  setProgress({ phase: 'Prices', done: 1, total: 1 });
  const oldest = rows.length ? Math.min(...rows.map((r) => r.time)) : now;
  const [daily, current] = await Promise.all([
    fetchDailyRates(Math.floor(oldest / 1000) - 86400, Math.floor(now / 1000), key),
    fetchExchangeRate(apiContext.chain, apiContext.wocApiKey).catch(() => 0),
  ]);
  // Daily BSV/USD is cached on the device, so a failed price fetch still has the days seen before.
  // Daily BSV/USD is cached on the device, so a failed price fetch still has the days seen before.
  // What each payment was for, saved on this device when it was sent (purpose/purpose.ts).
  return withPurposes(withRates(rows, cacheBsvUsd(ratesByDay(daily)), current), identityAddress);
};
